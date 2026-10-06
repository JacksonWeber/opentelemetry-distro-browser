// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
} from "../../../src/index.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const handles = new Set<MicrosoftOpenTelemetryBrowser>();

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

function failingInstrumentation(
  failure: Error,
  method: "setTracerProvider" | "setLoggerProvider" | "getConfig" | "enable" = "enable",
): BrowserInstrumentation {
  return {
    setTracerProvider() {},
    setLoggerProvider() {},
    getConfig: () => ({ enabled: false }),
    enable() {},
    disable() {},
    [method]() {
      throw failure;
    },
  };
}

it.each(
  [false, true].flatMap((pageView) =>
    (["setTracerProvider", "setLoggerProvider", "getConfig", "enable"] as const).map((method) => ({
      pageView,
      method,
    })),
  ),
)(
  "exports after retrying a $method failure with pageView=$pageView",
  async ({ method, pageView }) => {
    const failure = new Error("instrumentation initialization failed");
    const failed = createInMemoryPipeline();
    const manager = new StackContextManager();
    const disable = vi.spyOn(manager, "disable");
    await expect(
      useMicrosoftOpenTelemetry({
        ...failed.options,
        session: { enabled: true },
        pageView: { enabled: pageView },
        traces: { contextManager: manager, propagators: [] },
        instrumentations: [failingInstrumentation(failure, method)],
      }),
    ).rejects.toBe(failure);
    expect(disable).toHaveBeenCalledOnce();

    const retry = createInMemoryPipeline();
    const handle = await useMicrosoftOpenTelemetry({
      ...retry.options,
      pageView: { enabled: pageView },
    });
    handles.add(handle);
    const operation = trace.getSpanContext(context.active());
    if (pageView) expect(operation).toBeDefined();
    else expect(operation).toBeUndefined();

    const tracer = trace.getTracer("retry");
    tracer.startActiveSpan("retry-parent", (parent) => {
      expect(trace.getSpan(context.active())).toBe(parent);
      logs.getLogger("retry").emit({ body: "retry-log" });
      tracer.startSpan("retry-child").end();
      parent.end();
    });
    await handle.forceFlush();

    const [child, parent] = retry.spanExporter.getFinishedSpans();
    expect(child.name).toBe("retry-child");
    expect(parent.name).toBe("retry-parent");
    expect(child.parentSpanContext).toEqual(parent.spanContext());
    expect(parent.parentSpanContext).toEqual(operation);
    expect(retry.logExporter.getFinishedLogRecords()).toEqual([
      expect.objectContaining({ body: "retry-log", spanContext: parent.spanContext() }),
    ]);
    const headers: Record<string, string> = {};
    propagation.inject(trace.setSpanContext(ROOT_CONTEXT, parent.spanContext()), headers);
    expect(headers.traceparent).toContain(parent.spanContext().traceId);
  },
);

it("preserves existing providers, context and propagation when a second initialization fails", async () => {
  const existing = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry(existing.options);
  handles.add(handle);
  const tracerProvider = trace.getTracerProvider();
  const loggerProvider = logs.getLoggerProvider();
  const operation = trace.getSpanContext(context.active());
  const failed = createInMemoryPipeline();
  const failure = new Error("second initialization failed");

  await expect(
    useMicrosoftOpenTelemetry({
      ...failed.options,
      instrumentations: [failingInstrumentation(failure)],
    }),
  ).rejects.toBe(failure);

  expect(trace.getTracerProvider()).toBe(tracerProvider);
  expect(logs.getLoggerProvider()).toBe(loggerProvider);
  expect(trace.getSpanContext(context.active())).toBe(operation);
  expect(propagation.fields()).toContain("traceparent");
  trace.getTracer("existing").startSpan("still-recording").end();
  logs.getLogger("existing").emit({ body: "still-recording" });
  await handle.forceFlush();
  expect(existing.spanExporter.getFinishedSpans()).toHaveLength(1);
  expect(existing.logExporter.getFinishedLogRecords()).toEqual([
    expect.objectContaining({ body: "still-recording", spanContext: operation }),
  ]);
});

it.each(["traces", "logs"] as const)(
  "preserves existing %s while rolling back the newly registered signal",
  async (existingSignal) => {
    const existing = createInMemoryPipeline();
    const existingHandle = await useMicrosoftOpenTelemetry({
      spanProcessors: existingSignal === "traces" ? existing.options.spanProcessors : [],
      logRecordProcessors: existingSignal === "logs" ? existing.options.logRecordProcessors : [],
      pageView: { enabled: false },
    });
    handles.add(existingHandle);
    const failed = createInMemoryPipeline();
    const failure = new Error("initialization failed");
    await expect(
      useMicrosoftOpenTelemetry({
        ...failed.options,
        pageView: { enabled: false },
        instrumentations: [failingInstrumentation(failure)],
      }),
    ).rejects.toBe(failure);

    const retry = createInMemoryPipeline();
    const retryHandle = await useMicrosoftOpenTelemetry({
      spanProcessors: existingSignal === "traces" ? [] : retry.options.spanProcessors,
      logRecordProcessors: existingSignal === "logs" ? [] : retry.options.logRecordProcessors,
      pageView: { enabled: false },
    });
    handles.add(retryHandle);
    trace.getTracer("mixed").startSpan("mixed").end();
    logs.getLogger("mixed").emit({ body: "mixed" });
    await Promise.all([existingHandle.forceFlush(), retryHandle.forceFlush()]);
    const traces = existingSignal === "traces" ? existing : retry;
    const records = existingSignal === "logs" ? existing : retry;
    expect(traces.spanExporter.getFinishedSpans()).toEqual([
      expect.objectContaining({ name: "mixed" }),
    ]);
    expect(records.logExporter.getFinishedLogRecords()).toEqual([
      expect.objectContaining({ body: "mixed" }),
    ]);
  },
);

it("binds working instrumentation after several consecutive initialization failures", async () => {
  const failure = new Error("initialization failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    const failed = createInMemoryPipeline();
    const spanShutdown = vi.spyOn(failed.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(failed.logProcessor, "shutdown");
    await expect(
      useMicrosoftOpenTelemetry({
        ...failed.options,
        instrumentations: [failingInstrumentation(failure)],
      }),
    ).rejects.toBe(failure);
    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
  }

  const retry = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({
    ...retry.options,
    pageView: { enabled: false },
    instrumentations: [
      {
        setTracerProvider(provider) {
          provider.getTracer("instrumentation").startSpan("instrumented-span").end();
        },
        setLoggerProvider(provider) {
          provider.getLogger("instrumentation").emit({ body: "instrumented-log" });
        },
        getConfig: () => ({ enabled: false }),
        enable() {},
        disable() {},
      },
    ],
  });
  handles.add(handle);
  await handle.forceFlush();
  expect(retry.spanExporter.getFinishedSpans()).toEqual([
    expect.objectContaining({ name: "instrumented-span" }),
  ]);
  expect(retry.logExporter.getFinishedLogRecords()).toEqual([
    expect.objectContaining({ body: "instrumented-log" }),
  ]);
});

it.each(["traces", "logs", "both"] as const)(
  "preserves independently registered context APIs after a %s startup fails",
  async (signals) => {
    const manager = new StackContextManager().enable();
    const disable = vi.spyOn(manager, "disable");
    context.setGlobalContextManager(manager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const failed = createInMemoryPipeline();
    const failure = new Error("initialization failed");
    await expect(
      useMicrosoftOpenTelemetry({
        spanProcessors: signals === "logs" ? [] : failed.options.spanProcessors,
        logRecordProcessors: signals === "traces" ? [] : failed.options.logRecordProcessors,
        instrumentations: [failingInstrumentation(failure)],
      }),
    ).rejects.toBe(failure);

    expect(disable).not.toHaveBeenCalled();
    expect(propagation.fields()).toEqual(["traceparent", "tracestate"]);
    const active = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      traceFlags: 1,
    });
    context.with(active, () => expect(manager.active()).toBe(active));

    const retry = createInMemoryPipeline();
    const handle = await useMicrosoftOpenTelemetry({
      ...retry.options,
      pageView: { enabled: false },
    });
    handles.add(handle);
    trace.getTracer("retry").startSpan("retry").end();
    logs.getLogger("retry").emit({ body: "retry" });
    await handle.forceFlush();
    expect(retry.spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(retry.logExporter.getFinishedLogRecords()).toHaveLength(1);
  },
);

it.each(["instrumentation", "provider"] as const)(
  "allows retry and preserves the initialization error when %s shutdown fails",
  async (shutdownFailure) => {
    const failed = createInMemoryPipeline();
    const failure = new Error("initialization failed");
    const cleanupFailure = new Error("shutdown failed");
    const report = vi.spyOn(diag, "error");
    const instrumentation = failingInstrumentation(failure);
    if (shutdownFailure === "instrumentation") {
      instrumentation.disable = () => {
        throw cleanupFailure;
      };
    } else {
      const shutdown = failed.logProcessor.shutdown.bind(failed.logProcessor);
      vi.spyOn(failed.logProcessor, "shutdown").mockImplementation(async () => {
        await shutdown();
        throw cleanupFailure;
      });
    }
    await expect(
      useMicrosoftOpenTelemetry({ ...failed.options, instrumentations: [instrumentation] }),
    ).rejects.toBe(failure);
    expect(report).toHaveBeenCalledWith(
      "Telemetry initialization cleanup failed",
      shutdownFailure === "instrumentation" ? cleanupFailure : expect.any(Error),
    );

    const retry = createInMemoryPipeline();
    const handle = await useMicrosoftOpenTelemetry({
      ...retry.options,
      pageView: { enabled: false },
    });
    handles.add(handle);
    trace.getTracer("retry").startSpan("retry").end();
    logs.getLogger("retry").emit({ body: "retry" });
    await handle.forceFlush();
    expect(retry.spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(retry.logExporter.getFinishedLogRecords()).toHaveLength(1);
  },
);

it("keeps replacement globals installed while rollback awaits provider shutdown", async () => {
  const failed = createInMemoryPipeline();
  const failure = new Error("initialization failed");
  let finishShutdown!: () => void;
  const pendingShutdown = new Promise<void>((resolve) => {
    finishShutdown = resolve;
  });
  const shutdown = failed.logProcessor.shutdown.bind(failed.logProcessor);
  const logShutdown = vi.spyOn(failed.logProcessor, "shutdown").mockImplementation(async () => {
    await pendingShutdown;
    await shutdown();
  });
  const initialization = useMicrosoftOpenTelemetry({
    ...failed.options,
    instrumentations: [failingInstrumentation(failure)],
  });
  const rejection = expect(initialization).rejects.toBe(failure);

  try {
    await vi.waitFor(() => expect(logShutdown).toHaveBeenCalledOnce());
    trace.disable();
    logs.disable();
    propagation.disable();
    context.disable();
    const replacement = createInMemoryPipeline();
    const manager = new StackContextManager();
    const disable = vi.spyOn(manager, "disable");
    const handle = await useMicrosoftOpenTelemetry({
      ...replacement.options,
      traces: { contextManager: manager },
    });
    handles.add(handle);
    const operation = trace.getSpanContext(context.active());
    finishShutdown();
    await rejection;

    expect(disable).not.toHaveBeenCalled();
    expect(trace.getSpanContext(context.active())).toBe(operation);
    expect(propagation.fields()).toContain("traceparent");
    trace.getTracer("replacement").startSpan("replacement").end();
    logs.getLogger("replacement").emit({ body: "replacement" });
    await handle.forceFlush();
    expect(replacement.spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(replacement.logExporter.getFinishedLogRecords()).toEqual([
      expect.objectContaining({ body: "replacement", spanContext: operation }),
    ]);
  } finally {
    finishShutdown();
    await rejection;
  }
});
