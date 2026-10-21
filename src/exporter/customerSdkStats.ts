// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind } from "@opentelemetry/api";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { createEnvelope, getSdkVersion, isUnloading } from "./common.js";
import { getTrustedIngestionEndpoint, Sender } from "./sender.js";
import { reportFailure, sendSdkStats } from "./sdkStats.js";
import { getInternalSdkStatsConfiguration } from "./sdkStatsConfiguration.js";
import type { AzureMonitorEnvelope, MetricData } from "./telemetryModels.js";

/**
 * Customer SDK health metrics, configured at startup.
 *
 * @remarks
 * Transport counters count envelopes. Queue and sampling drops count source records.
 * Standalone exporters observe only export outcomes.
 * Reports bypass application pipelines, time out after 10 seconds and are not retried or stored.
 * @public
 */
export interface AzureMonitorSdkStatsOptions {
  /**
   * Enables customer item metrics. Defaults to false and leaves internal stats unchanged.
   */
  readonly enabled?: boolean;
  /**
   * Reporting interval in integer milliseconds (1..2147483647). Defaults to 900000 (15 minutes).
   */
  readonly collectionIntervalMillis?: number;
}

export function validateSdkStatsOptions(options: AzureMonitorSdkStatsOptions | undefined): void {
  if (options === undefined) return;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("sdkStats must be an object.");
  }
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") {
    throw new TypeError("sdkStats.enabled must be a boolean.");
  }
  const interval = options.collectionIntervalMillis;
  if (
    interval !== undefined &&
    (!Number.isInteger(interval) || interval < 1 || interval > 2_147_483_647)
  ) {
    throw new RangeError("Invalid sdkStats.collectionIntervalMillis (1..2147483647 ms).");
  }
}

type ItemOutcome = "Success" | "Dropped" | "Retry";
export type ItemType =
  "CUSTOM_EVENT" | "CUSTOM_METRIC" | "DEPENDENCY" | "EXCEPTION" | "PAGE_VIEW" | "TRACE" | "REQUEST";

export interface CustomerSdkStats {
  count(outcome: ItemOutcome, type: ItemType, code?: string, count?: number): void;
  countEnvelopes(
    outcome: ItemOutcome,
    envelopes: readonly AzureMonitorEnvelope[] | undefined,
    code?: string | readonly string[],
  ): void;
  shouldCollectLog: (record: ReadableLogRecord) => boolean;
  forceFlush(): Promise<void>;
  shutdown(pending?: Promise<unknown>): Promise<void>;
}

// Keeps stats off the public exporter API.
export const customerSdkStats = new WeakMap<SpanExporter | LogRecordExporter, CustomerSdkStats>();

export function spanItemType(kind: SpanKind): ItemType {
  return kind === SpanKind.SERVER || kind === SpanKind.CONSUMER ? "REQUEST" : "DEPENDENCY";
}

function envelopeItemType(envelope: AzureMonitorEnvelope): ItemType {
  switch (envelope.data.baseType) {
    case "RequestData":
      return "REQUEST";
    case "RemoteDependencyData":
      return "DEPENDENCY";
    case "ExceptionData":
      return "EXCEPTION";
    case "PageViewData":
    case "PageviewPerformanceData":
      return "PAGE_VIEW";
    case "MessageData":
      return "TRACE";
    case "MetricData":
      return "CUSTOM_METRIC";
    default:
      return "CUSTOM_EVENT";
  }
}

export function createCustomerSdkStats(
  options: AzureMonitorSdkStatsOptions | undefined,
  instrumentationKey: string,
  endpoint: string,
): CustomerSdkStats | undefined {
  validateSdkStatsOptions(options);
  if (options?.enabled !== true) return undefined;
  const interval = options.collectionIntervalMillis ?? 900_000;
  const counts = new Map<string, number>();
  const sender = new Sender({ endpoint: `${endpoint}/v2/track`, disableBeacon: true });
  const internalEndpoint = getInternalSdkStatsConfiguration(endpoint)?.endpoint;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let stopping = false;
  let stopped = false;

  function shouldCollectLog(record: ReadableLogRecord): boolean {
    if (
      record.eventName !== "browser.resource_timing" ||
      record.instrumentationScope.name !== "@opentelemetry/browser-instrumentation/resource-timing"
    )
      return true;
    const url = record.attributes["url.full"];
    // Resource timing runs after fetch suppression, so exclude ingestion requests.
    return !(
      typeof url === "string" &&
      /\/v2\/track(?:[?#]|$)/.test(url) &&
      (url === internalEndpoint ||
        url === `${endpoint}/v2/track` ||
        getTrustedIngestionEndpoint(`${endpoint}/v2/track`, url))
    );
  }

  function schedule(): void {
    if (stopping || flushing || timer !== undefined || !counts.size) return;
    timer = setTimeout(() => void forceFlush(), interval);
  }

  function count(outcome: ItemOutcome, type: ItemType, code = "", value = 1): void {
    if (stopped || value <= 0) return;
    const key = `${outcome}:${type}:${code}`;
    counts.set(key, (counts.get(key) ?? 0) + value);
    schedule();
  }

  function countEnvelopes(
    outcome: ItemOutcome,
    envelopes: readonly AzureMonitorEnvelope[] | undefined,
    code?: string | readonly string[],
  ): void {
    for (const [index, envelope] of (envelopes ?? []).entries()) {
      count(outcome, envelopeItemType(envelope), typeof code === "string" ? code : code?.[index]);
    }
  }

  function forceFlush(): Promise<void> {
    if (flushing) return flushing;
    clearTimeout(timer);
    timer = undefined;
    if (!counts.size || stopped) return Promise.resolve();
    const time = new Date().toISOString();
    const envelopes: AzureMonitorEnvelope<MetricData>[] = [];
    for (const [key, value] of counts) {
      const [outcome, telemetryType, code] = key.split(":");
      const name = `Item_${outcome}_Count`;
      envelopes.push(
        createEnvelope(
          instrumentationKey,
          "Microsoft.ApplicationInsights.Metric",
          time,
          { "ai.internal.sdkVersion": getSdkVersion() },
          "MetricData",
          {
            ver: 2,
            metrics: [{ name, kind: 0, value }],
            properties: {
              telemetryType,
              language: "JavaScript",
              version: getSdkVersion(),
              computeType: "unknown",
              ...(code ? { [outcome === "Retry" ? "retryCode" : "dropCode"]: code } : {}),
            },
          },
        ),
      );
    }
    counts.clear();
    const controller = new AbortController();
    flushing = sendSdkStats(sender, envelopes, controller, isUnloading())
      .catch((error: unknown) => reportFailure(error, "Customer SDK stats export failed"))
      .finally(() => {
        controller.abort();
        flushing = undefined;
        schedule();
      });
    return flushing;
  }

  function shutdown(pending?: Promise<unknown>): Promise<void> {
    if (!shutdownPromise) {
      stopping = true;
      clearTimeout(timer);
      timer = undefined;
      shutdownPromise = (async () => {
        try {
          await pending;
        } finally {
          await flushing;
          await forceFlush();
          stopped = true;
          counts.clear();
        }
      })();
    }
    return shutdownPromise;
  }

  return { count, countEnvelopes, shouldCollectLog, forceFlush, shutdown };
}
