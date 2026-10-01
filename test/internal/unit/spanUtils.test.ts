// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import { TEST_INSTRUMENTATION_KEY as instrumentationKey } from "../../fixtures/azureMonitor.js";
import { createReadableSpan as makeSpan } from "../../fixtures/telemetry.js";

const spanContext = makeSpan().spanContext();
const parentSpanContext = makeSpan().parentSpanContext;

describe("Azure Monitor span envelope mapping", () => {
  it("maps an HTTP client span to RemoteDependencyData", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        status: { code: SpanStatusCode.ERROR },
        attributes: {
          "http.request.method": "GET",
          "http.response.status_code": 503,
          "server.address": "api.example.test",
          "server.port": 8443,
          "url.full": "https://api.example.test:8443/items/42?source=test",
          tenant: "north",
          retries: 2,
        },
      }),
      instrumentationKey,
    );

    expect(envelope).toEqual({
      name: "Microsoft.ApplicationInsights.RemoteDependency",
      time: "2025-01-01T00:00:00.000Z",
      iKey: instrumentationKey,
      sampleRate: 100,
      tags: {
        "ai.operation.id": spanContext.traceId,
        "ai.operation.parentId": parentSpanContext?.spanId,
        "ai.cloud.role": "browser-store",
      },
      ver: 1,
      data: {
        baseType: "RemoteDependencyData",
        baseData: {
          ver: 2,
          id: spanContext.spanId,
          name: "GET /items/42",
          duration: "00:00:01.2345670",
          success: false,
          resultCode: "503",
          type: "Http",
          data: "https://api.example.test:8443/items/42?source=test",
          target: "api.example.test:8443",
          properties: { tenant: "north" },
          measurements: { retries: 2 },
        },
      },
    });
  });

  it("maps a server span to RequestData", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        name: "GET /checkout",
        kind: SpanKind.SERVER,
        attributes: {
          "http.response.status_code": 204,
          "url.full": "https://shop.example.test/checkout",
        },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "RequestData",
      baseData: {
        ver: 2,
        id: spanContext.spanId,
        name: "GET /checkout",
        duration: "00:00:01.2345670",
        success: true,
        responseCode: "204",
        url: "https://shop.example.test/checkout",
        properties: undefined,
        measurements: undefined,
      },
    });
  });

  it("includes the day component for long span durations", () => {
    const envelope = spanToEnvelope(
      makeSpan({ duration: [90_061, 1_000_000] }),
      instrumentationKey,
    );

    expect(envelope.data.baseData.duration).toBe("1.01:01:01.0010000");
  });
});
