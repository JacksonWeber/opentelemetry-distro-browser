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
  private endpoint: string;
  private compress: boolean;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sendBeacon: typeof globalThis.navigator.sendBeacon | undefined;
  private readonly disableBeacon: boolean;
  private readonly maxPayloadSize: number | undefined;
  private readonly delay: (delayMs: number) => Promise<void>;
  private readonly random: () => number;
  private throttleDeadline = 0;
  private readonly stats: InternalSdkStats | undefined;

  public constructor(options: SenderOptions) {
    this.endpoint = options.endpoint;
    this.compress = isTrustedIngestionEndpoint(options.endpoint);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sendBeacon =
      options.sendBeacon ?? globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
    this.disableBeacon = options.disableBeacon ?? false;
    this.maxPayloadSize = options.maxPayloadSize;
    this.delay = options.delay ?? wait;
    this.random = options.random ?? Math.random;
    this.stats = options.stats;

    if (this.maxPayloadSize !== undefined && this.maxPayloadSize <= 0) {
      throw new RangeError("maxPayloadSize must be greater than zero.");
    }
  }

  public async send(request: SendRequest): Promise<SenderResultType> {
    if (this.maxPayloadSize !== undefined && request.body.byteLength > this.maxPayloadSize) {
      throw new RangeError(
        `Payload size ${request.body.byteLength} exceeds the ${this.maxPayloadSize} byte limit.`,
      );
    }
    if (request.unloading === true || request.retry === false) {
      const result = await this.sendOnce(request);
      this.rememberThrottleDeadline(result);
      return result;
    }

    let currentRequest = request;
    let remainingRetryWaitMs = MAX_RETRY_WAIT_MS;
    const permanentErrors: BreezeError[] = [];
    for (let attempt = 1; ; attempt++) {
      remainingRetryWaitMs = await this.waitForThrottle(remainingRetryWaitMs);

      let result: SenderResultType;
      try {
        result = await this.sendOnce(currentRequest);
      } catch (error) {
        if (!(error instanceof BrowserTransportError)) {
          throw error;
        }
        if (error.statusCode !== undefined && !isRetriable(error.statusCode)) {
          throw error.cause;
        }
        if (error.retryAfterMs !== undefined) {
          this.rememberThrottleDelay(error.retryAfterMs);
        }
        if (attempt >= MAX_SEND_ATTEMPTS) {
          throw error.cause;
        }
        if (error.retryAfterMs === undefined) {
          remainingRetryWaitMs = await this.waitForRetry(
            getRetryDelay(attempt - 1, this.random()),
            remainingRetryWaitMs,
          );
        }
        continue;
      }

      if (result.transport === "beacon") {
        return result;
      }

      permanentErrors.push(...getPermanentErrors(result));
      const retryRequest = getRetryRequest(currentRequest, result);
      this.rememberThrottleDeadline(result);
      if (!retryRequest || attempt >= MAX_SEND_ATTEMPTS) {
        return permanentErrors.length === 0 ? result : { ...result, permanentErrors };
      }

      if (result.retryAfterMs === undefined) {
        remainingRetryWaitMs = await this.waitForRetry(
          getRetryDelay(attempt - 1, this.random()),
          remainingRetryWaitMs,
        );
      }
      currentRequest = retryRequest;
    }
  }

  private rememberThrottleDeadline(result: SenderResultType): void {
    if (
      result.transport === "fetch" &&
      result.retryAfterMs !== undefined &&
      isRetriable(result.statusCode)
    ) {
      this.rememberThrottleDelay(result.retryAfterMs);
    }
  }

  private rememberThrottleDelay(delayMs: number): void {
    this.throttleDeadline = Math.max(this.throttleDeadline, Date.now() + delayMs);
  }

  private async waitForThrottle(remainingRetryWaitMs: number): Promise<number> {
    let observedDeadline = this.throttleDeadline;
    while (observedDeadline > Date.now()) {
      remainingRetryWaitMs = await this.waitForRetry(
        Math.max(0, observedDeadline - Date.now()),
        remainingRetryWaitMs,
      );
      if (this.throttleDeadline <= observedDeadline) {
        return remainingRetryWaitMs;
      }
      observedDeadline = this.throttleDeadline;
    }
    return remainingRetryWaitMs;
  }

  private async waitForRetry(delayMs: number, remainingRetryWaitMs: number): Promise<number> {
    if (delayMs > remainingRetryWaitMs) {
      throw new Error(
        `Azure Monitor export exceeds the ${MAX_RETRY_WAIT_MS} ms retry-wait budget.`,
      );
    }
    await this.delay(delayMs);
    return remainingRetryWaitMs - delayMs;
  }

  private async sendOnce(request: SendRequest): Promise<SenderResultType> {
    if (request.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    const unloading = request.unloading === true;
    const keepaliveAvailable =
      pendingKeepaliveBodySize + request.body.byteLength <= MAX_PENDING_KEEPALIVE_BODY_SIZE &&
      pendingKeepaliveRequestCount < MAX_PENDING_KEEPALIVE_REQUESTS;
    if (unloading && !keepaliveAvailable) {
      return this.sendWithBeacon(request);
    }

    const useKeepalive = unloading;
    if (useKeepalive) {
      pendingKeepaliveBodySize += request.body.byteLength;
      pendingKeepaliveRequestCount++;
    }

    try {
      let response: Response;
      try {
        const payload = unloading || !this.compress ? undefined : await gzipPayload(request.body);
        const startTime = Date.now();
        try {
          // Browser context may not survive compression or retry awaits, so suppress at the call.
          response = await context.with(suppressTracing(context.active()), () =>
            this.fetch(this.endpoint, {
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
            }),
          );
        } catch (error) {
          this.stats?.countException(error);
          if (!isBrowserTransportFailure(error)) {
            throw error;
          }
          throw new BrowserTransportError(error);
        }
        this.rememberRedirectEndpoint(response);
        this.stats?.countResponse(response.status, Date.now() - startTime);
      } catch (error) {
        if (unloading && !request.signal?.aborted) {
          return this.sendWithBeacon(
            request,
            error instanceof BrowserTransportError ? error.cause : error,
          );
        }
        throw error;
      }

      const retryAfterMs = parseRetryAfterHeader(response.headers.get("retry-after"));
      let result: string;
      try {
        result = await response.text();
      } catch (error) {
        this.stats?.countException(error);
        if (!isBrowserTransportFailure(error)) {
          throw error;
        }
        if (!isRetriable(response.status)) {
          throw error;
        }
        if (unloading && !request.signal?.aborted) {
          return this.sendWithBeacon(request, error);
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

  private rememberRedirectEndpoint(response: Response): void {
    if (!response.redirected || response.url === this.endpoint) {
      return;
    }

    const redirectedEndpoint = getTrustedIngestionEndpoint(this.endpoint, response.url);
    if (redirectedEndpoint !== undefined) {
      this.endpoint = redirectedEndpoint;
      this.stats?.updateEndpoint(redirectedEndpoint);
      this.compress = isTrustedIngestionEndpoint(redirectedEndpoint);
    }
  }

  private sendWithBeacon(request: SendRequest, cause?: unknown): BeaconSenderResult {
    if (request.body.byteLength > MAX_BEACON_BODY_SIZE) {
      throw new RangeError(
        `Unload payload size ${request.body.byteLength} exceeds the ${MAX_BEACON_BODY_SIZE} byte beacon limit.`,
        { cause },
      );
    }

    if (this.disableBeacon || !this.sendBeacon) {
      const error = new Error("sendBeacon fallback is unavailable for the unload request.", {
        cause,
      });
      this.stats?.countException(error);
      throw error;
    }

    const body = new Blob([request.body], { type: "text/plain;charset=UTF-8" });
    let queued: boolean;
    try {
      queued = this.sendBeacon(this.endpoint, body);
    } catch (error) {
      this.stats?.countException(error);
      throw error;
    }
    if (!queued) {
      const error = new Error("sendBeacon could not queue the unload request.", { cause });
      this.stats?.countException(error);
      throw error;
    }

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

function getRetryRequest(request: SendRequest, result: SenderResult): SendRequest | undefined {
  if (!isRetriable(result.statusCode)) {
    return undefined;
  }
  if (result.statusCode !== 206) {
    return request;
  }
  if (!request.envelopes) {
    return undefined;
  }

  const response = parseBreezeResponse(result.result);
  if (!response) {
    return undefined;
  }

  const envelopes = response.errors
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

function getPermanentErrors(result: SenderResult): BreezeError[] {
  if (result.statusCode !== 206) return [];
  const response = parseBreezeResponse(result.result);
  if (!response) return [];
  return response.errors.filter(
    (error) => !isRetriable(error.statusCode) && !isSamplingRejection(error),
  );
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
