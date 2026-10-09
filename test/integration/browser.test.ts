// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, expect, inject, it, vi } from "vitest";
import { version } from "../../package.json";
import type { AzureMonitorEnvelope } from "../../src/exporter/telemetryModels.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

afterEach(() => {
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
});

it("sends telemetry from a browser interaction to Azure Monitor ingestion", async () => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
  let pageReady!: () => void;
  const pageEmitted = new Promise<void>((resolve) => {
    pageReady = resolve;
  });
  const telemetry = await (
    await import(/* @vite-ignore */ new URL("../../dist/esm/index.js", import.meta.url).href)
  ).useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString:
        `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
        `IngestionEndpoint=${ingestionEndpoint}`,
    },
    pageView: { applyCustomLogRecordData: () => pageReady() },
    session: { enabled: true, persist: false, inactivityTimeout: 60, maxDuration: 3600 },
  });
  const button = document.createElement("button");
  let applicationSpanId: string | undefined;
  button.addEventListener("click", () => {
    const logger = logs.getLogger("browser-ingestion-test");
    const span = trace.getTracer("browser-ingestion-test").startSpan("checkout.click");
    applicationSpanId = span.spanContext().spanId;
    const applicationContext = trace.setSpan(ROOT_CONTEXT, span);
    logger.emit({
      eventName: "checkout.context",
      context: applicationContext,
      attributes: { "test.run_id": runId },
    });
    trace
      .getTracer("browser-ingestion-test")
      .startSpan("checkout.child", {}, applicationContext)
      .end();
    span.end();
    logger.emit({
      eventName: "checkout.clicked",
      body: runId,
      attributes: { "test.run_id": runId },
    });
    logger.emit({
      eventName: "browser.page_view",
      attributes: {
        "browser.page_view.name": "Checkout",
        "browser.page_view.duration": 425.25,
        "browser.page_view.performance.total": 425.25,
        "browser.page_view.performance.network_connect": 25,
        "browser.page_view.performance.sent_request": 100.5,
        "browser.page_view.performance.received_response": 50.25,
        "browser.page_view.performance.dom_processing": 249.5,
        "url.full": `${location.origin}/checkout`,
        "test.run_id": runId,
      },
    });
    logger.emit({
      eventName: "checkout.custom",
      attributes: { "test.run_id": runId, itemCount: 2 },
    });
  });
  document.body.append(button);

  try {
    await pageEmitted;
    const operationId = trace.getSpanContext(context.active())!.traceId;
    button.click();
    await telemetry.forceFlush();

    const captured: AzureMonitorEnvelope[] = await fetch(
      `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`,
    ).then((response) => response.json());
    const sessionId = captured[0].tags["ai.session.id"];
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
    for (const envelope of captured) {
      expect(envelope.tags["ai.session.id"]).toBe(sessionId);
      expect(envelope.data.baseData.properties?.["session.id"]).toBeUndefined();
    }
    expect(captured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tags: expect.objectContaining({ "ai.operation.id": operationId }),
          data: expect.objectContaining({
            baseType: "PageViewData",
            baseData: expect.objectContaining({ id: operationId }),
          }),
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.RemoteDependency",
          tags: expect.objectContaining({ "ai.operation.id": operationId }),
          data: expect.objectContaining({
            baseType: "RemoteDependencyData",
            baseData: expect.objectContaining({ name: "checkout.click" }),
          }),
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.Event",
          tags: expect.objectContaining({ "ai.operation.id": operationId }),
          data: expect.objectContaining({
            baseType: "EventData",
            baseData: expect.objectContaining({
              name: "checkout.clicked",
              properties: expect.objectContaining({ "test.run_id": runId }),
            }),
          }),
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.PageView",
          tags: expect.objectContaining({ "ai.operation.id": operationId }),
          data: {
            baseType: "PageViewData",
            baseData: expect.objectContaining({
              id: operationId,
              name: "Checkout",
              url: `${location.origin}/checkout`,
              duration: "00:00:00.4252500",
              properties: expect.objectContaining({ "test.run_id": runId }),
            }),
          },
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.PageviewPerformance",
          tags: expect.objectContaining({ "ai.operation.id": operationId }),
          data: {
            baseType: "PageviewPerformanceData",
            baseData: expect.objectContaining({
              name: "Checkout",
              url: `${location.origin}/checkout`,
              duration: "00:00:00.4252500",
              perfTotal: "00:00:00.4252500",
              networkConnect: "00:00:00.0250000",
              sentRequest: "00:00:00.1005000",
              receivedResponse: "00:00:00.0502500",
              domProcessing: "00:00:00.2495000",
              properties: expect.objectContaining({ "test.run_id": runId }),
            }),
          },
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.Event",
          tags: expect.objectContaining({ "ai.operation.id": operationId }),
          data: {
            baseType: "EventData",
            baseData: expect.objectContaining({
              name: "checkout.custom",
              properties: expect.objectContaining({ "test.run_id": runId }),
              measurements: expect.objectContaining({ itemCount: 2 }),
            }),
          },
        }),
      ]),
    );
    const parented = captured.filter((envelope) =>
      Object.hasOwn(envelope.tags, "ai.operation.parentId"),
    );
    expect(parented).toHaveLength(2);
    expect(parented).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tags: expect.objectContaining({ "ai.operation.parentId": applicationSpanId }),
          data: expect.objectContaining({
            baseType: "EventData",
            baseData: expect.objectContaining({ name: "checkout.context" }),
          }),
        }),
        expect.objectContaining({
          tags: expect.objectContaining({ "ai.operation.parentId": applicationSpanId }),
          data: expect.objectContaining({
            baseType: "RemoteDependencyData",
            baseData: expect.objectContaining({ name: "checkout.child" }),
          }),
        }),
      ]),
    );
  } finally {
    button.remove();
    await telemetry.shutdown();
  }
});

it("redacts the default page URL in the Azure Monitor ingestion payload", async () => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
  const originalUrl = `${location.pathname}${location.search}${location.hash}`;
  history.replaceState(
    null,
    "",
    "/callback?code=query-secret#access_token=access-secret&id_token=id-secret&state=public",
  );
  let pageReady!: () => void;
  const pageEmitted = new Promise<void>((resolve) => {
    pageReady = resolve;
  });
  const telemetry = await (
    await import(/* @vite-ignore */ new URL("../../dist/esm/index.js", import.meta.url).href)
  ).useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString:
        `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
        `IngestionEndpoint=${ingestionEndpoint}`,
    },
    pageView: { applyCustomLogRecordData: () => pageReady() },
  });

  try {
    await pageEmitted;
    await telemetry.forceFlush();

    const captured: AzureMonitorEnvelope[] = await fetch(
      `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`,
    ).then((response) => response.json());
    const pageView = captured.find((envelope) => envelope.data.baseType === "PageViewData");
    expect(pageView).toMatchObject({
      data: {
        baseType: "PageViewData",
        baseData: {
          url: `${location.origin}/callback?code=REDACTED#access_token=REDACTED&id_token=REDACTED&state=public`,
        },
      },
    });
    expect(JSON.stringify(captured)).not.toMatch(/query-secret|access-secret|id-secret/);
  } finally {
    await telemetry.shutdown();
    history.replaceState(null, "", originalUrl);
  }
});

it.each(["index.js", "index.min.js"])(
  "exports manual telemetry from application APIs through %s",
  async (file) => {
    // Type-check from a clean checkout; load the built artifact only at runtime.
    const path = `../../dist/esm/${file}`;
    const url = new URL(path, import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
    expect(Object.keys(distro).sort()).toEqual([
      "AzureMonitorLogRecordExporter",
      "AzureMonitorSpanExporter",
      "BrowserDetector",
      "OPENTELEMETRY_BROWSER_VERSION",
      "UserAgentDetector",
      "browserDetector",
      "useMicrosoftOpenTelemetry",
      "userAgentDetector",
    ]);
    expect(distro.OPENTELEMETRY_BROWSER_VERSION).toBe(version);
    expect(window).not.toHaveProperty("OpenTelemetryBrowser");
    const pipeline = createInMemoryPipeline();
    const tracer = trace.getTracer("browser-consumer");
    const logger = logs.getLogger("browser-consumer");
    const telemetry = await distro.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      session: { enabled: true },
    });
    try {
      const span = tracer.startSpan("before-init");
      logger.emit({
        eventName: "before-init",
        context: trace.setSpan(ROOT_CONTEXT, span),
      });
      span.end();
      trace.getTracer("after-init").startSpan("after-init").end();
      logs.getLogger("after-init").emit({ eventName: "after-init" });
      await pipeline.forceFlush();
      const spans = pipeline.spanExporter.getFinishedSpans();
      const records = pipeline.logExporter.getFinishedLogRecords();
      expect(spans.map((record) => record.name)).toEqual(["before-init", "after-init"]);
      expect(records.map((record) => record.eventName)).toEqual(["before-init", "after-init"]);
      expect(records[0].spanContext).toEqual(spans[0].spanContext());
      const sessionId = spans[0].attributes["session.id"];
      expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
      for (const record of [...spans, ...records]) {
        expect(record.attributes["session.id"]).toBe(sessionId);
      }
      tracer
        .startSpan("application-session", {
          attributes: { "session.id": "application-span" },
        })
        .end();
      logger.emit({
        eventName: "application-session",
        attributes: { "session.id": "application-log" },
      });
      await pipeline.forceFlush();
      expect(pipeline.spanExporter.getFinishedSpans().at(-1)?.attributes["session.id"]).toBe(
        "application-span",
      );
      expect(pipeline.logExporter.getFinishedLogRecords().at(-1)?.attributes["session.id"]).toBe(
        "application-log",
      );
    } finally {
      await telemetry.shutdown();
    }
  },
);
