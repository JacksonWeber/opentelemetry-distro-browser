// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { afterEach, beforeEach, expect, inject, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
} from "../../src/index.js";
import type { AzureMonitorEnvelope, CustomEventData } from "../../src/exporter/telemetryModels.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../src/types.js";
import { withoutSdkStats } from "../fixtures/sdkStats.js";
import { createInMemoryPipeline, createSpanContext } from "../fixtures/telemetry.js";

const handles: MicrosoftOpenTelemetryBrowser[] = [];
let originalUrl: string;

beforeEach(() => {
  originalUrl = location.href;
  const nativeFetch = fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation(withoutSdkStats(nativeFetch));
});

afterEach(async () => {
  try {
    await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  } finally {
    history.replaceState(null, "", originalUrl);
    trace.disable();
    logs.disable();
    propagation.disable();
    context.disable();
    diag.disable();
    vi.restoreAllMocks();
  }
});

async function start(options: Partial<MicrosoftOpenTelemetryBrowserOptions> = {}) {
  const pipeline = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: false },
    session: { persist: false },
    userContext: { enabled: false },
    ...options,
  });
  handles.push(handle);
  return { ...pipeline, handle };
}

function clients() {
  return {
    tracer: trace.getTracer("dynamic-configuration"),
    logger: logs.getLogger("dynamic-configuration"),
  };
}

function emit(client: ReturnType<typeof clients>, name: string): void {
  client.tracer.startSpan(name, {}, ROOT_CONTEXT).end();
  client.logger.emit({ eventName: name, body: name, context: ROOT_CONTEXT });
}

it("keeps cached tracers and loggers bound to their instance across 0/100/reset updates", async () => {
  const first = await start({ resource: resourceFromAttributes({ "service.name": "first" }) });
  const cached = clients();
  const second = await start({ resource: resourceFromAttributes({ "service.name": "second" }) });
  emit(cached, "initial");
  await first.handle.updateCfg({ samplingPercentage: 0 });
  emit(cached, "dropped-span");
  await first.handle.updateCfg({ samplingPercentage: 100 });
  emit(cached, "all");
  await first.handle.updateCfg({ samplingPercentage: undefined });
  emit(cached, "reset");
  await second.handle.updateCfg({ samplingPercentage: 0 });
  emit(cached, "other-instance-isolated");
  await Promise.all([first.handle.forceFlush(), second.handle.forceFlush()]);

  expect(first.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "initial",
    "all",
    "reset",
    "other-instance-isolated",
  ]);
  const records = first.logExporter.getFinishedLogRecords();
  expect(records.map((record) => record.eventName)).toEqual([
    "initial",
    "dropped-span",
    "all",
    "reset",
    "other-instance-isolated",
  ]);
  expect(records.every((record) => record.resource.attributes["service.name"] === "first")).toBe(
    true,
  );
  expect(
    first.spanExporter
      .getFinishedSpans()
      .every((span) => span.resource.attributes["service.name"] === "first"),
  ).toBe(true);
  expect(second.spanExporter.getFinishedSpans()).toEqual([]);
  expect(second.logExporter.getFinishedLogRecords()).toEqual([]);
});

it("restores parent-based sampling rather than treating an undefined reset as 100 percent", async () => {
  const pipeline = await start({ samplingPercentage: 100 });
  const { tracer } = clients();
  const parent = trace.setSpanContext(ROOT_CONTEXT, { ...createSpanContext(), traceFlags: 0 });
  tracer.startSpan("explicit-100", {}, parent).end();
  expect(await pipeline.handle.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  tracer.startSpan("omitted-retains-policy", {}, parent).end();
  await pipeline.handle.updateCfg({ samplingPercentage: undefined });
  tracer.startSpan("unsampled-parent", {}, parent).end();
  tracer.startSpan("default-root", {}, ROOT_CONTEXT).end();
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "explicit-100",
    "omitted-retains-policy",
    "default-root",
  ]);
});

it("updates Azure spans, logs and page decisions without filtering caller log processors", async () => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${runId}`;
  let pages = 0;
  const pipeline = await start({
    samplingPercentage: 0,
    azureMonitor: {
      connectionString: `InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=${ingestionEndpoint}`,
    },
    pageView: { applyCustomLogRecordData: () => pages++ },
  });
  const cached = clients();
  await vi.waitFor(() => expect(pages).toBe(1));
  emit(cached, "zero");
  await pipeline.handle.forceFlush();
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith(ingestionEndpoint)),
  ).toHaveLength(0);
  await pipeline.handle.updateCfg({ samplingPercentage: 100 });
  emit(cached, "hundred");
  // A route creates a new page operation using the current policy, not the startup policy.
  history.pushState(null, "", `${location.pathname}?dynamic-sampling=${runId}`);
  await vi.waitFor(() => expect(pages).toBe(2));
  await pipeline.handle.forceFlush();
  await pipeline.handle.updateCfg({ samplingPercentage: undefined });
  emit(cached, "native");
  cached.logger.emit({
    eventName: "native-unsampled-parent",
    body: "native-unsampled-parent",
    context: trace.setSpanContext(ROOT_CONTEXT, { ...createSpanContext(), traceFlags: 0 }),
  });
  await pipeline.handle.forceFlush();

  const endpoint = new URL(ingestionEndpoint);
  const envelopes: AzureMonitorEnvelope[] = await fetch(
    `${endpoint.origin}/captured?runId=${runId}`,
  ).then((response) => response.json());
  expect(
    envelopes
      .filter(
        (envelope): envelope is AzureMonitorEnvelope<CustomEventData> =>
          envelope.data.baseType === "EventData",
      )
      .map((envelope) => envelope.data.baseData.name),
  ).toEqual(["hundred", "native", "native-unsampled-parent"]);
  expect(envelopes.filter((envelope) => envelope.data.baseType === "PageViewData")).toHaveLength(1);
  expect(
    envelopes.filter((envelope) => envelope.data.baseType === "RemoteDependencyData"),
  ).toHaveLength(2);
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "hundred",
    "native",
  ]);
  const records = pipeline.logExporter.getFinishedLogRecords();
  expect(records.filter((record) => record.eventName === "browser.page_view")).toHaveLength(2);
  expect(
    records
      .filter((record) => record.eventName !== "browser.page_view")
      .map((record) => record.eventName),
  ).toEqual(["zero", "hundred", "native", "native-unsampled-parent"]);
});

it("rejects invalid percentages and unknown paths atomically without advancing the revision", async () => {
  const pipeline = await start();
  const cached = clients();
  const patches = [
    ...[-1, 101, NaN, Infinity, "0", null].map((samplingPercentage) => ({ samplingPercentage })),
    { samplingPercentage: 0, unsupported: true },
  ];
  for (const patch of patches) {
    await expect(
      pipeline.handle.updateCfg(patch as MicrosoftOpenTelemetryBrowserConfigurationUpdate),
    ).rejects.toThrow();
    expect(await pipeline.handle.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  }
  emit(cached, "still-sampled");
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "still-sampled",
  ]);
});

it("serializes captured patches, resets omissions in replacement mode and keeps no-op revisions", async () => {
  const pipeline = await start({ samplingPercentage: 100 });
  const cached = clients();
  const patch = { samplingPercentage: 0 };
  const first = pipeline.handle.updateCfg(patch);
  patch.samplingPercentage = 100;
  const second = pipeline.handle.updateCfg({ samplingPercentage: 100 });
  expect(await first).toEqual({ revision: 1, changedPaths: ["samplingPercentage"] });
  expect(await second).toEqual({ revision: 2, changedPaths: ["samplingPercentage"] });
  expect(await pipeline.handle.updateCfg({})).toEqual({ revision: 2, changedPaths: [] });
  expect(await pipeline.handle.updateCfg({}, false)).toEqual({
    revision: 3,
    changedPaths: ["samplingPercentage"],
  });
  expect(await pipeline.handle.updateCfg({}, false)).toEqual({ revision: 3, changedPaths: [] });
  emit(cached, "replacement-reset");
  const parent = trace.setSpanContext(ROOT_CONTEXT, { ...createSpanContext(), traceFlags: 0 });
  cached.tracer.startSpan("default-unsampled-parent", {}, parent).end();
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "replacement-reset",
  ]);
});

it("rejects queued and future updates once shutdown starts", async () => {
  const pipeline = await start();
  const queued = Promise.allSettled([
    pipeline.handle.updateCfg({ samplingPercentage: 0 }),
    pipeline.handle.updateCfg({ samplingPercentage: 100 }),
  ]);
  const shutdown = pipeline.handle.shutdown();
  expect((await queued).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  await shutdown;
  await expect(pipeline.handle.updateCfg({ samplingPercentage: 100 })).rejects.toThrow("stopped");
});
