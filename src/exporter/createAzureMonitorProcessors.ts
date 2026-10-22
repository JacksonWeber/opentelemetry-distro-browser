// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AzureMonitorSamplingLogRecordProcessor } from "../samplingLogRecordProcessor.js";
import { StartupQueue } from "../shared/startupQueue.js";
import type { AzureMonitorOptions } from "./base.js";
import { AzureMonitorLogRecordExporter } from "./log.js";
import { AzureMonitorSpanExporter } from "./trace.js";
import { sessionBufferStorage } from "./sessionBuffer.js";
import {
  customerSdkStats,
  shouldCollectSdkStatsLog,
  spanItemType,
  type CustomerSdkStats,
  type ItemType,
} from "./customerSdkStats.js";
import { createStatsSpanProcessor } from "../statsSpanProcessor.js";
import { logItemType } from "./logUtils.js";

/** Creates only the Azure Monitor branches; custom processors never pass through this queue. */
export function createAzureMonitorProcessors(
  options: AzureMonitorOptions<string | Promise<string>>,
  tracesEnabled: boolean,
  logsEnabled: boolean,
  readSamplingPercentage: () => number | undefined,
  exporters: (AzureMonitorSpanExporter | AzureMonitorLogRecordExporter)[],
  onSpanStats?: (stats: CustomerSdkStats) => void,
): {
  span?: SpanProcessor;
  log?: LogRecordProcessor;
  stop: () => void;
  startDiagnostics: () => void;
} {
  let span: SpanProcessor | undefined;
  let log: AzureMonitorSamplingLogRecordProcessor | undefined;
  const startupDrops =
    options.sdkStats?.enabled && typeof options.connectionString !== "string"
      ? { span: new Map<ItemType, number>(), log: new Map<ItemType, number>() }
      : undefined;

  function transferDrops(signal: "span" | "log", stats: CustomerSdkStats | undefined): void {
    for (const [type, count] of startupDrops?.[signal] ?? []) {
      stats?.count("Dropped", type, "QUEUE_FULL", count);
    }
    startupDrops?.[signal].clear();
  }

  function initialize(connectionString: string): void {
    const resolved = { ...options, connectionString };
    // Storage policy is keyed by options identity; preserve it when resolving the destination.
    const storage = sessionBufferStorage.get(options);
    if (storage !== undefined) {
      sessionBufferStorage.set(resolved, storage);
    }
    if (tracesEnabled) {
      const exporter = new AzureMonitorSpanExporter(resolved);
      exporters.push(exporter);
      const stats = customerSdkStats.get(exporter);
      transferDrops("span", stats);
      if (stats) onSpanStats?.(stats);
      // The distribution already flushes on page hide.
      span = stats
        ? createStatsSpanProcessor({ exporter, disableAutoFlushOnDocumentHide: true }, stats)
        : new BatchSpanProcessor(exporter, { disableAutoFlushOnDocumentHide: true });
    }
    if (logsEnabled) {
      const exporter = new AzureMonitorLogRecordExporter(resolved);
      exporters.push(exporter);
      const stats = customerSdkStats.get(exporter);
      transferDrops("log", stats);
      log = new AzureMonitorSamplingLogRecordProcessor({
        exporter,
        samplingPercentage: readSamplingPercentage,
        shouldCollect: stats?.shouldCollectLog,
        onDrop: stats
          ? (record, reason) => stats.count("Dropped", logItemType(record), reason)
          : undefined,
      });
    }
  }

  // Keep the existing synchronous path: invalid strings still fail initialization.
  if (typeof options.connectionString === "string") {
    initialize(options.connectionString);
    return { span, log, stop() {}, startDiagnostics() {} };
  }

  // Promise settlement and timeout can precede diagnostic logger installation. Retain only
  // safe messages, not payloads or rejection reasons, until the instance is ready.
  let warnings: string[] | undefined = [];
  const queue = new StartupQueue<() => void>(options, (message) => {
    if (warnings) warnings.push(message);
    else diag.warn(message);
  });
  void Promise.resolve(options.connectionString).then(
    (connectionString) => {
      if (!queue.pending) return;
      try {
        initialize(connectionString);
        queue.activate((deliver) => deliver());
      } catch {
        // Do not include connection strings or rejection reasons in diagnostics.
        queue.fail();
      }
    },
    () => queue.fail(),
  );

  const stop = (): void => {
    queue.shutdown();
    startupDrops?.span.clear();
    startupDrops?.log.clear();
    warnings = undefined;
  };
  return {
    stop,
    startDiagnostics: () => {
      const buffered = warnings ?? [];
      warnings = undefined;
      for (const message of buffered) diag.warn(message);
    },
    span: tracesEnabled
      ? {
          onStart() {},
          onEnd: (record) => {
            if (queue.track(() => span?.onEnd(record)) === "QUEUE_FULL" && startupDrops) {
              const type = spanItemType(record.kind);
              startupDrops.span.set(type, (startupDrops.span.get(type) ?? 0) + 1);
            }
          },
          forceFlush: async () => {
            await span?.forceFlush();
          },
          shutdown: async () => {
            stop();
            await span?.shutdown();
          },
        }
      : undefined,
    log: logsEnabled
      ? {
          onEmit: (record) => {
            if (startupDrops && !shouldCollectSdkStatsLog(record)) return;
            const percentage = readSamplingPercentage();
            if (
              queue.track(() => log?.onEmitWithSamplingPercentage(record, percentage)) ===
                "QUEUE_FULL" &&
              startupDrops
            ) {
              const type = logItemType(record);
              startupDrops.log.set(type, (startupDrops.log.get(type) ?? 0) + 1);
            }
          },
          forceFlush: async () => {
            await log?.forceFlush();
          },
          shutdown: async () => {
            stop();
            await log?.shutdown();
          },
        }
      : undefined,
  };
}
