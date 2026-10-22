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

/** Creates only the Azure Monitor branches; custom processors never pass through this queue. */
export function createAzureMonitorProcessors(
  options: AzureMonitorOptions<string | Promise<string>>,
  tracesEnabled: boolean,
  logsEnabled: boolean,
  readSamplingPercentage: () => number | undefined,
  exporters: (AzureMonitorSpanExporter | AzureMonitorLogRecordExporter)[],
): {
  span?: SpanProcessor;
  log?: LogRecordProcessor;
  stop: () => void;
  startDiagnostics: () => void;
} {
  let span: SpanProcessor | undefined;
  let log: AzureMonitorSamplingLogRecordProcessor | undefined;

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
      // The distribution already flushes on page hide.
      span = new BatchSpanProcessor(exporter, { disableAutoFlushOnDocumentHide: true });
    }
    if (logsEnabled) {
      const exporter = new AzureMonitorLogRecordExporter(resolved);
      exporters.push(exporter);
      log = new AzureMonitorSamplingLogRecordProcessor({
        exporter,
        samplingPercentage: readSamplingPercentage,
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

  return {
    stop: () => {
      queue.shutdown();
      warnings = undefined;
    },
    startDiagnostics: () => {
      const buffered = warnings ?? [];
      warnings = undefined;
      for (const message of buffered) diag.warn(message);
    },
    span: tracesEnabled
      ? {
          onStart() {},
          onEnd: (record) => queue.track(() => span?.onEnd(record)),
          forceFlush: async () => {
            await span?.forceFlush();
          },
          shutdown: async () => {
            queue.shutdown();
            await span?.shutdown();
          },
        }
      : undefined,
    log: logsEnabled
      ? {
          onEmit: (record) => {
            const percentage = readSamplingPercentage();
            queue.track(() => log?.onEmitWithSamplingPercentage(record, percentage));
          },
          forceFlush: async () => {
            await log?.forceFlush();
          },
          shutdown: async () => {
            queue.shutdown();
            await log?.shutdown();
          },
        }
      : undefined,
  };
}
