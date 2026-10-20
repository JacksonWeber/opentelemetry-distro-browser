// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import {
  MAX_BEACON_BODY_SIZE,
  MAX_PENDING_KEEPALIVE_BODY_SIZE,
  MAX_PENDING_KEEPALIVE_REQUESTS,
  MAX_SEND_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  MAX_RETRY_WAIT_MS,
  RETRY_DELAY_MS,
} from "./constants.js";
import {
  type BreezeError,
  type BreezeResponse,
  isRetriable,
  isSamplingRejection,
  parseBreezeResponse,
  parseRetryAfterHeader,
} from "./breezeUtils.js";
import type { AzureMonitorEnvelope } from "./telemetryModels.js";
import type { InternalSdkStats } from "./sdkStats.js";

let pendingKeepaliveBodySize = 0;
let pendingKeepaliveRequestCount = 0;

const trustedIngestionHostSuffixGroups = [
  [
    ".livediagnostics.monitor.azure.com",
    ".monitor.azure.com",
    ".services.visualstudio.com",
    ".applicationinsights.azure.com",
    ".applicationinsights.microsoft.com",
  ],
  [".monitor.azure.us", ".applicationinsights.azure.us", ".applicationinsights.us"],
  [".monitor.azure.cn", ".applicationinsights.azure.cn"],
];

export interface SenderOptions {
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sendBeacon?: typeof globalThis.navigator.sendBeacon;
  readonly disableBeacon?: boolean;
  readonly maxPayloadSize?: number;
  readonly delay?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
  readonly stats?: InternalSdkStats;
}

export interface SendRequest {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly envelopes?: readonly AzureMonitorEnvelope[];
  readonly unloading?: boolean;
  readonly signal?: AbortSignal;
  readonly retry?: boolean;
  /** Called once an unload request is handed to the browser by keepalive fetch or beacon. */
  readonly onDispatch?: () => void;
  /**
   * Called after each 206 response with the envelopes that are still retriable, or an empty array
   * when none remain.
   */
  readonly onPartial?: (envelopes: readonly AzureMonitorEnvelope[]) => void;
  /** Called with each response status before its body is read. */
  readonly onResponse?: (statusCode: number) => void;
  /** Checked before each attempt; when it returns `false` the request stops with an error. */
  readonly active?: () => boolean;
}

export interface SenderResult {
  readonly transport: "fetch";
  readonly statusCode: number;
  readonly result: string;
  readonly retryAfterMs?: number;
  readonly permanentErrors?: readonly BreezeError[];
}

export interface BeaconSenderResult {
  readonly transport: "beacon";
}

export type SenderResultType = SenderResult | BeaconSenderResult;

export class Sender {
  #endpoint: string;
  #compress: boolean;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sendBeacon: typeof globalThis.navigator.sendBeacon | undefined;
  readonly #disableBeacon: boolean;
  readonly #maxPayloadSize: number | undefined;
  readonly #delay: (delayMs: number) => Promise<void>;
  readonly #random: () => number;
  #throttleDeadline = 0;
  readonly #stats: InternalSdkStats | undefined;

  public constructor(options: SenderOptions) {
    this.#endpoint = options.endpoint;
    this.#compress = isTrustedIngestionEndpoint(options.endpoint);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sendBeacon =
      options.sendBeacon ?? globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
    this.#disableBeacon = options.disableBeacon ?? false;
    this.#maxPayloadSize = options.maxPayloadSize;
    this.#delay = options.delay ?? wait;
    this.#random = options.random ?? Math.random;
    this.#stats = options.stats;

    if (this.#maxPayloadSize !== undefined && this.#maxPayloadSize <= 0) {
      throw new RangeError("maxPayloadSize must be greater than zero.");
    }
  }

  public async send(request: SendRequest): Promise<SenderResultType> {
    if (this.#maxPayloadSize !== undefined && request.body.byteLength > this.#maxPayloadSize) {
      throw new RangeError(
        `Payload size ${request.body.byteLength} exceeds the ${this.#maxPayloadSize} byte limit.`,
      );
    }
    if (request.unloading === true || request.retry === false) {
      const result = await this.#sendOnce(request);
      if (result.transport === "fetch" && result.statusCode === 206) {
        reportPartial(request, result, parseBreezeResponse(result.result));
      }
      this.#rememberThrottleDeadline(result);
      return result;
    }

    let currentRequest = request;
    let remainingRetryWaitMs = MAX_RETRY_WAIT_MS;
    const permanentErrors: BreezeError[] = [];
    for (let attempt = 1; ; attempt++) {
      remainingRetryWaitMs = await this.#waitForThrottle(remainingRetryWaitMs);

      let result: SenderResultType;
      try {
        result = await this.#sendOnce(currentRequest);
      } catch (error) {
        if (!(error instanceof BrowserTransportError)) {
          throw error;
        }
        if (error.statusCode !== undefined && !isRetriable(error.statusCode)) {
          throw error.cause;
        }
        if (error.retryAfterMs !== undefined) {
          this.#rememberThrottleDelay(error.retryAfterMs);
        }
        if (attempt >= MAX_SEND_ATTEMPTS) {
          throw error.cause;
        }
        if (error.retryAfterMs === undefined) {
          remainingRetryWaitMs = await this.#waitForRetry(
            getRetryDelay(attempt - 1, this.#random()),
            remainingRetryWaitMs,
          );
        }
        continue;
      }

      if (result.transport === "beacon") {
        return result;
      }

      const response = result.statusCode === 206 ? parseBreezeResponse(result.result) : undefined;
      const breezeErrors = response?.errors ?? [];
      permanentErrors.push(
        ...breezeErrors.filter(
          (error) => !isRetriable(error.statusCode) && !isSamplingRejection(error),
        ),
      );
      const retryRequest = reportPartial(currentRequest, result, response);
      this.#rememberThrottleDeadline(result);
      if (!retryRequest || attempt >= MAX_SEND_ATTEMPTS) {
        return permanentErrors.length === 0 ? result : { ...result, permanentErrors };
      }

      if (result.retryAfterMs === undefined) {
        remainingRetryWaitMs = await this.#waitForRetry(
          getRetryDelay(attempt - 1, this.#random()),
          remainingRetryWaitMs,
        );
      }
      currentRequest = retryRequest;
    }
  }

  #rememberThrottleDeadline(result: SenderResultType): void {
    if (
      result.transport === "fetch" &&
      result.retryAfterMs !== undefined &&
      isRetriable(result.statusCode)
    ) {
      this.#rememberThrottleDelay(result.retryAfterMs);
    }
  }

  #rememberThrottleDelay(delayMs: number): void {
    this.#throttleDeadline = Math.max(this.#throttleDeadline, Date.now() + delayMs);
  }

  async #waitForThrottle(remainingRetryWaitMs: number): Promise<number> {
    let observedDeadline = this.#throttleDeadline;
    while (observedDeadline > Date.now()) {
      remainingRetryWaitMs = await this.#waitForRetry(
        Math.max(0, observedDeadline - Date.now()),
        remainingRetryWaitMs,
      );
      if (this.#throttleDeadline <= observedDeadline) {
        return remainingRetryWaitMs;
      }
      observedDeadline = this.#throttleDeadline;
    }
    return remainingRetryWaitMs;
  }

  async #waitForRetry(delayMs: number, remainingRetryWaitMs: number): Promise<number> {
    if (delayMs > remainingRetryWaitMs) {
      throw new Error(
        `Azure Monitor export exceeds the ${MAX_RETRY_WAIT_MS} ms retry-wait budget.`,
      );
    }
    await this.#delay(delayMs);
    return remainingRetryWaitMs - delayMs;
  }

  async #sendOnce(request: SendRequest): Promise<SenderResultType> {
    if (request.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    assertActive(request);
    const unloading = request.unloading === true;
    const keepaliveAvailable =
      pendingKeepaliveBodySize + request.body.byteLength <= MAX_PENDING_KEEPALIVE_BODY_SIZE &&
      pendingKeepaliveRequestCount < MAX_PENDING_KEEPALIVE_REQUESTS;
    if (unloading && !keepaliveAvailable) {
      return this.#sendWithBeacon(request);
    }

    const useKeepalive = unloading;
    if (useKeepalive) {
      pendingKeepaliveBodySize += request.body.byteLength;
      pendingKeepaliveRequestCount++;
    }

    try {
      let response: Response;
      let endpoint = this.#endpoint;
      try {
        const payload = unloading || !this.#compress ? undefined : await gzipPayload(request.body);
        // Compression yields, so the page may have been frozen and handed off in between.
        if (!unloading) assertActive(request);
        endpoint = this.#endpoint;
        const startTime = Date.now();
        try {
          // Browser context may not survive compression or retry awaits, so suppress at the call.
          response = await context.with(suppressTracing(context.active()), () => {
            const pending = this.#fetch(endpoint, {
              method: "POST",
              headers: {
                "content-type": request.contentType,
                ...(payload === undefined ? {} : { "content-encoding": "gzip" }),
              },
              body: payload ?? request.body,
              keepalive: useKeepalive,
              ...(request.signal
                ? { signal: request.signal, credentials: "omit", referrerPolicy: "no-referrer" }
                : {}),
            });
            if (useKeepalive) request.onDispatch?.();
            return pending;
          });
        } catch (error) {
          this.#stats?.countException(error, endpoint);
          if (!isBrowserTransportFailure(error)) {
            throw error;
          }
          throw new BrowserTransportError(error);
        }
        endpoint = this.#rememberRedirectEndpoint(response, endpoint);
        this.#stats?.countResponse(response.status, Date.now() - startTime, endpoint);
      } catch (error) {
        if (unloading && !request.signal?.aborted) {
          return this.#sendWithBeacon(
            request,
            error instanceof BrowserTransportError ? error.cause : error,
          );
        }
        throw error;
      }

      request.onResponse?.(response.status);
      const retryAfterMs = parseRetryAfterHeader(response.headers.get("retry-after"));
      let result: string;
      try {
        result = await response.text();
      } catch (error) {
        this.#stats?.countException(error, endpoint);
        if (!isBrowserTransportFailure(error)) {
          throw error;
        }
        if (!isRetriable(response.status)) {
          throw error;
        }
        if (unloading && !request.signal?.aborted) {
          return this.#sendWithBeacon(request, error);
        }
        throw new BrowserTransportError(error, response.status, retryAfterMs);
      }
      return {
        transport: "fetch",
        statusCode: response.status,
        result,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    } finally {
      if (useKeepalive) {
        pendingKeepaliveBodySize -= request.body.byteLength;
        pendingKeepaliveRequestCount--;
      }
    }
  }

  #rememberRedirectEndpoint(response: Response, attemptedEndpoint: string): string {
    if (!response.redirected) return attemptedEndpoint;

    const redirectedEndpoint = getTrustedIngestionEndpoint(attemptedEndpoint, response.url);
    if (redirectedEndpoint !== undefined && redirectedEndpoint !== this.#endpoint) {
      this.#endpoint = redirectedEndpoint;
      this.#stats?.updateEndpoint(redirectedEndpoint);
      this.#compress = isTrustedIngestionEndpoint(redirectedEndpoint);
    }
    return response.url;
  }

  #sendWithBeacon(request: SendRequest, cause?: unknown): BeaconSenderResult {
    // A fallback can follow a frozen response body read, after the batch was handed off.
    assertActive(request);
    const endpoint = this.#endpoint;
    if (request.body.byteLength > MAX_BEACON_BODY_SIZE) {
      throw new RangeError(
        `Unload payload size ${request.body.byteLength} exceeds the ${MAX_BEACON_BODY_SIZE} byte beacon limit.`,
        { cause },
      );
    }

    if (this.#disableBeacon || !this.#sendBeacon) {
      const error = new Error("sendBeacon fallback is unavailable for the unload request.", {
        cause,
      });
      this.#stats?.countException(error, endpoint);
      throw error;
    }

    const body = new Blob([request.body], { type: "text/plain;charset=UTF-8" });
    let queued: boolean;
    try {
      queued = this.#sendBeacon(endpoint, body);
    } catch (error) {
      this.#stats?.countException(error, endpoint);
      throw error;
    }
    if (!queued) {
      const error = new Error("sendBeacon could not queue the unload request.", { cause });
      this.#stats?.countException(error, endpoint);
      throw error;
    }

    request.onDispatch?.();
    return { transport: "beacon" };
  }
}

function getTrustedIngestionEndpoint(
  currentEndpoint: string,
  redirectedEndpoint: string,
): string | undefined {
  try {
    const currentUrl = new URL(currentEndpoint);
    const redirectedUrl = new URL(redirectedEndpoint);
    if (currentUrl.protocol !== "https:" || redirectedUrl.protocol !== "https:") {
      return undefined;
    }

    if (normalizeHostname(currentUrl.hostname) === normalizeHostname(redirectedUrl.hostname)) {
      return (currentUrl.port || "443") === (redirectedUrl.port || "443")
        ? redirectedUrl.toString()
        : undefined;
    }

    const cloud = getIngestionCloud(currentUrl);
    return cloud >= 0 && cloud === getIngestionCloud(redirectedUrl)
      ? redirectedUrl.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Only first-party Azure Monitor ingestion is known to accept gzip request bodies; custom
 * endpoints such as proxies may parse the body as JSON and reject it.
 */
function isTrustedIngestionEndpoint(endpoint: string): boolean {
  try {
    return getIngestionCloud(new URL(endpoint)) >= 0;
  } catch {
    return false;
  }
}

/** Returns the trusted cloud index for an HTTPS port-443 ingestion URL, or -1. */
function getIngestionCloud(url: URL): number {
  if (url.protocol !== "https:" || (url.port || "443") !== "443") {
    return -1;
  }
  const hostname = normalizeHostname(url.hostname);
  return trustedIngestionHostSuffixGroups.findIndex((suffixGroup) =>
    suffixGroup.some((suffix) => hostname.endsWith(suffix)),
  );
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** Returns the retry request, reporting the envelopes still outstanding after a 206 response. */
function reportPartial(
  request: SendRequest,
  result: SenderResult,
  response: BreezeResponse | undefined,
): SendRequest | undefined {
  const retryRequest = getRetryRequest(request, result, response?.errors ?? []);
  if (result.statusCode === 206) {
    // An unreadable response leaves every envelope outstanding, without an immediate retry.
    request.onPartial?.(response ? (retryRequest?.envelopes ?? []) : (request.envelopes ?? []));
  }
  return retryRequest;
}

function getRetryRequest(
  request: SendRequest,
  result: SenderResult,
  breezeErrors: readonly BreezeError[],
): SendRequest | undefined {
  if (!isRetriable(result.statusCode)) {
    return undefined;
  }
  if (result.statusCode !== 206) {
    return request;
  }
  if (!request.envelopes) {
    return undefined;
  }

  const envelopes = breezeErrors
    .filter((error) => isRetriable(error.statusCode) && !isSamplingRejection(error))
    .map((error) => request.envelopes?.[error.index])
    .filter((envelope): envelope is AzureMonitorEnvelope => envelope !== undefined);
  if (envelopes.length === 0) {
    return undefined;
  }

  return {
    ...request,
    body: new TextEncoder().encode(JSON.stringify(envelopes)),
    envelopes,
  };
}

function assertActive(request: SendRequest): void {
  if (request.active?.() === false) throw new Error("Telemetry was handed off to another page.");
}

function getRetryDelay(retryAttempt: number, random: number): number {
  const maximumDelay = Math.min(RETRY_DELAY_MS * 2 ** retryAttempt, MAX_RETRY_DELAY_MS);
  const minimumDelay = maximumDelay / 2;
  return minimumDelay + Math.floor(random * (minimumDelay + 1));
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function gzipPayload(
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (typeof globalThis.CompressionStream !== "function") {
    return undefined;
  }

  try {
    const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}

class BrowserTransportError extends Error {
  public constructor(
    public override readonly cause: unknown,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
  ) {
    super("Browser transport failed", { cause });
  }
}

function isBrowserTransportFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}
