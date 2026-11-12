// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ResourceTimingInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/resource-timing";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type ReadWriteLogRecord,
} from "@opentelemetry/sdk-logs";
import { afterEach, expect, inject, it, vi } from "vitest";
import type { BrowserInstrumentation, MicrosoftOpenTelemetryBrowser } from "../../src/types.js";
import type { AzureMonitorEnvelope } from "../../src/exporter/telemetryModels.js";
import { assertAzureMonitorEnvelope, TEST_INSTRUMENTATION_KEY } from "../fixtures/azureMonitor.js";
import {
  createConsolePipeline,
  createInMemoryPipeline,
  createReadableLogRecord,
} from "../fixtures/telemetry.js";
import { AzureMonitorSpanExporter } from "../../src/exporter/trace.js";
import { Sender } from "../../src/exporter/sender.js";
import { rememberSdkIngestionUrl } from "../../src/shared/globalOwnership.js";
import { SDK_STATS_ENDPOINT, withoutSdkStats } from "../fixtures/sdkStats.js";
import { loadBrowserScript } from "../fixtures/browserBundle.js";

const SECOND_KEY = "22222222-2222-2222-2222-222222222222";
const handles: Pick<MicrosoftOpenTelemetryBrowser, "shutdown">[] = [];
let referrerPolicy: HTMLMetaElement | undefined;

it.each(["index.js", "index.min.js"])(
  "shares unload reservations with the separately bundled %s",
  async (file) => {
    const modulePath = `../../dist/esm/${file}`;
    const moduleUrl = new URL(modulePath, import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(
      /* @vite-ignore */ moduleUrl.href
    );
    let release!: () => void;
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    transport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Response(null));
        }),
    );
    vi.stubGlobal("fetch", transport);
    const sender = new Sender({
      endpoint: "https://customer.example.test/v2/track",
      disableBeacon: true,
    });
    const request = { contentType: "application/json", unloading: true };
    const pending = sender.send({ ...request, body: new Uint8Array(60 * 1024) });
    let handle: MicrosoftOpenTelemetryBrowser | undefined;
    try {
      handle = await distro.useMicrosoftOpenTelemetry({
        azureMonitor: {
          connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=https://customer.example.test`,
          sdkStats: { enabled: true },
          disableBeacon: true,
        },
        pageView: { enabled: false },
        session: { enabled: false },
        storage: { enabled: false },
      });
      trace.getTracer("cross-copy-quota").startSpan("application").end();
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      await handle.forceFlush();
      const reports = transport.mock.calls
        .slice(1)
        .filter(([, init]) => init?.credentials === "omit");
      expect(reports.length).toBeGreaterThan(0);
      expect(reports.every(([, init]) => init?.keepalive === false)).toBe(true);
      expect(transport.mock.calls.slice(1).every(([, init]) => init?.credentials === "omit")).toBe(
        true,
      );
    } finally {
      release();
      await pending;
      sender.dispose();
      await handle?.shutdown();
    }
  },
);

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

it.each(
  ["index.js", "index.min.js"].flatMap((file) => [false, true].map((active) => ({ file, active }))),
)(
  "shares ingestion URL protection with $file despite an incompatible registry (active: $active)",
  async ({ file, active }) => {
    const modulePath = `../../dist/esm/${file}`;
    const moduleUrl = new URL(modulePath, import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(
      /* @vite-ignore */ moduleUrl.href
    );
    const key = Symbol.for("@microsoft/opentelemetry-browser");
    const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const previous = Object.getOwnPropertyDescriptor(realm, key);
    const incompatible = { version: 2 };
    realm[key] = incompatible;
    const transport = vi.fn<typeof fetch>(async () => new Response(null));
    vi.stubGlobal("fetch", transport);
    let exporter: InstanceType<typeof distro.AzureMonitorLogRecordExporter> | undefined;
    let peer: AzureMonitorSpanExporter | undefined;
    try {
      const peerEndpoint = "https://cross-copy-sdk.example.test";
      peer = new AzureMonitorSpanExporter({
        connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${peerEndpoint}`,
      });
      if (active) {
        for (let index = 0; index < 300; index++)
          rememberSdkIngestionUrl(`https://cross-copy-churn.example.test/track?request=${index}`);
      } else {
        await peer.shutdown();
      }
      exporter = new distro.AzureMonitorLogRecordExporter({
        connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=https://customer.example.test`,
        sdkStats: { enabled: true },
      });
      const timing = (url: string) =>
        createReadableLogRecord({
          eventName: "browser.resource_timing",
          instrumentationScope: {
            name: "@opentelemetry/browser-instrumentation/resource-timing",
          },
          attributes: { "url.full": url },
        });
      const callback = vi.fn<(result: ExportResult) => void>();
      exporter.export(
        [timing(`${peerEndpoint}/v2/track`), timing(`${peerEndpoint}/v2/track?application=true`)],
        callback,
      );
      await vi.waitFor(() =>
        expect(callback).toHaveBeenCalledExactlyOnceWith({ code: ExportResultCode.SUCCESS }),
      );
      const [url, init] = transport.mock.calls[0];
      const envelopes: AzureMonitorEnvelope[] = await new Request(url, init).json();
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0].data.baseData.properties?.["url.full"]).toBe(
        `${peerEndpoint}/v2/track?application=true`,
      );
      expect(realm[key]).toBe(incompatible);
    } finally {
      await exporter?.shutdown();
      await peer?.shutdown();
      if (previous) Object.defineProperty(realm, key, previous);
      else delete realm[key];
    }
  },
);

it.each(
  (["index.js", "index.min.js", "iife.min"] as const).flatMap((file) =>
    [false, true].flatMap((restartDuringReport) =>
      [false, true].map((outerStandalone) => ({ file, restartDuringReport, outerStandalone })),
    ),
  ),
)(
  "keeps stats diagnostics out of console pipelines through $file with in-callback restart $restartDuringReport and outer standalone $outerStandalone",
  async ({ file, restartDuringReport, outerStandalone }) => {
    context.disable();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = vi.fn<typeof fetch>(
      async (url) => new Response(null, { status: url === SDK_STATS_ENDPOINT ? 503 : 200 }),
    );
    vi.stubGlobal("fetch", transport);
    const { exporter, provider, instrumentation: standalone } = createConsolePipeline();
    const standaloneWarn = console.warn;
    const scripts: HTMLScriptElement[] = [];
    let handle: MicrosoftOpenTelemetryBrowser | undefined;
    let outer: ReturnType<typeof createConsolePipeline> | undefined;
    try {
      let initialize: typeof import("../../src/index.js").useMicrosoftOpenTelemetry;
      let diagnostics = diag;
      let instrumentations: BrowserInstrumentation[];
      if (file === "iife.min") {
        scripts.push(await loadBrowserScript("opentelemetry-browser.iife.min.js"));
        scripts.push(await loadBrowserScript("opentelemetry-browser-instrumentations.iife.min.js"));
        const bundle = window.Microsoft?.OpenTelemetry;
        const instrumentationBundle = window.Microsoft?.OpenTelemetryInstrumentations;
        if (!bundle || !instrumentationBundle) throw new Error("Minified bundles did not load");
        initialize = bundle.useMicrosoftOpenTelemetry;
        diagnostics = bundle.diag;
        instrumentations = await instrumentationBundle.getInstrumentations({
          fetch: { enabled: false },
          xhr: { enabled: false },
          console: { enabled: true, logMethods: ["warn"] },
        });
      } else {
        const modulePath = `../../dist/esm/${file}`;
        const moduleUrl = new URL(modulePath, import.meta.url);
        const distro: typeof import("../../src/index.js") = await import(
          /* @vite-ignore */ moduleUrl.href
        );
        initialize = distro.useMicrosoftOpenTelemetry;
        instrumentations = [new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] })];
      }
      const pipeline = createInMemoryPipeline();
      handle = await initialize({
        azureMonitor: {
          connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=https://customer.example.test`,
        },
        spanProcessors: [],
        logRecordProcessors: pipeline.options.logRecordProcessors,
        pageView: { enabled: false },
        session: { enabled: false },
        storage: { enabled: false },
        instrumentations,
      });
      handles.push(handle);
      if (outerStandalone) outer = createConsolePipeline();
      const standaloneTop = outer ? console.warn : standaloneWarn;
      let sharedWarn = console.warn;
      expect(sharedWarn).not.toBe(standaloneWarn);
      vi.spyOn(diagnostics, "warn")
        .mockImplementation((...args) => console.warn(...args))
        .mockImplementationOnce((...args) => {
          console.warn(...args);
          for (const instrumentation of instrumentations) instrumentation.disable();
          if (restartDuringReport) {
            for (const instrumentation of instrumentations) instrumentation.enable();
          }
        });
      for (let index = 1; index <= 2; index++) {
        console.warn("application warning");
        await handle.forceFlush();
        await provider.forceFlush();
        await outer?.provider.forceFlush();
        expect(transport).toHaveBeenCalledTimes(index * 2);
        expect(diagnostics.warn).toHaveBeenCalledTimes(index);
        expect(exporter.getFinishedLogRecords().map((record) => record.body)).toEqual(
          Array<string>(index).fill("application warning"),
        );
        if (outer) {
          expect(outer.exporter.getFinishedLogRecords().map((record) => record.body)).toEqual(
            Array<string>(index).fill("application warning"),
          );
        }
        expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual(
          Array<string>(index).fill("application warning"),
        );
        if (index === 1) {
          if (!restartDuringReport) {
            expect(console.warn).toBe(standaloneTop);
            for (const instrumentation of instrumentations) instrumentation.enable();
          }
          expect(console.warn).not.toBe(sharedWarn);
          sharedWarn = console.warn;
        } else {
          expect(console.warn).toBe(sharedWarn);
        }
      }
      await handle.shutdown();
      expect(console.warn).toBe(standaloneTop);
      console.warn("standalone after shutdown");
      await provider.forceFlush();
      await outer?.provider.forceFlush();
      expect(exporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
        "application warning",
        "application warning",
        "standalone after shutdown",
      ]);
      if (outer) {
        expect(outer.exporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
          "application warning",
          "application warning",
          "standalone after shutdown",
        ]);
      }
    } finally {
      await handle?.shutdown();
      outer?.instrumentation.disable();
      await outer?.provider.shutdown();
      standalone.disable();
      await provider.shutdown();
      for (const script of scripts) script.remove();
      if (file === "iife.min") delete window.Microsoft;
    }
  },
);

it.each(
  ["index.js", "index.min.js"].flatMap((file) =>
    [false, true].flatMap((eu) =>
      [false, true].map((customerStats) => ({ file, eu, customerStats })),
    ),
  ),
)(
  "isolates internal and customer stats through $file with EU $eu and customer stats $customerStats",
  async ({ file, eu, customerStats }) => {
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
          sdkStats: { enabled: customerStats },
        },
        resource: resourceFromAttributes({
          "service.name": `application-${key}`,
          "service.instance.id": id,
        }),
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
    expect(customerReferrers).toHaveLength(customerStats ? 4 : 2);
    expect(
      customerReferrers.filter((referrer) => referrer.startsWith(location.origin)),
    ).toHaveLength(2);
    expect(customerReferrers.filter((referrer) => referrer === "")).toHaveLength(
      customerStats ? 2 : 0,
    );
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
      expect(customer).toHaveLength(customerStats ? 4 : 2);
      expect(customer.every((envelope) => envelope.iKey === key)).toBe(true);
      const itemStats = customer.filter((envelope) => envelope.data.baseType === "MetricData");
      expect(itemStats).toHaveLength(customerStats ? 2 : 0);
      for (const envelope of itemStats) {
        assertAzureMonitorEnvelope(envelope);
        expect(envelope.data.baseData).toMatchObject({
          metrics: [{ name: "Item_Success_Count", value: 1 }],
        });
        expect(envelope.tags).toEqual({
          "ai.internal.sdkVersion": expect.any(String),
          "ai.cloud.role": `application-${key}`,
          "ai.cloud.roleInstance": id,
        });
      }
      expect(JSON.stringify(itemStats)).not.toMatch(
        /private-user|private-account|application span|application log|ai\.operation|ai\.session/,
      );
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

it("excludes real ingestion resource timing without filtering custom processor branches", async () => {
  const moduleUrl = new URL("../../dist/esm/index.js", import.meta.url);
  const distro: typeof import("../../src/index.js") = await import(
    /* @vite-ignore */ moduleUrl.href
  );
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const transport = vi.fn(nativeFetch);
  vi.stubGlobal("fetch", withoutSdkStats(transport));
  const runId = crypto.randomUUID();
  const origin = new URL(inject("ingestionEndpoint")).origin;
  const destination = `${origin}/ingest/${runId}`;
  const observed: ReadWriteLogRecord[] = [];
  const handle = await distro.useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${destination}`,
      sdkStats: { enabled: true },
    },
    spanProcessors: [],
    logRecordProcessors: [
      {
        onEmit: (record) => observed.push(record),
        forceFlush: async () => {},
        shutdown: async () => {},
      },
    ],
    pageView: { enabled: false },
    storage: { enabled: false },
    session: { enabled: false },
    instrumentations: [
      new ResourceTimingInstrumentation({
        enabled: false,
        initiatorTypes: ["fetch"],
        ignoreUrls: [new RegExp(`^(?!.*\\/ingest\\/${runId}).*$`)],
        forceProcessingAfter: 0,
      }),
    ],
  });
  handles.push(handle);
  logs.getLogger("app").emit({ body: "application" });
  await handle.forceFlush();
  await vi.waitFor(() =>
    expect(observed.some((record) => record.eventName === "browser.resource_timing")).toBe(true),
  );
  for (let index = 0; index < 3; index++) {
    await handle.forceFlush();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await handle.shutdown();
  expect(transport).toHaveBeenCalledTimes(2);
  const captured: AzureMonitorEnvelope[] = await nativeFetch(
    `${origin}/captured?runId=${runId}`,
  ).then((response) => response.json());
  expect(captured).toHaveLength(2);
  expect(captured.filter((envelope) => envelope.data.baseType === "MetricData")).toHaveLength(1);
});

it.each([0, 100])(
  "excludes peer ingestion across two custom origins at %s percent sampling",
  async (samplingPercentage) => {
    const moduleUrl = new URL("../../dist/esm/index.js", import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(
      /* @vite-ignore */ moduleUrl.href
    );
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const transport = vi.fn(nativeFetch);
    vi.stubGlobal("fetch", withoutSdkStats(transport));
    const runId = crypto.randomUUID();
    const firstOrigin = new URL(inject("ingestionEndpoint")).origin;
    const secondOrigin = firstOrigin.replace("127.0.0.1", "localhost");
    const start = async (origin: string, key: string) => {
      const instrumentation = new ResourceTimingInstrumentation({
        enabled: false,
        initiatorTypes: ["fetch"],
        ignoreUrls: [new RegExp(`^(?!.*\\/ingest\\/${runId}).*$`)],
        forceProcessingAfter: 0,
      });
      const bind = vi.spyOn(instrumentation, "setLoggerProvider");
      const observed: ReadWriteLogRecord[] = [];
      const handle = await distro.useMicrosoftOpenTelemetry({
        azureMonitor: {
          connectionString: `InstrumentationKey=${key};IngestionEndpoint=${origin}/ingest/${runId}`,
          sdkStats: { enabled: true, collectionIntervalMillis: 50 },
        },
        samplingPercentage,
        spanProcessors: [],
        logRecordProcessors: [
          {
            onEmit: (record) => observed.push(record),
            forceFlush: async () => {},
            shutdown: async () => {},
          },
        ],
        pageView: { enabled: false },
        storage: { enabled: false },
        session: { enabled: false },
        instrumentations: [instrumentation],
      });
      handles.push(handle);
      return { handle, observed, logger: bind.mock.calls[0][0].getLogger("app") };
    };
    const first = await start(firstOrigin, TEST_INSTRUMENTATION_KEY);
    const second = await start(secondOrigin, SECOND_KEY);
    first.logger.emit({ body: "first application log" });
    second.logger.emit({ body: "second application log" });
    await Promise.all([first.handle.forceFlush(), second.handle.forceFlush()]);
    if (samplingPercentage === 0) {
      // Sampling sends nothing. Seed real peer timings without sending application records.
      await Promise.all(
        [firstOrigin, secondOrigin].map((origin) =>
          nativeFetch(`${origin}/ingest/${runId}/v2/track`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "[]",
          }),
        ),
      );
    }
    for (const { observed } of [first, second]) {
      await vi.waitFor(() => {
        const urls = observed
          .filter((record) => record.eventName === "browser.resource_timing")
          .map((record) => record.attributes["url.full"]);
        expect(urls).toContain(`${firstOrigin}/ingest/${runId}/v2/track`);
        expect(urls).toContain(`${secondOrigin}/ingest/${runId}/v2/track`);
      });
    }
    for (let index = 0; index < 3; index++) {
      await Promise.all([first.handle.forceFlush(), second.handle.forceFlush()]);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await Promise.all([first.handle.shutdown(), second.handle.shutdown()]);
    expect(transport).toHaveBeenCalledTimes(samplingPercentage === 0 ? 0 : 4);
    const captured: AzureMonitorEnvelope[] = await nativeFetch(
      `${firstOrigin}/captured?runId=${runId}`,
    ).then((response) => response.json());
    expect(captured).toHaveLength(samplingPercentage === 0 ? 0 : 4);
    const stats = captured.filter((envelope) => envelope.data.baseType === "MetricData");
    expect(stats).toHaveLength(samplingPercentage === 0 ? 0 : 2);
    for (const envelope of stats) {
      expect(envelope.data.baseData).toMatchObject({
        metrics: [
          {
            name: "Item_Success_Count",
            value: 1,
          },
        ],
        properties: {
          telemetryType: "TRACE",
        },
      });
    }
  },
);

it.each(["index.js", "index.min.js"])(
  "keeps standalone stats warnings out of console telemetry through %s",
  async (file) => {
    const modulePath = `../../dist/esm/${file}`;
    const moduleUrl = new URL(modulePath, import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(
      /* @vite-ignore */ moduleUrl.href
    );
    context.disable();
    const application: AzureMonitorEnvelope[] = [];
    const reports: AzureMonitorEnvelope[][] = [];
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      const envelopes: AzureMonitorEnvelope[] = JSON.parse(await new Request(url, init).text());
      const stats = envelopes.every((envelope) => envelope.data.baseType === "MetricData");
      if (stats) reports.push(envelopes);
      else application.push(...envelopes);
      return new Response(null, { status: stats ? 503 : 200 });
    });
    vi.stubGlobal("fetch", withoutSdkStats(transport));
    const exporter = new distro.AzureMonitorLogRecordExporter({
      connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=https://customer.example.test`,
      sdkStats: { enabled: true },
    });
    const provider = new LoggerProvider({
      processors: [new BatchLogRecordProcessor({ exporter })],
    });
    handles.push(provider);
    const instrumentation = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
    instrumentation.setLoggerProvider(provider);
    instrumentation.enable();
    vi.spyOn(diag, "warn").mockImplementation((...args) => console.warn(...args));
    try {
      const wrappedWarn = console.warn;
      for (let index = 1; index <= 2; index++) {
        console.warn("application warning");
        await provider.forceFlush();
        await exporter.forceFlush();
        await provider.forceFlush();
        await exporter.forceFlush();
        expect(application).toHaveLength(index);
        expect(
          application.every(
            (envelope) =>
              envelope.data.baseType === "MessageData" &&
              "message" in envelope.data.baseData &&
              envelope.data.baseData.message === "application warning",
          ),
        ).toBe(true);
        expect(reports.at(-1)).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              baseData: expect.objectContaining({
                metrics: [{ name: "Item_Success_Count", kind: 0, value: index }],
              }),
            }),
          }),
        ]);
        expect(diag.warn).toHaveBeenCalledTimes(reports.length);
        expect(console.warn).toBe(wrappedWarn);
      }
    } finally {
      instrumentation.disable();
    }
  },
);
