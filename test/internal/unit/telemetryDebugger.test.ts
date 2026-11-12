// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import { TracerProvider, AlwaysOffSampler, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetryDebugger,
  type TelemetryDebugger,
  type TelemetryDebuggerOptions,
} from "../../../src/debug/index.js";
import { snapshot } from "../../../src/debug/snapshot.js";
import { createReadableLogRecord, createReadableSpan } from "../../fixtures/telemetry.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((fn) => fn()),
  );
  vi.restoreAllMocks();
  for (const result of results) if (result.status === "rejected") throw result.reason;
});

function debuggerForTest(options: TelemetryDebuggerOptions = {}): TelemetryDebugger {
  const debug = createTelemetryDebugger(options);
  cleanup.push(() => debug.dispose());
  return debug;
}

function pipeline(debug: TelemetryDebugger, sampled = true) {
  const exportSpan = vi.fn<SpanExporter["export"]>((_records, callback) =>
    callback({ code: ExportResultCode.SUCCESS }),
  );
  const exportLog = vi.fn<LogRecordExporter["export"]>((_records, callback) =>
    callback({ code: ExportResultCode.SUCCESS }),
  );
  const spans = new TracerProvider({
    ...(sampled ? {} : { sampler: new AlwaysOffSampler() }),
    spanProcessors: [
      debug.wrapSpanProcessor(
        new SimpleSpanProcessor(
          debug.wrapSpanExporter({
            export: exportSpan,
            shutdown: async () => {},
          }),
        ),
      ),
    ],
  });
  const logs = new LoggerProvider({
    processors: [
      debug.wrapLogRecordProcessor(
        new SimpleLogRecordProcessor({
          exporter: debug.wrapLogRecordExporter({
            export: exportLog,
            forceFlush: async () => {},
            shutdown: async () => {},
          }),
        }),
      ),
    ],
  });
  cleanup.push(async () => {
    await Promise.all([spans.shutdown(), logs.shutdown()]);
  });
  return {
    tracer: spans.getTracer("debug-test"),
    logger: logs.getLogger("debug-test"),
    exportSpan,
    exportLog,
    flush: () => Promise.all([spans.forceFlush(), logs.forceFlush()]),
  };
}

describe("telemetry debugger", () => {
  it("observes emission and successful export for both signals without mutating telemetry", async () => {
    const debug = debuggerForTest();
    const sdk = pipeline(debug);
    const span = sdk.tracer.startSpan("checkout", { attributes: { cart: 3 } });
    const parent = trace.setSpan(ROOT_CONTEXT, span);
    sdk.logger.emit({ eventName: "cart.ready", body: { count: 3 }, context: parent });
    span.end();
    await sdk.flush();
    const entries = debug.getEntries();
    for (const signal of ["span", "log"]) {
      expect(
        entries.filter((entry) => entry.signal === signal).map((entry) => entry.phase),
      ).toEqual(["emitted", "exported"]);
    }
    expect(new Set(entries.map((entry) => entry.traceId))).toEqual(
      new Set([span.spanContext().traceId]),
    );
    expect(sdk.exportSpan.mock.calls[0][0][0].attributes).toEqual({ cart: 3 });
    expect(sdk.exportLog.mock.calls[0][0][0].body).toEqual({ count: 3 });
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(
      performance
        .getEntriesByType("measure")
        .filter((entry) => entry.name.startsWith("otel.debug.")),
    ).toHaveLength(0);
  });

  it("keeps instances independent and does not make sampled-out spans visible", async () => {
    const first = debuggerForTest();
    const second = debuggerForTest();
    const a = pipeline(first, false);
    const b = pipeline(second);
    a.tracer.startSpan("sampled out").end();
    a.logger.emit({ eventName: "first" });
    b.tracer.startSpan("second").end();
    await Promise.all([a.flush(), b.flush()]);
    expect(first.getEntries().map((entry) => entry.name)).toEqual(["first", "first"]);
    expect(second.getEntries().map((entry) => entry.name)).toEqual(["second", "second"]);
    first.dispose();
    b.logger.emit({ eventName: "still running" });
    await b.flush();
    expect(second.getEntries().at(-1)?.name).toBe("still running");
  });

  it.each(["span", "log"] as const)(
    "preserves pending, failed, and throwing %s exporter behavior",
    (signal) => {
      const debug = debuggerForTest();
      let pending: ((result: ExportResult) => void) | undefined;
      const delegate = {
        export: vi.fn((_records: unknown[], callback: (result: ExportResult) => void) => {
          pending = callback;
        }),
        forceFlush: async () => {},
        shutdown: async () => {},
      };
      const callback = vi.fn();
      const send = () =>
        signal === "span"
          ? debug.wrapSpanExporter(delegate).export([createReadableSpan()], callback)
          : debug.wrapLogRecordExporter(delegate).export([createReadableLogRecord()], callback);
      send();
      expect(debug.getEntries()[0].phase).toBe("exporting");
      const result = { code: ExportResultCode.FAILED, error: new Error("transport failed") };
      pending?.(result);
      expect(callback).toHaveBeenCalledExactlyOnceWith(result);
      expect(debug.getEntries()[0].phase).toBe("failed");
      const failure = new Error("synchronous exporter failure");
      delegate.export.mockImplementation(() => {
        throw failure;
      });
      expect(send).toThrow(failure);
      expect(debug.getEntries().at(-1)?.phase).toBe("failed");
      expect(callback).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["span", "log"] as const)(
    "does not recall a throwing %s result callback or relabel success",
    (signal) => {
      const debug = debuggerForTest();
      const result = { code: ExportResultCode.SUCCESS };
      const delegate = {
        export: (_records: unknown[], callback: (result: ExportResult) => void) => callback(result),
        forceFlush: async () => {},
        shutdown: async () => {},
      };
      const failure = new Error("callback failure");
      const callback = vi.fn(() => {
        throw failure;
      });
      const send = () =>
        signal === "span"
          ? debug.wrapSpanExporter(delegate).export([createReadableSpan()], callback)
          : debug.wrapLogRecordExporter(delegate).export([createReadableLogRecord()], callback);
      expect(send).toThrow(failure);
      expect(callback).toHaveBeenCalledExactlyOnceWith(result);
      expect(debug.getEntries()[0].phase).toBe("exported");
    },
  );

  it("preserves processor hooks, receiver binding, enabled checks, and flush arguments", async () => {
    const debug = debuggerForTest();
    const onEnding = vi.fn<NonNullable<SpanProcessor["onEnding"]>>((span) =>
      span.setAttribute("ending", true),
    );
    const processor = {
      onStart: vi.fn(),
      onEnding,
      onEnd: vi.fn(),
      forceFlush: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const wrapped = debug.wrapSpanProcessor(processor);
    const provider = new TracerProvider({ spanProcessors: [wrapped] });
    provider.getTracer("hooks").startSpan("hooks").end();
    await provider.forceFlush();
    await provider.shutdown();
    expect(processor.onStart).toHaveBeenCalledOnce();
    expect(onEnding).toHaveBeenCalledOnce();
    expect(processor.onEnd.mock.calls[0][0].attributes.ending).toBe(true);
    expect(processor.forceFlush).toHaveBeenCalledOnce();
    expect(processor.shutdown).toHaveBeenCalledOnce();

    const enabled = vi.fn(function (this: object) {
      expect(this).toBe(logProcessor);
      return false;
    });
    const logProcessor = {
      enabled,
      onEmit: vi.fn(),
      forceFlush: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const log = debug.wrapLogRecordProcessor(logProcessor);
    const options = { context: ROOT_CONTEXT, instrumentationScope: { name: "test" } };
    expect(log.enabled?.(options)).toBe(false);
    expect(enabled).toHaveBeenCalledWith(options);
    const flush = { timeoutMillis: 10 };
    await log.forceFlush(flush);
    expect(logProcessor.forceFlush).toHaveBeenCalledWith(flush);
    const exporter = { export: vi.fn(), shutdown: async () => {} };
    expect(debug.wrapSpanExporter(exporter).forceFlush).toBeUndefined();
  });

  it("bounds observations and payloads, and pauses capture without stopping export", async () => {
    const debug = debuggerForTest({ maxEntries: 3, maxPayloadLength: 256 });
    const sdk = pipeline(debug);
    for (let i = 0; i < 10; i++)
      sdk.logger.emit({ eventName: `log-${i}`, body: "x".repeat(10000) });
    await sdk.flush();
    expect(debug.getEntries()).toHaveLength(3);
    expect(
      debug
        .getEntries()
        .every((entry) => entry.payload.length <= 256 && entry.payload.includes("[Truncated]")),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(debug.element.shadowRoot?.querySelector("output")?.textContent).toContain("17 older"),
    );
    debug.setPaused(true);
    sdk.logger.emit({ eventName: "not captured" });
    await sdk.flush();
    expect(sdk.exportLog).toHaveBeenCalledTimes(11);
    expect(debug.getEntries()).toHaveLength(3);
    debug.clear();
    expect(debug.getEntries()).toHaveLength(0);
    debug.setPaused(false);
    sdk.logger.emit({ eventName: "resumed" });
    await sdk.flush();
    expect(debug.getEntries().at(-1)?.name).toBe("resumed");
  });

  it("clears retained and in-flight work, and disposal leaves wrappers transparent", async () => {
    const debug = debuggerForTest({ performance: true, maxEntries: 2 });
    let complete: ((result: ExportResult) => void) | undefined;
    const delegate = {
      export: vi.fn((_records: unknown[], done: (result: ExportResult) => void) => {
        complete = done;
      }),
      shutdown: vi.fn(async () => {}),
    };
    const exporter = debug.wrapSpanExporter(delegate);
    const callback = vi.fn();
    exporter.export([createReadableSpan()], callback);
    debug.clear();
    complete?.({ code: ExportResultCode.SUCCESS });
    expect(debug.getEntries()).toHaveLength(0);
    exporter.export([createReadableSpan()], callback);
    debug.dispose();
    debug.dispose();
    complete?.({ code: ExportResultCode.SUCCESS });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(debug.element.isConnected).toBe(false);
    expect(debug.element.shadowRoot?.childElementCount).toBe(0);
    exporter.export([createReadableSpan()], callback);
    expect(delegate.export).toHaveBeenCalledTimes(3);
    await exporter.shutdown();
    expect(delegate.shutdown).toHaveBeenCalledOnce();
    expect(debug.getEntries()).toHaveLength(0);
    expect(
      performance
        .getEntriesByType("measure")
        .filter((entry) => entry.name.startsWith("otel.debug.")),
    ).toHaveLength(0);
  });

  it("bounds owned marks and measures, propagates timing failures, and preserves other timings", async () => {
    performance.mark("application-mark");
    cleanup.push(() => performance.clearMarks("application-mark"));
    const debug = debuggerForTest({ performance: true, maxEntries: 2 });
    for (let i = 0; i < 5; i++) expect(await debug.measure("initialize", async () => 42)).toBe(42);
    const owned = () =>
      performance.getEntries().filter((entry) => entry.name.startsWith("otel.debug."));
    expect(owned().filter((entry) => entry.entryType === "measure")).toHaveLength(2);
    expect(owned().filter((entry) => entry.entryType === "mark")).toHaveLength(4);
    const failure = new Error("initialization failed");
    await expect(
      debug.measure("initialize", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    debug.clear();
    expect(owned()).toHaveLength(0);
    expect(performance.getEntriesByName("application-mark")).toHaveLength(1);
    await expect(debug.measure("", async () => {})).rejects.toThrow(RangeError);
  });

  it("renders untrusted text safely and supports search, signal/phase filters, selection, and clearing", async () => {
    const debug = debuggerForTest();
    const sdk = pipeline(debug);
    sdk.tracer.startSpan("<img src=x onerror=alert(1)>").end();
    sdk.logger.emit({ eventName: "find-me", body: "<script>throw 1</script>" });
    await sdk.flush();
    const root = debug.element.shadowRoot!;
    await vi.waitFor(() => expect(root.querySelectorAll("li")).toHaveLength(4));
    expect(root.querySelectorAll("img,script")).toHaveLength(0);
    const select = root.querySelector<HTMLSelectElement>('[aria-label="Signal"]')!;
    select.value = "log";
    select.dispatchEvent(new Event("change"));
    expect(root.querySelectorAll("li")).toHaveLength(2);
    const phase = root.querySelector<HTMLSelectElement>('[aria-label="Phase"]')!;
    phase.value = "exported";
    phase.dispatchEvent(new Event("change"));
    expect(root.querySelectorAll("li")).toHaveLength(1);
    root.querySelector<HTMLButtonElement>("li button")!.click();
    expect(root.querySelector("pre")?.textContent).toContain("<script>throw 1</script>");
    const search = root.querySelector<HTMLInputElement>("input")!;
    search.value = "not present";
    search.dispatchEvent(new Event("input"));
    expect(root.querySelectorAll("li")).toHaveLength(0);
    debug.clear();
    expect(root.querySelector("pre")?.textContent).not.toContain("<script>");
  });

  it("reports snapshot failures without leaking payloads, recursing, or disrupting exports", () => {
    const debug = debuggerForTest();
    const span = createReadableSpan();
    const records = [span];
    const callback = vi.fn();
    const exporter = debug.wrapSpanExporter({
      export: (_records, done) => done({ code: ExportResultCode.SUCCESS }),
      shutdown: async () => {},
    });
    const report = vi.spyOn(diag, "error").mockImplementation(() => {
      exporter.export(records, callback);
      throw new Error("diagnostic failed");
    });
    Object.defineProperty(span, "attributes", {
      get() {
        throw new Error("secret payload");
      },
    });
    expect(() => exporter.export(records, callback)).not.toThrow();
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0].join(" ")).not.toContain("secret");
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not call payload accessors or toJSON and bounds cyclic, deep, and large snapshots", () => {
    const getter = vi.fn(() => "secret");
    const toJSON = vi.fn(() => {
      throw new Error("must not run");
    });
    const value = { toJSON, nested: {} };
    value.nested = value;
    Object.defineProperty(value, "secret", { enumerable: true, get: getter });
    expect(snapshot(value, 256)).toContain("[Circular]");
    expect(snapshot(value, 256)).toContain("[Accessor]");
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(
      snapshot(
        Array.from({ length: 10000 }, () => "x".repeat(1000)),
        256,
      ).length,
    ).toBeLessThanOrEqual(256);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 10001])(
    "rejects invalid entry limit %s before mounting",
    (maxEntries) => {
      const count = document.body.childElementCount;
      expect(() => createTelemetryDebugger({ maxEntries })).toThrow(RangeError);
      expect(document.body.childElementCount).toBe(count);
    },
  );
});
