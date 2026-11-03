// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  diag,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { detectResources, resourceFromAttributes } from "@opentelemetry/resources";
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
import {
  MAX_FLUSH_WAIT_MS,
  MAX_BATCH_SIZE_IN_BYTES,
  MAX_SEND_ATTEMPTS,
  MAX_SHUTDOWN_WAIT_MS,
} from "../../../src/exporter/constants.js";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "../../../src/exporter/base.js";
import type { AzureMonitorEnvelope, MetricData } from "../../../src/exporter/telemetryModels.js";
import { createReadableLogRecord, createReadableSpan } from "../../fixtures/telemetry.js";
import {
  TEST_INSTRUMENTATION_KEY,
  assertAzureMonitorEnvelope,
} from "../../fixtures/azureMonitor.js";
import { installFakeClock } from "../../fixtures/clock.js";
import {
  MAX_SESSION_BUFFER_LENGTH,
  sessionBufferStorage,
} from "../../../src/exporter/sessionBuffer.js";
import { setSessionStorage, testSessionStorage } from "../../fixtures/sessionStorageSetup.js";
import { isSdkIngestionUrl, rememberSdkIngestionUrl } from "../../../src/shared/globalOwnership.js";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
} from "../../../src/index.js";
import { getInternalSdkStatsConfiguration } from "../../fixtures/sdkStatsConfigurationMock.js";

const endpoint = "https://customer.example.test";
const connectionString = `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${endpoint}`;
const owners: Array<{ shutdown(): Promise<void> }> = [];
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
  await Promise.allSettled(owners.splice(0).map((owner) => owner.shutdown()));
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const envelope of reports.flat()) {
    const {
      metrics: [metric],
      properties,
    } = envelope.data.baseData;
    if (metric.name !== "Item_Dropped_Count") continue;
    expect(properties?.dropCode).not.toMatch(/SAMPLING|QUEUE_FULL/);
    if (["DEPENDENCY", "REQUEST"].includes(String(properties?.telemetryType))) {
      expect(typeof properties?.telemetrySuccess).toBe("boolean");
    }
  }
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

function createClient(
  options: AzureMonitorOptions = { connectionString, sdkStats: { enabled: true } },
) {
  const client = new AzureMonitorExportClient(options);
  owners.push(client);
  return client;
}

function createExporter(signal: "spans", options?: AzureMonitorOptions): AzureMonitorSpanExporter;
function createExporter(
  signal: "logs",
  options?: AzureMonitorOptions,
): AzureMonitorLogRecordExporter;
function createExporter(
  signal: "spans" | "logs",
  options?: AzureMonitorOptions,
): AzureMonitorSpanExporter | AzureMonitorLogRecordExporter;
function createExporter(
  signal: "spans" | "logs",
  options: AzureMonitorOptions = { connectionString, sdkStats: { enabled: true } },
) {
  const exporter =
    signal === "spans"
      ? new AzureMonitorSpanExporter(options)
      : new AzureMonitorLogRecordExporter(options);
  owners.push(exporter);
  return exporter;
}

function exportAsync<T>(
  exporter: { export(records: T[], callback: (result: ExportResult) => void): void },
  records: T[],
): Promise<ExportResult> {
  return new Promise((resolve) => exporter.export(records, resolve));
}

function resourceTiming(url: string) {
  return createReadableLogRecord({
    eventName: "browser.resource_timing",
    instrumentationScope: { name: "@opentelemetry/browser-instrumentation/resource-timing" },
    attributes: { "url.full": url },
  });
}

function throwOnRead(target: object, property: PropertyKey, error: Error): void {
  Object.defineProperty(target, property, {
    get: () => {
      throw error;
    },
  });
}

function expectExportFailure(callback: ReturnType<typeof vi.fn>, error: Error): void {
  expect(callback).toHaveBeenCalledExactlyOnceWith({ code: ExportResultCode.FAILED, error });
}

function holdNextFetch(): (response?: Response) => void {
  const normal = fetch.getMockImplementation()!;
  let args: Parameters<typeof globalThis.fetch> | undefined;
  let finish!: (response: Response | PromiseLike<Response>) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  fetch.mockImplementationOnce((...request) => {
    args = request;
    return pending;
  });
  return (response) => {
    if (!args) throw new Error("Expected the held fetch to have started.");
    finish(response ?? normal(...args));
  };
}

function partialResponse(
  itemsReceived: number,
  errors: { index: number; statusCode: number; message: string }[],
  headers?: HeadersInit,
): Response {
  return Response.json(
    { itemsReceived, itemsAccepted: itemsReceived - errors.length, errors },
    { status: 206, headers },
  );
}

function redirectResponse(url: string): Response {
  return Object.defineProperties(new Response(null), {
    redirected: { value: true },
    url: { value: url },
  });
}

function churnIngestionUrls(): void {
  for (let index = 0; index < 300; index++)
    rememberSdkIngestionUrl(`https://history.example.test/track?request=${index}`);
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
  stats.count("Dropped", "TRACE", "400", 2);
  stats.count("Retry", "DEPENDENCY", "503", 3);
  await clock.advance(899_999);
  expect(fetch).not.toHaveBeenCalled();
  await clock.advance(1);
  await vi.waitFor(() => expect(reports).toHaveLength(1));
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 4,
    "Item_Dropped_Count:TRACE:400": 2,
    "Item_Retry_Count:DEPENDENCY:503": 3,
  });
  for (const envelope of reports.flat()) {
    assertAzureMonitorEnvelope(envelope);
    expect(envelope.iKey).toBe(TEST_INSTRUMENTATION_KEY);
    expect(envelope.sampleRate).toBeUndefined();
    expect(Object.keys(envelope.tags)).toEqual(["ai.internal.sdkVersion"]);
    expect(envelope.data.baseData.properties?.language).toBe("JavaScript");
  }
  expect(fetch.mock.calls[0]).toEqual([
    `${endpoint}/v2/track`,
    expect.objectContaining({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    }),
  ]);
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await clock.advance(900_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(
  (["spans", "logs"] as const).flatMap((signal) =>
    [false, true].map((conversionFailure) => ({ signal, conversionFailure })),
  ),
)(
  "preserves $signal role groups after conversion failure: $conversionFailure",
  async ({ signal, conversionFailure }) => {
    const exporter = createExporter(signal);
    const roles = [
      ["checkout:west", "one"],
      ["checkout", "west:one"],
    ];
    const resources = roles.map(([role, instance]) =>
      resourceFromAttributes({ "service.name": role, "service.instance.id": instance }),
    );
    const failure = new Error("conversion failed");
    if (exporter instanceof AzureMonitorSpanExporter) {
      const records = resources.map((resource) => createReadableSpan({ resource }));
      if (conversionFailure) throwOnRead(records[0], "startTime", failure);
      await exportAsync(exporter, records);
    } else {
      const records = resources.map((resource) => createReadableLogRecord({ resource }));
      if (conversionFailure) throwOnRead(records[0], "hrTime", failure);
      await exportAsync(exporter, records);
    }
    await exporter.forceFlush();
    expect(reports.flat()).toHaveLength(2);
    for (const [index, envelope] of reports.flat().entries()) {
      assertAzureMonitorEnvelope(envelope);
      expect(envelope.tags).toEqual({
        "ai.internal.sdkVersion": expect.any(String),
        "ai.cloud.role": roles[index][0],
        "ai.cloud.roleInstance": roles[index][1],
      });
      expect(envelope.data.baseData.metrics).toEqual([
        {
          name: conversionFailure ? "Item_Dropped_Count" : "Item_Success_Count",
          kind: 0,
          value: 1,
        },
      ]);
      expect(envelope.data.baseData.properties?.telemetrySuccess).toBe(
        conversionFailure && signal === "spans" ? true : undefined,
      );
    }
  },
);

it.each(
  [SpanKind.CLIENT, SpanKind.SERVER].flatMap((kind) =>
    [false, true].map((conversionFailure) => ({ kind, conversionFailure })),
  ),
)(
  "separates dropped kind $kind by application outcome after conversion failure: $conversionFailure",
  async ({ kind, conversionFailure }) => {
    const exporter = createExporter("spans");
    const records = [
      { status: { code: SpanStatusCode.OK } },
      { attributes: { "http.response.status_code": 200 } },
      { status: { code: SpanStatusCode.ERROR } },
      { attributes: { "http.response.status_code": 500 } },
    ].map((options) => createReadableSpan({ ...options, kind }));
    if (conversionFailure) throwOnRead(records[0], "startTime", new Error("conversion failed"));
    else fetch.mockResolvedValueOnce(new Response(null, { status: 400 }));
    expect((await exportAsync(exporter, records)).code).toBe(ExportResultCode.FAILED);
    await exporter.forceFlush();
    expect(reports.flat()).toHaveLength(2);
    for (const [index, envelope] of reports.flat().entries()) {
      assertAzureMonitorEnvelope(envelope);
      expect(envelope.data.baseData.metrics).toEqual([
        {
          name: "Item_Dropped_Count",
          kind: 0,
          value: 2,
        },
      ]);
      expect(envelope.data.baseData.properties).toMatchObject({
        telemetryType: kind === SpanKind.CLIENT ? "DEPENDENCY" : "REQUEST",
        dropCode: conversionFailure ? "CLIENT_EXCEPTION" : "400",
        telemetrySuccess: index === 0,
      });
    }
  },
);

it.each([401, 403, 408, 429, 439, 500, 502, 503, 504, "network"] as const)(
  "retains a failed %s report until the next interval without counting its own failure",
  async (failure) => {
    const clock = installFakeClock();
    const stats = create({ enabled: true, collectionIntervalMillis: 10 });
    if (failure === "network") fetch.mockRejectedValueOnce(new TypeError("offline"));
    else fetch.mockResolvedValueOnce(new Response(null, { status: failure }));
    stats.count("Success", "TRACE", "", 4);
    await stats.forceFlush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(diag.warn).toHaveBeenCalledWith("Customer SDK stats export failed", expect.any(Error));
    await clock.advance(9);
    expect(fetch).toHaveBeenCalledOnce();
    await clock.advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await stats.forceFlush();
    expect(totals()).toEqual({ "Item_Success_Count:TRACE": 4 });
    await stats.shutdown();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([400, 413])("does not retain a permanently rejected HTTP %s report", async (status) => {
  const clock = installFakeClock();
  const stats = create({ enabled: true, collectionIntervalMillis: 10 });
  fetch.mockResolvedValueOnce(new Response(null, { status }));
  stats.count("Success", "TRACE");
  await stats.forceFlush();
  await clock.advance(10);
  await stats.shutdown();
  expect(fetch).toHaveBeenCalledOnce();
  expect(diag.warn).toHaveBeenCalledWith("Customer SDK stats export failed", expect.any(Error));
  expect(vi.getTimerCount()).toBe(0);
});

it.each([200, 400, 503, 206])(
  "batches role groups and retains only failed HTTP %i items",
  async (status) => {
    const stats = create();
    const original = fetch.getMockImplementation()!;
    const batches: AzureMonitorEnvelope<MetricData>[][] = [];
    fetch.mockImplementation(async (...args) => {
      const body = await new Request(...args).text();
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
        MAX_BATCH_SIZE_IN_BYTES,
      );
      const envelopes: AzureMonitorEnvelope<MetricData>[] = JSON.parse(body);
      batches.push(envelopes);
      if (batches.length === 1 && status !== 200) {
        return status === 206
          ? partialResponse(envelopes.length, [
              { index: 0, statusCode: 503, message: "retry" },
              { index: 1, statusCode: 400, message: "invalid" },
            ])
          : new Response(null, { status });
      }
      return original(...args);
    });
    const envelope = request().envelopes[0];
    stats.countEnvelopes(
      "Success",
      Array.from({ length: 250 }, (_, index) => ({
        ...envelope,
        tags: { ...envelope.tags, "ai.cloud.roleInstance": `worker-${index}-\u20ac` },
      })),
    );
    await stats.forceFlush();
    expect(batches).toHaveLength(2);
    expect(batches.flat()).toHaveLength(250);
    expect(new Set(fetch.mock.calls.map(([, init]) => init?.signal)).size).toBe(2);
    const identities = (batch: readonly AzureMonitorEnvelope[]) =>
      batch.map((item) => item.tags["ai.cloud.roleInstance"]);
    expect(new Set(identities(batches.flat())).size).toBe(250);
    await stats.forceFlush();
    const retry = status === 503 ? batches[0] : status === 206 ? batches[0].slice(0, 1) : [];
    expect(batches).toHaveLength(retry.length ? 3 : 2);
    if (retry.length) expect(identities(batches[2])).toEqual(identities(retry));
  },
);

it.each([200, 400])(
  "does not replay HTTP %s counts when reading the response body fails",
  async (status) => {
    const clock = installFakeClock();
    const stats = create({ enabled: true, collectionIntervalMillis: 10 });
    const response = new Response(null, { status });
    vi.spyOn(response, "text").mockRejectedValueOnce(new TypeError("body failed"));
    fetch.mockResolvedValueOnce(response);
    stats.count("Success", "TRACE");
    await stats.forceFlush();
    await clock.advance(10);
    await stats.shutdown();
    expect(fetch).toHaveBeenCalledOnce();
    expect(diag.warn).toHaveBeenCalledWith("Customer SDK stats export failed", expect.any(Error));
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("merges failed counts with counts collected during a shared in-flight flush", async () => {
  const stats = create();
  const finish = holdNextFetch();
  stats.count("Success", "TRACE", "", 4);
  const first = stats.forceFlush();
  expect(stats.forceFlush()).toBe(first);
  stats.count("Success", "TRACE", "", 2);
  stats.count("Dropped", "TRACE", "400", 3);
  finish(new Response(null, { status: 503 }));
  await first;
  expect(reports).toHaveLength(0);
  await stats.forceFlush();
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(totals()).toEqual({
    "Item_Success_Count:TRACE": 6,
    "Item_Dropped_Count:TRACE:400": 3,
  });
});

it.each(
  (["spans", "logs"] as const).flatMap((signal) =>
    [200, 503].map((status) => ({ signal, status })),
  ),
)(
  "flushes new $signal counts once behind an older HTTP $status stats report",
  async ({ signal, status }) => {
    const exporter = createExporter(signal);
    const send = () =>
      new Promise<ExportResult>((resolve) => {
        if (exporter instanceof AzureMonitorSpanExporter)
          exporter.export([createReadableSpan()], resolve);
        else exporter.export([createReadableLogRecord()], resolve);
      });
    await send();
    const finish = holdNextFetch();
    const first = exporter.forceFlush();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await send();
    const second = exporter.forceFlush();
    const concurrent = exporter.forceFlush();
    await Promise.resolve();
    finish(status === 200 ? undefined : new Response(null, { status }));
    await Promise.all([first, second, concurrent]);
    await exporter.forceFlush();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(totals()).toEqual({
      [`Item_Success_Count:${signal === "spans" ? "DEPENDENCY" : "TRACE"}`]: 2,
    });
  },
);

it("only retries outstanding retriable items after partial acceptance", async () => {
  const stats = create();
  fetch.mockResolvedValueOnce(
    partialResponse(4, [
      { index: 1, statusCode: 503, message: "unavailable" },
      { index: 2, statusCode: 400, message: "invalid" },
      { index: 3, statusCode: 206, message: "Telemetry sampled out." },
    ]),
  );
  stats.count("Success", "TRACE", "", 4);
  stats.count("Retry", "DEPENDENCY", "503", 3);
  stats.count("Dropped", "TRACE", "400", 2);
  stats.count("Success", "REQUEST");
  const first = stats.forceFlush();
  stats.count("Success", "TRACE", "", 2);
  await first;
  await stats.forceFlush();
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(totals()).toEqual({
    "Item_Success_Count:TRACE": 2,
    "Item_Retry_Count:DEPENDENCY:503": 3,
  });
});

it("retains all outstanding counts when a partial response cannot be parsed", async () => {
  const stats = create();
  fetch.mockResolvedValueOnce(new Response("unreadable", { status: 206 }));
  stats.count("Success", "TRACE", "", 4);
  await stats.forceFlush();
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(totals()).toEqual({ "Item_Success_Count:TRACE": 4 });
});

it("keeps failed counts isolated from another reporter", async () => {
  const first = create();
  const second = create();
  fetch.mockRejectedValueOnce(new TypeError("offline"));
  first.count("Success", "TRACE", "", 4);
  second.count("Success", "DEPENDENCY", "", 2);
  await first.forceFlush();
  await second.forceFlush();
  expect(totals()).toEqual({ "Item_Success_Count:DEPENDENCY": 2 });
  await first.forceFlush();
  expect(totals()).toEqual({ "Item_Success_Count:DEPENDENCY": 2, "Item_Success_Count:TRACE": 4 });
});

it("shares concurrent flushes, retains new counts and drains them after a pending export at shutdown", async () => {
  const stats = create();
  const complete = holdNextFetch();
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

it("retains timed-out counts for the next interval and aborts the stalled request", async () => {
  const clock = installFakeClock();
  fetch.mockImplementationOnce(() => new Promise(() => {}));
  const stats = create({ enabled: true, collectionIntervalMillis: 10 });
  stats.count("Success", "TRACE");
  const flushing = stats.forceFlush();
  await clock.advance(10_000);
  await flushing;
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(diag.warn).toHaveBeenCalledWith(
    "Customer SDK stats export failed",
    expect.objectContaining({ message: "Operation timed out." }),
  );
  await clock.advance(10);
  expect(fetch).toHaveBeenCalledTimes(2);
  await stats.forceFlush();
  expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1 });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "bounds shutdown to one final attempt after any in-flight report: %s",
  async (inFlight) => {
    const clock = installFakeClock();
    fetch.mockImplementation(() => new Promise(() => {}));
    const stats = create();
    stats.count("Success", "TRACE");
    if (inFlight) void stats.forceFlush();
    const shutdown = stats.shutdown();
    expect(stats.shutdown()).toBe(shutdown);
    await clock.advance(inFlight ? 20_000 : 10_000);
    await shutdown;
    expect(fetch).toHaveBeenCalledTimes(inFlight ? 2 : 1);
    expect(fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    stats.count("Success", "TRACE");
    await stats.forceFlush();
    await clock.advance(900_000);
    expect(fetch).toHaveBeenCalledTimes(inFlight ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("makes one final attempt for failed counts before discarding them at shutdown", async () => {
  const clock = installFakeClock();
  fetch.mockRejectedValue(new TypeError("offline"));
  const stats = create();
  stats.count("Success", "TRACE");
  await stats.forceFlush();
  await stats.shutdown();
  await clock.advance(900_000);
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("re-arms pending counters when an interval expires during a slow report", async () => {
  const clock = installFakeClock();
  const stats = create({ enabled: true, collectionIntervalMillis: 10 });
  const finish = holdNextFetch();
  stats.count("Success", "TRACE");
  await clock.advance(10);
  stats.count("Success", "DEPENDENCY");
  await clock.advance(20);
  finish();
  await clock.advance(20);
  expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1, "Item_Success_Count:DEPENDENCY": 1 });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not count an in-flight batch as dropped when its buffer copy is evicted", async () => {
  const client = createClient();
  const finish = holdNextFetch();
  const sending = exportAsync(client, request().envelopes);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const large = {
    ...request().envelopes[0],
    tags: { large: "x".repeat(MAX_SESSION_BUFFER_LENGTH * 0.6) },
  };
  beginUnloading();
  try {
    for (let index = 0; index < 2; index++) await exportAsync(client, [large]);
  } finally {
    endUnloading();
    finish(new Response(null));
  }
  await sending;
  await client.shutdown();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
  });
});

it.each(["void", "throws", "promise"] as const)(
  "drains all exports and ignores callback return values during shutdown: %s",
  async (callbackMode) => {
    const client = createClient();
    const completions: Array<(response: Response) => void> = [];
    for (let index = 0; index < 2; index++)
      fetch.mockImplementationOnce(() => new Promise((resolve) => completions.push(resolve)));
    const failure = new Error("callback failed");
    const callback = vi.fn(() => {
      if (callbackMode === "throws") throw failure;
      if (callbackMode === "promise") return new Promise<void>(() => {});
    });
    client.export(request().envelopes, callback);
    client.export(request([SpanKind.SERVER]).envelopes, () => {});
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    const stopped = vi.fn();
    const shutdown = client.shutdown().finally(stopped);
    const expected =
      callbackMode === "throws"
        ? expect(shutdown).rejects.toBe(failure)
        : expect(shutdown).resolves.toBeUndefined();
    completions[0](new Response(null));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(stopped).not.toHaveBeenCalled();
    completions[1](new Response(null, { status: 503, headers: { "retry-after": "86400" } }));
    await expected;
    expect(callback).toHaveBeenCalledOnce();
    expect(totals()).toEqual({
      "Item_Success_Count:DEPENDENCY": 1,
    });
  },
);

it.each(["available", "disabled", "unavailable", "quota", "oversized"] as const)(
  "reports unload size-limit drops only when storage does not retain them: %s",
  async (storage) => {
    const options = { connectionString, sdkStats: { enabled: true } };
    if (storage === "disabled") sessionBufferStorage.set(options, null);
    if (storage === "unavailable") setSessionStorage(undefined);
    if (storage === "quota")
      vi.spyOn(testSessionStorage, "setItem").mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
    const client = createClient(options);
    const envelopes = request().envelopes;
    const large = {
      ...envelopes[0],
      data: {
        baseType: "MessageData" as const,
        baseData: {
          ver: 2 as const,
          message: "x".repeat(storage === "oversized" ? MAX_SESSION_BUFFER_LENGTH : 70_000),
        },
      },
    };
    beginUnloading();
    try {
      const result = await exportAsync(client, [envelopes[0], large]);
      expect(result.code).toBe(ExportResultCode.FAILED);
      await client.forceFlush();
    } finally {
      endUnloading();
    }
    expect(totals()).toEqual({
      ...(["disabled", "oversized"].includes(storage)
        ? { "Item_Dropped_Count:TRACE:PAYLOAD_TOO_LARGE": 1 }
        : {}),
      "Item_Success_Count:DEPENDENCY": 1,
    });
  },
);

it("flushes both stats reporters before propagating an export callback failure", async () => {
  const internalEndpoint = "https://internal.example.test/v2/track";
  getInternalSdkStatsConfiguration.mockReturnValue({
    instrumentationKey: TEST_INSTRUMENTATION_KEY,
    endpoint: internalEndpoint,
  });
  const client = createClient();
  const failure = new Error("callback failed");
  client.export(request().envelopes, () => {
    throw failure;
  });
  await expect(client.forceFlush()).rejects.toBe(failure);
  expect(fetch.mock.calls.map(([url]) => url)).toContain(internalEndpoint);
  expect(totals()["Item_Success_Count:DEPENDENCY"]).toBe(1);
});

it("reports collected counts despite a hung flush without cancelling application delivery", async () => {
  const clock = installFakeClock();
  const client = createClient();
  await exportAsync(client, request().envelopes);
  const finishFirst = holdNextFetch();
  const first = exportAsync(client, request().envelopes);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const flushing = expect(client.forceFlush()).rejects.toThrow("Operation timed out");
  const finishSecond = holdNextFetch();
  const sending = exportAsync(client, request([SpanKind.SERVER]).envelopes);
  await vi.waitFor(() => expect(totals()).toEqual({ "Item_Success_Count:DEPENDENCY": 1 }));
  await clock.advance(MAX_FLUSH_WAIT_MS);
  await flushing;
  expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(false);
  expect(fetch.mock.calls[3][1]?.signal?.aborted).toBe(false);
  finishFirst(new Response(null));
  finishSecond(new Response(null));
  expect(await Promise.all([first, sending])).toEqual([
    { code: ExportResultCode.SUCCESS },
    { code: ExportResultCode.SUCCESS },
  ]);
  await client.shutdown();
  expect(totals()).toEqual({
    "Item_Success_Count:REQUEST": 1,
    "Item_Success_Count:DEPENDENCY": 2,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([20, 30])(
  "preserves Retry-After: %ss while flushing with stats disabled",
  async (seconds) => {
    const clock = installFakeClock();
    const client = createClient({ connectionString, sdkStats: { enabled: false } });
    for (const status of [503, 200]) {
      const response = new Response(null, { status, headers: { "retry-after": String(seconds) } });
      vi.spyOn(response, "text").mockResolvedValue("");
      fetch.mockResolvedValueOnce(response);
    }
    const sending = exportAsync(client, request().envelopes);
    const flushed = Promise.allSettled([client.forceFlush()]);
    await clock.advance(seconds * 1000);
    expect(await sending).toEqual({ code: ExportResultCode.SUCCESS });
    expect((await flushed)[0].status).toBe(seconds === 20 ? "fulfilled" : "rejected");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, init]) => !init?.signal?.aborted)).toBe(true);
    await client.shutdown();
  },
);

it("lets shutdown own final reports when an earlier flush is still draining", async () => {
  const clock = installFakeClock();
  const options = { connectionString, sdkStats: { enabled: true } };
  sessionBufferStorage.set(options, null);
  const client = createClient(options);
  fetch.mockImplementation(() => new Promise(() => {}));
  client.export(request().envelopes, () => {});
  const flushing = expect(client.forceFlush()).rejects.toThrow("shutdown timed out");
  const shutdown = client.shutdown();
  const settled = Promise.allSettled([shutdown]);
  expect(client.forceFlush()).toBe(shutdown);
  await clock.advance(MAX_SHUTDOWN_WAIT_MS + 10_001);
  await flushing;
  await settled;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["fetch", "body", "retry"] as const)(
  "cancels a hung %s at shutdown and reports its outcome once",
  async (phase) => {
    const clock = installFakeClock();
    const options = { connectionString, sdkStats: { enabled: true } };
    sessionBufferStorage.set(options, null);
    const client = createClient(options);
    const finish = phase === "fetch" ? holdNextFetch() : () => {};
    if (phase !== "fetch") {
      const response = new Response(null, { status: 503, headers: { "retry-after": "30" } });
      vi.spyOn(response, "text").mockImplementation(() =>
        phase === "body" ? new Promise(() => {}) : Promise.resolve(""),
      );
      fetch.mockResolvedValueOnce(response);
    }
    const callback = vi.fn();
    client.export(request().envelopes, callback);
    const shutdown = client.shutdown();
    expect(client.shutdown()).toBe(shutdown);
    const expected = expect(shutdown).rejects.toThrow("Exporter shutdown timed out.");
    await clock.advance(MAX_SHUTDOWN_WAIT_MS - 1);
    expect(callback).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(fetch.mock.calls[0][1]?.credentials).toBeUndefined();
    expect(fetch.mock.calls[0][1]?.referrerPolicy).toBeUndefined();
    await clock.advance(1);
    await expected;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      code: ExportResultCode.FAILED,
      error: expect.objectContaining({ name: "AbortError" }),
    });
    expect(totals()).toEqual({
      [`Item_Dropped_Count:DEPENDENCY:${phase === "retry" ? "503" : "CLIENT_EXCEPTION"}`]: 1,
    });
    finish(new Response(null));
    await clock.advance(MAX_SHUTDOWN_WAIT_MS);
    await client.forceFlush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["available", "disabled", "unavailable", "quota"] as const)(
  "counts only terminal outcomes from a partial unload with %s storage",
  async (storage) => {
    const options = { connectionString, sdkStats: { enabled: true } };
    if (storage === "disabled") sessionBufferStorage.set(options, null);
    if (storage === "unavailable") setSessionStorage(undefined);
    const client = createClient(options);
    fetch.mockImplementationOnce(async () => {
      if (storage === "quota")
        vi.spyOn(testSessionStorage, "setItem").mockImplementation(() => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        });
      return partialResponse(4, [
        { index: 1, statusCode: 503, message: "retry" },
        { index: 2, statusCode: 400, message: "invalid" },
        { index: 3, statusCode: 206, message: "Telemetry sampled out." },
      ]);
    });
    beginUnloading();
    try {
      const result = await exportAsync(
        client,
        request([SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CLIENT, SpanKind.SERVER]).envelopes,
      );
      expect(result.code).toBe(ExportResultCode.FAILED);
    } finally {
      endUnloading();
    }
    await client.forceFlush();
    expect(totals()).toEqual({
      "Item_Success_Count:DEPENDENCY": 1,
      "Item_Dropped_Count:DEPENDENCY:400": 1,
      "Item_Dropped_Count:REQUEST:206": 1,
      ...(storage === "disabled" ? { "Item_Dropped_Count:REQUEST:503": 1 } : {}),
    });
    await client.shutdown();
    expect(totals()["Item_Dropped_Count:REQUEST:503"]).toBe(storage === "disabled" ? 1 : undefined);
  },
);

it.each(
  [false, true].flatMap((unloading) =>
    ["next span", "later event"].map((location) => ({ unloading, location })),
  ),
)(
  "counts completed span envelopes before failure in $location (unloading: $unloading)",
  async ({ unloading, location }) => {
    const exporter = createExporter("spans");
    const failure = new Error("conversion failed");
    const badEvent = { name: "bad", time: [1, 0] as [number, number], droppedAttributesCount: 0 };
    throwOnRead(badEvent, "time", failure);
    const converted = createReadableSpan({
      events: [
        {
          name: "exception",
          time: [1_735_689_601, 0],
          attributes: { "exception.type": "Error", "exception.message": "boom" },
          droppedAttributesCount: 0,
        },
        { name: "step", time: [1_735_689_602, 0], droppedAttributesCount: 0 },
        ...(location === "later event" ? [badEvent] : []),
      ],
    });
    const failed = createReadableSpan({ kind: SpanKind.SERVER });
    if (location === "next span") throwOnRead(failed, "startTime", failure);
    const callback = vi.fn();
    if (unloading) beginUnloading();
    try {
      exporter.export([converted, failed, createReadableSpan()], callback);
    } finally {
      if (unloading) endUnloading();
    }
    expectExportFailure(callback, failure);
    expect(fetch).not.toHaveBeenCalled();
    await exporter.forceFlush();
    expect(totals()).toEqual({
      "Item_Dropped_Count:DEPENDENCY:CLIENT_EXCEPTION": 2,
      "Item_Dropped_Count:REQUEST:CLIENT_EXCEPTION": 1,
      "Item_Dropped_Count:EXCEPTION:CLIENT_EXCEPTION": 1,
      "Item_Dropped_Count:TRACE:CLIENT_EXCEPTION": 1,
    });
  },
);

it("counts the discarded page-view performance envelope without counting filtered SDK timings", async () => {
  const exporter = createExporter("logs");
  const converted = createReadableLogRecord({
    eventName: "browser.page_view",
    attributes: {
      "browser.page_view.performance.total": 170,
      "browser.page_view.performance.network_connect": 20,
      "browser.page_view.performance.sent_request": 50,
      "browser.page_view.performance.received_response": 30,
      "browser.page_view.performance.dom_processing": 70,
    },
  });
  const failed = createReadableLogRecord({ eventName: "application.event" });
  const failure = new Error("conversion failed");
  throwOnRead(failed, "hrTime", failure);
  const timing = resourceTiming(`${endpoint}/v2/track`);
  const callback = vi.fn();
  exporter.export([timing, converted, failed, timing, createReadableLogRecord()], callback);
  expectExportFailure(callback, failure);
  expect(fetch).not.toHaveBeenCalled();
  await exporter.forceFlush();
  expect(totals()).toEqual({
    "Item_Dropped_Count:PAGE_VIEW:CLIENT_EXCEPTION": 2,
    "Item_Dropped_Count:CUSTOM_EVENT:CLIENT_EXCEPTION": 1,
    "Item_Dropped_Count:TRACE:CLIENT_EXCEPTION": 1,
  });
});

it.each([false, true])(
  "counts only outstanding retries and their latest codes (network failure: %s)",
  async (networkFailure) => {
    const stats = create();
    const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
    fetch.mockResolvedValueOnce(
      partialResponse(5, [
        { index: 1, statusCode: 503, message: "retry" },
        { index: 2, statusCode: 400, message: "invalid" },
        { index: 3, statusCode: 206, message: "Telemetry sampled out." },
        { index: 4, statusCode: 429, message: "retry" },
      ]),
    );
    if (networkFailure) fetch.mockRejectedValueOnce(new TypeError("offline"));
    await sender.send(
      request([
        SpanKind.CLIENT,
        SpanKind.SERVER,
        SpanKind.CLIENT,
        SpanKind.SERVER,
        SpanKind.CLIENT,
      ]),
    );
    await stats.forceFlush();
    expect(totals()).toEqual({
      "Item_Success_Count:DEPENDENCY": 2,
      "Item_Success_Count:REQUEST": 1,
      "Item_Dropped_Count:DEPENDENCY:400": 1,
      "Item_Dropped_Count:REQUEST:206": 1,
      "Item_Retry_Count:REQUEST:503": 1,
      "Item_Retry_Count:DEPENDENCY:429": 1,
      ...(networkFailure
        ? {
            "Item_Retry_Count:REQUEST:CLIENT_EXCEPTION": 1,
            "Item_Retry_Count:DEPENDENCY:CLIENT_EXCEPTION": 1,
          }
        : {}),
    });
  },
);

it.each([false, true])(
  "counts rejected retry promises but not synchronous fetch throws (synchronous: %s)",
  async (synchronous) => {
    const stats = create();
    const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetch.mockImplementationOnce(() => {
      const error = new TypeError("fetch wrapper failed");
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    await sender.send(request());
    await stats.forceFlush();
    expect(totals()).toEqual({
      "Item_Success_Count:DEPENDENCY": 1,
      "Item_Retry_Count:DEPENDENCY:CLIENT_EXCEPTION": 1,
      ...(synchronous ? {} : { "Item_Retry_Count:DEPENDENCY:503": 1 }),
    });
  },
);

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
    partialResponse(2, [{ index: 1, statusCode: 503, message: "retry" }], {
      "retry-after": "86400",
    }),
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

it.each(["handoff", "abort"] as const)(
  "does not count a retry cancelled by %s during compression",
  async (cancellation) => {
    const stats = create();
    let active = true;
    let compressions = 0;
    const controller = new AbortController();
    vi.stubGlobal(
      "CompressionStream",
      class extends TransformStream<Uint8Array, Uint8Array> {
        constructor() {
          super({
            transform(chunk, stream) {
              if (++compressions === 2) {
                if (cancellation === "abort") controller.abort();
                else active = false;
              }
              stream.enqueue(chunk);
            },
          });
        }
      },
    );
    const transport = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 503 }),
    );
    const sender = new Sender({
      endpoint: "https://dc.services.visualstudio.com/v2/track",
      fetch: transport,
      itemStats: stats,
      delay: async () => {},
    });
    await expect(
      sender.send({ ...request(), active: () => active, signal: controller.signal }),
    ).rejects.toThrow(cancellation === "abort" ? "Request aborted" : "handed off");
    expect(compressions).toBe(2);
    expect(transport).toHaveBeenCalledOnce();
    await stats.forceFlush();
    expect(totals()).toEqual(
      cancellation === "handoff" ? {} : { "Item_Dropped_Count:DEPENDENCY:CLIENT_EXCEPTION": 1 },
    );
  },
);

it("counts only the retry subset when its successful response body fails", async () => {
  const stats = create();
  const response = new Response(null);
  vi.spyOn(response, "text").mockRejectedValue(new TypeError("body failed"));
  fetch
    .mockResolvedValueOnce(partialResponse(2, [{ index: 1, statusCode: 503, message: "retry" }]))
    .mockResolvedValueOnce(response);
  const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
  await expect(sender.send(request([SpanKind.CLIENT, SpanKind.SERVER]))).rejects.toThrow(
    "body failed",
  );
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Success_Count:REQUEST": 1,
    "Item_Retry_Count:REQUEST:503": 1,
  });
});

it("does not invent successes or retries from an invalid partial response", async () => {
  const stats = create();
  const sender = new Sender({ endpoint, itemStats: stats });
  fetch.mockResolvedValueOnce(partialResponse(2, [{ index: 5, statusCode: 503, message: "bad" }]));
  await sender.send(request([SpanKind.CLIENT, SpanKind.CLIENT]));
  await stats.forceFlush();
  expect(totals()).toEqual({ "Item_Dropped_Count:DEPENDENCY:206": 2 });
});

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

it("reports customer stats on unload without falling back to beacon", async () => {
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
  expect(fetch.mock.calls[0][1]?.keepalive).toBe(false);
  expect(beacon).not.toHaveBeenCalled();
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1 });
});

it.each(["spans", "logs"] as const)(
  "excludes real distribution $signal queue overflow from customer counters",
  async (signal) => {
    const observed: unknown[] = [];
    const handle = await useMicrosoftOpenTelemetry({
      azureMonitor: { connectionString, sdkStats: { enabled: true } },
      spanProcessors:
        signal === "spans"
          ? [
              {
                onStart() {},
                onEnd: (record) => observed.push(record),
                forceFlush: async () => {},
                shutdown: async () => {},
              },
            ]
          : [],
      logRecordProcessors:
        signal === "logs"
          ? [
              {
                onEmit: (record) => observed.push(record),
                forceFlush: async () => {},
                shutdown: async () => {},
              },
            ]
          : [],
      pageView: { enabled: false },
      storage: { enabled: false },
      session: { enabled: false },
    });
    owners.push(handle);
    const tracer = trace.getTracer("queue");
    const logger = logs.getLogger("queue");
    for (let index = 0; index < 2600; index++) {
      if (signal === "spans") tracer.startSpan(`span-${index}`).end();
      else logger.emit({ body: `log-${index}` });
    }
    await handle.forceFlush();
    expect(observed).toHaveLength(2600);
    expect(totals()).toEqual({
      [`Item_Success_Count:${signal === "spans" ? "DEPENDENCY" : "TRACE"}`]: 2560,
    });
    if (signal === "logs") {
      expect(diag.warn).toHaveBeenCalledWith("Log queue full; dropping records");
    }
    const application = await Promise.all(
      fetch.mock.calls.map(async ([url, init]) => {
        const envelopes: AzureMonitorEnvelope[] = await new Request(url, init).json();
        return envelopes.filter((envelope) => envelope.data.baseType !== "MetricData");
      }),
    );
    expect(application.flat()).toHaveLength(2560);
  },
);

it.each(
  [SpanKind.CLIENT, SpanKind.SERVER].flatMap((kind) =>
    [SpanStatusCode.OK, SpanStatusCode.ERROR].map((code) => ({ kind, code })),
  ),
)(
  "reports ingestion sampling with HTTP 206 and completed success for kind $kind status $code",
  async ({ kind, code }) => {
    const exporter = createExporter("spans");
    fetch.mockResolvedValueOnce(
      partialResponse(1, [{ index: 0, statusCode: 206, message: "Telemetry sampled out." }]),
    );
    expect(await exportAsync(exporter, [createReadableSpan({ kind, status: { code } })])).toEqual({
      code: ExportResultCode.SUCCESS,
    });
    await exporter.forceFlush();
    expect(reports.flat()).toHaveLength(1);
    expect(reports.flat()[0].data.baseData).toMatchObject({
      metrics: [{ name: "Item_Dropped_Count", value: 1 }],
      properties: {
        telemetryType: kind === SpanKind.CLIENT ? "DEPENDENCY" : "REQUEST",
        dropCode: "206",
        telemetrySuccess: code === SpanStatusCode.OK,
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
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

it.each(
  ["prototype getters", "inherited fields", "non-enumerable fields"].flatMap((shape) =>
    [false, true].map((deferred) => ({ shape, deferred })),
  ),
)("snapshots $shape with a deferred destination: $deferred", async ({ shape, deferred }) => {
  const clock = installFakeClock();
  const timer = vi.spyOn(globalThis, "setTimeout");
  const values = { enabled: true, collectionIntervalMillis: 100 };
  class StatsOptions {
    get enabled() {
      return values.enabled;
    }
    get collectionIntervalMillis() {
      return values.collectionIntervalMillis;
    }
  }
  const sdkStats: AzureMonitorSdkStatsOptions =
    shape === "prototype getters"
      ? new StatsOptions()
      : shape === "inherited fields"
        ? Object.create(values)
        : Object.defineProperties(
            {},
            {
              enabled: { value: true },
              collectionIntervalMillis: { value: 100 },
            },
          );
  let resolve!: (value: string) => void;
  const pending = new Promise<string>((done) => (resolve = done));
  const handle = await useMicrosoftOpenTelemetry({
    azureMonitor: { connectionString: deferred ? pending : connectionString, sdkStats },
    samplingPercentage: 100,
    pageView: { enabled: false },
    session: { enabled: false },
    storage: { enabled: false },
  });
  owners.push(handle);
  values.enabled = false;
  values.collectionIntervalMillis = 900_000;
  logs.getLogger("inherited-stats").emit({ body: "retained" });
  if (deferred) {
    resolve(connectionString);
    await Promise.resolve();
  }
  await clock.advance(2000);
  await vi.waitFor(() =>
    expect(totals()).toEqual({
      "Item_Success_Count:TRACE": 1,
    }),
  );
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 100);
});

it.each([false, true])(
  "excludes sampling drops and preserves retained resource dimensions with a deferred destination: %s",
  async (deferred) => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => (resolve = done));
    const handle = await useMicrosoftOpenTelemetry({
      azureMonitor: {
        connectionString: deferred ? pending : connectionString,
        sdkStats: { enabled: true },
      },
      resource: detectResources({
        detectors: [
          {
            detect: () => ({
              attributes: {
                "service.name": Promise.resolve("sampling-app"),
                "service.instance.id": Promise.resolve("sampling-instance"),
                "enduser.id": "private-user",
              },
            }),
          },
        ],
      }),
      samplingPercentage: 0,
      pageView: { enabled: false },
      storage: { enabled: false },
      session: { enabled: false },
    });
    owners.push(handle);
    trace.getTracer("sampling-dimensions").startSpan("request", { kind: SpanKind.SERVER }).end();
    logs.getLogger("sampling-dimensions").emit({ body: "private-body" });
    if (deferred) {
      expect(fetch).not.toHaveBeenCalled();
      resolve(connectionString);
      await Promise.resolve();
    }
    await handle.forceFlush();
    expect(fetch).not.toHaveBeenCalled();
    expect(totals()).toEqual({});
    await handle.updateCfg({ samplingPercentage: 100 });
    trace.getTracer("sampling-dimensions").startSpan("request", { kind: SpanKind.SERVER }).end();
    logs.getLogger("sampling-dimensions").emit({ body: "private-body" });
    await handle.forceFlush();
    expect(totals()).toEqual({
      "Item_Success_Count:REQUEST": 1,
      "Item_Success_Count:TRACE": 1,
    });
    for (const envelope of reports.flat()) {
      expect(envelope.tags).toEqual({
        "ai.internal.sdkVersion": expect.any(String),
        "ai.cloud.role": "sampling-app",
        "ai.cloud.roleInstance": "sampling-instance",
      });
      expect(envelope.data.baseData.properties?.telemetrySuccess).toBeUndefined();
    }
    expect(JSON.stringify(reports)).not.toContain("private");
  },
);

it("sends no customer items or stats for trace and log sampling at zero percent", async () => {
  const handle = await initialize(TEST_INSTRUMENTATION_KEY, 0);
  trace.getTracer("sample").startSpan("private span", { kind: SpanKind.SERVER }).end();
  logs.getLogger("sample").emit({ eventName: "private event", body: "private body" });
  await handle.forceFlush();
  expect(totals()).toEqual({});
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(reports)).not.toContain("private");
  const tracer = trace.getTracer("stale");
  await handle.shutdown();
  tracer.startSpan("after shutdown").end();
  await handle.forceFlush();
  expect(fetch).not.toHaveBeenCalled();
});

it("excludes the default parent-based sampler's drops", async () => {
  const handle = await initialize();
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    traceFlags: 0,
  });
  trace.getTracer("parent").startSpan("child", {}, parent).end();
  await handle.forceFlush();
  expect(totals()).toEqual({});
  expect(fetch).not.toHaveBeenCalled();
});

it("counts only retained items across runtime sampling policy changes", async () => {
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
  });
});

it("excludes sampled items using the emission-time log policy while the destination resolves", async () => {
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
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Success_Count:TRACE": 1,
  });
});

it.each([0, 1])(
  "excludes deferred startup overflow from customer counters with capacity %s",
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
      resource: resourceFromAttributes({
        "service.name": "startup-app",
        "service.instance.id": "startup-instance",
      }),
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
    tracer
      .startSpan("another request", { kind: SpanKind.CONSUMER })
      .setStatus({ code: SpanStatusCode.ERROR })
      .end();
    expect(fetch).not.toHaveBeenCalled();
    resolve(connectionString);
    await Promise.resolve();
    await handle.forceFlush();
    expect(totals()).toEqual({
      ...(initInMemoMaxSize ? { "Item_Success_Count:TRACE": 1 } : {}),
    });
    expect(diag.warn).toHaveBeenCalledWith("Telemetry startup queue full; dropping new items");
    for (const envelope of reports.flat()) {
      expect(envelope.tags["ai.cloud.role"]).toBe("startup-app");
      expect(envelope.tags["ai.cloud.roleInstance"]).toBe("startup-instance");
    }
    tracer.startSpan("after activation").end();
    logger.emit({ body: "after activation" });
    await handle.shutdown();
    expect(totals()).toEqual({
      "Item_Success_Count:TRACE": initInMemoMaxSize + 1,
      "Item_Success_Count:DEPENDENCY": 1,
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
    expect(totals()).toEqual(
      samplingPercentage === 0 ? {} : { "Item_Success_Count:CUSTOM_EVENT": 1 },
    );
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
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(diag.warn).toHaveBeenCalledOnce();
    expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1 });
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
  await handle.updateCfg({ samplingPercentage: 100 });
  logger.emit({
    eventName: "browser.resource_timing",
    attributes: { "url.full": `${redirectedEndpoint}/unrelated` },
  });
  logs.getLogger("application").emit({
    eventName: "browser.resource_timing",
    attributes: { "url.full": redirectedEndpoint },
  });
  await handle.forceFlush();
  expect(totals()).toEqual({ "Item_Success_Count:CUSTOM_EVENT": 2 });
});

it("keeps opt-in and counters isolated across instances and hands off after shutdown", async () => {
  const secondKey = "22222222-2222-2222-2222-222222222222";
  const first = await initialize(TEST_INSTRUMENTATION_KEY, 100, false);
  const second = await initialize(secondKey, 100);
  trace.getTracer("first").startSpan("not reported").end();
  logs.getLogger("first").emit({ body: "not reported" });
  await first.shutdown();
  expect(reports).toHaveLength(0);
  trace.getTracer("second").startSpan("reported").end();
  logs.getLogger("second").emit({ body: "reported" });
  await second.shutdown();
  expect(reports.flat().every((envelope) => envelope.iKey === secondKey)).toBe(true);
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Success_Count:TRACE": 1,
  });
});

it.each([false, true])(
  "filters only exact shared configured and redirect URLs in standalone logs when enabled: %s",
  async (enabled) => {
    const configured = "https://standalone-filter.example.test/v2/track";
    const redirected = "https://standalone-filter.example.test/ingest?tenant=one";
    const peer = new Sender({
      endpoint: configured,
      fetch: async () => redirectResponse(redirected),
    });
    await peer.send(request());
    const exporter = createExporter("logs", {
      connectionString,
      sdkStats: { enabled },
    });
    const records = [
      resourceTiming(configured),
      resourceTiming(redirected),
      resourceTiming(`${configured}?application=true`),
      resourceTiming("https://standalone-filter.example.test/application"),
      resourceTiming("https://unconfigured.services.visualstudio.com/v2/track"),
      { ...resourceTiming(configured), instrumentationScope: { name: "application" } },
      { ...resourceTiming(redirected), eventName: "application.event" },
    ];
    const result = await exportAsync(exporter, records);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    const [url, init] = fetch.mock.calls[0];
    const envelopes: AzureMonitorEnvelope[] = await new Request(url, init).json();
    expect(envelopes).toHaveLength(enabled ? 5 : 7);
    expect(envelopes.map((envelope) => envelope.data.baseData.properties?.["url.full"])).toEqual(
      records.slice(enabled ? 2 : 0).map((record) => record.attributes["url.full"]),
    );
    await exporter.forceFlush();
    expect(totals()).toEqual(enabled ? { "Item_Success_Count:CUSTOM_EVENT": 5 } : {});
  },
);

it.each([false, true])(
  "constructs standalone exporters beside an incompatible distribution registry (stats: %s)",
  async (enabled) => {
    const key = Symbol.for("@microsoft/opentelemetry-browser");
    const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const previous = Object.getOwnPropertyDescriptor(realm, key);
    const incompatible = { version: 2 };
    realm[key] = incompatible;
    try {
      const options = { connectionString, sdkStats: { enabled } };
      const spans = createExporter("spans", options);
      const logExporter = createExporter("logs", options);
      await expect(exportAsync(spans, [createReadableSpan()])).resolves.toEqual({
        code: ExportResultCode.SUCCESS,
      });
      await expect(
        exportAsync(logExporter, [
          resourceTiming(`${endpoint}/v2/track`),
          createReadableLogRecord(),
        ]),
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      const [url, init] = fetch.mock.calls[1];
      const envelopes: AzureMonitorEnvelope[] = await new Request(url, init).json();
      expect(envelopes).toHaveLength(enabled ? 1 : 2);
      await Promise.all([spans.forceFlush(), logExporter.forceFlush()]);
      expect(totals()).toEqual(
        enabled ? { "Item_Success_Count:DEPENDENCY": 1, "Item_Success_Count:TRACE": 1 } : {},
      );
      expect(realm[key]).toBe(incompatible);
    } finally {
      if (previous) Object.defineProperty(realm, key, previous);
      else delete realm[key];
    }
  },
);

it("bounds exact URL history while retaining recent and refreshed destinations", () => {
  const url = (index: number) => `https://redirect-history.example.test/track?request=${index}`;
  for (let index = -1; index < 256; index++) rememberSdkIngestionUrl(url(index));
  expect(isSdkIngestionUrl(url(-1))).toBe(false);
  expect(isSdkIngestionUrl(url(0))).toBe(true);
  rememberSdkIngestionUrl(`${url(0)}#ignored`);
  rememberSdkIngestionUrl(url(256));
  expect(isSdkIngestionUrl(url(0))).toBe(true);
  expect(isSdkIngestionUrl(url(1))).toBe(false);
  expect(isSdkIngestionUrl(url(2))).toBe(true);
  expect(isSdkIngestionUrl(url(256))).toBe(true);
  expect(isSdkIngestionUrl(`${url(256)}&application=true`)).toBe(false);
});

it.each([false, true])(
  "protects live shared destinations through redirect churn and releases them on shutdown (stats: %s)",
  async (enabled) => {
    const protectedEndpoint = `https://active-sdk-${enabled}.example.test`;
    const options = {
      connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${protectedEndpoint}`,
      sdkStats: { enabled },
    };
    const first = createExporter("spans", options);
    const second = createExporter("logs", options);
    const url = `${protectedEndpoint}/v2/track`;
    for (const owner of [first, second]) {
      churnIngestionUrls();
      expect(isSdkIngestionUrl(url)).toBe(true);
      await owner.shutdown();
      await owner.shutdown();
    }
    expect(isSdkIngestionUrl(url)).toBe(true);
    churnIngestionUrls();
    expect(isSdkIngestionUrl(url)).toBe(false);
  },
);

it.each(["success", "failure", "disposed"] as const)(
  "protects in-flight URLs without leaking ownership after %s",
  async (outcome) => {
    const original = `https://attempt-${outcome}.example.test/v2/track`;
    const redirected = `https://attempt-${outcome}.example.test/redirected`;
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const transport = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      )
      .mockImplementation(async () => redirectResponse(redirected));
    const sender = new Sender({ endpoint: original, fetch: transport });
    const pending = sender.send({ ...request(), retry: false });
    const expected =
      outcome === "failure"
        ? expect(pending).rejects.toThrow("Browser transport failed")
        : expect(pending).resolves.toMatchObject({ statusCode: 200 });
    await sender.send(request());
    if (outcome === "disposed") sender.dispose();
    churnIngestionUrls();
    expect(isSdkIngestionUrl(original)).toBe(true);
    if (outcome === "failure") reject(new TypeError("offline"));
    else resolve(redirectResponse(redirected));
    await expected;
    expect(isSdkIngestionUrl(original)).toBe(true);
    churnIngestionUrls();
    expect(isSdkIngestionUrl(original)).toBe(false);
    expect(isSdkIngestionUrl(redirected)).toBe(outcome !== "disposed");
    sender.dispose();
  },
);
