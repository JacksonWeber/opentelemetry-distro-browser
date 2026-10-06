// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../../src/index.js";
import { assertGlobalsAvailable } from "../../../src/shared/globalOwnership.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const apiKey = Symbol.for("opentelemetry.js.api.1");
const logsKey = Symbol.for("io.opentelemetry.js.api.logs");
const initializationKey = Symbol.for("@microsoft/opentelemetry-browser.initializing");
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
const cleanup: Array<() => Promise<void>> = [];
let previousSession: string | null;

beforeEach(() => {
  previousSession = localStorage.getItem("opentelemetry-session");
});

afterEach(async () => {
  try {
    for (const stop of cleanup.splice(0).reverse()) await stop();
    expect(realm[initializationKey]).toBeUndefined();
  } finally {
    trace.disable();
    logs.disable();
    context.disable();
    propagation.disable();
    diag.disable();
    delete realm[apiKey];
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (previousSession === null) localStorage.removeItem("opentelemetry-session");
    else localStorage.setItem("opentelemetry-session", previousSession);
  }
});

it.each(["tracer-provider", "logger-provider", "context-manager", "propagator"] as const)(
  "rejects a foreign %s before touching caller resources or browser state",
  async (owner) => {
    const pipeline = createInMemoryPipeline();
    const tracerProvider = new BasicTracerProvider({ spanProcessors: [pipeline.spanProcessor] });
    const loggerProvider = new LoggerProvider({ processors: [pipeline.logProcessor] });
    cleanup.push(
      () => tracerProvider.shutdown(),
      () => loggerProvider.shutdown(),
    );
    const manager = new StackContextManager().enable();
    const propagator = new W3CTraceContextPropagator();
    if (owner === "tracer-provider") trace.setGlobalTracerProvider(tracerProvider);
    if (owner === "logger-provider") logs.setGlobalLoggerProvider(loggerProvider);
    if (owner === "context-manager") context.setGlobalContextManager(manager);
    if (owner === "propagator") propagation.setGlobalPropagator(propagator);
    const globals = realm[apiKey] === undefined ? undefined : { ...Object(realm[apiKey]) };
    const logGlobal = realm[logsKey];
    const report = vi.spyOn(diag, "error");
    const readStorage = vi.spyOn(Storage.prototype, "getItem");
    const writeStorage = vi.spyOn(Storage.prototype, "setItem");
    const addListener = vi.spyOn(globalThis, "addEventListener");
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    const instrumentation = {
      setTracerProvider: vi.fn(),
      setLoggerProvider: vi.fn(),
      getConfig: vi.fn(() => ({ enabled: false })),
      enable: vi.fn(),
      disable: vi.fn(),
    };
    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        session: { enabled: true },
        userContext: { enabled: true },
        instrumentations: [instrumentation],
        // A conflict takes precedence over exporter construction and config validation.
        azureMonitor: { connectionString: "invalid" },
      }),
    ).rejects.toMatchObject({ code: `${owner}-conflict` });
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`[${owner}-conflict]`));
    expect(realm[apiKey]).toEqual(globals);
    expect(realm[logsKey]).toBe(logGlobal);
    for (const operation of [
      readStorage,
      writeStorage,
      addListener,
      addDocumentListener,
      spanShutdown,
      logShutdown,
      ...Object.values(instrumentation),
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
    if (owner === "tracer-provider") {
      trace.getTracer("foreign").startSpan("still-recording").end();
      await pipeline.forceFlush();
      expect(pipeline.spanExporter.getFinishedSpans()[0]?.name).toBe("still-recording");
    }
    if (owner === "logger-provider") {
      logs.getLogger("foreign").emit({ eventName: "still-recording" });
      await pipeline.forceFlush();
      expect(pipeline.logExporter.getFinishedLogRecords()[0]?.eventName).toBe("still-recording");
    }
  },
);

it.each(["1.8.0", "1.9.0", "1.9.2", "1.10.0"])(
  "rolls back when the loaded API rejects registration into a %s registry",
  async (version) => {
    const registry = { version };
    realm[apiKey] = registry;
    const pipeline = createInMemoryPipeline();
    const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    const instrumentation = {
      setTracerProvider: vi.fn(),
      setLoggerProvider: vi.fn(),
      getConfig: vi.fn(() => ({ enabled: false })),
      enable: vi.fn(),
      disable: vi.fn(),
    };
    vi.spyOn(diag, "error").mockImplementation(() => {});
    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: false },
        instrumentations: [instrumentation],
      }),
    ).rejects.toMatchObject({
      code: "api-version-conflict",
    });
    expect(realm[apiKey]).toEqual({ version });
    expect(realm[logsKey]).toBeUndefined();
    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
    for (const operation of Object.values(instrumentation)) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it.each(["1.9.1", "1.9.2", "1.9.99"])(
  "does not hardcode version %s in the ownership preflight",
  (version) => {
    realm[apiKey] = { version };
    expect(assertGlobalsAvailable).not.toThrow();
  },
);

it("detects an incompatible logs getter without invoking it", async () => {
  const foreign = vi.fn(() => undefined);
  realm[logsKey] = foreign;
  await expect(useMicrosoftOpenTelemetry()).rejects.toMatchObject({
    code: "logger-provider-conflict",
  });
  expect(foreign).not.toHaveBeenCalled();
  expect(realm[logsKey]).toBe(foreign);
});

it("allows an application diagnostic sink without replacing its registration during preflight", () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  diag.setLogger(logger);
  const registry = { ...Object(realm[apiKey]) };
  expect(assertGlobalsAvailable).not.toThrow();
  expect(realm[apiKey]).toEqual(registry);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  expect(assertGlobalsAvailable).toThrow("[propagator-conflict]");
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("[propagator-conflict]"),
  );
});

it.each(["traces", "logs", "both"] as const)(
  "does not bind instrumentations to foreign globals when %s are disabled",
  async (disabled) => {
    const provider = new LoggerProvider();
    logs.setGlobalLoggerProvider(provider);
    cleanup.push(() => provider.shutdown());
    await expect(
      useMicrosoftOpenTelemetry({
        spanProcessors: disabled !== "logs" ? [] : undefined,
        logRecordProcessors: disabled !== "traces" ? [] : undefined,
      }),
    ).rejects.toMatchObject({ code: "logger-provider-conflict" });
  },
);

it("preserves context globals when Azure Monitor is configured but traces are explicitly disabled", async () => {
  const manager = new StackContextManager().enable();
  context.setGlobalContextManager(manager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const globals = { ...Object(realm[apiKey]) };
  const handle = await useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
    },
    spanProcessors: [],
    logRecordProcessors: [],
    pageView: { enabled: false },
  });
  cleanup.push(() => handle.shutdown());
  expect(realm[apiKey]).toMatchObject(globals);
  expect(trace.getTracer("disabled").startSpan("disabled").isRecording()).toBe(false);
  expect(realm[logsKey]).toBeUndefined();
});

it("cleans up default OTLP processors when a foreign provider registers during startup", async () => {
  const spanShutdown = vi.spyOn(BatchSpanProcessor.prototype, "shutdown");
  const logShutdown = vi.spyOn(BatchLogRecordProcessor.prototype, "shutdown");
  const initializing = useMicrosoftOpenTelemetry({ pageView: { enabled: false } });
  const foreign = new BasicTracerProvider();
  cleanup.push(() => foreign.shutdown());
  trace.setGlobalTracerProvider(foreign);
  await expect(initializing).rejects.toMatchObject({ code: "tracer-provider-conflict" });
  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
  expect(trace.getTracerProvider().getTracer("foreign")).toBe(foreign.getTracer("foreign"));
  expect(realm[logsKey]).toBeUndefined();
});

it("rejects simultaneous startup and preserves the first installation through rejected retries", async () => {
  const pipeline = createInMemoryPipeline();
  const first = useMicrosoftOpenTelemetry({ ...pipeline.options, pageView: { enabled: false } });
  await expect(useMicrosoftOpenTelemetry()).rejects.toMatchObject({
    code: "initialization-in-progress",
  });
  const handle = await first;
  cleanup.push(() => handle.shutdown());
  await expect(useMicrosoftOpenTelemetry()).rejects.toMatchObject({
    code: "tracer-provider-conflict",
  });
  trace.getTracer("first").startSpan("first").end();
  logs.getLogger("first").emit({ eventName: "first" });
  await handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
  expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(1);
  await handle.shutdown();
  await expect(useMicrosoftOpenTelemetry()).rejects.toMatchObject({
    code: "tracer-provider-conflict",
  });
});

it("rechecks ownership after asynchronous session startup without disabling the foreign provider", async () => {
  vi.useFakeTimers();
  const pipeline = createInMemoryPipeline();
  const spanShutdown = vi.spyOn(BatchSpanProcessor.prototype, "shutdown");
  const logShutdown = vi.spyOn(BatchLogRecordProcessor.prototype, "shutdown");
  const callerShutdown = vi.spyOn(pipeline.spanExporter, "shutdown");
  const callerLogShutdown = vi.spyOn(pipeline.logExporter, "shutdown");
  const readStorage = vi.spyOn(Storage.prototype, "getItem").mockReturnValue(null);
  const initializing = useMicrosoftOpenTelemetry({
    ...pipeline.options,
    session: { enabled: true },
    azureMonitor: {
      connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
    },
    pageView: { enabled: false },
  });
  const foreign = new BasicTracerProvider();
  cleanup.push(() => foreign.shutdown());
  trace.setGlobalTracerProvider(foreign);
  await expect(initializing).rejects.toMatchObject({ code: "tracer-provider-conflict" });
  expect(readStorage).toHaveBeenCalled();
  expect(callerShutdown).not.toHaveBeenCalled();
  expect(callerLogShutdown).not.toHaveBeenCalled();
  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(trace.getTracerProvider().getTracer("foreign")).toBe(foreign.getTracer("foreign"));
  expect(realm[logsKey]).toBeUndefined();

  trace.disable();
  const handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: false },
  });
  cleanup.push(() => handle.shutdown());
});

it("releases the startup reservation after configuration failure", async () => {
  await expect(
    useMicrosoftOpenTelemetry({ azureMonitor: { connectionString: "invalid" } }),
  ).rejects.toThrow();
  const pipeline = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: false },
  });
  cleanup.push(() => handle.shutdown());
});

it("snapshots exporter settings and caller processors before awaiting startup", async () => {
  const pipeline = createInMemoryPipeline();
  const azureMonitor = {
    connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
  };
  const initializing = useMicrosoftOpenTelemetry({
    ...pipeline.options,
    azureMonitor,
    pageView: { enabled: false },
  });
  pipeline.options.spanProcessors.length = 0;
  pipeline.options.logRecordProcessors.length = 0;
  azureMonitor.connectionString = "invalid";
  const handle = await initializing;
  cleanup.push(() => handle.shutdown());
  const spanFlush = vi.spyOn(pipeline.spanProcessor, "forceFlush");
  const logFlush = vi.spyOn(pipeline.logProcessor, "forceFlush");
  await handle.forceFlush();
  expect(spanFlush).toHaveBeenCalledOnce();
  expect(logFlush).toHaveBeenCalledOnce();
});

it.each(
  [false, true].flatMap((pageView) =>
    [
      ["context", "context-manager-conflict"],
      ["propagation", "propagator-conflict"],
      ["trace", "tracer-provider-conflict"],
      ["logs", "logger-provider-conflict"],
    ].map(([signal, code]) => ({ pageView, signal, code })),
  ),
)(
  "preserves a foreign $signal installed by enable() with pageView=$pageView",
  async ({ pageView, signal, code }) => {
    const pipeline = createInMemoryPipeline();
    const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    const foreignManager = new StackContextManager().enable();
    const foreignTracer = new BasicTracerProvider();
    const foreignLogger = new LoggerProvider();
    const foreignPropagator = new W3CTraceContextPropagator();
    const foreignDisable = vi.spyOn(foreignManager, "disable");
    const foreignTraceShutdown = vi.spyOn(foreignTracer, "shutdown");
    const foreignLogShutdown = vi.spyOn(foreignLogger, "shutdown");
    cleanup.push(
      async () => {
        foreignManager.disable();
      },
      () => foreignTracer.shutdown(),
      () => foreignLogger.shutdown(),
    );
    const manager = new StackContextManager();
    const enable = manager.enable.bind(manager);
    const disable = vi.spyOn(manager, "disable");
    const report = vi.spyOn(diag, "error").mockImplementation(() => {});
    let foreignRegistration: unknown;
    vi.spyOn(manager, "enable").mockImplementation(() => {
      enable();
      if (signal === "context") context.setGlobalContextManager(foreignManager);
      if (signal === "propagation") {
        propagation.disable();
        propagation.setGlobalPropagator(foreignPropagator);
      }
      if (signal === "trace") {
        trace.disable();
        trace.setGlobalTracerProvider(foreignTracer);
      }
      if (signal === "logs") {
        logs.disable();
        logs.setGlobalLoggerProvider(foreignLogger);
      }
      foreignRegistration =
        signal === "logs" ? realm[logsKey] : Reflect.get(Object(realm[apiKey]), signal);
      return manager;
    });
    const instrumentation = {
      setTracerProvider: vi.fn(),
      setLoggerProvider: vi.fn(),
      getConfig: vi.fn(() => ({ enabled: false })),
      enable: vi.fn(),
      disable: vi.fn(),
    };

    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: pageView },
        traces: { contextManager: manager },
        instrumentations: [instrumentation],
      }).then((handle) => {
        cleanup.push(() => handle.shutdown());
        return handle;
      }),
    ).rejects.toMatchObject({ code });

    expect(report).toHaveBeenCalledWith(expect.stringContaining(`[${code}]`));
    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledOnce();
    expect(foreignDisable).not.toHaveBeenCalled();
    expect(foreignTraceShutdown).not.toHaveBeenCalled();
    expect(foreignLogShutdown).not.toHaveBeenCalled();
    for (const key of ["trace", "context", "propagation"]) {
      expect(Reflect.get(Object(realm[apiKey]), key)).toBe(
        key === signal ? foreignRegistration : undefined,
      );
    }
    expect(realm[logsKey]).toBe(signal === "logs" ? foreignRegistration : undefined);
    for (const operation of Object.values(instrumentation))
      expect(operation).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "does not disable a manager that registered itself from enable() with pageView=%s",
  async (pageView) => {
    const pipeline = createInMemoryPipeline();
    const manager = new StackContextManager();
    const enable = manager.enable.bind(manager);
    const disable = vi.spyOn(manager, "disable");
    vi.spyOn(diag, "error").mockImplementation(() => {});
    vi.spyOn(manager, "enable").mockImplementation(() => {
      enable();
      context.setGlobalContextManager(manager);
      return manager;
    });
    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: pageView },
        traces: { contextManager: manager },
      }),
    ).rejects.toMatchObject({ code: "context-manager-conflict" });
    expect(disable).not.toHaveBeenCalled();
    expect(Reflect.get(Object(realm[apiKey]), "context")).toBe(manager);
  },
);

it("retains the SDK shutdown handle when a context manager's enable() throws", async () => {
  const pipeline = createInMemoryPipeline();
  const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
  const manager = new StackContextManager();
  const failure = new Error("context enable failed");
  vi.spyOn(manager, "enable").mockImplementation(() => {
    throw failure;
  });
  const disable = vi.spyOn(manager, "disable");
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      traces: { contextManager: manager },
    }),
  ).rejects.toBe(failure);
  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
  expect(disable).toHaveBeenCalledOnce();
  expect(realm[logsKey]).toBeUndefined();
  expect(assertGlobalsAvailable).not.toThrow();
});

it("checks propagator fields callbacks before starting either SDK pipeline", async () => {
  const pipeline = createInMemoryPipeline();
  cleanup.push(() => pipeline.shutdown());
  const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
  const foreignPropagator = new W3CTraceContextPropagator();
  const fields = vi.fn(() => {
    propagation.setGlobalPropagator(foreignPropagator);
    return [];
  });
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      traces: { propagators: [{ fields, inject() {}, extract: (ctx) => ctx }] },
    }),
  ).rejects.toMatchObject({ code: "propagator-conflict" });
  expect(fields).toHaveBeenCalledOnce();
  expect(spanShutdown).not.toHaveBeenCalled();
  expect(logShutdown).not.toHaveBeenCalled();
  expect(realm[logsKey]).toBeUndefined();
  expect(Reflect.get(Object(realm[apiKey]), "trace")).toBeUndefined();
  expect(Reflect.get(Object(realm[apiKey]), "propagation")).toBe(foreignPropagator);
});

it("removes owned registrations after an instrumentation failure so startup can be retried", async () => {
  const pipeline = createInMemoryPipeline();
  const failure = new Error("instrumentation enable failed");
  await expect(
    useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      instrumentations: [
        {
          setTracerProvider() {},
          getConfig: () => ({ enabled: false }),
          enable() {
            throw failure;
          },
          disable() {},
        },
      ],
    }),
  ).rejects.toBe(failure);
  expect(assertGlobalsAvailable).not.toThrow();
  const nextPipeline = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({
    ...nextPipeline.options,
    pageView: { enabled: false },
  });
  cleanup.push(() => handle.shutdown());
  trace.getTracer("retry").startSpan("retry").end();
  await handle.forceFlush();
  expect(nextPipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
});
