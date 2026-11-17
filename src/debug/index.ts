// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { reportError, reportWithoutTelemetry } from "../shared/globalOwnership.js";
import { createPanel } from "./panel.js";
import { logDetails, snapshot, spanDetails } from "./snapshot.js";
import type { TelemetryDebugEntry, TelemetryDebugger, TelemetryDebuggerOptions } from "./types.js";

export type { TelemetryDebugEntry, TelemetryDebugger, TelemetryDebuggerOptions } from "./types.js";

/**
 * Mounts an opt-in, development-only telemetry inspector. Importing this entry has no side effects.
 *
 * @remarks
 * Compose wrappers around standard processors and their exporters before SDK initialization.
 * Processor observations precede delegate processing. Exporter observations reflect the records
 * handed to that exporter. Use both to distinguish emission from export, including failures.
 * Enable `performance` to record processor callbacks, flush, shutdown, export latency, and explicit
 * `measure` calls. User Timing names contain operation names only, never telemetry payloads.
 *
 * @throws RangeError for invalid retention limits.
 * @throws Error outside a browser or before a mount container exists.
 * @public
 */
export function createTelemetryDebugger(options: TelemetryDebuggerOptions = {}): TelemetryDebugger {
  const maxEntries = boundedInteger(options.maxEntries ?? 200, 1, 10000, "maxEntries");
  const maxPayloadLength = boundedInteger(
    options.maxPayloadLength ?? 16000,
    256,
    1000000,
    "maxPayloadLength",
  );
  const container =
    options.container ?? (typeof document === "undefined" ? undefined : document.body);
  if (!container) throw new Error("Telemetry debugger requires a browser mount container.");
  const name = options.name ?? "Telemetry";
  const timingEnabled = options.performance ?? false;
  const prefix = timingEnabled
    ? `otel.debug.${globalThis.crypto.getRandomValues(new Uint32Array(2)).join(".")}`
    : "";
  let entries: TelemetryDebugEntry[] = [];
  const timings: string[] = [];
  let nextId = 0;
  let nextTiming = 0;
  let dropped = 0;
  let paused = false;
  let disposed = false;
  let observing = false;
  let generation = 0;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;

  // Debug failures must not alter telemetry delivery, even with console instrumentation enabled.
  function observe(action: () => void): void {
    if (disposed || observing) return;
    observing = true;
    try {
      action();
    } catch {
      reportWithoutTelemetry(() =>
        reportError("[telemetry-debug] Observation failed. Telemetry processing continues."),
      );
    } finally {
      observing = false;
    }
  }
  const panel = createPanel(container, name.slice(0, 200), {
    pause: () => setPaused(!paused),
    clear,
    dispose,
  });
  function render(): void {
    if (renderTimer !== undefined || disposed) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      observe(() => panel.update(entries, dropped, paused));
    }, 0);
  }
  function clearTiming(name: string): void {
    performance.clearMarks(`${name}.start`);
    performance.clearMarks(`${name}.end`);
    performance.clearMeasures(name);
  }
  function startTiming(operation: string): () => void {
    if (!timingEnabled || paused || disposed || observing) return () => {};
    let start: number | undefined;
    observe(() => {
      start = performance.now();
    });
    const version = generation;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (start === undefined || version !== generation) return;
      const startTime = start;
      observe(() => {
        const name = `${prefix}.${++nextTiming}.${operation}`;
        timings.push(name);
        while (timings.length > maxEntries) {
          const oldest = timings.shift();
          if (oldest) clearTiming(oldest);
        }
        performance.mark(`${name}.start`, { startTime });
        performance.mark(`${name}.end`);
        performance.measure(name, `${name}.start`, `${name}.end`);
      });
    };
  }
  function sync<T>(name: string, action: () => T): T {
    const end = startTiming(name);
    try {
      return action();
    } finally {
      end();
    }
  }
  async function measure<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (!name || name.length > 80)
      throw new RangeError("Timing names must contain 1 to 80 characters.");
    const end = startTiming(name);
    try {
      return await action();
    } finally {
      end();
    }
  }
  function capture(
    signal: "span" | "log",
    phase: "emitted" | "exporting",
    record: ReadableSpan | ReadableLogRecord,
  ): number | undefined {
    if (paused) return;
    let id: number | undefined;
    observe(() => {
      const context = isSpan(record) ? record.spanContext() : record.spanContext;
      const name = isSpan(record)
        ? record.name
        : (record.eventName ?? record.severityText ?? "Log record");
      const payload = snapshot(
        isSpan(record) ? spanDetails(record) : logDetails(record),
        maxPayloadLength,
      );
      id = ++nextId;
      entries.push(
        Object.freeze({
          id,
          timestamp: Date.now(),
          signal,
          phase,
          name: name.slice(0, 200),
          traceId: context?.traceId,
          spanId: context?.spanId,
          payload,
        }),
      );
      if (entries.length > maxEntries) {
        entries.shift();
        dropped++;
      }
      render();
    });
    return id;
  }
  function exportRecords<T extends ReadableSpan | ReadableLogRecord>(
    signal: "span" | "log",
    records: T[],
    callback: (result: ExportResult) => void,
    delegate: (callback: (result: ExportResult) => void) => void,
  ): void {
    const ids = new Set<number>();
    const start = Math.max(0, records.length - maxEntries);
    if (!paused && !disposed) dropped += start;
    for (let i = start; i < records.length; i++) {
      const id = capture(signal, "exporting", records[i]);
      if (id !== undefined) ids.add(id);
    }
    const end = startTiming(`${signal}.export`);
    let completed = false;
    const complete = (success: boolean): void => {
      if (completed) return;
      completed = true;
      end();
      observe(() => {
        entries = entries.map((entry) =>
          ids.has(entry.id)
            ? Object.freeze({ ...entry, phase: success ? "exported" : "failed" })
            : entry,
        );
        render();
      });
    };
    try {
      delegate((result) => {
        complete(result.code === ExportResultCode.SUCCESS);
        callback(result);
      });
    } catch (error) {
      complete(false);
      throw error;
    }
  }
  function setPaused(value: boolean): void {
    paused = value;
    render();
  }
  function clear(): void {
    generation++;
    entries = [];
    dropped = 0;
    observe(() => {
      for (const name of timings.splice(0)) clearTiming(name);
    });
    if (!disposed) panel.update(entries, dropped, paused);
  }
  function dispose(): void {
    if (disposed) return;
    clear();
    disposed = true;
    if (renderTimer !== undefined) clearTimeout(renderTimer);
    renderTimer = undefined;
    panel.dispose();
  }
  panel.update(entries, dropped, paused);
  return {
    element: panel.element,
    wrapSpanProcessor: (processor) => ({
      onStart: (span, context) => sync("span.onStart", () => processor.onStart(span, context)),
      ...(processor.onEnding
        ? { onEnding: (span) => sync("span.onEnding", () => processor.onEnding?.(span)) }
        : {}),
      onEnd(span) {
        capture("span", "emitted", span);
        sync("span.onEnd", () => processor.onEnd(span));
      },
      forceFlush: () => measure("span.forceFlush", () => processor.forceFlush()),
      shutdown: () => measure("span.shutdown", () => processor.shutdown()),
    }),
    wrapLogRecordProcessor: (processor) => {
      const enabled = processor.enabled?.bind(processor);
      return {
        ...(enabled ? { enabled } : {}),
        onEmit(record, context) {
          capture("log", "emitted", record);
          sync("log.onEmit", () => processor.onEmit(record, context));
        },
        forceFlush: (options) => measure("log.forceFlush", () => processor.forceFlush(options)),
        shutdown: () => measure("log.shutdown", () => processor.shutdown()),
      };
    },
    wrapSpanExporter: (exporter) => {
      const forceFlush = exporter.forceFlush?.bind(exporter);
      return {
        export: (records, callback) =>
          exportRecords("span", records, callback, (done) => exporter.export(records, done)),
        ...(forceFlush ? { forceFlush } : {}),
        shutdown: () => exporter.shutdown(),
      };
    },
    wrapLogRecordExporter: (exporter) => ({
      export: (records, callback) =>
        exportRecords("log", records, callback, (done) => exporter.export(records, done)),
      forceFlush: () => exporter.forceFlush(),
      shutdown: () => exporter.shutdown(),
    }),
    measure,
    getEntries: () => Object.freeze(entries.slice()),
    setPaused,
    clear,
    dispose,
  };
}

function isSpan(record: ReadableSpan | ReadableLogRecord): record is ReadableSpan {
  return typeof record.spanContext === "function";
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
