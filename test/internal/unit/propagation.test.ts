// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ROOT_CONTEXT,
  createContextKey,
  createTraceState,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  trace,
  type SpanContext,
  type TextMapPropagator,
} from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { describe, expect, it, vi } from "vitest";
import { createPropagator } from "../../../src/propagation.js";
import type { MicrosoftOpenTelemetryBrowserTraceOptions } from "../../../src/index.js";

const span: SpanContext = {
  traceId: "1234567890abcdef1234567890abcdef",
  spanId: "1234567890abcdef",
  traceFlags: 1,
  traceState: createTraceState("vendor=state"),
};
const modes = [
  { mode: undefined, legacy: false, w3c: true, state: true },
  { mode: 0, legacy: true, w3c: false, state: false },
  { mode: 1, legacy: true, w3c: true, state: false },
  { mode: 2, legacy: false, w3c: true, state: false },
  { mode: 17, legacy: true, w3c: true, state: true },
  { mode: 18, legacy: false, w3c: true, state: true },
] as const;

describe.each(modes)("tracing mode $mode", ({ mode, legacy, w3c, state }) => {
  it.each([undefined, "frontend-app"])("injects the exact headers with appId=%s", (appId) => {
    const propagator = createPropagator({ distributedTracingMode: mode, appId });
    const baggage = propagation.createBaggage({ tenant: { value: "contoso" } });
    const ctx = propagation.setBaggage(trace.setSpanContext(ROOT_CONTEXT, span), baggage);
    const carrier: Record<string, string> = {};
    propagator.inject(ctx, carrier, defaultTextMapSetter);
    expect(carrier).toEqual({
      ...(w3c ? { traceparent: `00-${span.traceId}-${span.spanId}-01` } : {}),
      ...(state ? { tracestate: "vendor=state" } : {}),
      ...(legacy ? { "Request-Id": `|${span.traceId}.${span.spanId}` } : {}),
      ...(appId ? { "Request-Context": `appId=cid-v1:${appId}` } : {}),
      baggage: "tenant=contoso",
    });
    expect(propagator.fields()).toEqual(Object.keys(carrier));
    propagator.fields().push("not-a-field");
    expect(propagator.fields()).toEqual(Object.keys(carrier));
  });

  it("extracts only supported standard headers and preserves application context", () => {
    const propagator = createPropagator({ distributedTracingMode: mode });
    const key = createContextKey("application-context");
    const base = ROOT_CONTEXT.setValue(key, "preserved");
    const extracted = propagator.extract(
      base,
      {
        traceparent: `00-${span.traceId}-${span.spanId}-00`,
        tracestate: "vendor=state",
        baggage: "tenant=contoso",
        "Request-Id": "|legacy.parent.",
        "Request-Context": "appId=cid-v1:remote-app",
      },
      defaultTextMapGetter,
    );
    if (w3c) {
      expect(trace.getSpanContext(extracted)).toMatchObject({
        traceId: span.traceId,
        spanId: span.spanId,
        traceFlags: 0,
        isRemote: true,
      });
      expect(trace.getSpanContext(extracted)?.traceState?.serialize()).toBe("vendor=state");
    } else {
      expect(trace.getSpanContext(extracted)).toBeUndefined();
    }
    expect(extracted.getValue(key)).toBe("preserved");
    expect(propagation.getBaggage(extracted)?.getEntry("tenant")?.value).toBe("contoso");
    expect(trace.getSpanContext(base)).toBeUndefined();
  });
});

it.each([0, 1])("uses explicit span IDs even when traceFlags=%s", (traceFlags) => {
  const propagator = createPropagator({ distributedTracingMode: 17, appId: "frontend" });
  const carrier = new Headers({ "x-application": "preserved" });
  propagator.inject(trace.setSpanContext(ROOT_CONTEXT, { ...span, traceFlags }), carrier, {
    set: (headers, key, value) => headers.set(key, String(value)),
  });
  expect(carrier.get("request-id")).toBe(`|${span.traceId}.${span.spanId}`);
  expect(carrier.get("traceparent")).toBe(`00-${span.traceId}-${span.spanId}-0${traceFlags}`);
  expect(carrier.get("request-context")).toBe("appId=cid-v1:frontend");
  expect(carrier.get("x-application")).toBe("preserved");
});

it.each([
  ROOT_CONTEXT,
  trace.setSpanContext(ROOT_CONTEXT, { ...span, traceId: "0".repeat(32) }),
  trace.setSpanContext(ROOT_CONTEXT, { ...span, spanId: "0".repeat(16) }),
  trace.setSpanContext(ROOT_CONTEXT, { ...span, spanId: "invalid" }),
  suppressTracing(trace.setSpanContext(ROOT_CONTEXT, span)),
])("does not inject correlation without a valid, unsuppressed span", (ctx) => {
  const carrier = {};
  createPropagator({ distributedTracingMode: 17, appId: "frontend" }).inject(
    ctx,
    carrier,
    defaultTextMapSetter,
  );
  expect(carrier).toEqual({});
});

it("does not infer trace context from legacy request headers", () => {
  const ctx = trace.setSpanContext(ROOT_CONTEXT, span);
  expect(
    createPropagator({ distributedTracingMode: 17 }).extract(
      ctx,
      { "Request-Id": "|another.trace.", "Request-Context": "appId=cid-v1:remote" },
      defaultTextMapGetter,
    ),
  ).toBe(ctx);
});

it.each([null, -1, 3, 16, 19, 1.5, NaN, Infinity, "1"])("rejects invalid mode %s", (mode) => {
  expect(() =>
    createPropagator({
      // @ts-expect-error Exercise invalid JavaScript configuration.
      distributedTracingMode: mode,
    }),
  ).toThrow("distributedTracingMode must be 0, 1, 2, 17, or 18");
});

it.each([null, 123, "", "with space", "app\r\nInjected: true", "a,b", "a;b", "a=b", "\u00e9"])(
  "rejects invalid appId %j without including its value in the error",
  (appId) => {
    expect(() =>
      createPropagator({
        // @ts-expect-error Exercise invalid JavaScript configuration.
        appId,
      }),
    ).toThrow(
      "appId must be non-empty printable ASCII without spaces, commas, semicolons or equals signs",
    );
  },
);

it("captures configuration without mutating it or retaining mutable options", () => {
  const options: MicrosoftOpenTelemetryBrowserTraceOptions = {
    distributedTracingMode: 0,
    appId: "first",
  };
  const propagator = createPropagator(options);
  options.distributedTracingMode = 18;
  options.appId = "second";
  const carrier = {};
  propagator.inject(trace.setSpanContext(ROOT_CONTEXT, span), carrier, defaultTextMapSetter);
  expect(carrier).toEqual({
    "Request-Id": `|${span.traceId}.${span.spanId}`,
    "Request-Context": "appId=cid-v1:first",
  });
  expect(() => createPropagator(Object.freeze(options))).not.toThrow();
});

it.each([false, true])("lets custom propagators replace all defaults (empty=%s)", (empty) => {
  const inject = vi.fn((_ctx, carrier, setter) => setter.set(carrier, "custom", "value"));
  const custom: TextMapPropagator = {
    fields: () => ["custom"],
    inject,
    extract: (ctx) => ctx,
  };
  const propagators = empty ? [] : [custom];
  const propagator = createPropagator(
    Object.freeze({
      propagators: Object.freeze(propagators),
      distributedTracingMode: 17,
      appId: "unused invalid value",
    }),
  );
  const carrier = {};
  propagator.inject(trace.setSpanContext(ROOT_CONTEXT, span), carrier, defaultTextMapSetter);
  expect(carrier).toEqual(empty ? {} : { custom: "value" });
  expect(inject).toHaveBeenCalledTimes(empty ? 0 : 1);
});
