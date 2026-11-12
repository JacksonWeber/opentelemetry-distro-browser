// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogRecordExporter, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Development-only viewer configuration. @public */
export interface TelemetryDebuggerOptions {
  /** Element to contain the isolated shadow-DOM panel. Defaults to document.body. */
  container?: HTMLElement;
  /** Display label for this debugger's pipeline. Defaults to "Telemetry". */
  name?: string;
  /** Maximum retained observations and completed timing operations, each. Default 200, maximum 10000. */
  maxEntries?: number;
  /** Maximum characters per payload snapshot. Default 16000, maximum 1000000. */
  maxPayloadLength?: number;
  /** Emit bounded User Timing marks and measures for wrapped SDK operations. Defaults to false. */
  performance?: boolean;
}

/** An immutable, bounded snapshot, not a reference to a live SDK record. @public */
export interface TelemetryDebugEntry {
  /** Unique observation ID within this debugger. */
  readonly id: number;
  /** Time observed, in milliseconds since the Unix epoch. */
  readonly timestamp: number;
  /** OpenTelemetry signal. */
  readonly signal: "span" | "log";
  /**
   * Emitted means a processor received the record. Exporting means the exporter was called.
   * Exported means its callback reported success, not that ingestion was verified.
   */
  readonly phase: "emitted" | "exporting" | "exported" | "failed";
  /** Span name, log event name, or severity. */
  readonly name: string;
  /** Trace identity when present. */
  readonly traceId?: string;
  /** Span identity when present. */
  readonly spanId?: string;
  /** Bounded JSON snapshot. Truncation and circular references are explicitly indicated. */
  readonly payload: string;
}

/**
 * Development-only telemetry inspection, composed with standard OpenTelemetry pipelines.
 *
 * @remarks
 * Use a separate debugger per telemetry instance. Wrap each processor/exporter only once.
 * Wrappers preserve the delegate's telemetry, callbacks, errors, and lifecycle ownership.
 * No globals, browser APIs, or network transports are patched. Records sampled out before
 * processing are not visible. Export snapshots are OTel records, not serialized wire envelopes.
 *
 * Payloads can contain sensitive application data. Enable only in development with appropriate
 * consent. Data stays in memory and the page, with no storage or additional network requests.
 * Dispose the debugger separately after shutting down its SDK, including on failed startup.
 * @public
 */
export interface TelemetryDebugger {
  /** Panel host. All controls and payloads are inside its shadow root. */
  readonly element: HTMLElement;
  /** Observe ended spans and time processor operations without changing sampling. */
  wrapSpanProcessor(processor: SpanProcessor): SpanProcessor;
  /** Observe emitted logs and time processor operations, preserving enabled checks. */
  wrapLogRecordProcessor(processor: LogRecordProcessor): LogRecordProcessor;
  /** Observe export attempts and their completion. Does not add or replace an exporter. */
  wrapSpanExporter(exporter: SpanExporter): SpanExporter;
  /** Observe export attempts and their completion. Does not add or replace an exporter. */
  wrapLogRecordExporter(exporter: LogRecordExporter): LogRecordExporter;
  /**
   * Optionally time an asynchronous SDK operation such as initialization or handle shutdown.
   * Returns its result or propagates its error unchanged. Names must contain 1 to 80 characters.
   */
  measure<T>(name: string, operation: () => Promise<T>): Promise<T>;
  /** Read retained observations oldest first. Entries and the returned array are immutable. */
  getEntries(): readonly TelemetryDebugEntry[];
  /** Stop new observations and timings without pausing telemetry export. Pending results still settle. */
  setPaused(paused: boolean): void;
  /** Clear observations and owned timings. Older in-flight work cannot repopulate the view. */
  clear(): void;
  /**
   * Idempotently remove the panel, scheduled rendering, payloads, and owned User Timing entries.
   * Existing wrappers remain transparent delegates. Does not shut down the SDK or its exporters.
   */
  dispose(): void;
}
