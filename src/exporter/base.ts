// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { callWithTimeout, ExportResultCode } from "@opentelemetry/core";
import { isRetriable, isSamplingRejection } from "./breezeUtils.js";
import { createEnvelopeBatches, isUnloading, type EnvelopeBatch } from "./common.js";
import { isValidInstrumentationKey, parseConnectionString } from "./connectionStringParser.js";
import {
  MAX_BATCH_SIZE_IN_BYTES,
  MAX_BEACON_BODY_SIZE,
  MAX_FLUSH_WAIT_MS,
  MAX_PENDING_KEEPALIVE_BODY_SIZE,
  MAX_SHUTDOWN_WAIT_MS,
} from "./constants.js";
import { Sender, type SenderResultType } from "./sender.js";
import { createInternalSdkStats, reportFailure, type InternalSdkStats } from "./sdkStats.js";
import { getInternalSdkStatsConfiguration } from "./sdkStatsConfiguration.js";
import { SessionBuffer, sessionBufferStorage } from "./sessionBuffer.js";
import { throwErrors, waitForAll } from "../shared/lifecycle.js";
import type { AzureMonitorBaseData, AzureMonitorEnvelope } from "./telemetryModels.js";
import {
  createCustomerSdkStats,
  type CustomerSdkStats,
  type AzureMonitorSdkStatsOptions,
  type ItemType,
} from "./customerSdkStats.js";

const CONTENT_TYPE = "application/json";
const noop = (): void => {};

/** Internal per-destination policy; standalone exporter options remain startup-only. */
export const unloadBeaconPolicies = new WeakMap<object, () => boolean>();

/**
 * Azure Monitor destination configuration.
 * @typeParam TConnectionString - Defaults to a resolved string for standalone exporters.
 * The distribution also accepts `string | Promise<string>`.
 * @public
 */
export interface AzureMonitorOptions<TConnectionString extends string | Promise<string> = string> {
  /**
   * Azure Monitor connection string containing a valid UUID instrumentation key.
   * Endpoints require HTTPS except on localhost or loopback IPs.
   * Invalid endpoints warn and fall back to suffix-derived or public cloud endpoints.
   * Promises are supported by the distribution; standalone exporters require a resolved string.
   */
  readonly connectionString: TConnectionString;
  /** Maximum promise wait in milliseconds. Defaults to 50000; zero expires immediately. */
  readonly initTimeOut?: number;
  /** Maximum spans and logs buffered together while waiting. Defaults to 100; zero drops all. */
  readonly initInMemoMaxSize?: number;
  /**
   * Disables `sendBeacon` fallback when a keepalive request cannot be queued during page unload.
   * This can prevent pending telemetry from being delivered when the page closes.
   */
  readonly disableBeacon?: boolean;
  /** Opt-in customer SDK Stats for this destination. Disabled by default. */
  readonly sdkStats?: AzureMonitorSdkStatsOptions;
}

export class AzureMonitorExportClient {
  readonly #sender: Sender;
  readonly #pending = new Set<Promise<void>>();
  #stopped = false;
  readonly #stats: InternalSdkStats;
  readonly #buffer: SessionBuffer | undefined;
  readonly #controller = new AbortController();
  #shutdown: Promise<void> | undefined;

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
    this.itemStats = createCustomerSdkStats(
      options.sdkStats,
      instrumentationKey,
      ingestionEndpoint,
    );
    this.#sender = new Sender({
      endpoint: `${ingestionEndpoint}/v2/track`,
      disableBeacon: unloadBeaconPolicies.get(options) ?? options.disableBeacon,
      stats: this.#stats,
      itemStats: this.itemStats,
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
  public readonly itemStats: CustomerSdkStats | undefined;

  public exportRecords<T extends ReadableSpan | ReadableLogRecord>(
    records: readonly T[],
    convert: (record: T, envelopes: AzureMonitorEnvelope[]) => void,
    itemType: (record: T) => ItemType,
    callback: (result: ExportResult) => void,
    shouldCollect?: (record: T) => boolean,
  ): void {
    const envelopes: AzureMonitorEnvelope[] = [];
    let converted = 0;
    let recordStart = 0;
    try {
      for (const record of records) {
        recordStart = envelopes.length;
        if (!shouldCollect || shouldCollect(record)) convert(record, envelopes);
        converted++;
      }
    } catch (error) {
      if (this.itemStats) {
        this.itemStats.countEnvelopes("Dropped", envelopes, "CLIENT_EXCEPTION");
        // A partially converted record already contributed its primary envelope.
        for (const record of records.slice(converted + (envelopes.length > recordStart ? 1 : 0))) {
          try {
            if (!shouldCollect || shouldCollect(record))
              this.itemStats.countFailedRecord(record, itemType(record));
          } catch (classificationError) {
            reportFailure(classificationError, "SDK stats item classification failed");
          }
        }
      }
      callback(toFailedExportResult(error));
      return;
    }
    this.export(envelopes, callback);
  }

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
      this.itemStats?.countEnvelopes(
        "Dropped",
        envelopes,
        error instanceof RangeError ? "PAYLOAD_TOO_LARGE" : "CLIENT_EXCEPTION",
      );
      callback(toFailedExportResult(error));
      return;
    }
    const { requests, dropped, error } = batchResult;
    // Envelopes that cannot fit the unload beacon wait for the next page load.
    if (dropped.length > 0) {
      const id = this.#buffer?.add(JSON.stringify(dropped));
      if (this.itemStats && (id === undefined || !this.#buffer?.retain(id)))
        this.itemStats.countEnvelopes("Dropped", dropped, "PAYLOAD_TOO_LARGE");
    }
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
      .catch(toFailedExportResult)
      // Callback errors must not be reported back to the same callback as export failures.
      .then((result) => {
        callback(result);
      });
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
        signal: this.#controller.signal,
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
        retain: () => {
          settle(true);
          return id !== undefined && this.#buffer?.retain(id) === true;
        },
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

  async #drain(): Promise<unknown[]> {
    const pending = Promise.allSettled([...this.#pending]);
    try {
      // A flush timeout stops waiting, not delivery. Only shutdown cancels application exports.
      const results = await (this.#stopped ? pending : callWithTimeout(pending, MAX_FLUSH_WAIT_MS));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (this.#controller.signal.aborted) errors.push(new Error("Exporter shutdown timed out."));
      return errors;
    } catch (error) {
      return [error];
    }
  }

  public forceFlush(): Promise<void> {
    if (this.#stopped) return this.#shutdown ?? Promise.resolve();
    const report = () =>
      waitForAll(
        [this.itemStats?.forceFlush(), this.#stats.forceFlush()],
        "SDK stats flush failed",
      );
    // Already-collected counts must not wait behind a different hung export.
    const pending = this.#drain();
    return waitForAll(
      [
        report(),
        pending.then((errors) => {
          if (!this.#shutdown) throwErrors(errors, "Pending exports failed");
        }),
        pending.then(() => this.#shutdown ?? report()),
      ],
      "Exporter flush failed",
    );
  }

  public shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    if (this.#stopped) return Promise.resolve();
    this.#stopped = true;
    const timer = setTimeout(() => this.#controller.abort(), MAX_SHUTDOWN_WAIT_MS);
    const pending = this.#drain().finally(() => this.#buffer?.dispose());
    this.#shutdown = waitForAll(
      [
        pending.then((errors) => throwErrors(errors, "Pending exports failed")),
        this.#stats.shutdown(pending),
        this.itemStats?.shutdown(pending),
      ],
      "Exporter shutdown failed",
    ).finally(() => {
      this.#shutdown = undefined;
      clearTimeout(timer);
      this.#sender.dispose();
    });
    return this.#shutdown;
  }
}

function createBatchRequests(
  envelopes: readonly AzureMonitorEnvelope[],
  maxBatchSize: number,
  enforceMaxBatchSize: boolean,
): {
  requests: EnvelopeBatch[];
  /** Original envelopes left out of an unload request. */
  dropped: readonly AzureMonitorEnvelope[];
  error?: RangeError;
} {
  if (enforceMaxBatchSize) {
    const encoder = new TextEncoder();
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

  return { requests: createEnvelopeBatches(envelopes, maxBatchSize), dropped: [] };
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

function toFailedExportResult(error: unknown): ExportResult {
  return {
    code: ExportResultCode.FAILED,
    error: error instanceof Error ? error : new Error(String(error)),
  };
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
    const response = result.response;
    if (response && response.errors.every(isSamplingRejection)) {
      return { code: ExportResultCode.SUCCESS };
    }
  }
  return {
    code: ExportResultCode.FAILED,
    error: new Error(`Azure Monitor export failed with HTTP ${result.statusCode}.`),
  };
}
