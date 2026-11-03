// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ROOT_CONTEXT,
  context,
  createContextKey,
  diag,
  propagation,
  trace,
  type Context,
  type TextMapPropagator,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../src/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

const TRACE_ID = "1234567890abcdef1234567890abcdef";
const PARENT_ID = "1234567890abcdef";
const incomingHeaders = {
  traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
  tracestate: "vendor=state",
  baggage: "tenant.id=contoso",
};
let pipeline: ReturnType<typeof createInMemoryPipeline>;
let handle: MicrosoftOpenTelemetryBrowser | undefined;

async function start(options: MicrosoftOpenTelemetryBrowserOptions = {}): Promise<void> {
  pipeline = createInMemoryPipeline();
  handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: false },
    ...options,
  });
}

afterEach(async () => {
  try {
    await handle?.shutdown();
  } finally {
    handle = undefined;
    trace.disable();
    logs.disable();
    propagation.disable();
    context.disable();
    diag.disable();
    vi.restoreAllMocks();
  }
});

describe.each(["default", "custom"] as const)("%s context manager", (manager) => {
  beforeEach(async () => {
    await start(
      manager === "custom" ? { traces: { contextManager: new StackContextManager() } } : {},
    );
  });

  it("correlates nested spans and logs, respects explicit context, and restores the parent", async () => {
    const tracer = trace.getTracer("context-test");
    const logger = logs.getLogger("context-test");

    tracer.startActiveSpan("parent", (parent) => {
      expect(trace.getSpan(context.active())).toBe(parent);
      logger.emit({ eventName: "parent" });
      tracer.startActiveSpan("child", (child) => {
        expect(trace.getSpan(context.active())).toBe(child);
        logger.emit({ eventName: "child" });
        logger.emit({
          eventName: "explicit-parent",
          context: trace.setSpan(ROOT_CONTEXT, parent),
        });
        logger.emit({ eventName: "explicit-root", context: ROOT_CONTEXT });
        child.end();
      });
      expect(trace.getSpan(context.active())).toBe(parent);
      logger.emit({ eventName: "restored-parent" });
      parent.end();
    });
    expect(context.active()).toBe(ROOT_CONTEXT);
    logger.emit({ eventName: "outside" });
    tracer.startSpan("unrelated").end();
    await handle?.forceFlush();

    const [child, parent, unrelated] = pipeline.spanExporter.getFinishedSpans();
    expect(child.name).toBe("child");
    expect(parent.name).toBe("parent");
    expect(child.parentSpanContext).toEqual(parent.spanContext());
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(parent.parentSpanContext).toBeUndefined();
    expect(unrelated.parentSpanContext).toBeUndefined();
    expect(unrelated.spanContext().traceId).not.toBe(parent.spanContext().traceId);
    expect(
      pipeline.logExporter.getFinishedLogRecords().map((record) => ({
        eventName: record.eventName,
        spanContext: record.spanContext,
      })),
    ).toEqual([
      { eventName: "parent", spanContext: parent.spanContext() },
      { eventName: "child", spanContext: child.spanContext() },
      { eventName: "explicit-parent", spanContext: parent.spanContext() },
      { eventName: "explicit-root", spanContext: undefined },
      { eventName: "restored-parent", spanContext: parent.spanContext() },
      { eventName: "outside", spanContext: undefined },
    ]);
  });

  it("preserves callback arguments, receiver and return values and restores context after throws", () => {
    const key = createContextKey("context-test");
    const outer = ROOT_CONTEXT.setValue(key, "outer");
    const inner = ROOT_CONTEXT.setValue(key, "inner");
    const receiver = { prefix: "result" };
    const failure = new Error("callback failed");
    const callback = function (this: typeof receiver, value: number): string {
      expect(this).toBe(receiver);
      expect(context.active()).toBe(outer);
      expect(() =>
        context.with(inner, () => {
          expect(context.active()).toBe(inner);
          throw failure;
        }),
      ).toThrow(failure);
      expect(context.active()).toBe(outer);
      return `${this.prefix}:${value}`;
    };

    expect(context.with(outer, callback, receiver, 42)).toBe("result:42");
    expect(context.active()).toBe(ROOT_CONTEXT);
    expect(context.bind(outer, callback).call(receiver, 7)).toBe("result:7");
    expect(context.active()).toBe(ROOT_CONTEXT);
    context.with(inner, () => {
      expect(context.bind(outer, callback).call(receiver, 9)).toBe("result:9");
      expect(context.active()).toBe(inner);
    });
    expect(() =>
      context.with(outer, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(context.active()).toBe(ROOT_CONTEXT);
    expect(() =>
      context.bind(outer, () => {
        throw failure;
      })(),
    ).toThrow(failure);
    expect(context.active()).toBe(ROOT_CONTEXT);
  });

  it.each([
    { name: "timer", schedule: (callback: () => void) => setTimeout(callback, 0) },
    { name: "promise", schedule: (callback: () => void) => Promise.resolve().then(callback) },
    {
      name: "event",
      schedule: (callback: () => void) => {
        const target = new EventTarget();
        target.addEventListener("test", callback, { once: true });
        queueMicrotask(() => target.dispatchEvent(new Event("test")));
      },
    },
  ])("isolates concurrently scheduled, explicitly bound $name callbacks", async ({ schedule }) => {
    const tracer = trace.getTracer("context-test");
    const parents = [tracer.startSpan("first-parent"), tracer.startSpan("second-parent")];
    const contexts = parents.map((parent) => trace.setSpan(ROOT_CONTEXT, parent));
    const pending = contexts.map(
      (parentContext, index) =>
        new Promise<Context>((resolve) => {
          const bound = context.with(parentContext, () =>
            context.bind(context.active(), () => {
              const child = tracer.startSpan(`child-${index}`);
              logs.getLogger("context-test").emit({ eventName: `callback-${index}` });
              child.end();
              resolve(context.active());
            }),
          );
          schedule(bound);
        }),
    );

    expect(context.active()).toBe(ROOT_CONTEXT);
    expect(await Promise.all(pending)).toEqual(contexts);
    expect(context.active()).toBe(ROOT_CONTEXT);
    parents.forEach((parent) => parent.end());
    await handle?.forceFlush();

    const spans = pipeline.spanExporter.getFinishedSpans();
    const records = pipeline.logExporter.getFinishedLogRecords();
    expect(spans).toHaveLength(4);
    expect(records).toHaveLength(2);
    parents.forEach((parent, index) => {
      const child = spans.find((span) => span.name === `child-${index}`);
      expect(child?.parentSpanContext).toEqual(parent.spanContext());
      expect(child?.spanContext().traceId).toBe(parent.spanContext().traceId);
      expect(
        records.find((record) => record.eventName === `callback-${index}`)?.spanContext,
      ).toEqual(parent.spanContext());
    });
  });

  it("does not keep a synchronous context active across an unbound promise continuation", async () => {
    const parent = trace.getTracer("context-test").startSpan("parent");
    const active = trace.setSpan(ROOT_CONTEXT, parent);
    const pending = context.with(active, () => {
      expect(context.active()).toBe(active);
      return Promise.resolve().then(() => context.active());
    });

    expect(context.active()).toBe(ROOT_CONTEXT);
    expect(await pending).toBe(ROOT_CONTEXT);
    parent.end();
  });
});

describe("propagation", () => {
  it("extracts W3C trace context, trace state and baggage into a remote parent", async () => {
    await start();
    const extracted = propagation.extract(ROOT_CONTEXT, incomingHeaders);
    expect(trace.getSpanContext(extracted)).toMatchObject({
      traceId: TRACE_ID,
      spanId: PARENT_ID,
      traceFlags: 1,
      isRemote: true,
    });
    expect(trace.getSpanContext(extracted)?.traceState?.serialize()).toBe("vendor=state");
    expect(propagation.getBaggage(extracted)?.getEntry("tenant.id")).toEqual({ value: "contoso" });

    const child = context.with(extracted, () => {
      const span = trace.getTracer("context-test").startSpan("remote-child");
      const headers: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), span), headers);
      expect(headers).toEqual({
        ...incomingHeaders,
        traceparent: `00-${TRACE_ID}-${span.spanContext().spanId}-01`,
      });
      span.end();
      return span;
    });
    await handle?.forceFlush();

    const [exported] = pipeline.spanExporter.getFinishedSpans();
    expect(exported.spanContext()).toEqual(child.spanContext());
    expect(exported.parentSpanContext).toEqual(trace.getSpanContext(extracted));
    expect(context.active()).toBe(ROOT_CONTEXT);
    expect(propagation.getBaggage(context.active())).toBeUndefined();
  });

  it("preserves an unsampled remote trace without exporting a sampled child", async () => {
    await start();
    const headers = { ...incomingHeaders, traceparent: `00-${TRACE_ID}-${PARENT_ID}-00` };
    const extracted = propagation.extract(ROOT_CONTEXT, headers);
    const injected: Record<string, string> = {};
    propagation.inject(extracted, injected);
    expect(injected).toEqual(headers);
    const child = trace.getTracer("context-test").startSpan("unsampled", {}, extracted);
    expect(child.isRecording()).toBe(false);
    expect(child.spanContext()).toMatchObject({ traceId: TRACE_ID, traceFlags: 0 });
    child.end();
    await handle?.forceFlush();
    expect(pipeline.spanExporter.getFinishedSpans()).toEqual([]);
  });

  it.each([
    "invalid",
    `00-${"0".repeat(32)}-${PARENT_ID}-01`,
    `00-${TRACE_ID}-${"0".repeat(16)}-01`,
    `ff-${TRACE_ID}-${PARENT_ID}-01`,
  ])(
    "rejects invalid traceparent %s without losing baggage or base context",
    async (traceparent) => {
      await start();
      const key = createContextKey("existing-value");
      const base = ROOT_CONTEXT.setValue(key, "preserved");
      const extracted = propagation.extract(base, { ...incomingHeaders, traceparent });

      expect(trace.getSpanContext(extracted)).toBeUndefined();
      expect(extracted.getValue(key)).toBe("preserved");
      expect(propagation.getBaggage(extracted)?.getEntry("tenant.id")?.value).toBe("contoso");
      expect(base.getValue(key)).toBe("preserved");
      expect(propagation.getBaggage(base)).toBeUndefined();
      const parent = {
        traceId: TRACE_ID,
        spanId: PARENT_ID,
        traceFlags: 1,
      };
      const withParent = propagation.extract(trace.setSpanContext(base, parent), {
        ...incomingHeaders,
        traceparent,
      });
      expect(trace.getSpanContext(withParent)).toEqual(parent);
      expect(withParent.getValue(key)).toBe("preserved");
    },
  );

  it("composes caller propagators in order without retaining omitted defaults", async () => {
    const key = createContextKey("custom-propagation");
    const custom: TextMapPropagator = {
      fields: () => ["x-test-context"],
      extract: (ctx, carrier, getter) => ctx.setValue(key, getter.get(carrier, "x-test-context")),
      inject: (ctx, carrier, setter) =>
        setter.set(carrier, "x-test-context", String(ctx.getValue(key))),
    };
    const second: TextMapPropagator = {
      fields: () => ["x-test-context"],
      extract: (ctx) => ctx.setValue(key, `${String(ctx.getValue(key))}:second`),
      inject: (ctx, carrier, setter) =>
        setter.set(carrier, "x-test-context", `${String(ctx.getValue(key))}:injected`),
    };
    await start({
      traces: { propagators: Object.freeze([custom, second, new W3CBaggagePropagator()]) },
    });
    const extracted = propagation.extract(ROOT_CONTEXT, {
      ...incomingHeaders,
      "x-test-context": "first",
    });
    const injected: Record<string, string> = {};
    propagation.inject(extracted, injected);

    expect(extracted.getValue(key)).toBe("first:second");
    expect(trace.getSpanContext(extracted)).toBeUndefined();
    expect(injected).toEqual({
      "x-test-context": "first:second:injected",
      baggage: "tenant.id=contoso",
    });
    expect(propagation.fields()).toEqual(["x-test-context", "baggage"]);
  });

  it("disables extraction and injection with an empty propagator list, but not active spans", async () => {
    await start({ traces: { propagators: [] } });
    expect(propagation.extract(ROOT_CONTEXT, incomingHeaders)).toBe(ROOT_CONTEXT);
    expect(propagation.fields()).toEqual([]);
    trace.getTracer("context-test").startActiveSpan("active", (span) => {
      expect(trace.getSpan(context.active())).toBe(span);
      const baggage = propagation.createBaggage({ tenant: { value: "contoso" } });
      const injected: Record<string, string> = {};
      propagation.inject(propagation.setBaggage(context.active(), baggage), injected);
      expect(injected).toEqual({});
      span.end();
    });
    await handle?.forceFlush();
    expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
  });
});

describe("context lifecycle", () => {
  it.each([false, true])(
    "does not replace existing context APIs when traces are disabled (session=%s)",
    async (enabled) => {
      const existingManager = new StackContextManager().enable();
      context.setGlobalContextManager(existingManager);
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      const customManager = new StackContextManager();
      const enable = vi.spyOn(customManager, "enable");
      const fields = vi.fn(() => ["x-unused"]);
      await start({
        spanProcessors: [],
        session: { enabled },
        traces: {
          contextManager: customManager,
          propagators: [{ fields, inject() {}, extract: (ctx) => ctx }],
        },
      });

      expect(enable).not.toHaveBeenCalled();
      expect(fields).not.toHaveBeenCalled();
      const key = createContextKey("existing-manager");
      const active = ROOT_CONTEXT.setValue(key, "existing");
      context.with(active, () => expect(existingManager.active()).toBe(active));
      expect(propagation.fields()).toEqual(["traceparent", "tracestate"]);
      const extracted = propagation.extract(ROOT_CONTEXT, incomingHeaders);
      expect(trace.getSpanContext(extracted)?.traceId).toBe(TRACE_ID);
      expect(trace.getTracer("context-test").startSpan("disabled").isRecording()).toBe(false);
      logs.getLogger("context-test").emit({ eventName: "logs-still-enabled", context: extracted });
      await handle?.forceFlush();
      expect(pipeline.logExporter.getFinishedLogRecords()[0]?.spanContext).toEqual(
        trace.getSpanContext(extracted),
      );
    },
  );

  it("disables owned context at final shutdown while retaining explicit propagation", async () => {
    const manager = new StackContextManager();
    const enable = vi.spyOn(manager, "enable");
    const disable = vi.spyOn(manager, "disable");
    const bind = vi.spyOn(manager, "bind");
    await start({ traces: { contextManager: manager } });
    expect(enable).toHaveBeenCalledOnce();

    const extracted = propagation.extract(ROOT_CONTEXT, incomingHeaders);
    const callback = context.bind(extracted, () => context.active());
    expect(bind).toHaveBeenCalledOnce();
    expect(callback()).toBe(extracted);
    await handle?.shutdown();
    await handle?.shutdown();

    expect(disable).toHaveBeenCalledOnce();
    expect(callback()).toBe(ROOT_CONTEXT);
    const injected: Record<string, string> = {};
    propagation.inject(extracted, injected);
    expect(injected).toEqual(incomingHeaders);
    expect(context.active()).toBe(ROOT_CONTEXT);
  });
});
