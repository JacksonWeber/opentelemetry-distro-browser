// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { callWithTimeout } from "@opentelemetry/core";
import { OPENTELEMETRY_BROWSER_VERSION } from "../shared/constants.js";
import { createEnvelope, getSdkVersion, isUnloading } from "./common.js";
import { isSupportedEndpoint, isValidInstrumentationKey } from "./connectionStringParser.js";
import { Sender } from "./sender.js";
import { getInternalSdkStatsConfiguration } from "./sdkStatsConfiguration.js";
import type { AzureMonitorEnvelope, MetricData } from "./telemetryModels.js";

/**
 * Distro-owned internal network SDK stats, sent separately from application telemetry.
 *
 * @remarks
 * Each Azure Monitor exporter owns its counters and reports independently. Reports contain the
 * customer instrumentation key, effective ingestion stamp, SDK version, request counts and
 * average duration in milliseconds. They do not contain telemetry, user or session attributes,
 * exception messages, or ingestion URL paths and queries. No browser storage is used.
 *
 * Reports go directly to the distro-owned ingestion endpoint without a remote configuration
 * request. HTTPS is required except for localhost and loopback testing.
 * Accepted customer redirects update the route and stamp without resetting counters or timers.
 * Each attempt's endpoint controls eligibility, including responses that complete after a redirect.
 * Stats fetches omit credentials and referrers. Beacon fallback is disabled because it cannot
 * suppress referrers on pages with a permissive referrer policy.
 *
 * Reports bypass application sampling and processors. Empty windows send nothing.
 * Success counts require an HTTP response, not just successful beacon queuing.
 * Attempted reports are best effort and are not replayed, which avoids duplicating partially
 * accepted metrics. Report requests have a 10-second timeout.
 * Lifecycle stats flushes follow customer telemetry so they do not consume its unload capacity.
 * Failures are reported through diagnostics and do not fail customer telemetry flushes.
 * @internal
 */
export interface InternalSdkStatsConfiguration {
  /** Separate SDK stats destination key. Must be a UUID, never defaulted to the customer key. */
  readonly instrumentationKey: string;
  /** Full SDK stats ingestion URL. Never falls back to the customer endpoint. */
  readonly endpoint: string;
  /** Reporting interval in milliseconds, from 1 through 2147483647. Defaults to one hour. */
  readonly collectionIntervalMillis?: number;
  /** Independently samples each stats metric from 0 through 100. Defaults to 100. */
  readonly samplingPercentage?: number;
}

const RETRY_STATUSES = [401, 403, 408, 429, 500, 502, 503, 504];

export interface InternalSdkStats {
  updateEndpoint(endpoint: string): void;
  countResponse(status: number, duration: number, endpoint?: string): void;
  countException(error: unknown, endpoint?: string): void;
  forceFlush(): Promise<void>;
  shutdown(pending?: Promise<unknown>): Promise<void>;
}

export function createInternalSdkStats(
  options: InternalSdkStatsConfiguration | undefined,
  customerKey: string,
  endpoint: string,
): InternalSdkStats {
  let route = resolveRoute(options);
  const interval = options?.collectionIntervalMillis ?? 3_600_000;
  const sampleRate = options?.samplingPercentage ?? 100;
  if (!Number.isFinite(interval) || interval < 1 || interval > 2_147_483_647) {
    throw new RangeError("Invalid SDK stats interval (1..2147483647 ms).");
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 100) {
    throw new RangeError("Invalid SDK stats samplingPercentage (0..100).");
  }
  const customerUrl = new URL(endpoint);
  const properties = {
    rp: "unknown",
    attach: "Manual",
    cikey: customerKey,
    os: "Browser",
    language: "JavaScript",
    version: `mot${OPENTELEMETRY_BROWSER_VERSION}`,
    endpoint: "breeze",
    host: customerUrl.hostname.split(".")[0],
  };
  const counts = new Map<string, number>();
  let duration = 0;
  let requests = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sender: Sender | undefined;
  let sending: AbortController | undefined;
  let flushing: Promise<void> | undefined;
  let stopped = false;
  let disabled = sampleRate === 0;

  function updateEndpoint(endpoint: string): void {
    if (disabled) return;
    const next = resolveRoute(getInternalSdkStatsConfiguration(endpoint));
    properties.host = new URL(endpoint).hostname.split(".")[0];
    route = next;
    sender = undefined;
    if (!route) sending?.abort();
  }

  function countResponse(status: number, elapsed: number, endpoint?: string): void {
    if (disabled || !route || (endpoint && !getInternalSdkStatsConfiguration(endpoint))) return;
    requests++;
    duration += Math.max(0, elapsed);
    if (status >= 200 && status < 300) {
      increment("Request_Success_Count");
    } else if (status !== 307 && status !== 308) {
      const name = RETRY_STATUSES.includes(status)
        ? "Retry_Count"
        : status === 402 || status === 439
          ? "Throttle_Count"
          : "Request_Failure_Count";
      increment(`${name}:${status}`);
    }
    schedule();
  }

  function countException(error: unknown, endpoint?: string): void {
    if (disabled || !route || (endpoint && !getInternalSdkStatsConfiguration(endpoint))) return;
    const type =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
        ? "Timeout exception"
        : error instanceof TypeError
          ? "Network exception"
          : "Client exception";
    increment(`Exception_Count:${type}`);
    schedule();
  }

  function forceFlush(): Promise<void> {
    if (!flushing) {
      clearTimer();
      flushing = flush(isUnloading())
        .catch(reportFailure)
        .finally(() => {
          flushing = undefined;
          if (counts.size || requests) schedule();
        });
    }
    return flushing;
  }

  async function shutdown(pending?: Promise<unknown>): Promise<void> {
    stopped = true;
    clearTimer();
    try {
      await pending;
    } finally {
      try {
        await flushing;
        await forceFlush();
      } finally {
        disabled = true;
        counts.clear();
        requests = duration = 0;
      }
    }
  }

  function increment(key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  function clearTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    if (stopped || disabled || timer !== undefined) return;
    timer = setTimeout(() => {
      void forceFlush();
    }, interval);
  }

  async function flush(unloading: boolean): Promise<void> {
    const currentRoute = route;
    if (disabled || !currentRoute || (!counts.size && !requests)) return;
    const envelopes: AzureMonitorEnvelope<MetricData>[] = [];
    const time = new Date().toISOString();
    const append = (key: string, value: number): void => {
      if (value < 0 || (sampleRate < 100 && Math.random() * 100 >= sampleRate)) return;
      const [name, code] = key.split(":");
      envelopes.push(
        createEnvelope(
          currentRoute.instrumentationKey,
          "Microsoft.ApplicationInsights.Metric",
          time,
          { "ai.internal.sdkVersion": getSdkVersion() },
          "MetricData",
          {
            ver: 2,
            metrics: [{ name, kind: 0, value }],
            properties: {
              ...properties,
              ...(code === undefined
                ? {}
                : { [name === "Exception_Count" ? "exceptionType" : "statusCode"]: code }),
            },
          },
          sampleRate,
        ),
      );
    };
    if (requests) append("Request_Duration", duration / requests);
    for (const [key, value] of counts) append(key, value);
    counts.clear();
    requests = duration = 0;
    if (!envelopes.length) return;
    const statsSender = (sender ??= new Sender({
      endpoint: currentRoute.endpoint,
      disableBeacon: true,
    }));
    const controller = (sending = new AbortController());
    try {
      const result = await callWithTimeout(
        statsSender.send({
          body: new TextEncoder().encode(JSON.stringify(envelopes)),
          contentType: "application/json",
          unloading,
          signal: controller.signal,
          retry: false,
        }),
        10_000,
      );
      if (
        result.transport === "fetch" &&
        (result.statusCode < 200 || result.statusCode >= 300 || result.statusCode === 206)
      ) {
        throw new Error(`SDK stats ingestion failed: HTTP ${result.statusCode}.`);
      }
    } finally {
      controller.abort();
      sending = undefined;
    }
  }

  return { updateEndpoint, countResponse, countException, forceFlush, shutdown };
}

function resolveRoute(
  options: InternalSdkStatsConfiguration | undefined,
): { instrumentationKey: string; endpoint: string } | undefined {
  if (!options) return undefined;
  if (!isValidInstrumentationKey(options.instrumentationKey)) {
    throw new Error("Invalid SDK stats instrumentationKey UUID.");
  }
  const url = new URL(options.endpoint);
  if (!isSupportedEndpoint(url) || url.username || url.password || url.hash || url.search) {
    throw new Error(
      "SDK stats URLs require HTTPS or loopback HTTP, no credentials or fragments, and no ingestion query.",
    );
  }
  return { instrumentationKey: options.instrumentationKey, endpoint: url.href };
}

function reportFailure(error: unknown): void {
  try {
    diag.warn("SDK stats export failed", error);
  } catch {
    // Application diagnostic loggers must not break best-effort stats or customer cleanup.
  }
}
