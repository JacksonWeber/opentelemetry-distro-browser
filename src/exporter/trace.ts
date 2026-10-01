// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "./base.js";
import { spanToEnvelope } from "./spanUtils.js";

/**
 * Exports OpenTelemetry spans to Azure Monitor.
 * @public
 */
export class AzureMonitorSpanExporter implements SpanExporter {
  private readonly client: AzureMonitorExportClient;

  public constructor(options: AzureMonitorOptions) {
    this.client = new AzureMonitorExportClient(options);
  }

  public export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    this.client.export(
      spans.map((span) => spanToEnvelope(span, this.client.instrumentationKey)),
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
