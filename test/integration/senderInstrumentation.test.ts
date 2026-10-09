// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { isTracingSuppressed } from "@opentelemetry/core";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../src/index.js";
import { Sender } from "../../src/exporter/sender.js";
import type { AzureMonitorEnvelope } from "../../src/exporter/telemetryModels.js";
import type { MicrosoftOpenTelemetryBrowser } from "../../src/types.js";
import { TEST_INSTRUMENTATION_KEY } from "../fixtures/azureMonitor.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

const ENDPOINT = "https://ingestion.example.test/v2/track";
const REQUEST = {
  body: new TextEncoder().encode("telemetry"),
  contentType: "application/json",
};
let handle: MicrosoftOpenTelemetryBrowser | undefined;
let instrumentation: FetchInstrumentation | undefined;

afterEach(async () => {
  try {
    instrumentation?.disable();
    await handle?.shutdown();
  } finally {
    handle = undefined;
    instrumentation = undefined;
    vi.unstubAllGlobals();
    trace.disable();
    logs.disable();
    propagation.disable();
    context.disable();
    diag.disable();
  }
});

describe.each(["index.js", "index.min.js"])("export instrumentation through %s", (file) => {
  it.each([false, true])(
    "sends one application span without feedback over real HTTP with page views enabled: %s",
    async (pageViewsEnabled) => {
      const path = `../../dist/esm/${file}`;
      const url = new URL(path, import.meta.url);
      const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const transport = vi.fn(nativeFetch);
      vi.stubGlobal("fetch", transport);
      instrumentation = new FetchInstrumentation({ enabled: false });
      const runId = crypto.randomUUID();
      const ingestionEndpoint = `${inject("ingestionEndpoint")}${runId}`;
      const pipeline = createInMemoryPipeline();
      let pageReady!: () => void;
      const pageEmitted = new Promise<void>((resolve) => {
        pageReady = resolve;
      });
      handle = await distro.useMicrosoftOpenTelemetry({
        ...pipeline.options,
        azureMonitor: {
          connectionString:
            `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};` +
            `IngestionEndpoint=${ingestionEndpoint}`,
        },
        instrumentations: [instrumentation],
        pageView: pageViewsEnabled
          ? { applyCustomLogRecordData: () => pageReady() }
          : { enabled: false },
      });
      if (pageViewsEnabled) await pageEmitted;
      trace.getTracer("sender-test").startSpan("application").end();

      for (let round = 0; round < 4; round++) {
        await handle.forceFlush();
        // Real fetch instrumentation also waits for a cloned response body to finish.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await pipeline.forceFlush();

      expect(transport).toHaveBeenCalledTimes(pageViewsEnabled ? 2 : 1);
      expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
        "application",
      ]);
      const captured: AzureMonitorEnvelope[] = await nativeFetch(
        `${new URL(ingestionEndpoint).origin}/captured?runId=${runId}`,
      ).then((response) => response.json());
      expect(captured).toHaveLength(pageViewsEnabled ? 3 : 1);
      expect(
        captured.filter((envelope) => envelope.data.baseType === "RemoteDependencyData"),
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            baseData: expect.objectContaining({ name: "application" }),
          }),
        }),
      ]);
      if (pageViewsEnabled) {
        expect(
          captured.filter((envelope) => envelope.data.baseType === "PageViewData"),
        ).toHaveLength(1);
        expect(
          captured.filter((envelope) => envelope.data.baseType === "PageviewPerformanceData"),
        ).toHaveLength(1);
      }
    },
  );

  it.each([false, true])(
    "does not export its own requests when fetch was already enabled: %s",
    async (alreadyEnabled) => {
      const path = `../../dist/esm/${file}`;
      const url = new URL(path, import.meta.url);
      const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
      const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null));
      vi.stubGlobal("fetch", transport);
      instrumentation = new FetchInstrumentation({
        enabled: alreadyEnabled,
        propagateTraceHeaderCorsUrls: [ENDPOINT],
      });
      const pipeline = createInMemoryPipeline();
      if (alreadyEnabled) {
        await expect(
          distro.useMicrosoftOpenTelemetry({
            ...pipeline.options,
            instrumentations: [instrumentation],
            pageView: { enabled: false },
          }),
        ).rejects.toThrow("browser-instrumentation-active");
        return;
      }
      handle = await distro.useMicrosoftOpenTelemetry({
        ...pipeline.options,
        azureMonitor: {
          connectionString:
            `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};` +
            "IngestionEndpoint=https://ingestion.example.test",
        },
        instrumentations: [instrumentation],
        pageView: { enabled: false },
      });
      trace.getTracer("sender-test").startSpan("application").end();
      logs.getLogger("sender-test").emit({ body: "application log" });

      // Repeated flushes would export spans created by the previous export request.
      for (let round = 0; round < 3; round++) await handle.forceFlush();
      await pipeline.forceFlush();

      expect(transport).toHaveBeenCalledTimes(2);
      expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
        "application",
      ]);
      expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
        "application log",
      ]);
      for (const [, init] of transport.mock.calls) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).has("traceparent")).toBe(false);
      }

      // Excluding the ingestion URL globally would also hide this application request.
      await fetch(ENDPOINT);
      await handle.forceFlush();
      await handle.forceFlush();
      await pipeline.forceFlush();
      expect(transport).toHaveBeenCalledTimes(4);
      expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
        "application",
        "GET",
      ]);
      expect(new Headers(transport.mock.calls[2][1]?.headers).has("traceparent")).toBe(true);
      expect(isTracingSuppressed(context.active())).toBe(false);
    },
  );
});

async function startInstrumentedPipeline() {
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null));
  vi.stubGlobal("fetch", transport);
  instrumentation = new FetchInstrumentation({ enabled: false });
  const pipeline = createInMemoryPipeline();
  handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    instrumentations: [instrumentation],
    pageView: { enabled: false },
  });
  return { pipeline, transport };
}

it.each([
  { name: "compressed", unloading: false, compression: true },
  { name: "uncompressed", unloading: false, compression: false },
  { name: "keepalive", unloading: true, compression: true },
])("suppresses $name sends without suppressing application context", async (options) => {
  const { pipeline, transport } = await startInstrumentedPipeline();
  if (!options.compression) vi.stubGlobal("CompressionStream", undefined);
  const sender = new Sender({ endpoint: ENDPOINT, fetch: globalThis.fetch });
  const parent = trace.getTracer("sender-test").startSpan("parent");
  const parentContext = trace.setSpan(context.active(), parent);
  const sending = context.with(parentContext, () => {
    const result = sender.send({ ...REQUEST, unloading: options.unloading });
    expect(context.active()).toBe(parentContext);
    expect(isTracingSuppressed(context.active())).toBe(false);
    return result;
  });

  await sending;
  parent.end();
  await pipeline.forceFlush();
  expect(transport).toHaveBeenCalledOnce();
  const headers = new Headers(transport.mock.calls[0][1]?.headers);
  expect(headers.get("content-encoding")).toBe(
    options.compression && !options.unloading ? "gzip" : null,
  );
  expect(transport.mock.calls[0][1]?.keepalive).toBe(options.unloading);
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(["parent"]);
  expect(isTracingSuppressed(context.active())).toBe(false);
});

it("suppresses every retry after transport errors and redirects", async () => {
  const { pipeline, transport } = await startInstrumentedPipeline();
  const redirectedEndpoint = "https://ingestion.example.test/redirected";
  const redirectedResponse = new Response(null, { status: 503 });
  Object.defineProperties(redirectedResponse, {
    redirected: { value: true },
    url: { value: redirectedEndpoint },
  });
  transport
    .mockRejectedValueOnce(new TypeError("Network failure"))
    .mockResolvedValueOnce(redirectedResponse);
  const delay = vi.fn(async () => {});
  const sender = new Sender({ endpoint: ENDPOINT, delay, random: () => 0 });

  await expect(sender.send(REQUEST)).resolves.toMatchObject({ statusCode: 200 });
  await pipeline.forceFlush();
  expect(transport.mock.calls.map(([url]) => url)).toEqual([
    ENDPOINT,
    ENDPOINT,
    redirectedEndpoint,
  ]);
  expect(delay).toHaveBeenCalledTimes(2);
  expect(pipeline.spanExporter.getFinishedSpans()).toEqual([]);
  expect(isTracingSuppressed(context.active())).toBe(false);
});

it.each([false, true])(
  "preserves fetch failures and restores context when the failure is synchronous: %s",
  async (synchronous) => {
    const { pipeline, transport } = await startInstrumentedPipeline();
    const failure = new Error("Transport failed");
    const suppressed: boolean[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      suppressed.push(isTracingSuppressed(context.active()));
      if (synchronous) throw failure;
      return Promise.reject(failure);
    });
    const sender = new Sender({ endpoint: ENDPOINT, fetch });

    await expect(sender.send(REQUEST)).rejects.toBe(failure);
    expect(suppressed).toEqual([true]);
    expect(isTracingSuppressed(context.active())).toBe(false);
    await globalThis.fetch(ENDPOINT);
    await pipeline.forceFlush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(["GET"]);
  },
);
