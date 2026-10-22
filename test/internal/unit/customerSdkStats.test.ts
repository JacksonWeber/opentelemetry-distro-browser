// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createCustomerSdkStats,
  type CustomerSdkStats,
  type AzureMonitorSdkStatsOptions,
} from "../../../src/exporter/customerSdkStats.js";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";
import { AzureMonitorSpanExporter } from "../../../src/exporter/trace.js";
import { Sender } from "../../../src/exporter/sender.js";
import { spanToEnvelopes } from "../../../src/exporter/spanUtils.js";
import { beginUnloading, endUnloading } from "../../../src/exporter/common.js";
import { MAX_SEND_ATTEMPTS } from "../../../src/exporter/constants.js";
import { AzureMonitorExportClient } from "../../../src/exporter/base.js";
import { createStatsSpanProcessor } from "../../../src/statsSpanProcessor.js";
import { BrowserBatchLogRecordProcessor } from "../../../src/browserBatchLogRecordProcessor.js";
import { logItemType } from "../../../src/exporter/logUtils.js";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
} from "../../../src/index.js";
import type { AzureMonitorEnvelope, MetricData } from "../../../src/exporter/telemetryModels.js";
import { createReadableLogRecord, createReadableSpan } from "../../fixtures/telemetry.js";
import {
  TEST_INSTRUMENTATION_KEY,
  assertAzureMonitorEnvelope,
} from "../../fixtures/azureMonitor.js";
import { installFakeClock } from "../../fixtures/clock.js";
import { reportFailure } from "../../../src/exporter/sdkStats.js";

const endpoint = "https://customer.example.test";
const connectionString = `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${endpoint}`;
const owners: Array<{ shutdown(): Promise<void> }> = [];
const finishers: Array<() => void> = [];
let reports: AzureMonitorEnvelope<MetricData>[][];
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

beforeEach(() => {
  reports = [];
  vi.stubGlobal("CompressionStream", undefined);
  fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const envelopes: AzureMonitorEnvelope[] = JSON.parse(await new Request(url, init).text());
    if (envelopes.every((envelope) => envelope.data.baseType === "MetricData")) {
      reports.push(envelopes as AzureMonitorEnvelope<MetricData>[]);
    }
    return new Response(null);
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(diag, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const finish of finishers.splice(0)) finish();
  await Promise.allSettled(owners.splice(0).map((owner) => owner.shutdown()));
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function create(options: AzureMonitorSdkStatsOptions = { enabled: true }): CustomerSdkStats {
  const stats = createCustomerSdkStats(options, TEST_INSTRUMENTATION_KEY, endpoint);
  if (!stats) throw new Error("Expected enabled stats");
  owners.push(stats);
  return stats;
}

function totals() {
  const totals: Record<string, number> = {};
  for (const {
    data: { baseData },
  } of reports.flat()) {
    const { name, value } = baseData.metrics[0];
    const props = baseData.properties!;
    const key = [name, props.telemetryType, props.dropCode ?? props.retryCode]
      .filter(Boolean)
      .join(":");
    totals[key] = (totals[key] ?? 0) + value;
  }
  return totals;
}

function request(kinds = [SpanKind.CLIENT]) {
  const envelopes = kinds.flatMap((kind) =>
    spanToEnvelopes(createReadableSpan({ kind }), TEST_INSTRUMENTATION_KEY),
  );
  return {
    envelopes,
    body: new TextEncoder().encode(JSON.stringify(envelopes)),
    contentType: "application/json",
  };
}

it.each([undefined, {}, { enabled: false }])(
  "allocates no reporter without explicit opt-in: %j",
  (options) => {
    expect(createCustomerSdkStats(options, TEST_INSTRUMENTATION_KEY, endpoint)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])(
  "rejects invalid interval %s even while disabled",
  (collectionIntervalMillis) => {
    expect(() =>
      createCustomerSdkStats({ collectionIntervalMillis }, TEST_INSTRUMENTATION_KEY, endpoint),
    ).toThrow(RangeError);
  },
);

it("reports customer metrics without identifiers, enrichment, application sampling or idle timers", async () => {
  const clock = installFakeClock();
  const stats = create();
  expect(vi.getTimerCount()).toBe(0);
  stats.count("Success", "DEPENDENCY", "", 4);
  stats.count("Dropped", "TRACE", "SAMPLING", 2);
  stats.count("Retry", "DEPENDENCY", "503", 3);
  await clock.advance(899_999);
  expect(fetch).not.toHaveBeenCalled();
  await clock.advance(1);
  await vi.waitFor(() => expect(reports).toHaveLength(1));
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 4,
    "Item_Dropped_Count:TRACE:SAMPLING": 2,
    "Item_Retry_Count:DEPENDENCY:503": 3,
  });
  for (const envelope of reports.flat()) {
    assertAzureMonitorEnvelope(envelope);
    expect(envelope.iKey).toBe(TEST_INSTRUMENTATION_KEY);
    expect(envelope.sampleRate).toBeUndefined();
    expect(Object.keys(envelope.tags)).toEqual(["ai.internal.sdkVersion"]);
  }
  expect(fetch.mock.calls[0]).toEqual([
    `${endpoint}/v2/track`,
    expect.objectContaining({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    }),
  ]);
  await clock.advance(900_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["HTTP", "network"] as const)(
  "does not recursively count or retry a failed %s report",
  async (failure) => {
    const stats = create();
    if (failure === "HTTP") fetch.mockResolvedValue(new Response(null, { status: 503 }));
    else fetch.mockRejectedValue(new TypeError("offline"));
    stats.count("Success", "TRACE");
    await stats.forceFlush();
    await stats.forceFlush();
    await stats.shutdown();
    expect(fetch).toHaveBeenCalledOnce();
    expect(diag.warn).toHaveBeenCalledWith("Customer SDK stats export failed", expect.any(Error));
  },
);

it("shares concurrent flushes, retains new counts and drains them after a pending export at shutdown", async () => {
  const stats = create();
  const normal = fetch.getMockImplementation()!;
  let complete!: () => void;
  fetch.mockImplementationOnce(
    (...args) =>
      new Promise((resolve) => {
        complete = () => resolve(normal(...args));
      }),
  );
  stats.count("Success", "TRACE");
  const first = stats.forceFlush();
  expect(stats.forceFlush()).toBe(first);
  stats.count("Success", "DEPENDENCY");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shutdown = stats.shutdown(pending);
  expect(stats.shutdown()).toBe(shutdown);
  stats.count("Dropped", "TRACE", "400");
  finish();
  complete();
  await shutdown;
  stats.count("Success", "REQUEST");
  await stats.forceFlush();
  expect(reports).toHaveLength(2);
  expect(totals()).toEqual({
    "Item_Success_Count:TRACE": 1,
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Dropped_Count:TRACE:400": 1,
  });
});

it("bounds a stalled report to ten seconds and aborts it", async () => {
  const clock = installFakeClock();
  fetch.mockImplementation(() => new Promise(() => {}));
  const stats = create();
  stats.count("Success", "TRACE");
  const shutdown = stats.shutdown();
  await clock.advance(10_000);
  await shutdown;
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("re-arms pending counters when an interval expires during a slow report", async () => {
  const clock = installFakeClock();
  const stats = create({ enabled: true, collectionIntervalMillis: 10 });
  const normal = fetch.getMockImplementation()!;
  let finish!: () => void;
  fetch.mockImplementationOnce(
    (...args) =>
      new Promise((resolve) => {
        finish = () => resolve(normal(...args));
      }),
  );
  stats.count("Success", "TRACE");
  await clock.advance(10);
  stats.count("Success", "DEPENDENCY");
  await clock.advance(20);
  finish();
  await clock.advance(20);
  expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1, "Item_Success_Count:DEPENDENCY": 1 });
  expect(vi.getTimerCount()).toBe(0);
});

it("reports unload size-limit drops only for the envelopes that did not fit", async () => {
  const client = new AzureMonitorExportClient({ connectionString, sdkStats: { enabled: true } });
  owners.push(client);
  const envelopes = request().envelopes;
  const large = {
    ...envelopes[0],
    data: {
      baseType: "MessageData" as const,
      baseData: { ver: 2 as const, message: "x".repeat(70_000) },
    },
  };
  beginUnloading();
  try {
    const result = await new Promise<ExportResult>((resolve) =>
      client.export([envelopes[0], large], resolve),
    );
    expect(result.code).toBe(ExportResultCode.FAILED);
    await client.forceFlush();
  } finally {
    endUnloading();
  }
  expect(totals()).toEqual({
    "Item_Dropped_Count:TRACE:PAYLOAD_TOO_LARGE": 1,
    "Item_Success_Count:DEPENDENCY": 1,
  });
});

it.each(["spans", "logs"] as const)(
  "reports conversion failures for %s without losing the callback",
  async (signal) => {
    const options = { connectionString, sdkStats: { enabled: true } };
    const exporter =
      signal === "spans"
        ? new AzureMonitorSpanExporter(options)
        : new AzureMonitorLogRecordExporter(options);
    owners.push(exporter);
    const failure = new Error("conversion failed");
    const callback = vi.fn();
    if (exporter instanceof AzureMonitorSpanExporter) {
      const span = createReadableSpan();
      Object.defineProperty(span, "startTime", {
        get: () => {
          throw failure;
        },
      });
      exporter.export([span], callback);
    } else {
      const log = createReadableLogRecord();
      Object.defineProperty(log, "hrTime", {
        get: () => {
          throw failure;
        },
      });
      exporter.export([log], callback);
    }
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      code: ExportResultCode.FAILED,
      error: failure,
    });
    await exporter.forceFlush();
    expect(totals()).toEqual({
      [`Item_Dropped_Count:${signal === "spans" ? "DEPENDENCY" : "TRACE"}:CLIENT_EXCEPTION`]: 1,
    });
  },
);

it.each(["spans", "logs"] as const)(
  "counts %s exporter delivery once and stays silent without more telemetry",
  async (signal) => {
    const options = { connectionString, sdkStats: { enabled: true } };
    const exporter =
      signal === "spans"
        ? new AzureMonitorSpanExporter(options)
        : new AzureMonitorLogRecordExporter(options);
    owners.push(exporter);
    const result = await new Promise<ExportResult>((resolve) => {
      if (exporter instanceof AzureMonitorSpanExporter)
        exporter.export([createReadableSpan()], resolve);
      else exporter.export([createReadableLogRecord()], resolve);
    });
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await exporter.forceFlush();
    await exporter.forceFlush();
    expect(totals()).toEqual({
      [`Item_Success_Count:${signal === "spans" ? "DEPENDENCY" : "TRACE"}`]: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it("counts actual retry subsets, permanent failures and server sampling without recounting accepted items", async () => {
  const stats = create();
  const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
  fetch.mockResolvedValueOnce(
    Response.json(
      {
        itemsReceived: 5,
        itemsAccepted: 1,
        errors: [
          { index: 1, statusCode: 503, message: "retry" },
          { index: 2, statusCode: 400, message: "invalid" },
          { index: 3, statusCode: 206, message: "Telemetry sampled out." },
          { index: 4, statusCode: 429, message: "retry" },
        ],
      },
      { status: 206 },
    ),
  );
  await sender.send(
    request([SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CLIENT]),
  );
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 2,
    "Item_Success_Count:REQUEST": 1,
    "Item_Dropped_Count:DEPENDENCY:400": 1,
    "Item_Dropped_Count:REQUEST:SAMPLING": 1,
    "Item_Retry_Count:REQUEST:503": 1,
    "Item_Retry_Count:DEPENDENCY:429": 1,
  });
});

it("replaces per-item retry codes after a later transport failure", async () => {
  const stats = create();
  const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
  fetch
    .mockResolvedValueOnce(
      Response.json(
        {
          itemsReceived: 3,
          itemsAccepted: 1,
          errors: [
            { index: 1, statusCode: 503, message: "retry" },
            { index: 2, statusCode: 429, message: "retry" },
          ],
        },
        { status: 206 },
      ),
    )
    .mockRejectedValueOnce(new TypeError("offline"));
  await sender.send(request([SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CLIENT]));
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 2,
    "Item_Success_Count:REQUEST": 1,
    "Item_Retry_Count:REQUEST:503": 1,
    "Item_Retry_Count:DEPENDENCY:429": 1,
    "Item_Retry_Count:REQUEST:CLIENT_EXCEPTION": 1,
    "Item_Retry_Count:DEPENDENCY:CLIENT_EXCEPTION": 1,
  });
});

it.each(["HTTP", "network"] as const)(
  "counts exhausted %s retries and the final drop exactly once",
  async (failure) => {
    const stats = create();
    const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
    for (let index = 0; index < MAX_SEND_ATTEMPTS; index++) {
      if (failure === "HTTP") fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
      else fetch.mockRejectedValueOnce(new TypeError("offline"));
    }
    if (failure === "HTTP") await sender.send(request());
    else await expect(sender.send(request())).rejects.toThrow("offline");
    await stats.forceFlush();
    const code = failure === "HTTP" ? "503" : "CLIENT_EXCEPTION";
    expect(totals()).toEqual({
      [`Item_Retry_Count:DEPENDENCY:${code}`]: MAX_SEND_ATTEMPTS - 1,
      [`Item_Dropped_Count:DEPENDENCY:${code}`]: 1,
    });
  },
);

it("does not count a retry that the wait budget prevents and retains prior partial success", async () => {
  const stats = create();
  const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
  fetch.mockResolvedValueOnce(
    Response.json(
      {
        itemsReceived: 2,
        itemsAccepted: 1,
        errors: [{ index: 1, statusCode: 503, message: "retry" }],
      },
      { status: 206, headers: { "retry-after": "86400" } },
    ),
  );
  await expect(sender.send(request([SpanKind.CLIENT, SpanKind.SERVER]))).rejects.toThrow(
    "retry-wait budget",
  );
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Dropped_Count:REQUEST:503": 1,
  });
});

it.each([
  {
    itemsReceived: 2,
    itemsAccepted: 1,
    errors: [{ index: 5, statusCode: 503, message: "bad index" }],
  },
  {
    itemsReceived: 2,
    itemsAccepted: 0,
    errors: [
      { index: 0, statusCode: 503, message: "" },
      { index: 0, statusCode: 503, message: "" },
    ],
  },
  { itemsReceived: 2, itemsAccepted: 9, errors: [] },
])(
  "does not invent successes or duplicate retries from malformed partial responses: %j",
  async (body) => {
    const stats = create();
    const sender = new Sender({ endpoint, itemStats: stats });
    fetch.mockResolvedValueOnce(Response.json(body, { status: 206 }));
    await sender.send(request([SpanKind.CLIENT, SpanKind.CLIENT]));
    await stats.forceFlush();
    expect(totals()).toEqual({ "Item_Dropped_Count:DEPENDENCY:206": 2 });
  },
);

it("counts unload transport failures as drops and beacon queueing as success without retries", async () => {
  const stats = create();
  const beacon = vi.fn(() => true);
  const sender = new Sender({ endpoint, itemStats: stats, sendBeacon: beacon });
  fetch.mockRejectedValueOnce(new TypeError("keepalive unavailable"));
  await sender.send({ ...request(), unloading: true });
  beacon.mockReturnValueOnce(false);
  fetch.mockRejectedValueOnce(new TypeError("keepalive unavailable"));
  await expect(sender.send({ ...request(), unloading: true })).rejects.toThrow("could not queue");
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Dropped_Count:DEPENDENCY:CLIENT_EXCEPTION": 1,
  });
});

it("reports customer stats with keepalive but never falls back to beacon", async () => {
  const stats = create();
  const beacon = vi.spyOn(navigator, "sendBeacon");
  stats.count("Success", "TRACE");
  fetch.mockRejectedValueOnce(new TypeError("keepalive unavailable"));
  beginUnloading();
  try {
    await stats.forceFlush();
  } finally {
    endUnloading();
  }
  expect(fetch.mock.calls[0][1]?.keepalive).toBe(true);
  expect(beacon).not.toHaveBeenCalled();
});

it.each(["spans", "logs"] as const)(
  "observes real $signal queue overflow without changing queue ownership",
  async (signal) => {
    const stats = create();
    let complete!: () => void;
    let calls = 0;
    const exporter = {
      export: (_records: unknown[], callback: (result: ExportResult) => void) => {
        if (++calls === 1) complete = () => callback({ code: ExportResultCode.SUCCESS });
        else callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    };
    if (signal === "spans") {
      const processor = createStatsSpanProcessor(
        {
          exporter,
          maxExportBatchSize: 1,
          maxQueueSize: 1,
          disableAutoFlushOnDocumentHide: true,
        },
        stats,
      );
      owners.push(processor);
      processor.onEnd(createReadableSpan());
      processor.onEnd(createReadableSpan());
      processor.onEnd(createReadableSpan({ kind: SpanKind.SERVER }));
    } else {
      const processor = new BrowserBatchLogRecordProcessor({
        exporter,
        maxExportBatchSize: 1,
        maxQueueSize: 1,
        onDrop: (record, reason) => stats.count("Dropped", logItemType(record), reason),
      });
      const provider = new LoggerProvider({ processors: [processor] });
      owners.push(provider);
      const logger = provider.getLogger("queue");
      logger.emit({ body: "in flight" });
      await Promise.resolve();
      logger.emit({ body: "queued" });
      logger.emit({ eventName: "exception" });
    }
    finishers.push(() => complete());
    await stats.forceFlush();
    expect(totals()).toEqual({
      [`Item_Dropped_Count:${signal === "spans" ? "REQUEST" : "EXCEPTION"}:QUEUE_FULL`]: 1,
    });
  },
);

async function initialize(
  key = TEST_INSTRUMENTATION_KEY,
  samplingPercentage?: number,
  enabled = true,
): Promise<MicrosoftOpenTelemetryBrowser> {
  const handle = await useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString: `InstrumentationKey=${key};IngestionEndpoint=${endpoint}`,
      sdkStats: { enabled },
    },
    samplingPercentage,
    pageView: { enabled: false },
    storage: { enabled: false },
    session: { enabled: false },
  });
  owners.push(handle);
  return handle;
}

it("reports trace and log sampling at zero percent, with no customer items sent", async () => {
  const handle = await initialize(TEST_INSTRUMENTATION_KEY, 0);
  trace.getTracer("sample").startSpan("private span", { kind: SpanKind.SERVER }).end();
  logs.getLogger("sample").emit({ eventName: "private event", body: "private body" });
  await handle.forceFlush();
  expect(totals()).toEqual({
    "Item_Dropped_Count:REQUEST:SAMPLING": 1,
    "Item_Dropped_Count:CUSTOM_EVENT:SAMPLING": 1,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(reports)).not.toContain("private");
  const tracer = trace.getTracer("stale");
  await handle.shutdown();
  tracer.startSpan("after shutdown").end();
  await handle.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("counts the default parent-based sampler's drops", async () => {
  const handle = await initialize();
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    traceFlags: 0,
  });
  trace.getTracer("parent").startSpan("child", {}, parent).end();
  await handle.forceFlush();
  expect(totals()).toEqual({ "Item_Dropped_Count:DEPENDENCY:SAMPLING": 1 });
});

it("keeps sampling counters attached across runtime policy changes", async () => {
  const handle = await initialize(TEST_INSTRUMENTATION_KEY, 100);
  const tracer = trace.getTracer("runtime-stats");
  const logger = logs.getLogger("runtime-stats");
  const emit = () => {
    tracer.startSpan("operation", { kind: SpanKind.SERVER }).end();
    logger.emit({ body: "log" });
  };
  emit();
  await handle.forceFlush();
  await handle.updateCfg({ samplingPercentage: 0 });
  emit();
  await handle.forceFlush();
  await handle.updateCfg({ samplingPercentage: undefined });
  emit();
  await handle.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:REQUEST": 2,
    "Item_Success_Count:TRACE": 2,
    "Item_Dropped_Count:REQUEST:SAMPLING": 1,
    "Item_Dropped_Count:TRACE:SAMPLING": 1,
  });
});

it("retains sampling counts and emission-time log policy while the destination resolves", async () => {
  let resolve!: (value: string) => void;
  const pending = new Promise<string>((done) => (resolve = done));
  const handle = await useMicrosoftOpenTelemetry({
    azureMonitor: { connectionString: pending, sdkStats: { enabled: true } },
    samplingPercentage: 0,
    pageView: { enabled: false },
    storage: { enabled: false },
    session: { enabled: false },
  });
  owners.push(handle);
  trace.getTracer("deferred-stats").startSpan("sampled", { kind: SpanKind.SERVER }).end();
  logs.getLogger("deferred-stats").emit({ body: "sampled" });
  await handle.updateCfg({ samplingPercentage: 100 });
  trace.getTracer("deferred-stats").startSpan("retained").end();
  logs.getLogger("deferred-stats").emit({ body: "retained" });
  await handle.forceFlush();
  expect(fetch).not.toHaveBeenCalled();
  resolve(connectionString);
  await Promise.resolve();
  await handle.forceFlush();
  expect(totals()).toEqual({
    "Item_Dropped_Count:REQUEST:SAMPLING": 1,
    "Item_Dropped_Count:TRACE:SAMPLING": 1,
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Success_Count:TRACE": 1,
  });
});

it.each([0, 1])(
  "counts deferred startup overflow by signal and type with capacity %s",
  async (initInMemoMaxSize) => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => (resolve = done));
    const handle = await useMicrosoftOpenTelemetry({
      azureMonitor: {
        connectionString: pending,
        initInMemoMaxSize,
        sdkStats: { enabled: true },
      },
      samplingPercentage: 100,
      pageView: { enabled: false },
      storage: { enabled: false },
      session: { enabled: false },
    });
    owners.push(handle);
    const tracer = trace.getTracer("startup-overflow");
    const logger = logs.getLogger("startup-overflow");
    new Sender({ endpoint: "https://peer.example.test/v2/track" });
    logs.getLogger("@opentelemetry/browser-instrumentation/resource-timing").emit({
      eventName: "browser.resource_timing",
      attributes: { "url.full": "https://peer.example.test/v2/track" },
    });
    logger.emit({ body: "first" });
    logger.emit({ body: "overflow" });
    logger.emit({ eventName: "exception" });
    tracer.startSpan("dependency").end();
    tracer.startSpan("request", { kind: SpanKind.SERVER }).end();
    tracer.startSpan("another request", { kind: SpanKind.CONSUMER }).end();
    expect(fetch).not.toHaveBeenCalled();
    resolve(connectionString);
    await Promise.resolve();
    await handle.forceFlush();
    expect(totals()).toEqual({
      ...(initInMemoMaxSize ? { "Item_Success_Count:TRACE": 1 } : {}),
      "Item_Dropped_Count:TRACE:QUEUE_FULL": 2 - initInMemoMaxSize,
      "Item_Dropped_Count:EXCEPTION:QUEUE_FULL": 1,
      "Item_Dropped_Count:DEPENDENCY:QUEUE_FULL": 1,
      "Item_Dropped_Count:REQUEST:QUEUE_FULL": 2,
    });
    tracer.startSpan("after activation").end();
    logger.emit({ body: "after activation" });
    await handle.shutdown();
    expect(totals()).toEqual({
      "Item_Success_Count:TRACE": initInMemoMaxSize + 1,
      "Item_Success_Count:DEPENDENCY": 1,
      "Item_Dropped_Count:TRACE:QUEUE_FULL": 2 - initInMemoMaxSize,
      "Item_Dropped_Count:EXCEPTION:QUEUE_FULL": 1,
      "Item_Dropped_Count:DEPENDENCY:QUEUE_FULL": 1,
      "Item_Dropped_Count:REQUEST:QUEUE_FULL": 2,
    });
  },
);

it.each([undefined, 0, 100])(
  "does not count resource timing for its own ingestion at sampling %s",
  async (samplingPercentage) => {
    const handle = await initialize(TEST_INSTRUMENTATION_KEY, samplingPercentage);
    const logger = logs.getLogger("@opentelemetry/browser-instrumentation/resource-timing");
    logger.emit({
      eventName: "browser.resource_timing",
      attributes: { "url.full": `${endpoint}/v2/track` },
    });
    await handle.forceFlush();
    expect(fetch).not.toHaveBeenCalled();
    logger.emit({
      eventName: "browser.resource_timing",
      attributes: { "url.full": "https://application.example.test/image.png" },
    });
    await handle.forceFlush();
    expect(totals()).toEqual({
      [samplingPercentage === 0
        ? "Item_Dropped_Count:CUSTOM_EVENT:SAMPLING"
        : "Item_Success_Count:CUSTOM_EVENT"]: 1,
    });
  },
);

it.each([false, true])(
  "does not collect stats failure diagnostics with a logs-only pipeline: %s",
  async (logsOnly) => {
    const instrumentation = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
    const handle = await useMicrosoftOpenTelemetry({
      azureMonitor: { connectionString, sdkStats: { enabled: true } },
      spanProcessors: logsOnly ? [] : undefined,
      pageView: { enabled: false },
      storage: { enabled: false },
      session: { enabled: false },
      instrumentations: [instrumentation],
    });
    owners.push(handle);
    vi.spyOn(diag, "warn").mockImplementation(() => console.warn("Customer stats failed"));
    logs.getLogger("app").emit({ body: "application" });
    fetch
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await handle.forceFlush();
    await handle.forceFlush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(diag.warn).toHaveBeenCalledOnce();
  },
);

it.each([
  `${endpoint}/v2.1/track`,
  `${endpoint}/redirected`,
  "https://eastus-8.in.applicationinsights.azure.com/v2.1/track",
])("excludes remembered SDK dispatches to %s before sampling", async (redirectedEndpoint) => {
  const handle = await initialize(TEST_INSTRUMENTATION_KEY, 0);
  const response = new Response(null);
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: redirectedEndpoint },
  });
  fetch.mockResolvedValueOnce(response);
  const sender = new Sender({
    endpoint: redirectedEndpoint.includes("applicationinsights")
      ? "https://dc.services.visualstudio.com/v2/track"
      : `${endpoint}/v2/track`,
  });
  await sender.send(request());
  await sender.send(request());
  expect(fetch.mock.calls[1][0]).toBe(redirectedEndpoint);
  fetch.mockClear();
  const logger = logs.getLogger("@opentelemetry/browser-instrumentation/resource-timing");
  logger.emit({
    eventName: "browser.resource_timing",
    attributes: { "url.full": redirectedEndpoint },
  });
  await handle.forceFlush();
  expect(fetch).not.toHaveBeenCalled();
  logger.emit({
    eventName: "browser.resource_timing",
    attributes: { "url.full": `${redirectedEndpoint}/unrelated` },
  });
  logs.getLogger("application").emit({
    eventName: "browser.resource_timing",
    attributes: { "url.full": redirectedEndpoint },
  });
  await handle.forceFlush();
  expect(totals()).toEqual({ "Item_Dropped_Count:CUSTOM_EVENT:SAMPLING": 2 });
});

it.each([
  { name: "simple", Processor: SimpleLogRecordProcessor },
  { name: "batch", Processor: BatchLogRecordProcessor },
])(
  "does not feed diagnostics into standalone $name processors without a context manager",
  async ({ Processor }) => {
    context.disable();
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString,
      sdkStats: { enabled: true },
    });
    const provider = new LoggerProvider({ processors: [new Processor({ exporter })] });
    owners.push(provider);
    const instrumentation = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
    instrumentation.setLoggerProvider(provider);
    instrumentation.enable();
    finishers.push(() => instrumentation.disable());
    const wrappedWarn = console.warn;
    vi.spyOn(diag, "warn").mockImplementation((...args) => console.warn(...args));
    provider.getLogger("app").emit({ body: "application" });
    fetch
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await provider.forceFlush();
    await exporter.forceFlush();
    await provider.forceFlush();
    await exporter.forceFlush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(diag.warn).toHaveBeenCalledOnce();
    expect(console.warn).toBe(wrappedWarn);
    console.warn("application warning");
    await provider.forceFlush();
    await exporter.forceFlush();
    expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1 });
    expect(fetch).toHaveBeenCalledTimes(4);
  },
);

it("restores console instrumentation when a stats diagnostic logger throws", () => {
  const instrumentation = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
  instrumentation.enable();
  finishers.push(() => instrumentation.disable());
  const wrappedWarn = console.warn;
  vi.spyOn(diag, "warn").mockImplementation(() => {
    throw new Error("logger failed");
  });
  expect(() => reportFailure(new Error("stats failed"))).not.toThrow();
  expect(console.warn).toBe(wrappedWarn);
});

it("keeps opt-in and counters isolated across instances and hands off after shutdown", async () => {
  const secondKey = "22222222-2222-2222-2222-222222222222";
  const first = await initialize(TEST_INSTRUMENTATION_KEY, 0, false);
  const second = await initialize(secondKey, 0);
  trace.getTracer("first").startSpan("not reported").end();
  logs.getLogger("first").emit({ body: "not reported" });
  await first.shutdown();
  expect(reports).toHaveLength(0);
  trace.getTracer("second").startSpan("reported").end();
  logs.getLogger("second").emit({ body: "reported" });
  await second.shutdown();
  expect(reports.flat().every((envelope) => envelope.iKey === secondKey)).toBe(true);
  expect(totals()).toEqual({
    "Item_Dropped_Count:DEPENDENCY:SAMPLING": 1,
    "Item_Dropped_Count:TRACE:SAMPLING": 1,
  });
});
