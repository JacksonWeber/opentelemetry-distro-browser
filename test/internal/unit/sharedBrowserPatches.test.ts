// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import { InstrumentationBase } from "@opentelemetry/instrumentation";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  claimInstrumentations,
  isNetworkInstrumentation,
} from "../../../src/instrumentation/sharedBrowserPatches.js";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import { PageViewInstrumentation } from "../../../src/instrumentation/pageView/index.js";
import type { BrowserInstrumentation, MicrosoftOpenTelemetryBrowser } from "../../../src/types.js";
import { createInMemoryPipeline, createSpanContext } from "../../fixtures/telemetry.js";

type Method = (value: string) => unknown;
type Target = { method: Method };

// Exposes the upstream wrapping contract for deterministic platform and subscriber failures.
class PatchProbe extends InstrumentationBase {
  public observe = vi.fn<(next: Method, value: string) => unknown>((next, value) => next(value));

  public constructor(public readonly target: Target) {
    super("@opentelemetry/browser-instrumentation/console", "0.8.1", { enabled: false });
  }

  protected init(): void {}

  public enable(): void {
    this._wrap(this.target, "method", (next) => (value) => this.observe(next, value));
  }

  public disable(): void {
    this._unwrap(this.target, "method");
  }
}

const releases = new Set<() => void>();
const handles: MicrosoftOpenTelemetryBrowser[] = [];
const url = new URL("/shared-patch-unit", location.origin).href;

beforeEach(() => {
  vi.spyOn(diag, "error").mockImplementation(() => {});
});

afterEach(async () => {
  try {
    const results = await Promise.allSettled([
      ...handles.splice(0).map((handle) => handle.shutdown()),
      ...[...releases].map((release) => Promise.resolve().then(release)),
    ]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  } finally {
    trace.disable();
    logs.disable();
    context.disable();
    propagation.disable();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

function claim(...instrumentations: BrowserInstrumentation[]): () => void {
  const release = claimInstrumentations(instrumentations);
  const stop = (): void => {
    releases.delete(stop);
    release();
  };
  releases.add(stop);
  return stop;
}

async function start(instrumentations: BrowserInstrumentation[], traces = true) {
  const pipeline = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    spanProcessors: traces ? pipeline.options.spanProcessors : [],
    instrumentations,
    pageView: { enabled: false },
  });
  handles.push(handle);
  if (!traces) await pipeline.spanProcessor.shutdown();
  return { ...pipeline, handle };
}

function stubXhr() {
  const open = vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => {});
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (
    this: XMLHttpRequest,
  ) {
    this.dispatchEvent(new Event("load"));
  });
  const header = vi
    .spyOn(XMLHttpRequest.prototype, "setRequestHeader")
    .mockImplementation(() => {});
  return { open, send, header };
}

it("shares a method, preserves its receiver and return value, and releases each owner separately", () => {
  const original = vi.fn(function (this: Target, value: string) {
    expect(this).toBe(target);
    return value.toUpperCase();
  });
  const target = { method: original };
  const descriptor = Object.getOwnPropertyDescriptor(target, "method");
  const first = new PatchProbe(target);
  const second = new PatchProbe(target);
  const stopFirst = claim(first);
  first.enable();
  const patched = target.method;
  const stopSecond = claim(second);
  second.enable();
  expect(target.method).toBe(patched);
  expect(target.method("request")).toBe("REQUEST");
  expect(original).toHaveBeenCalledExactlyOnceWith("request");
  expect(first.observe).toHaveBeenCalledOnce();
  expect(second.observe).toHaveBeenCalledOnce();
  stopFirst();
  target.method("remaining");
  expect(first.observe).toHaveBeenCalledOnce();
  expect(second.observe).toHaveBeenCalledTimes(2);
  stopSecond();
  expect(Object.getOwnPropertyDescriptor(target, "method")).toEqual(descriptor);
});

it("skips a subscriber removed during dispatch without skipping surviving subscribers", () => {
  const native = vi.fn();
  const target = { method: native };
  const first = new PatchProbe(target);
  const removed = new PatchProbe(target);
  const last = new PatchProbe(target);
  claim(first, removed, last);
  first.observe.mockImplementation((next, value) => {
    removed.disable();
    return next(value);
  });
  first.enable();
  removed.enable();
  last.enable();
  target.method("event");
  expect(removed.observe).not.toHaveBeenCalled();
  expect(last.observe).toHaveBeenCalledOnce();
  expect(native).toHaveBeenCalledExactlyOnceWith("event");
});

it("keeps nested calls independent and restores the outer subscriber continuation", () => {
  const original = vi.fn((value: string) => value);
  const target = { method: original };
  const first = new PatchProbe(target);
  const second = new PatchProbe(target);
  claim(first, second);
  first.observe.mockImplementation((next, value) => {
    if (value === "outer") expect(target.method("inner")).toBe("inner");
    return next(value);
  });
  first.enable();
  second.enable();
  expect(target.method("outer")).toBe("outer");
  expect(original.mock.calls).toEqual([["inner"], ["outer"]]);
  expect(second.observe.mock.calls.map(([, value]) => value)).toEqual(["inner", "outer"]);
});

it("reports subscriber exceptions once even when diagnostics re-enter the patched method", () => {
  const original = vi.fn();
  const target = { method: original };
  const broken = new PatchProbe(target);
  const survivor = new PatchProbe(target);
  claim(broken, survivor);
  const failure = new Error("observer failed");
  broken.observe.mockImplementation(() => {
    throw failure;
  });
  broken.enable();
  survivor.enable();
  vi.mocked(diag.error).mockImplementation(() => {
    target.method("diagnostic");
  });
  expect(() => target.method("application")).not.toThrow();
  expect(diag.error).toHaveBeenCalledExactlyOnceWith(
    "Browser instrumentation subscriber failed",
    failure,
  );
  expect(original.mock.calls).toEqual([["diagnostic"], ["application"]]);
  expect(survivor.observe).toHaveBeenCalledTimes(2);
});

it("reports rejected subscriber promises without changing the application's return value", async () => {
  const target = { method: vi.fn<Method>(() => "native result") };
  const instrumentation = new PatchProbe(target);
  const failure = new Error("async observer failed");
  instrumentation.observe.mockRejectedValue(failure);
  claim(instrumentation);
  instrumentation.enable();
  expect(target.method("event")).toBe("native result");
  await vi.waitFor(() =>
    expect(diag.error).toHaveBeenCalledWith("Browser instrumentation subscriber failed", failure),
  );
});

it("preserves a foreign wrapper and leaves captured inactive patches as pass-throughs", () => {
  const native = vi.fn((value: string) => value);
  const target = { method: native };
  const first = new PatchProbe(target);
  const stop = claim(first);
  first.enable();
  const captured = target.method;
  const foreign = vi.fn((value: string) => captured(value));
  target.method = foreign;
  stop();
  expect(target.method).toBe(foreign);
  expect(target.method("after shutdown")).toBe("after shutdown");
  expect(first.observe).not.toHaveBeenCalled();
  const second = new PatchProbe(target);
  const stopSecond = claim(second);
  second.enable();
  target.method("restart");
  expect(second.observe).toHaveBeenCalledOnce();
  expect(native.mock.calls).toEqual([["after shutdown"], ["restart"]]);
  stopSecond();
  expect(target.method).toBe(foreign);
});

it("removes the own property when the patched method was inherited", () => {
  const prototype = { method: vi.fn() };
  class InheritedTarget {
    public method(value: string): unknown {
      return prototype.method(value);
    }
  }
  const target = new InheritedTarget();
  const instrumentation = new PatchProbe(target);
  const stop = claim(instrumentation);
  instrumentation.enable();
  expect(Object.hasOwn(target, "method")).toBe(true);
  stop();
  expect(Object.hasOwn(target, "method")).toBe(false);
  target.method("inherited");
  expect(prototype.method).toHaveBeenCalledExactlyOnceWith("inherited");
});

it("can enable a claimed object again without stacking another subscriber", () => {
  const target = { method: vi.fn() };
  const instrumentation = new PatchProbe(target);
  const stop = claim(instrumentation);
  instrumentation.enable();
  const patched = target.method;
  instrumentation.enable();
  expect(target.method).toBe(patched);
  target.method("first");
  expect(instrumentation.observe).toHaveBeenCalledOnce();
  stop();
  claim(instrumentation);
  instrumentation.enable();
  target.method("second");
  expect(instrumentation.observe).toHaveBeenCalledTimes(2);
});

it("rejects re-claiming an adapted object with live subscriptions", () => {
  const target = { method: vi.fn() };
  const instrumentation = new PatchProbe(target);
  const stop = claim(instrumentation);
  instrumentation.enable();
  stop();
  instrumentation.enable();
  try {
    expect(() => claim(instrumentation)).toThrow("browser-instrumentation-active");
  } finally {
    instrumentation.disable();
  }
  expect(() => claim(instrumentation)).not.toThrow();
});

it("rejects re-registering active fetch before rebinding providers", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
  const instrumentation = new FetchInstrumentation({ enabled: false });
  const first = await start([instrumentation]);
  await first.handle.shutdown();
  instrumentation.enable();
  const bindTrace = vi.spyOn(instrumentation, "setTracerProvider");
  const bindLogs = vi.spyOn(instrumentation, "setLoggerProvider");
  try {
    await expect(start([instrumentation])).rejects.toThrow("browser-instrumentation-active");
    expect(bindTrace).not.toHaveBeenCalled();
    expect(bindLogs).not.toHaveBeenCalled();
  } finally {
    instrumentation.disable();
  }
  await start([instrumentation]);
});

it.each([
  ["navigation", false],
  ["navigation", true],
  ["page view", false],
  ["page view", true],
] as const)("rejects active %s Navigation API listeners (adapted=%s)", async (kind, adapted) => {
  const navigation = new EventTarget();
  vi.stubGlobal("navigation", navigation);
  const remove = vi.spyOn(navigation, "removeEventListener");
  const options = { enabled: false, useNavigationApiIfAvailable: true };
  const instrumentation =
    kind === "navigation"
      ? new NavigationInstrumentation(options)
      : new PageViewInstrumentation(options);
  if (adapted) {
    const first = await start([instrumentation]);
    await first.handle.shutdown();
  }
  instrumentation.enable();
  const bindTrace = vi.spyOn(instrumentation, "setTracerProvider");
  const bindLogs = vi.spyOn(instrumentation, "setLoggerProvider");
  try {
    await expect(start([instrumentation])).rejects.toThrow("browser-instrumentation-active");
    expect(bindTrace).not.toHaveBeenCalled();
    expect(bindLogs).not.toHaveBeenCalled();
  } finally {
    instrumentation.disable();
  }
  expect(remove).toHaveBeenCalledWith("currententrychange", expect.any(Function));
});

const consoleMethods = ["log", "warn", "error", "info", "debug"] as const;

it.each(consoleMethods)(
  "recovers every method after a partial console patch failure at %s",
  async (locked) => {
    const originals = consoleMethods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const descriptor = Object.getOwnPropertyDescriptor(console, locked)!;
    const instrumentation = new ConsoleInstrumentation({ enabled: false });
    Object.defineProperty(console, locked, { ...descriptor, writable: false });
    try {
      await expect(start([instrumentation])).rejects.toThrow("browser-patch-unavailable");
      consoleMethods.forEach((method, index) => expect(console[method]).toBe(originals[index]));
    } finally {
      Object.defineProperty(console, locked, descriptor);
    }
    const retry = await start([instrumentation]);
    for (const method of consoleMethods) console[method](`retried ${method}`);
    await retry.handle.forceFlush();
    expect(retry.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual(
      consoleMethods.map((method) => `retried ${method}`),
    );
    await retry.handle.shutdown();
    consoleMethods.forEach((method, index) => expect(console[method]).toBe(originals[index]));
  },
);

it.each(["missing method", "locked method", "ignored assignment"] as const)(
  "rejects a %s without leaving a subscription behind",
  (failure) => {
    const target = { method: vi.fn() };
    const native = target.method;
    if (failure === "missing method") Reflect.deleteProperty(target, "method");
    else if (failure === "locked method")
      Object.defineProperty(target, "method", { writable: false });
    else
      Object.defineProperty(target, "method", {
        get: () => native,
        set: () => {},
        configurable: true,
      });
    const instrumentation = new PatchProbe(target);
    claim(instrumentation);
    expect(() => instrumentation.enable()).toThrow("browser-patch-unavailable");
    expect(target.method).toBe(failure === "missing method" ? undefined : native);
  },
);

it("reports every cleanup failure and still removes later subscribers", () => {
  const firstTarget = { method: vi.fn() };
  const secondTarget = { method: vi.fn() };
  const first = new PatchProbe(firstTarget);
  const second = new PatchProbe(secondTarget);
  const stop = claim(first, second);
  first.enable();
  second.enable();
  for (const target of [firstTarget, secondTarget]) {
    Object.defineProperty(target, "method", { configurable: false, writable: false });
  }
  expect(stop).toThrow(
    expect.objectContaining({
      errors: [expect.any(AggregateError), expect.any(AggregateError)],
    }),
  );
  firstTarget.method("inactive");
  secondTarget.method("inactive");
  expect(first.observe).not.toHaveBeenCalled();
  expect(second.observe).not.toHaveBeenCalled();
  expect(diag.error).toHaveBeenCalledWith("[browser-patch-cleanup] Cannot restore method.");
});

it("preserves startup errors when restoring a partially installed patch also fails", () => {
  const native = vi.fn();
  const target = { method: native };
  const instrumentation = new PatchProbe(target);
  const enable = instrumentation.enable.bind(instrumentation);
  const failure = new Error("startup failed");
  vi.spyOn(instrumentation, "enable").mockImplementation(() => {
    enable();
    Object.defineProperty(target, "method", { configurable: false, writable: false });
    throw failure;
  });
  const stop = claim(instrumentation);
  expect(() => instrumentation.enable()).toThrow(failure);
  expect(diag.error).toHaveBeenCalledWith(
    "Browser patch rollback failed",
    expect.any(AggregateError),
  );
  expect(stop).not.toThrow();
  target.method("after rollback");
  expect(native).toHaveBeenCalledExactlyOnceWith("after rollback");
  expect(instrumentation.observe).not.toHaveBeenCalled();
});

it.each(["version", "wrap", "unwrap"] as const)("rejects an unsupported %s contract", (field) => {
  const instrumentation = new PatchProbe({ method: vi.fn() });
  Object.defineProperty(
    instrumentation,
    field === "version" ? "instrumentationVersion" : `_${field}`,
    {
      value: field === "version" ? "0.0.0" : undefined,
    },
  );
  expect(() => claim(instrumentation)).toThrow("browser-instrumentation-version");
});

it.each(["configured", "previously patched"] as const)("rejects %s instrumentation", (state) => {
  const instrumentation = new PatchProbe({ method: vi.fn() });
  if (state === "configured") instrumentation.setConfig({ enabled: true });
  else Object.defineProperty(instrumentation, "_isPatched", { value: true });
  expect(() => claim(instrumentation)).toThrow("browser-instrumentation-active");
});

it("rejects duplicate objects and live owners before rebinding them", () => {
  const target = { method: vi.fn() };
  const instrumentation = new PatchProbe(target);
  expect(() => claim(instrumentation, instrumentation)).toThrow("browser-instrumentation-owned");
  const stop = claim(instrumentation);
  instrumentation.enable();
  const patched = target.method;
  expect(() => claim(instrumentation)).toThrow("browser-instrumentation-owned");
  expect(target.method).toBe(patched);
  stop();
  expect(() => claim(instrumentation)).not.toThrow();
});

it("classifies only supported network instrumentations", () => {
  expect(isNetworkInstrumentation(new FetchInstrumentation({ enabled: false }))).toBe(true);
  expect(isNetworkInstrumentation(new XhrInstrumentation({ enabled: false }))).toBe(true);
  expect(isNetworkInstrumentation(new ConsoleInstrumentation({ enabled: false }))).toBe(false);
  const foreign = new PatchProbe({ method: vi.fn() });
  Object.defineProperty(foreign, "instrumentationName", { value: "foreign/fetch" });
  expect(isNetworkInstrumentation(foreign)).toBe(false);
});

it("fans out fetch responses before callers consume their bodies and keeps hooks isolated", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("body"));
  const firstHook = vi.fn();
  const secondHook = vi.fn();
  const first = await start([
    new FetchInstrumentation({
      enabled: false,
      applyCustomAttributesOnSpan: firstHook,
      sanitizeUrl: () => "first",
    }),
  ]);
  const second = await start([
    new FetchInstrumentation({
      enabled: false,
      applyCustomAttributesOnSpan: secondHook,
      sanitizeUrl: () => "second",
    }),
  ]);
  const parent = createSpanContext();
  const response = await context.with(trace.setSpanContext(ROOT_CONTEXT, parent), () => fetch(url));
  expect(await response.text()).toBe("body");
  await vi.waitFor(async () => {
    await Promise.all([first.handle.forceFlush(), second.handle.forceFlush()]);
    expect(first.spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(second.spanExporter.getFinishedSpans()).toHaveLength(1);
  });
  const [a] = first.spanExporter.getFinishedSpans();
  const [b] = second.spanExporter.getFinishedSpans();
  expect(a.parentSpanContext).toEqual(parent);
  expect(b.parentSpanContext).toEqual(parent);
  expect(a.attributes["url.full"]).toBe("first");
  expect(b.attributes["url.full"]).toBe("second");
  expect(firstHook).toHaveBeenCalledOnce();
  expect(secondHook).toHaveBeenCalledOnce();
  expect(transport).toHaveBeenCalledOnce();
  expect(new Headers(transport.mock.calls[0][1]?.headers).get("traceparent")?.split("-")[2]).toBe(
    b.spanContext().spanId,
  );
});

it.each([false, true])(
  "preserves native fetch errors without reporting them as subscriber failures (sync=%s)",
  async (synchronous) => {
    const failure = new TypeError("network unavailable");
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      if (synchronous) throw failure;
      return Promise.reject(failure);
    });
    const first = await start([new FetchInstrumentation({ enabled: false })]);
    const second = await start([new FetchInstrumentation({ enabled: false })]);
    if (synchronous) expect(() => fetch(url)).toThrow(failure);
    else await expect(fetch(url)).rejects.toBe(failure);
    await vi.waitFor(async () => {
      await Promise.all([first.handle.forceFlush(), second.handle.forceFlush()]);
      expect(first.spanExporter.getFinishedSpans()).toHaveLength(1);
      expect(second.spanExporter.getFinishedSpans()).toHaveLength(1);
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(diag.error).not.toHaveBeenCalledWith(
      "Browser instrumentation subscriber failed",
      failure,
    );
  },
);

it("keeps deferred network instrumentation inert when traces are disabled", async () => {
  const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
  await start([new FetchInstrumentation({ enabled: false })], false);
  expect(fetch).toBe(transport);
  await fetch(url);
  expect(transport).toHaveBeenCalledExactlyOnceWith(url);
});

it("deduplicates XHR propagation but preserves repeated application headers and resets on open", async () => {
  const { open, send, header } = stubXhr();
  const first = await start([new XhrInstrumentation({ enabled: false })]);
  const second = await start([new XhrInstrumentation({ enabled: false })]);
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url);
  xhr.setRequestHeader("TraceParent", "application");
  xhr.setRequestHeader("X-Custom", "one");
  xhr.setRequestHeader("X-Custom", "two");
  xhr.send();
  expect(header.mock.calls).toEqual([
    ["TraceParent", "application"],
    ["X-Custom", "one"],
    ["X-Custom", "two"],
  ]);
  xhr.open("GET", url);
  xhr.send();
  await Promise.all([first.handle.forceFlush(), second.handle.forceFlush()]);
  expect(open).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledTimes(2);
  expect(header.mock.calls).toHaveLength(4);
  const [a, next] = first.spanExporter.getFinishedSpans();
  const [b] = second.spanExporter.getFinishedSpans();
  expect(a.spanContext().spanId).not.toBe(b.spanContext().spanId);
  expect(header.mock.calls[3][1].split("-")[2]).toBe(next.spanContext().spanId);
  expect(second.spanExporter.getFinishedSpans()).toHaveLength(2);
});

it.each(["disable", "shutdown"] as const)(
  "skips XHRs crossing a header tracking gap during %s",
  async (operation) => {
    const { send, header } = stubXhr();
    const instrumentation = new XhrInstrumentation({ enabled: false });
    let pipeline = await start([instrumentation]);
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    if (operation === "disable") instrumentation.disable();
    else await pipeline.handle.shutdown();
    xhr.setRequestHeader("traceparent", "application");
    if (operation === "disable") instrumentation.enable();
    else pipeline = await start([instrumentation]);
    xhr.setRequestHeader("X-Custom", "after restart");
    xhr.send();
    await pipeline.handle.forceFlush();
    expect(header.mock.calls).toEqual([
      ["traceparent", "application"],
      ["X-Custom", "after restart"],
    ]);
    expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(0);
    xhr.open("GET", url);
    xhr.send();
    await pipeline.handle.forceFlush();
    const spans = pipeline.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(header.mock.calls[2][1].split("-")[2]).toBe(spans[0].spanContext().spanId);
    expect(send).toHaveBeenCalledTimes(2);
  },
);

it("preserves in-flight XHR completion and listener cleanup across disable", async () => {
  const { send } = stubXhr();
  send.mockImplementation(() => {});
  const instrumentation = new XhrInstrumentation({ enabled: false });
  const pipeline = await start([instrumentation]);
  const xhr = new XMLHttpRequest();
  const remove = vi.spyOn(xhr, "removeEventListener");
  xhr.open("GET", url);
  xhr.send();
  instrumentation.disable();
  instrumentation.enable();
  xhr.dispatchEvent(new Event("load"));
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
  for (const event of ["abort", "error", "timeout", "load"]) {
    expect(remove).toHaveBeenCalledWith(event, expect.any(Function));
  }
});

it("keeps XHR header tracking while another subscriber remains enabled", async () => {
  const { header } = stubXhr();
  const instrumentation = new XhrInstrumentation({ enabled: false });
  const first = await start([instrumentation]);
  const second = await start([new XhrInstrumentation({ enabled: false })]);
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url);
  instrumentation.disable();
  xhr.setRequestHeader("traceparent", "application");
  instrumentation.enable();
  xhr.send();
  await Promise.all([first.handle.forceFlush(), second.handle.forceFlush()]);
  expect(header.mock.calls).toEqual([["traceparent", "application"]]);
  expect(first.spanExporter.getFinishedSpans()).toHaveLength(1);
  expect(second.spanExporter.getFinishedSpans()).toHaveLength(1);
});
