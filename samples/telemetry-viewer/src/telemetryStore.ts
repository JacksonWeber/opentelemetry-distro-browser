import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

export type TelemetryKind = "span" | "log";
export const MAX_TELEMETRY_ITEMS = 500;

export interface TelemetryItem {
  id: string;
  kind: TelemetryKind;
  name: string;
  timestamp: number;
  durationMs?: number;
  traceId?: string;
  spanId?: string;
  severity?: string;
  searchText: string;
  details: Record<string, unknown>;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let items: TelemetryItem[] = [];
let capturing = true;
let nextId = 1;
let droppedItems = 0;

function hrTimeToMilliseconds(time: readonly [number, number]): number {
  return time[0] * 1_000 + time[1] / 1_000_000;
}

function createItem(item: Omit<TelemetryItem, "id" | "searchText">): TelemetryItem {
  const result = {
    ...item,
    id: String(nextId++),
    searchText: "",
  };
  result.searchText = JSON.stringify(result).toLowerCase();
  return result;
}

function add(newItems: TelemetryItem[]): void {
  if (!capturing || newItems.length === 0) return;
  const nextItems = [...newItems.reverse(), ...items];
  droppedItems += Math.max(0, nextItems.length - MAX_TELEMETRY_ITEMS);
  items = nextItems.slice(0, MAX_TELEMETRY_ITEMS);
  listeners.forEach((listener) => listener());
}

function spanToItem(span: ReadableSpan): TelemetryItem {
  const context = span.spanContext();
  const details = {
    signal: "span",
    name: span.name,
    spanContext: context,
    parentSpanContext: span.parentSpanContext,
    kind: span.kind,
    startTime: new Date(hrTimeToMilliseconds(span.startTime)).toISOString(),
    endTime: new Date(hrTimeToMilliseconds(span.endTime)).toISOString(),
    durationMs: hrTimeToMilliseconds(span.duration),
    ended: span.ended,
    status: span.status,
    attributes: span.attributes,
    droppedAttributesCount: span.droppedAttributesCount,
    events: span.events,
    droppedEventsCount: span.droppedEventsCount,
    links: span.links,
    droppedLinksCount: span.droppedLinksCount,
    resource: span.resource.attributes,
    instrumentationScope: span.instrumentationScope,
  };

  return createItem({
    kind: "span",
    name: span.name,
    timestamp: hrTimeToMilliseconds(span.startTime),
    durationMs: hrTimeToMilliseconds(span.duration),
    traceId: context.traceId,
    spanId: context.spanId,
    details,
  });
}

function logToItem(record: ReadableLogRecord): TelemetryItem {
  const context = record.spanContext;
  const name = record.eventName ?? record.severityText ?? "Log record";
  const details = {
    signal: "log",
    eventName: record.eventName,
    timestamp: new Date(hrTimeToMilliseconds(record.hrTime)).toISOString(),
    observedTimestamp: new Date(hrTimeToMilliseconds(record.hrTimeObserved)).toISOString(),
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: record.body,
    attributes: record.attributes,
    droppedAttributesCount: record.droppedAttributesCount,
    spanContext: context,
    resource: record.resource.attributes,
    instrumentationScope: record.instrumentationScope,
  };

  return createItem({
    kind: "log",
    name,
    timestamp: hrTimeToMilliseconds(record.hrTime),
    traceId: context?.traceId,
    spanId: context?.spanId,
    severity: record.severityText,
    details,
  });
}

export const telemetryStore = {
  getItems(): readonly TelemetryItem[] {
    return items;
  },
  getDroppedItems(): number {
    return droppedItems;
  },
  isCapturing(): boolean {
    return capturing;
  },
  setCapturing(value: boolean): void {
    capturing = value;
    listeners.forEach((listener) => listener());
  },
  clear(): void {
    items = [];
    droppedItems = 0;
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export class ViewerSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    add(spans.map(spanToItem));
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  async shutdown(): Promise<void> {}
}

export class ViewerLogRecordExporter implements LogRecordExporter {
  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    add(records.map(logToItem));
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
