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
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logToEnvelope } from "../../../src/exporter/logUtils.js";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import {
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { PageViewInstrumentation } from "../../../src/instrumentation/pageView/index.js";
import { addInstance, withInstance } from "../../../src/routing/instanceRouter.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";
import { getSharedRegistry } from "../../../src/shared/globalOwnership.js";
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

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
  });
}

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
    pipeline,
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

it("isolates configured session lifetimes and shutdown across instances", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  async function startSession(maxDuration: number) {
    const ids: unknown[] = [];
    const instance = await start({
      session: { enabled: true, persist: false, inactivityTimeout: 0, maxDuration },
      spanProcessors: [
        {
          onStart: (span) => {
            ids.push(span.attributes["session.id"]);
          },
          onEnd() {},
          async forceFlush() {},
          async shutdown() {},
        },
      ],
      logRecordProcessors: [
        {
          onEmit: (record) => {
            ids.push(record.attributes["session.id"]);
          },
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    });
    return { ...instance, ids };
  }
  const alpha = await startSession(1);
  const beta = await startSession(2);
  alpha.probe.record("first");
  beta.probe.record("first");
  const alphaId = alpha.ids[0];
  const betaId = beta.ids[0];
  expect(alphaId).toMatch(/^[0-9a-f]{32}$/);
  expect(betaId).toMatch(/^[0-9a-f]{32}$/);
  expect(alphaId).not.toBe(betaId);
  expect(alpha.ids).toEqual([alphaId, alphaId]);
  expect(beta.ids).toEqual([betaId, betaId]);

  now.mockReturnValue(1_001_000);
  alpha.probe.record("renewed");
  beta.probe.record("active");
  expect(alpha.ids[2]).not.toBe(alphaId);
  expect(alpha.ids[3]).toBe(alpha.ids[2]);
  expect(beta.ids).toEqual([betaId, betaId, betaId, betaId]);

  await alpha.handle.shutdown();
  now.mockReturnValue(1_002_000);
  alpha.probe.record("stopped");
  beta.probe.record("renewed");
  expect(alpha.ids).toHaveLength(4);
  expect(beta.ids[4]).not.toBe(betaId);
  expect(beta.ids[5]).toBe(beta.ids[4]);
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

it("keeps resource session overrides isolated from another instance's managed session", async () => {
  const pipeline = createInMemoryPipeline();
  const resourceInstance = await start({
    resource: resourceFromAttributes({ "session.id": "application-resource" }),
    session: { enabled: true, persist: false },
    ...pipeline.options,
  });
  const managedPipeline = createInMemoryPipeline();
  const managedInstance = await start({
    session: { enabled: true, persist: false },
    ...managedPipeline.options,
  });
  resourceInstance.probe.record("resource");
  managedInstance.probe.record("managed");
  await Promise.all([pipeline.forceFlush(), managedPipeline.forceFlush()]);

  expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
  expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(1);
  for (const record of [
    ...pipeline.spanExporter.getFinishedSpans(),
    ...pipeline.logExporter.getFinishedLogRecords(),
  ]) {
    expect(record.attributes["session.id"]).toBeUndefined();
    expect(record.resource.attributes["session.id"]).toBe("application-resource");
  }
  const managedId = managedPipeline.spanExporter.getFinishedSpans()[0].attributes["session.id"];
  expect(managedId).toMatch(/^[0-9a-f]{32}$/);
  await resourceInstance.handle.shutdown();
  managedInstance.probe.record("after-resource-shutdown");
  await managedPipeline.forceFlush();
  expect(managedPipeline.spanExporter.getFinishedSpans()).toHaveLength(2);
  expect(managedPipeline.logExporter.getFinishedLogRecords()).toHaveLength(2);
  for (const record of [
    ...managedPipeline.spanExporter.getFinishedSpans(),
    ...managedPipeline.logExporter.getFinishedLogRecords(),
  ]) {
    expect(record.attributes["session.id"]).toBe(managedId);
    expect(record.resource.attributes["session.id"]).toBeUndefined();
  }
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
    "Trace context options ignored; page context already registered",
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

it("keeps the operation name captured before page correlation changes owners", async () => {
  const alpha = await start({ pageView: { routeResolver: () => "/owner-route" } });
  const beta = await start({ pageView: { routeResolver: () => "/successor-route" } });
  await settle();

  const operation = trace.getSpanContext(context.active())!;
  beta.probe.record("buffered");
  await alpha.handle.shutdown();
  await beta.pipeline.forceFlush();

  const span = beta.pipeline.spanExporter
    .getFinishedSpans()
    .find((candidate) => candidate.name === "buffered")!;
  const log = beta.pipeline.logExporter
    .getFinishedLogRecords()
    .find((candidate) => candidate.eventName === "buffered")!;
  for (const envelope of [spanToEnvelope(span, "key"), logToEnvelope(log, "key")]) {
    expect(envelope.tags["ai.operation.id"]).toBe(operation.traceId);
    expect(envelope.tags["ai.operation.name"]).toBe("/owner-route");
  }
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

it("does not let a logs-only owner's sampling disable a later tracing instance", async () => {
  await start({
    pageView: {},
    samplingPercentage: 0,
    spanProcessors: [],
  });
  const tracing = await start({ pageView: {} });

  tracing.probe.record("probe");

  const second = await tracing.traceIds();
  const operation = second.logs[0];
  expect(operation).toBeDefined();
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

describe("page visit time through useMicrosoftOpenTelemetry", () => {
  let storage: Storage;
  let savedVisits: Map<string, string>;
  let originalUrl: string;
  let originalState: unknown;
  let now: number;

  function visitKeys(): string[] {
    return Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "").filter(
      (key) => key.startsWith("otel.pageVisit."),
    );
  }

  function visitNamespace(namePrefix: string): string {
    return JSON.stringify([namePrefix, null, null]);
  }

  function visitKey(namePrefix: string, slot: number): string {
    return `otel.pageVisit.${visitNamespace(namePrefix)}.${slot}`;
  }

  function seedVisit(key: string) {
    const previous = {
      id: "11111111111111111111111111111111",
      name: "previous document",
      url: new URL("/previous-document", originalUrl).href,
      startTimeUnixMs: performance.timeOrigin - 2_000,
    };
    storage.setItem(key, JSON.stringify(previous));
    return previous;
  }

  beforeEach(() => {
    originalUrl = location.href;
    originalState = history.state;
    storage = sessionStorage;
    savedVisits = new Map(visitKeys().map((key) => [key, storage.getItem(key)!]));
    for (const key of savedVisits.keys()) storage.removeItem(key);
    now = performance.timeOrigin + 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      {
        startTime: 0,
        connectEnd: 20,
        requestStart: 30,
        responseStart: 80,
        responseEnd: 110,
        loadEventEnd: 170,
        type: "navigate",
      } as PerformanceNavigationTiming,
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
  });

  afterEach(async () => {
    // Stop listeners, settle timers and pending Azure startup queues before restoring browser state.
    const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
    handles.clear();
    try {
      expect(globalThis.fetch).not.toHaveBeenCalled();
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    } finally {
      vi.restoreAllMocks();
      history.replaceState(originalState, "", originalUrl);
      for (const key of visitKeys()) storage.removeItem(key);
      for (const [key, value] of savedVisits) storage.setItem(key, value);
    }
  });

  async function startVisits(name: string, options: MicrosoftOpenTelemetryBrowserOptions = {}) {
    const records: ReadWriteLogRecord[] = [];
    const handle = await useMicrosoftOpenTelemetry({
      ...options,
      session: { enabled: false },
      userContext: { enabled: false },
      spanProcessors: [],
      logRecordProcessors: [
        {
          onEmit: (record) => {
            records.push(record);
          },
          async forceFlush() {},
          async shutdown() {},
        },
        ...(options.logRecordProcessors ?? []),
      ],
      pageView: {
        routeResolver: () => `${name}:${location.pathname}`,
        useNavigationApiIfAvailable: false,
        ...options.pageView,
      },
    });
    handles.add(handle);
    return {
      handle,
      records,
      visits: () => records.filter((record) => record.eventName === "browser.page_visit"),
    };
  }

  it.each([
    "construction",
    "initial context",
    "page correlation",
    "resource",
    "instrumentation list",
    "provider startup",
  ])(
    "reuses slot zero and restores the previous document after failed %s before enable",
    async (stage) => {
      const namePrefix = `visit-failed-${stage.replaceAll(" ", "-")}-`;
      const key = visitKey(namePrefix, 0);
      const previous = seedVisit(key);
      const saved = storage.getItem(key);
      const failure = new Error(`${stage} failed`);
      const enable = vi.spyOn(PageViewInstrumentation.prototype, "enable");
      const options: MicrosoftOpenTelemetryBrowserOptions = {
        storage: { namePrefix },
        pageView: { autoTrackPageVisitTime: true },
      };
      if (stage === "construction") {
        vi.spyOn(PageViewInstrumentation.prototype, "setConfig").mockImplementationOnce(() => {
          throw failure;
        });
      } else if (stage === "initial context") {
        const manager = new StackContextManager();
        vi.spyOn(manager, "active").mockImplementationOnce(() => {
          throw failure;
        });
        options.traces = { contextManager: manager };
      } else if (stage === "page correlation") {
        vi.spyOn(PageViewInstrumentation.prototype, "pageViews", "get").mockImplementationOnce(
          () => {
            throw failure;
          },
        );
      } else if (stage === "resource") {
        const resource = resourceFromAttributes({});
        vi.spyOn(resource, "waitForAsyncAttributes").mockRejectedValueOnce(failure);
        options.resource = resource;
      } else if (stage === "instrumentation list") {
        const instrumentations: BrowserInstrumentation[] = [];
        vi.spyOn(instrumentations, Symbol.iterator).mockImplementationOnce(() => {
          throw failure;
        });
        options.instrumentations = instrumentations;
      } else {
        vi.mocked(addInstance).mockImplementationOnce(() => {
          throw failure;
        });
      }

      await expect(startVisits("failed", options)).rejects.toBe(failure);

      expect(enable).not.toHaveBeenCalled();
      expect(storage.getItem(key)).toBe(saved);
      expect(getSharedRegistry().pageVisitSlots?.has(visitNamespace(namePrefix))).toBe(false);
      const retry = await startVisits("retry", {
        storage: { namePrefix },
        pageView: { autoTrackPageVisitTime: true },
      });
      expect(visitKeys()).toEqual([key]);
      expect(retry.visits()).toMatchObject([
        {
          spanContext: { traceId: previous.id },
          attributes: {
            "browser.page_view.id": previous.id,
            "browser.page_view.name": previous.name,
            "url.full": previous.url,
            "browser.page_visit.duration": 2_000,
          },
        },
      ]);
      expect(retry.visits()).toHaveLength(1);
      expect(JSON.parse(storage.getItem(key)!)).toMatchObject({
        name: `retry:${location.pathname}`,
      });
    },
  );

  it("reuses slot zero after shutdown and restores that slot in the next document", async () => {
    const namePrefix = "visit-recreated-";
    const options = {
      storage: { namePrefix },
      pageView: { autoTrackPageVisitTime: true },
    };
    const key = visitKey(namePrefix, 0);
    const first = await startVisits("first", options);
    expect(visitKeys()).toEqual([key]);
    await first.handle.shutdown();
    expect(visitKeys()).toEqual([]);

    const recreated = await startVisits("recreated", options);
    expect(visitKeys()).toEqual([key]);
    expect(recreated.visits()).toEqual([]);
    const saved = storage.getItem(key)!;
    await recreated.handle.shutdown();
    expect(visitKeys()).toEqual([]);

    // Restore the persisted visit with an earlier document's time origin.
    const previous = JSON.parse(saved) as { id: string; name: string };
    storage.setItem(
      key,
      JSON.stringify({ ...JSON.parse(saved), startTimeUnixMs: performance.timeOrigin - 10_000 }),
    );
    const nextDocument = await startVisits("next-document", options);
    expect(visitKeys()).toEqual([key]);
    expect(nextDocument.visits()).toMatchObject([
      {
        attributes: {
          "browser.page_view.id": previous.id,
          "browser.page_view.name": previous.name,
          "browser.page_visit.duration": 10_000,
        },
      },
    ]);
    expect(nextDocument.visits()).toHaveLength(1);
  });

  it("reuses the lowest free slot without moving or overlapping live instances", async () => {
    const namePrefix = "visit-live-slots-";
    const initialPath = location.pathname;
    const options = {
      storage: { namePrefix },
      pageView: { autoTrackPageVisitTime: true },
    };
    const alpha = await startVisits("alpha", options);
    const beta = await startVisits("beta", options);
    const gamma = await startVisits("gamma", options);
    expect(visitKeys().sort()).toEqual([0, 1, 2].map((slot) => visitKey(namePrefix, slot)));
    const gammaSaved = storage.getItem(visitKey(namePrefix, 2));

    await beta.handle.shutdown();
    const delta = await startVisits("delta", options);
    expect(delta.visits()).toEqual([]);
    expect(storage.getItem(visitKey(namePrefix, 2))).toBe(gammaSaved);
    const deltaSaved = storage.getItem(visitKey(namePrefix, 1));
    await alpha.handle.shutdown();
    const epsilon = await startVisits("epsilon", options);
    // Repeating an old shutdown must not release a replacement's reservation.
    await alpha.handle.shutdown();
    expect(epsilon.visits()).toEqual([]);
    expect(storage.getItem(visitKey(namePrefix, 1))).toBe(deltaSaved);
    expect(storage.getItem(visitKey(namePrefix, 2))).toBe(gammaSaved);
    expect(getSharedRegistry().pageVisitSlots?.get(visitNamespace(namePrefix))).toEqual(
      new Set([0, 1, 2]),
    );

    now = performance.timeOrigin + 5_000;
    history.pushState(null, "", "/visit-live-slots");
    for (const [name, instance, slot] of [
      ["gamma", gamma, 2],
      ["delta", delta, 1],
      ["epsilon", epsilon, 0],
    ] as const) {
      expect(instance.visits()).toHaveLength(1);
      expect(instance.visits()[0].attributes["browser.page_view.name"]).toBe(
        `${name}:${initialPath}`,
      );
      expect(JSON.parse(storage.getItem(visitKey(namePrefix, slot))!)).toMatchObject({
        name: `${name}:/visit-live-slots`,
      });
    }
  });

  it("honors reservations shared through the realm registry by another distribution copy", async () => {
    const namePrefix = "visit-shared-slots-";
    const namespace = visitNamespace(namePrefix);
    const registry = getSharedRegistry();
    // Model another bundle's live slots using only the shared registry contract.
    const foreignSlots = new Set([0, 2]);
    const namespaces = (registry.pageVisitSlots ??= new Map());
    namespaces.set(namespace, foreignSlots);
    try {
      const instance = await startVisits("local", {
        storage: { namePrefix },
        pageView: { autoTrackPageVisitTime: true },
      });
      expect(visitKeys()).toEqual([visitKey(namePrefix, 1)]);
      expect(namespaces.get(namespace)).toBe(foreignSlots);
      expect(foreignSlots).toEqual(new Set([0, 1, 2]));
      await instance.handle.shutdown();
      expect(foreignSlots).toEqual(new Set([0, 2]));
      expect(namespaces.get(namespace)).toBe(foreignSlots);
    } finally {
      foreignSlots.delete(0);
      foreignSlots.delete(2);
      if (!foreignSlots.size) namespaces.delete(namespace);
    }
  });

  it("keeps a re-entrant startup's slot reserved when the enclosing startup fails", async () => {
    const namePrefix = "visit-reentrant-start-";
    const key = visitKey(namePrefix, 0);
    seedVisit(key);
    const saved = storage.getItem(key);
    const options = {
      storage: { namePrefix },
      pageView: { autoTrackPageVisitTime: true },
    };
    const failure = new Error("initial context failed");
    const manager = new StackContextManager();
    let nested!: ReturnType<typeof startVisits>;
    vi.spyOn(manager, "active").mockImplementationOnce(() => {
      nested = startVisits("nested", options);
      throw failure;
    });

    await expect(
      startVisits("outer", { ...options, traces: { contextManager: manager } }),
    ).rejects.toBe(failure);
    const survivor = await nested;
    expect(survivor.visits()).toEqual([]);
    expect(storage.getItem(key)).toBe(saved);
    expect(JSON.parse(storage.getItem(visitKey(namePrefix, 1))!)).toMatchObject({
      name: `nested:${location.pathname}`,
    });
    const retry = await startVisits("retry", options);
    expect(retry.visits()).toHaveLength(1);
    expect(visitKeys().sort()).toEqual([key, visitKey(namePrefix, 1)]);
    expect(getSharedRegistry().pageVisitSlots?.get(visitNamespace(namePrefix))).toEqual(
      new Set([0, 1]),
    );
  });

  it("releases a failed startup's slot even when instrumentation cleanup throws", async () => {
    const namePrefix = "visit-startup-cleanup-";
    const failure = new Error("instrumentation enable failed");
    const cleanupFailure = new Error("instrumentation disable failed");
    const options = {
      storage: { namePrefix },
      pageView: { autoTrackPageVisitTime: true },
    };
    const disable = vi.fn(() => {
      throw cleanupFailure;
    });

    await expect(
      startVisits("failed", {
        ...options,
        instrumentations: [
          {
            ...createProbe(),
            enable() {
              throw failure;
            },
            disable,
          },
        ],
      }),
    ).rejects.toBe(failure);

    expect(disable).toHaveBeenCalledOnce();
    expect(visitKeys()).toEqual([]);
    expect(getSharedRegistry().pageVisitSlots?.has(visitNamespace(namePrefix))).toBe(false);
    await startVisits("retry", options);
    expect(visitKeys()).toEqual([visitKey(namePrefix, 0)]);
  });

  it.each([
    ["custom processors", false],
    ["pending connection string", false],
    ["custom processors", true],
    ["pending connection string", true],
  ] as const)(
    "leaves the seed untouched when caller enable navigates then fails with %s (later quota=%s)",
    async (destination, quotaFailure) => {
      const namePrefix = `visit-enable-rollback-${destination.replaceAll(" ", "-")}-${quotaFailure}-`;
      const key = visitKey(namePrefix, 0);
      const previous = seedVisit(key);
      const saved = storage.getItem(key);
      const laterPath = "/visit-enable-rollback-later-route";
      const largeName = "Large later route name ".repeat(128);
      const initialName = `failed:${location.pathname}`;
      const quotaBytes =
        Math.max(
          saved!.length,
          JSON.stringify({
            ...previous,
            name: initialName,
            url: location.href,
            startTimeUnixMs: performance.timeOrigin,
          }).length,
        ) + 32;
      const routeResolver = vi.fn(() =>
        location.pathname === laterPath ? largeName : initialName,
      );
      const persist = storage.setItem.bind(storage);
      const write = vi.spyOn(storage, "setItem").mockImplementation((name, value) => {
        if (quotaFailure && name === key && value.length > quotaBytes) {
          throw new DOMException("Visit storage full", "QuotaExceededError");
        }
        persist(name, value);
      });
      const remove = vi.spyOn(storage, "removeItem");
      const accepted: ReadWriteLogRecord[] = [];
      const options: MicrosoftOpenTelemetryBrowserOptions = {
        storage: { namePrefix },
        pageView: { autoTrackPageVisitTime: true },
        // This queue must be discarded on failure, without consuming the persisted visit.
        ...(destination === "pending connection string"
          ? { azureMonitor: { connectionString: new Promise<string>(() => {}) } }
          : {}),
        logRecordProcessors: [
          {
            onEmit: (record) => {
              accepted.push(record);
            },
            async forceFlush() {},
            async shutdown() {},
          },
        ],
      };
      const failure = new Error("later instrumentation enable failed");

      await expect(
        startVisits("failed", {
          ...options,
          pageView: { ...options.pageView, routeResolver },
          instrumentations: [
            {
              ...createProbe(),
              enable() {
                expect(routeResolver).toHaveReturnedWith(initialName);
                expect(storage.getItem(key)).toBe(saved);
                expect(write.mock.calls.filter(([name]) => name === key)).toEqual([]);
                expect(remove.mock.calls.filter(([name]) => name === key)).toEqual([]);

                now = performance.timeOrigin + 3_000;
                history.pushState(null, "", laterPath);

                // A short initial write would succeed and this route would exceed quota.
                // Neither is attempted: managed startup prevents the old restore/backoff path.
                expect(routeResolver).toHaveReturnedWith(largeName);
                expect(JSON.stringify({ ...previous, name: largeName }).length).toBeGreaterThan(
                  quotaBytes,
                );
                expect(write.mock.calls.filter(([name]) => name === key)).toEqual([]);
                expect(remove.mock.calls.filter(([name]) => name === key)).toEqual([]);
                expect(storage.getItem(key)).toBe(saved);
                expect(
                  accepted.filter((record) => record.eventName === "browser.page_visit"),
                ).toEqual([]);
                throw failure;
              },
            },
          ],
        }),
      ).rejects.toBe(failure);

      expect(storage.getItem(key)).toBe(saved);
      expect(accepted.filter((record) => record.eventName === "browser.page_visit")).toEqual([]);
      expect(getSharedRegistry().pageVisitSlots?.has(visitNamespace(namePrefix))).toBe(false);
      expect(write.mock.calls.filter(([name]) => name === key)).toEqual([]);
      expect(remove.mock.calls.filter(([name]) => name === key)).toEqual([]);
      // Retry from the original short route; the larger route is deliberately over quota.
      history.replaceState(null, "", originalUrl);
      const retry = await startVisits("retry", options);
      expect(visitKeys()).toEqual([key]);
      expect(write.mock.calls.filter(([name]) => name === key)).toEqual([
        [key, storage.getItem(key)],
      ]);
      expect(remove.mock.calls.filter(([name]) => name === key)).toEqual([]);
      expect(JSON.parse(storage.getItem(key)!)).toMatchObject({
        name: `retry:${location.pathname}`,
        startTimeUnixMs: performance.timeOrigin,
      });
      expect(retry.visits()).toHaveLength(1);
      expect(retry.visits()).toMatchObject([
        {
          spanContext: { traceId: previous.id },
          attributes: {
            "browser.page_view.id": previous.id,
            "browser.page_view.name": previous.name,
            "url.full": previous.url,
            "browser.page_visit.duration": 2_000,
          },
        },
      ]);
      // Synchronous destinations must not receive a duplicate from the failed attempt.
      expect(accepted.filter((record) => record.eventName === "browser.page_visit")).toHaveLength(
        1,
      );
    },
  );

  it.each(["custom processors", "pending connection string"])(
    "consumes the seed once when the initial commit write hits native quota with %s",
    async (destination) => {
      const namePrefix = `visit-commit-quota-${destination.replaceAll(" ", "-")}-`;
      const key = visitKey(namePrefix, 0);
      const previous = seedVisit(key);
      const saved = storage.getItem(key);
      const persist = storage.setItem.bind(storage);
      const write = vi.spyOn(storage, "setItem").mockImplementation((name, value) => {
        if (name === key) {
          expect(storage.getItem(key)).toBe(saved);
          throw new DOMException("Visit storage full", "QuotaExceededError");
        }
        persist(name, value);
      });
      const remove = vi.spyOn(storage, "removeItem");
      const stateAtReport: (string | null)[] = [];
      const accepted = vi.fn((record: ReadWriteLogRecord) => {
        if (record.eventName !== "browser.page_visit") return;
        stateAtReport.push(storage.getItem(key));
        expect(write.mock.calls.filter(([name]) => name === key)).toHaveLength(1);
        expect(remove.mock.calls.filter(([name]) => name === key)).toEqual([[key]]);
        expect(storage.getItem(key)).toBeNull();
      });
      const options: MicrosoftOpenTelemetryBrowserOptions = {
        storage: { namePrefix },
        pageView: { autoTrackPageVisitTime: true },
        ...(destination === "pending connection string"
          ? { azureMonitor: { connectionString: new Promise<string>(() => {}) } }
          : {}),
        logRecordProcessors: [
          {
            onEmit: accepted,
            async forceFlush() {},
            async shutdown() {},
          },
        ],
        instrumentations: [
          {
            ...createProbe(),
            enable() {
              // Initial quota failure belongs to commit, not the preceding enable loop.
              expect(write.mock.calls.filter(([name]) => name === key)).toEqual([]);
              expect(remove.mock.calls.filter(([name]) => name === key)).toEqual([]);
              expect(storage.getItem(key)).toBe(saved);
            },
          },
        ],
      };

      const instance = await startVisits("commit", options);

      expect(write.mock.calls.filter(([name]) => name === key)).toHaveLength(1);
      expect(remove.mock.calls.filter(([name]) => name === key)).toEqual([[key]]);
      expect(storage.getItem(key)).toBeNull();
      expect(stateAtReport).toEqual([null]);
      expect(instance.visits()).toHaveLength(1);
      expect(instance.visits()).toMatchObject([
        {
          spanContext: { traceId: previous.id },
          attributes: {
            "browser.page_view.id": previous.id,
            "browser.page_view.name": previous.name,
            "url.full": previous.url,
            "browser.page_visit.duration": 2_000,
          },
        },
      ]);
      expect(
        accepted.mock.calls.filter(([record]) => record.eventName === "browser.page_visit"),
      ).toHaveLength(1);

      await instance.handle.shutdown();
      write.mockRestore();
      const retry = await startVisits("retry", { ...options, instrumentations: [] });
      expect(retry.visits()).toEqual([]);
      expect(
        accepted.mock.calls.filter(([record]) => record.eventName === "browser.page_visit"),
      ).toHaveLength(1);
    },
  );

  it.each(["instrumentation", "processor"])(
    "releases a slot after throwing %s cleanup without overlapping re-entrant startup",
    async (stage) => {
      const namePrefix = `visit-shutdown-cleanup-${stage}-`;
      const options = {
        storage: { namePrefix },
        pageView: { autoTrackPageVisitTime: true },
      };
      const failure = new Error(`${stage} cleanup failed`);
      let nested!: ReturnType<typeof startVisits>;
      const cleanup = () => {
        nested = startVisits("nested", options);
        throw failure;
      };
      const instance = await startVisits("stopping", {
        ...options,
        ...(stage === "instrumentation"
          ? { instrumentations: [{ ...createProbe(), disable: cleanup }] }
          : {
              logRecordProcessors: [
                {
                  onEmit() {},
                  async forceFlush() {},
                  async shutdown() {
                    cleanup();
                  },
                },
              ],
            }),
      });
      // Expected rejected shutdown is already observed here, not by the suite's cleanup.
      handles.delete(instance.handle);
      await expect(instance.handle.shutdown()).rejects.toBe(failure);

      const survivor = await nested;
      expect(survivor.visits()).toEqual([]);
      expect(visitKeys()).toEqual([visitKey(namePrefix, 1)]);
      const survivorSaved = storage.getItem(visitKey(namePrefix, 1));
      await startVisits("replacement", options);
      expect(visitKeys().sort()).toEqual([0, 1].map((slot) => visitKey(namePrefix, slot)));
      expect(storage.getItem(visitKey(namePrefix, 1))).toBe(survivorSaved);
      expect(getSharedRegistry().pageVisitSlots?.get(visitNamespace(namePrefix))).toEqual(
        new Set([0, 1]),
      );
    },
  );

  it.each([undefined, false])(
    "does not access sessionStorage or report visits when autoTrackPageVisitTime is %s",
    async (autoTrackPageVisitTime) => {
      const access = vi.spyOn(window, "sessionStorage", "get");
      const instance = await startVisits("disabled", {
        pageView: {
          ...(autoTrackPageVisitTime === undefined ? {} : { autoTrackPageVisitTime }),
        },
      });

      now = performance.timeOrigin + 5_000;
      history.pushState(null, "", "/visit-disabled");
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      await instance.handle.forceFlush();
      await instance.handle.shutdown();

      expect(instance.records.map((record) => record.eventName)).toEqual([
        "browser.page_view",
        "browser.page_view",
      ]);
      expect(instance.visits()).toEqual([]);
      expect(access).not.toHaveBeenCalled();
      expect(visitKeys()).toEqual([]);
    },
  );

  it("keeps SPA visits isolated without persistence when storage is disabled", async () => {
    const sentinelKey = "otel.pageVisit.disabled-sentinel";
    storage.setItem(sentinelKey, "existing visit");
    const access = vi.spyOn(window, "sessionStorage", "get");
    const initialPath = location.pathname;
    const alpha = await startVisits("alpha", {
      storage: { enabled: false, namePrefix: "visit-alpha-" },
      pageView: { autoTrackPageVisitTime: true },
    });
    const beta = await startVisits("beta", {
      storage: { enabled: false, namePrefix: "visit-beta-" },
      pageView: { autoTrackPageVisitTime: true },
    });
    expect(alpha.visits()).toEqual([]);
    expect(beta.visits()).toEqual([]);

    now = performance.timeOrigin + 5_000;
    history.pushState(null, "", "/visit-memory-one");
    now = performance.timeOrigin + 8_000;
    history.pushState(null, "", "/visit-memory-two");

    for (const [name, instance] of [
      ["alpha", alpha],
      ["beta", beta],
    ] as const) {
      expect(instance.visits()).toMatchObject([
        {
          attributes: {
            "browser.page_view.name": `${name}:${initialPath}`,
            "url.full": originalUrl,
            "browser.page_visit.duration": 5_000,
          },
        },
        {
          attributes: {
            "browser.page_view.name": `${name}:/visit-memory-one`,
            "url.full": new URL("/visit-memory-one", originalUrl).href,
            "browser.page_visit.duration": 3_000,
          },
        },
      ]);
      await instance.handle.shutdown();
      expect(instance.visits()).toHaveLength(2);
    }
    expect(access).not.toHaveBeenCalled();
    expect(visitKeys()).toEqual([sentinelKey]);
    expect(storage.getItem(sentinelKey)).toBe("existing visit");
  });

  it.each(["custom processors", "pending connection string"])(
    "persists distinct instance namespaces without cross-reading or reporting (%s)",
    async (destination) => {
      // Never resolve: custom processors remain live, but no Azure exporter can send or persist.
      const azureMonitor =
        destination === "pending connection string"
          ? { connectionString: new Promise<string>(() => {}) }
          : undefined;
      const reads = vi.spyOn(storage, "getItem");
      const initialPath = location.pathname;
      const alpha = await startVisits("alpha", {
        azureMonitor,
        storage: { namePrefix: "visit-alpha-" },
        pageView: { autoTrackPageVisitTime: true },
      });
      expect(visitKeys()).toHaveLength(1);
      const alphaKey = visitKeys()[0]!;
      expect(alphaKey).toContain("visit-alpha-");
      expect(reads.mock.calls.map(([key]) => key)).toEqual(["otel.pageVisitOwner", alphaKey]);
      const alphaSaved = storage.getItem(alphaKey)!;
      expect(JSON.parse(alphaSaved)).toMatchObject({
        name: `alpha:${initialPath}`,
        url: originalUrl,
        startTimeUnixMs: performance.timeOrigin,
      });
      reads.mockClear();

      const beta = await startVisits("beta", {
        azureMonitor,
        storage: { namePrefix: "visit-beta-" },
        pageView: { autoTrackPageVisitTime: true },
      });
      expect(visitKeys()).toHaveLength(2);
      const betaKey = visitKeys().find((key) => key !== alphaKey)!;
      expect(betaKey).toContain("visit-beta-");
      expect(reads.mock.calls.map(([key]) => key)).toEqual(["otel.pageVisitOwner", betaKey]);
      expect(storage.getItem(alphaKey)).toBe(alphaSaved);
      expect(JSON.parse(storage.getItem(betaKey)!)).toMatchObject({
        name: `beta:${initialPath}`,
        url: originalUrl,
        startTimeUnixMs: performance.timeOrigin,
      });
      expect(alpha.visits()).toEqual([]);
      expect(beta.visits()).toEqual([]);

      now = performance.timeOrigin + 5_000;
      history.pushState(null, "", "/visit-persisted-one");
      for (const [name, instance, key] of [
        ["alpha", alpha, alphaKey],
        ["beta", beta, betaKey],
      ] as const) {
        const initial = instance.records.find(
          (record) => record.eventName === "browser.page_view",
        )!;
        expect(instance.visits()).toMatchObject([
          {
            spanContext: { traceId: initial.attributes["browser.page_view.id"] },
            attributes: {
              "browser.page_view.id": initial.attributes["browser.page_view.id"],
              "browser.page_view.name": `${name}:${initialPath}`,
              "url.full": originalUrl,
              "browser.page_visit.duration": 5_000,
            },
          },
        ]);
        expect(JSON.parse(storage.getItem(key)!)).toMatchObject({
          name: `${name}:/visit-persisted-one`,
          url: new URL("/visit-persisted-one", originalUrl).href,
          startTimeUnixMs: now,
        });
      }

      const alphaCurrent = storage.getItem(alphaKey);
      reads.mockClear();
      await beta.handle.shutdown();
      expect(reads).toHaveBeenCalledExactlyOnceWith(betaKey);
      expect(beta.visits()).toHaveLength(1);
      expect(storage.getItem(betaKey)).toBeNull();
      expect(storage.getItem(alphaKey)).toBe(alphaCurrent);

      now = performance.timeOrigin + 8_000;
      history.pushState(null, "", "/visit-persisted-two");
      expect(alpha.visits()).toHaveLength(2);
      expect(alpha.visits()[1].attributes).toMatchObject({
        "browser.page_view.name": "alpha:/visit-persisted-one",
        "url.full": new URL("/visit-persisted-one", originalUrl).href,
        "browser.page_visit.duration": 3_000,
      });
      expect(beta.visits()).toHaveLength(1);
      await alpha.handle.shutdown();
      expect(alpha.visits()).toHaveLength(2);
      expect(visitKeys()).toEqual([]);
    },
  );

  it.each([undefined, ""])(
    "keeps async destinations in memory without a nonempty namePrefix (%s)",
    async (namePrefix) => {
      const access = vi.spyOn(window, "sessionStorage", "get");
      const initialPath = location.pathname;
      const instance = await startVisits("async", {
        azureMonitor: { connectionString: new Promise<string>(() => {}) },
        ...(namePrefix === undefined ? {} : { storage: { namePrefix } }),
        pageView: { autoTrackPageVisitTime: true },
      });
      expect(instance.visits()).toEqual([]);

      now = performance.timeOrigin + 5_000;
      history.pushState(null, "", "/visit-async-one");
      now = performance.timeOrigin + 8_000;
      history.pushState(null, "", "/visit-async-two");
      await instance.handle.forceFlush();
      await instance.handle.shutdown();

      expect(instance.visits()).toMatchObject([
        {
          attributes: {
            "browser.page_view.name": `async:${initialPath}`,
            "url.full": originalUrl,
            "browser.page_visit.duration": 5_000,
          },
        },
        {
          attributes: {
            "browser.page_view.name": "async:/visit-async-one",
            "url.full": new URL("/visit-async-one", originalUrl).href,
            "browser.page_visit.duration": 3_000,
          },
        },
      ]);
      expect(access).not.toHaveBeenCalled();
      expect(visitKeys()).toEqual([]);
    },
  );

  it("drops the unfinished visit on shutdown and ignores subsequent navigation", async () => {
    const instance = await startVisits("shutdown", {
      storage: { namePrefix: "visit-shutdown-" },
      pageView: { autoTrackPageVisitTime: true },
    });
    now = performance.timeOrigin + 5_000;
    history.pushState(null, "", "/visit-before-shutdown");
    expect(instance.visits()).toHaveLength(1);
    expect(visitKeys()).toHaveLength(1);

    now = performance.timeOrigin + 20_000;
    const emitted = instance.records.length;
    await instance.handle.shutdown();
    await instance.handle.shutdown();
    expect(instance.records).toHaveLength(emitted);
    expect(instance.visits()).toHaveLength(1);
    expect(visitKeys()).toEqual([]);

    history.pushState(null, "", "/visit-after-shutdown");
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(instance.records).toHaveLength(emitted);
    expect(visitKeys()).toEqual([]);
  });
});
