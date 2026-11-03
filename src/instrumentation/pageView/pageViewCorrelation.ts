// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isSpanContextValid, trace, type Context, type SpanContext } from "@opentelemetry/api";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { isPageContext } from "../../shared/pageOperationContext.js";
import { NAME_SOURCE_EXPLICIT, NAME_SOURCE_ROUTE } from "./semconv.js";
import type { PageView, PageViewSource } from "./types.js";

const MAX_OPERATION_NAMES = 32;

/** Removes a synthetic page operation while preserving application contexts and values. */
export function withoutPageOperation(active: Context): Context {
  const spanContext = trace.getSpanContext(active);
  return spanContext && isPageContext(spanContext) ? trace.deleteSpan(active) : active;
}

/**
 * Uses the page operation only when telemetry has no valid application-supplied span context.
 * Stops exposing synthetic page contexts at shutdown while preserving application contexts.
 */
export class PageViewCorrelation implements LogRecordProcessor {
  private operationNames = new Map<string, string | undefined>();
  private readonly releasePageViews: (() => void) | undefined;

  constructor(
    private getOperation: (() => SpanContext | undefined) | undefined,
    pageViews?: PageViewSource,
    private getUnpublishedOperationName?: (traceId: string) => string | undefined,
  ) {
    const track = (pageView: PageView): void => {
      const name =
        pageView.nameSource === NAME_SOURCE_EXPLICIT || pageView.nameSource === NAME_SOURCE_ROUTE
          ? pageView.name
          : undefined;
      this.operationNames.delete(pageView.id);
      this.operationNames.set(pageView.id, name);
      if (this.operationNames.size > MAX_OPERATION_NAMES) {
        const oldest = this.operationNames.keys().next().value;
        if (oldest !== undefined) this.operationNames.delete(oldest);
      }
    };
    const current = pageViews?.getCurrentPageView();
    if (current) track(current);
    this.releasePageViews = pageViews?.onPageViewChanged(track);
  }

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

  /** The safe page name for an operation, until shutdown. */
  operationName(traceId?: string): string | undefined {
    const operationId = traceId ?? this.getOperation?.()?.traceId;
    if (!operationId) return undefined;
    if (this.operationNames.has(operationId)) {
      const name = this.operationNames.get(operationId);
      this.operationNames.delete(operationId);
      this.operationNames.set(operationId, name);
      return name;
    }
    if (this.getOperation?.()?.traceId !== operationId) return undefined;
    const name = this.getUnpublishedOperationName?.(operationId);
    this.operationNames.set(operationId, name);
    return name;
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
    this.getUnpublishedOperationName = undefined;
    this.releasePageViews?.();
    this.operationNames.clear();
    return Promise.resolve();
  }
}
