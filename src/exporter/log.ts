// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "./base.js";
import { logItemType, logToEnvelopes } from "./logUtils.js";
import { customerSdkStats } from "./customerSdkStats.js";
import type { AzureMonitorEnvelope } from "./telemetryModels.js";

/**
 * Exports OpenTelemetry log records to Azure Monitor.
 *
 * @remarks
 * Synthetic page-operation contexts supply an operation ID, but not a parent ID.
 * Application and inherited span contexts retain their parent-ID mapping.
 * Built-in page-view diagnostics remain on OpenTelemetry records but are omitted from
 * Azure Monitor custom properties and measurements.
 *
 * @public
 */
export class AzureMonitorLogRecordExporter implements LogRecordExporter {
  readonly #client: AzureMonitorExportClient;

  public constructor(options: AzureMonitorOptions) {
    this.#client = new AzureMonitorExportClient(options);
    if (this.#client.itemStats) customerSdkStats.set(this, this.#client.itemStats);
  }

  public export(logs: ReadableLogRecord[], callback: (result: ExportResult) => void): void {
    let envelopes: AzureMonitorEnvelope[];
    try {
      const records = this.#client.itemStats
        ? logs.filter(this.#client.itemStats.shouldCollectLog)
        : logs;
      envelopes = records.flatMap((log) => logToEnvelopes(log, this.#client.instrumentationKey));
    } catch (error) {
      for (const log of logs)
        this.#client.itemStats?.count("Dropped", logItemType(log), "CLIENT_EXCEPTION");
      callback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    this.#client.export(envelopes, callback);
  }

  public forceFlush(): Promise<void> {
    return this.#client.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.#client.shutdown();
  }
}
