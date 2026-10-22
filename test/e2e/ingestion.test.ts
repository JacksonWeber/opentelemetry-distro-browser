// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, DiagLogLevel, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, expect, it, vi } from "vitest";
import type { useMicrosoftOpenTelemetry } from "../../src/index.js";
import { SDK_STATS_ENDPOINT } from "../fixtures/sdkStats.js";

// The public Application Insights resource that the Application Insights JavaScript SDK end-to-end
// tests send to. Browser connection strings are public by design.
const connectionString = "InstrumentationKey=b7170927-2d1c-44f1-acec-59f4e1751c11";

interface Envelope {
  name: string;
  data: { baseType: string; baseData: Record<string, unknown> };
}

interface IngestionResult {
  url: string;
  status: number;
  envelopes: Envelope[];
  body?: { itemsReceived: number; itemsAccepted: number; errors: unknown[] };
}

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    trace.disable();
    logs.disable();
    propagation.disable();
    context.disable();
    diag.disable();
    vi.restoreAllMocks();
  }
});

/** Shuts the instance down after the test even when an assertion or flush fails first. */
function track<T extends { shutdown(): Promise<void> }>(telemetry: T): T {
  cleanups.push(() => telemetry.shutdown().catch(() => {}));
  return telemetry;
}

/** Decodes the envelopes in an ingestion request body, which is gzipped unless the page unloads. */
async function readEnvelopes(init: RequestInit | undefined): Promise<Envelope[]> {
  const headers = new Headers(init?.headers);
  let body = new Response(init?.body).body ?? new ReadableStream();
  if (headers.get("content-encoding") === "gzip") {
    body = body.pipeThrough(new DecompressionStream("gzip"));
  }
  const text = await new Response(body).text();
  return text.trimStart().startsWith("[")
    ? (JSON.parse(text) as Envelope[])
    : text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Envelope);
}

/** Records every Azure Monitor ingestion request and response while passing them to the service. */
function captureIngestion(): IngestionResult[] {
  const results: IngestionResult[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  // Keep test traffic out of production SDK stats.
  const accepted = () =>
    new Response(JSON.stringify({ itemsReceived: 0, itemsAccepted: 0, errors: [] }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === SDK_STATS_ENDPOINT) return accepted();
    if (!url.endsWith("/v2/track")) return realFetch(input, init);
    const envelopes = await readEnvelopes(init);
    const response = await realFetch(input, init);
    const body = await response
      .clone()
      .json()
      .catch(() => undefined);
    results.push({ url, status: response.status, envelopes, body });
    return response;
  });
  return results;
}

/** Replaces the distro's console diagnostic logger, which it installs on first initialization. */
function captureDiagErrors(): unknown[] {
  const errors: unknown[] = [];
  const ignore = () => {};
  diag.setLogger(
    {
      error: (...args) => errors.push(args),
      warn: ignore,
      info: ignore,
      debug: ignore,
      verbose: ignore,
    },
    { logLevel: DiagLogLevel.ERROR, suppressOverrideMessage: true },
  );
  return errors;
}

type EnvelopeMatcher = [baseType: string, matches: (baseData: Record<string, unknown>) => boolean];

/** Requires every ingestion request to be fully accepted and each expected envelope to be sent. */
function expectAccepted(results: IngestionResult[], expected: EnvelopeMatcher[]): void {
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(result.status, result.url).toBe(200);
    expect(result.body?.errors, result.url).toEqual([]);
    expect(result.body?.itemsReceived, result.url).toBe(result.envelopes.length);
    expect(result.body?.itemsAccepted, result.url).toBe(result.envelopes.length);
  }
  const envelopes = results.flatMap(({ envelopes }) => envelopes);
  for (const [baseType, matches] of expected) {
    expect(
      envelopes.some(
        (envelope) =>
          envelope.data.baseType === baseType &&
          envelope.name === `Microsoft.ApplicationInsights.${baseType.slice(0, -4)}` &&
          matches(envelope.data.baseData),
      ),
      `${baseType} envelope`,
    ).toBe(true);
  }
}

const hasRunId = (runId: string) => (baseData: Record<string, unknown>) =>
  (baseData.properties as Record<string, unknown> | undefined)?.["test.run_id"] === runId;
const named = (name: string, runId?: string) => (baseData: Record<string, unknown>) =>
  baseData.name === name && (runId === undefined || hasRunId(runId)(baseData));
const pageView: EnvelopeMatcher = ["PageViewData", (baseData) => typeof baseData.name === "string"];

it("delivers page views, spans, logs and exceptions from the npm build to ingestion", async () => {
  const results = captureIngestion();
  const runId = crypto.randomUUID();
  const telemetry = track(
    await (
      await import(/* @vite-ignore */ new URL("../../dist/esm/index.js", import.meta.url).href)
    ).useMicrosoftOpenTelemetry({ azureMonitor: { connectionString } }),
  );
  const errors = captureDiagErrors();

  const span = trace.getTracer("e2e-ingestion").startSpan("e2e.span", {
    attributes: { "test.run_id": runId },
  });
  context.with(trace.setSpan(context.active(), span), () => {
    logs.getLogger("e2e-ingestion").emit({
      eventName: "e2e.event",
      body: runId,
      attributes: { "test.run_id": runId },
    });
  });
  span.recordException(new Error(`e2e exception ${runId}`));
  span.end();
  await telemetry.forceFlush();
  await telemetry.shutdown();

  expect(errors, "export diagnostics").toEqual([]);
  expectAccepted(results, [
    pageView,
    ["RemoteDependencyData", named("e2e.span", runId)],
    ["EventData", named("e2e.event", runId)],
    [
      "ExceptionData",
      (baseData) =>
        (baseData.exceptions as { message?: string }[] | undefined)?.some(
          ({ message }) => message === `e2e exception ${runId}`,
        ) === true,
    ],
  ]);
});

it("delivers telemetry from the minified CDN bundle to ingestion", async () => {
  const results = captureIngestion();
  const script = document.createElement("script");
  script.src = new URL(
    "../../dist/browser/opentelemetry-browser.iife.min.js",
    import.meta.url,
  ).href;
  const loaded = new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = reject;
  });
  cleanups.push(() => script.remove());
  document.head.append(script);
  await loaded;

  const { OpenTelemetry } = (
    globalThis as unknown as {
      Microsoft: {
        OpenTelemetry: {
          useMicrosoftOpenTelemetry: typeof useMicrosoftOpenTelemetry;
          trace: typeof trace;
        };
      };
    }
  ).Microsoft;
  const telemetry = track(
    await OpenTelemetry.useMicrosoftOpenTelemetry({ azureMonitor: { connectionString } }),
  );
  const errors = captureDiagErrors();
  const runId = crypto.randomUUID();
  OpenTelemetry.trace
    .getTracer("e2e-cdn")
    .startSpan("e2e.cdn.span", { attributes: { "test.run_id": runId } })
    .end();
  await telemetry.forceFlush();
  await telemetry.shutdown();

  expect(errors, "export diagnostics").toEqual([]);
  expectAccepted(results, [pageView, ["RemoteDependencyData", named("e2e.cdn.span", runId)]]);
});
