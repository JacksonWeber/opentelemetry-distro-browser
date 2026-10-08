// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isSpanContextValid } from "@opentelemetry/api";
import {
  BatchLogRecordProcessor,
  type BatchLogRecordProcessorBrowserOptions,
  type ReadWriteLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  AZURE_MONITOR_SAMPLE_RATE,
  getEffectiveSampleRate,
  isTraceSampled,
  validateSamplingPercentage,
} from "./sampling.js";

export interface AzureMonitorSamplingLogRecordProcessorOptions extends BatchLogRecordProcessorBrowserOptions {
  samplingPercentage: number;
}

export class AzureMonitorSamplingLogRecordProcessor extends BatchLogRecordProcessor {
  private readonly samplingPercentage: number;

  public constructor(
    options: AzureMonitorSamplingLogRecordProcessorOptions,
    private readonly random: () => number = Math.random,
  ) {
    const { samplingPercentage, ...batchOptions } = options;
    super(batchOptions);
    this.samplingPercentage = validateSamplingPercentage(samplingPercentage);
  }

  public override onEmit(record: ReadWriteLogRecord): void {
    const spanContext = record.spanContext;
    const correlated = !!spanContext && isSpanContextValid(spanContext);
    const sampled = correlated
      ? isTraceSampled(spanContext.traceId, this.samplingPercentage)
      : this.samplingPercentage === 100 ||
        (this.samplingPercentage !== 0 && this.random() * 100 < this.samplingPercentage);
    if (!sampled) return;

    const currentSampleRate = record.attributes[AZURE_MONITOR_SAMPLE_RATE];
    const effectiveSampleRate = getEffectiveSampleRate(
      currentSampleRate,
      this.samplingPercentage,
      !correlated,
    );
    if (effectiveSampleRate < 100 && currentSampleRate !== effectiveSampleRate) {
      const azureRecord = Object.create(record, {
        attributes: {
          value: {
            ...record.attributes,
            [AZURE_MONITOR_SAMPLE_RATE]: effectiveSampleRate,
          },
        },
      }) as ReadWriteLogRecord;
      super.onEmit(azureRecord);
      return;
    }
    super.onEmit(record);
  }
}
