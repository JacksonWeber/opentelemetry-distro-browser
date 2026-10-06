// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  createContextKey,
  diag,
  propagation,
  ROOT_CONTEXT,
  trace,
  type Context,
  type ContextManager,
  type TracerProvider,
} from "@opentelemetry/api";
import { createNoopLogger, logs, type LoggerProvider } from "@opentelemetry/api-logs";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { addInstance, withInstance } from "../../../src/routing/instanceRouter.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

vi.mock("../../../src/routing/instanceRouter.js", { spy: true });

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
  vi.mocked(addInstance).mockClear();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

const SCOPE = "shared-instrumentation";

/** An instrumentation that records through whichever providers it was bound to. */
function createProbe() {
  let tracerProvider: TracerProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  return {
    setTracerProvider: (provider: TracerProvider) => (tracerProvider = provider),
    setLoggerProvider: (provider: LoggerProvider) => (loggerProvider = provider),
    getConfig: () => ({ enabled: false }),
    enable() {},
    disable() {},
    record(name: string) {
      tracerProvider?.getTracer(SCOPE, "1.0.0").startSpan(name).end();
      loggerProvider?.getLogger(SCOPE, "1.0.0").emit({ eventName: name });
    },
  } satisfies BrowserInstrumentation & { record(name: string): void };
}

async function start(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
  const pipeline = createInMemoryPipeline();
  const probe = createProbe();
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: pipeline.options.spanProcessors,
    logRecordProcessors: pipeline.options.logRecordProcessors,
    pageView: { enabled: false },
    instrumentations: [probe],
    ...options,
  });
  handles.add(handle);
  const pipelines = vi.mocked(addInstance).mock.lastCall![0];
  return {
    handle,
    probe,
    pipelines,
    async traceIds() {
      await pipeline.forceFlush();
      const ids = (items: { spanContext?: { traceId: string } }[]) =>
        items.map((item) => item.spanContext?.traceId);
      return {
        spans: pipeline.spanExporter
          .getFinishedSpans()
          .map((span) => [span.name, span.spanContext().traceId]),
        logs: pipeline.logExporter
          .getFinishedLogRecords()
          .filter((record) => record.eventName === "probe")
          .map((record) => record.spanContext?.traceId),
        pageViews: pipeline.logExporter
          .getFinishedLogRecords()
          .filter((record) => record.eventName !== "probe")
          .map((record) => record.spanContext?.traceId),
        ids,
      };
    },
    async exported() {
      await pipeline.forceFlush();
      return {
        spans: pipeline.spanExporter.getFinishedSpans().map((span) => span.name),
        logs: pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName),
      };
    },
  };
}

it("keeps instrumentation telemetry in its own instance when scope names are identical", async () => {
  const alpha = await start();
  const beta = await start();

  alpha.probe.record("alpha");
  beta.probe.record("beta");

  expect(await alpha.exported()).toEqual({ spans: ["alpha"], logs: ["alpha"] });
  expect(await beta.exported()).toEqual({ spans: ["beta"], logs: ["beta"] });
});

it("binds global tracers and loggers to the selected instance at acquisition", async () => {
  const alpha = await start();
  const beta = await start();
  const tracer = withInstance(beta.pipelines, () => trace.getTracer(SCOPE));
  const logger = withInstance(beta.pipelines, () => logs.getLogger(SCOPE));

  withInstance(alpha.pipelines, () => {
    tracer.startSpan("beta").end();
    logger.emit({ eventName: "beta" });
  });
  trace.getTracer(SCOPE).startSpan("default").end();
  logs.getLogger(SCOPE).emit({ eventName: "default" });

  expect(await alpha.exported()).toEqual({ spans: ["default"], logs: ["default"] });
  expect(await beta.exported()).toEqual({ spans: ["beta"], logs: ["beta"] });
});

it("keeps explicit async parents within each overlapping instance", async () => {
  const alpha = await start();
  const beta = await start();
  const run = async (instance: typeof alpha) => {
    const tracer = withInstance(instance.pipelines, () => trace.getTracer(SCOPE));
    const parent = tracer.startSpan("parent");
    const parentContext = trace.setSpan(context.active(), parent);
    await new Promise((resolve) => setTimeout(resolve));
    const child = tracer.startSpan("child", {}, parentContext);
    child.end();
    parent.end();
    return { parent: parent.spanContext(), child };
  };

  const [alphaRun, betaRun] = await Promise.all([run(alpha), run(beta)]);

  for (const { parent, child } of [alphaRun, betaRun]) {
    expect(child.spanContext().traceId).toBe(parent.traceId);
    expect(
      (child as unknown as { parentSpanContext?: { spanId: string } }).parentSpanContext,
    ).toMatchObject({ spanId: parent.spanId });
  }
  expect(alphaRun.parent.traceId).not.toBe(betaRun.parent.traceId);
  expect(await alpha.exported()).toEqual({ spans: ["child", "parent"], logs: [] });
  expect(await beta.exported()).toEqual({ spans: ["child", "parent"], logs: [] });
});

it("routes new acquisitions to the next running instance without moving bound tracers", async () => {
  const alpha = await start();
  const beta = await start();
  const alphaTracer = trace.getTracer(SCOPE);
  const alphaLogger = logs.getLogger(SCOPE);

  await alpha.handle.shutdown();
  alphaTracer.startSpan("stale").end();
  alphaLogger.emit({ eventName: "stale" });
  trace.getTracer(SCOPE).startSpan("after").end();
  logs.getLogger(SCOPE).emit({ eventName: "after" });

  expect(await beta.exported()).toEqual({ spans: ["after"], logs: ["after"] });
});

it("defaults each signal to the first running instance that collects it", async () => {
  const logsOnly = await start({ spanProcessors: [] });
  const both = await start();

  logsOnly.probe.record("logs-only");
  trace.getTracer(SCOPE).startSpan("default").end();
  logs.getLogger(SCOPE).emit({ eventName: "default" });

  expect(await logsOnly.exported()).toEqual({ spans: [], logs: ["logs-only", "default"] });
  expect(await both.exported()).toEqual({ spans: ["default"], logs: [] });
});

it("never serves a selected instance a signal it does not collect from another instance", async () => {
  const logsOnly = await start({ spanProcessors: [] });
  const both = await start();
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});

  const span = withInstance(logsOnly.pipelines, () => trace.getTracer(SCOPE)).startSpan("selected");
  span.end();

  expect(span.isRecording()).toBe(false);
  expect(warn).not.toHaveBeenCalled();
  expect(await both.exported()).toEqual({ spans: [], logs: [] });
});

it("drops and reports telemetry acquired for a shut-down selected instance", async () => {
  const alpha = await start();
  const beta = await start();
  await alpha.handle.shutdown();
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});

  const span = withInstance(alpha.pipelines, () => trace.getTracer(SCOPE)).startSpan("stale");
  span.end();

  expect(span.isRecording()).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
  expect(await beta.exported()).toEqual({ spans: [], logs: [] });
});

it("drops and reports telemetry acquired when no instance is running", async () => {
  const alpha = await start();
  await alpha.handle.shutdown();
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});

  const span = trace.getTracer(SCOPE).startSpan("orphan");
  span.end();
  const logger = logs.getLogger(SCOPE);

  expect(span.isRecording()).toBe(false);
  expect(logger.enabled()).toBe(false);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(await alpha.exported()).toEqual({ spans: [], logs: [] });
});

it("routes to a new instance after every earlier instance has shut down", async () => {
  const first = await start();
  await first.handle.shutdown();
  const second = await start();

  trace.getTracer(SCOPE).startSpan("second").end();

  expect(await second.exported()).toEqual({ spans: ["second"], logs: [] });
});

it("does not replace a tracer provider registered by another SDK", async () => {
  const foreign = new BasicTracerProvider();
  trace.setGlobalTracerProvider(foreign);
  const report = vi.spyOn(diag, "error").mockImplementation(() => {});
  const alpha = await start();

  alpha.probe.record("alpha");

  expect((trace.getTracerProvider() as unknown as { getDelegate(): unknown }).getDelegate()).toBe(
    foreign,
  );
  expect(report).toHaveBeenCalled();
  expect(await alpha.exported()).toEqual({ spans: ["alpha"], logs: ["alpha"] });
});

it("keeps the first instance's page context and reports unused context options", async () => {
  const first = vi.fn(() => ROOT_CONTEXT);
  const contextManager = (active: () => ReturnType<ContextManager["active"]>) =>
    ({
      active,
      bind: (_ctx, target) => target,
      disable() {
        return this;
      },
      enable() {
        return this;
      },
      with: (_ctx, callback, thisArg, ...args) => callback.apply(thisArg, args),
    }) satisfies ContextManager;
  await start({ traces: { contextManager: contextManager(first) } });
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const second = vi.fn(() => ROOT_CONTEXT);

  await start({ traces: { contextManager: contextManager(second) } });
  context.active();

  expect(first).toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "Trace context options are unused because an earlier instance registered the page context",
  );
});

it("hands page correlation to a surviving instance when the owner shuts down", async () => {
  const alpha = await start({ pageView: {} });
  const beta = await start({ pageView: {} });
  alpha.probe.record("probe");
  const alphaOperation = (await alpha.traceIds()).logs[0];
  await alpha.handle.shutdown();
  history.pushState(null, "", "/next");

  beta.probe.record("probe");
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);

  const { spans, logs } = await beta.traceIds();
  const betaOperation = logs.at(-1);
  expect(betaOperation).toBeDefined();
  expect(betaOperation).not.toBe(alphaOperation);
  expect(spans.at(-1)).toEqual(["probe", betaOperation]);
  expect(headers.traceparent).toContain(betaOperation);
});

it("correlates a reinitialized instance with its own page operation", async () => {
  const first = await start({ pageView: {} });
  first.probe.record("probe");
  const firstOperation = (await first.traceIds()).logs[0];
  await first.handle.shutdown();

  const second = await start({ pageView: {} });
  second.probe.record("probe");
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);

  const { spans, logs } = await second.traceIds();
  expect(logs[0]).toBeDefined();
  expect(logs[0]).not.toBe(firstOperation);
  expect(spans).toEqual([["probe", logs[0]]]);
  expect(headers.traceparent).toContain(logs[0]);
});

it("shuts down its providers and registers nothing when context startup fails", async () => {
  const failure = new Error("enable failed");
  const spanShutdown = vi.fn(async () => {});
  const logShutdown = vi.fn(async () => {});
  const register = vi.spyOn(context, "setGlobalContextManager");

  await expect(
    startTelemetryInstance({
      resourceAttributes: {},
      spanProcessors: [
        { onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: spanShutdown },
      ],
      logRecordProcessors: [{ onEmit() {}, forceFlush: async () => {}, shutdown: logShutdown }],
      contextManager: {
        active: () => ROOT_CONTEXT,
        with: (_ctx, fn, thisArg, ...args) => fn.apply(thisArg, args),
        bind: (_ctx, target) => target,
        enable() {
          throw failure;
        },
        disable() {
          return this;
        },
      },
    }),
  ).rejects.toBe(failure);

  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
  expect(register).not.toHaveBeenCalled();
  expect(vi.mocked(addInstance)).not.toHaveBeenCalled();
  const alpha = await start();
  alpha.probe.record("alpha");
  expect(await alpha.exported()).toEqual({ spans: ["alpha"], logs: ["alpha"] });
});

it("reports dropped telemetry once per signal until an instance starts", async () => {
  const alpha = await start();
  await alpha.handle.shutdown();
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});

  for (let i = 0; i < 3; i++) {
    trace.getTracer(SCOPE);
    logs.getLogger(SCOPE);
  }
  expect(warn).toHaveBeenCalledTimes(2);

  const beta = await start();
  await beta.handle.shutdown();
  trace.getTracer(SCOPE);
  expect(warn).toHaveBeenCalledTimes(3);
});

it("diagnoses each foreign provider once without attempting to replace it", async () => {
  trace.setGlobalTracerProvider(new BasicTracerProvider());
  vi.spyOn(diag, "error").mockImplementation(() => {});
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  logs.setGlobalLoggerProvider({ getLogger: () => createNoopLogger() });
  const registerTracer = vi.spyOn(trace, "setGlobalTracerProvider");
  const registerLogger = vi.spyOn(logs, "setGlobalLoggerProvider");

  await start();
  await start();

  expect(registerTracer).not.toHaveBeenCalled();
  expect(registerLogger).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledOnce();
});

it("keeps page-view and telemetry operation IDs consistent in each instance after navigation", async () => {
  const alpha = await start({ pageView: {} });
  const beta = await start({ pageView: {} });
  history.pushState(null, "", "/consistent");

  alpha.probe.record("probe");
  beta.probe.record("probe");
  window.dispatchEvent(new PageTransitionEvent("pagehide"));

  for (const instance of [alpha, beta]) {
    const { spans, logs, pageViews } = await instance.traceIds();
    expect(pageViews.at(-1)).toBeDefined();
    expect(logs).toEqual([pageViews.at(-1)]);
    expect(spans).toEqual([["probe", pageViews.at(-1)]]);
  }
  history.replaceState(null, "", "/");
});

it("registers propagation when the application already registered a context manager", async () => {
  context.setGlobalContextManager({
    active: () => ROOT_CONTEXT,
    with: (_ctx, fn, thisArg, ...args) => fn.apply(thisArg, args),
    bind: (_ctx, target) => target,
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  });
  vi.spyOn(diag, "error").mockImplementation(() => {});
  const spanContext = {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: 1,
  };

  await start();
  const headers: Record<string, string> = {};
  propagation.inject(trace.setSpanContext(ROOT_CONTEXT, spanContext), headers);

  expect(headers.traceparent).toBe(`00-${spanContext.traceId}-${spanContext.spanId}-01`);
});

it("leaves an application-registered context manager enabled when it is also supplied", async () => {
  const manager = new StackContextManager();
  context.setGlobalContextManager(manager.enable());
  const disable = vi.spyOn(manager, "disable");
  vi.spyOn(diag, "error").mockImplementation(() => {});
  const key = createContextKey("app");

  await start({ traces: { contextManager: manager } });

  expect(disable).not.toHaveBeenCalled();
  expect(context.with(ROOT_CONTEXT.setValue(key, 1), () => context.active().getValue(key))).toBe(1);
});

it("shares a logs-only instance's page operation with a later tracing instance", async () => {
  const logsOnly = await start({ pageView: {}, spanProcessors: [] });
  const tracing = await start({ pageView: {} });

  logsOnly.probe.record("probe");
  tracing.probe.record("probe");
  window.dispatchEvent(new PageTransitionEvent("pagehide"));

  const first = await logsOnly.traceIds();
  const second = await tracing.traceIds();
  const operation = first.pageViews.at(-1);
  expect(operation).toBeDefined();
  expect(first.logs).toEqual([operation]);
  expect(second.pageViews.at(-1)).toBe(operation);
  expect(second.logs).toEqual([operation]);
  expect(second.spans).toEqual([["probe", operation]]);
});

it("keeps the page operation for other instances while the owner flushes during shutdown", async () => {
  const alpha = await start({ pageView: {} });
  const beta = await start({ pageView: {} });
  beta.probe.record("probe");
  const operation = (await beta.traceIds()).logs[0];

  void alpha.handle.forceFlush();
  const stopped = alpha.handle.shutdown();

  expect(operation).toBeDefined();
  expect(trace.getSpanContext(context.active())?.traceId).toBe(operation);
  await stopped;
});

it("routes telemetry acquired while an instance flushes during shutdown to a surviving instance", async () => {
  let finishFlush!: () => void;
  const flushing = new Promise<void>((resolve) => (finishFlush = resolve));
  const alpha = await start({
    spanProcessors: [
      { onStart() {}, onEnd() {}, forceFlush: () => flushing, shutdown: async () => {} },
    ],
  });
  const beta = await start();

  void alpha.handle.forceFlush();
  const stopped = alpha.handle.shutdown();
  const tracer = trace.getTracer(SCOPE);
  const logger = logs.getLogger(SCOPE);
  finishFlush();
  await stopped;
  tracer.startSpan("survivor").end();
  logger.emit({ eventName: "survivor" });

  expect(await beta.exported()).toEqual({ spans: ["survivor"], logs: ["survivor"] });
});

it("registers context and propagation on retry after propagator construction fails", async () => {
  const failure = new Error("fields failed");
  const broken = {
    fields(): string[] {
      throw failure;
    },
    inject() {},
    extract: (ctx: Context) => ctx,
  };
  await expect(start({ traces: { propagators: [broken] } })).rejects.toBe(failure);

  const active = vi.fn(() => ROOT_CONTEXT);
  await start({
    traces: {
      contextManager: {
        active,
        with: (_ctx, fn, thisArg, ...args) => fn.apply(thisArg, args),
        bind: (_ctx, target) => target,
        enable() {
          return this;
        },
        disable() {
          return this;
        },
      },
    },
  });
  context.active();

  expect(active).toHaveBeenCalled();
  expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
});
