// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, expect, it, vi } from "vitest";
import { version } from "../../package.json";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

afterEach(() => {
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
});

it.each(["index.js", "index.min.js"])(
  "exports manual telemetry from application APIs through %s",
  async (file) => {
    // Type-check from a clean checkout; load the built artifact only at runtime.
    const path = `../../dist/esm/${file}`;
    const url = new URL(path, import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
    expect(Object.keys(distro).sort()).toEqual([
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
    const telemetry = distro.useMicrosoftOpenTelemetry(pipeline.options);
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
    } finally {
      await telemetry.shutdown();
    }
  },
);
