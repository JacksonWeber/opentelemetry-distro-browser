// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, SpanStatusCode, type SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { createDeterministicIdGenerator } from "./ids.js";

/**
 * Local exporters and processors only, without registering global providers.
 * Flush before inspecting records. Shutdown clears records and stops batch timers.
 * A provider owning these processors should perform shutdown instead of this helper.
 * With fake timers, start forceFlush(), advance the clock, then await the flush.
 */
export function createInMemoryPipeline() {
  const batchOptions = {
    scheduledDelayMillis: 60_000,
    disableAutoFlushOnDocumentHide: true,
  };
  const spanExporter = new InMemorySpanExporter();
  const spanProcessor = new BatchSpanProcessor(spanExporter, batchOptions);
  const logExporter = new InMemoryLogRecordExporter();
  const logProcessor = new BatchLogRecordProcessor({ exporter: logExporter, ...batchOptions });
  return {
    spanExporter,
    spanProcessor,
    logExporter,
    logProcessor,
    async forceFlush(): Promise<void> {
      await Promise.all([spanProcessor.forceFlush(), logProcessor.forceFlush()]);
    },
    async shutdown(): Promise<void> {
      const results = await Promise.allSettled([spanProcessor.shutdown(), logProcessor.shutdown()]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) throw new AggregateError(errors, "Test pipeline shutdown failed.");
    },
    options: {
      spanProcessors: [spanProcessor],
      logRecordProcessors: [logProcessor],
    },
  };
}

/** Fresh typed records with stable defaults. Supply a context for correlated or unique records. */
export function createSpanContext(): SpanContext {
  const ids = createDeterministicIdGenerator();
  return { traceId: ids.generateTraceId(), spanId: ids.generateSpanId(), traceFlags: 1 };
}

export function createReadableSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  const spanContext = createSpanContext();
  return {
    name: "GET /items/:id",
    kind: SpanKind.CLIENT,
    spanContext: () => spanContext,
    parentSpanContext: { ...spanContext, spanId: "0000000000000002" },
    startTime: [1_735_689_600, 0],
    endTime: [1_735_689_601, 234_567_000],
    duration: [1, 234_567_000],
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    resource: resourceFromAttributes({ "service.name": "browser-store" }),
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ended: true,
    ...overrides,
  };
}

export function createReadableLogRecord(
  overrides: Partial<ReadableLogRecord> = {},
): ReadableLogRecord {
  return {
    hrTime: [1_735_689_600, 0],
    hrTimeObserved: [1_735_689_600, 0],
    spanContext: createSpanContext(),
    resource: resourceFromAttributes({ "service.name": "browser-store" }),
    instrumentationScope: { name: "test" },
    attributes: {},
    droppedAttributesCount: 0,
    ...overrides,
  };
}
