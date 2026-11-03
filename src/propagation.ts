// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isSpanContextValid, trace, type TextMapPropagator } from "@opentelemetry/api";
import {
  CompositePropagator,
  isTracingSuppressed,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import type { MicrosoftOpenTelemetryBrowserTraceOptions } from "./types.js";

/** Builds page-lifetime propagation without changing the instrumentations' URL allow lists. */
export function createPropagator(
  options: MicrosoftOpenTelemetryBrowserTraceOptions,
): TextMapPropagator {
  if (options.propagators !== undefined) {
    return new CompositePropagator({ propagators: options.propagators.slice() });
  }

  const mode = options.distributedTracingMode === undefined ? 18 : options.distributedTracingMode;
  if (![0, 1, 2, 17, 18].includes(mode)) {
    throw new TypeError("distributedTracingMode must be 0, 1, 2, 17, or 18");
  }
  const appId = options.appId;
  if (
    appId !== undefined &&
    (typeof appId !== "string" || !/^[\x21-\x7e]+$/.test(appId) || /[,;=]/.test(appId))
  ) {
    throw new TypeError(
      "appId must be non-empty printable ASCII without spaces, commas, semicolons or equals signs",
    );
  }

  const w3c = mode === 0 ? undefined : new W3CTraceContextPropagator();
  const legacy = mode === 0 || mode === 1 || mode === 17;
  const fields = [
    ...(w3c ? ["traceparent", ...(mode >= 16 ? ["tracestate"] : [])] : []),
    ...(legacy ? ["Request-Id"] : []),
    ...(appId !== undefined ? ["Request-Context"] : []),
  ];
  const correlation: TextMapPropagator = {
    fields: () => fields.slice(),
    extract: (ctx, carrier, getter) => w3c?.extract(ctx, carrier, getter) ?? ctx,
    inject(ctx, carrier, setter) {
      const span = trace.getSpanContext(ctx);
      if (!span || !isSpanContextValid(span) || isTracingSuppressed(ctx)) return;
      w3c?.inject(ctx, carrier, {
        set(target, key, value) {
          if (key !== "tracestate" || mode >= 16) setter.set(target, key, value);
        },
      });
      if (legacy) setter.set(carrier, "Request-Id", `|${span.traceId}.${span.spanId}`);
      if (appId !== undefined) setter.set(carrier, "Request-Context", `appId=cid-v1:${appId}`);
    },
  };
  return new CompositePropagator({ propagators: [correlation, new W3CBaggagePropagator()] });
}
