// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  defaultTextMapGetter,
  diag,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type SpanContext,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

/** Reads the initial document's remote parent without changing global propagation. */
export function readServerTraceContext(): SpanContext | undefined {
  const [navigation] = (performance.getEntriesByType?.("navigation") ??
    []) as PerformanceNavigationTiming[];
  // A late initialization on a different SPA route must not reuse the document's server parent.
  if (navigation?.name && navigation.name.split("#")[0] !== location.href.split("#")[0]) {
    return undefined;
  }
  const sources = [
    (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content,
    (name: string) => navigation?.serverTiming?.find((entry) => entry.name === name)?.description,
  ];
  for (const get of sources) {
    const traceparent = get("traceparent");
    if (!traceparent) continue;
    const extracted = new W3CTraceContextPropagator().extract(
      ROOT_CONTEXT,
      { traceparent, tracestate: get("tracestate") },
      defaultTextMapGetter,
    );
    const parent = trace.getSpanContext(extracted);
    if (parent) {
      parent.traceFlags &= TraceFlags.SAMPLED;
      return parent;
    }
    diag.warn("Ignoring invalid server traceparent.");
  }
  return undefined;
}
