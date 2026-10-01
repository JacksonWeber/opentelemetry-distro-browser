// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { installFakeClock } from "../../../fixtures/clock.js";
import { createDeterministicIdGenerator } from "../../../fixtures/ids.js";
import {
  createInMemoryPipeline,
  createReadableLogRecord,
  createReadableSpan,
} from "../../../fixtures/telemetry.js";

describe("in-memory telemetry fixtures", () => {
  it("flushes queued spans with the fake clock and leaves no pending timers", async () => {
    const clock = installFakeClock();
    const pipeline = createInMemoryPipeline();
    try {
      const span = createReadableSpan();
      pipeline.spanProcessor.onEnd(span);
      const flushed = pipeline.forceFlush();
      await clock.advance(0);
      await flushed;
      expect(pipeline.spanExporter.getFinishedSpans()).toEqual([span]);
    } finally {
      const stopped = pipeline.shutdown();
      await clock.advance(0);
      await stopped;
      expect(vi.getTimerCount()).toBe(0);
      clock.restore();
    }
  });

  it("buffers, flushes and resets correlated telemetry from real providers", async () => {
    const pipeline = createInMemoryPipeline();
    const traces = new BasicTracerProvider({
      spanProcessors: pipeline.options.spanProcessors,
      idGenerator: createDeterministicIdGenerator(),
    });
    const logs = new LoggerProvider({ processors: pipeline.options.logRecordProcessors });
    try {
      const span = traces.getTracer("fixture").startSpan("checkout");
      logs
        .getLogger("fixture")
        .emit({ body: "started", context: trace.setSpan(ROOT_CONTEXT, span) });
      span.end();
      expect(pipeline.spanExporter.getFinishedSpans()).toEqual([]);
      expect(pipeline.logExporter.getFinishedLogRecords()).toEqual([]);
      await pipeline.forceFlush();
      expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
      expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(1);
      expect(pipeline.logExporter.getFinishedLogRecords()[0].spanContext).toEqual(
        span.spanContext(),
      );
      expect(span.spanContext().traceId).toBe("00000000000000000000000000000001");
      pipeline.spanExporter.reset();
      pipeline.logExporter.reset();
      expect(pipeline.spanExporter.getFinishedSpans()).toEqual([]);
      expect(pipeline.logExporter.getFinishedLogRecords()).toEqual([]);
      traces.getTracer("fixture").startSpan("next").end();
      await pipeline.forceFlush();
      expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(["next"]);
    } finally {
      await Promise.all([traces.shutdown(), logs.shutdown()]);
    }
    expect(pipeline.spanExporter.getFinishedSpans()).toEqual([]);
    expect(pipeline.logExporter.getFinishedLogRecords()).toEqual([]);
  });

  it("reports exporter success, isolates instances and rejects export after shutdown", async () => {
    const first = createInMemoryPipeline();
    const second = createInMemoryPipeline();
    try {
      const span = createReadableSpan();
      const log = createReadableLogRecord();
      expect(
        await new Promise<ExportResult>((resolve) => first.spanExporter.export([span], resolve)),
      ).toEqual({ code: ExportResultCode.SUCCESS });
      expect(
        await new Promise<ExportResult>((resolve) => first.logExporter.export([log], resolve)),
      ).toEqual({ code: ExportResultCode.SUCCESS });
      expect(first.spanExporter.getFinishedSpans()).toEqual([span]);
      expect(first.logExporter.getFinishedLogRecords()).toEqual([log]);
      expect(second.spanExporter.getFinishedSpans()).toEqual([]);
      expect(second.logExporter.getFinishedLogRecords()).toEqual([]);
      await first.shutdown();
      await first.shutdown();
      expect(first.spanExporter.getFinishedSpans()).toEqual([]);
      expect(first.logExporter.getFinishedLogRecords()).toEqual([]);
      expect(
        await new Promise<ExportResult>((resolve) => first.spanExporter.export([span], resolve)),
      ).toMatchObject({ code: ExportResultCode.FAILED, error: expect.any(Error) });
      expect(
        await new Promise<ExportResult>((resolve) => first.logExporter.export([log], resolve)),
      ).toMatchObject({ code: ExportResultCode.FAILED, error: expect.any(Error) });
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
  });

  it("finishes both shutdowns and exposes cleanup failures", async () => {
    const pipeline = createInMemoryPipeline();
    const failure = new Error("span shutdown failed");
    const spanShutdown = vi
      .spyOn(pipeline.spanProcessor, "shutdown")
      .mockRejectedValueOnce(failure);
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    try {
      await expect(pipeline.shutdown()).rejects.toMatchObject({ errors: [failure] });
      expect(logShutdown).toHaveResolvedTimes(1);
    } finally {
      spanShutdown.mockRestore();
      logShutdown.mockRestore();
      await pipeline.shutdown();
    }
  });

  it("builds typed readable records with isolated mutable defaults and explicit overrides", () => {
    const span = createReadableSpan({ name: "custom", parentSpanContext: undefined });
    const log = createReadableLogRecord({ body: "custom", spanContext: undefined });
    span.attributes.changed = true;
    log.attributes.changed = true;
    expect(span.name).toBe("custom");
    expect(span.parentSpanContext).toBeUndefined();
    expect(log.spanContext).toBeUndefined();
    expect(createReadableSpan().attributes).toEqual({});
    expect(createReadableLogRecord().attributes).toEqual({});
    expect(createReadableSpan().resource.getRawAttributes()).toEqual([
      ["service.name", "browser-store"],
    ]);
  });
});
