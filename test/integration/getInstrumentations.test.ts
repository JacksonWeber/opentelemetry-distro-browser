// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ROOT_CONTEXT,
  context,
  diag,
  propagation,
  trace,
  type TextMapPropagator,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, inject, it } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../src/index.js";
import { getInstrumentations } from "../../src/instrumentation/browserInstrumentation/index.js";
import type {
  InstrumentationOptions,
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserTraceOptions,
} from "../../src/types.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

/**
 * Exercises the constructed instrumentations against a real browser, registered the way an
 * application registers them: real `fetch`, real `XMLHttpRequest`, real patching of the global
 * objects. The unit tests assert what configuration is produced; these assert what that
 * configuration actually does once it is running.
 */

/** A path the dev server will answer, so a request completes rather than failing to connect. */
const APPLICATION_URL = new URL("/__application__", location.origin).toString();
const CROSS_ORIGIN_HEADERS_URL = new URL("/headers", inject("redirectEndpoint")).toString();

interface PropagationHeaders {
  baggage?: string;
  custom?: string;
  traceparent?: string;
  tracestate?: string;
}

let pipeline: ReturnType<typeof createInMemoryPipeline>;
let handle: MicrosoftOpenTelemetryBrowser | undefined;

async function start(
  options: InstrumentationOptions = {},
  traces?: MicrosoftOpenTelemetryBrowserTraceOptions,
): Promise<void> {
  pipeline = createInMemoryPipeline();
  handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    traces,
    instrumentations: await getInstrumentations(options),
  });
}

/** Resolves once the request has settled, whatever the outcome. */
async function request(url: string): Promise<void> {
  try {
    await fetch(url);
  } catch {
    // A non-2xx or blocked response is still a completed request as far as capture goes.
  }
}

function sendXhr(url: string): Promise<void> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.addEventListener("loadend", () => resolve());
    xhr.open("GET", url);
    xhr.send();
  });
}

function sendXhrForHeaders(url: string): Promise<PropagationHeaders> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.addEventListener("load", () => {
      try {
        resolve(JSON.parse(xhr.responseText) as PropagationHeaders);
      } catch (error) {
        reject(error);
      }
    });
    xhr.addEventListener("error", () => reject(new Error(`XMLHttpRequest failed for ${url}`)));
    xhr.open("GET", url);
    xhr.send();
  });
}

async function fetchHeaders(url: string): Promise<PropagationHeaders> {
  const response = await fetch(url);
  return (await response.json()) as PropagationHeaders;
}

function withBaggage<T>(callback: () => T): T {
  const baggage = propagation.createBaggage({
    "tenant.id": { value: "contoso" },
  });
  return context.with(propagation.setBaggage(context.active(), baggage), callback);
}

function expectW3cHeaders(headers: PropagationHeaders): void {
  expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(headers.baggage).toBe("tenant.id=contoso");
}

/** Waits for the exporter to settle, then returns whatever was captured. */
async function captured(): Promise<ReadableSpan[]> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await pipeline.spanProcessor.forceFlush();
  return pipeline.spanExporter.getFinishedSpans();
}

function urlsOf(spans: readonly ReadableSpan[]): string[] {
  return spans.map((span) => String(span.attributes["url.full"] ?? span.attributes["http.url"]));
}

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
});

describe("configured instrumentations in a browser", () => {
  it("captures both a fetch and an XMLHttpRequest with no instrumentation options", async () => {
    await start();
    await request(APPLICATION_URL);
    await sendXhr(APPLICATION_URL);

    const spans = await captured();
    expect(spans).toHaveLength(2);
    expect(urlsOf(spans)).toEqual([APPLICATION_URL, APPLICATION_URL]);
  });

  it("captures nothing once the default instrumentations are turned off", async () => {
    await start({ fetch: { enabled: false }, xhr: { enabled: false } });

    await request(APPLICATION_URL);
    await sendXhr(APPLICATION_URL);

    expect(await captured()).toEqual([]);
  });

  it("does not patch fetch when fetch capture is turned off", async () => {
    const original = window.fetch;
    await start({ fetch: { enabled: false } });

    expect(window.fetch).toBe(original);
  });

  it("captures a fetch request once enabled", async () => {
    await start({ fetch: { enabled: true }, xhr: { enabled: false } });

    await request(APPLICATION_URL);

    const spans = await captured();
    expect(spans).toHaveLength(1);
    expect(urlsOf(spans)).toEqual([APPLICATION_URL]);
  });

  it("captures an XMLHttpRequest once enabled", async () => {
    await start({ xhr: { enabled: true }, fetch: { enabled: false } });

    await sendXhr(APPLICATION_URL);

    const spans = await captured();
    expect(spans).toHaveLength(1);
    expect(urlsOf(spans)).toEqual([APPLICATION_URL]);
  });

  describe("W3C propagation", () => {
    it("injects trace context and baggage into allowed cross-origin requests", async () => {
      const allowedOrigins = [/^http:\/\/127\.0\.0\.1:\d+\//];
      await start({
        fetch: { propagateTraceHeaderCorsUrls: allowedOrigins },
        xhr: { propagateTraceHeaderCorsUrls: allowedOrigins },
      });

      const extracted = propagation.extract(ROOT_CONTEXT, {
        traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
        tracestate: "vendor=state",
      });
      const parent = trace.getTracer("request-parent").startSpan("parent", {}, extracted);
      const [fetchRequest, xhrRequest] = await context.with(
        trace.setSpan(ROOT_CONTEXT, parent),
        () =>
          withBaggage(() =>
            Promise.all([
              fetchHeaders(CROSS_ORIGIN_HEADERS_URL),
              sendXhrForHeaders(CROSS_ORIGIN_HEADERS_URL),
            ]),
          ),
      );
      parent.end();

      expectW3cHeaders(fetchRequest);
      expectW3cHeaders(xhrRequest);
      const spans = await captured();
      expect(spans).toHaveLength(3);
      for (const headers of [fetchRequest, xhrRequest]) {
        const requestSpan = spans.find(
          (span) => span.spanContext().spanId === headers.traceparent?.split("-")[2],
        );
        expect(requestSpan?.parentSpanContext).toEqual(parent.spanContext());
        expect(headers.traceparent).toBe(
          `00-${parent.spanContext().traceId}-${requestSpan?.spanContext().spanId}-01`,
        );
        expect(headers.tracestate).toBe("vendor=state");
      }
      expect(context.active()).toBe(ROOT_CONTEXT);
      expect(propagation.getBaggage(context.active())).toBeUndefined();
    });

    it("does not inject headers into cross-origin requests outside the allowed list", async () => {
      await start({
        fetch: { propagateTraceHeaderCorsUrls: ["https://allowed.example.test"] },
        xhr: { propagateTraceHeaderCorsUrls: ["https://allowed.example.test"] },
      });

      const [fetchRequest, xhrRequest] = await withBaggage(() =>
        Promise.all([
          fetchHeaders(CROSS_ORIGIN_HEADERS_URL),
          sendXhrForHeaders(CROSS_ORIGIN_HEADERS_URL),
        ]),
      );

      expect(fetchRequest).toEqual({});
      expect(xhrRequest).toEqual({});
    });

    it("replaces the defaults with configured propagators", async () => {
      const customPropagator: TextMapPropagator = {
        fields: () => ["x-test-context"],
        inject: (_ctx, carrier, setter) => setter.set(carrier, "x-test-context", "configured"),
        extract: (ctx) => ctx,
      };
      const allowedOrigins = [/^http:\/\/127\.0\.0\.1:\d+\//];
      await start(
        {
          fetch: { propagateTraceHeaderCorsUrls: allowedOrigins },
          xhr: { propagateTraceHeaderCorsUrls: allowedOrigins },
        },
        { propagators: [customPropagator] },
      );

      const [fetchRequest, xhrRequest] = await Promise.all([
        fetchHeaders(CROSS_ORIGIN_HEADERS_URL),
        sendXhrForHeaders(CROSS_ORIGIN_HEADERS_URL),
      ]);

      expect(fetchRequest).toEqual({ custom: "configured" });
      expect(xhrRequest).toEqual({ custom: "configured" });
    });

    it("disables propagation when configured with an empty propagator list", async () => {
      const allowedOrigins = [/^http:\/\/127\.0\.0\.1:\d+\//];
      await start(
        {
          fetch: { propagateTraceHeaderCorsUrls: allowedOrigins },
          xhr: { propagateTraceHeaderCorsUrls: allowedOrigins },
        },
        { propagators: [] },
      );

      const [fetchRequest, xhrRequest] = await withBaggage(() =>
        Promise.all([
          fetchHeaders(CROSS_ORIGIN_HEADERS_URL),
          sendXhrForHeaders(CROSS_ORIGIN_HEADERS_URL),
        ]),
      );

      expect(fetchRequest).toEqual({});
      expect(xhrRequest).toEqual({});
    });
  });

  describe("upstream settings reach the instrumentation", () => {
    it("applies a caller sanitizeUrl to the captured span", async () => {
      await start({
        fetch: { enabled: true, sanitizeUrl: () => "https://sanitized.example.test/" },
      });

      await request(`${APPLICATION_URL}?token=secret`);

      expect(urlsOf(await captured())).toEqual(["https://sanitized.example.test/"]);
    });

    it("invokes a caller requestHook and applyCustomAttributesOnSpan", async () => {
      const seen: string[] = [];
      await start({
        fetch: {
          enabled: true,
          requestHook: (span) => {
            seen.push("requestHook");
            span.setAttribute("test.request_hook", true);
          },
          applyCustomAttributesOnSpan: (span) => {
            seen.push("applyCustomAttributesOnSpan");
            span.setAttribute("test.custom_attributes", true);
          },
        },
      });

      await request(APPLICATION_URL);

      const spans = await captured();
      expect(seen).toEqual(["requestHook", "applyCustomAttributesOnSpan"]);
      expect(spans[0]?.attributes["test.request_hook"]).toBe(true);
      expect(spans[0]?.attributes["test.custom_attributes"]).toBe(true);
    });

    it("honours a caller ignoreUrls entry", async () => {
      await start({ fetch: { enabled: true, ignoreUrls: [APPLICATION_URL] } });

      await request(APPLICATION_URL);

      expect(await captured()).toEqual([]);
    });
  });
});
