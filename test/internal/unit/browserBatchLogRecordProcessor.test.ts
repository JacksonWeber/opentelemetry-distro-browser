// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { LoggerProvider, type ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { afterEach, expect, it, vi } from "vitest";
import {
  BrowserBatchLogRecordProcessor,
  type BrowserBatchLogRecordProcessorOptions,
} from "../../../src/browserBatchLogRecordProcessor.js";

const providers = new Set<LoggerProvider>();
const finishers = new Set<() => void>();

afterEach(async () => {
  for (const finish of finishers) finish();
  finishers.clear();
  vi.useRealTimers();
  const results = await Promise.allSettled([...providers].map((provider) => provider.shutdown()));
  providers.clear();
  vi.restoreAllMocks();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

function create(options: Partial<BrowserBatchLogRecordProcessorOptions> = {}) {
  const batches: ReadableLogRecord[][] = [];
  const callbacks: Array<(result: ExportResult) => void> = [];
  const exporter = {
    export: vi.fn((records: ReadableLogRecord[], callback: (result: ExportResult) => void) => {
      batches.push(records);
      callbacks.push(callback);
    }),
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  const processor = new BrowserBatchLogRecordProcessor({ exporter, ...options });
  const provider = new LoggerProvider({ processors: [processor] });
  providers.add(provider);
  const finish = (): void => {
    callbacks.splice(0).forEach((callback) => callback({ code: ExportResultCode.SUCCESS }));
  };
  finishers.add(() => {
    exporter.export.mockImplementation((_, callback) =>
      callback({ code: ExportResultCode.SUCCESS }),
    );
    finish();
  });
  return {
    processor,
    provider,
    logger: provider.getLogger("test"),
    exporter,
    batches,
    finish,
    finishNext(result: ExportResult) {
      const callback = callbacks.shift();
      if (!callback) throw new Error("No pending export to finish.");
      callback(result);
    },
  };
}

it("uses the one-second delay and exports after every processor has enriched the record", async () => {
  vi.useFakeTimers();
  const pipeline = create();
  const provider = new LoggerProvider({
    processors: [
      pipeline.processor,
      {
        onEmit: (record) => record.setAttribute("enriched", true),
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  providers.delete(pipeline.provider);
  providers.add(provider);
  provider.getLogger("test").emit({ body: "default delay" });
  await vi.advanceTimersByTimeAsync(999);
  expect(pipeline.batches).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(pipeline.batches[0][0].attributes).toEqual({ enriched: true });
  pipeline.finish();
});

it("schedules all flush batches without waiting for an older export response", async () => {
  vi.useFakeTimers();
  const pipeline = create({ maxExportBatchSize: 1 });
  pipeline.logger.emit({ body: "in-flight" });
  await vi.advanceTimersByTimeAsync(0);
  pipeline.logger.emit({ body: "queued-one" });
  pipeline.logger.emit({ body: "queued-two" });
  let settled = false;
  const flush = pipeline.processor.forceFlush().then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(0);
  expect(pipeline.batches.map((batch) => batch.map((record) => record.body))).toEqual([
    ["in-flight"],
    ["queued-one"],
    ["queued-two"],
  ]);
  expect(settled).toBe(false);
  pipeline.finish();
  await flush;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["forceFlush", "shutdown"] as const)(
  "waits for sibling batches after an export fails during %s",
  async (method) => {
    vi.useFakeTimers();
    const pipeline = create({ maxExportBatchSize: 1 });
    pipeline.logger.emit({ body: "failed batch" });
    pipeline.logger.emit({ body: "pending batch" });
    if (method === "shutdown") providers.delete(pipeline.provider);
    const operation = pipeline.processor[method]();
    let settled = false;
    void operation.then(
      () => (settled = true),
      () => (settled = true),
    );
    const failure = new Error("first batch failed");
    const rejection = expect(operation).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.batches).toHaveLength(2);
    pipeline.finishNext({ code: ExportResultCode.FAILED, error: failure });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(pipeline.exporter.shutdown).not.toHaveBeenCalled();

    pipeline.finish();
    await rejection;
    expect(settled).toBe(true);
    if (method === "shutdown") {
      expect(pipeline.exporter.shutdown).toHaveBeenCalledOnce();
      await expect(pipeline.provider.shutdown()).rejects.toBe(failure);
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["forceFlush", "shutdown"] as const)(
  "waits for sibling batches after an older export times out during %s",
  async (method) => {
    vi.useFakeTimers();
    const pipeline = create({ maxExportBatchSize: 1, exportTimeoutMillis: 100 });
    pipeline.logger.emit({ body: "older batch" });
    await vi.advanceTimersByTimeAsync(50);
    pipeline.logger.emit({ body: "pending batch" });
    if (method === "shutdown") providers.delete(pipeline.provider);
    const operation = pipeline.processor[method]();
    let settled = false;
    void operation.then(
      () => (settled = true),
      () => (settled = true),
    );
    const rejection = expect(operation).rejects.toThrow("Operation timed out");
    await vi.advanceTimersByTimeAsync(50);
    expect(pipeline.batches).toHaveLength(2);
    expect(settled).toBe(false);
    expect(pipeline.exporter.shutdown).not.toHaveBeenCalled();

    pipeline.finish();
    await rejection;
    expect(settled).toBe(true);
    if (method === "shutdown") {
      expect(pipeline.exporter.shutdown).toHaveBeenCalledOnce();
      await expect(pipeline.provider.shutdown()).rejects.toThrow("Operation timed out");
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("reports every failed batch after all exports settle", async () => {
  vi.useFakeTimers();
  const pipeline = create({ maxExportBatchSize: 1 });
  pipeline.logger.emit({ body: "first batch" });
  pipeline.logger.emit({ body: "second batch" });
  const first = new Error("first failure");
  const second = new Error("second failure");
  const rejection = expect(pipeline.processor.forceFlush()).rejects.toMatchObject({
    name: "AggregateError",
    errors: [first, second],
  });
  await vi.advanceTimersByTimeAsync(0);
  pipeline.finishNext({ code: ExportResultCode.FAILED, error: first });
  pipeline.finishNext({ code: ExportResultCode.FAILED, error: second });
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds the queue and batch size while an export is pending", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const pipeline = create({ maxQueueSize: 3, maxExportBatchSize: 2 });
  for (let index = 0; index < 7; index++) pipeline.logger.emit({ body: index });
  const flush = pipeline.processor.forceFlush();
  await vi.advanceTimersByTimeAsync(0);
  expect(pipeline.batches.map((batch) => batch.map((record) => record.body))).toEqual([
    [0, 1],
    [2, 3],
    [4],
  ]);
  expect(warning).toHaveBeenCalledOnce();
  pipeline.finish();
  await flush;
});

it("captures new records during a concurrent flush without exporting any record twice", async () => {
  vi.useFakeTimers();
  const pipeline = create();
  pipeline.logger.emit({ body: "first" });
  const first = pipeline.processor.forceFlush();
  pipeline.logger.emit({ body: "second" });
  const second = pipeline.processor.forceFlush();
  const duplicate = pipeline.processor.forceFlush();
  await vi.advanceTimersByTimeAsync(0);
  expect(pipeline.batches.map((batch) => batch.map((record) => record.body))).toEqual([
    ["first"],
    ["second"],
  ]);
  pipeline.finish();
  await Promise.all([first, second, duplicate]);
  pipeline.logger.emit({ body: "after returning to the page" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(pipeline.batches[2][0].body).toBe("after returning to the page");
  pipeline.finish();
});

it("reports failed flushes and shuts down the exporter even when the final batch fails", async () => {
  const failure = new Error("ingestion rejected the batch");
  const pipeline = create();
  pipeline.exporter.export.mockImplementation((_, callback) =>
    callback({ code: ExportResultCode.FAILED, error: failure }),
  );
  pipeline.logger.emit({ body: "failed" });
  providers.delete(pipeline.provider);
  const stop = pipeline.processor.shutdown();
  expect(pipeline.processor.shutdown()).toBe(stop);
  expect(pipeline.processor.forceFlush()).toBe(stop);
  await expect(stop).rejects.toBe(failure);
  expect(pipeline.exporter.shutdown).toHaveBeenCalledOnce();
  pipeline.logger.emit({ body: "after shutdown" });
  expect(pipeline.exporter.export).toHaveBeenCalledOnce();
  await expect(pipeline.provider.shutdown()).rejects.toBe(failure);
});

it("bounds a stuck export and ignores its late completion", async () => {
  vi.useFakeTimers();
  const pipeline = create({ exportTimeoutMillis: 20 });
  pipeline.logger.emit({ body: "stuck export" });
  const flush = pipeline.processor.forceFlush();
  let timedOut = false;
  void flush.catch(() => (timedOut = true));
  const rejected = expect(flush).rejects.toThrow("Operation timed out");
  await vi.advanceTimersByTimeAsync(19);
  expect(pipeline.exporter.export).toHaveBeenCalledOnce();
  expect(timedOut).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  pipeline.finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(pipeline.exporter.export).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("continues after a synchronous exporter failure", async () => {
  const pipeline = create();
  const failure = new Error("export threw");
  pipeline.exporter.export.mockImplementationOnce(() => {
    throw failure;
  });
  pipeline.logger.emit({ body: "failed" });
  await expect(pipeline.processor.forceFlush()).rejects.toBe(failure);
  pipeline.logger.emit({ body: "next" });
  const next = pipeline.processor.forceFlush();
  await vi.waitFor(() => expect(pipeline.batches).toHaveLength(1));
  pipeline.finish();
  await next;
});
