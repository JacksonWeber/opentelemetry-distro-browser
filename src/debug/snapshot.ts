// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** Copy a bounded tree before serialization, without invoking payload getters or toJSON methods. */
export function snapshot(value: unknown, limit: number): string {
  const seen = new WeakSet<object>();
  let remaining = limit;
  let nodes = 0;
  function copy(value: unknown, depth: number): unknown {
    if (--remaining < 0 || ++nodes > 1000 || depth > 8) return "[Truncated]";
    if (typeof value === "string") {
      const length = Math.max(0, remaining);
      remaining -= value.length;
      return value.length > length ? `${value.slice(0, length)}[Truncated]` : value;
    }
    if (typeof value === "bigint") return String(value);
    if (typeof value === "function") return "[Function]";
    if (typeof value === "symbol") return "[Symbol]";
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : (Object.create(null) as Record<string, unknown>);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (remaining <= 0 || nodes >= 1000) {
        if (Array.isArray(result)) result.push("[Truncated]");
        else result["[Truncated]"] = true;
        break;
      }
      remaining -= key.length;
      const property = Object.getOwnPropertyDescriptor(value, key);
      const child: unknown = property && "value" in property ? property.value : "[Accessor]";
      const copied = copy(child, depth + 1);
      if (Array.isArray(result)) result.push(copied);
      else result[key.slice(0, limit)] = copied;
    }
    seen.delete(value);
    return result;
  }
  const json = JSON.stringify(copy(value, 0), null, 2) ?? "null";
  return json.length > limit ? `${json.slice(0, Math.max(0, limit - 14))}\n[Truncated]` : json;
}

export function spanDetails(span: ReadableSpan): object {
  return {
    name: span.name,
    spanContext: span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    kind: span.kind,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    status: span.status,
    attributes: span.attributes,
    events: span.events,
    links: span.links,
    resource: span.resource.attributes,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export function logDetails(record: ReadableLogRecord): object {
  return {
    eventName: record.eventName,
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: record.body,
    hrTime: record.hrTime,
    hrTimeObserved: record.hrTimeObserved,
    spanContext: record.spanContext,
    attributes: record.attributes,
    resource: record.resource.attributes,
    instrumentationScope: record.instrumentationScope,
    droppedAttributesCount: record.droppedAttributesCount,
  };
}
