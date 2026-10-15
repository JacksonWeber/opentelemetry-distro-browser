// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { afterEach, expect, inject, it, vi } from "vitest";
import type { MicrosoftOpenTelemetryBrowser } from "../../src/types.js";
import type { AzureMonitorEnvelope } from "../../src/exporter/telemetryModels.js";
import { assertAzureMonitorEnvelope, TEST_INSTRUMENTATION_KEY } from "../fixtures/azureMonitor.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";
import { SDK_STATS_ENDPOINT } from "../fixtures/sdkStats.js";

const SECOND_KEY = "22222222-2222-2222-2222-222222222222";
const handles: MicrosoftOpenTelemetryBrowser[] = [];
let referrerPolicy: HTMLMetaElement | undefined;

afterEach(async () => {
  try {
    await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  } finally {
    trace.disable();
    logs.disable();
    context.disable();
    propagation.disable();
    diag.disable();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    referrerPolicy?.remove();
    referrerPolicy = undefined;
  }
});

it.each([
  { file: "index.js", eu: false },
  { file: "index.min.js", eu: false },
  { file: "index.js", eu: true },
  { file: "index.min.js", eu: true },
])(
  "targets production ingestion without configuration lookup through $file with EU state $eu",
  async ({ file, eu }) => {
    referrerPolicy = document.createElement("meta");
    referrerPolicy.name = "referrer";
    referrerPolicy.content = "unsafe-url";
    document.head.append(referrerPolicy);
    const modulePath = `../../dist/esm/${file}`;
    const moduleUrl = new URL(modulePath, import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(
      /* @vite-ignore */ moduleUrl.href
    );
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const origin = new URL(inject("ingestionEndpoint")).origin;
    const runId = crypto.randomUUID();
    const statsKey = "c4a29126-a7cb-47e5-b348-11414998b11e";
    const customerOrigin = eu ? "https://westeurope-5.in.applicationinsights.azure.com" : origin;
    const transport = vi.fn<typeof fetch>((url, init) => {
      if (url === SDK_STATS_ENDPOINT)
        return nativeFetch(`${origin}/ingest/${runId}-stats/v2/track`, init);
      const localUrl =
        eu && typeof url === "string" && url.startsWith(customerOrigin)
          ? url.replace(customerOrigin, origin)
          : url;
      return nativeFetch(localUrl, init);
    });
    vi.stubGlobal("fetch", transport);
    const instrumentation = new FetchInstrumentation({ enabled: false });
    const pipeline = createInMemoryPipeline();
    const start = async (id: string, key: string, instrumented: boolean) => {
      const handle = await distro.useMicrosoftOpenTelemetry({
        ...(instrumented ? pipeline.options : {}),
        azureMonitor: {
          connectionString: `InstrumentationKey=${key};IngestionEndpoint=${customerOrigin}/ingest/${id}`,
        },
        pageView: { enabled: false },
        instrumentations: instrumented ? [instrumentation] : [],
      });
      handles.push(handle);
      return handle;
    };
    const first = await start(runId, TEST_INSTRUMENTATION_KEY, true);
    const second = await start(`${runId}-second`, SECOND_KEY, false);
    first.userContext.setAuthenticatedUserContext("private-user", "private-account");
    trace.getTracer("stats-test").startSpan("first application span").end();
    logs.getLogger("stats-test").emit({ body: "first application log" });
    await first.forceFlush();
    await pipeline.forceFlush();

    expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "first application span",
    ]);
    expect(pipeline.logExporter.getFinishedLogRecords().map((log) => log.body)).toEqual([
      "first application log",
    ]);
    await first.shutdown();
    trace.getTracer("stats-test").startSpan("second application span").end();
    logs.getLogger("stats-test").emit({ body: "second application log" });
    await second.shutdown();
    expect(transport.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
    const statsCalls = transport.mock.calls.filter(([url]) => url === SDK_STATS_ENDPOINT);
    expect(statsCalls).toHaveLength(eu ? 0 : 4);
    for (const [, init] of statsCalls) {
      expect(new Headers(init?.headers).has("traceparent")).toBe(false);
      expect(init?.credentials).toBe("omit");
      expect(init?.referrerPolicy).toBe("no-referrer");
    }
    const referrers: string[] = await nativeFetch(
      `${origin}/captured-referrers?runId=${runId}-stats`,
    ).then((response) => response.json());
    expect(referrers).toEqual(Array.from({ length: eu ? 0 : 4 }, () => ""));
    const customerReferrers: string[] = await nativeFetch(
      `${origin}/captured-referrers?runId=${runId}`,
    ).then((response) => response.json());
    expect(customerReferrers).toHaveLength(2);
    expect(customerReferrers.every((referrer) => referrer.startsWith(location.origin))).toBe(true);
    for (const [id, key] of [
      [runId, TEST_INSTRUMENTATION_KEY],
      [`${runId}-second`, SECOND_KEY],
    ]) {
      const read = async (captureId: string): Promise<AzureMonitorEnvelope[]> =>
        nativeFetch(`${origin}/captured?runId=${captureId}`).then((response) => response.json());
      const customer = await read(id);
      const stats = (await read(`${runId}-stats`)).filter(
        (envelope) => envelope.data.baseData.properties?.cikey === key,
      );
      expect(customer).toHaveLength(2);
      expect(
        customer.every(
          (envelope) => envelope.iKey === key && envelope.data.baseType !== "MetricData",
        ),
      ).toBe(true);
      const successes = stats.filter(
        (envelope) =>
          envelope.data.baseType === "MetricData" &&
          "metrics" in envelope.data.baseData &&
          envelope.data.baseData.metrics[0].name === "Request_Success_Count",
      );
      expect(successes).toHaveLength(eu ? 0 : 2);
      if (eu) expect(stats).toHaveLength(0);
      for (const envelope of stats) {
        assertAzureMonitorEnvelope(envelope);
        expect(envelope.iKey).toBe(statsKey);
        expect(envelope.data.baseData.properties).toMatchObject({
          cikey: key,
          host: new URL(customerOrigin).hostname.split(".")[0],
          os: "Browser",
          language: "JavaScript",
        });
        expect(Object.keys(envelope.tags)).toEqual(["ai.internal.sdkVersion"]);
        expect(envelope.tags["ai.internal.sdkVersion"]).toBe(
          customer[0].tags["ai.internal.sdkVersion"],
        );
      }
      expect(JSON.stringify(stats)).not.toMatch(
        /private-user|private-account|application span|application log|ai\.operation|ai\.session/,
      );
    }
  },
);
