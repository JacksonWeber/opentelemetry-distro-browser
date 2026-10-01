// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  isSpanContextValid,
  trace,
  type ContextManager,
  type SpanContext,
} from "@opentelemetry/api";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { syntheticPageContexts } from "../../shared/pageOperationContext.js";

/**
 * Uses the page operation only when telemetry has no valid application-supplied span context.
 * Stops exposing synthetic page contexts at shutdown while preserving application contexts.
 */
export class PageViewCorrelation implements ContextManager, LogRecordProcessor {
  private running = false;

  constructor(
    private getOperation: (() => SpanContext | undefined) | undefined,
    private readonly delegate: ContextManager = new StackContextManager(),
  ) {}

  active(): ReturnType<ContextManager["active"]> {
    const active = this.delegate.active();
    if (!this.running) {
      const spanContext = trace.getSpanContext(active);
      return spanContext && syntheticPageContexts.has(spanContext)
        ? trace.deleteSpan(active)
        : active;
    }
    const operation = this.getOperation?.();
    const spanContext = trace.getSpanContext(active);
    return operation && (!spanContext || !isSpanContextValid(spanContext))
      ? trace.setSpanContext(active, operation)
      : active;
  }

  with: ContextManager["with"] = (ctx, fn, thisArg, ...args) =>
    this.delegate.with(ctx, fn, thisArg, ...args);

  bind: ContextManager["bind"] = (ctx, target) => this.delegate.bind(ctx, target);

  enable(): this {
    this.delegate.enable();
    this.running = true;
    return this;
  }

  disable(): this {
    this.running = false;
    this.delegate.disable();
    return this;
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
    this.running = false;
    this.getOperation = undefined;
    return Promise.resolve();
  }
}
