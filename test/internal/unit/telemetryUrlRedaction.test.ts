// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  diag,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type TracerProvider,
} from "@opentelemetry/api";
import { logs, type LoggerProvider } from "@opentelemetry/api-logs";
import type { LogRecordProcessor, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { Span } from "@opentelemetry/sdk-trace";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import { EVENT_BROWSER_PAGE_VIEW } from "../../../src/instrumentation/pageView/semconv.js";
import type {
  BrowserInstrumentation,
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/types.js";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";

const handles = new Set<MicrosoftOpenTelemetryBrowser>();
const originalUrl = location.href;
const sensitiveUrl = "https://user:secret@example.test/app.js?token=private&safe=visible";
const redactedUrl = "https://REDACTED:REDACTED@example.test/app.js?token=REDACTED&safe=visible";

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  // Match the existing initialization/multi-instance suites: SDK shutdown leaves globals installed.
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  if (location.href !== originalUrl) history.replaceState(null, "", originalUrl);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

/** Record at the public processor boundary, using providers bound by real initialization. */
async function start(
  options: MicrosoftOpenTelemetryBrowserOptions = {},
  scopeName = "@opentelemetry/browser-instrumentation/fetch",
) {
  const startedSpans: Span[] = [];
  const spans: ReadableSpan[] = [];
  const records: ReadableLogRecord[] = [];
  const spanProcessor: SpanProcessor = {
    onStart: (span) => {
      startedSpans.push(span);
    },
    onEnd: (span) => {
      spans.push(span);
    },
    async forceFlush() {},
    async shutdown() {},
  };
  const logProcessor: LogRecordProcessor = {
    onEmit: (record) => {
      records.push(record);
    },
    async forceFlush() {},
    async shutdown() {},
  };
  let tracerProvider!: TracerProvider;
  let loggerProvider!: LoggerProvider;
  const probe: BrowserInstrumentation = {
    setTracerProvider: (provider) => {
      tracerProvider = provider;
    },
    setLoggerProvider: (provider) => {
      loggerProvider = provider;
    },
    getConfig: () => ({ enabled: false }),
    enable() {},
    disable() {},
  };
  const handle = await useMicrosoftOpenTelemetry({
    session: { enabled: false },
    userContext: { enabled: false },
    pageView: { enabled: false },
    spanProcessors: [spanProcessor],
    logRecordProcessors: [logProcessor],
    instrumentations: [probe],
    ...options,
  });
  handles.add(handle);
  return {
    handle,
    startedSpans,
    spans,
    records,
    tracer: tracerProvider.getTracer(scopeName),
    logger: loggerProvider.getLogger("url-redaction-test"),
  };
}

describe("instance telemetry URL redaction", () => {
  it.each([
    "@opentelemetry/browser-instrumentation/fetch",
    "@opentelemetry/browser-instrumentation/xhr",
  ])("redacts late URL attributes before custom processors see them for %s", async (scopeName) => {
    const pipeline = await start({}, scopeName);
    const span = pipeline.tracer.startSpan("GET /app.js", { kind: SpanKind.CLIENT });
    const attributes = {
      "url.full": sensitiveUrl,
      "http.url": sensitiveUrl,
      "url.original": sensitiveUrl,
      "url.referrer": sensitiveUrl,
      "http.referrer": sensitiveUrl,
      "browser.page_view.referrer": sensitiveUrl,
      "http.request.method": "GET",
      "custom.value": "unchanged",
    };
    span.setAttributes(attributes);
    expect(pipeline.spans).toHaveLength(0);
    span.end();

    expect(pipeline.spans).toHaveLength(1);
    expect(pipeline.spans[0].attributes).toMatchObject({
      ...attributes,
      "url.full": redactedUrl,
      "http.url": redactedUrl,
    });
    expect(attributes["url.full"]).toBe(sensitiveUrl);
    expect(pipeline.spans[0]).toBe(span);
    expect(pipeline.startedSpans[0].attributes["url.full"]).toBe(redactedUrl);
    expect(pipeline.spans[0].spanContext()).toEqual(span.spanContext());
    expect(pipeline.spans[0].ended).toBe(true);
    expect(spanToEnvelope(pipeline.spans[0], TEST_INSTRUMENTATION_KEY).data.baseData).toMatchObject(
      {
        data: redactedUrl,
      },
    );
  });

  it("leaves exception events, span names, status and custom text untouched", async () => {
    const pipeline = await start();
    const attributes = Object.freeze({
      "exception.type": "TypeError",
      "exception.message": `Failed loading ${sensitiveUrl}`,
      "exception.stacktrace": `TypeError: failed\n    at load (${sensitiveUrl}:12:34)`,
      "exception.source": sensitiveUrl,
      "code.file.path": sensitiveUrl,
      "code.filepath": sensitiveUrl,
    });
    const parent = {
      traceId: "12345678901234567890123456789012",
      spanId: "1234567890123456",
      traceFlags: 1,
    };
    const span = pipeline.tracer.startSpan(
      `load ${sensitiveUrl}`,
      {
        kind: SpanKind.CLIENT,
        startTime: [100, 0],
        links: [{ context: parent }],
        attributes: { ...attributes, "http.request.method": "GET", "custom.text": sensitiveUrl },
      },
      trace.setSpanContext(context.active(), parent),
    );
    span.addEvent("exception", attributes, [101, 0]);
    const status = Object.freeze({
      code: SpanStatusCode.ERROR,
      message: `Failed ${sensitiveUrl}`,
    });
    span.setStatus(status);
    const original = pipeline.startedSpans[0];
    const metadata = {
      kind: original.kind,
      parentSpanContext: original.parentSpanContext,
      startTime: original.startTime,
      links: original.links,
      resource: original.resource,
      instrumentationScope: original.instrumentationScope,
      droppedAttributesCount: original.droppedAttributesCount,
      droppedEventsCount: original.droppedEventsCount,
      droppedLinksCount: original.droppedLinksCount,
    };
    const sdkAttributes = original.attributes;
    const event = original.events[0];
    const eventAttributes = event.attributes;
    expect(eventAttributes).not.toBe(attributes);
    expect(eventAttributes).toEqual(attributes);
    span.end([102, 0]);

    const recorded = pipeline.spans[0];
    expect(recorded.name).toBe(`load ${sensitiveUrl}`);
    expect(recorded.status).toEqual(status);
    expect(recorded.events[0].attributes).toEqual(attributes);
    expect(recorded.attributes).toMatchObject({ ...attributes, "custom.text": sensitiveUrl });
    expect(attributes["exception.source"]).toBe(sensitiveUrl);
    expect(attributes["exception.stacktrace"]).toContain(sensitiveUrl);
    expect(status.message).toBe(`Failed ${sensitiveUrl}`);
    expect(recorded).toBe(span);
    expect(recorded).toBe(original);
    expect(original.name).toBe(`load ${sensitiveUrl}`);
    expect(original.status.message).toBe(`Failed ${sensitiveUrl}`);
    expect(recorded.attributes).toBe(sdkAttributes);
    expect(recorded.events[0]).toBe(event);
    expect(recorded.events[0].attributes).toBe(eventAttributes);
    expect(recorded.events[0].time).toEqual([101, 0]);
    expect(recorded.events[0].droppedAttributesCount).toBe(0);
    expect(recorded.endTime).toEqual([102, 0]);
    expect(recorded.duration).toEqual([2, 0]);
    expect(recorded.ended).toBe(true);
    expect(recorded.parentSpanContext).toEqual(parent);
    expect(recorded.links).toEqual([{ context: parent }]);
    for (const field of Object.keys(metadata) as (keyof typeof metadata)[]) {
      expect(recorded[field], field).toBe(metadata[field]);
    }
  });

  it("redacts late application onEnding changes before every onEnd and export", async () => {
    const order: string[] = [];
    const exporter = new InMemorySpanExporter();
    const attributes = Object.freeze({ "exception.message": `Late ${sensitiveUrl}` });
    const first: SpanProcessor = {
      onStart() {},
      onEnding(span) {
        order.push("first ending");
        expect(span.isRecording()).toBe(true);
        expect(span.attributes["url.full"]).toBe(sensitiveUrl);
      },
      onEnd(span) {
        order.push("first end");
        expect(span.ended).toBe(true);
        expect(span.name).toBe(`Late ${sensitiveUrl}`);
        expect(span.status.message).toBe(`Late ${sensitiveUrl}`);
        expect(span.attributes["url.full"]).toBe(redactedUrl);
        expect(span.events[0].attributes?.["exception.message"]).toBe(`Late ${sensitiveUrl}`);
      },
      async forceFlush() {},
      async shutdown() {},
    };
    const last: SpanProcessor = {
      ...first,
      onEnding(span) {
        order.push("last ending");
        expect(span.attributes["url.full"]).toBe(sensitiveUrl);
        span.setAttribute("url.full", sensitiveUrl);
        span.updateName(`Late ${sensitiveUrl}`);
        span.setStatus({ code: SpanStatusCode.ERROR, message: `Late ${sensitiveUrl}` });
        span.addEvent("exception", attributes);
      },
      onEnd(span) {
        order.push("last end");
        expect(span.attributes["url.full"]).toBe(redactedUrl);
      },
    };
    const pipeline = await start({
      // Exporting is registered first; the final application hook must still be redacted.
      spanProcessors: [new SimpleSpanProcessor(exporter), first, last],
    });
    const span = pipeline.tracer.startSpan("request", {
      kind: SpanKind.CLIENT,
      attributes: { "url.full": sensitiveUrl, "http.request.method": "GET" },
    });
    const updateName = vi.spyOn(span, "updateName");
    span.end();
    await pipeline.handle.forceFlush();

    expect(order).toEqual(["first ending", "last ending", "first end", "last end"]);
    expect(updateName).toHaveBeenCalledTimes(1); // Only the application hook changes the name.
    expect(attributes["exception.message"]).toBe(`Late ${sensitiveUrl}`);
    const exported = exporter.getFinishedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0]).toBe(span);
    expect(exported[0].attributes["url.full"]).toBe(redactedUrl);
    expect(exported[0].events[0].attributes).toEqual({
      "exception.message": `Late ${sensitiveUrl}`,
    });
  });

  it.each([
    ["fetch", ""],
    ["xhr", ""],
    ["fetch", " \t "],
    ["xhr", " \t "],
  ])("preserves URL attributes cleared by an application hook for %s (%j)", async (name, value) => {
    const exporter = new InMemorySpanExporter();
    const onEnding = vi.fn((span: Span) => {
      span.setAttribute("url.full", value);
      span.setAttribute("http.url", value);
    });
    const pipeline = await start(
      {
        spanProcessors: [
          new SimpleSpanProcessor(exporter),
          {
            onStart() {},
            onEnding,
            onEnd() {},
            async forceFlush() {},
            async shutdown() {},
          },
        ],
      },
      `@opentelemetry/browser-instrumentation/${name}`,
    );
    const span = pipeline.tracer.startSpan("request", {
      kind: SpanKind.CLIENT,
      attributes: {
        "url.full": sensitiveUrl,
        "http.url": sensitiveUrl,
        "http.request.method": "GET",
      },
    });
    span.end();
    await pipeline.handle.forceFlush();

    expect(onEnding).toHaveBeenCalledOnce();
    const exported = exporter.getFinishedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0].attributes["url.full"]).toBe(value);
    expect(exported[0].attributes["http.url"]).toBe(value);
  });

  it("does not redact or call application hooks for spans ending after shutdown", async () => {
    const onEnding = vi.fn();
    const onEnd = vi.fn();
    let started!: Span;
    const pipeline = await start({
      spanProcessors: [
        {
          onStart(span) {
            started = span;
          },
          onEnding,
          onEnd,
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    });
    const span = pipeline.tracer.startSpan(`load ${sensitiveUrl}`, {
      kind: SpanKind.CLIENT,
      attributes: { "url.full": sensitiveUrl, "http.request.method": "GET" },
    });
    const updateName = vi.spyOn(span, "updateName");
    await pipeline.handle.shutdown();
    span.end();

    expect(onEnding).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(updateName).not.toHaveBeenCalled();
    expect(started.attributes["url.full"]).toBe(sensitiveUrl);
  });

  it("leaves exception log attributes and body untouched", async () => {
    const pipeline = await start();
    const attributes = {
      "exception.type": "Error",
      "exception.message": `Cannot load ${sensitiveUrl}`,
      "exception.stacktrace": `load@${sensitiveUrl}:8:2`,
      "exception.source": sensitiveUrl,
      "code.filepath": sensitiveUrl,
      "url.full": sensitiveUrl,
      "custom.count": 3,
    };
    pipeline.logger.emit({ body: `Cannot load ${sensitiveUrl}`, attributes });

    expect(pipeline.records).toHaveLength(1);
    expect(pipeline.records[0].body).toBe(`Cannot load ${sensitiveUrl}`);
    expect(pipeline.records[0].attributes).toMatchObject(attributes);
    expect(attributes["url.full"]).toBe(sensitiveUrl);
  });

  it("does not rewrite ordinary log bodies or structured application bodies", async () => {
    const pipeline = await start();
    const body = { message: sensitiveUrl };
    pipeline.logger.emit({ body: sensitiveUrl });
    pipeline.logger.emit({ body, attributes: { "exception.type": "Error" } });
    expect(pipeline.records.map((record) => record.body)).toEqual([sensitiveUrl, body]);
    expect(body.message).toBe(sensitiveUrl);
  });

  it("snapshots additive settings at initialization and isolates concurrent dependencies across instances", async () => {
    const parameters = ["alpha"];
    const pending = start({ redactQueryParams: parameters });
    parameters.splice(0, 1, "beta");
    const alpha = await pending;
    const beta = await start({ redactQueryParams: ["beta"] });
    const url = "https://example.test/?token=default&alpha=one&beta=two";
    const alphaUrl = "https://example.test/?token=REDACTED&alpha=REDACTED&beta=two";
    const betaUrl = "https://example.test/?token=REDACTED&alpha=one&beta=REDACTED";

    const pendingSpans = [alpha, beta].map((pipeline) =>
      pipeline.tracer.startSpan("request", {
        kind: SpanKind.CLIENT,
        attributes: { "url.full": url, "http.request.method": "GET" },
      }),
    );
    for (const span of pendingSpans.reverse()) span.end();
    for (const pipeline of [alpha, beta]) {
      pipeline.logger.emit({
        body: url,
        attributes: { "exception.type": "Error", "url.full": url },
      });
    }
    expect(alpha.spans.map((span) => span.attributes["url.full"])).toEqual([alphaUrl]);
    expect(beta.spans.map((span) => span.attributes["url.full"])).toEqual([betaUrl]);
    expect(alpha.records[0].attributes["url.full"]).toBe(url);
    expect(alpha.records[0].body).toBe(url);
    expect(beta.records[0].attributes["url.full"]).toBe(url);
    expect(beta.records[0].body).toBe(url);
  });

  it("preserves legacy page-view replacement settings and snapshots their array", async () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const parameters = ["tenant_secret"];
    history.replaceState(null, "", "/legacy?code=visible&tenant_secret=private");
    const pending = start({ pageView: { redactedQueryParams: parameters } });
    parameters[0] = "code";
    const pipeline = await pending;
    window.dispatchEvent(new Event("pagehide"));

    const pageViews = pipeline.records.filter(
      (record) => record.eventName === EVENT_BROWSER_PAGE_VIEW,
    );
    expect(pageViews).toHaveLength(1);
    expect(pageViews[0].attributes["url.full"]).toBe(
      `${location.origin}/legacy?code=visible&tenant_secret=REDACTED`,
    );
  });

  it("adds instance parameters to page-view URLs without changing sanitizer output", async () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    history.replaceState(null, "", "/page?token=private&tenant=secret&safe=visible");
    const sanitizeUrl = vi.fn((url: string) => new URL(url).pathname);
    const pipeline = await start({
      redactQueryParams: ["tenant"],
      pageView: { sanitizeUrl },
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(sanitizeUrl).toHaveBeenCalledWith(
      `${location.origin}/page?token=REDACTED&tenant=REDACTED&safe=visible`,
    );
    const pageViews = pipeline.records.filter(
      (record) => record.eventName === EVENT_BROWSER_PAGE_VIEW,
    );
    expect(pageViews).toHaveLength(1);
    expect(pageViews[0].attributes["url.full"]).toBe("/page");
  });

  it.each([
    [SpanKind.INTERNAL, { "http.request.method": "GET" }],
    [SpanKind.SERVER, { "http.request.method": "GET" }],
    [SpanKind.CLIENT, { "db.system.name": "postgresql" }],
  ])("does not rewrite non-HTTP-client URLs (%s, %j)", async (kind, attributes) => {
    const pipeline = await start();
    pipeline.tracer
      .startSpan("other", {
        kind,
        attributes: { ...attributes, "url.full": sensitiveUrl, "http.url": sensitiveUrl },
      })
      .end();
    expect(pipeline.spans[0].attributes).toMatchObject({
      "url.full": sensitiveUrl,
      "http.url": sensitiveUrl,
    });
  });

  it.each([
    "application-http-client",
    "@third-party/http-client",
    "@opentelemetry/instrumentation-fetch",
    "@opentelemetry/browser-instrumentation/fetch-custom",
  ])(
    "leaves HTTP client spans from %s untouched without network instrumentation",
    async (scopeName) => {
      const fetchBefore = globalThis.fetch;
      const xhrOpenBefore = XMLHttpRequest.prototype.open;
      const xhrSendBefore = XMLHttpRequest.prototype.send;
      const pipeline = await start({}, scopeName);
      trace
        .getTracer(scopeName)
        .startSpan("application request", {
          kind: SpanKind.CLIENT,
          attributes: {
            "url.full": sensitiveUrl,
            "http.url": sensitiveUrl,
            "http.request.method": "GET",
            "http.method": "GET",
          },
        })
        .end();

      expect(pipeline.spans).toHaveLength(1);
      expect(pipeline.spans[0].instrumentationScope.name).toBe(scopeName);
      expect(pipeline.spans[0].attributes).toMatchObject({
        "url.full": sensitiveUrl,
        "http.url": sensitiveUrl,
      });
      expect(globalThis.fetch).toBe(fetchBefore);
      expect(XMLHttpRequest.prototype.open).toBe(xhrOpenBefore);
      expect(XMLHttpRequest.prototype.send).toBe(xhrSendBefore);
    },
  );

  it("redacts legacy HTTP client URL attributes", async () => {
    const pipeline = await start({}, "@opentelemetry/browser-instrumentation/xhr");
    pipeline.tracer
      .startSpan("request", {
        kind: SpanKind.CLIENT,
        attributes: { "http.url": sensitiveUrl, "http.method": "GET" },
      })
      .end();
    expect(pipeline.spans[0].attributes["http.url"]).toBe(redactedUrl);
  });

  it.each([
    ["/sanitized", "/sanitized"],
    [
      "/sanitized?token=private&tenant=secret&safe=visible#access_token=private&tenant=secret",
      "/sanitized?token=REDACTED&tenant=REDACTED&safe=visible#access_token=REDACTED&tenant=REDACTED",
    ],
    ["../sanitized?token=private#tenant=secret", "/sanitized?token=REDACTED#tenant=REDACTED"],
    ["?token=private", "/base/page?token=REDACTED"],
    ["#/route?token=private&tenant=secret", "/base/page#/route?token=REDACTED&tenant=REDACTED"],
  ])(
    "resolves relative dependency output against document.baseURI before redaction: %s",
    async (url, expected) => {
      vi.spyOn(document, "baseURI", "get").mockReturnValue("https://base.example/base/page");
      const pipeline = await start({ redactQueryParams: ["tenant"] });
      pipeline.tracer
        .startSpan("request", {
          kind: SpanKind.CLIENT,
          attributes: { "url.full": url, "http.url": url, "http.request.method": "GET" },
        })
        .end();
      expect(pipeline.spans[0].attributes["url.full"]).toBe(`https://base.example${expected}`);
      expect(pipeline.spans[0].attributes["http.url"]).toBe(`https://base.example${expected}`);
    },
  );

  it("falls back to location.href and protects built-in parameters without custom settings", async () => {
    vi.spyOn(document, "baseURI", "get").mockReturnValue("");
    const pipeline = await start();
    pipeline.tracer
      .startSpan("request", {
        kind: SpanKind.CLIENT,
        attributes: {
          "url.full": "?token=private#access_token=private",
          "http.request.method": "GET",
        },
      })
      .end();
    const expected = new URL("?token=REDACTED#access_token=REDACTED", location.href).href;
    expect(pipeline.spans[0].attributes["url.full"]).toBe(expected);
  });

  describe.each(["fetch", "xhr"])("%s sanitizer output", (name) => {
    it.each(["document", "location"])(
      "does not restore page query data from the %s base",
      async (baseSource) => {
        history.replaceState(null, "", "/location/page?email=private#location-secret");
        vi.spyOn(document, "baseURI", "get").mockReturnValue(
          baseSource === "document"
            ? "https://base.example/base/page?email=private#document-secret"
            : "",
        );
        const pipeline = await start({}, `@opentelemetry/browser-instrumentation/${name}`);
        pipeline.tracer
          .startSpan("request", {
            kind: SpanKind.CLIENT,
            attributes: {
              "url.full": "#/sanitized",
              "http.url": "#/sanitized",
              "http.request.method": "GET",
            },
          })
          .end();

        const expected =
          baseSource === "document"
            ? "https://base.example/base/page#/sanitized"
            : `${location.origin}/location/page#/sanitized`;
        expect(pipeline.spans[0].attributes["url.full"]).toBe(expected);
        expect(pipeline.spans[0].attributes["http.url"]).toBe(expected);
        expect(pipeline.records).toHaveLength(0);
      },
    );

    it.each(["https://[redacted]/resource?token=private", "//[redacted]/resource?token=private"])(
      "clears unparseable URL attributes instead of exporting secrets: %s",
      async (url) => {
        const pipeline = await start({}, `@opentelemetry/browser-instrumentation/${name}`);
        const span = pipeline.tracer.startSpan("request", {
          kind: SpanKind.CLIENT,
          attributes: { "url.full": url, "http.url": url, "http.request.method": "GET" },
        });
        expect(() => span.end()).not.toThrow();
        expect(pipeline.spans).toHaveLength(1);
        expect(pipeline.spans[0].attributes["url.full"]).toBe("");
        expect(pipeline.spans[0].attributes["http.url"]).toBe("");
      },
    );
  });

  it("preserves relative source file paths on exception spans and logs", async () => {
    const pipeline = await start();
    const attributes = { "code.filepath": "src/app.ts", "code.file.path": "../lib/load.ts" };
    const span = pipeline.tracer.startSpan("exception");
    span.addEvent("exception", { "exception.type": "Error", ...attributes });
    span.end();
    pipeline.logger.emit({ attributes: { "exception.type": "Error", ...attributes } });
    expect(pipeline.spans[0].events[0].attributes).toMatchObject(attributes);
    expect(pipeline.records[0].attributes).toMatchObject(attributes);
  });
});
