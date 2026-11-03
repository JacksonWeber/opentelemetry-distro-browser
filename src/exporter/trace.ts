// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "./base.js";
import { isUnloading } from "./common.js";
import { appendSpanEnvelopes } from "./spanUtils.js";
import { customerSdkStats, spanItemType } from "./customerSdkStats.js";

/**
 * Exports OpenTelemetry spans to Azure Monitor.
 *
 * @remarks
 * Synthetic page-operation contexts supply an operation ID, but not a parent ID.
 * Application and inherited span contexts retain their parent-ID mapping.
 * Shutdown allows 15 seconds for outstanding application exports, followed by best-effort
 * SDK Stats reporting. Enclosing processors may impose their own deadlines.
 *
 * @public
 */
export class AzureMonitorSpanExporter implements SpanExporter {
  readonly #client: AzureMonitorExportClient;

  /** Standalone export requires a resolved string; the distribution owns startup buffering. */
  public constructor(options: AzureMonitorOptions) {
    this.#client = new AzureMonitorExportClient(options);
    if (this.#client.itemStats) customerSdkStats.set(this, this.#client.itemStats);
  }

  public export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    const unloading = isUnloading();
    this.#client.exportRecords(
      spans,
      (span, envelopes) =>
        appendSpanEnvelopes(span, this.#client.instrumentationKey, envelopes, unloading),
      (span) => spanItemType(span.kind),
      callback,
    );
  }

  public forceFlush(): Promise<void> {
    return this.#client.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.#client.shutdown();
  }
}
