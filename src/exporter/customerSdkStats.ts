// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind } from "@opentelemetry/api";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { isRetriable } from "./breezeUtils.js";
import { createEnvelopeBatches, createTags, getSdkVersion, isUnloading } from "./common.js";
import { MAX_BATCH_SIZE_IN_BYTES } from "./constants.js";
import { spanSucceeded } from "./spanUtils.js";
import { Sender } from "./sender.js";
import { createSdkStatsEnvelope, reportFailure, sendSdkStats } from "./sdkStats.js";
import { isSdkIngestionUrl } from "../shared/globalOwnership.js";
import { waitForAll } from "../shared/lifecycle.js";
import type { AzureMonitorEnvelope, MetricData } from "./telemetryModels.js";

/**
 * Customer SDK Stats, configured at startup.
 *
 * @remarks
 * Transport counters count envelopes. Queue and sampling drops count source records.
 * Counts retain available application role and instance tags. Dropped requests and dependencies
 * are separated by their application success value, independently of export success.
 * Standalone exporters count observed delivery, retry and terminal-drop outcomes, not a durable
 * delivery ledger. Telemetry retained in memory or storage is not a drop; later expiry or eviction is not counted.
 * Cross-page drop attribution and deduplicated accounting after storage failures are deferred.
 * Reports bypass application pipelines, use the application batch-size threshold and ordinary
 * fetch, and time out after 10 seconds per request.
 * Retryable counts remain in memory for the next report, but are not persisted across page loads.
 * Shutdown makes one final attempt after any in-flight report, then discards remaining counts.
 * Reports are best-effort: page exit or enclosing processor deadlines may prevent completion,
 * and retrying an unacknowledged report can duplicate counts.
 * @public
 */
export interface AzureMonitorSdkStatsOptions {
  /**
   * Enables customer SDK Stats. Defaults to false and leaves internal SDK Stats unchanged.
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
  countFailedRecord(record: ReadableSpan | ReadableLogRecord, type: ItemType): void;
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

function envelopeItemType(envelope: AzureMonitorEnvelope): ItemType | undefined {
  if (typeof envelope?.data?.baseType !== "string") return undefined;
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

export function shouldCollectSdkStatsLog(record: ReadableLogRecord): boolean {
  if (
    record.eventName !== "browser.resource_timing" ||
    record.instrumentationScope.name !== "@opentelemetry/browser-instrumentation/resource-timing"
  )
    return true;
  const url = record.attributes["url.full"];
  // Resource timing runs after fetch suppression, so exclude ingestion requests.
  return !(typeof url === "string" && isSdkIngestionUrl(url));
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
  const ingestionEndpoint = `${endpoint}/v2/track`;
  const sender = new Sender({ endpoint: ingestionEndpoint, disableBeacon: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let stopping = false;
  let stopped = false;

  function schedule(): void {
    if (stopping || flushing || timer !== undefined || !counts.size) return;
    timer = setTimeout(() => void flush(), interval);
  }

  function count(
    outcome: ItemOutcome,
    type: ItemType,
    code = "",
    value = 1,
    tags?: Readonly<Record<string, string>>,
    success?: boolean,
  ): void {
    if (stopped || value <= 0) return;
    const key = JSON.stringify([
      outcome,
      type,
      code,
      tags?.["ai.cloud.role"] ?? "",
      tags?.["ai.cloud.roleInstance"] ?? "",
      outcome === "Dropped" && (type === "DEPENDENCY" || type === "REQUEST")
        ? (success ?? null)
        : null,
    ]);
    counts.set(key, (counts.get(key) ?? 0) + value);
    schedule();
  }

  function countFailedRecord(record: ReadableSpan | ReadableLogRecord, type: ItemType): void {
    const attributes = record.resource.attributes;
    count(
      "Dropped",
      type,
      "CLIENT_EXCEPTION",
      1,
      createTags(undefined, undefined, attributes["service.name"], {}, attributes),
      "kind" in record ? spanSucceeded(record) : undefined,
    );
  }

  function countEnvelopes(
    outcome: ItemOutcome,
    envelopes: readonly AzureMonitorEnvelope[] | undefined,
    code?: string | readonly string[],
  ): void {
    for (const [index, envelope] of (envelopes ?? []).entries()) {
      const type = envelopeItemType(envelope);
      if (type)
        count(
          outcome,
          type,
          typeof code === "string" ? code : code?.[index],
          1,
          envelope.tags,
          "success" in envelope.data.baseData ? envelope.data.baseData.success : undefined,
        );
    }
  }

  function forceFlush(): Promise<void> {
    // Include counters collected behind an older report without retrying failures in a loop.
    return flushing && counts.size ? flushing.then(flush) : flush();
  }

  function flush(): Promise<void> {
    if (flushing) return flushing;
    clearTimeout(timer);
    timer = undefined;
    if (!counts.size || stopped) return Promise.resolve();
    const time = new Date().toISOString();
    const pending = new Map<AzureMonitorEnvelope<MetricData>, readonly [string, number]>();
    for (const [key, value] of counts) {
      const [outcome, telemetryType, code, role, instance, success] = JSON.parse(key) as [
        ItemOutcome,
        ItemType,
        string,
        string,
        string,
        boolean | null,
      ];
      pending.set(
        createSdkStatsEnvelope(
          instrumentationKey,
          time,
          `Item_${outcome}_Count`,
          value,
          {
            telemetryType,
            language: "JavaScript",
            version: getSdkVersion(),
            computeType: "unknown",
            ...(code ? { [outcome === "Retry" ? "retryCode" : "dropCode"]: code } : {}),
            ...(success === null ? {} : { telemetrySuccess: success }),
          },
          undefined,
          {
            ...(role ? { "ai.cloud.role": role } : {}),
            ...(instance ? { "ai.cloud.roleInstance": instance } : {}),
          },
        ),
        [key, value],
      );
    }
    counts.clear();
    const unloading = isUnloading();
    flushing = waitForAll(
      createEnvelopeBatches([...pending.keys()], MAX_BATCH_SIZE_IN_BYTES).map(({ envelopes }) =>
        sendSdkStats(sender, envelopes, new AbortController(), unloading, {
          onResponse: (status) => {
            if (!isRetriable(status)) for (const envelope of envelopes) pending.delete(envelope);
          },
          onPartial: (remaining) => {
            const retriable = new Set(remaining);
            for (const envelope of envelopes) {
              if (!retriable.has(envelope)) pending.delete(envelope);
            }
          },
        }),
      ),
      "Customer SDK stats requests failed",
    )
      .catch((error: unknown) => {
        for (const [key, value] of pending.values()) {
          counts.set(key, (counts.get(key) ?? 0) + value);
        }
        reportFailure(error, "Customer SDK stats export failed");
      })
      .finally(() => {
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
          await flush();
          stopped = true;
          counts.clear();
          sender.dispose();
        }
      })();
    }
    return shutdownPromise;
  }

  return {
    count,
    countFailedRecord,
    countEnvelopes,
    shouldCollectLog: shouldCollectSdkStatsLog,
    forceFlush,
    shutdown,
  };
}
