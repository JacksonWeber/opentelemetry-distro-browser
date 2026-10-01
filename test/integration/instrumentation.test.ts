// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, context, diag, propagation, trace } from "@opentelemetry/api";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { afterEach, expect, it, vi } from "vitest";
import type { MicrosoftOpenTelemetryBrowser } from "../../src/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

const originalUrl = location.href;
const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;
const handles = new Set<MicrosoftOpenTelemetryBrowser>();

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.pushState = originalPushState;
  history.replaceState = originalReplaceState;
  history.replaceState(null, "", originalUrl);
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

for (const file of ["index.js", "index.min.js"]) {
  async function loadDistro() {
    const path = `../../dist/esm/${file}`;
    const url = new URL(path, import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
    return distro;
  }

  it(`registers independently imported navigation and fetch instances through ${file}`, async () => {
    const distro = await loadDistro();
    const pipeline = createInMemoryPipeline();
    const onLog = vi.spyOn(pipeline.logProcessor, "onEmit");
    const onSpan = vi.spyOn(pipeline.spanProcessor, "onStart");
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchRequest);
    const navigation = new NavigationInstrumentation({
      enabled: false,
      sanitizeUrl: (url) => new URL(url).pathname,
      applyCustomLogRecordData: (record) => {
        record.attributes = { ...record.attributes, "test.registration": true };
      },
    });
    const http = new FetchInstrumentation({
      enabled: false,
      sanitizeUrl: (url) => new URL(url).pathname,
      ignoreUrls: [/\/excluded$/],
    });
    const navigationDisable = vi.spyOn(navigation, "disable");
    const httpDisable = vi.spyOn(http, "disable");
    const handle = distro.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      instrumentations: Object.freeze([navigation, http]),
    });
    handles.add(handle);

    history.pushState(null, "", "/registration-page?secret=redact#private");
    await fetch(new URL("/registration-request?secret=redact", location.origin));
    await fetch(new URL("/excluded", location.origin));
    await pipeline.forceFlush();

    const records = pipeline.logExporter.getFinishedLogRecords();
    const record = records.find((entry) => entry.attributes["url.full"] === "/registration-page");
    expect(record).toMatchObject({
      eventName: "browser.navigation",
      severityNumber: SeverityNumber.INFO,
      instrumentationScope: { name: "@opentelemetry/browser-instrumentation/navigation" },
      attributes: {
        "url.full": "/registration-page",
        "browser.navigation.same_document": true,
        "browser.navigation.hash_change": false,
        "browser.navigation.type": "push",
        "test.registration": true,
      },
    });
    const spans = pipeline.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "GET",
      kind: SpanKind.CLIENT,
      instrumentationScope: { name: "@opentelemetry/browser-instrumentation/fetch" },
      attributes: {
        "url.full": "/registration-request",
        "http.request.method": "GET",
        "http.response.status_code": 204,
        "server.address": location.hostname,
      },
    });
    expect(fetchRequest).toHaveBeenCalledTimes(2);

    await handle.shutdown();
    handles.delete(handle);
    const logCount = onLog.mock.calls.length;
    const spanCount = onSpan.mock.calls.length;
    history.pushState(null, "", "/after-shutdown");
    await fetch(new URL("/after-shutdown", location.origin));
    expect(onLog).toHaveBeenCalledTimes(logCount);
    expect(onSpan).toHaveBeenCalledTimes(spanCount);
    await handle.shutdown();
    expect(navigationDisable).toHaveBeenCalledOnce();
    expect(httpDisable).toHaveBeenCalledOnce();
  });

  it(`rebinds an already-enabled navigation logger created before initialization through ${file}`, async () => {
    const distro = await loadDistro();
    const pipeline = createInMemoryPipeline();
    const navigation = new NavigationInstrumentation();
    const enable = vi.spyOn(navigation, "enable");
    const handle = distro.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      instrumentations: [navigation],
    });
    handles.add(handle);
    history.pushState(null, "", "/rebound");
    await pipeline.logProcessor.forceFlush();
    expect(pipeline.logExporter.getFinishedLogRecords()).toEqual([
      expect.objectContaining({
        eventName: "browser.navigation",
        attributes: expect.objectContaining({ "url.full": `${location.origin}/rebound` }),
      }),
    ]);
    expect(enable).not.toHaveBeenCalled();
  });

  it(`leaves browser APIs untouched when no instrumentations are supplied through ${file}`, async () => {
    const distro = await loadDistro();
    const pipeline = createInMemoryPipeline();
    const fetchBefore = globalThis.fetch;
    const pushBefore = history.pushState;
    const handle = distro.useMicrosoftOpenTelemetry(pipeline.options);
    handles.add(handle);
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(history.pushState).toBe(pushBefore);
    history.pushState(null, "", "/unobserved");
    await pipeline.logProcessor.forceFlush();
    expect(pipeline.logExporter.getFinishedLogRecords()).toEqual([]);
  });
}
