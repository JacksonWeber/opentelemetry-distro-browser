// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";
import { AzureMonitorSpanExporter } from "../../../src/exporter/trace.js";
import { createInternalSdkStats } from "../../../src/exporter/sdkStats.js";
import * as configuration from "../../../src/exporter/sdkStatsConfiguration.js";
import { Sender } from "../../../src/exporter/sender.js";
import type { AzureMonitorEnvelope, MetricData } from "../../../src/exporter/telemetryModels.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";
import { installFakeClock } from "../../fixtures/clock.js";
import { SDK_STATS_ENDPOINT } from "../../fixtures/sdkStats.js";
import { createReadableLogRecord, createReadableSpan } from "../../fixtures/telemetry.js";

const actual = await vi.importActual<typeof configuration>(
  "../../../src/exporter/sdkStatsConfiguration.js",
);
const globalEndpoint = "https://dc.services.visualstudio.com";
const westEndpoint = "https://westus2-2.in.applicationinsights.azure.com";
const eastEndpoint = "https://eastus-1.in.applicationinsights.azure.com";
const euEndpoint = "https://westeurope-5.in.applicationinsights.azure.com";
const request = { body: new TextEncoder().encode("[]"), contentType: "application/json" };
let reports: AzureMonitorEnvelope<MetricData>[][];
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

beforeEach(() => {
  vi.stubGlobal("CompressionStream", undefined);
  vi.mocked(configuration.getInternalSdkStatsConfiguration).mockImplementation(
    actual.getInternalSdkStatsConfiguration,
  );
  reports = [];
  fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (url === SDK_STATS_ENDPOINT) {
      reports.push(JSON.parse(await new Request(url, init).text()));
    }
    return new Response(null);
  });
  vi.stubGlobal("fetch", fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function redirected(endpoint: string): Response {
  const response = new Response(null);
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: `${endpoint}/v2/track` },
  });
  return response;
}

function successCount(): number {
  return reports
    .flat()
    .reduce(
      (total, envelope) =>
        total +
        (envelope.data.baseData.metrics[0].name === "Request_Success_Count"
          ? envelope.data.baseData.metrics[0].value
          : 0),
      0,
    );
}

it.each(["spans", "logs"] as const)(
  "updates %s stats after accepted redirects without leaking EU counters",
  async (signal) => {
    const options = {
      connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${globalEndpoint}`,
    };
    const exporter =
      signal === "spans"
        ? new AzureMonitorSpanExporter(options)
        : new AzureMonitorLogRecordExporter(options);
    const send = () =>
      new Promise<void>((resolve) => {
        if (exporter instanceof AzureMonitorSpanExporter)
          exporter.export([createReadableSpan()], () => resolve());
        else exporter.export([createReadableLogRecord()], () => resolve());
      });
    try {
      await send();
      fetch.mockResolvedValueOnce(redirected(euEndpoint));
      await send();
      await exporter.forceFlush();
      expect(reports).toEqual([]);
      await send();
      expect(fetch.mock.calls.at(-1)?.[0]).toBe(`${euEndpoint}/v2/track`);
      fetch.mockResolvedValueOnce(redirected(westEndpoint));
      await send();
      await exporter.forceFlush();
      expect(successCount()).toBe(2);
      expect(
        reports.flat().every((envelope) => envelope.data.baseData.properties?.host === "westus2-2"),
      ).toBe(true);
    } finally {
      await exporter.shutdown();
    }
  },
);

it("enables stats when an initially excluded EU sender accepts a non-EU redirect", async () => {
  const exporter = new AzureMonitorSpanExporter({
    connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${euEndpoint}`,
  });
  fetch.mockResolvedValueOnce(redirected(eastEndpoint));
  try {
    exporter.export([createReadableSpan()], () => {});
    await exporter.forceFlush();
    expect(successCount()).toBe(1);
    expect(reports[0][0].data.baseData.properties?.host).toBe("eastus-1");
  } finally {
    await exporter.shutdown();
  }
});

it.each([
  "IngestionEndpoint=https://usgovvirginia-0.in.applicationinsights.azure.us",
  "EndpointSuffix=applicationinsights.azure.us;Location=usgovvirginia",
  "EndpointSuffix=applicationinsights.azure.microsoft.scloud;Location=usseceast",
])("keeps stats off for government connection string %s", async (destination) => {
  const exporter = new AzureMonitorSpanExporter({
    connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};${destination}`,
  });
  try {
    exporter.export([createReadableSpan()], () => {});
    await exporter.forceFlush();
    expect(reports).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    await exporter.shutdown();
  }
});

it("ignores an untrusted redirected endpoint without changing the stats stamp", async () => {
  const stats = createInternalSdkStats(
    actual.getInternalSdkStatsConfiguration(westEndpoint),
    TEST_INSTRUMENTATION_KEY,
    westEndpoint,
  );
  const sender = new Sender({ endpoint: `${westEndpoint}/v2/track`, stats });
  fetch.mockResolvedValueOnce(redirected("https://westeurope.evil.example"));
  try {
    await sender.send(request);
    await stats.forceFlush();
    expect(reports[0][0].data.baseData.properties?.host).toBe("westus2-2");
    expect(configuration.getInternalSdkStatsConfiguration).not.toHaveBeenCalled();
  } finally {
    await stats.shutdown();
  }
});

it("preserves the collection deadline and counters through a non-EU redirect", async () => {
  const clock = installFakeClock();
  const stats = createInternalSdkStats(
    {
      ...actual.getInternalSdkStatsConfiguration(westEndpoint)!,
      collectionIntervalMillis: 1000,
    },
    TEST_INSTRUMENTATION_KEY,
    westEndpoint,
  );
  const sender = new Sender({ endpoint: `${westEndpoint}/v2/track`, stats });
  try {
    await sender.send(request);
    await clock.advance(500);
    fetch.mockResolvedValueOnce(redirected(eastEndpoint));
    await sender.send(request);
    await clock.advance(499);
    expect(reports).toEqual([]);
    await clock.advance(1);
    await vi.waitFor(() => expect(successCount()).toBe(2));
    expect(reports[0][0].data.baseData.properties?.host).toBe("eastus-1");
  } finally {
    await stats.shutdown();
  }
});

it("keeps the most recently accepted concurrent redirect authoritative", async () => {
  const stats = createInternalSdkStats(
    actual.getInternalSdkStatsConfiguration(globalEndpoint),
    TEST_INSTRUMENTATION_KEY,
    globalEndpoint,
  );
  const sender = new Sender({ endpoint: `${globalEndpoint}/v2/track`, stats });
  let first!: (response: Response) => void;
  let second!: (response: Response) => void;
  fetch
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          second = resolve;
        }),
    );
  try {
    const sendingFirst = sender.send(request);
    const sendingSecond = sender.send(request);
    await vi.waitFor(() => expect(second).toBeDefined());
    second(redirected(eastEndpoint));
    await sendingSecond;
    first(redirected(westEndpoint));
    await sendingFirst;
    await stats.forceFlush();
    expect(successCount()).toBe(2);
    expect(reports[0][0].data.baseData.properties?.host).toBe("westus2-2");
    await sender.send(request);
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(`${westEndpoint}/v2/track`);
  } finally {
    await stats.shutdown();
  }
});

it("aborts a pending stats report immediately when a redirect excludes the route", async () => {
  const stats = createInternalSdkStats(
    actual.getInternalSdkStatsConfiguration(westEndpoint),
    TEST_INSTRUMENTATION_KEY,
    westEndpoint,
  );
  let signal: AbortSignal | null | undefined;
  fetch.mockImplementationOnce((_url, init) => {
    signal = init?.signal;
    return new Promise((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
    );
  });
  stats.countResponse(200, 10);
  try {
    const flushing = stats.forceFlush();
    await vi.waitFor(() => expect(signal).toBeDefined());
    stats.updateEndpoint(euEndpoint);
    expect(signal?.aborted).toBe(true);
    await flushing;
    stats.countResponse(200, 10);
    await stats.forceFlush();
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    await stats.shutdown();
  }
});
