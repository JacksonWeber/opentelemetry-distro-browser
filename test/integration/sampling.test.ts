// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, expect, it, vi } from "vitest";
import type { AzureMonitorEnvelope } from "../../src/exporter/telemetryModels.js";
import { AZURE_MONITOR_SAMPLE_RATE, getSamplingScore, isTraceSampled } from "../../src/sampling.js";
import { useMicrosoftOpenTelemetry, type MicrosoftOpenTelemetryBrowser } from "../../src/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;" +
  "IngestionEndpoint=https://example.test";
let handle: MicrosoftOpenTelemetryBrowser | undefined;

afterEach(async () => {
  try {
    await handle?.shutdown();
  } finally {
    handle = undefined;
    trace.disable();
    logs.disable();
    propagation.disable();
    context.disable();
    diag.disable();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

async function decodeRequest(init: RequestInit | undefined): Promise<AzureMonitorEnvelope[]> {
  let stream = new Blob([init?.body as Uint8Array<ArrayBuffer>]).stream();
  if (new Headers(init?.headers).get("content-encoding") === "gzip") {
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  return new Response(stream).json();
}

function traceIdSampledAt(percentage: number): string {
  for (let value = 1; ; value++) {
    const traceId = value.toString(16).padStart(32, "0");
    if (isTraceSampled(traceId, percentage)) return traceId;
  }
}

it("retains a page view, child span, and correlated log with one effective rate", async () => {
  const pipeline = createInMemoryPipeline();
  const pageTraceId = traceIdSampledAt(25);
  const pageBytes = Uint8Array.from(pageTraceId.match(/../g)!, (byte) => Number.parseInt(byte, 16));
  const crypto = globalThis.crypto;
  let pageViewCreated = false;
  vi.stubGlobal("crypto", {
    ...crypto,
    getRandomValues: <T extends ArrayBufferView>(target: T): T => {
      if (!pageViewCreated && target.byteLength === 16) {
        new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(pageBytes);
        return target;
      }
      return crypto.getRandomValues(target);
    },
  });
  const requests: Promise<AzureMonitorEnvelope[]>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
    requests.push(decodeRequest(init));
    return Promise.resolve(new Response(null, { status: 200 }));
  });
  vi.stubGlobal("fetch", fetch);
  let pageReady!: () => void;
  const emitted = new Promise<void>((resolve) => {
    pageReady = resolve;
  });

  handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    samplingPercentage: 25,
    azureMonitor: { connectionString },
    pageView: {
      applyCustomLogRecordData: () => {
        pageViewCreated = true;
        pageReady();
      },
    },
  });
  await emitted;
  trace.getTracer("sampling-integration").startSpan("page-child").end();
  logs.getLogger("sampling-integration").emit({ eventName: "page-log" });
  await handle.forceFlush();

  const envelopes = (await Promise.all(requests)).flat();
  const pageGroup = envelopes.filter(
    (envelope) => envelope.tags["ai.operation.id"] === pageTraceId,
  );
  expect(pageGroup.map((envelope) => envelope.data.baseType)).toEqual(
    expect.arrayContaining(["PageViewData", "RemoteDependencyData", "EventData"]),
  );
  expect(pageGroup).not.toHaveLength(0);
  expect(pageGroup.every((envelope) => envelope.sampleRate === 25)).toBe(true);
  const callerLog = pipeline.logExporter
    .getFinishedLogRecords()
    .find((record) => record.eventName === "page-log");
  expect(callerLog).toBeDefined();
  expect(callerLog?.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBeUndefined();
});

it("rejects an unsampled page group only from Azure Monitor log export", async () => {
  const pipeline = createInMemoryPipeline();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  let pageReady!: () => void;
  const emitted = new Promise<void>((resolve) => {
    pageReady = resolve;
  });

  handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    samplingPercentage: 0,
    azureMonitor: { connectionString },
    pageView: { applyCustomLogRecordData: () => pageReady() },
  });
  await emitted;
  trace.getTracer("sampling-integration").startSpan("rejected-child").end();
  logs.getLogger("sampling-integration").emit({ eventName: "caller-visible-log" });
  await handle.forceFlush();

  expect(fetch).not.toHaveBeenCalled();
  expect(pipeline.spanExporter.getFinishedSpans()).toEqual([]);
  expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual(
    expect.arrayContaining(["browser.page_view", "caller-visible-log"]),
  );
});

it("samples unrelated root trace IDs at approximately the configured percentage", async () => {
  const pipeline = createInMemoryPipeline();
  handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    samplingPercentage: 25,
    pageView: { enabled: false },
  });

  for (let index = 0; index < 1_000; index++) {
    trace.getTracer("sampling-distribution").startSpan(`root-${index}`).end();
  }
  await handle.forceFlush();

  const sampled = pipeline.spanExporter.getFinishedSpans();
  expect(sampled.length).toBeGreaterThan(180);
  expect(sampled.length).toBeLessThan(320);
  expect(sampled.every((span) => getSamplingScore(span.spanContext().traceId) < 25)).toBe(true);
});
