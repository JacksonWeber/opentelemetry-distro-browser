// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";
import { AzureMonitorSpanExporter } from "../../../src/exporter/trace.js";
import { beginUnloading, endUnloading, getSdkVersion } from "../../../src/exporter/common.js";
import {
  createInternalSdkStats,
  type InternalSdkStats,
  type InternalSdkStatsConfiguration,
} from "../../../src/exporter/sdkStats.js";
import * as statsConfiguration from "../../../src/exporter/sdkStatsConfiguration.js";
import { Sender } from "../../../src/exporter/sender.js";
import type { AzureMonitorEnvelope, MetricData } from "../../../src/exporter/telemetryModels.js";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../../src/index.js";
import {
  assertAzureMonitorEnvelope,
  TEST_INSTRUMENTATION_KEY,
} from "../../fixtures/azureMonitor.js";
import { installFakeClock } from "../../fixtures/clock.js";
import { createReadableLogRecord, createReadableSpan } from "../../fixtures/telemetry.js";

const STATS_KEY = "11111111-1111-1111-1111-111111111111";
const CUSTOMER_ENDPOINT = "https://customer.example.test";
const STATS_ENDPOINT = "https://stats.example.test/v2/track";
const options: InternalSdkStatsConfiguration = {
  instrumentationKey: STATS_KEY,
  endpoint: STATS_ENDPOINT,
};
const instances: InternalSdkStats[] = [];
let payloads: AzureMonitorEnvelope<MetricData>[][];
let transport: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

beforeEach(() => {
  payloads = [];
  vi.mocked(statsConfiguration.getInternalSdkStatsConfiguration).mockReturnValue(options);
  vi.stubGlobal("CompressionStream", undefined);
  vi.spyOn(diag, "warn").mockImplementation(() => {});
  transport = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(init?.method).toBe("POST");
    expect(url).toBe(STATS_ENDPOINT);
    const envelopes: AzureMonitorEnvelope<MetricData>[] = JSON.parse(
      await new Request(url, init).text(),
    );
    payloads.push(envelopes);
    return Response.json({
      itemsReceived: envelopes.length,
      itemsAccepted: envelopes.length,
      errors: [],
    });
  });
  vi.stubGlobal("fetch", transport);
});

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((stats) => stats.shutdown()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function createStats(
  overrides: Partial<InternalSdkStatsConfiguration> = {},
  endpoint = CUSTOMER_ENDPOINT,
) {
  const stats = createInternalSdkStats(
    { ...options, ...overrides },
    TEST_INSTRUMENTATION_KEY,
    endpoint,
  );
  instances.push(stats);
  return stats;
}

function metrics(envelopes = payloads.flat()) {
  return Object.fromEntries(
    envelopes.map(({ data: { baseData } }) => [
      [
        baseData.metrics[0].name,
        baseData.properties?.statusCode ?? baseData.properties?.exceptionType,
      ]
        .filter(Boolean)
        .join(":"),
      baseData.metrics[0].value,
    ]),
  );
}

it("sends the reference metric names, status buckets, average duration and separate destination key", async () => {
  const stats = createStats({}, `${CUSTOMER_ENDPOINT}/private-path?secret=value`);
  const statuses = [200, 201, 206, 400, 401, 403, 408, 429, 500, 502, 503, 504, 402, 439, 307, 308];
  for (const status of statuses) stats.countResponse(status, 40);
  stats.countException(new TypeError("private network details"));
  stats.countException(new DOMException("private timeout details", "TimeoutError"));
  stats.countException(new Error("private client details"));
  expect(transport).not.toHaveBeenCalled();
  await stats.forceFlush();

  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0][1]).toMatchObject({
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  expect(metrics()).toEqual({
    Request_Duration: 40,
    Request_Success_Count: 3,
    "Request_Failure_Count:400": 1,
    "Retry_Count:401": 1,
    "Retry_Count:403": 1,
    "Retry_Count:408": 1,
    "Retry_Count:429": 1,
    "Retry_Count:500": 1,
    "Retry_Count:502": 1,
    "Retry_Count:503": 1,
    "Retry_Count:504": 1,
    "Throttle_Count:402": 1,
    "Throttle_Count:439": 1,
    "Exception_Count:Network exception": 1,
    "Exception_Count:Timeout exception": 1,
    "Exception_Count:Client exception": 1,
  });
  for (const envelope of payloads.flat()) {
    assertAzureMonitorEnvelope(envelope);
    expect(envelope.iKey).toBe(STATS_KEY);
    expect(envelope.tags).toEqual({
      "ai.internal.sdkVersion": getSdkVersion(),
    });
    expect(envelope.data.baseData.properties).toMatchObject({
      rp: "unknown",
      attach: "Manual",
      cikey: TEST_INSTRUMENTATION_KEY,
      os: "Browser",
      language: "JavaScript",
      version: `mot${OPENTELEMETRY_BROWSER_VERSION}`,
      endpoint: "breeze",
      host: "customer",
    });
  }
  expect(JSON.stringify(payloads)).not.toMatch(/private|secret/);
  await stats.forceFlush();
  await stats.shutdown();
  expect(transport).toHaveBeenCalledOnce();
});

it("starts the default hour-long window with the first response and stops on shutdown", async () => {
  const clock = installFakeClock();
  const stats = createStats();
  await stats.forceFlush();
  expect(transport).not.toHaveBeenCalled();
  stats.countResponse(200, 10);
  await clock.advance(3_599_999);
  expect(payloads).toHaveLength(0);
  await clock.advance(1);
  await vi.waitFor(() =>
    expect(metrics()).toEqual({ Request_Duration: 10, Request_Success_Count: 1 }),
  );
  stats.countResponse(200, 20);
  await stats.shutdown();
  expect(payloads).toHaveLength(2);
  stats.countResponse(500, 30);
  stats.countException(new Error("stale"));
  await clock.advance(7_200_000);
  expect(payloads).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops the timer immediately while shutdown waits for a pending customer request", async () => {
  const clock = installFakeClock();
  const stats = createStats();
  stats.countResponse(200, 10);
  await stats.forceFlush();
  stats.countResponse(200, 20);
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const stopping = stats.shutdown(pending);
  await clock.advance(7_200_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(payloads).toHaveLength(1);
  stats.countResponse(200, 40);
  complete();
  await stopping;
  expect(metrics(payloads[1])).toEqual({ Request_Duration: 30, Request_Success_Count: 2 });
});

it("reports transport failures without fetching configuration or replaying the failed report", async () => {
  transport.mockRejectedValueOnce(new TypeError("offline"));
  const stats = createStats();
  stats.countResponse(200, 10);
  await stats.forceFlush();
  stats.countResponse(200, 30);
  await stats.forceFlush();
  expect(metrics()).toEqual({ Request_Duration: 30, Request_Success_Count: 1 });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(
    transport.mock.calls.every(([url, init]) => url === STATS_ENDPOINT && init?.method === "POST"),
  ).toBe(true);
  expect(diag.warn).toHaveBeenCalledWith(
    "SDK stats export failed",
    expect.objectContaining({ cause: expect.objectContaining({ message: "offline" }) }),
  );
});

it("accepts the production collector's success response without an errors field", async () => {
  transport.mockResolvedValueOnce(Response.json({ itemsAccepted: 2, itemsReceived: 2 }));
  const stats = createStats();
  stats.countResponse(200, 40);
  await stats.forceFlush();
  expect(transport).toHaveBeenCalledOnce();
  expect(diag.warn).not.toHaveBeenCalled();
});

it("exports a valid zero-duration average instead of dropping the measurement", async () => {
  const stats = createStats();
  stats.countResponse(200, 0);
  stats.countResponse(200, 0);
  await stats.forceFlush();
  expect(metrics()).toEqual({ Request_Duration: 0, Request_Success_Count: 2 });
  payloads.flat().forEach(assertAzureMonitorEnvelope);
});

it.each(["forceFlush", "shutdown", "timer"] as const)(
  "contains a throwing diagnostic logger during stats %s",
  async (operation) => {
    const clock = installFakeClock();
    const stats = createStats();
    vi.mocked(diag.warn).mockImplementation(() => {
      throw new Error("Diagnostic logger failed");
    });
    transport.mockRejectedValue(new TypeError("Stats network failed"));
    stats.countResponse(200, 10);
    if (operation === "timer") {
      await clock.advance(3_600_000);
      expect(diag.warn).toHaveBeenCalled();
    } else {
      await expect(stats[operation]()).resolves.toBeUndefined();
    }
  },
);

it("reports the ingestion stamp rather than a full origin as required by the SDK stats schema", async () => {
  const stats = createStats({}, "https://westus2-2.in.applicationinsights.azure.com");
  stats.countResponse(200, 40);
  await stats.forceFlush();
  expect(
    payloads.flat().every((envelope) => envelope.data.baseData.properties?.host === "westus2-2"),
  ).toBe(true);
});

it.each([
  { instrumentationKey: "" },
  { endpoint: "" },
  { endpoint: "http://stats.example.test/v2/track" },
  { endpoint: "https://user:secret@stats.example.test/v2/track" },
  { endpoint: "https://stats.example.test/v2/track#fragment" },
  { endpoint: "https://stats.example.test/v2/track?query=secret" },
  { endpoint: "file:///stats" },
  { collectionIntervalMillis: 0 },
  { collectionIntervalMillis: Infinity },
  { collectionIntervalMillis: 2_147_483_648 },
  { samplingPercentage: -1 },
  { samplingPercentage: 101 },
  { samplingPercentage: NaN },
])("rejects invalid explicit options %j before sending anything", (overrides) => {
  expect(() => createStats(overrides)).toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it("does not collect, schedule or send at zero percent", async () => {
  const clock = installFakeClock();
  const stats = createStats({ samplingPercentage: 0 });
  stats.countResponse(200, 10);
  stats.countException(new Error("ignored"));
  await stats.forceFlush();
  await clock.advance(3_600_000);
  expect(transport).not.toHaveBeenCalled();
});

it("samples each metric independently and stamps the stats sampling percentage", async () => {
  vi.spyOn(Math, "random").mockReturnValueOnce(0.75).mockReturnValueOnce(0.25);
  const stats = createStats({ samplingPercentage: 50 });
  stats.countResponse(200, 10);
  await stats.forceFlush();
  expect(metrics()).toEqual({ Request_Success_Count: 1 });
  expect(payloads[0][0].sampleRate).toBe(50);
});

it("shares concurrent flushes and preserves requests recorded during delivery for the next window", async () => {
  let finish!: (response: Response) => void;
  const normal = transport.getMockImplementation()!;
  transport.mockImplementation(async (url, init) => {
    const response = await normal(url, init);
    if (init?.method === "POST" && payloads.length === 1) {
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return response;
  });
  const stats = createStats();
  stats.countResponse(200, 10);
  const first = stats.forceFlush();
  expect(stats.forceFlush()).toBe(first);
  await vi.waitFor(() => expect(payloads).toHaveLength(1));
  stats.countResponse(200, 30);
  finish(new Response(null));
  await first;
  await stats.forceFlush();
  expect(metrics(payloads[0])).toEqual({ Request_Duration: 10, Request_Success_Count: 1 });
  expect(metrics(payloads[1])).toEqual({ Request_Duration: 30, Request_Success_Count: 1 });
});

it("bounds a stalled stats request and aborts it", async () => {
  const clock = installFakeClock();
  let signal: AbortSignal | null | undefined;
  transport.mockImplementation(async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  });
  const stats = createStats();
  stats.countResponse(200, 10);
  const flushing = stats.forceFlush();
  await vi.waitFor(() => expect(signal).toBeDefined());
  await clock.advance(10_000);
  await flushing;
  expect(diag.warn).toHaveBeenCalledWith(
    "SDK stats export failed",
    expect.objectContaining({ message: "Operation timed out." }),
  );
  expect(signal?.aborted).toBe(true);
});

it.each([400, 206, 503])(
  "surfaces stats HTTP %s without retrying or counting its own failed report",
  async (status) => {
    const clock = installFakeClock();
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      return init?.method === "POST" ? new Response(null, { status }) : response;
    });
    const stats = createStats();
    stats.countResponse(200, 10);
    await stats.forceFlush();
    expect(diag.warn).toHaveBeenCalledWith(
      "SDK stats export failed",
      expect.objectContaining({ message: `SDK stats ingestion failed: HTTP ${status}.` }),
    );
    await clock.advance(3_600_000);
    await stats.forceFlush();
    expect(transport).toHaveBeenCalledOnce();
  },
);

it("does not delay a later stats window behind a failed report's Retry-After", async () => {
  const normal = transport.getMockImplementation()!;
  let failed = false;
  transport.mockImplementation(async (url, init) => {
    const response = await normal(url, init);
    if (init?.method === "POST" && !failed) {
      failed = true;
      return new Response(null, { status: 503, headers: { "retry-after": "86400" } });
    }
    return response;
  });
  const stats = createStats();
  stats.countResponse(200, 10);
  await stats.forceFlush();
  expect(diag.warn).toHaveBeenCalledWith(
    "SDK stats export failed",
    expect.objectContaining({ message: "SDK stats ingestion failed: HTTP 503." }),
  );
  stats.countResponse(200, 20);
  await stats.forceFlush();
  expect(payloads).toHaveLength(2);
  expect(metrics(payloads[1])).toEqual({ Request_Duration: 20, Request_Success_Count: 1 });
});

it("counts every customer attempt without counting its own stats send", async () => {
  const stats = createStats();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const sender = new Sender({
    endpoint: `${CUSTOMER_ENDPOINT}/v2/track`,
    stats,
    fetch,
    delay: async () => {},
  });
  await sender.send({ body: new TextEncoder().encode("[]"), contentType: "application/json" });
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(metrics()).toMatchObject({
    "Exception_Count:Network exception": 1,
    "Retry_Count:502": 1,
    Request_Success_Count: 1,
  });
  expect(transport).toHaveBeenCalledOnce();
});

it("counts response-body failures once without hiding the HTTP status", async () => {
  const stats = createStats();
  const response = new Response(null);
  vi.spyOn(response, "text").mockRejectedValue(new TypeError("body failed"));
  const sender = new Sender({
    endpoint: CUSTOMER_ENDPOINT,
    stats,
    fetch: async () => response,
  });
  await expect(
    sender.send({
      body: new TextEncoder().encode("[]"),
      contentType: "application/json",
    }),
  ).rejects.toThrow("body failed");
  await stats.forceFlush();
  expect(metrics()).toMatchObject({
    Request_Success_Count: 1,
    "Exception_Count:Network exception": 1,
  });
});

it.each([true, false])(
  "does not mistake beacon queue acceptance %s for an HTTP success",
  async (queued) => {
    const stats = createStats();
    const sender = new Sender({
      endpoint: CUSTOMER_ENDPOINT,
      stats,
      fetch: async () => {
        throw new TypeError("offline");
      },
      sendBeacon: () => queued,
    });
    const sending = sender.send({
      body: new TextEncoder().encode("[]"),
      contentType: "application/json",
      unloading: true,
    });
    if (queued) await expect(sending).resolves.toEqual({ transport: "beacon" });
    else await expect(sending).rejects.toThrow("could not queue");
    await stats.forceFlush();
    expect(metrics()).toEqual({
      "Exception_Count:Network exception": 1,
      ...(queued ? {} : { "Exception_Count:Client exception": 1 }),
    });
  },
);

it("sends stats using keepalive without disclosing the page referrer", async () => {
  const stats = createStats();
  stats.countResponse(200, 10);
  beginUnloading();
  try {
    await stats.forceFlush();
    expect(transport.mock.calls[0][1]).toMatchObject({
      keepalive: true,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(payloads).toHaveLength(1);
  } finally {
    endUnloading();
  }
});

it("does not fall back to beacon because beacon cannot suppress private page referrers", async () => {
  const stats = createStats();
  const beacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
  stats.countResponse(200, 10);
  await stats.forceFlush();
  stats.countResponse(200, 10);
  transport.mockRejectedValueOnce(new TypeError("keepalive unavailable"));
  beginUnloading();
  try {
    await stats.forceFlush();
    const [, init] = transport.mock.calls.at(-1)!;
    expect(init?.keepalive).toBe(true);
    expect(beacon).not.toHaveBeenCalled();
    expect(diag.warn).toHaveBeenCalledWith(
      "SDK stats export failed",
      expect.objectContaining({
        message: "sendBeacon fallback is unavailable for the unload request.",
      }),
    );
  } finally {
    endUnloading();
  }
});

it.each(["spans", "logs"] as const)(
  "flushes internal %s exporter stats without accepting caller-supplied stats configuration",
  async (signal) => {
    vi.mocked(statsConfiguration.getInternalSdkStatsConfiguration).mockReturnValue(options);
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, init) =>
      url === `${CUSTOMER_ENDPOINT}/v2/track` ? new Response(null) : normal(url, init),
    );
    const exporterOptions = {
      connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${CUSTOMER_ENDPOINT}`,
      sdkStats: {
        instrumentationKey: "22222222-2222-2222-2222-222222222222",
        endpoint: "https://unexpected.example.test/v2/track",
      },
    };
    const callback = vi.fn();
    const exporter =
      signal === "spans"
        ? new AzureMonitorSpanExporter(exporterOptions)
        : new AzureMonitorLogRecordExporter(exporterOptions);
    const send = () => {
      if (exporter instanceof AzureMonitorSpanExporter)
        exporter.export([createReadableSpan()], callback);
      else exporter.export([createReadableLogRecord()], callback);
    };
    try {
      send();
      await exporter.forceFlush();
      expect(callback).toHaveBeenCalledExactlyOnceWith({ code: ExportResultCode.SUCCESS });
      expect(metrics()).toMatchObject({ Request_Success_Count: 1 });
      expect(payloads.flat().every((envelope) => envelope.iKey === STATS_KEY)).toBe(true);
      expect(statsConfiguration.getInternalSdkStatsConfiguration).toHaveBeenCalledWith(
        CUSTOMER_ENDPOINT,
      );
      send();
      await exporter.shutdown();
      expect(payloads).toHaveLength(2);
      send();
      expect(callback).toHaveBeenLastCalledWith({
        code: ExportResultCode.FAILED,
        error: expect.objectContaining({ message: "Exporter has been shut down." }),
      });
    } finally {
      await exporter.shutdown();
    }
  },
);

it.each(["network", "HTTP"] as const)(
  "does not fail customer exports, forceFlush or shutdown after a stats %s failure",
  async (failure) => {
    vi.mocked(statsConfiguration.getInternalSdkStatsConfiguration).mockReturnValue(options);
    transport.mockImplementation(async (url) => {
      if (url === `${CUSTOMER_ENDPOINT}/v2/track`) return new Response(null);
      if (failure === "network") throw new TypeError("Network failed");
      return new Response(null, { status: 503 });
    });
    const exporter = new AzureMonitorSpanExporter({
      connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${CUSTOMER_ENDPOINT}`,
    });
    const callback = vi.fn();
    exporter.export([createReadableSpan()], callback);
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledExactlyOnceWith({ code: ExportResultCode.SUCCESS });
    await expect(exporter.shutdown()).resolves.toBeUndefined();
    expect(diag.warn).toHaveBeenCalledWith("SDK stats export failed", expect.any(Error));
  },
);
