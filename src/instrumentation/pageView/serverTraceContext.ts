// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, TraceFlags, type SpanContext } from "@opentelemetry/api";
import { parseTraceParent, TraceState } from "@opentelemetry/core";

/** Reads the initial document's remote parent without changing global propagation. */
export function readServerTraceContext(
  navigation?: PerformanceNavigationTiming,
): SpanContext | undefined {
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
    const parent = traceparent && parseTraceParent(traceparent);
    if (parent) {
      parent.isRemote = true;
      parent.traceFlags &= TraceFlags.SAMPLED;
      const state = get("tracestate");
      if (state) parent.traceState = new TraceState(state);
      return parent;
    }
    if (traceparent) diag.warn("Invalid server traceparent.");
  }
  return undefined;
}
