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
 * Internal per-exporter network stats, separate from customer telemetry.
 * Best-effort fetch: 10-second timeout, no retries or beacon fallback.
 * @internal
 */
export interface InternalSdkStatsConfiguration {
  /** Internal stats UUID, not the customer's key. */
  readonly instrumentationKey: string;
  /** Full stats ingestion URL. */
  readonly endpoint: string;
  /** Interval in ms (1..2147483647). Default: one hour. */
  readonly collectionIntervalMillis?: number;
  /** Per-metric sampling percentage (0..100). Default: 100. */
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
    // Logger failures must not interrupt cleanup.
  }
}
