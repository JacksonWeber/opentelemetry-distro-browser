// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  createContextKey,
  diag,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logToEnvelope } from "../../../src/exporter/logUtils.js";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import { PageViewInstrumentation } from "../../../src/instrumentation/pageView/pageViewInstrumentation.js";
import { readServerTraceContext as extractServerTraceContext } from "../../../src/instrumentation/pageView/serverTraceContext.js";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/types.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
const traceparent = `00-${traceId}-${spanId}-01`;
const originalUrl = location.href;
const originalPush = history.pushState;
const originalReplace = history.replaceState;
const handles: MicrosoftOpenTelemetryBrowser[] = [];
const metaTags: HTMLMetaElement[] = [];

function readServerTraceContext() {
  const [navigation] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  return extractServerTraceContext(navigation);
}

function meta(name: string, content: string): void {
  const element = document.createElement("meta");
  element.name = name;
  element.content = content;
  document.head.append(element);
  metaTags.push(element);
}

function serverTiming(parent?: string, state?: string, name = originalUrl): void {
  const navigation = {
    name,
    entryType: "navigation",
    startTime: 0,
    duration: 0,
    toJSON: () => ({}),
    serverTiming: [
      { name: "traceparent", description: parent ?? "" },
      { name: "tracestate", description: state ?? "" },
    ],
  };
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([navigation]);
}

async function start(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
  const pipeline = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({ ...pipeline.options, ...options });
  handles.push(handle);
  return { ...pipeline, handle };
}

afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.shutdown();
  history.pushState = originalPush;
  history.replaceState = originalReplace;
  history.replaceState(null, "", originalUrl);
  for (const element of metaTags.splice(0)) element.remove();
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  vi.restoreAllMocks();
});

describe.each(["meta", "header"] as const)("%s server context", (source) => {
  function supply(parent: string, state?: string): void {
    if (source === "header") {
      serverTiming(parent, state);
    } else {
      meta("traceparent", parent);
      if (state !== undefined) meta("tracestate", state);
    }
  }

  it("extracts a remote parent and its trace state", () => {
    supply(traceparent, "vendor=state");
    const parent = readServerTraceContext();
    expect(parent).toMatchObject({ traceId, spanId, traceFlags: 1, isRemote: true });
    expect(parent?.traceState?.serialize()).toBe("vendor=state");
  });

  it.each([
    "",
    "invalid",
    `00-${"0".repeat(32)}-${spanId}-01`,
    `00-${traceId}-${"0".repeat(16)}-01`,
    `00-${traceId.toUpperCase()}-${spanId}-01`,
    `ff-${traceId}-${spanId}-01`,
    `00-${traceId}-${spanId}-01-extra`,
    `00-${traceId}-${spanId}-0g`,
    `00-${traceId}-${spanId}`,
  ])("rejects malformed parent %s", (parent) => {
    supply(parent);
    const warning = vi.spyOn(diag, "warn").mockImplementation(() => {});
    expect(readServerTraceContext()).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(parent ? 1 : 0);
  });

  it("ignores invalid trace state without losing a valid parent", () => {
    supply(traceparent, "INVALID=state");
    const parent = readServerTraceContext();
    expect(parent?.traceId).toBe(traceId);
    expect(parent?.traceState?.serialize()).toBe("");
  });

  it("accepts future versions and retains only the sampled flag", () => {
    supply(`01-${traceId}-${spanId}-03-extra`);
    expect(readServerTraceContext()).toMatchObject({ traceId, spanId, traceFlags: 1 });
  });

  it("parents page views, dependencies and logs on the server span", async () => {
    supply(traceparent, "vendor=state");
    const pipeline = await start();
    trace.getTracer("test").startSpan("dependency").end();
    logs.getLogger("test").emit({ body: "during load" });
    window.dispatchEvent(new Event("pagehide"));
    await pipeline.handle.forceFlush();

    const [span] = pipeline.spanExporter.getFinishedSpans();
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.parentSpanContext).toMatchObject({ traceId, spanId, isRemote: true });
    expect(spanToEnvelope(span, "key").tags["ai.operation.parentId"]).toBe(spanId);
    const records = pipeline.logExporter.getFinishedLogRecords();
    expect(records.some((record) => record.eventName === "browser.page_view")).toBe(true);
    for (const record of records) {
      expect(record.spanContext?.traceId).toBe(traceId);
      expect(logToEnvelope(record, "key").tags["ai.operation.parentId"]).toBe(spanId);
    }
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    expect(headers).toEqual({ traceparent, tracestate: "vendor=state" });
  });
});

it("prefers valid meta context without mixing trace state from another source", () => {
  meta("traceparent", traceparent);
  serverTiming(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`, "header=state");
  const parent = readServerTraceContext();
  expect(parent?.traceId).toBe(traceId);
  expect(parent?.traceState).toBeUndefined();
});

it("falls back to header context when the meta parent is invalid", () => {
  meta("traceparent", "invalid");
  meta("tracestate", "meta=state");
  serverTiming(traceparent, "header=state");
  vi.spyOn(diag, "warn").mockImplementation(() => {});
  const parent = readServerTraceContext();
  expect(parent?.traceId).toBe(traceId);
  expect(parent?.traceState?.serialize()).toBe("header=state");
});

it("reads meta context when navigation timing is unavailable", () => {
  meta("traceparent", traceparent);
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
  expect(readServerTraceContext()?.traceId).toBe(traceId);
});

it.each([undefined, "invalid"])("starts a fresh operation for parent %s", async (parent) => {
  if (parent) meta("traceparent", parent);
  vi.spyOn(diag, "warn").mockImplementation(() => {});
  await start();
  const operation = trace.getSpanContext(context.active())!;
  expect(isSpanContextValid(operation)).toBe(true);
  expect(operation.traceId).not.toBe(traceId);
  expect(operation.isRemote).not.toBe(true);
});

it("respects the server sampling flag with the default sampler", async () => {
  meta("traceparent", `00-${traceId}-${spanId}-00`);
  const pipeline = await start();
  const span = trace.getTracer("test").startSpan("unsampled dependency");
  expect(span.isRecording()).toBe(false);
  expect(span.spanContext()).toMatchObject({ traceId, traceFlags: 0 });
  span.end();
  window.dispatchEvent(new Event("pagehide"));
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(0);
  expect(pipeline.logExporter.getFinishedLogRecords()[0].spanContext?.traceFlags).toBe(0);
});

it.each([false, true])(
  "preserves explicit initial context with session tracking %s",
  async (enabled) => {
    meta("traceparent", traceparent);
    const explicit = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
    const manager = new StackContextManager();
    const read = vi.spyOn(document, "querySelector");
    await manager.with(trace.setSpanContext(ROOT_CONTEXT, explicit), () =>
      start({ traces: { contextManager: manager }, session: { enabled } }),
    );
    expect(trace.getSpanContext(context.active())).toEqual(explicit);
    expect(read).not.toHaveBeenCalled();
  },
);

it.each([0, 1])(
  "removes captured server page context when its last owner stops (sampled=%s)",
  async (sampled) => {
    meta("traceparent", `00-${traceId}-${spanId}-0${sampled}`);
    const owner = await start();
    const key = createContextKey("application-data");
    const captured = context.active().setValue(key, "retained");
    const parent = trace.getSpanContext(captured)!;
    const pageCallback = context.bind(captured, () => {
      const active = context.active();
      expect(trace.getSpanContext(active)).toBeUndefined();
      expect(active.getValue(key)).toBe("retained");
      const headers: Record<string, string> = {};
      propagation.inject(active, headers);
      expect(headers).toEqual({});
      const span = trace.getTracer("survivor").startSpan("after shutdown");
      expect(span.isRecording()).toBe(true);
      expect(span.spanContext().traceId).not.toBe(traceId);
      span.end();
      logs.getLogger("survivor").emit({ body: "after shutdown" });
    });
    const explicit = trace.setSpanContext(captured, { ...parent });
    const applicationCallback = context.bind(explicit, () => context.active());
    const applicationSpan = trace.getTracer("owner").startSpan("application span");
    const applicationContext = trace.setSpan(captured, applicationSpan);
    const spanCallback = context.bind(applicationContext, () => context.active());
    applicationSpan.end();
    window.dispatchEvent(new Event("pagehide"));
    await owner.handle.forceFlush();
    const bufferedLogs = owner.logExporter.getFinishedLogRecords().slice();
    const bufferedSpans = owner.spanExporter.getFinishedSpans().slice();

    const survivor = await start({ pageView: { enabled: false } });
    const stopping = owner.handle.shutdown();
    pageCallback();
    await stopping;
    pageCallback();
    expect(applicationCallback()).toBe(explicit);
    expect(spanCallback()).toBe(applicationContext);
    expect(trace.getSpanContext(captured)).toBe(parent);
    const explicitHeaders: Record<string, string> = {};
    propagation.inject(applicationCallback(), explicitHeaders);
    expect(explicitHeaders.traceparent).toBe(`00-${traceId}-${spanId}-0${sampled}`);

    await survivor.handle.forceFlush();
    for (const record of survivor.logExporter.getFinishedLogRecords()) {
      expect(record.spanContext).toBeUndefined();
    }
    expect(bufferedLogs.length).toBeGreaterThan(0);
    for (const record of bufferedLogs) {
      expect(logToEnvelope(record, "key").tags["ai.operation.parentId"]).toBe(spanId);
      expect(record.spanContext?.traceFlags).toBe(sampled);
    }
    expect(bufferedSpans).toHaveLength(sampled);
    for (const span of bufferedSpans) {
      expect(spanToEnvelope(span, "key").tags["ai.operation.parentId"]).toBe(spanId);
    }
  },
);

it("opts out without disabling page correlation or outgoing propagation", async () => {
  meta("traceparent", traceparent);
  const read = vi.spyOn(document, "querySelector");
  const pipeline = await start({ pageView: { useServerTraceContext: false } });
  const operation = trace.getSpanContext(context.active())!;
  expect(read).not.toHaveBeenCalled();
  expect(operation.traceId).not.toBe(traceId);
  trace.getTracer("test").startSpan("dependency").end();
  window.dispatchEvent(new Event("pagehide"));
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans()[0].spanContext().traceId).toBe(operation.traceId);
  expect(pipeline.logExporter.getFinishedLogRecords()[0].spanContext?.traceId).toBe(
    operation.traceId,
  );
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  expect(headers.traceparent?.split("-")[1]).toBe(operation.traceId);
});

it("does not override application span or log contexts after startup", async () => {
  meta("traceparent", traceparent);
  const pipeline = await start();
  const explicit = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
  const active = trace.setSpanContext(ROOT_CONTEXT, explicit);
  trace.getTracer("test").startSpan("explicit dependency", {}, active).end();
  logs.getLogger("test").emit({ body: "explicit log", context: active });
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans()[0].parentSpanContext).toEqual(explicit);
  expect(
    pipeline.logExporter.getFinishedLogRecords().find((record) => record.body === "explicit log")
      ?.spanContext,
  ).toEqual(explicit);
  expect(trace.getSpanContext(context.active())?.traceId).toBe(traceId);
});

it.each([false, true])(
  "shares the first instance's choice and hands off ownership (server context=%s)",
  async (useServerTraceContext) => {
    meta("traceparent", traceparent);
    const first = await start({
      spanProcessors: [],
      pageView: { useServerTraceContext },
    });
    const second = await start({ pageView: { useServerTraceContext: !useServerTraceContext } });
    const operation = trace.getSpanContext(context.active())!;
    expect(operation.traceId === traceId).toBe(useServerTraceContext);
    window.dispatchEvent(new Event("pagehide"));
    for (const instance of [first, second]) {
      await instance.handle.forceFlush();
      expect(instance.logExporter.getFinishedLogRecords()[0].spanContext).toEqual(operation);
    }
    await first.handle.shutdown();
    trace.getTracer("test").startSpan("survivor").end();
    await second.handle.forceFlush();
    expect(second.spanExporter.getFinishedSpans()[0].parentSpanContext).toEqual(operation);
  },
);

it("starts fresh SPA traces, including returning to the document URL and late instances", async () => {
  meta("traceparent", traceparent);
  await start();
  expect(trace.getSpanContext(context.active())?.traceId).toBe(traceId);
  history.pushState(null, "", "/server-context-route");
  const route = trace.getSpanContext(context.active())!;
  expect(route.traceId).not.toBe(traceId);
  expect(route.traceState).toBeUndefined();
  const second = await start();
  window.dispatchEvent(new Event("pagehide"));
  await second.handle.forceFlush();
  expect(second.logExporter.getFinishedLogRecords()[0].spanContext?.traceId).toBe(route.traceId);
  history.pushState(null, "", originalUrl);
  const returned = trace.getSpanContext(context.active())!;
  expect(returned.traceId).not.toBe(traceId);
  expect(returned.traceId).not.toBe(route.traceId);
});

it("does not adopt document context when first initialized on a different SPA route", async () => {
  meta("traceparent", traceparent);
  serverTiming(undefined, undefined, originalUrl);
  history.pushState(null, "", "/before-sdk-start");
  await start();
  expect(trace.getSpanContext(context.active())?.traceId).not.toBe(traceId);
});

it.each([false, true])(
  "distinguishes an initial fragment from a late hash route (late=%s)",
  async (late) => {
    const url = new URL(originalUrl);
    url.hash = "/home";
    history.replaceState(null, "", url.href);
    meta("traceparent", traceparent);
    serverTiming(undefined, undefined, url.href);
    if (late) history.pushState(null, "", "#/checkout");
    await start();
    expect(trace.getSpanContext(context.active())?.traceId === traceId).toBe(!late);
  },
);

it("starts a fresh operation when the document is restored from the back/forward cache", async () => {
  meta("traceparent", traceparent);
  await start();
  expect(trace.getSpanContext(context.active())?.traceId).toBe(traceId);
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  expect(trace.getSpanContext(context.active())?.traceId).not.toBe(traceId);
});

it("does not reread server context when an instrumentation is re-enabled", () => {
  meta("traceparent", traceparent);
  const instrumentation = new PageViewInstrumentation();
  try {
    expect(instrumentation.getOperationContext()?.traceId).toBe(traceId);
    instrumentation.disable();
    instrumentation.enable();
    expect(instrumentation.getOperationContext()?.traceId).not.toBe(traceId);
  } finally {
    instrumentation.disable();
  }
});
