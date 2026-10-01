// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind } from "@opentelemetry/api";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { logToEnvelope } from "../../../../src/exporter/logUtils.js";
import { Sender } from "../../../../src/exporter/sender.js";
import { spanToEnvelope } from "../../../../src/exporter/spanUtils.js";
import {
  assertAzureMonitorEnvelope,
  createMockIngestionEndpoint,
  TEST_INSTRUMENTATION_KEY,
} from "../../../fixtures/azureMonitor.js";
import { createReadableLogRecord, createReadableSpan } from "../../../fixtures/telemetry.js";

const message = logToEnvelope(
  createReadableLogRecord({ body: "checkout" }),
  TEST_INSTRUMENTATION_KEY,
);
const dependency = spanToEnvelope(createReadableSpan(), TEST_INSTRUMENTATION_KEY);
const request = spanToEnvelope(
  createReadableSpan({ kind: SpanKind.SERVER }),
  TEST_INSTRUMENTATION_KEY,
);
const exception = logToEnvelope(
  createReadableLogRecord({ eventName: "exception" }),
  TEST_INSTRUMENTATION_KEY,
);
const pageView = logToEnvelope(
  createReadableLogRecord({ eventName: "browser.navigation" }),
  TEST_INSTRUMENTATION_KEY,
);
const event = logToEnvelope(
  createReadableLogRecord({ eventName: "checkout.started" }),
  TEST_INSTRUMENTATION_KEY,
);
const envelopes = [message, dependency, request, exception, pageView, event];

afterEach(() => vi.restoreAllMocks());

describe("Azure Monitor envelope assertions", () => {
  it.each(envelopes.map((envelope) => [envelope.data.baseType, envelope] as const))(
    "accepts mapped %s envelopes",
    (_name, envelope) => assertAzureMonitorEnvelope(envelope),
  );

  it("accepts optional fields emitted by the mapper", () => {
    assertAzureMonitorEnvelope(
      logToEnvelope(
        createReadableLogRecord({
          eventName: "exception",
          severityNumber: 24,
          attributes: {
            "exception.stacktrace": "Error\n at checkout",
            tenant: "north",
            count: 2,
          },
        }),
        TEST_INSTRUMENTATION_KEY,
      ),
    );
    assertAzureMonitorEnvelope(
      logToEnvelope(
        createReadableLogRecord({
          eventName: "browser.navigation",
          attributes: { "url.full": "https://example.test", "browser.navigation.duration": 1 },
        }),
        TEST_INSTRUMENTATION_KEY,
      ),
    );
    assertAzureMonitorEnvelope(
      spanToEnvelope(
        createReadableSpan({
          attributes: {
            "http.request.method": "GET",
            "url.full": "https://example.test/items",
            "server.address": "example.test",
          },
        }),
        TEST_INSTRUMENTATION_KEY,
      ),
    );
  });

  it.each([
    ["null", null],
    ["array", []],
    ["instrumentation key", { ...message, iKey: undefined }],
    ["envelope version", { ...message, ver: 2 }],
    ["sample rate", { ...message, sampleRate: 50 }],
    ["timestamp", { ...message, time: "not a date" }],
    ["non-ISO timestamp", { ...message, time: "2025-01-01" }],
    ["tags", { ...message, tags: { role: 42 } }],
    ["missing data", { ...message, data: undefined }],
    ["missing base data", { ...message, data: { baseType: "MessageData" } }],
    ["unknown base type", { ...message, data: { baseType: "MetricData", baseData: { ver: 2 } } }],
    ["name pairing", { ...message, name: request.name }],
  ])("rejects invalid %s", (_name, value) => {
    expect(() => assertAzureMonitorEnvelope(value)).toThrow();
  });

  it.each([
    ["data version", message, { ver: 1 }],
    ["properties", message, { properties: { count: 1 } }],
    ["measurements", message, { measurements: { count: "1" } }],
    ["non-finite measurement", message, { measurements: { count: Infinity } }],
    ["message", message, { message: 42 }],
    ["severity", message, { severityLevel: 5 }],
    ["exceptions", exception, { exceptions: {} }],
    ["exception entry", exception, { exceptions: [{ typeName: "Error", message: "failure" }] }],
    [
      "exception stack",
      exception,
      { exceptions: [{ typeName: "Error", message: "failure", hasFullStack: true, stack: 1 }] },
    ],
    ["request status", request, { responseCode: 200 }],
    ["request success", request, { success: "true" }],
    ["span ID", request, { id: undefined }],
    ["duration", request, { duration: "00:60:00.0000000" }],
    ["dependency type", dependency, { type: undefined }],
    ["dependency result", dependency, { resultCode: 200 }],
    ["dependency target", dependency, { target: 123 }],
    ["page duration", pageView, { duration: 1 }],
    ["page URL", pageView, { url: false }],
    ["event name", event, { name: null }],
  ])("rejects invalid %s fields", (_name, envelope, fields) => {
    expect(() =>
      assertAzureMonitorEnvelope({
        ...envelope,
        data: { ...envelope.data, baseData: { ...envelope.data.baseData, ...fields } },
      }),
    ).toThrow();
  });
});

describe("in-memory Azure Monitor endpoint", () => {
  it("keeps request validation when scripting partial success and retry responses", async () => {
    const partial = {
      itemsReceived: 2,
      itemsAccepted: 1,
      errors: [{ index: 1, statusCode: 429, message: "Throttled" }],
    };
    const respond = vi
      .fn()
      .mockReturnValueOnce(new Response(JSON.stringify(partial), { status: 206 }))
      .mockReturnValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "2" } }));
    const ingestion = createMockIngestionEndpoint({ respond });
    const sender = new Sender(ingestion.senderOptions);
    const body = new TextEncoder().encode(JSON.stringify([message, dependency]));

    await expect(sender.send({ body, contentType: "application/json" })).resolves.toMatchObject({
      statusCode: 206,
      result: JSON.stringify(partial),
    });
    await expect(sender.send({ body, contentType: "application/json" })).resolves.toMatchObject({
      statusCode: 503,
      retryAfterMs: 2000,
    });
    expect(ingestion.requests).toHaveLength(2);
    expect(respond.mock.calls[0][0]).toBe(ingestion.requests[0]);
    await expect(
      sender.send({
        body: new TextEncoder().encode("{}"),
        contentType: "application/json",
      }),
    ).rejects.toThrow();
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("captures a request before controlled response completion", async () => {
    let complete: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    const ingestion = createMockIngestionEndpoint({ respond: () => response });
    const sender = new Sender(ingestion.senderOptions);
    const completed = vi.fn();
    const send = sender
      .send({
        body: new TextEncoder().encode(JSON.stringify(message)),
        contentType: "application/json",
      })
      .then(completed);
    try {
      await vi.waitFor(() => expect(ingestion.requests).toHaveLength(1));
      expect(completed).not.toHaveBeenCalled();
    } finally {
      assert(complete);
      complete(new Response(null, { status: 202 }));
      await send;
    }
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 202 }));
  });

  it("captures validated attempts when the responder rejects", async () => {
    const failure = new TypeError("offline");
    const ingestion = createMockIngestionEndpoint({
      respond: async () => {
        throw failure;
      },
    });
    const sender = new Sender(ingestion.senderOptions);
    await expect(
      sender.send({
        body: new TextEncoder().encode(JSON.stringify(message)),
        contentType: "application/json",
      }),
    ).rejects.toBe(failure);
    expect(ingestion.requests).toHaveLength(1);
  });

  it.each([false, true])(
    "captures Sender envelopes without networking, unloading=%s",
    async (unloading) => {
      const networkFetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network fetch"));
      const networkBeacon = vi.spyOn(navigator, "sendBeacon").mockImplementation(() => {
        throw new Error("Unexpected network beacon");
      });
      const ingestion = createMockIngestionEndpoint();
      const sender = new Sender(ingestion.senderOptions);
      const result = await sender.send({
        body: new TextEncoder().encode(JSON.stringify(envelopes)),
        contentType: "application/json",
        unloading,
      });

      expect(result).toEqual({
        transport: "fetch",
        statusCode: 200,
        result: '{"itemsReceived":6,"itemsAccepted":6,"errors":[]}',
      });
      expect(ingestion.requests).toHaveLength(1);
      expect(ingestion.requests[0].envelopes).toEqual(JSON.parse(JSON.stringify(envelopes)));
      expect(ingestion.requests[0].request.keepalive).toBe(unloading);
      expect(ingestion.requests[0].request.headers.get("content-encoding")).toBe(
        unloading ? null : "gzip",
      );
      expect(networkFetch).not.toHaveBeenCalled();
      expect(networkBeacon).not.toHaveBeenCalled();
    },
  );

  it("captures and validates the beacon fallback without networking", async () => {
    const networkBeacon = vi.spyOn(navigator, "sendBeacon").mockImplementation(() => {
      throw new Error("Unexpected network beacon");
    });
    const ingestion = createMockIngestionEndpoint();
    ingestion.fetch.mockRejectedValueOnce(new TypeError("offline"));
    const sender = new Sender(ingestion.senderOptions);
    await expect(
      sender.send({
        body: new TextEncoder().encode(JSON.stringify(message)),
        contentType: "application/json",
        unloading: true,
      }),
    ).resolves.toEqual({ transport: "beacon" });
    await ingestion.flush();
    expect(ingestion.requests).toHaveLength(1);
    expect(ingestion.requests[0]).toMatchObject({
      transport: "beacon",
      envelopes: [JSON.parse(JSON.stringify(message))],
    });
    expect(networkBeacon).not.toHaveBeenCalled();
  });

  it.each(["{}", "null", "[]", "not json", JSON.stringify([message, {}])])(
    "rejects invalid request body %s atomically",
    async (body) => {
      const ingestion = createMockIngestionEndpoint();
      await expect(
        ingestion.fetch(ingestion.senderOptions.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      ).rejects.toThrow();
      expect(ingestion.requests).toEqual([]);
    },
  );

  it.each([
    [
      "wrong URL",
      "https://other.example.test/v2.1/track",
      { method: "POST", headers: { "content-type": "application/json" } },
    ],
    ["wrong method", undefined, { method: "PUT", headers: { "content-type": "application/json" } }],
    ["wrong content type", undefined, { method: "POST", headers: { "content-type": "text/html" } }],
    [
      "wrong encoding",
      undefined,
      { method: "POST", headers: { "content-type": "application/json", "content-encoding": "br" } },
    ],
  ] as const)("rejects %s", async (_name, url, init) => {
    const ingestion = createMockIngestionEndpoint();
    await expect(
      ingestion.fetch(url ?? ingestion.senderOptions.endpoint, {
        ...init,
        body: JSON.stringify(message),
      }),
    ).rejects.toThrow();
    expect(ingestion.requests).toEqual([]);
  });

  it("surfaces queued beacon validation failures and drains them on flush", async () => {
    const ingestion = createMockIngestionEndpoint();
    expect(
      ingestion.sendBeacon(
        ingestion.senderOptions.endpoint,
        new Blob(["{}"], { type: "text/plain" }),
      ),
    ).toBe(true);
    await expect(ingestion.flush()).rejects.toThrow("Beacon ingestion validation failed");
    await expect(ingestion.flush()).resolves.toBeUndefined();
    expect(ingestion.requests).toEqual([]);
  });

  it("keeps instances isolated and returns a fresh response per request", async () => {
    const first = createMockIngestionEndpoint();
    const second = createMockIngestionEndpoint();
    const request = new Request(first.senderOptions.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    const response = await first.fetch(request.clone());
    const another = await first.fetch(request.clone());
    expect(await response.json()).toEqual(await another.json());
    expect(first.requests).toHaveLength(2);
    expect(second.requests).toEqual([]);
  });
});
