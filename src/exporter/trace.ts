// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "./base.js";
import { isUnloading } from "./common.js";
import { spanToEnvelopes } from "./spanUtils.js";
import type { AzureMonitorEnvelope } from "./telemetryModels.js";
import { customerSdkStats, spanItemType } from "./customerSdkStats.js";

/**
 * Exports OpenTelemetry spans to Azure Monitor.
 *
 * @remarks
 * Synthetic page-operation contexts supply an operation ID, but not a parent ID.
 * Application and inherited span contexts retain their parent-ID mapping.
 *
 * @public
 */
export class AzureMonitorSpanExporter implements SpanExporter {
  readonly #client: AzureMonitorExportClient;

  public constructor(options: AzureMonitorOptions) {
    this.#client = new AzureMonitorExportClient(options);
    if (this.#client.itemStats) customerSdkStats.set(this, this.#client.itemStats);
  }

  public export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    const envelopes: AzureMonitorEnvelope[] = [];
    const unloading = isUnloading();
    try {
      for (const span of spans) {
        envelopes.push(
          ...spanToEnvelopes(
            span,
            this.#client.instrumentationKey,
            unloading ? envelopes : undefined,
          ),
        );
      }
    } catch (error) {
      for (const span of spans)
        this.#client.itemStats?.count("Dropped", spanItemType(span.kind), "CLIENT_EXCEPTION");
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
