// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace, type TracerProvider } from "@opentelemetry/api";
import { logs, type LoggerProvider as ApiLoggerProvider } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry, type BrowserInstrumentation } from "../../../src/index.js";
import { getRegisteredGlobal } from "../../../src/shared/globalOwnership.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const apiKey = Symbol.for("opentelemetry.js.api.1");
const distroKey = Symbol.for("@microsoft/opentelemetry-browser");
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
const cleanup: Array<() => Promise<void>> = [];
let previousSession: string | null;

beforeEach(() => {
  previousSession = localStorage.getItem("opentelemetry-session");
});

afterEach(async () => {
  try {
    for (const stop of cleanup.splice(0).reverse()) await stop();
  } finally {
    trace.disable();
    logs.disable();
    context.disable();
    propagation.disable();
    diag.disable();
    delete realm[apiKey];
    delete realm[distroKey];
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (previousSession === null) localStorage.removeItem("opentelemetry-session");
    else localStorage.setItem("opentelemetry-session", previousSession);
  }
});

function probe() {
  let tracerProvider: TracerProvider | undefined;
  let loggerProvider: ApiLoggerProvider | undefined;
  return {
    setTracerProvider(provider) {
      tracerProvider = provider;
    },
    setLoggerProvider(provider) {
      loggerProvider = provider;
    },
    getConfig: () => ({ enabled: false }),
    enable() {},
    disable() {},
    emit(name: string) {
      tracerProvider?.getTracer("same-scope").startSpan(name).end();
      loggerProvider?.getLogger("same-scope").emit({ eventName: name });
    },
  } satisfies BrowserInstrumentation & { emit(name: string): void };
}

it.each(["trace", "logs", "context", "propagation"] as const)(
  "preserves a pre-existing %s registration while collecting into its own pipelines",
  async (signal) => {
    const foreignPipeline = createInMemoryPipeline();
    const foreignTrace = new BasicTracerProvider({
      spanProcessors: [foreignPipeline.spanProcessor],
    });
    const foreignLogs = new LoggerProvider({ processors: [foreignPipeline.logProcessor] });
    cleanup.push(
      () => foreignTrace.shutdown(),
      () => foreignLogs.shutdown(),
    );
    if (signal === "trace") trace.setGlobalTracerProvider(foreignTrace);
    if (signal === "logs") logs.setGlobalLoggerProvider(foreignLogs);
    if (signal === "context") context.setGlobalContextManager(new StackContextManager().enable());
    if (signal === "propagation") propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const original = getRegisteredGlobal(signal);
    const foreignShutdown = vi.spyOn(signal === "logs" ? foreignLogs : foreignTrace, "shutdown");
    const pipeline = createInMemoryPipeline();
    const instrumentation = probe();
    const error = vi.spyOn(diag, "error").mockImplementation(() => {});
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    const handle = await useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      instrumentations: [instrumentation],
    });
    cleanup.push(() => handle.shutdown());
    instrumentation.emit("isolated");
    await handle.forceFlush();
    expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(["isolated"]);
    expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual([
      "isolated",
    ]);
    expect(getRegisteredGlobal(signal)).toBe(original);
    expect(
      [...error.mock.calls, ...warn.mock.calls].some(
        ([message]) => typeof message === "string" && message.includes("conflict"),
      ),
    ).toBe(true);
    await handle.shutdown();
    expect(getRegisteredGlobal(signal)).toBe(original);
    expect(foreignShutdown).not.toHaveBeenCalled();
    if (signal === "trace") {
      trace.getTracer("foreign").startSpan("foreign").end();
      await foreignPipeline.forceFlush();
      expect(foreignPipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
    }
    if (signal === "logs") {
      logs.getLogger("foreign").emit({ eventName: "foreign" });
      await foreignPipeline.forceFlush();
      expect(foreignPipeline.logExporter.getFinishedLogRecords()).toHaveLength(1);
    }
  },
);

it("diagnoses an incompatible logs registry without invoking it or adopting its providers", async () => {
  const foreign = vi.fn(() => undefined);
  realm[Symbol.for("io.opentelemetry.js.api.logs")] = foreign;
  const warning = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const pipeline = createInMemoryPipeline();
  const instrumentation = probe();
  const handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: false },
    instrumentations: [instrumentation],
  });
  cleanup.push(() => handle.shutdown());
  instrumentation.emit("local");
  await handle.forceFlush();
  expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(1);
  expect(foreign).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("[logger-provider-conflict]"));
  expect(getRegisteredGlobal("logs")).toBe(foreign);
});

it.each(["1.8.0", "1.9.0", "1.9.2", "1.10.0"])(
  "cleans up pipelines when the loaded API cannot register page context in a %s registry",
  async (version) => {
    realm[apiKey] = { version };
    const pipeline = createInMemoryPipeline();
    const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    vi.spyOn(diag, "error").mockImplementation(() => {});
    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: false },
      }),
    ).rejects.toMatchObject({ code: "context-manager-conflict" });
    expect(realm[apiKey]).toEqual({ version });
    expect(getRegisteredGlobal("logs")).toBeUndefined();
    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
  },
);

it("rejects an incompatible distribution registry before accessing storage or caller resources", async () => {
  const registry = { version: 2 };
  realm[distroKey] = registry;
  const access = vi.spyOn(Storage.prototype, "getItem");
  await expect(
    useMicrosoftOpenTelemetry({
      session: { enabled: true },
      userContext: { enabled: true },
    }),
  ).rejects.toMatchObject({ code: "distribution-version-conflict" });
  expect(realm[distroKey]).toBe(registry);
  expect(access).not.toHaveBeenCalled();
});

it("allows concurrent initialization without replacing routers or mixing instrumentation telemetry", async () => {
  const first = createInMemoryPipeline();
  const second = createInMemoryPipeline();
  const a = probe();
  const b = probe();
  const handles = await Promise.all([
    useMicrosoftOpenTelemetry({
      ...first.options,
      pageView: { enabled: false },
      instrumentations: [a],
    }),
    useMicrosoftOpenTelemetry({
      ...second.options,
      pageView: { enabled: false },
      instrumentations: [b],
    }),
  ]);
  cleanup.push(...handles.map((handle) => () => handle.shutdown()));
  a.emit("a");
  b.emit("b");
  await Promise.all(handles.map((handle) => handle.forceFlush()));
  expect(first.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(["a"]);
  expect(second.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(["b"]);
  const router = trace.getTracerProvider();
  await handles[0].shutdown();
  trace.getTracer("same-scope").startSpan("next").end();
  await handles[1].forceFlush();
  expect(trace.getTracerProvider()).toBe(router);
  expect(second.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(["b", "next"]);
});

it.each(
  [false, true].flatMap((pageView) =>
    (["context", "propagation", "trace", "logs"] as const).map((signal) => ({ pageView, signal })),
  ),
)(
  "rejects a re-entrant $signal change with pageView=$pageView and leaves the foreign owner intact",
  async ({ pageView, signal }) => {
    const pipeline = createInMemoryPipeline();
    const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    const foreignManager = new StackContextManager().enable();
    const foreignTrace = new BasicTracerProvider();
    const foreignLogs = new LoggerProvider();
    cleanup.push(
      () => foreignTrace.shutdown(),
      () => foreignLogs.shutdown(),
      async () => {
        foreignManager.disable();
      },
    );
    const foreignDisable = vi.spyOn(foreignManager, "disable");
    const manager = new StackContextManager();
    const disable = vi.spyOn(manager, "disable");
    const enable = manager.enable.bind(manager);
    vi.spyOn(diag, "error").mockImplementation(() => {});
    let foreignRegistration: unknown;
    vi.spyOn(manager, "enable").mockImplementation(() => {
      enable();
      if (signal === "context") context.setGlobalContextManager(foreignManager);
      if (signal === "propagation")
        propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      if (signal === "trace") trace.setGlobalTracerProvider(foreignTrace);
      if (signal === "logs") logs.setGlobalLoggerProvider(foreignLogs);
      foreignRegistration = getRegisteredGlobal(signal);
      return manager;
    });
    const instrumentation = probe();
    const bind = vi.spyOn(instrumentation, "setTracerProvider");
    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: pageView },
        traces: { contextManager: manager },
        instrumentations: [instrumentation],
      }),
    ).rejects.toMatchObject({
      code: {
        context: "context-manager-conflict",
        propagation: "propagator-conflict",
        trace: "tracer-provider-conflict",
        logs: "logger-provider-conflict",
      }[signal],
    });
    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledOnce();
    expect(foreignDisable).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    for (const key of ["trace", "context", "propagation", "logs"] as const) {
      expect(getRegisteredGlobal(key)).toBe(key === signal ? foreignRegistration : undefined);
    }
  },
);

it("preserves a manager that registers itself from enable()", async () => {
  const pipeline = createInMemoryPipeline();
  const manager = new StackContextManager();
  const disable = vi.spyOn(manager, "disable");
  vi.spyOn(diag, "error").mockImplementation(() => {});
  vi.spyOn(manager, "enable").mockImplementation(() => {
    context.setGlobalContextManager(manager);
    return manager;
  });
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      traces: { contextManager: manager },
    }),
  ).rejects.toMatchObject({ code: "context-manager-conflict" });
  expect(disable).not.toHaveBeenCalled();
  expect(getRegisteredGlobal("context")).toBe(manager);
});

it("cleans up both pipelines when enable throws and allows retry", async () => {
  const pipeline = createInMemoryPipeline();
  const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
  const manager = new StackContextManager();
  const failure = new Error("enable failed");
  vi.spyOn(manager, "enable").mockImplementation(() => {
    throw failure;
  });
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      traces: { contextManager: manager },
    }),
  ).rejects.toBe(failure);
  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
  const next = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({ ...next.options, pageView: { enabled: false } });
  cleanup.push(() => handle.shutdown());
  trace.getTracer("retry").startSpan("retry").end();
  await handle.forceFlush();
  expect(next.spanExporter.getFinishedSpans()).toHaveLength(1);
});

it("rejects a propagator fields callback that changes globals without disturbing that owner", async () => {
  const pipeline = createInMemoryPipeline();
  const foreign = new W3CTraceContextPropagator();
  const fields = vi.fn(() => {
    propagation.setGlobalPropagator(foreign);
    return [];
  });
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      traces: { propagators: [{ fields, inject() {}, extract: (ctx) => ctx }] },
    }),
  ).rejects.toMatchObject({ code: "propagator-conflict" });
  expect(fields).toHaveBeenCalledOnce();
  expect(getRegisteredGlobal("propagation")).toBe(foreign);
  expect(getRegisteredGlobal("trace")).toBeUndefined();
  expect(getRegisteredGlobal("logs")).toBeUndefined();
});

it("preserves earlier instances when a later instrumentation fails", async () => {
  const first = createInMemoryPipeline();
  const firstHandle = await useMicrosoftOpenTelemetry({
    ...first.options,
    pageView: { enabled: false },
  });
  cleanup.push(() => firstHandle.shutdown());
  const original = [
    getRegisteredGlobal("trace"),
    getRegisteredGlobal("context"),
    getRegisteredGlobal("propagation"),
    getRegisteredGlobal("logs"),
  ];
  const second = createInMemoryPipeline();
  const failure = new Error("instrumentation failed");
  await expect(
    useMicrosoftOpenTelemetry({
      ...second.options,
      pageView: { enabled: false },
      instrumentations: [
        {
          ...probe(),
          enable() {
            throw failure;
          },
        },
      ],
    }),
  ).rejects.toBe(failure);
  expect([
    getRegisteredGlobal("trace"),
    getRegisteredGlobal("context"),
    getRegisteredGlobal("propagation"),
    getRegisteredGlobal("logs"),
  ]).toEqual(original);
  trace.getTracer("first").startSpan("still-running").end();
  logs.getLogger("first").emit({ eventName: "still-running" });
  await firstHandle.forceFlush();
  expect(first.spanExporter.getFinishedSpans()).toHaveLength(1);
  expect(first.logExporter.getFinishedLogRecords()).toHaveLength(1);
});

it("preserves a running logs-only instance when first-trace context startup fails", async () => {
  const first = createInMemoryPipeline();
  cleanup.push(() => first.spanProcessor.shutdown());
  const firstHandle = await useMicrosoftOpenTelemetry({
    spanProcessors: [],
    logRecordProcessors: first.options.logRecordProcessors,
    pageView: { enabled: false },
  });
  cleanup.push(() => firstHandle.shutdown());
  const logger = getRegisteredGlobal("logs");
  const second = createInMemoryPipeline();
  const manager = new StackContextManager();
  const foreign = new StackContextManager().enable();
  vi.spyOn(manager, "enable").mockImplementation(() => {
    context.setGlobalContextManager(foreign);
    return manager;
  });
  await expect(
    useMicrosoftOpenTelemetry({
      ...second.options,
      traces: { contextManager: manager },
    }),
  ).rejects.toMatchObject({ code: "context-manager-conflict" });
  expect(getRegisteredGlobal("logs")).toBe(logger);
  expect(getRegisteredGlobal("context")).toBe(foreign);
  logs.getLogger("survivor").emit({ eventName: "survivor" });
  await firstHandle.forceFlush();
  expect(first.logExporter.getFinishedLogRecords()).toHaveLength(1);
});

it("removes only new page registrations when propagation registration fails", async () => {
  const pipeline = createInMemoryPipeline();
  const foreign = new W3CTraceContextPropagator();
  const register = propagation.setGlobalPropagator.bind(propagation);
  vi.spyOn(propagation, "setGlobalPropagator").mockImplementationOnce(() => {
    register(foreign);
    return false;
  });
  const manager = new StackContextManager();
  const disable = vi.spyOn(manager, "disable");
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      traces: { contextManager: manager },
    }),
  ).rejects.toMatchObject({ code: "propagator-conflict" });
  expect(getRegisteredGlobal("context")).toBeUndefined();
  expect(getRegisteredGlobal("propagation")).toBe(foreign);
  expect(disable).toHaveBeenCalledOnce();
  expect(getRegisteredGlobal("trace")).toBeUndefined();
  expect(getRegisteredGlobal("logs")).toBeUndefined();
});

it("cleans up partially created owned processors before handing them to a pipeline", async () => {
  const spanShutdown = vi.spyOn(BatchSpanProcessor.prototype, "shutdown");
  const logShutdown = vi.spyOn(BatchLogRecordProcessor.prototype, "shutdown");
  const failure = new Error("session storage failed");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw failure;
  });
  await expect(
    useMicrosoftOpenTelemetry({
      session: { enabled: true },
      pageView: { enabled: false },
    }),
  ).rejects.toBe(failure);
  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
});
