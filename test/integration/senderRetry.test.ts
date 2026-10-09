// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, expect, it, vi } from "vitest";
import { AzureMonitorLogRecordExporter } from "../../src/exporter/log.js";
import { Sender } from "../../src/exporter/sender.js";
import { AzureMonitorSpanExporter } from "../../src/exporter/trace.js";
import { createReadableLogRecord, createReadableSpan } from "../fixtures/telemetry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["forceFlush", "shutdown"] as const)(
  "completes span and log %s within 1.5 seconds despite a day-long Retry-After",
  async (method) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      return new Response(null, { status: 503, headers: { "retry-after": "86400" } });
    });
    vi.stubGlobal("fetch", fetch);
    const options = {
      connectionString:
        "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test",
    };
    const spanExporter = new AzureMonitorSpanExporter(options);
    const logExporter = new AzureMonitorLogRecordExporter(options);
    const spanCallback = vi.fn();
    const logCallback = vi.fn();

    spanExporter.export([createReadableSpan()], spanCallback);
    logExporter.export([createReadableLogRecord()], logCallback);
    await Promise.all([spanExporter[method](), logExporter[method]()]);

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const callback of [spanCallback, logCallback]) {
      expect(callback).toHaveBeenCalledExactlyOnceWith({
        code: ExportResultCode.FAILED,
        error: expect.objectContaining({ message: expect.stringContaining("retry-wait budget") }),
      });
    }
    await Promise.all([spanExporter.shutdown(), logExporter.shutdown()]);
  },
  1_500,
);

it.each(["AbortError", "TimeoutError"] as const)(
  "retries a browser %s transport failure",
  async (errorName) => {
    const transportError = new DOMException("Request failed", errorName);
    expect(transportError).toBeInstanceOf(DOMException);
    expect(transportError.name).toBe(errorName);

    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const delay = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      delay,
      random: () => 0,
    });

    await expect(
      sender.send({ body: new TextEncoder().encode("telemetry"), contentType: "application/json" }),
    ).resolves.toMatchObject({ transport: "fetch", statusCode: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
  },
);
