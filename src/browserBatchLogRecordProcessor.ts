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
import { runLifecycleTasks } from "./shared/lifecycle.js";

export type BrowserBatchLogRecordProcessorOptions = Pick<
  BatchLogRecordProcessorBrowserOptions,
  | "exporter"
  | "maxQueueSize"
  | "maxExportBatchSize"
  | "scheduledDelayMillis"
  | "exportTimeoutMillis"
>;

/**
 * Batches distribution-owned logs with the OpenTelemetry defaults.
 * Lifecycle listeners belong to the distribution, not individual processors.
 * Providers construct resources from resolved attributes before any logs are emitted.
 *
 * Unlike the upstream log processor, forceFlush schedules every queued batch before waiting
 * for older exports. An older response must not hold queued telemetry in a dying document.
 */
export class BrowserBatchLogRecordProcessor implements LogRecordProcessor {
  private readonly exporter: LogRecordExporter;
  private readonly maxQueueSize: number;
  private readonly maxExportBatchSize: number;
  private readonly scheduledDelayMillis: number;
  private readonly exportTimeoutMillis: number;
  private records: ReadableLogRecord[] = [];
  private readonly pending = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private queueFullReported = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(options: BrowserBatchLogRecordProcessorOptions) {
    this.exporter = options.exporter;
    this.maxQueueSize = options.maxQueueSize ?? 2048;
    const batchSize = options.maxExportBatchSize ?? 512;
    if (
      !Number.isSafeInteger(this.maxQueueSize) ||
      this.maxQueueSize <= 0 ||
      !Number.isSafeInteger(batchSize) ||
      batchSize <= 0
    ) {
      throw new RangeError("Log queue and batch sizes must be positive integers");
    }
    this.maxExportBatchSize = Math.min(batchSize, this.maxQueueSize);
    this.scheduledDelayMillis = options.scheduledDelayMillis ?? 1000;
    this.exportTimeoutMillis = options.exportTimeoutMillis ?? 30_000;
  }

  public onEmit(record: ReadWriteLogRecord): void {
    if (this.stopped) return;
    if (this.records.length >= this.maxQueueSize) {
      if (!this.queueFullReported) {
        this.queueFullReported = true;
        diag.warn("Log queue full; dropping records");
      }
      return;
    }
    this.queueFullReported = false;
    this.records.push(record);
    this.schedule();
  }

  public forceFlush(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.clearTimer();
    const records = this.records;
    this.records = [];
    const operations = [...this.pending];
    for (let offset = 0; offset < records.length; offset += this.maxExportBatchSize) {
      operations.push(this.exportBatch(records.slice(offset, offset + this.maxExportBatchSize)));
    }
    return runLifecycleTasks(
      operations.map((operation) => () => operation),
      "Log flush failed",
    );
  }

  public shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.stopped = true;
      this.shutdownPromise = this.forceFlush().finally(() => this.exporter.shutdown());
    }
    return this.shutdownPromise;
  }

  private schedule(): void {
    if (this.stopped || this.pending.size || !this.records.length) return;
    const flush = (): void => {
      this.clearTimer();
      const batch = this.records.splice(0, this.maxExportBatchSize);
      void this.exportBatch(batch).catch(globalErrorHandler);
    };
    if (this.records.length >= this.maxExportBatchSize) flush();
    else if (this.timer === undefined) this.timer = setTimeout(flush, this.scheduledDelayMillis);
  }

  private exportBatch(records: ReadableLogRecord[]): Promise<void> {
    // Defer until onEmit has returned and every processor has finished enriching the record.
    const operation = Promise.resolve().then(
      () =>
        new Promise<void>((resolve, reject) =>
          context.with(suppressTracing(context.active()), () =>
            this.exporter.export(records, (result) => {
              if (result.code === ExportResultCode.SUCCESS) resolve();
              else reject(result.error ?? new Error("Log export failed"));
            }),
          ),
        ),
    );
    const tracked = callWithTimeout(operation, this.exportTimeoutMillis).finally(() => {
      this.pending.delete(tracked);
      this.schedule();
    });
    this.pending.add(tracked);
    return tracked;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
