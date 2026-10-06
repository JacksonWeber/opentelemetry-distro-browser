// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, SpanStatusCode, type SpanContext } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginUnloading, endUnloading } from "../../../src/exporter/common.js";
import { MAX_BATCH_SIZE_IN_BYTES } from "../../../src/exporter/constants.js";
import { AzureMonitorSpanExporter } from "../../../src/exporter/trace.js";
import { createMockIngestionEndpoint } from "../../fixtures/azureMonitor.js";

const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test";
const spanContext: SpanContext = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeSpan(name = "checkout"): ReadableSpan {
  return {
    name,
    kind: SpanKind.CLIENT,
    spanContext: () => spanContext,
    startTime: [1_735_689_600, 0],
    duration: [0, 1_000_000],
    status: { code: SpanStatusCode.OK },
    attributes: {},
    links: [],
    events: [],
    resource: { attributes: {} },
    instrumentationScope: { name: "test" },
  } as unknown as ReadableSpan;
}

function exportSpan(exporter: AzureMonitorSpanExporter) {
  return exportSpans(exporter, [makeSpan()]);
}

function exportSpans(exporter: AzureMonitorSpanExporter, spans: ReadableSpan[]) {
  return new Promise<{ code: ExportResultCode; error?: Error }>((resolve) => {
    exporter.export(spans, resolve);
  });
}

async function requestEnvelopes(fetch: ReturnType<typeof vi.fn>, call: number): Promise<unknown[]> {
  return JSON.parse(await requestBody(fetch, call)) as unknown[];
}

async function requestBody(fetch: ReturnType<typeof vi.fn>, call: number): Promise<string> {
  const request = fetch.mock.calls[call][1] as RequestInit;
  const response = new Response(request.body);
  return new Headers(request.headers).get("content-encoding") === "gzip"
    ? new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).text()
    : response.text();
}

describe("AzureMonitorSpanExporter", () => {
  it("rejects a connection string with an invalid instrumentation key", () => {
    expect(
      () =>
        new AzureMonitorSpanExporter({
          connectionString: "InstrumentationKey=not-an-instrumentation-key",
        }),
    ).toThrow("valid InstrumentationKey UUID");
  });

  it("maps spans, posts Breeze envelopes, and reports success", async () => {
    const ingestion = createMockIngestionEndpoint();
    vi.stubGlobal("fetch", ingestion.fetch);
    const exporter = new AzureMonitorSpanExporter({ connectionString: ingestion.connectionString });
    try {
      await expect(exportSpan(exporter)).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(ingestion.fetch).toHaveBeenCalledOnce();
      expect(ingestion.requests[0].request.url).toBe(ingestion.senderOptions.endpoint);
      expect(ingestion.requests[0].envelopes).toEqual([
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.RemoteDependency",
          iKey: "00000000-0000-0000-0000-000000000000",
        }),
      ]);
    } finally {
      await exporter.shutdown();
    }
  });

  it("splits envelopes into request-sized batches without rejecting an oversized envelope", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorSpanExporter({ connectionString });
    const first = {
      ...makeSpan(),
      name: "first",
      attributes: { payload: "x".repeat(MAX_BATCH_SIZE_IN_BYTES / 2) },
    } as ReadableSpan;
    const second = {
      ...makeSpan(),
      name: "second",
      attributes: { payload: "x".repeat(MAX_BATCH_SIZE_IN_BYTES / 2) },
    } as ReadableSpan;

    await expect(exportSpans(exporter, [first, second])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new TextEncoder().encode(await requestBody(fetch, 0)).byteLength).toBeLessThanOrEqual(
      MAX_BATCH_SIZE_IN_BYTES,
    );
    expect(new TextEncoder().encode(await requestBody(fetch, 1)).byteLength).toBeLessThanOrEqual(
      MAX_BATCH_SIZE_IN_BYTES,
    );
    // Batches are compressed concurrently, so fetch call order is not deterministic across engines.
    const batchNames = await Promise.all(
      [0, 1].map(async (call) =>
        (await requestEnvelopes(fetch, call)).map(
          (envelope) => (envelope as { data: { baseData: { name: string } } }).data.baseData.name,
        ),
      ),
    );
    expect(batchNames).toHaveLength(2);
    expect(batchNames).toEqual(expect.arrayContaining([["first"], ["second"]]));

    const oversized = {
      ...makeSpan("oversized"),
      attributes: { payload: "x".repeat(MAX_BATCH_SIZE_IN_BYTES) },
    } as ReadableSpan;
    await expect(exportSpans(exporter, [oversized])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new TextEncoder().encode(await requestBody(fetch, 2)).byteLength).toBeGreaterThan(
      MAX_BATCH_SIZE_IN_BYTES,
    );
  });

  it("retries only rejected retriable envelopes from a partial response", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            itemsReceived: 2,
            itemsAccepted: 1,
            errors: [{ index: 1, statusCode: 500, message: "Server error" }],
          }),
          { status: 206 },
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorSpanExporter({ connectionString });

    await expect(
      exportSpans(exporter, [makeSpan("accepted"), makeSpan("retried")]),
    ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(requestEnvelopes(fetch, 1)).resolves.toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          baseData: expect.objectContaining({ name: "retried" }),
        }),
      }),
    ]);
  });

  it("reports permanent rejections when retriable envelopes later succeed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            itemsReceived: 2,
            itemsAccepted: 0,
            errors: [
              { index: 0, statusCode: 400, message: "Invalid envelope" },
              { index: 1, statusCode: 500, message: "Server error" },
            ],
          }),
          { status: 206 },
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorSpanExporter({ connectionString });

    await expect(
      exportSpans(exporter, [makeSpan("rejected"), makeSpan("retried")]),
    ).resolves.toEqual({
      code: ExportResultCode.FAILED,
      error: expect.objectContaining({
        message: expect.stringContaining("permanently rejected 1"),
      }),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports permanent and retry-exhausted partial rejections as failed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const partialResponse = (statusCode: number) =>
      new Response(
        JSON.stringify({
          itemsReceived: 1,
          itemsAccepted: 0,
          errors: [{ index: 0, statusCode, message: "Rejected" }],
        }),
        { status: 206 },
      );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(partialResponse(400))
      .mockResolvedValue(partialResponse(500));
    vi.stubGlobal("fetch", fetch);

    await expect(exportSpan(new AzureMonitorSpanExporter({ connectionString }))).resolves.toEqual({
      code: ExportResultCode.FAILED,
      error: expect.any(Error),
    });
    await expect(exportSpan(new AzureMonitorSpanExporter({ connectionString }))).resolves.toEqual({
      code: ExportResultCode.FAILED,
      error: expect.any(Error),
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("converts HTTP and transport failures to failed ExportResults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 503 })),
    );
    const failedResponse = new AzureMonitorSpanExporter({ connectionString });
    await expect(exportSpan(failedResponse)).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
      error: expect.any(Error),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () => {
        throw new Error("offline");
      }),
    );
    const failedFetch = new AzureMonitorSpanExporter({ connectionString });
    await expect(exportSpan(failedFetch)).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
      error: expect.objectContaining({ message: "offline" }),
    });
  });

  it("waits for active exports and rejects exports after shutdown", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorSpanExporter({ connectionString });
    const result = exportSpan(exporter);
    let flushed = false;
    const flush = exporter.forceFlush().then(() => (flushed = true));

    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    expect(flushed).toBe(false);
    resolveFetch(new Response("", { status: 200 }));
    await flush;
    await expect(result).resolves.toEqual({ code: ExportResultCode.SUCCESS });

    await exporter.shutdown();
    await expect(exportSpan(exporter)).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
    });
  });

  it("uses beacon while unloading", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("page unloading");
    });
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorSpanExporter({ connectionString });
    beginUnloading();

    try {
      await expect(exportSpan(exporter)).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][1]).toMatchObject({ keepalive: true });
      expect(sendBeacon).toHaveBeenCalledOnce();
    } finally {
      endUnloading();
    }
  });
});
