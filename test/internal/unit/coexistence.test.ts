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
import { getRegisteredGlobal, getSharedRegistry } from "../../../src/shared/globalOwnership.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";
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

it.each(["OTLP", "Azure Monitor"])(
  "cleans up owned %s processors when the application's diagnostic logger throws during startup",
  async (destination) => {
    const failure = new Error("application diagnostic logger failed");
    const logger = {
      error: vi.fn(),
      warn: vi.fn<() => void>(() => {
        throw failure;
      }),
      info: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
    };
    diag.setLogger(logger);
    const spanShutdown = vi.spyOn(BatchSpanProcessor.prototype, "shutdown");
    const logShutdown = vi.spyOn(BatchLogRecordProcessor.prototype, "shutdown");
    const instrumentation = probe();
    const bind = vi.spyOn(instrumentation, "setTracerProvider");

    await expect(
      useMicrosoftOpenTelemetry({
        ...(destination === "Azure Monitor"
          ? {
              azureMonitor: {
                connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
              },
            }
          : {}),
        pageView: { enabled: false },
        instrumentations: [instrumentation],
      }),
    ).rejects.toBe(failure);

    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
    expect(getSharedRegistry().diagInitialized).not.toBe(true);
    expect(bind).not.toHaveBeenCalled();
    for (const signal of ["trace", "logs", "context", "propagation"] as const) {
      expect(getRegisteredGlobal(signal)).toBeUndefined();
    }

    logger.warn.mockImplementation(() => {});
    const pipeline = createInMemoryPipeline();
    const handle = await useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
    });
    cleanup.push(() => handle.shutdown());
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(getSharedRegistry().diagInitialized).toBe(true);
    trace.getTracer("retry").startSpan("retry").end();
    await handle.forceFlush();
    expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
  },
);

it.each(["resource", "logger provider"] as const)(
  "shuts down caller processors exactly once after an early %s failure",
  async (stage) => {
    const pipeline = createInMemoryPipeline();
    const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    const failure = new Error(`${stage} failed`);
    if (stage === "logger provider") {
      vi.spyOn(pipeline.options.logRecordProcessors, "slice").mockImplementationOnce(() => {
        throw failure;
      });
    }
    await expect(
      startTelemetryInstance({
        resourceAttributes: {
          get "service.name"() {
            if (stage === "resource") throw failure;
            return "startup-test";
          },
        },
        spanProcessors: pipeline.options.spanProcessors,
        logRecordProcessors: pipeline.options.logRecordProcessors,
      }),
    ).rejects.toBe(failure);
    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
    for (const signal of ["trace", "logs", "context", "propagation"] as const) {
      expect(getRegisteredGlobal(signal)).toBeUndefined();
    }
  },
);

it("finishes early-startup cleanup after a synchronous processor shutdown failure", async () => {
  const failure = new Error("diagnostic initialization failed");
  const cleanupFailure = new Error("span shutdown failed");
  const logger = {
    error: vi.fn(),
    warn: () => {
      throw failure;
    },
    info() {},
    debug() {},
    verbose() {},
  };
  diag.setLogger(logger);
  const spanShutdown = vi.fn(() => {
    throw cleanupFailure;
  });
  const logShutdown = vi.fn(async () => {});
  await expect(
    startTelemetryInstance({
      resourceAttributes: {},
      spanProcessors: [{ onStart() {}, onEnd() {}, async forceFlush() {}, shutdown: spanShutdown }],
      logRecordProcessors: [{ onEmit() {}, async forceFlush() {}, shutdown: logShutdown }],
    }),
  ).rejects.toBe(failure);
  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(
    "Telemetry initialization cleanup failed",
    cleanupFailure,
  );
});

it.each(["context", "router"] as const)(
  "preserves the %s startup error when rollback, processor shutdown, and diagnostics all throw",
  async (stage) => {
    const failure = new Error(`${stage} startup failed`);
    const rollbackFailure = new Error("rollback failed");
    const shutdownFailure = new Error("processor shutdown failed");
    const report = vi.fn(() => {
      throw new Error("diagnostic logger failed");
    });
    const pipeline = createInMemoryPipeline();
    const shutdownSpan = pipeline.spanProcessor.shutdown.bind(pipeline.spanProcessor);
    const spanShutdown = vi
      .spyOn(pipeline.spanProcessor, "shutdown")
      .mockImplementationOnce(async () => {
        await shutdownSpan();
        throw shutdownFailure;
      });
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    const manager = new StackContextManager();
    vi.spyOn(manager, "enable").mockImplementation(() => {
      diag.setLogger(
        { error: report, warn() {}, info() {}, debug() {}, verbose() {} },
        {
          suppressOverrideMessage: true,
        },
      );
      if (stage === "context") throw failure;
      return manager;
    });
    vi.spyOn(manager, "disable").mockImplementation(() => {
      throw rollbackFailure;
    });
    if (stage === "router") {
      vi.spyOn(logs, "setGlobalLoggerProvider").mockImplementationOnce(() => {
        throw failure;
      });
    }

    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: false },
        traces: { contextManager: manager },
      }),
    ).rejects.toBe(failure);

    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      stage === "context" ? "Page context rollback failed" : "Telemetry global rollback failed",
      rollbackFailure,
    );
    expect(report).toHaveBeenCalledWith(
      "Telemetry initialization cleanup failed",
      expect.any(Error),
    );
    expect(getRegisteredGlobal("trace")).toBeUndefined();
    expect(getRegisteredGlobal("logs")).toBeUndefined();
    expect(getRegisteredGlobal("context")).toBeUndefined();
    expect(getRegisteredGlobal("propagation")).toBeUndefined();
  },
);

it.each(["none", "existing instance", "foreign replacement"] as const)(
  "rolls back partial router installation while preserving %s",
  async (existing) => {
    const first = createInMemoryPipeline();
    if (existing === "existing instance") {
      const handle = await useMicrosoftOpenTelemetry({
        ...first.options,
        logRecordProcessors: [],
        pageView: { enabled: false },
      });
      cleanup.push(
        () => handle.shutdown(),
        () => first.logProcessor.shutdown(),
      );
    } else {
      cleanup.push(() => first.shutdown());
    }
    let preservedTrace = getRegisteredGlobal("trace");
    const failure = new Error("logger registration failed");
    vi.spyOn(logs, "setGlobalLoggerProvider").mockImplementationOnce(() => {
      if (existing === "foreign replacement") {
        trace.disable();
        const foreign = new BasicTracerProvider({ spanProcessors: [first.spanProcessor] });
        cleanup.push(() => foreign.shutdown());
        trace.setGlobalTracerProvider(foreign);
        preservedTrace = getRegisteredGlobal("trace");
      }
      throw failure;
    });
    const pipeline = createInMemoryPipeline();
    const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: false },
      }),
    ).rejects.toBe(failure);
    expect(getRegisteredGlobal("trace")).toBe(preservedTrace);
    expect(getRegisteredGlobal("logs")).toBeUndefined();
    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();

    if (existing === "none") {
      const foreign = new BasicTracerProvider({ spanProcessors: [first.spanProcessor] });
      cleanup.push(() => foreign.shutdown());
      expect(trace.setGlobalTracerProvider(foreign)).toBe(true);
    }
    trace.getTracer("survivor").startSpan("survivor").end();
    await first.forceFlush();
    expect(first.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(["survivor"]);
  },
);

it("removes the new trace proxy when its registration diagnostic throws", async () => {
  const failure = new Error("trace registration diagnostic failed");
  vi.spyOn(diag, "debug").mockImplementation((message) => {
    if (typeof message === "string" && message.includes("Registered a global for trace")) {
      throw failure;
    }
  });
  const pipeline = createInMemoryPipeline();
  const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
    }),
  ).rejects.toBe(failure);
  expect(getRegisteredGlobal("trace")).toBeUndefined();
  expect(getRegisteredGlobal("logs")).toBeUndefined();
  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
  vi.mocked(diag.debug).mockRestore();
  const next = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({ ...next.options, pageView: { enabled: false } });
  cleanup.push(() => handle.shutdown());
  trace.getTracer("retry").startSpan("retry").end();
  await handle.forceFlush();
  expect(next.spanExporter.getFinishedSpans()).toHaveLength(1);
});

it.each(["setTracerProvider", "setLoggerProvider", "getConfig", "enable"] as const)(
  "rolls back all first-start globals when instrumentation %s throws",
  async (method) => {
    const pipeline = createInMemoryPipeline();
    const failure = new Error("instrumentation failed");
    const instrumentation = probe();
    vi.spyOn(instrumentation, method).mockImplementation(() => {
      throw failure;
    });
    const disable = vi.spyOn(instrumentation, "disable");
    const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: false },
        instrumentations: [instrumentation],
      }),
    ).rejects.toBe(failure);
    expect(disable).toHaveBeenCalledOnce();
    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
    for (const signal of ["trace", "logs", "context", "propagation"] as const) {
      expect(getRegisteredGlobal(signal)).toBeUndefined();
    }
    expect(getSharedRegistry().pending).toEqual([]);
    const foreignTrace = new BasicTracerProvider();
    const foreignLogs = new LoggerProvider();
    cleanup.push(
      () => foreignTrace.shutdown(),
      () => foreignLogs.shutdown(),
    );
    expect(trace.setGlobalTracerProvider(foreignTrace)).toBe(true);
    expect(logs.setGlobalLoggerProvider(foreignLogs)).toBe(foreignLogs);
    expect(context.setGlobalContextManager(new StackContextManager().enable())).toBe(true);
    expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
  },
);

it.each(["both fail", "first fails", "second fails"] as const)(
  "settles concurrent startup ownership when %s",
  async (scenario) => {
    const first = createInMemoryPipeline();
    const second = createInMemoryPipeline();
    const fail = {
      ...probe(),
      enable() {
        throw new Error("startup failed");
      },
    };
    const results = await Promise.allSettled([
      useMicrosoftOpenTelemetry({
        ...first.options,
        pageView: { enabled: false },
        instrumentations: scenario !== "second fails" ? [fail] : [],
      }),
      useMicrosoftOpenTelemetry({
        ...second.options,
        pageView: { enabled: false },
        instrumentations: scenario !== "first fails" ? [{ ...fail }] : [],
      }),
    ]);
    const active = results.filter((result) => result.status === "fulfilled");
    cleanup.push(...active.map((result) => () => result.value.shutdown()));
    expect(active).toHaveLength(scenario === "both fail" ? 0 : 1);
    expect(getSharedRegistry().pending).toEqual([]);
    if (scenario === "both fail") {
      for (const signal of ["trace", "logs", "context", "propagation"] as const) {
        expect(getRegisteredGlobal(signal)).toBeUndefined();
      }
    } else {
      trace.getTracer("survivor").startSpan("survivor").end();
      logs.getLogger("survivor").emit({ eventName: "survivor" });
      await active[0].value.forceFlush();
      const survivor = scenario === "first fails" ? second : first;
      expect(survivor.spanExporter.getFinishedSpans()).toHaveLength(1);
      expect(survivor.logExporter.getFinishedLogRecords()).toHaveLength(1);
    }
  },
);

it("preserves a foreign context installed by a throwing disable callback", async () => {
  const manager = new StackContextManager();
  const foreign = new StackContextManager().enable();
  const failure = new Error("logger registration failed");
  vi.spyOn(manager, "disable").mockImplementation(() => {
    context.disable();
    context.setGlobalContextManager(foreign);
    throw new Error("manager cleanup failed");
  });
  vi.spyOn(logs, "setGlobalLoggerProvider").mockImplementationOnce(() => {
    throw failure;
  });
  const pipeline = createInMemoryPipeline();
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      traces: { contextManager: manager },
    }),
  ).rejects.toBe(failure);
  expect(getRegisteredGlobal("context")).toBe(foreign);
  for (const signal of ["trace", "logs", "propagation"] as const) {
    expect(getRegisteredGlobal(signal)).toBeUndefined();
  }
});

it.each(["trace", "logs"] as const)(
  "preserves a concurrent %s-only commit without retaining failed-instance globals",
  async (signal) => {
    const failing = createInMemoryPipeline();
    const survivor = createInMemoryPipeline();
    cleanup.push(() =>
      (signal === "trace" ? survivor.logProcessor : survivor.spanProcessor).shutdown(),
    );

    const results = await Promise.allSettled([
      useMicrosoftOpenTelemetry({
        ...failing.options,
        pageView: { enabled: false },
        instrumentations: [
          {
            ...probe(),
            enable() {
              throw new Error("startup failed");
            },
          },
        ],
      }),
      useMicrosoftOpenTelemetry({
        spanProcessors: signal === "trace" ? survivor.options.spanProcessors : [],
        logRecordProcessors: signal === "logs" ? survivor.options.logRecordProcessors : [],
        pageView: { enabled: false },
      }),
    ]);
    expect(results[0].status).toBe("rejected");
    const started = results[1];
    if (started.status !== "fulfilled") throw started.reason;
    cleanup.push(() => started.value.shutdown());
    expect(getSharedRegistry().pending).toEqual([]);
    expect(getRegisteredGlobal(signal)).toBeDefined();
    expect(getRegisteredGlobal(signal === "trace" ? "logs" : "trace")).toBeUndefined();
    if (signal === "logs") {
      expect(getRegisteredGlobal("context")).toBeUndefined();
      expect(getRegisteredGlobal("propagation")).toBeUndefined();
    }
  },
);

it("aborts globals when listener setup fails with no instrumentations", async () => {
  const pipeline = createInMemoryPipeline();
  const failure = new Error("listener registration failed");
  vi.spyOn(globalThis, "addEventListener").mockImplementationOnce(() => {
    throw failure;
  });
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
    }),
  ).rejects.toBe(failure);
  for (const signal of ["trace", "logs", "context", "propagation"] as const) {
    expect(getRegisteredGlobal(signal)).toBeUndefined();
  }
  expect(getSharedRegistry().pending).toEqual([]);
});
