// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "./base.js";
import { logToEnvelope } from "./logUtils.js";

/**
 * Exports OpenTelemetry log records to Azure Monitor.
 * @public
 */
export class AzureMonitorLogRecordExporter implements LogRecordExporter {
  private readonly client: AzureMonitorExportClient;

  public constructor(options: AzureMonitorOptions) {
    this.client = new AzureMonitorExportClient(options);
  }

  public export(logs: ReadableLogRecord[], callback: (result: ExportResult) => void): void {
    this.client.export(
      logs.map((log) => logToEnvelope(log, this.client.instrumentationKey)),
      callback,
    );
  }

  public forceFlush(): Promise<void> {
    return this.client.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.client.shutdown();
  }
}
