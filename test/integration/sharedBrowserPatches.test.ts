// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { ErrorsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/errors";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { UserActionInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/user-action";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { afterEach, expect, inject, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../src/index.js";
import type {
  BrowserInstrumentation,
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../src/types.js";
import { createInMemoryPipeline, createSpanContext } from "../fixtures/telemetry.js";
import { loadBrowserScript } from "../fixtures/browserBundle.js";

const handles: MicrosoftOpenTelemetryBrowser[] = [];
const scripts: HTMLScriptElement[] = [];
const originalUrl = location.href;
const endpoint = new URL("/headers", inject("redirectEndpoint")).href;

afterEach(async () => {
  try {
    for (const handle of handles.splice(0)) await handle.shutdown();
  } finally {
    trace.disable();
    logs.disable();
    context.disable();
    propagation.disable();
    diag.disable();
    vi.restoreAllMocks();
    history.replaceState(null, "", originalUrl);
    for (const script of scripts.splice(0)) script.remove();
    delete window.Microsoft;
  }
});

async function start(
  name: string,
  instrumentations: BrowserInstrumentation[],
  options: Partial<MicrosoftOpenTelemetryBrowserOptions> = {},
  initialize = useMicrosoftOpenTelemetry,
) {
  const pipeline = createInMemoryPipeline();
  const handle = await initialize({
    ...pipeline.options,
    resource: resourceFromAttributes({ "service.name": name }),
    pageView: { enabled: false },
    instrumentations,
    ...options,
  });
  handles.push(handle);
  return { ...pipeline, handle };
}

function network(kind: "fetch" | "xhr", config = {}) {
  const options = { enabled: false, propagateTraceHeaderCorsUrls: [endpoint], ...config };
  return kind === "fetch" ? new FetchInstrumentation(options) : new XhrInstrumentation(options);
}

async function request(kind: "fetch" | "xhr", headers?: Record<string, string>) {
  if (kind === "fetch")
    return (await fetch(endpoint, { headers })).json() as Promise<{ traceparent?: string }>;
  return new Promise<{ traceparent?: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", endpoint);
    for (const [key, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(key, value);
    xhr.onload = () => resolve(JSON.parse(xhr.responseText) as { traceparent?: string });
    xhr.onerror = () => reject(new Error("XHR failed"));
    xhr.send();
  });
}

function sendOpenedXhr(xhr: XMLHttpRequest) {
  return new Promise<{ traceparent?: string }>((resolve, reject) => {
    xhr.onload = () => resolve(JSON.parse(xhr.responseText) as { traceparent?: string });
    xhr.onerror = () => reject(new Error("XHR failed"));
    xhr.send();
  });
}

async function spans(pipeline: Awaited<ReturnType<typeof start>>, count: number) {
  await vi.waitFor(async () => {
    await pipeline.handle.forceFlush();
    expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(count);
  });
  return pipeline.spanExporter.getFinishedSpans();
}

it.each(["fetch", "xhr"] as const)(
  "shares one %s patch, isolates sibling spans and matches Application Insights header ownership",
  async (kind) => {
    const original = kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send;
    const first = await start("first", [
      network(kind, {
        sanitizeUrl: () => "https://first.test/",
        applyCustomAttributesOnSpan: (span: { setAttribute(key: string, value: string): void }) =>
          span.setAttribute("subscriber", "first"),
      }),
    ]);
    const patched = kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send;
    expect(patched).not.toBe(original);
    const second = await start("second", [
      network(kind, {
        sanitizeUrl: () => "https://second.test/",
        applyCustomAttributesOnSpan: (span: { setAttribute(key: string, value: string): void }) =>
          span.setAttribute("subscriber", "second"),
      }),
    ]);
    expect(kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send).toBe(patched);
    const parent = createSpanContext();
    const response = await context.with(trace.setSpanContext(ROOT_CONTEXT, parent), () =>
      request(kind),
    );
    const [a] = await spans(first, 1);
    const [b] = await spans(second, 1);
    expect(a.parentSpanContext).toEqual(parent);
    expect(b.parentSpanContext).toEqual(parent);
    expect(a.spanContext().spanId).not.toBe(b.spanContext().spanId);
    expect(a.attributes).toMatchObject({ "url.full": "https://first.test/", subscriber: "first" });
    expect(b.attributes).toMatchObject({
      "url.full": "https://second.test/",
      subscriber: "second",
    });
    expect(a.resource.attributes["service.name"]).toBe("first");
    expect(b.resource.attributes["service.name"]).toBe("second");
    const owner = kind === "fetch" ? b : a;
    expect(response.traceparent).toBe(`00-${parent.traceId}-${owner.spanContext().spanId}-01`);

    await first.handle.shutdown();
    expect(kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send).toBe(patched);
    await request(kind);
    await spans(second, 2);
    await second.handle.shutdown();
    expect(kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send).toBe(original);
  },
);

it.each(["fetch", "xhr"] as const)(
  "keeps %s filtering and propagation opt-outs independent",
  async (kind) => {
    const first = await start("first", [network(kind)]);
    const second = await start("second", [network(kind, { ignoreUrls: [endpoint] })]);
    const third = await start("third", [network(kind, { propagateTraceHeaderCorsUrls: [] })]);
    const response = await request(kind);
    const [owner] = await spans(first, 1);
    await spans(second, 0);
    await spans(third, 1);
    expect(response.traceparent?.split("-")[2]).toBe(owner.spanContext().spanId);
  },
);

it.each(["fetch", "xhr"] as const)("preserves %s application header behavior", async (kind) => {
  await start("first", [network(kind)]);
  const header = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01";
  const response = await request(kind, { traceparent: header });
  if (kind === "xhr") expect(response.traceparent).toBe(header);
  else expect(response.traceparent).not.toBe(header);
});

it("preserves XHR headers written while collection is disabled", async () => {
  const instrumentation = network("xhr");
  const pipeline = await start("xhr", [instrumentation]);
  const xhr = new XMLHttpRequest();
  xhr.open("GET", endpoint);
  instrumentation.disable();
  const traceparent = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01";
  xhr.setRequestHeader("traceparent", traceparent);
  instrumentation.enable();
  const response = await new Promise<{ traceparent?: string }>((resolve, reject) => {
    xhr.onload = () => resolve(JSON.parse(xhr.responseText) as { traceparent?: string });
    xhr.onerror = () => reject(new Error("XHR failed"));
    xhr.send();
  });
  expect(response.traceparent).toBe(traceparent);
  await spans(pipeline, 0);
  await request("xhr");
  await spans(pipeline, 1);
});

it("calls native fetch once and isolates request hooks without nesting their contexts", async () => {
  const native = vi.spyOn(globalThis, "fetch");
  const first = await start("first", [
    network("fetch", {
      requestHook: (
        span: { setAttribute(key: string, value: string): void },
        options: RequestInit,
      ) => {
        span.setAttribute("hook", "first");
        options.headers = {
          ...Object.fromEntries(new Headers(options.headers)),
          "x-test-context": "hook",
        };
      },
    }),
  ]);
  const second = await start("second", [network("fetch")]);
  await request("fetch");
  expect(native.mock.calls.filter(([url]) => String(url) === endpoint)).toHaveLength(1);
  expect((await spans(first, 1))[0].attributes.hook).toBe("first");
  expect((await spans(second, 1))[0].attributes.hook).toBeUndefined();
});

it.each(["fetch", "xhr"] as const)("supports explicit %s disable and re-enable", async (kind) => {
  const instrumentation = network(kind);
  const first = await start("first", [instrumentation]);
  const second = await start("second", [network(kind)]);
  instrumentation.disable();
  await request(kind);
  await spans(first, 0);
  await spans(second, 1);
  instrumentation.enable();
  await request(kind);
  await spans(first, 1);
  await spans(second, 2);
});

it.each([
  ["fetch", "disableFetchTracking"],
  ["xhr", "disableAjaxTracking"],
] as const)("keeps the %s gate and manual pause local to an instance", async (kind, gate) => {
  const instrumentation = network(kind);
  const bindProvider = vi.spyOn(instrumentation, "setTracerProvider");
  const first = await start("first", [instrumentation]);
  const second = await start("second", [network(kind)]);
  expect(first.handle.instrumentations.get(kind)).toBe(instrumentation);

  await request(kind);
  await spans(first, 1);
  await spans(second, 1);

  await first.handle.updateCfg({ [gate]: true });
  await request(kind);
  await spans(first, 1);
  await spans(second, 2);

  await first.handle.instrumentations.setEnabled(kind, false);
  await first.handle.instrumentations.setEnabled(kind, true);
  await request(kind);
  await spans(first, 1);
  await spans(second, 3);

  await first.handle.instrumentations.setEnabled(kind, false);
  await first.handle.updateCfg({ [gate]: undefined });
  await request(kind);
  await spans(first, 1);
  await spans(second, 4);

  await first.handle.instrumentations.setEnabled(kind, true);
  await request(kind);
  const firstSpans = await spans(first, 2);
  await spans(second, 5);
  expect(bindProvider).toHaveBeenCalledOnce();
  expect(firstSpans.every((span) => span.resource.attributes["service.name"] === "first")).toBe(
    true,
  );
});

it.each([
  ["fetch", "disableFetchTracking"],
  ["xhr", "disableAjaxTracking"],
] as const)("applies the %s gate to every registered object independently", async (kind, gate) => {
  const firstInstrumentation = network(kind);
  const secondInstrumentation = network(kind);
  const pipeline = await start("multiple", [firstInstrumentation, secondInstrumentation]);
  expect(pipeline.handle.instrumentations.get(kind)).toBe(firstInstrumentation);
  expect(pipeline.handle.instrumentations.get(`${kind}#2`)).toBe(secondInstrumentation);

  await request(kind);
  await spans(pipeline, 2);
  await pipeline.handle.instrumentations.setEnabled(`${kind}#2`, false);
  await pipeline.handle.updateCfg({ [gate]: true });
  await request(kind);
  await spans(pipeline, 2);
  await pipeline.handle.updateCfg({ [gate]: false });
  await request(kind);
  await spans(pipeline, 3);
  await pipeline.handle.instrumentations.setEnabled(`${kind}#2`, true);
  await request(kind);
  await spans(pipeline, 5);
});

it.each([
  ["fetch", "disableFetchTracking"],
  ["xhr", "disableAjaxTracking"],
] as const)("serializes concurrent %s gate and manual controls", async (kind, gate) => {
  const pipeline = await start("queued", [network(kind)]);
  await Promise.all([
    pipeline.handle.updateCfg({ [gate]: true }),
    pipeline.handle.instrumentations.setEnabled(kind, false),
    pipeline.handle.updateCfg({ [gate]: false }),
  ]);
  await request(kind);
  await spans(pipeline, 0);
  await pipeline.handle.instrumentations.setEnabled(kind, true);
  await request(kind);
  await spans(pipeline, 1);
});

it.each([
  ["fetch", "disableFetchTracking"],
  ["xhr", "disableAjaxTracking"],
] as const)("never enables %s without a trace pipeline", async (kind, gate) => {
  const instrumentation = network(kind);
  const enable = vi.spyOn(instrumentation, "enable");
  const logsOnly = await start("logs-only", [instrumentation], { spanProcessors: [] });
  const tracing = await start("tracing", [network(kind)]);
  await logsOnly.handle.instrumentations.setEnabled(kind, false);
  await logsOnly.handle.instrumentations.setEnabled(kind, true);
  await logsOnly.handle.updateCfg({ [gate]: true });
  await logsOnly.handle.updateCfg({ [gate]: false });
  const response = await request(kind);
  const [owner] = await spans(tracing, 1);
  expect(enable).not.toHaveBeenCalled();
  expect(response.traceparent?.split("-")[2]).toBe(owner.spanContext().spanId);
});

it.each([
  ["fetch", "disableFetchTracking"],
  ["xhr", "disableAjaxTracking"],
] as const)("finishes an in-flight %s once after its gate closes", async (kind, gate) => {
  const native =
    kind === "fetch" ? vi.spyOn(globalThis, "fetch") : vi.spyOn(XMLHttpRequest.prototype, "send");
  const first = await start("first", [network(kind)]);
  const second = await start("second", [network(kind)]);
  let completed = false;
  const pending = request(kind).then((response) => {
    completed = true;
    return response;
  });
  await first.handle.updateCfg({ [gate]: true });
  expect(completed).toBe(false);
  await pending;
  await spans(first, 1);
  await spans(second, 1);
  expect(native).toHaveBeenCalledOnce();

  await request(kind);
  await spans(first, 1);
  await spans(second, 2);
  expect(native).toHaveBeenCalledTimes(2);
});

it("does not collect an XHR opened before a subscriber's pause, even after it resumes", async () => {
  const first = await start("first", [network("xhr")]);
  const second = await start("second", [network("xhr")]);
  const xhr = new XMLHttpRequest();
  xhr.open("GET", endpoint);
  await first.handle.instrumentations.setEnabled("xhr", false);
  await first.handle.instrumentations.setEnabled("xhr", true);
  const response = await sendOpenedXhr(xhr);
  await spans(first, 0);
  const [other] = await spans(second, 1);
  expect(response.traceparent?.split("-")[2]).toBe(other.spanContext().spanId);
  await request("xhr");
  await spans(first, 1);
  await spans(second, 2);
});

it.each([false, true])(
  "does not reuse a stale XHR record for an ignored URL (pause=%s)",
  async (pause) => {
    const ignored = `${endpoint}#ignored`;
    const first = await start("first", [network("xhr", { ignoreUrls: [ignored] })]);
    const second = await start("second", [network("xhr")]);
    const xhr = new XMLHttpRequest();
    xhr.open("GET", endpoint);
    if (pause) {
      await first.handle.instrumentations.setEnabled("xhr", false);
      await first.handle.instrumentations.setEnabled("xhr", true);
    }
    xhr.open("GET", ignored);
    await sendOpenedXhr(xhr);
    await spans(first, 0);
    const [other] = await spans(second, 1);
    expect(other.attributes["url.full"]).toBe(ignored);
  },
);

it("preserves an earlier XHR open when a later ignored open fails native validation", async () => {
  const ignored = `${endpoint}#ignored`;
  const pipeline = await start("xhr", [network("xhr", { ignoreUrls: [ignored] })]);
  const xhr = new XMLHttpRequest();
  xhr.open("GET", endpoint);
  expect(() => xhr.open("invalid method", ignored)).toThrow();
  await sendOpenedXhr(xhr);
  const [span] = await spans(pipeline, 1);
  expect(span.attributes["url.full"]).toBe(endpoint);
});

it.each(["console", "errors", "user-action"] as const)(
  "pauses and resumes real %s collection without affecting another instance",
  async (kind) => {
    const makeInstrumentation = () => {
      switch (kind) {
        case "console":
          return new ConsoleInstrumentation({ enabled: false, logMethods: ["info"] });
        case "errors":
          return new ErrorsInstrumentation({ enabled: false });
        case "user-action":
          return new UserActionInstrumentation({ enabled: false });
      }
    };
    const instrumentation = makeInstrumentation();
    const first = await start("first", [instrumentation]);
    const second = await start("second", [makeInstrumentation()]);
    expect(first.handle.instrumentations.get(kind)).toBe(instrumentation);
    const button = document.createElement("button");
    document.body.append(button);
    const emit = () => {
      if (kind === "console") console.info("pause-resume event");
      else if (kind === "errors")
        window.dispatchEvent(new ErrorEvent("error", { message: "pause-resume event" }));
      else button.click();
    };
    const check = async (firstCount: number, secondCount: number) => {
      await first.handle.forceFlush();
      await second.handle.forceFlush();
      expect(first.logExporter.getFinishedLogRecords()).toHaveLength(firstCount);
      expect(second.logExporter.getFinishedLogRecords()).toHaveLength(secondCount);
    };
    try {
      emit();
      await check(1, 1);
      await first.handle.instrumentations.setEnabled(kind, false);
      emit();
      await check(1, 2);
      await first.handle.instrumentations.setEnabled(kind, true);
      emit();
      await check(2, 3);
      expect(
        first.logExporter
          .getFinishedLogRecords()
          .every((record) => record.resource.attributes["service.name"] === "first"),
      ).toBe(true);
    } finally {
      button.remove();
    }
  },
);

it("rejects runtime control of navigation, page views, custom and unknown instrumentations", async () => {
  const navigation = new NavigationInstrumentation({ enabled: false });
  const custom = {
    instrumentationName: "custom-instrumentation",
    setTracerProvider() {},
    getConfig: () => ({ enabled: false }),
    enable: vi.fn(),
    disable: vi.fn(),
  };
  const pipeline = await start("unsupported", [navigation, custom], { pageView: {} });
  expect(pipeline.handle.instrumentations.get("navigation")).toBe(navigation);
  expect(pipeline.handle.instrumentations.get("custom-instrumentation")).toBe(custom);
  expect(
    pipeline.handle.instrumentations.get("@microsoft/opentelemetry-browser/page-view"),
  ).toBeDefined();
  for (const id of [
    "navigation",
    "custom-instrumentation",
    "@microsoft/opentelemetry-browser/page-view",
  ]) {
    await expect(pipeline.handle.instrumentations.setEnabled(id, false)).rejects.toThrow(
      "unsupported",
    );
  }
  await expect(pipeline.handle.instrumentations.setEnabled("missing", false)).rejects.toThrow(
    "Unknown instrumentation",
  );
  expect(custom.disable).not.toHaveBeenCalled();
});

it("fans out console calls once with independent method filters and serializers", async () => {
  const original = console.info;
  const first = await start("first", [
    new ConsoleInstrumentation({
      enabled: false,
      logMethods: ["info"],
      messageSerializer: () => "first",
    }),
  ]);
  const patched = console.info;
  const second = await start("second", [
    new ConsoleInstrumentation({
      enabled: false,
      logMethods: ["info", "debug"],
      messageSerializer: () => "second",
    }),
  ]);
  expect(console.info).toBe(patched);
  console.info("shared console event");
  console.debug("second only");
  await first.handle.forceFlush();
  await second.handle.forceFlush();
  expect(first.logExporter.getFinishedLogRecords().map((log) => log.body)).toEqual(["first"]);
  expect(second.logExporter.getFinishedLogRecords().map((log) => log.body)).toEqual([
    "second",
    "second",
  ]);
  await first.handle.shutdown();
  console.info("surviving subscriber");
  await second.handle.forceFlush();
  expect(second.logExporter.getFinishedLogRecords()).toHaveLength(3);
  await second.handle.shutdown();
  expect(console.info).toBe(original);
});

it("does not let a failing console subscriber break the application or other subscribers", async () => {
  const first = await start("first", [
    new ConsoleInstrumentation({
      enabled: false,
      logMethods: ["info"],
      messageSerializer: () => {
        throw new Error("serializer");
      },
    }),
  ]);
  const second = await start("second", [
    new ConsoleInstrumentation({ enabled: false, logMethods: ["info"] }),
  ]);
  const error = vi.spyOn(diag, "error").mockImplementation(() => {});
  expect(() => console.info("still delivered")).not.toThrow();
  await first.handle.forceFlush();
  await second.handle.forceFlush();
  expect(first.logExporter.getFinishedLogRecords()).toHaveLength(0);
  expect(second.logExporter.getFinishedLogRecords().map((log) => log.body)).toEqual([
    "still delivered",
  ]);
  expect(error).toHaveBeenCalledWith(
    "Browser instrumentation subscriber failed",
    expect.any(Error),
  );
});

it("shares History between page views and upstream navigation with per-instance sanitization", async () => {
  const original = history.pushState;
  const first = await start(
    "first",
    [
      new NavigationInstrumentation({
        enabled: false,
        sanitizeUrl: () => "https://first.test/",
      }),
    ],
    { pageView: { softNavigationSettleTimeoutMs: 1 } },
  );
  const patched = history.pushState;
  const second = await start(
    "second",
    [
      new NavigationInstrumentation({
        enabled: false,
        sanitizeUrl: () => "https://second.test/",
      }),
    ],
    { pageView: { softNavigationSettleTimeoutMs: 1 } },
  );
  expect(history.pushState).toBe(patched);
  await vi.waitFor(async () => {
    await first.handle.forceFlush();
    await second.handle.forceFlush();
    expect(first.logExporter.getFinishedLogRecords()).toHaveLength(2);
    expect(second.logExporter.getFinishedLogRecords()).toHaveLength(2);
  });
  history.pushState(null, "", `${originalUrl}#shared-patches`);
  await vi.waitFor(async () => {
    await first.handle.forceFlush();
    await second.handle.forceFlush();
    expect(first.logExporter.getFinishedLogRecords()).toHaveLength(4);
    expect(second.logExporter.getFinishedLogRecords()).toHaveLength(4);
  });
  for (const [pipeline, url] of [
    [first, "https://first.test/"],
    [second, "https://second.test/"],
  ] as const) {
    const navigation = pipeline.logExporter
      .getFinishedLogRecords()
      .filter((log) => log.eventName === "browser.navigation");
    expect(navigation).toHaveLength(2);
    expect(navigation.every((log) => log.attributes["url.full"] === url)).toBe(true);
  }
  await first.handle.shutdown();
  expect(history.pushState).toBe(patched);
  await second.handle.shutdown();
  expect(history.pushState).toBe(original);
});

it("rolls back a failed subscriber without disturbing an existing patch owner", async () => {
  const first = await start("first", [network("fetch")]);
  const patched = fetch;
  await expect(
    start("failed", [
      network("fetch"),
      {
        setTracerProvider() {},
        getConfig: () => ({ enabled: false }),
        enable() {
          throw new Error("startup failed");
        },
        disable() {},
      },
    ]),
  ).rejects.toThrow("startup failed");
  expect(fetch).toBe(patched);
  await request("fetch");
  await spans(first, 1);
});

it("rejects reuse of a live instrumentation without disabling or rebinding its owner", async () => {
  const instrumentation = network("fetch");
  const first = await start("first", [instrumentation]);
  await expect(start("second", [instrumentation])).rejects.toThrow("browser-instrumentation-owned");
  await request("fetch");
  await spans(first, 1);
});

it("preserves an outer application wrapper and can restart under it without duplicate collection", async () => {
  const original = fetch;
  const first = await start("first", [network("fetch")]);
  const patched = fetch;
  const outer: typeof fetch = (...args) => patched(...args);
  globalThis.fetch = outer;
  try {
    await first.handle.shutdown();
    expect(fetch).toBe(outer);
    const second = await start("second", [network("fetch")]);
    await request("fetch");
    await spans(second, 1);
    await second.handle.shutdown();
    expect(fetch).toBe(outer);
  } finally {
    globalThis.fetch = original;
  }
});

it.each([false, true])(
  "shares patch ownership across distribution copies (bundle first=%s)",
  async (bundleFirst) => {
    const original = fetch;
    scripts.push(await loadBrowserScript("opentelemetry-browser.iife.min.js"));
    const initialize = window.Microsoft?.OpenTelemetry?.useMicrosoftOpenTelemetry;
    expect(initialize).toBeTypeOf("function");
    const first = await start(
      "first",
      [network("fetch")],
      {},
      bundleFirst ? initialize : useMicrosoftOpenTelemetry,
    );
    const patched = fetch;
    const second = await start(
      "second",
      [network("fetch")],
      {},
      bundleFirst ? useMicrosoftOpenTelemetry : initialize,
    );
    expect(fetch).toBe(patched);
    await request("fetch");
    await spans(first, 1);
    await spans(second, 1);
    await second.handle.shutdown();
    await first.handle.shutdown();
    expect(fetch).toBe(original);
  },
);

it.each(["fetch", "xhr"] as const)(
  "does not let a logs-only %s subscriber claim propagation",
  async (kind) => {
    await start("logs-only", [network(kind)], { spanProcessors: [] });
    const tracing = await start("tracing", [network(kind)]);
    const parent = createSpanContext();
    const response = await context.with(trace.setSpanContext(ROOT_CONTEXT, parent), () =>
      request(kind),
    );
    const [owner] = await spans(tracing, 1);
    expect(response.traceparent?.split("-")[2]).toBe(owner.spanContext().spanId);
  },
);

it("observes XHR sent from the synchronous OPENED event", async () => {
  const first = await start("first", [network("xhr")]);
  const second = await start("second", [network("xhr")]);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onreadystatechange = () => {
      if (xhr.readyState === XMLHttpRequest.OPENED) xhr.send();
    };
    xhr.onload = () => resolve();
    xhr.onerror = () => reject(new Error("XHR failed"));
    xhr.open("GET", endpoint);
  });
  await spans(first, 1);
  await spans(second, 1);
});

it.each([false, true])("preserves native fetch failures (synchronous=%s)", async (synchronous) => {
  const failure = new TypeError("network failed");
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    if (synchronous) throw failure;
    return Promise.reject(failure);
  });
  const first = await start("first", [network("fetch")]);
  const second = await start("second", [network("fetch")]);
  const active = context.active();
  if (synchronous) expect(() => fetch(endpoint)).toThrow(failure);
  else await expect(fetch(endpoint)).rejects.toBe(failure);
  expect(context.active()).toBe(active);
  expect(native).toHaveBeenCalledOnce();
  expect((await spans(first, 1))[0].status.code).toBe(2);
  expect((await spans(second, 1))[0].status.code).toBe(2);
});

it("does not attach new subscribers to in-flight requests or export into stopped pipelines", async () => {
  let resolve!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = await start("first", [network("fetch")]);
  const firstEnd = vi.spyOn(first.spanProcessor, "onEnd");
  const second = await start("second", [network("fetch")]);
  const pending = fetch(endpoint);
  const third = await start("third", [network("fetch")]);
  await first.handle.shutdown();
  resolve(new Response(null, { status: 204 }));
  expect((await pending).status).toBe(204);
  await spans(second, 1);
  await spans(third, 0);
  expect(firstEnd).not.toHaveBeenCalled();
});

it("rolls back partial XHR patching and permits retry after a method is unlocked", async () => {
  const prototype = XMLHttpRequest.prototype;
  const originalOpen = prototype.open;
  const originalHeader = prototype.setRequestHeader;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "send")!;
  Object.defineProperty(prototype, "send", { ...descriptor, writable: false });
  const instrumentation = network("xhr");
  try {
    await expect(start("failed", [instrumentation])).rejects.toThrow("browser-patch-unavailable");
    expect(prototype.open).toBe(originalOpen);
    expect(prototype.setRequestHeader).toBe(originalHeader);
  } finally {
    Object.defineProperty(prototype, "send", descriptor);
  }
  const restarted = await start("retry", [instrumentation]);
  await request("xhr");
  await spans(restarted, 1);
});

it("rejects duplicate objects and unsupported upstream versions before patching", async () => {
  const original = fetch;
  const instrumentation = network("fetch");
  await expect(start("duplicate", [instrumentation, instrumentation])).rejects.toThrow(
    "browser-instrumentation-owned",
  );
  Object.defineProperty(instrumentation, "instrumentationVersion", { value: "unsupported" });
  await expect(start("version", [instrumentation])).rejects.toThrow(
    "browser-instrumentation-version",
  );
  expect(fetch).toBe(original);
});

it("preserves startup errors when a shared instrumentation also fails cleanup", async () => {
  const original = fetch;
  const instrumentation = network("fetch");
  const enable = instrumentation.enable.bind(instrumentation);
  const disable = instrumentation.disable.bind(instrumentation);
  const failure = new Error("enable failed");
  instrumentation.enable = () => {
    enable();
    throw failure;
  };
  instrumentation.disable = () => {
    disable();
    throw new Error("disable failed");
  };
  const diagnostic = vi.spyOn(diag, "error").mockImplementation(() => {});
  await expect(start("failed", [instrumentation])).rejects.toBe(failure);
  expect(fetch).toBe(original);
  expect(diagnostic).toHaveBeenCalledWith("Browser patch rollback failed", expect.any(Error));
});

it("rejects previously enabled shared instrumentations even when their config says disabled", async () => {
  const original = fetch;
  const instrumentation = network("fetch");
  instrumentation.enable();
  instrumentation.disable();
  try {
    await expect(start("already patched", [instrumentation])).rejects.toThrow(
      "browser-instrumentation-active",
    );
  } finally {
    globalThis.fetch = original;
  }
});

it("keeps live console configuration updates local to their subscriber", async () => {
  const instrumentation = new ConsoleInstrumentation({ enabled: false, logMethods: ["info"] });
  const first = await start("first", [instrumentation]);
  const second = await start("second", [
    new ConsoleInstrumentation({ enabled: false, logMethods: ["info"] }),
  ]);
  const patched = console.info;
  instrumentation.setConfig({
    enabled: false,
    logMethods: ["debug"],
    messageSerializer: () => "updated",
  });
  expect(console.info).toBe(patched);
  console.info("second");
  console.debug("first");
  await first.handle.forceFlush();
  await second.handle.forceFlush();
  expect(first.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
    "updated",
  ]);
  expect(second.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
    "second",
  ]);
});

it.each(["fetch", "xhr"] as const)(
  "adds, removes, and transfers %s registrations without disturbing another handle",
  async (kind) => {
    const original = kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send;
    const native =
      kind === "fetch" ? vi.spyOn(globalThis, "fetch") : vi.spyOn(XMLHttpRequest.prototype, "send");
    const first = await start("first", []);
    const second = await start("second", [
      network(kind, { sanitizeUrl: () => "https://second.test/" }),
    ]);
    const instrumentation = network(kind, { sanitizeUrl: () => "https://first.test/" });
    const controls = first.handle.instrumentations;

    await expect(controls.add("", instrumentation)).rejects.toThrow("non-empty");
    await controls.add(kind, instrumentation);
    const patched = kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send;
    expect(patched).not.toBe(original);
    await request(kind);
    expect((await spans(first, 1))[0].attributes["url.full"]).toBe("https://first.test/");
    expect((await spans(second, 1))[0].attributes["url.full"]).toBe("https://second.test/");
    expect(native).toHaveBeenCalledOnce();

    await controls.remove(kind);
    expect(kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send).toBe(patched);
    await request(kind);
    await spans(first, 1);
    await spans(second, 2);

    await second.handle.instrumentations.add("transferred", instrumentation);
    await first.handle.shutdown();
    await request(kind);
    const transferred = await spans(second, 4);
    expect(transferred.at(-1)?.resource.attributes["service.name"]).toBe("second");
    expect(native).toHaveBeenCalledTimes(3);
  },
);

it.each(["fetch", "xhr"] as const)(
  "replaces %s collection with instance-bound providers and hooks",
  async (kind) => {
    const first = await start("first", [
      network(kind, {
        sanitizeUrl: () => "https://old.test/",
        applyCustomAttributesOnSpan: (span: { setAttribute(key: string, value: string): void }) =>
          span.setAttribute("subscriber", "old"),
      }),
    ]);
    const second = await start("second", [
      network(kind, {
        sanitizeUrl: () => "https://second.test/",
        applyCustomAttributesOnSpan: (span: { setAttribute(key: string, value: string): void }) =>
          span.setAttribute("subscriber", "second"),
      }),
    ]);
    const patched = kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send;
    const pending = request(kind);
    await first.handle.instrumentations.replace(
      kind,
      network(kind, {
        sanitizeUrl: () => "https://replacement.test/",
        applyCustomAttributesOnSpan: (span: { setAttribute(key: string, value: string): void }) =>
          span.setAttribute("subscriber", "replacement"),
      }),
    );
    await pending;
    await spans(first, 1);
    await spans(second, 1);
    await request(kind);
    const [old, replacement] = await spans(first, 2);
    const [, sibling] = await spans(second, 2);
    expect(old.attributes).toMatchObject({ "url.full": "https://old.test/", subscriber: "old" });
    expect(replacement.attributes).toMatchObject({
      "url.full": "https://replacement.test/",
      subscriber: "replacement",
    });
    expect(replacement.resource.attributes["service.name"]).toBe("first");
    expect(sibling.attributes).toMatchObject({
      "url.full": "https://second.test/",
      subscriber: "second",
    });
    expect(kind === "fetch" ? globalThis.fetch : XMLHttpRequest.prototype.send).toBe(patched);
  },
);

it("keeps a replacement paused and applies the replacement kind's gate", async () => {
  const first = await start("first", [network("fetch")]);
  const second = await start("second", [network("fetch")]);
  const controls = first.handle.instrumentations;
  await first.handle.instrumentations.setEnabled("fetch", false);
  const pausedFetch = network("fetch");
  await controls.replace("fetch", pausedFetch);
  expect(first.handle.instrumentations.get("fetch")).toBe(pausedFetch);
  await request("fetch");
  await spans(first, 0);
  await spans(second, 1);

  await first.handle.updateCfg({ disableAjaxTracking: true });
  await controls.replace("fetch", network("xhr"));
  await request("xhr");
  await spans(first, 0);
  await spans(second, 1);
  await first.handle.instrumentations.setEnabled("fetch", true);
  await first.handle.updateCfg({ disableAjaxTracking: false });
  await request("xhr");
  await spans(first, 1);
});

it("serializes a gated network addition with updateCfg", async () => {
  const first = await start("first", []);
  const second = await start("second", [network("fetch")]);
  await Promise.all([
    first.handle.updateCfg({ disableFetchTracking: true }),
    first.handle.instrumentations.add("added", network("fetch")),
  ]);
  await request("fetch");
  await spans(first, 0);
  await spans(second, 1);
  await first.handle.updateCfg({ disableFetchTracking: false });
  await request("fetch");
  await spans(first, 1);
  await spans(second, 2);
});

it.each(["fetch", "xhr"] as const)(
  "requires a trace pipeline before adding %s collection",
  async (kind) => {
    const logsOnly = await start("logs-only", [], { spanProcessors: [] });
    await expect(logsOnly.handle.instrumentations.add(kind, network(kind))).rejects.toThrow(
      "trace pipeline",
    );
  },
);

it("does not collect an XHR opened before replacement until it is opened again", async () => {
  const first = await start("first", [network("xhr")]);
  const second = await start("second", [network("xhr")]);
  const xhr = new XMLHttpRequest();
  xhr.open("GET", endpoint);
  await first.handle.instrumentations.replace("xhr", network("xhr"));
  await sendOpenedXhr(xhr);
  await spans(first, 0);
  await spans(second, 1);

  await request("xhr");
  await spans(first, 1);
  await spans(second, 2);
});

it.each(["console", "errors", "user-action"] as const)(
  "replaces and removes %s collection without changing a sibling subscriber",
  async (kind) => {
    const makeInstrumentation = (): BrowserInstrumentation => {
      switch (kind) {
        case "console":
          return new ConsoleInstrumentation({ enabled: false, logMethods: ["info"] });
        case "errors":
          return new ErrorsInstrumentation({
            enabled: false,
            applyCustomAttributes: () => ({ "test.error-hook": "owned" }),
          });
        case "user-action":
          return new UserActionInstrumentation({ enabled: false });
      }
    };
    const first = await start("first", [makeInstrumentation()]);
    const second = await start("second", [makeInstrumentation()]);
    const button = document.createElement("button");
    document.body.append(button);
    const emit = () => {
      if (kind === "console") console.info("registry event");
      else if (kind === "errors") {
        window.dispatchEvent(new ErrorEvent("error", { message: "registry event" }));
      } else button.click();
    };
    const records = async (pipeline: Awaited<ReturnType<typeof start>>, count: number) => {
      await vi.waitFor(async () => {
        await pipeline.handle.forceFlush();
        expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(count);
      });
    };
    try {
      emit();
      await records(first, 1);
      await records(second, 1);
      await first.handle.instrumentations.replace(kind, makeInstrumentation());
      emit();
      await records(first, 2);
      await records(second, 2);
      await first.handle.instrumentations.remove(kind);
      emit();
      await records(first, 2);
      await records(second, 3);
    } finally {
      button.remove();
    }
  },
);
