// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { isSamplingRejection, parseBreezeResponse } from "./breezeUtils.js";
import { isUnloading } from "./common.js";
import { isValidInstrumentationKey, parseConnectionString } from "./connectionStringParser.js";
import { MAX_BATCH_SIZE_IN_BYTES } from "./constants.js";
import { Sender, type SenderResultType } from "./sender.js";
import type { AzureMonitorEnvelope } from "./telemetryModels.js";

const CONTENT_TYPE = "application/json";

/**
 * Azure Monitor destination configuration.
 * @public
 */
export interface AzureMonitorOptions {
  /** Azure Monitor connection string containing a valid UUID instrumentation key. */
  readonly connectionString: string;
  /**
   * Disables `sendBeacon` fallback when a keepalive request cannot be queued during page unload.
   * This can prevent pending telemetry from being delivered when the page closes.
   */
  readonly disableBeacon?: boolean;
}

export class AzureMonitorExportClient {
  private readonly sender: Sender;
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;

  public constructor(options: AzureMonitorOptions) {
    const { instrumentationKey, ingestionEndpoint } = parseConnectionString(
      options.connectionString,
    );
    if (!instrumentationKey || !isValidInstrumentationKey(instrumentationKey)) {
      throw new Error(
        "The Azure Monitor connection string must contain a valid InstrumentationKey UUID.",
      );
    }
    this.instrumentationKey = instrumentationKey;
    this.sender = new Sender({
      endpoint: `${ingestionEndpoint}/v2/track`,
      disableBeacon: options.disableBeacon,
    });
  }

  public readonly instrumentationKey: string;

  public export(
    envelopes: readonly AzureMonitorEnvelope[],
    callback: (result: ExportResult) => void,
  ): void {
    if (this.stopped) {
      callback({ code: ExportResultCode.FAILED, error: new Error("Exporter has been shut down.") });
      return;
    }

    const unloading = isUnloading();
    const requests = createBatchRequests(envelopes);
    const operation = Promise.allSettled(
      requests.map(({ body, envelopes: batchEnvelopes }) =>
        this.sender.send({
          body,
          contentType: CONTENT_TYPE,
          envelopes: batchEnvelopes,
          unloading,
        }),
      ),
    )
      .then((results) => {
        const fulfilled: SenderResultType[] = [];
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
          fulfilled.push(result.value);
        }
        callback(toExportResult(fulfilled));
      })
      .catch((error: unknown) =>
        callback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      )
      .finally(() => this.pending.delete(operation));
    this.pending.add(operation);
  }

  public async forceFlush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  public async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.forceFlush();
  }
}

function createBatchRequests(envelopes: readonly AzureMonitorEnvelope[]): Array<{
  body: Uint8Array<ArrayBuffer>;
  envelopes: readonly AzureMonitorEnvelope[];
}> {
  const encoder = new TextEncoder();
  const requests: Array<{
    body: Uint8Array<ArrayBuffer>;
    envelopes: readonly AzureMonitorEnvelope[];
  }> = [];
  let batch: AzureMonitorEnvelope[] = [];
  let serializedBatch: string[] = [];
  let batchSize = 2;

  const flush = (): void => {
    if (batch.length === 0) return;
    requests.push({
      body: encoder.encode(`[${serializedBatch.join(",")}]`),
      envelopes: batch,
    });
    batch = [];
    serializedBatch = [];
    batchSize = 2;
  };

  for (const envelope of envelopes) {
    const serialized = JSON.stringify(envelope);
    const serializedSize = encoder.encode(serialized).byteLength;
    const separatorSize = batch.length === 0 ? 0 : 1;
    if (batch.length > 0 && batchSize + separatorSize + serializedSize > MAX_BATCH_SIZE_IN_BYTES) {
      flush();
    }
    batch.push(envelope);
    serializedBatch.push(serialized);
    batchSize += (batch.length === 1 ? 0 : 1) + serializedSize;
  }
  flush();
  return requests;
}

function toExportResult(results: readonly SenderResultType[]): ExportResult {
  for (const result of results) {
    const exportResult = toSingleExportResult(result);
    if (exportResult.code === ExportResultCode.FAILED) return exportResult;
  }
  return { code: ExportResultCode.SUCCESS };
}

function toSingleExportResult(result: SenderResultType): ExportResult {
  if (result.transport === "beacon") {
    return { code: ExportResultCode.SUCCESS };
  }
  if (result.permanentErrors?.length) {
    return {
      code: ExportResultCode.FAILED,
      error: new Error(
        `Azure Monitor ingestion permanently rejected ${result.permanentErrors.length} item(s).`,
      ),
    };
  }
  if (result.statusCode >= 200 && result.statusCode < 300 && result.statusCode !== 206) {
    return { code: ExportResultCode.SUCCESS };
  }
  if (result.statusCode === 206) {
    const response = parseBreezeResponse(result.result);
    if (response && response.errors.every(isSamplingRejection)) {
      return { code: ExportResultCode.SUCCESS };
    }
  }
  return {
    code: ExportResultCode.FAILED,
    error: new Error(`Azure Monitor ingestion failed with HTTP status ${result.statusCode}.`),
  };
}
