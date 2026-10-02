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
