// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { isRetriable, isSamplingRejection, parseBreezeResponse } from "./breezeUtils.js";
import { isUnloading } from "./common.js";
import { isValidInstrumentationKey, parseConnectionString } from "./connectionStringParser.js";
import {
  MAX_BATCH_SIZE_IN_BYTES,
  MAX_BEACON_BODY_SIZE,
  MAX_PENDING_KEEPALIVE_BODY_SIZE,
} from "./constants.js";
import { Sender, type SenderResultType } from "./sender.js";
import { createInternalSdkStats, type InternalSdkStats } from "./sdkStats.js";
import { getInternalSdkStatsConfiguration } from "./sdkStatsConfiguration.js";
import { SessionBuffer, sessionBufferStorage } from "./sessionBuffer.js";
import type { AzureMonitorBaseData, AzureMonitorEnvelope } from "./telemetryModels.js";

const CONTENT_TYPE = "application/json";
const noop = (): void => {};

/**
 * Azure Monitor destination configuration.
 * @public
 */
export interface AzureMonitorOptions {
  /**
   * Azure Monitor connection string containing a valid UUID instrumentation key.
   * Endpoints require HTTPS except on localhost or loopback IPs.
   * Invalid endpoints warn and fall back to suffix-derived or public cloud endpoints.
   */
  readonly connectionString: string;
  /**
   * Disables `sendBeacon` fallback when a keepalive request cannot be queued during page unload.
   * This can prevent pending telemetry from being delivered when the page closes.
   */
  readonly disableBeacon?: boolean;
}

export class AzureMonitorExportClient {
  readonly #sender: Sender;
  readonly #pending = new Set<Promise<void>>();
  #stopped = false;
  readonly #stats: InternalSdkStats;
  readonly #buffer: SessionBuffer | undefined;

  public constructor(options: AzureMonitorOptions) {
    const { instrumentationKey, ingestionEndpoint } = parseConnectionString(
      options.connectionString,
    );
    if (!instrumentationKey || !isValidInstrumentationKey(instrumentationKey)) {
      throw new Error("Connection string needs a valid InstrumentationKey UUID.");
    }
    this.instrumentationKey = instrumentationKey;
    const statsConfiguration = getInternalSdkStatsConfiguration(ingestionEndpoint);
    this.#stats = createInternalSdkStats(statsConfiguration, instrumentationKey, ingestionEndpoint);
    this.#sender = new Sender({
      endpoint: `${ingestionEndpoint}/v2/track`,
      disableBeacon: options.disableBeacon,
      stats: this.#stats,
    });
    // Unsent telemetry is mirrored in sessionStorage unless `storage.enabled` is false; leftovers
    // from the previous page load in this tab go out before any new telemetry. Storage failures
    // only log a warning.
    const storage = sessionBufferStorage.get(options);
    this.#buffer =
      storage === null
        ? undefined
        : new SessionBuffer(`${instrumentationKey}|${ingestionEndpoint}`, storage);
    for (const [id, body] of this.#buffer?.adopt() ?? []) {
      this.#track(
        this.#send(body, JSON.parse(body) as AzureMonitorEnvelope[], false, id).then(noop, noop),
      );
    }
  }

  public readonly instrumentationKey: string;

  public export(
    envelopes: readonly AzureMonitorEnvelope[],
    callback: (result: ExportResult) => void,
  ): void {
    if (this.#stopped) {
      callback({ code: ExportResultCode.FAILED, error: new Error("Exporter has been shut down.") });
      return;
    }

    const unloading = isUnloading();
    let batchResult: ReturnType<typeof createBatchRequests>;
    try {
      batchResult = createBatchRequests(
        envelopes,
        unloading ? MAX_PENDING_KEEPALIVE_BODY_SIZE : MAX_BATCH_SIZE_IN_BYTES,
        unloading,
      );
    } catch (error) {
      callback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    const { requests, dropped, error } = batchResult;
    // Envelopes that cannot fit the unload beacon wait for the next page load.
    if (dropped.length > 0) this.#buffer?.add(JSON.stringify(dropped));
    if (error) {
      callback({ code: ExportResultCode.FAILED, error });
      return;
    }
    const operation = Promise.allSettled(
      requests.map(({ body, envelopes: batchEnvelopes }) =>
        this.#send(body, batchEnvelopes, unloading),
      ),
    )
      .then((results) => {
        const fulfilled: SenderResultType[] = [];
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
          fulfilled.push(result.value);
        }
        const exportResult = toExportResult(fulfilled);
        if (exportResult.code === ExportResultCode.FAILED || dropped.length === 0) {
          return exportResult;
        }
        return {
          code: ExportResultCode.FAILED,
          error: new Error(
            `Unload beacon limit exceeded; sent ${envelopes.length - dropped.length} of ${envelopes.length} envelopes.`,
          ),
        };
      })
      .catch((error: unknown): ExportResult => ({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      }))
      // Callback errors must not be reported back to the same callback as export failures.
      .then(callback);
    this.#track(operation);
  }

  /**
   * Sends one serialized batch, buffering it until it is delivered or permanently rejected.
   * Unload requests leave the buffer when the browser accepts them, since their responses may
   * never be observed. After a partial response, only the outstanding retriable envelopes stay
   * buffered.
   */
  #send(
    body: string,
    envelopes: readonly AzureMonitorEnvelope[],
    unloading: boolean,
    id = this.#buffer?.add(body),
  ): Promise<SenderResultType> {
    let outstanding = body;
    /** Ingestion accepted or permanently rejected the batch. */
    let final = false;
    const settle = (keep: boolean): void => {
      if (id !== undefined) this.#buffer?.settle(id, outstanding, keep);
    };
    const end = (): void => {
      if (id !== undefined) this.#buffer?.end(id);
    };
    if (id !== undefined) this.#buffer?.begin(id);
    return this.#sender
      .send({
        body: new TextEncoder().encode(body),
        contentType: CONTENT_TYPE,
        envelopes,
        unloading,
        onDispatch: () => {
          if (id !== undefined) this.#buffer?.dispatch(id);
        },
        onPartial: (rest) => {
          if (rest.length > 0) outstanding = JSON.stringify(rest);
          settle(rest.length > 0);
        },
        // A known status settles the batch even if its body cannot be read. A partial response
        // keeps the whole batch, including a dispatched one, until `onPartial` narrows it.
        onResponse: (status) => {
          final = status !== 206 && !isRetriable(status);
          settle(!final);
        },
        // Stop retrying a batch another document adopted and delivered.
        active: () => id === undefined || this.#buffer?.owns(id) !== false,
      })
      .then(
        (result) => {
          // A beacon's outcome is never observed, so the browser accepting it is final.
          if (result.transport === "beacon") settle(false);
          end();
          return result;
        },
        (error: unknown) => {
          if (!final) settle(true);
          end();
          throw error;
        },
      );
  }

  #track(operation: Promise<void>): void {
    const tracked = operation.finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  public async forceFlush(): Promise<void> {
    // Customer exports get keepalive capacity before stats.
    await Promise.all([...this.#pending]);
    await this.#stats.forceFlush();
  }

  public async shutdown(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const pending = Promise.all([...this.#pending]);
    try {
      await this.#stats.shutdown(pending);
    } finally {
      this.#buffer?.dispose();
    }
  }
}

function createBatchRequests(
  envelopes: readonly AzureMonitorEnvelope[],
  maxBatchSize: number,
  enforceMaxBatchSize: boolean,
): {
  requests: BatchRequest[];
  /** Original envelopes left out of an unload request. */
  dropped: readonly AzureMonitorEnvelope[];
  error?: RangeError;
} {
  const encoder = new TextEncoder();
  if (enforceMaxBatchSize) {
    if (envelopes.length === 0) return { requests: [], dropped: [] };
    const original = serializeBatch(envelopes, encoder);
    const fitted =
      original.size <= MAX_BEACON_BODY_SIZE
        ? original
        : fitBatchCustomFields(envelopes, MAX_BEACON_BODY_SIZE, encoder);
    let deliverable = fitted;
    let dropped: readonly AzureMonitorEnvelope[] = [];
    if (fitted.size > MAX_BEACON_BODY_SIZE) {
      const subset = selectEnvelopeSubset(fitted.envelopes, MAX_BEACON_BODY_SIZE, encoder);
      const selected = new Set(subset.indexes);
      dropped = envelopes.filter((_, index) => !selected.has(index));
      deliverable = fitBatchCustomFields(
        subset.indexes.map((index) => envelopes[index]),
        MAX_BEACON_BODY_SIZE,
        encoder,
      );
    }
    if (deliverable.envelopes.length === 0) {
      return {
        requests: [],
        dropped,
        error: new RangeError(
          `Unload payload size ${fitted.size} exceeds the ${MAX_BEACON_BODY_SIZE} byte aggregate beacon limit.`,
        ),
      };
    }
    return {
      requests: [{ body: deliverable.serialized, envelopes: deliverable.envelopes }],
      dropped,
    };
  }

  const requests: BatchRequest[] = [];
  let batch: AzureMonitorEnvelope[] = [];
  let serializedBatch: string[] = [];
  let batchSize = 2;

  const flush = (): void => {
    if (batch.length === 0) return;
    requests.push({ body: `[${serializedBatch.join(",")}]`, envelopes: batch });
    batch = [];
    serializedBatch = [];
    batchSize = 2;
  };

  for (const envelope of envelopes) {
    // Normal exports treat maxBatchSize as a split threshold only. A single oversized envelope is
    // still sent on its own so ingestion can report a per-item failure; rejecting it locally would
    // hide that diagnostic.
    const separatorSize = batch.length === 0 ? 0 : 1;
    const { serialized, size: serializedSize } = serializeEnvelope(envelope, encoder);
    if (batch.length > 0 && batchSize + separatorSize + serializedSize > maxBatchSize) {
      flush();
    }
    batch.push(envelope);
    serializedBatch.push(serialized);
    batchSize += (batch.length === 1 ? 0 : 1) + serializedSize;
  }
  flush();
  return { requests, dropped: [] };
}

interface BatchRequest {
  body: string;
  envelopes: readonly AzureMonitorEnvelope[];
}

interface SerializedEnvelope {
  envelope: AzureMonitorEnvelope;
  serialized: string;
  size: number;
}

interface SerializedBatch {
  envelopes: readonly AzureMonitorEnvelope[];
  serialized: string;
  size: number;
}

interface SerializedEnvelopeSubset extends SerializedBatch {
  indexes: readonly number[];
}

function serializeBatch(
  envelopes: readonly AzureMonitorEnvelope[],
  encoder: TextEncoder,
): SerializedBatch {
  const serialized = JSON.stringify(envelopes);
  return { envelopes, serialized, size: encoder.encode(serialized).byteLength };
}

function selectEnvelopeSubset(
  envelopes: readonly AzureMonitorEnvelope[],
  maxBatchSize: number,
  encoder: TextEncoder,
): SerializedEnvelopeSubset {
  const selected: AzureMonitorEnvelope[] = [];
  const indexes: number[] = [];
  const serializedEnvelopes: string[] = [];
  let size = 2;
  for (const [index, envelope] of envelopes.entries()) {
    const serializedEnvelope = serializeEnvelope(envelope, encoder);
    const separatorSize = selected.length === 0 ? 0 : 1;
    if (size + separatorSize + serializedEnvelope.size > maxBatchSize) continue;
    selected.push(envelope);
    indexes.push(index);
    serializedEnvelopes.push(serializedEnvelope.serialized);
    size += separatorSize + serializedEnvelope.size;
  }
  return {
    envelopes: selected,
    indexes,
    serialized: `[${serializedEnvelopes.join(",")}]`,
    size,
  };
}

function serializeEnvelope(
  envelope: AzureMonitorEnvelope,
  encoder: TextEncoder,
): SerializedEnvelope {
  const serialized = JSON.stringify(envelope);
  return { envelope, serialized, size: encoder.encode(serialized).byteLength };
}

function fitBatchCustomFields(
  envelopes: readonly AzureMonitorEnvelope[],
  maxBatchSize: number,
  encoder: TextEncoder,
): SerializedBatch {
  const original = serializeBatch(envelopes, encoder);
  if (original.size <= maxBatchSize) return original;

  const customFields: Array<{ size: number; remove: () => number }> = [];
  const createFittedEnvelopes = envelopes.map((envelope) => {
    const sourceBaseData = envelope.data.baseData;
    const properties = sourceBaseData.properties ? { ...sourceBaseData.properties } : undefined;
    const measurements = sourceBaseData.measurements
      ? { ...sourceBaseData.measurements }
      : undefined;
    const remaining = [
      properties ? Object.keys(properties).length : 0,
      measurements ? Object.keys(measurements).length : 0,
    ];
    [properties, measurements].forEach((fields, index) => {
      if (!fields) return;
      const wrapperSize =
        encoder.encode(JSON.stringify(index === 0 ? "properties" : "measurements")).byteLength + 3;
      for (const key of Object.keys(fields)) {
        customFields.push({
          size: encoder.encode(JSON.stringify([key, fields[key]])).byteLength,
          remove: () => {
            delete fields[key];
            return --remaining[index] === 0 ? wrapperSize : 0;
          },
        });
      }
    });
    return (): AzureMonitorEnvelope => {
      const baseData: AzureMonitorBaseData = {
        ...sourceBaseData,
        properties: remaining[0] > 0 ? properties : undefined,
        measurements: remaining[1] > 0 ? measurements : undefined,
      };
      return { ...envelope, data: { ...envelope.data, baseData } };
    };
  });
  customFields.sort((left, right) => right.size - left.size);

  // Re-serialize only when the estimate might fit. Removing a defined `"key":value` entry and its
  // comma saves exactly the `["key",value]` size minus 1 byte (undefined values save nothing).
  // Emptying an object also removes its serialized property-name wrapper. The estimate starts from
  // the normalized batch because empty containers are omitted there.
  const createBatch = (): AzureMonitorEnvelope[] =>
    createFittedEnvelopes.map((createEnvelope) => createEnvelope());
  let fitted = serializeBatch(createBatch(), encoder);
  let estimatedSize = fitted.size;
  for (const field of customFields) {
    estimatedSize -= field.size - 1 + field.remove();
    if (estimatedSize > maxBatchSize) continue;
    fitted = serializeBatch(createBatch(), encoder);
    if (fitted.size <= maxBatchSize) return fitted;
    estimatedSize = fitted.size;
  }
  return fitted;
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
        `Azure Monitor permanently rejected ${result.permanentErrors.length} item(s).`,
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
    error: new Error(`Azure Monitor export failed with HTTP ${result.statusCode}.`),
  };
}
