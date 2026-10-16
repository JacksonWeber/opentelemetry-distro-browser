// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { SDK_INFO } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ATTR_TELEMETRY_SDK_VERSION } from "@opentelemetry/semantic-conventions";
import { describe, expect, it } from "vitest";
import { spanToEnvelope, spanToEnvelopes } from "../../../src/exporter/spanUtils.js";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../../src/shared/constants.js";
import { AZURE_MONITOR_SAMPLE_RATE } from "../../../src/sampling.js";
import { TEST_INSTRUMENTATION_KEY as instrumentationKey } from "../../fixtures/azureMonitor.js";
import { createReadableSpan as makeSpan, createSpanContext } from "../../fixtures/telemetry.js";

const spanContext = createSpanContext();
const parentSpanContext = { ...spanContext, spanId: "0000000000000002" };

describe("Azure Monitor span envelope mapping", () => {
  it.each([
    SpanKind.CLIENT,
    SpanKind.SERVER,
    SpanKind.CONSUMER,
    SpanKind.INTERNAL,
    SpanKind.PRODUCER,
  ])("sets browser device tags and omits the default envelope version (kind=%i)", (kind) => {
    const envelope = spanToEnvelope(makeSpan({ kind }), instrumentationKey);

    expect(envelope.tags).toMatchObject({
      "ai.device.type": "Browser",
      "ai.device.id": "browser",
    });
    expect(envelope).not.toHaveProperty("ver");
    expect(envelope.data.baseData.ver).toBe(2);
  });

  it("maps resource OS attributes to the Application Insights client OS tag", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        resource: resourceFromAttributes({
          "user_agent.os.name": "Windows",
          "user_agent.os.version": "11",
        }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags["ai.device.osVersion"]).toBe("Windows11");
  });

  it("prefers a complete record OS over the resource OS", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        attributes: {
          "user_agent.os.name": "Linux",
          "user_agent.os.version": "6.8",
        },
        resource: resourceFromAttributes({
          "user_agent.os.name": "Windows",
          "user_agent.os.version": "11",
        }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags["ai.device.osVersion"]).toBe("Linux6.8");
    expect(envelope.data.baseData.properties).toBeUndefined();
  });

  it("does not combine incomplete record and resource OS values", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        attributes: { "user_agent.os.name": "Linux" },
        resource: resourceFromAttributes({ "user_agent.os.version": "11" }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags).not.toHaveProperty("ai.device.osVersion");
    expect(envelope.data.baseData.properties).toEqual({ "user_agent.os.name": "Linux" });
  });

  it("maps resource service.version to the Application Insights application version tag", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        resource: resourceFromAttributes({
          "service.version": "synthetic-release-42",
          "custom.resource.marker": "not-exported-per-record",
        }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags["ai.application.ver"]).toBe("synthetic-release-42");
    expect(envelope.data.baseData.properties).toBeUndefined();
  });

  it("bounds the Application Insights application version tag", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        resource: resourceFromAttributes({ "service.version": "v".repeat(1_025) }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags["ai.application.ver"]).toBe("v".repeat(1_024));
  });

  it.each([SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CONSUMER, SpanKind.INTERNAL])(
    "promotes standard session IDs to tags without changing the source span (kind=%i)",
    (kind) => {
      const span = makeSpan({ kind, attributes: { "session.id": "session-1", custom: "value" } });
      const envelope = spanToEnvelope(span, instrumentationKey);
      expect(envelope.tags["ai.session.id"]).toBe("session-1");
      expect(envelope.tags).not.toHaveProperty("ai.session.isFirst");
      expect(envelope.data.baseData.properties).toEqual({ custom: "value" });
      expect(span.attributes["session.id"]).toBe("session-1");
    },
  );

  it.each([undefined, "", 0, false, ["session-1"]])(
    "does not create session tags for absent or invalid IDs (%j)",
    (id) => {
      const envelope = spanToEnvelope(
        makeSpan({ attributes: { "session.id": id } }),
        instrumentationKey,
      );
      expect(envelope.tags).not.toHaveProperty("ai.session.id");
      if (id === 0) expect(envelope.data.baseData.measurements?.["session.id"]).toBe(0);
      else if (id !== undefined)
        expect(envelope.data.baseData.properties?.["session.id"]).toBeDefined();
    },
  );

  it.each([undefined, "", 0, false, ["invalid"], "record-session"])(
    "prefers a valid record session ID over resource context (record=%j)",
    (id) => {
      const span = makeSpan({
        attributes: { "session.id": id },
        resource: resourceFromAttributes({ "session.id": "resource-session" }),
      });
      const envelope = spanToEnvelope(span, instrumentationKey);
      expect(envelope.tags["ai.session.id"]).toBe(
        id === "record-session" ? id : "resource-session",
      );
      expect(span.attributes["session.id"]).toEqual(id);
      expect(span.resource.attributes["session.id"]).toBe("resource-session");
    },
  );

  it.each([undefined, "", 0, false, ["invalid"]])(
    "omits invalid resource session tags (resource=%j)",
    (id) => {
      const envelope = spanToEnvelope(
        makeSpan({ resource: resourceFromAttributes({ "session.id": id }) }),
        instrumentationKey,
      );
      expect(envelope.tags).not.toHaveProperty("ai.session.id");
    },
  );

  it("maps an HTTP client span to RemoteDependencyData", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        spanContext: () => spanContext,
        parentSpanContext,
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
      sampleRate: undefined,
      tags: {
        "ai.internal.sdkVersion": `browser:otel${SDK_INFO[ATTR_TELEMETRY_SDK_VERSION]}:mot${OPENTELEMETRY_BROWSER_VERSION}`,
        "ai.device.type": "Browser",
        "ai.device.id": "browser",
        "ai.operation.id": spanContext.traceId,
        "ai.operation.parentId": parentSpanContext.spanId,
        "ai.cloud.role": "browser-store",
      },
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

  it("maps parented internal spans to InProc dependencies", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        kind: SpanKind.INTERNAL,
        name: "checkout.validate-cart",
        parentSpanContext,
      }),
      instrumentationKey,
    );

    expect(envelope.data.baseData).toMatchObject({ type: "InProc" });
  });

  it("leaves root internal spans as generic dependencies", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        kind: SpanKind.INTERNAL,
        name: "checkout.validate-cart",
        parentSpanContext: undefined,
      }),
      instrumentationKey,
    );

    expect(envelope.data.baseData).toMatchObject({ type: "Dependency" });
  });

  it("classifies parented internal HTTP spans as HTTP dependencies", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        kind: SpanKind.INTERNAL,
        parentSpanContext,
        attributes: {
          "http.request.method": "GET",
          "url.full": "https://example.test/items",
        },
      }),
      instrumentationKey,
    );

    expect(envelope.data.baseData).toMatchObject({ type: "Http" });
  });

  it("does not split surrogate pairs in span and span-event names", () => {
    const envelopes = spanToEnvelopes(
      makeSpan({
        name: `${"s".repeat(1_023)}\u{1f600}`,
        events: [
          {
            name: `${"e".repeat(32_767)}\u{1f600}`,
            time: [1_735_689_602, 0],
            droppedAttributesCount: 0,
          },
        ],
      }),
      instrumentationKey,
    );

    expect(envelopes[0].data.baseData).toMatchObject({ name: "s".repeat(1_023) });
    expect(envelopes[1].data.baseData).toMatchObject({ message: "e".repeat(32_767) });
  });

  it("maps span events to envelopes parented to the span", () => {
    const envelopes = spanToEnvelopes(
      makeSpan({
        spanContext: () => spanContext,
        attributes: { "session.id": "session-1" },
        events: [
          {
            name: "exception",
            time: [1_735_689_601, 0],
            attributes: {
              "exception.type": "Error",
              "exception.message": "boom",
              "exception.stacktrace":
                "Error: boom\n    at checkout (https://example.test/app.js:1:2)",
            },
            droppedAttributesCount: 0,
          },
          {
            name: "checkout.step",
            time: [1_735_689_602, 0],
            attributes: { phase: "validate", attempt: 2 },
            droppedAttributesCount: 0,
          },
        ],
      }),
      instrumentationKey,
    );

    expect(envelopes).toHaveLength(3);
    expect(envelopes[1]).toMatchObject({
      name: "Microsoft.ApplicationInsights.Exception",
      tags: {
        "ai.operation.id": spanContext.traceId,
        "ai.operation.parentId": spanContext.spanId,
        "ai.session.id": "session-1",
      },
      data: {
        baseType: "ExceptionData",
        baseData: { exceptions: [{ typeName: "Error", message: "boom" }] },
      },
    });
    expect(envelopes[2]).toMatchObject({
      name: "Microsoft.ApplicationInsights.Message",
      tags: {
        "ai.operation.id": spanContext.traceId,
        "ai.operation.parentId": spanContext.spanId,
        "ai.session.id": "session-1",
      },
      data: {
        baseType: "MessageData",
        baseData: {
          message: "checkout.step",
          properties: { phase: "validate" },
          measurements: { attempt: 2 },
        },
      },
    });
  });

  it("preserves span event OS attributes that are not promoted to tags", () => {
    const envelopes = spanToEnvelopes(
      makeSpan({
        events: [
          {
            name: "checkout.step",
            time: [1_735_689_602, 0],
            attributes: {
              "user_agent.os.name": "Linux",
              "user_agent.os.version": "6.8",
            },
            droppedAttributesCount: 0,
          },
        ],
      }),
      instrumentationKey,
    );

    expect(envelopes[1].tags).not.toHaveProperty("ai.device.osVersion");
    expect(envelopes[1].data.baseData.properties).toEqual({
      "user_agent.os.name": "Linux",
      "user_agent.os.version": "6.8",
    });
  });

  it("prefers a span event session ID over the span session ID", () => {
    const envelopes = spanToEnvelopes(
      makeSpan({
        attributes: { "session.id": "span-session" },
        events: [
          {
            name: "checkout.step",
            time: [1_735_689_602, 0],
            attributes: { "session.id": "event-session" },
            droppedAttributesCount: 0,
          },
        ],
      }),
      instrumentationKey,
    );

    expect(envelopes[1].tags["ai.session.id"]).toBe("event-session");
    expect(envelopes[1].data.baseData.properties).toBeUndefined();
  });

  it("keeps the span session ID when the span event session ID is empty", () => {
    const envelopes = spanToEnvelopes(
      makeSpan({
        attributes: { "session.id": "span-session" },
        events: [
          {
            name: "checkout.step",
            time: [1_735_689_602, 0],
            attributes: { "session.id": "" },
            droppedAttributesCount: 0,
          },
        ],
      }),
      instrumentationKey,
    );

    expect(envelopes[1].tags["ai.session.id"]).toBe("span-session");
    expect(envelopes[1].data.baseData.properties).toBeUndefined();
  });

  it("omits the session tag when both span event and span session IDs are empty", () => {
    const envelopes = spanToEnvelopes(
      makeSpan({
        attributes: { "session.id": "" },
        events: [
          {
            name: "checkout.step",
            time: [1_735_689_602, 0],
            attributes: { "session.id": "" },
            droppedAttributesCount: 0,
          },
        ],
      }),
      instrumentationKey,
    );

    expect(envelopes[1].tags).not.toHaveProperty("ai.session.id");
    expect(envelopes[1].data.baseData.properties).toBeUndefined();
  });

  it.each(["user.id", "enduser.id"])(
    "maps %s to authenticated user context and promotes user tags",
    (attribute) => {
      const envelope = spanToEnvelope(
        makeSpan({
          attributes: {
            [attribute]: "signed-in-user",
            "enduser.pseudo.id": "anonymous-user",
            "user.account.id": "tenant-42",
          },
        }),
        instrumentationKey,
      );

      expect(envelope.tags).toMatchObject({
        "ai.user.id": "anonymous-user",
        "ai.user.authUserId": "signed-in-user",
        "ai.user.accountId": "tenant-42",
      });
      expect(envelope.data.baseData.properties).toBeUndefined();
    },
  );

  it("prefers application enduser.id over managed user.id", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        attributes: {
          "user.id": "managed-user",
          "enduser.id": "application-user",
        },
      }),
      instrumentationKey,
    );

    expect(envelope.tags["ai.user.authUserId"]).toBe("application-user");
    expect(envelope.data.baseData.properties).toBeUndefined();
  });

  it("uses the same authenticated user precedence for resource attributes", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        resource: resourceFromAttributes({
          "user.id": "managed-user",
          "enduser.id": "application-user",
        }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags["ai.user.authUserId"]).toBe("application-user");
  });

  it("omits invalid user tag values", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        attributes: {
          "enduser.pseudo.id": "",
          "user.id": null,
          "user.account.id": 42,
        } as unknown as ReadableSpan["attributes"],
      }),
      instrumentationKey,
    );

    expect(envelope.tags).not.toHaveProperty("ai.user.id");
    expect(envelope.tags).not.toHaveProperty("ai.user.authUserId");
    expect(envelope.tags).not.toHaveProperty("ai.user.accountId");
  });

  it("falls back to valid resource user context when signal values are invalid", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        attributes: {
          "enduser.pseudo.id": "",
          "enduser.id": null,
          "user.account.id": 42,
        } as unknown as ReadableSpan["attributes"],
        resource: resourceFromAttributes({
          "enduser.pseudo.id": "resource-anonymous",
          "enduser.id": "resource-user",
          "user.account.id": "resource-account",
        }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags).toMatchObject({
      "ai.user.id": "resource-anonymous",
      "ai.user.authUserId": "resource-user",
      "ai.user.accountId": "resource-account",
    });
  });

  it("maps a server span to RequestData", () => {
    const envelope = spanToEnvelope(
      makeSpan({
        spanContext: () => spanContext,
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

  it("omits the parent tag for a root span", () => {
    const envelope = spanToEnvelope(
      makeSpan({ spanContext: () => spanContext, parentSpanContext: undefined }),
      instrumentationKey,
    );

    expect(envelope.tags["ai.operation.id"]).toBe(spanContext.traceId);
    expect(envelope.tags).not.toHaveProperty("ai.operation.parentId");
  });

  it("includes the day component for long span durations", () => {
    const envelope = spanToEnvelope(
      makeSpan({ duration: [90_061, 1_000_000] }),
      instrumentationKey,
    );

    expect(envelope.data.baseData.duration).toBe("1.01:01:01.0010000");
  });

  it.each([0.000001, 25, 99.5])(
    "maps the reserved sample rate %s without exporting it as a custom measurement",
    (sampleRate) => {
      const envelope = spanToEnvelope(
        makeSpan({ attributes: { [AZURE_MONITOR_SAMPLE_RATE]: sampleRate } }),
        instrumentationKey,
      );

      expect(envelope.sampleRate).toBe(sampleRate);
      expect(envelope.data.baseData.measurements).toBeUndefined();
    },
  );

  it.each([undefined, 0, 100, -1, 101, NaN, Infinity, "25"])(
    "omits full sampling from standalone span conversion with sample rate %s",
    (sampleRate) => {
      const attributes =
        sampleRate === undefined ? {} : { [AZURE_MONITOR_SAMPLE_RATE]: sampleRate };
      expect(
        JSON.parse(JSON.stringify(spanToEnvelope(makeSpan({ attributes }), instrumentationKey))),
      ).not.toHaveProperty("sampleRate");
    },
  );
});
