// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";
import { createMockIngestionEndpoint } from "../../fixtures/azureMonitor.js";
import { createReadableLogRecord } from "../../fixtures/telemetry.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AzureMonitorLogRecordExporter", () => {
  it("falls back to HTTPS instead of exporting logs to a non-loopback HTTP endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString:
        "InstrumentationKey=00000000-0000-0000-0000-000000000000;" +
        "IngestionEndpoint=http://example.test",
    });

    try {
      const result = await new Promise<{ code: ExportResultCode }>((resolve) => {
        exporter.export([createReadableLogRecord()], resolve);
      });
      expect(result).toEqual({ code: ExportResultCode.SUCCESS });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][0]).toBe("https://dc.services.visualstudio.com/v2/track");
    } finally {
      await exporter.shutdown();
    }
  });

  it("maps and exports log records", async () => {
    const ingestion = createMockIngestionEndpoint();
    vi.stubGlobal("fetch", ingestion.fetch);
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString: ingestion.connectionString,
    });

    try {
      const result = await new Promise<{ code: ExportResultCode }>((resolve) => {
        exporter.export([createReadableLogRecord({ body: "checkout completed" })], resolve);
      });
      await exporter.forceFlush();
      expect(result).toEqual({ code: ExportResultCode.SUCCESS });
      expect(ingestion.fetch).toHaveBeenCalledOnce();
      expect(ingestion.requests[0].envelopes[0]).toMatchObject({
        data: { baseType: "MessageData", baseData: { message: "checkout completed" } },
      });
    } finally {
      await exporter.shutdown();
    }
  });
});
