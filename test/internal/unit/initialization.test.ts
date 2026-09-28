// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ROOT_CONTEXT,
  context,
  diag,
  propagation,
  trace,
  type ContextManager,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  browserDetector,
  OPENTELEMETRY_BROWSER_VERSION,
  userAgentDetector,
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

vi.mock("@opentelemetry/browser-sdk", { spy: true });

const handles = new Set<MicrosoftOpenTelemetryBrowser>();

beforeEach(() => {
  vi.mocked(startBrowserSdk).mockClear();
});

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  // Upstream shutdown does not unregister globals; isolate tests explicitly.
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

it("prepends session enrichment without changing the caller's processor arrays", async () => {
  const pipeline = createInMemoryPipeline();
  const options: MicrosoftOpenTelemetryBrowserOptions = {
    ...pipeline.options,
    session: { enabled: true },
  };
  Object.freeze(options.spanProcessors);
  Object.freeze(options.logRecordProcessors);
  const upstreamHandle = { shutdown: vi.fn(async () => {}) };
  vi.mocked(startBrowserSdk).mockReturnValueOnce(upstreamHandle);

  const handle = await useMicrosoftOpenTelemetry(Object.freeze(options));
  handles.add(handle);
  expect(useMicrosoftOpenTelemetry).not.toBe(startBrowserSdk);
  expect(startBrowserSdk).toHaveBeenCalledExactlyOnceWith({
    resourceAttributes: {
      "telemetry.distro.name": "@microsoft/opentelemetry-browser",
      "telemetry.distro.version": OPENTELEMETRY_BROWSER_VERSION,
    },
    traces: {
      processors: [
        expect.objectContaining({ onStart: expect.any(Function) }),
        pipeline.spanProcessor,
      ],
    },
    logs: {
      processors: [
        expect.objectContaining({ onEmit: expect.any(Function) }),
        pipeline.logProcessor,
      ],
    },
  });
  expect(options.spanProcessors).toEqual([pipeline.spanProcessor]);
  expect(options.logRecordProcessors).toEqual([pipeline.logProcessor]);
  await handle.forceFlush();
  await handle.shutdown();
  expect(upstreamHandle.shutdown).toHaveBeenCalledOnce();
});

it("adds Azure Monitor batch exporters after session enrichment and before caller processors", async () => {
  const pipeline = createInMemoryPipeline();
  const upstreamHandle = { shutdown: vi.fn(async () => {}) };
  vi.mocked(startBrowserSdk).mockReturnValueOnce(upstreamHandle);
  const addDocumentListener = vi.spyOn(document, "addEventListener");

  const handle = await useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString:
        "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test",
    },
    session: { enabled: true },
    spanProcessors: pipeline.options.spanProcessors,
    logRecordProcessors: pipeline.options.logRecordProcessors,
    pageView: { enabled: false },
  });

  expect(startBrowserSdk).toHaveBeenCalledOnce();
  const sdkOptions = vi.mocked(startBrowserSdk).mock.calls[0]?.[0];
  if (!sdkOptions) throw new Error("Expected browser SDK options");
  expect(sdkOptions.traces?.processors).toHaveLength(3);
  expect(sdkOptions.traces?.processors?.[0]).toEqual(
    expect.objectContaining({ onStart: expect.any(Function) }),
  );
  expect(sdkOptions.traces?.processors?.[1]).toBeInstanceOf(BatchSpanProcessor);
  expect(sdkOptions.traces?.processors?.[2]).toBe(pipeline.spanProcessor);
  expect(sdkOptions.logs?.processors).toHaveLength(3);
  expect(sdkOptions.logs?.processors?.[0]).toEqual(
    expect.objectContaining({ onEmit: expect.any(Function) }),
  );
  expect(sdkOptions.logs?.processors?.[1]).toBeInstanceOf(BatchLogRecordProcessor);
  expect(sdkOptions.logs?.processors?.[2]).toBe(pipeline.logProcessor);
  expect(
    addDocumentListener.mock.calls.filter(([eventName]) => eventName === "visibilitychange"),
  ).toHaveLength(1);

  await handle.shutdown();
  expect(upstreamHandle.shutdown).toHaveBeenCalledOnce();
});

it("forwards trace context configuration without sharing the propagator array", async () => {
  const pipeline = createInMemoryPipeline();
  const contextManager: ContextManager = {
    active: () => ROOT_CONTEXT,
    bind: (_ctx, target) => target,
    disable() {
      return this;
    },
    enable() {
      return this;
    },
    with: (_ctx, callback, thisArg, ...args) => callback.apply(thisArg, args),
  };
  const propagator = {
    fields: () => ["x-test-context"],
    inject: vi.fn(),
    extract: vi.fn((ctx) => ctx),
  };
  const propagators = Object.freeze([propagator]);
  const options: MicrosoftOpenTelemetryBrowserOptions = {
    spanProcessors: [pipeline.spanProcessor],
    traces: Object.freeze({ contextManager, propagators }),
  };
  Object.freeze(options.spanProcessors);
  const upstreamHandle = { shutdown: vi.fn(async () => {}) };
  vi.mocked(startBrowserSdk).mockReturnValueOnce(upstreamHandle);

  const handle = await useMicrosoftOpenTelemetry(Object.freeze(options));
  handles.add(handle);

  expect(startBrowserSdk).toHaveBeenCalledExactlyOnceWith({
    resourceAttributes: {
      "telemetry.distro.name": "@microsoft/opentelemetry-browser",
      "telemetry.distro.version": OPENTELEMETRY_BROWSER_VERSION,
    },
    traces: {
      contextManager,
      propagators: [propagator],
      processors: [pipeline.spanProcessor],
    },
    logs: { processors: undefined },
  });
  const forwarded = vi.mocked(startBrowserSdk).mock.calls[0]?.[0]?.traces?.propagators;
  expect(forwarded).not.toBe(propagators);
  expect(options.traces?.propagators).toBe(propagators);
});

it("identifies the distribution without displacing the upstream SDK defaults", async () => {
  const pipeline = createInMemoryPipeline();
  const spanExport = vi.spyOn(pipeline.spanExporter, "export");
  const handle = await useMicrosoftOpenTelemetry(pipeline.options);
  handles.add(handle);
  trace.getTracer("manual").startSpan("checkout").end();
  await handle.shutdown();
  handles.delete(handle);

  expect(spanExport.mock.calls[0][0][0].resource.attributes).toMatchObject({
    "telemetry.distro.name": "@microsoft/opentelemetry-browser",
    "telemetry.distro.version": OPENTELEMETRY_BROWSER_VERSION,
    "service.name": "unknown_service",
    "telemetry.sdk.language": "webjs",
    "telemetry.sdk.name": "opentelemetry",
  });
});

it("lets a service.name attribute replace the unknown_service placeholder", async () => {
  const pipeline = createInMemoryPipeline();
  const spanExport = vi.spyOn(pipeline.spanExporter, "export");
  const handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    resource: resourceFromAttributes({
      "service.name": "checkout-web",
      "service.version": "4.2.1",
      "deployment.environment.name": "production",
    }),
  });
  handles.add(handle);
  trace.getTracer("manual").startSpan("checkout").end();
  await handle.shutdown();
  handles.delete(handle);

  expect(spanExport.mock.calls[0][0][0].resource.attributes).toMatchObject({
    "service.name": "checkout-web",
    "service.version": "4.2.1",
    "deployment.environment.name": "production",
  });
});

it("does not share one attributes object across initializations", async () => {
  vi.mocked(startBrowserSdk)
    .mockReturnValueOnce({ shutdown: vi.fn(async () => {}) })
    .mockReturnValueOnce({ shutdown: vi.fn(async () => {}) });

  await useMicrosoftOpenTelemetry();
  await useMicrosoftOpenTelemetry();

  const [first, second] = vi.mocked(startBrowserSdk).mock.calls;
  expect(first[0]?.resourceAttributes).not.toBe(second[0]?.resourceAttributes);
});

it("force flushes both signal processors", async () => {
  const pipeline = createInMemoryPipeline();
  const spanFlush = vi.spyOn(pipeline.spanProcessor, "forceFlush");
  const logFlush = vi.spyOn(pipeline.logProcessor, "forceFlush");
  const handle = await useMicrosoftOpenTelemetry(pipeline.options);
  handles.add(handle);

  await handle.forceFlush();

  expect(spanFlush).toHaveBeenCalledOnce();
  expect(logFlush).toHaveBeenCalledOnce();
});

it("propagates initialization failures without returning a success-shaped handle", async () => {
  const failure = new Error("initialization failed");
  vi.mocked(startBrowserSdk).mockImplementationOnce(() => {
    throw failure;
  });
  await expect(useMicrosoftOpenTelemetry()).rejects.toThrow(failure);
});

it.each([undefined, {}])(
  "initializes both providers with default configuration %j",
  async (options) => {
    const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
    const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
    const detectBrowser = vi.spyOn(browserDetector, "detect");
    const detectUserAgent = vi.spyOn(userAgentDetector, "detect");
    const handle = await useMicrosoftOpenTelemetry(options);
    handles.add(handle);
    expect(registerTrace).toHaveBeenCalledOnce();
    expect(registerLogs).toHaveBeenCalledOnce();
    expect(detectBrowser).not.toHaveBeenCalled();
    expect(detectUserAgent).not.toHaveBeenCalled();
  },
);

it("exports correlated manual telemetry through custom processors", async () => {
  const pipeline = createInMemoryPipeline();
  Object.freeze(pipeline.options.spanProcessors);
  Object.freeze(pipeline.options.logRecordProcessors);
  const spanExport = vi.spyOn(pipeline.spanExporter, "export");
  const logExport = vi.spyOn(pipeline.logExporter, "export");
  const handle = await useMicrosoftOpenTelemetry(Object.freeze(pipeline.options));
  handles.add(handle);
  const span = trace.getTracer("manual", "1.2.3").startSpan("checkout");
  logs.getLogger("manual", "1.2.3").emit({
    eventName: "checkout.started",
    context: trace.setSpan(ROOT_CONTEXT, span),
  });
  span.end();
  await handle.shutdown();
  handles.delete(handle);

  const exportedSpan = spanExport.mock.calls[0][0][0];
  const exportedLog = logExport.mock.calls[0][0][0];
  expect(exportedSpan.name).toBe("checkout");
  expect(exportedLog.eventName).toBe("checkout.started");
  expect(exportedLog.spanContext).toEqual(span.spanContext());
  for (const record of [exportedSpan, exportedLog]) {
    expect(record.instrumentationScope).toMatchObject({ name: "manual", version: "1.2.3" });
  }
  expect(pipeline.options.spanProcessors).toEqual([pipeline.spanProcessor]);
  expect(pipeline.options.logRecordProcessors).toEqual([pipeline.logProcessor]);
});

it.each(
  [true, false].flatMap((enabled) =>
    [undefined, []].flatMap((spanProcessors) =>
      [undefined, []].map((logRecordProcessors) => ({
        enabled,
        spanProcessors,
        logRecordProcessors,
      })),
    ),
  ),
)(
  "preserves per-signal disabling and default export (%j)",
  async ({ enabled, spanProcessors, logRecordProcessors }) => {
    const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
    const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
    const spanExport = vi
      .spyOn(OTLPTraceExporter.prototype, "export")
      .mockImplementation((_spans, callback) => callback({ code: 0 }));
    const logExport = vi
      .spyOn(OTLPLogExporter.prototype, "export")
      .mockImplementation((_records, callback) => callback({ code: 0 }));
    const handle = await useMicrosoftOpenTelemetry({
      session: { enabled },
      pageView: { enabled: false },
      spanProcessors,
      logRecordProcessors,
    });
    handles.add(handle);
    expect(registerTrace).toHaveBeenCalledTimes(spanProcessors === undefined ? 1 : 0);
    expect(registerLogs).toHaveBeenCalledTimes(logRecordProcessors === undefined ? 1 : 0);
    const span = trace.getTracer("default-export").startSpan("default");
    expect(span.isRecording()).toBe(spanProcessors === undefined);
    span.end();
    const logger = logs.getLogger("default-export");
    expect(logger.enabled()).toBe(logRecordProcessors === undefined);
    logger.emit({ eventName: "default" });
    await handle.shutdown();
    expect(spanExport).toHaveBeenCalledTimes(spanProcessors === undefined ? 1 : 0);
    expect(logExport).toHaveBeenCalledTimes(logRecordProcessors === undefined ? 1 : 0);
    const ids = [
      ...spanExport.mock.calls.flatMap(([spans]) => spans),
      ...logExport.mock.calls.flatMap(([records]) => records),
    ].map((record) => record.attributes["session.id"]);
    for (const id of ids) {
      if (enabled) {
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(id).toBe(ids[0]);
      } else expect(id).toBeUndefined();
    }
  },
);

it.each([true, false])(
  "preserves caller log filtering with sessions enabled=%s",
  async (enabled) => {
    const pipeline = createInMemoryPipeline();
    const firstEmit = vi.fn();
    const onEmit = vi.spyOn(pipeline.logProcessor, "onEmit");
    const filter = vi.fn<NonNullable<LogRecordProcessor["enabled"]>>(
      (options) =>
        options.eventName === "allowed" && options.severityNumber === SeverityNumber.WARN,
    );
    const handle = await useMicrosoftOpenTelemetry({
      session: { enabled },
      pageView: { enabled: false },
      spanProcessors: [],
      logRecordProcessors: [
        {
          enabled: () => false,
          onEmit: firstEmit,
          forceFlush: async () => {},
          shutdown: async () => {},
        },
        Object.assign(pipeline.logProcessor, { enabled: filter }),
      ],
    });
    handles.add(handle);
    const logger = logs.getLogger("filtered", "1.0");
    const rejected = {
      eventName: "blocked",
      severityNumber: SeverityNumber.WARN,
      context: ROOT_CONTEXT,
    };
    expect(logger.enabled(rejected)).toBe(false);
    logger.emit(rejected);
    logger.emit({ eventName: "allowed", severityNumber: SeverityNumber.INFO });
    expect(firstEmit).not.toHaveBeenCalled();
    expect(onEmit).not.toHaveBeenCalled();
    const accepted = { ...rejected, eventName: "allowed" };
    expect(logger.enabled(accepted)).toBe(true);
    logger.emit(accepted);
    expect(filter).toHaveBeenLastCalledWith({
      ...accepted,
      instrumentationScope: expect.objectContaining({ name: "filtered", version: "1.0" }),
    });
    expect(onEmit).toHaveBeenCalledOnce();
    const id = onEmit.mock.calls[0][0].attributes["session.id"];
    if (enabled) expect(id).toMatch(/^[0-9a-f]{32}$/);
    else expect(id).toBeUndefined();
  },
);

it("reports an upstream shutdown failure while shutting down both signals", async () => {
  const failure = new Error("processor shutdown failed");
  const pipeline = createInMemoryPipeline();
  const traceShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: pipeline.options.spanProcessors,
    logRecordProcessors: [
      {
        onEmit() {},
        async forceFlush() {},
        async shutdown() {
          throw failure;
        },
      },
    ],
  });
  await expect(handle.shutdown()).rejects.toThrow("processor shutdown failed");
  expect(traceShutdown).toHaveBeenCalledOnce();
});
