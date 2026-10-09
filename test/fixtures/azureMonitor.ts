// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert, expect, onTestFinished, vi } from "vitest";
import type { SenderOptions } from "../../src/exporter/sender.js";
import type { AzureMonitorEnvelope } from "../../src/exporter/telemetryModels.js";

export const TEST_INSTRUMENTATION_KEY = "00000000-0000-0000-0000-000000000000";

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${path}: expected an object`,
  );
}

function assertMap(value: unknown, type: "string" | "number", path: string) {
  assertObject(value, path);
  for (const [key, entry] of Object.entries(value)) {
    assert(typeof entry === type, `${path}.${key}: expected ${type}`);
    if (type === "number")
      assert(Number.isFinite(entry), `${path}.${key}: expected a finite number`);
  }
}

function assertOptionalStrings(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (data[key] !== undefined) expect(data[key], `baseData.${key}`).toEqual(expect.any(String));
  }
}

function assertDuration(value: unknown) {
  expect(value, "baseData.duration").toMatch(
    /^(?:\d+\.)?(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{7}$/,
  );
}

/**
 * Validate the distro's telemetryModels.ts wire contract, including name/baseType
 * pairing and variant fields. This is not a complete Azure service schema validator.
 */
export function assertAzureMonitorEnvelope(value: unknown): asserts value is AzureMonitorEnvelope {
  assertObject(value, "envelope");
  expect(value).toMatchObject({
    name: expect.any(String),
    iKey: expect.any(String),
    ver: 1,
    sampleRate: 100,
  });
  assert(
    typeof value.time === "string" && Number.isFinite(Date.parse(value.time)),
    "envelope.time: expected an ISO timestamp",
  );
  expect(new Date(value.time).toISOString()).toBe(value.time);
  assertMap(value.tags, "string", "envelope.tags");
  assertObject(value.data, "envelope.data");
  const { baseType, baseData } = value.data;
  assertObject(baseData, "envelope.data.baseData");
  expect(baseData.ver, "baseData.ver").toBe(2);
  if (baseData.properties !== undefined)
    assertMap(baseData.properties, "string", "baseData.properties");
  if (baseData.measurements !== undefined)
    assertMap(baseData.measurements, "number", "baseData.measurements");

  let suffix: string;
  switch (baseType) {
    case "RequestData":
    case "RemoteDependencyData":
      expect(baseData).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        success: expect.any(Boolean),
      });
      assertDuration(baseData.duration);
      if (baseType === "RequestData") {
        suffix = "Request";
        expect(baseData.responseCode).toEqual(expect.any(String));
        assertOptionalStrings(baseData, ["url"]);
      } else {
        suffix = "RemoteDependency";
        expect(baseData).toMatchObject({
          resultCode: expect.any(String),
          type: expect.any(String),
        });
        assertOptionalStrings(baseData, ["data", "target"]);
      }
      break;
    case "MessageData":
      suffix = "Message";
      expect(baseData.message).toEqual(expect.any(String));
      break;
    case "ExceptionData":
      suffix = "Exception";
      assert(Array.isArray(baseData.exceptions), "baseData.exceptions: expected an array");
      for (const exception of baseData.exceptions) {
        assertObject(exception, "baseData.exceptions[]");
        expect(exception).toMatchObject({
          typeName: expect.any(String),
          message: expect.any(String),
          hasFullStack: expect.any(Boolean),
        });
        assertOptionalStrings(exception, ["stack"]);
      }
      break;
    case "PageViewData":
      suffix = "PageView";
      expect(baseData).toMatchObject({ id: expect.any(String), name: expect.any(String) });
      assertOptionalStrings(baseData, ["url", "referredUri"]);
      if (baseData.duration !== undefined) assertDuration(baseData.duration);
      break;
    case "PageviewPerformanceData":
      suffix = "PageviewPerformance";
      expect(baseData.name).toEqual(expect.any(String));
      assertOptionalStrings(baseData, ["url"]);
      for (const duration of [
        "duration",
        "perfTotal",
        "networkConnect",
        "sentRequest",
        "receivedResponse",
        "domProcessing",
      ]) {
        assertDuration(baseData[duration]);
      }
      break;
    case "EventData":
      suffix = "Event";
      expect(baseData.name).toEqual(expect.any(String));
      break;
    default:
      throw new Error(`Unsupported Azure Monitor baseType: ${String(baseType)}`);
  }
  if (
    (baseType === "MessageData" || baseType === "ExceptionData") &&
    baseData.severityLevel !== undefined
  ) {
    expect([0, 1, 2, 3, 4], "baseData.severityLevel").toContain(baseData.severityLevel);
  }
  expect(value.name, "envelope.name must match baseType").toBe(
    `Microsoft.ApplicationInsights.${suffix}`,
  );
}

export interface IngestionRequest {
  readonly transport: "fetch" | "beacon";
  readonly request: Request;
  readonly envelopes: readonly AzureMonitorEnvelope[];
}

interface MockIngestionOptions {
  /** Controls fetch completion after request validation, including failures and partial success. */
  readonly respond?: (request: IngestionRequest) => Response | Promise<Response>;
}

/**
 * Inject senderOptions into Sender. Both transports stay in memory and reject
 * unexpected URLs or malformed envelopes without delegating to browser networking.
 * For exporters, use connectionString and stub global fetch with this fixture's fetch.
 * Accepts one JSON envelope or a nonempty JSON array, plus gzip for fetch.
 * Beacons accept text/plain or application/json. Fetch requires application/json.
 * Await flush() to observe queued beacon validation. It also runs at test cleanup.
 * Await fetch calls before finishing the test. Custom responders own their pending work.
 *
 * @see https://github.com/microsoft/ApplicationInsights-JS/blob/main/common/Tests/Framework/src/AITestClass.ts
 */
export function createMockIngestionEndpoint(options: MockIngestionOptions = {}) {
  const ingestionEndpoint = "https://ingestion.example.test";
  const endpoint = `${ingestionEndpoint}/v2/track`;
  const requests: IngestionRequest[] = [];
  const beacons: Promise<PromiseSettledResult<IngestionRequest>>[] = [];

  async function ingest(request: Request, transport: IngestionRequest["transport"]) {
    expect(request.url, "ingestion URL").toBe(endpoint);
    expect(request.method, "ingestion method").toBe("POST");
    const contentType = request.headers.get("content-type")?.split(";")[0];
    const allowedContentTypes =
      transport === "beacon" ? ["text/plain", "application/json"] : ["application/json"];
    expect(allowedContentTypes, "ingestion content-type").toContain(contentType);
    const encoding = request.headers.get("content-encoding");
    assert(
      encoding === null || (encoding === "gzip" && transport === "fetch"),
      "Unsupported ingestion content-encoding",
    );
    // Buffer before decompressing: Firefox yields an empty result when piping `Request.body`.
    const text =
      encoding === "gzip"
        ? await new Response(
            new Blob([await request.arrayBuffer()])
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).text()
        : await request.text();
    const parsed: unknown = JSON.parse(text);
    const envelopes: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    assert(envelopes.length > 0, "Expected at least one telemetry envelope");
    const validated = envelopes.map((envelope) => {
      assertAzureMonitorEnvelope(envelope);
      return envelope;
    });
    const captured = { transport, request, envelopes: validated };
    requests.push(captured);
    return captured;
  }

  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const captured = await ingest(new Request(input, init), "fetch");
    if (options.respond) return options.respond(captured);
    return new Response(
      JSON.stringify({
        itemsReceived: captured.envelopes.length,
        itemsAccepted: captured.envelopes.length,
        errors: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const sendBeacon = vi.fn<typeof navigator.sendBeacon>((url, data) => {
    const pending = ingest(new Request(url, { method: "POST", body: data }), "beacon");
    beacons.push(
      pending.then(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      ),
    );
    return true;
  });
  async function flush(): Promise<void> {
    const results = await Promise.all(beacons.splice(0));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) throw new AggregateError(errors, "Beacon ingestion validation failed.");
  }
  onTestFinished(flush);
  return {
    connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${ingestionEndpoint}`,
    senderOptions: { endpoint, fetch, sendBeacon } satisfies SenderOptions,
    fetch,
    sendBeacon,
    requests,
    flush,
  };
}
