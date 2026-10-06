// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isSpanContextValid, trace, type Context, type SpanContext } from "@opentelemetry/api";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { syntheticPageContexts } from "../../shared/pageOperationContext.js";

/** Removes a synthetic page operation while preserving application contexts and values. */
export function withoutPageOperation(active: Context): Context {
  const spanContext = trace.getSpanContext(active);
  return spanContext && syntheticPageContexts.has(spanContext) ? trace.deleteSpan(active) : active;
}

/**
 * Uses the page operation only when telemetry has no valid application-supplied span context.
 * Stops exposing synthetic page contexts at shutdown while preserving application contexts.
 */
export class PageViewCorrelation implements LogRecordProcessor {
  constructor(private getOperation: (() => SpanContext | undefined) | undefined) {}

  /** Applies page correlation to the active context supplied by the page context manager. */
  decorate(active: Context): Context {
    if (!this.getOperation) return withoutPageOperation(active);
    const operation = this.getOperation();
    const spanContext = trace.getSpanContext(active);
    return operation && (!spanContext || !isSpanContextValid(spanContext))
      ? trace.setSpanContext(active, operation)
      : active;
  }

  /** The current page operation, until shutdown. */
  operation(): SpanContext | undefined {
    return this.getOperation?.();
  }

  // Correlation must not enable records rejected by the application's log processors.
  enabled(): boolean {
    return false;
  }

  onEmit(record: ReadWriteLogRecord): void {
    const operation =
      (!record.spanContext || !isSpanContextValid(record.spanContext)) && this.getOperation?.();
    if (operation) record.spanContext = operation;
  }

  async forceFlush(): Promise<void> {}

  shutdown(): Promise<void> {
    this.getOperation = undefined;
    return Promise.resolve();
  }
}
