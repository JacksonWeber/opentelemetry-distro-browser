// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { suppressTracing } from "@opentelemetry/core";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry, type MicrosoftOpenTelemetryBrowser } from "../../src/index.js";
import {
  getInstrumentations,
  type DependencyInstrumentationOptions,
  type InstrumentationOptions,
} from "../../src/instrumentation/browserInstrumentation/index.js";
import { spanToEnvelope } from "../../src/exporter/spanUtils.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";
import { TEST_INSTRUMENTATION_KEY } from "../fixtures/azureMonitor.js";

const endpoint = new URL("/dependency", inject("redirectEndpoint")).href;
const originalUrl = location.href;
const originalFetch = globalThis.fetch;
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
const handles = new Set<MicrosoftOpenTelemetryBrowser>();
type Transport = "fetch" | "xhr";

async function start(
  dependencies?: DependencyInstrumentationOptions,
  options: InstrumentationOptions = {},
  pageViews = true,
) {
  const pipeline = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: pageViews },
    instrumentations: await getInstrumentations({ ...options, dependencies }),
  });
  handles.add(handle);
  return {
    ...pipeline,
    handle,
    async captured(count: number) {
      await vi.waitFor(async () => {
        await handle.forceFlush();
        expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(count);
      });
      return pipeline.spanExporter.getFinishedSpans();
    },
  };
}

function sendXhr(
  url: string,
  headers: [string, string][] = [],
  xhr = new XMLHttpRequest(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    xhr.onloadend = () => resolve();
    xhr.onerror = () => reject(new Error("Test XHR failed"));
    xhr.open("GET", url);
    for (const [name, value] of headers) xhr.setRequestHeader(name, value);
    xhr.send();
  });
}

async function send(
  transport: Transport,
  url = endpoint,
  headers: [string, string][] = [],
): Promise<void> {
  if (transport === "xhr") return sendXhr(url, headers);
  await (await fetch(url, { headers })).text();
}

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  XMLHttpRequest.prototype.open = originalOpen;
  XMLHttpRequest.prototype.send = originalSend;
  XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
  history.replaceState(null, "", originalUrl);
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

describe.each<Transport>(["fetch", "xhr"])("%s dependency enrichment", (transport) => {
  it("does not capture headers, status text or timing by default", async () => {
    const pipeline = await start();
    await send(transport, `${endpoint}?status=503`, [["x-public", "request"]]);
    const [span] = await pipeline.captured(1);
    expect(span.attributes["http.response.status_code"]).toBe(503);
    expect(
      Object.keys(span.attributes).filter(
        (name) =>
          name.includes(".header.") || name.includes("dependency.") || name.endsWith("status_text"),
      ),
    ).toEqual([]);
  });

  it("captures headers and failed status text with additive case-insensitive exclusions", async () => {
    const ignoreHeaders = ["X-Ignore"];
    const options: DependencyInstrumentationOptions = {
      captureRequestHeaders: true,
      captureResponseHeaders: true,
      includeErrorStatusText: true,
      ignoreHeaders,
    };
    const pipeline = await start(options);
    ignoreHeaders.length = 0;
    options.captureResponseHeaders = false;
    await send(transport, `${endpoint}?status=503`, [
      ["X-Public", "first"],
      ["x-public", "second"],
      ["Authorization", "test-credential"],
      ["X-Api-Key", "test-key"],
      ["X-Ignore", "test-secret"],
    ]);
    const [span] = await pipeline.captured(1);
    expect(span.attributes).toMatchObject({
      "http.request.header.x-public": ["first, second"],
      "http.response.header.x-public": ["response"],
      "http.response.status_text": "Dependency failed",
    });
    for (const name of [
      "authorization",
      "x-api-key",
      "x-ignore",
      "cookie",
      "set-cookie",
      "www-authenticate",
    ]) {
      expect(span.attributes[`http.request.header.${name}`]).toBeUndefined();
      expect(span.attributes[`http.response.header.${name}`]).toBeUndefined();
    }
    expect(span.attributes["http.response.header.x-private"]).toBeUndefined();
    const envelope = spanToEnvelope(span, TEST_INSTRUMENTATION_KEY);
    expect(envelope.data.baseData.properties).toMatchObject({
      "http.request.header.x-public": '["first, second"]',
      "http.response.header.x-public": '["response"]',
      "http.response.status_text": "Dependency failed",
    });
    expect(JSON.stringify(envelope)).not.toMatch(
      /test-credential|test-key|test-secret|response-body/,
    );
  });

  it("keeps capture directions independent and omits status text on success", async () => {
    const pipeline = await start({ captureResponseHeaders: true, includeErrorStatusText: true });
    await send(transport, endpoint, [["x-public", "request"]]);
    const [span] = await pipeline.captured(1);
    expect(span.attributes["http.response.header.x-public"]).toEqual(["response"]);
    expect(span.attributes["http.request.header.x-public"]).toBeUndefined();
    expect(span.attributes["http.response.status_text"]).toBeUndefined();
  });

  it("adds resource-timing phases without undoing URL sanitization", async () => {
    const pipeline = await start(
      { enableResourceTiming: true },
      {
        [transport]: { sanitizeUrl: () => "/sanitized" },
      },
    );
    await send(transport, `${endpoint}?timing=${transport}#client-fragment`);
    const [span] = await pipeline.captured(1);
    expect(span.attributes["url.full"]).toBe("/sanitized");
    expect(
      span.attributes["browser.dependency.duration"],
      JSON.stringify(
        performance
          .getEntriesByType("resource")
          .filter((entry) => entry.name.includes(`timing=${transport}`)),
      ),
    ).toEqual(expect.any(Number));
    for (const name of [
      "dns.duration",
      "connect.duration",
      "request.duration",
      "response.duration",
    ]) {
      expect(span.attributes[`browser.dependency.${name}`]).toEqual(expect.any(Number));
      expect(Number(span.attributes[`browser.dependency.${name}`])).toBeGreaterThanOrEqual(0);
    }
    const envelope = spanToEnvelope(span, TEST_INSTRUMENTATION_KEY);
    expect(envelope.data.baseData.measurements?.["browser.dependency.duration"]).toBe(
      span.attributes["browser.dependency.duration"],
    );
  });

  it("does not invent restricted cross-origin timing phases", async () => {
    const pipeline = await start({ enableResourceTiming: true });
    await send(transport, `${endpoint}?restricted=1`);
    const [span] = await pipeline.captured(1);
    expect(span.attributes["browser.dependency.duration"]).toEqual(expect.any(Number));
    expect(span.attributes["browser.dependency.request.duration"]).toBeUndefined();
    expect(span.attributes["browser.dependency.response.duration"]).toBeUndefined();
  });

  it("does not invent response headers or status text for CORS failures", async () => {
    const pipeline = await start({ captureResponseHeaders: true, includeErrorStatusText: true });
    await expect(send(transport, `${endpoint}?blocked=1`)).rejects.toThrow();
    const [span] = await pipeline.captured(1);
    expect(span.status.code).toBe(2);
    expect(span.attributes["http.response.status_text"]).toBeUndefined();
    expect(
      Object.keys(span.attributes).some((name) => name.startsWith("http.response.header.")),
    ).toBe(false);
  });
});

it.each(
  [
    { "X-Public": "record" },
    [["X-Public", "tuple"]] as [string, string][],
    new Headers({ "X-Public": "headers" }),
  ].map((headers) => ({ headers })),
)("captures fetch HeadersInit forms after the application request hook", async ({ headers }) => {
  const hook = vi.fn((_span, request: Request | RequestInit) => {
    const next = new Headers(request.headers);
    next.set("x-public", "from-hook");
    if (request instanceof Request) request.headers.set("x-public", "from-hook");
    else request.headers = next;
  });
  const pipeline = await start({ captureRequestHeaders: true }, { fetch: { requestHook: hook } });
  await (await fetch(endpoint, { headers })).text();
  const [span] = await pipeline.captured(1);
  expect(hook).toHaveBeenCalledOnce();
  expect(span.attributes["http.request.header.x-public"]).toEqual(["from-hook"]);
  expect(span.attributes["http.response.header.x-public"]).toBeUndefined();
});

it("uses effective Request headers when fetch supplies overriding init", async () => {
  const pipeline = await start({ captureRequestHeaders: true });
  const request = new Request(endpoint, { headers: { "x-public": "original", "x-ignore": "old" } });
  await (await fetch(request, { headers: { "X-Public": "override" } })).text();
  const [span] = await pipeline.captured(1);
  expect(span.attributes["http.request.header.x-public"]).toEqual(["override"]);
  expect(span.attributes["http.request.header.x-ignore"]).toBeUndefined();
  expect(request.headers.get("x-public")).toBe("original");
});

it("does not carry headers across XHR reuse", async () => {
  const pipeline = await start({ captureRequestHeaders: true });
  const xhr = new XMLHttpRequest();
  await sendXhr(endpoint, [["x-public", "first"]], xhr);
  await sendXhr(endpoint, [["x-ignore", "second"]], xhr);
  const [first, second] = await pipeline.captured(2);
  expect(first.attributes["http.request.header.x-public"]).toEqual(["first"]);
  expect(second.attributes["http.request.header.x-public"]).toBeUndefined();
  expect(second.attributes["http.request.header.x-ignore"]).toEqual(["second"]);
});

it("captures XHR headers when application code sends inside open's readystatechange", async () => {
  const pipeline = await start({ captureRequestHeaders: true });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onloadend = () => resolve();
    xhr.onerror = () => reject(new Error("Test XHR failed"));
    xhr.onreadystatechange = () => {
      if (xhr.readyState === XMLHttpRequest.OPENED) {
        xhr.setRequestHeader("x-public", "reentrant");
        xhr.send();
      }
    };
    xhr.open("GET", endpoint);
  });
  const [span] = await pipeline.captured(1);
  expect(span.attributes["http.request.header.x-public"]).toEqual(["reentrant"]);
});

it("preserves application enrichment and continues capture when a request hook throws", async () => {
  const pipeline = await start(
    { captureRequestHeaders: true, captureResponseHeaders: true, includeErrorStatusText: true },
    {
      fetch: {
        requestHook(span) {
          span.setAttribute("http.request.header.x-public", ["application"]);
          throw new Error("test hook failure");
        },
        applyCustomAttributesOnSpan(span) {
          span.setAttribute("http.response.header.x-public", ["application"]);
        },
      },
      xhr: {
        applyCustomAttributesOnSpan(span) {
          span.setAttribute("http.response.status_text", "application");
        },
      },
    },
  );
  const error = vi.fn();
  diag.setLogger({ error, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), verbose: vi.fn() });
  await send("fetch", endpoint, [["x-public", "request"]]);
  await send("xhr", `${endpoint}?status=500`);
  const [fetchSpan, xhrSpan] = await pipeline.captured(2);
  expect(fetchSpan.attributes["http.request.header.x-public"]).toEqual(["application"]);
  expect(fetchSpan.attributes["http.response.header.x-public"]).toEqual(["application"]);
  expect(xhrSpan.attributes["http.response.status_text"]).toBe("application");
  expect(error).toHaveBeenCalled();
});

it("shares the budget at request start, resets on navigation and preserves explicit parents", async () => {
  const pipeline = await start(
    { maxDependenciesPerView: 2 },
    {
      fetch: { ignoreUrls: [`${endpoint}?ignored=1`] },
    },
  );
  const warning = vi.spyOn(diag, "warn").mockImplementation(() => {});
  await send("fetch", `${endpoint}?ignored=1`);
  await Promise.all([send("fetch", `${endpoint}?delay=30`), send("xhr", endpoint)]);
  await send("fetch");
  await send("xhr");
  await pipeline.captured(2);
  expect(warning).toHaveBeenCalledExactlyOnceWith("Dependency limit reached for this page view");

  history.pushState(null, "", "/dependency-next-view");
  const parent = trace.getTracer("application").startSpan("manual");
  await context.with(trace.setSpan(ROOT_CONTEXT, parent), () => send("xhr"));
  parent.end();
  const spans = await pipeline.captured(4);
  expect(
    spans.find((span) => span.parentSpanContext?.spanId === parent.spanContext().spanId),
  ).toBeDefined();
});

it("still sends requests and propagates the parent when the limit is zero", async () => {
  const pipeline = await start(
    { maxDependenciesPerView: 0 },
    {
      fetch: { propagateTraceHeaderCorsUrls: [/^http:\/\/127\.0\.0\.1:/] },
    },
  );
  const parent = trace.getSpanContext(context.active())!;
  const response = await fetch(endpoint);
  const body = await response.json();
  expect(body.traceparent).toBe(`00-${parent.traceId}-${parent.spanId}-01`);
  await pipeline.captured(0);
});

it("does not charge suppressed exporter requests to the dependency budget", async () => {
  const pipeline = await start({ maxDependenciesPerView: 1, captureRequestHeaders: true });
  await context.with(suppressTracing(context.active()), () => send("fetch"));
  await context.with(suppressTracing(context.active()), () => send("xhr"));
  await send("fetch", endpoint, [["x-public", "application"]]);
  const [span] = await pipeline.captured(1);
  expect(span.attributes["http.request.header.x-public"]).toEqual(["application"]);
});

it("uses one lifetime budget when page views are disabled", async () => {
  const pipeline = await start({ maxDependenciesPerView: 1 }, {}, false);
  await send("fetch");
  await pipeline.captured(1);
  history.pushState(null, "", "/without-page-views");
  await send("xhr");
  await pipeline.captured(1);
});

it("keeps enrichment unlimited by default beyond 500 dependencies", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  const pipeline = await start({ captureRequestHeaders: true });
  await Promise.all(Array.from({ length: 501 }, () => send("fetch")));
  await pipeline.captured(501);
});

it("charges an in-flight request to its starting page rather than its completion page", async () => {
  const pipeline = await start({ maxDependenciesPerView: 1 });
  const firstPage = trace.getSpanContext(context.active())!.traceId;
  const pending = send("fetch", `${endpoint}?delay=50`);
  history.pushState(null, "", "/dependency-in-flight");
  const nextPage = trace.getSpanContext(context.active())!.traceId;
  await send("xhr");
  await pending;
  await send("xhr");
  const spans = await pipeline.captured(2);
  expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(
    new Set([firstPage, nextPage]),
  );
});

it("keeps separate presets and providers isolated through shutdown", async () => {
  const first = await start(
    { maxDependenciesPerView: 1, captureRequestHeaders: true },
    {
      xhr: { enabled: false },
    },
  );
  const second = await start(
    { maxDependenciesPerView: 2, captureResponseHeaders: true },
    {
      fetch: { enabled: false },
    },
  );
  await send("fetch", endpoint, [["x-public", "first"]]);
  await send("xhr", endpoint, [["x-public", "second"]]);
  const [firstSpan] = await first.captured(1);
  const [secondSpan] = await second.captured(1);
  expect(firstSpan.attributes["http.request.header.x-public"]).toEqual(["first"]);
  expect(firstSpan.attributes["http.response.header.x-public"]).toBeUndefined();
  expect(secondSpan.attributes["http.request.header.x-public"]).toBeUndefined();
  expect(secondSpan.attributes["http.response.header.x-public"]).toEqual(["response"]);
  await first.handle.shutdown();
  await send("xhr");
  await second.captured(2);
});

it("releases owned patches and ignores in-flight enrichment after shutdown", async () => {
  const pipeline = await start({
    captureRequestHeaders: true,
    captureResponseHeaders: true,
    enableResourceTiming: true,
  });
  const onEnd = vi.spyOn(pipeline.spanProcessor, "onEnd");
  const pending = send("fetch", `${endpoint}?delay=50`);
  await pipeline.handle.shutdown();
  expect(XMLHttpRequest.prototype.setRequestHeader).toBe(originalSetHeader);
  await pending;
  await send("xhr");
  expect(onEnd).not.toHaveBeenCalled();
});
