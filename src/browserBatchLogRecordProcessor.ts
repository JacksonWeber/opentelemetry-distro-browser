// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag } from "@opentelemetry/api";
import {
  callWithTimeout,
  ExportResultCode,
  globalErrorHandler,
  suppressTracing,
} from "@opentelemetry/core";
import type {
  BatchLogRecordProcessorBrowserOptions,
  LogRecordExporter,
  LogRecordProcessor,
  ReadableLogRecord,
  ReadWriteLogRecord,
} from "@opentelemetry/sdk-logs";
import { runLifecycleTasks, waitForAll } from "./shared/lifecycle.js";

export type BrowserBatchLogRecordProcessorOptions = Pick<
  BatchLogRecordProcessorBrowserOptions,
  | "exporter"
  | "maxQueueSize"
  | "maxExportBatchSize"
  | "scheduledDelayMillis"
  | "exportTimeoutMillis"
> & {
  onDrop?: (record: ReadableLogRecord, reason: "QUEUE_FULL" | "SAMPLING") => void;
  shouldCollect?: (record: ReadableLogRecord) => boolean;
};

/**
 * Batches distribution-owned logs with the OpenTelemetry defaults.
 * Lifecycle listeners belong to the distribution, not individual processors.
 * Providers construct resources from resolved attributes before any logs are emitted.
 *
 * Unlike the upstream log processor, forceFlush schedules every queued batch before waiting
 * for older exports. An older response must not hold queued telemetry in a dying document.
 */
export class BrowserBatchLogRecordProcessor implements LogRecordProcessor {
  readonly #exporter: LogRecordExporter;
  readonly #maxQueueSize: number;
  readonly #maxExportBatchSize: number;
  readonly #scheduledDelayMillis: number;
  readonly #exportTimeoutMillis: number;
  #records: ReadableLogRecord[] = [];
  readonly #pending = new Set<Promise<void>>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #queueFullReported = false;
  #shutdownPromise: Promise<void> | undefined;
  readonly #onDrop: BrowserBatchLogRecordProcessorOptions["onDrop"];
  readonly #shouldCollect: BrowserBatchLogRecordProcessorOptions["shouldCollect"];

  public constructor(options: BrowserBatchLogRecordProcessorOptions) {
    this.#exporter = options.exporter;
    this.#onDrop = options.onDrop;
    this.#shouldCollect = options.shouldCollect;
    this.#maxQueueSize = options.maxQueueSize ?? 2048;
    const batchSize = options.maxExportBatchSize ?? 512;
    if (
      !Number.isSafeInteger(this.#maxQueueSize) ||
      this.#maxQueueSize <= 0 ||
      !Number.isSafeInteger(batchSize) ||
      batchSize <= 0
    ) {
      throw new RangeError("Log queue and batch sizes must be positive integers");
    }
    this.#maxExportBatchSize = Math.min(batchSize, this.#maxQueueSize);
    this.#scheduledDelayMillis = options.scheduledDelayMillis ?? 1000;
    this.#exportTimeoutMillis = options.exportTimeoutMillis ?? 30_000;
  }

  public onEmit(record: ReadWriteLogRecord): void {
    if (!this.accepts(record)) return;
    if (this.#records.length >= this.#maxQueueSize) {
      this.drop(record, "QUEUE_FULL");
      if (!this.#queueFullReported) {
        this.#queueFullReported = true;
        diag.warn("Log queue full; dropping records");
      }
      return;
    }
    this.#queueFullReported = false;
    this.#records.push(record);
    this.#schedule();
  }

  protected drop(record: ReadableLogRecord, reason: "QUEUE_FULL" | "SAMPLING"): void {
    if (!this.#stopped) this.#onDrop?.(record, reason);
  }

  protected accepts(record: ReadableLogRecord): boolean {
    return !this.#stopped && (this.#shouldCollect?.(record) ?? true);
  }

  public forceFlush(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#clearTimer();
    const records = this.#records;
    this.#records = [];
    const operations = [...this.#pending];
    for (let offset = 0; offset < records.length; offset += this.#maxExportBatchSize) {
      operations.push(this.#exportBatch(records.slice(offset, offset + this.#maxExportBatchSize)));
    }
    return waitForAll(operations, "Log flush failed");
  }

  public shutdown(): Promise<void> {
    if (!this.#shutdownPromise) {
      this.#stopped = true;
      const flush = this.forceFlush();
      const cleanup = (): Promise<void> =>
        runLifecycleTasks([() => this.#exporter.shutdown()], "Log exporter shutdown failed");
      // Cleanup follows flush even on failure; keep each rejection instead of replacing it.
      this.#shutdownPromise = waitForAll(
        [flush, flush.then(cleanup, cleanup)],
        "Log shutdown failed",
      );
    }
    return this.#shutdownPromise;
  }

  #schedule(): void {
    if (this.#stopped || this.#pending.size || !this.#records.length) return;
    const flush = (): void => {
      this.#clearTimer();
      const batch = this.#records.splice(0, this.#maxExportBatchSize);
      void this.#exportBatch(batch).catch(globalErrorHandler);
    };
    if (this.#records.length >= this.#maxExportBatchSize) flush();
    else if (this.#timer === undefined) this.#timer = setTimeout(flush, this.#scheduledDelayMillis);
  }

  #exportBatch(records: ReadableLogRecord[]): Promise<void> {
    // Defer until onEmit has returned and every processor has finished enriching the record.
    const operation = Promise.resolve().then(
      () =>
        new Promise<void>((resolve, reject) =>
          context.with(suppressTracing(context.active()), () =>
            this.#exporter.export(records, (result) => {
              if (result.code === ExportResultCode.SUCCESS) resolve();
              else reject(result.error ?? new Error("Log export failed"));
            }),
          ),
        ),
    );
    const tracked = callWithTimeout(operation, this.#exportTimeoutMillis).finally(() => {
      this.#pending.delete(tracked);
      this.#schedule();
    });
    this.#pending.add(tracked);
    return tracked;
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
