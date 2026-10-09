// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it } from "vitest";
import { MAX_BEACON_BODY_SIZE } from "../../../src/exporter/constants.js";
import type { ExceptionData } from "../../../src/exporter/telemetryModels.js";
import { logToEnvelope, logToEnvelopes } from "../../../src/exporter/logUtils.js";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../../src/shared/constants.js";
import { AZURE_MONITOR_SAMPLE_RATE } from "../../../src/sampling.js";
import { TEST_INSTRUMENTATION_KEY as instrumentationKey } from "../../fixtures/azureMonitor.js";
import { createReadableLogRecord as makeLog, createSpanContext } from "../../fixtures/telemetry.js";

const spanContext = createSpanContext();

describe("Azure Monitor log envelope mapping", () => {
  it("maps the reserved sample rate without exporting it as a custom measurement", () => {
    const envelope = logToEnvelope(
      makeLog({ attributes: { [AZURE_MONITOR_SAMPLE_RATE]: 25 }, body: "sampled" }),
      instrumentationKey,
    );

    expect(envelope.sampleRate).toBe(25);
    expect(envelope.data.baseData.measurements).toBeUndefined();
  });

  it.each([undefined, 0])(
    "defaults standalone log conversion with sample rate %s to full sampling",
    (sampleRate) => {
      const attributes =
        sampleRate === undefined ? {} : { [AZURE_MONITOR_SAMPLE_RATE]: sampleRate };
      expect(
        logToEnvelope(makeLog({ attributes, body: "default" }), instrumentationKey).sampleRate,
      ).toBe(100);
    },
  );

  it.each([
    [undefined, "MessageData"],
    ["custom.event", "EventData"],
    ["exception", "ExceptionData"],
    ["browser.page_view", "PageViewData"],
    ["browser.navigation", "PageViewData"],
  ])("promotes standard session IDs for %s to %s tags", (eventName, baseType) => {
    const record = makeLog({
      eventName,
      attributes: { "session.id": "session-1", custom: "value" },
    });
    const envelope = logToEnvelope(record, instrumentationKey);
    expect(envelope.data.baseType).toBe(baseType);
    expect(envelope.tags["ai.session.id"]).toBe("session-1");
    expect(envelope.tags).not.toHaveProperty("ai.session.isFirst");
    expect(envelope.data.baseData.properties).toEqual({ custom: "value" });
    expect(record.attributes["session.id"]).toBe("session-1");
  });

  it.each([undefined, "", 0, false, ["session-1"]])(
    "does not create session tags for absent or invalid IDs (%j)",
    (id) => {
      const envelope = logToEnvelope(
        makeLog({ attributes: { "session.id": id } }),
        instrumentationKey,
      );
      expect(envelope.tags).not.toHaveProperty("ai.session.id");
      if (id === 0) expect(envelope.data.baseData.measurements?.["session.id"]).toBe(0);
      else if (id !== undefined)
        expect(envelope.data.baseData.properties?.["session.id"]).toBeDefined();
    },
  );

  it.each([
    ["browser.page_view", undefined],
    ["browser.page_view", ""],
    ["browser.page_view", "explicit-page-id"],
    ["browser.page_view", 0],
    ["browser.page_view", false],
    ["browser.navigation", undefined],
    ["browser.navigation", ""],
    ["browser.navigation", "explicit-page-id"],
    ["browser.navigation", 0],
    ["browser.navigation", false],
  ])("maps %s IDs using the AppInsights fallback (%j)", (eventName, id) => {
    const envelope = logToEnvelope(
      makeLog({
        eventName,
        spanContext,
        body: "Checkout",
        attributes: {
          "browser.page_view.id": id,
          "browser.page_view.name": "Other",
          "browser.page_view.duration": 125,
          "browser.navigation.duration": 250,
          "url.full": "https://example.test/checkout",
        },
      }),
      instrumentationKey,
    );
    expect(envelope.tags["ai.operation.id"]).toBe(spanContext.traceId);
    expect(envelope.tags["ai.operation.parentId"]).toBe(spanContext.spanId);
    expect(envelope.data).toMatchObject({
      baseType: "PageViewData",
      baseData: {
        id: id === undefined || id === "" ? spanContext.traceId : String(id),
        name: "Checkout",
        duration: "00:00:00.1250000",
      },
    });
    expect(envelope.data.baseData.properties?.["browser.page_view.id"]).toBeUndefined();
    expect(envelope.data.baseData.measurements?.["browser.page_view.id"]).toBeUndefined();
    expect(envelope.data.baseData).not.toHaveProperty("referredUri");
  });

  it.each([
    ["browser.page_view", 0],
    ["browser.page_view", false],
    ["browser.navigation", 0],
    ["browser.navigation", false],
  ])("preserves explicit %s IDs without a span context (%j)", (eventName, id) => {
    const envelope = logToEnvelope(
      makeLog({
        eventName,
        spanContext: undefined,
        attributes: { "browser.page_view.id": id },
      }),
      instrumentationKey,
    );
    expect(envelope.data.baseData).toMatchObject({ id: String(id) });
  });

  it.each([
    ["browser.page_view", undefined],
    ["browser.page_view", ""],
    ["browser.navigation", undefined],
    ["browser.navigation", ""],
  ])("generates a page-view ID without a span context for %s (%j)", (eventName, id) => {
    const envelope = logToEnvelope(
      makeLog({
        eventName,
        spanContext: undefined,
        attributes: { "browser.page_view.id": id },
      }),
      instrumentationKey,
    );

    expect(envelope.data.baseData).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(envelope.data.baseData).not.toMatchObject({ id: "00000000000000000000000000000000" });
    expect(envelope.data.baseData.properties).toBeUndefined();
  });

  it.each([undefined, "Legacy"])("preserves legacy navigation mapping with body %j", (body) => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "browser.navigation",
        body,
        attributes: {
          "browser.page_view.id": "other-id",
          "browser.page_view.name": "Other",
          "browser.page_view.duration": 250,
          "browser.page_view.referrer": "https://example.test/products",
          "browser.navigation.duration": 10,
        },
      }),
      instrumentationKey,
    );
    expect(envelope.data.baseData).toMatchObject({
      id: "other-id",
      name: body ?? "Other",
      duration: "00:00:00.2500000",
      referredUri: "https://example.test/products",
      properties: undefined,
      measurements: undefined,
    });
  });

  it("maps exception semantic attributes and severity", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        severityNumber: 18,
        body: "request failed",
        attributes: {
          "exception.type": "TypeError",
          "exception.message": "Cannot read properties of undefined",
          "exception.stacktrace":
            "TypeError: Cannot read properties of undefined\n" +
            "    at checkout (https://shop.example.test/app.js:42:7)\n" +
            "restoreCart@https://shop.example.test/cart.js:18:3",
          "url.full": "https://shop.example.test/checkout",
          handled: false,
        },
      }),
      instrumentationKey,
    );

    expect(envelope.name).toBe("Microsoft.ApplicationInsights.Exception");
    expect(envelope.tags["ai.internal.sdkVersion"]).toBe(`mot${OPENTELEMETRY_BROWSER_VERSION}`);
    expect(envelope.data).toEqual({
      baseType: "ExceptionData",
      baseData: {
        ver: 2,
        exceptions: [
          {
            typeName: "TypeError",
            message: "Cannot read properties of undefined",
            hasFullStack: true,
            stack:
              "TypeError: Cannot read properties of undefined\n" +
              "    at checkout (https://shop.example.test/app.js:42:7)\n" +
              "restoreCart@https://shop.example.test/cart.js:18:3",
            parsedStack: [
              {
                level: 0,
                method: "checkout",
                assembly: "at checkout (https://shop.example.test/app.js:42:7)",
                fileName: "https://shop.example.test/app.js",
                line: 42,
              },
              {
                level: 1,
                method: "restoreCart",
                assembly: "restoreCart@https://shop.example.test/cart.js:18:3",
                fileName: "https://shop.example.test/cart.js",
                line: 18,
              },
            ],
          },
        ],
        severityLevel: 3,
        properties: {
          "url.full": "https://shop.example.test/checkout",
          handled: "false",
        },
        measurements: undefined,
      },
    });
  });

  it("parses only stack frames and supports parentheses in filenames", () => {
    const stack =
      "user@example.com:404\n" +
      "    at render (https://example.test/app(foo).js:42:7)\n" +
      "    at hydrate bundle.js:21:5\n" +
      "restoreCart@app.js:18:3\n" +
      "loadCart@app.js:19\n" +
      "saveCart@https://example.test/cart.js:20\n" +
      "    at https://cdn.example.test/node_modules/@scope/pkg/index.js:22:4\n" +
      "https://cdn.example.test/node_modules/@scope/pkg/bare.js:23:5\n" +
      "bundle.js:23:5\n" +
      "src/relative.js:24:6\n" +
      "https://example.test/bootstrap.js:8:3\n" +
      "checkout (https://shop.test/app.js:25:7)\n" +
      `invalid.js:${"9".repeat(400)}:1\n` +
      "@https://example.test/anonymous.js:12:4\n" +
      "outer/inner@https://example.test/app.js:10:5\n" +
      "Foo.prototype.bar/<@app.js:11:6\n" +
      "node_modules/@scope/pkg/index.js:13:2";
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.message": "Request failed:404",
          "exception.stacktrace": stack,
        },
      }),
      instrumentationKey,
    );
    const exception = (envelope.data.baseData as ExceptionData).exceptions[0];

    expect(exception.parsedStack).toEqual([
      {
        level: 0,
        method: "render",
        assembly: "at render (https://example.test/app(foo).js:42:7)",
        fileName: "https://example.test/app(foo).js",
        line: 42,
      },
      {
        level: 1,
        method: "hydrate",
        assembly: "at hydrate bundle.js:21:5",
        fileName: "bundle.js",
        line: 21,
      },
      {
        level: 2,
        method: "restoreCart",
        assembly: "restoreCart@app.js:18:3",
        fileName: "app.js",
        line: 18,
      },
      {
        level: 3,
        method: "loadCart",
        assembly: "loadCart@app.js:19",
        fileName: "app.js",
        line: 19,
      },
      {
        level: 4,
        method: "saveCart",
        assembly: "saveCart@https://example.test/cart.js:20",
        fileName: "https://example.test/cart.js",
        line: 20,
      },
      {
        level: 5,
        method: "<no_method>",
        assembly: "at https://cdn.example.test/node_modules/@scope/pkg/index.js:22:4",
        fileName: "https://cdn.example.test/node_modules/@scope/pkg/index.js",
        line: 22,
      },
      {
        level: 6,
        method: "<no_method>",
        assembly: "https://cdn.example.test/node_modules/@scope/pkg/bare.js:23:5",
        fileName: "https://cdn.example.test/node_modules/@scope/pkg/bare.js",
        line: 23,
      },
      {
        level: 7,
        method: "<no_method>",
        assembly: "bundle.js:23:5",
        fileName: "bundle.js",
        line: 23,
      },
      {
        level: 8,
        method: "<no_method>",
        assembly: "src/relative.js:24:6",
        fileName: "src/relative.js",
        line: 24,
      },
      {
        level: 9,
        method: "<no_method>",
        assembly: "https://example.test/bootstrap.js:8:3",
        fileName: "https://example.test/bootstrap.js",
        line: 8,
      },
      {
        level: 10,
        method: "checkout",
        assembly: "checkout (https://shop.test/app.js:25:7)",
        fileName: "https://shop.test/app.js",
        line: 25,
      },
      {
        level: 11,
        method: "<no_method>",
        assembly: "@https://example.test/anonymous.js:12:4",
        fileName: "https://example.test/anonymous.js",
        line: 12,
      },
      {
        level: 12,
        method: "outer/inner",
        assembly: "outer/inner@https://example.test/app.js:10:5",
        fileName: "https://example.test/app.js",
        line: 10,
      },
      {
        level: 13,
        method: "Foo.prototype.bar/<",
        assembly: "Foo.prototype.bar/<@app.js:11:6",
        fileName: "app.js",
        line: 11,
      },
      {
        level: 14,
        method: "<no_method>",
        assembly: "node_modules/@scope/pkg/index.js:13:2",
        fileName: "node_modules/@scope/pkg/index.js",
        line: 13,
      },
    ]);
  });

  it("caps the full exception at 64 KB while preserving both ends of the parsed stack", () => {
    const stack = Array.from(
      { length: 700 },
      (_, index) =>
        `    at frame${index} (https://example.test/${"segment/".repeat(12)}file${index}.js:${index + 1}:1)`,
    ).join("\n");
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.message": "Large stack",
          "exception.stacktrace": stack,
          [AZURE_MONITOR_SAMPLE_RATE]: 0.000001,
        },
      }),
      instrumentationKey,
    );
    const exception = (envelope.data.baseData as ExceptionData).exceptions[0];
    const parsedStack = exception?.parsedStack;
    if (!parsedStack) throw new Error("Expected parsed stack frames");

    expect(new TextEncoder().encode(JSON.stringify([envelope])).byteLength).toBeLessThanOrEqual(
      MAX_BEACON_BODY_SIZE,
    );
    expect(envelope.sampleRate).toBe(0.000001);
    expect(exception.hasFullStack).toBe(false);
    expect(exception.stack?.length).toBeLessThan(stack.length);
    expect(parsedStack[0]?.assembly).toContain("frame0");
    expect(parsedStack.at(-1)?.assembly).toContain("frame699");
    expect(parsedStack.at(-1)?.level).toBe(699);
    expect(
      parsedStack.some(
        (frame, index) => index > 0 && frame.level > parsedStack[index - 1]!.level + 1,
      ),
    ).toBe(true);
    expect(parsedStack.length).toBeLessThan(700);
  });

  it("uses the full exception budget when a stack has no parsable frames", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.message": "m".repeat(32 * 1024),
          "exception.stacktrace": "s".repeat(32 * 1024),
        },
      }),
      instrumentationKey,
    );
    const exception = (envelope.data.baseData as ExceptionData).exceptions[0];
    const size = new TextEncoder().encode(JSON.stringify([envelope])).byteLength;

    expect(exception.parsedStack).toBeUndefined();
    expect(size).toBeGreaterThan(
      MAX_BEACON_BODY_SIZE - new TextEncoder().encode(',"parsedStack":[]').byteLength,
    );
    expect(size).toBeLessThanOrEqual(MAX_BEACON_BODY_SIZE);
  });

  it("limits parsed stack frame fields to Azure Monitor schema lengths", () => {
    const method = "m".repeat(1100);
    const fileName = `${"path/".repeat(220)}app.js`;
    const stack = `    at ${method} (${fileName}:42:7)`;
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.message": "Long frame",
          "exception.stacktrace": stack,
        },
      }),
      instrumentationKey,
    );
    const frame = (envelope.data.baseData as ExceptionData).exceptions[0]?.parsedStack?.[0];
    if (!frame) throw new Error("Expected a parsed stack frame");

    expect(frame.method.length).toBe(1024);
    expect(frame.assembly.length).toBe(1024);
    expect(frame.fileName.length).toBe(1024);
  });

  it("applies exception character limits before the aggregate byte limit", () => {
    const typeName = "T".repeat(1024);
    const message = "é".repeat(1024);
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.type": typeName,
          "exception.message": message,
        },
      }),
      instrumentationKey,
    );
    const exception = (envelope.data.baseData as ExceptionData).exceptions[0];

    expect(exception.typeName).toBe(typeName);
    expect(exception.message).toBe(message);
  });

  it("reserves raw stack space before allocating a multibyte message", () => {
    const stack = "Error\n    at checkout (https://example.test/app.js:42:7)";
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        attributes: {
          "exception.message": "😀".repeat(32 * 1024),
          "exception.stacktrace": stack,
        },
      }),
      instrumentationKey,
    );
    const exception = (envelope.data.baseData as ExceptionData).exceptions[0];

    expect(exception.stack).toBe(stack);
    expect(exception.hasFullStack).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(exception)).byteLength).toBeLessThanOrEqual(
      64 * 1024,
    );
  });

  it("maps an unnamed log to MessageData", () => {
    const envelope = logToEnvelope(
      makeLog({
        body: "cart restored",
        severityNumber: 10,
        attributes: { "url.full": "https://shop.example.test/cart", itemCount: 3 },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "MessageData",
      baseData: {
        ver: 2,
        message: "cart restored",
        severityLevel: 1,
        properties: { "url.full": "https://shop.example.test/cart" },
        measurements: { itemCount: 3 },
      },
    });
  });

  it("maps resource user attributes to Azure Monitor user tags", () => {
    const envelope = logToEnvelope(
      makeLog({
        resource: resourceFromAttributes({
          "service.name": "browser-store",
          "user.id": "signed-in-user",
          "enduser.pseudo.id": "anonymous-user",
        }),
      }),
      instrumentationKey,
    );

    expect(envelope.tags).toMatchObject({
      "ai.user.id": "anonymous-user",
      "ai.user.authUserId": "signed-in-user",
    });
  });

  it.each([undefined, "browser.page_view"])(
    "maps log user attributes to tags instead of properties for event %s",
    (eventName) => {
      const envelope = logToEnvelope(
        makeLog({
          eventName,
          attributes: {
            "enduser.pseudo.id": "anonymous-user",
            "user.id": "signed-in-user",
            "user.account.id": "tenant-42",
            "custom.attribute": "kept",
          },
        }),
        instrumentationKey,
      );

      expect(envelope.tags).toMatchObject({
        "ai.user.id": "anonymous-user",
        "ai.user.authUserId": "signed-in-user",
        "ai.user.accountId": "tenant-42",
      });
      const properties = (envelope.data?.baseData as { properties?: Record<string, string> })
        .properties;
      expect(properties).toMatchObject({ "custom.attribute": "kept" });
      for (const key of ["enduser.pseudo.id", "user.id", "user.account.id"]) {
        expect(properties).not.toHaveProperty(key);
      }
    },
  );

  it.each([undefined, null, ""])('maps an empty message body to "n/a": %s', (body) => {
    const envelope = logToEnvelope(makeLog({ body }), instrumentationKey);

    expect(envelope.data).toEqual({
      baseType: "MessageData",
      baseData: {
        ver: 2,
        message: "n/a",
        severityLevel: undefined,
        properties: undefined,
        measurements: undefined,
      },
    });
  });

  it.each([0, false])("preserves a valid falsy message body: %s", (body) => {
    const envelope = logToEnvelope(makeLog({ body }), instrumentationKey);

    expect(envelope.data.baseData).toMatchObject({ message: String(body) });
  });

  it.each(["browser.page_view.duration", "browser.navigation.duration"])(
    "maps browser.page_view to PageViewData using %s",
    (durationAttribute) => {
      const pageViewId = "0123456789abcdef0123456789abcdef";
      const envelope = logToEnvelope(
        makeLog({
          eventName: "browser.page_view",
          attributes: {
            "browser.page_view.id": pageViewId,
            "browser.page_view.name": "Cart",
            [durationAttribute]: 425.25,
            "browser.page_view.referrer": "https://shop.example.test/products",
            "url.full": "https://shop.example.test/cart",
            "browser.page_view.same_document": true,
          },
        }),
        instrumentationKey,
      );

      expect(envelope.data).toEqual({
        baseType: "PageViewData",
        baseData: {
          ver: 2,
          id: pageViewId,
          name: "Cart",
          url: "https://shop.example.test/cart",
          duration: "00:00:00.4252500",
          referredUri: "https://shop.example.test/products",
          properties: { "browser.page_view.same_document": "true" },
          measurements: undefined,
        },
      });
    },
  );

  it("maps page-view performance phases to a correlated companion envelope", () => {
    const envelopes = logToEnvelopes(
      makeLog({
        eventName: "browser.page_view",
        attributes: {
          "browser.page_view.name": "Cart",
          "browser.page_view.duration": 425.25,
          "browser.page_view.performance.total": 425.25,
          "browser.page_view.performance.network_connect": 25,
          "browser.page_view.performance.sent_request": 100.5,
          "browser.page_view.performance.received_response": 50.25,
          "browser.page_view.performance.dom_processing": 249.5,
          "url.full": "https://shop.example.test/cart",
          "browser.page_view.same_document": false,
          [AZURE_MONITOR_SAMPLE_RATE]: 25,
        },
      }),
      instrumentationKey,
    );

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]?.sampleRate).toBe(25);
    expect(envelopes[1]).toEqual({
      name: "Microsoft.ApplicationInsights.PageviewPerformance",
      time: envelopes[0]?.time,
      iKey: instrumentationKey,
      sampleRate: 25,
      tags: envelopes[0]?.tags,
      ver: 1,
      data: {
        baseType: "PageviewPerformanceData",
        baseData: {
          ver: 2,
          name: "Cart",
          url: "https://shop.example.test/cart",
          duration: "00:00:00.4252500",
          perfTotal: "00:00:00.4252500",
          networkConnect: "00:00:00.0250000",
          sentRequest: "00:00:00.1005000",
          receivedResponse: "00:00:00.0502500",
          domProcessing: "00:00:00.2495000",
          properties: { "browser.page_view.same_document": "false" },
          measurements: undefined,
        },
      },
    });
    expect(envelopes[1]?.tags["ai.operation.id"]).toBe(spanContext.traceId);
  });

  it("does not emit page-view performance when any phase is missing", () => {
    const envelopes = logToEnvelopes(
      makeLog({
        eventName: "browser.page_view",
        attributes: {
          "browser.page_view.performance.total": 425.25,
          "browser.page_view.performance.network_connect": 25,
          "browser.page_view.performance.sent_request": 100.5,
          "browser.page_view.performance.received_response": 50.25,
        },
      }),
      instrumentationKey,
    );

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.data.baseType).toBe("PageViewData");
  });

  it("does not emit page-view performance when the record maps to an exception", () => {
    const envelopes = logToEnvelopes(
      makeLog({
        eventName: "browser.page_view",
        attributes: {
          "exception.type": "NavigationError",
          "browser.page_view.performance.total": 425.25,
          "browser.page_view.performance.network_connect": 25,
          "browser.page_view.performance.sent_request": 100.5,
          "browser.page_view.performance.received_response": 50.25,
          "browser.page_view.performance.dom_processing": 249.5,
        },
      }),
      instrumentationKey,
    );

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.data.baseType).toBe("ExceptionData");
  });

  it("maps legacy browser.navigation to PageViewData", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "browser.navigation",
        spanContext,
        attributes: {
          "url.full": "https://shop.example.test/cart",
          "browser.navigation.duration": 425.25,
          "browser.navigation.same_document": true,
        },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "PageViewData",
      baseData: {
        ver: 2,
        id: spanContext.traceId,
        name: "https://shop.example.test/cart",
        url: "https://shop.example.test/cart",
        duration: "00:00:00.4252500",
        properties: { "browser.navigation.same_document": "true" },
        measurements: undefined,
      },
    });
  });

  it.each([
    ["browser.console", "MessageData", "Microsoft.ApplicationInsights.Message"],
    ["browser.navigation", "PageViewData", "Microsoft.ApplicationInsights.PageView"],
    ["browser.navigation_timing", "EventData", "Microsoft.ApplicationInsights.Event"],
    ["browser.resource_timing", "EventData", "Microsoft.ApplicationInsights.Event"],
    ["browser.user_action.click", "EventData", "Microsoft.ApplicationInsights.Event"],
    ["browser.web_vital", "EventData", "Microsoft.ApplicationInsights.Event"],
    ["exception", "ExceptionData", "Microsoft.ApplicationInsights.Exception"],
  ] as const)(
    "maps browser instrumentation event %s to %s",
    (eventName, baseType, envelopeName) => {
      const envelope = logToEnvelope(
        makeLog({
          eventName,
          body: "instrumentation payload",
          severityNumber: 13,
          attributes: {},
        }),
        instrumentationKey,
      );

      expect(envelope.name).toBe(envelopeName);
      expect(envelope.data.baseType).toBe(baseType);
    },
  );

  it("maps browser.console to MessageData without losing its message or severity", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "browser.console",
        body: "checkout completed",
        severityNumber: 13,
        severityText: "warn",
        attributes: { currency: "USD", total: 42.5, items: ["sku-1", "sku-2"] },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "MessageData",
      baseData: {
        ver: 2,
        message: "checkout completed",
        severityLevel: 2,
        properties: {
          currency: "USD",
          items: '["sku-1","sku-2"]',
        },
        measurements: { total: 42.5 },
      },
    });
  });

  it("maps other named logs to EventData regardless of body or severity", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "application.audit",
        body: "checkout completed",
        severityNumber: 13,
        attributes: { currency: "USD", total: 42.5 },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "EventData",
      baseData: {
        ver: 2,
        name: "application.audit",
        properties: { currency: "USD" },
        measurements: { total: 42.5 },
      },
    });
  });

  it("maps a name-only record to EventData", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "browser.user_action.click",
        attributes: { target: "button#add-to-cart" },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "EventData",
      baseData: {
        ver: 2,
        name: "browser.user_action.click",
        properties: { target: "button#add-to-cart" },
        measurements: undefined,
      },
    });
  });
});
