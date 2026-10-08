// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from "@opentelemetry/api";
import { SamplingDecision, type Sampler } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  ApplicationInsightsSampler,
  AZURE_MONITOR_SAMPLE_RATE,
  getSamplingScore,
  PageOperationSampler,
} from "../../../src/sampling.js";
import { markPageContext } from "../../../src/shared/pageOperationContext.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const LOW_SCORE_TRACE_ID = "00000000000000000000000000000001";

function sample(sampler: Sampler, context = ROOT_CONTEXT) {
  return sampler.shouldSample(context, TRACE_ID, "test", SpanKind.INTERNAL, {}, []);
}

describe("PageOperationSampler", () => {
  it("samples a span correlated to an unsampled synthetic page operation", () => {
    const operation = {
      traceId: TRACE_ID,
      spanId: "1111111111111111",
      traceFlags: TraceFlags.NONE,
    };
    markPageContext(operation);
    const parent = trace.setSpanContext(ROOT_CONTEXT, operation);

    expect(sample(new PageOperationSampler(), parent)).toMatchObject({
      decision: SamplingDecision.RECORD_AND_SAMPLED,
    });
  });

  it.each([false, true])("preserves an unsampled %s application parent", (isRemote) => {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: "1111111111111111",
      traceFlags: TraceFlags.NONE,
      isRemote,
    });

    expect(sample(new PageOperationSampler(), parent)).toMatchObject({
      decision: SamplingDecision.NOT_RECORD,
    });
  });
});

describe("ApplicationInsightsSampler", () => {
  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid percentage %s",
    (percentage) => {
      expect(() => new ApplicationInsightsSampler(percentage)).toThrow(RangeError);
    },
  );

  it("handles the zero and 100 percent boundaries", () => {
    expect(sample(new ApplicationInsightsSampler(0))).toEqual({
      decision: SamplingDecision.NOT_RECORD,
      attributes: {},
    });
    expect(sample(new ApplicationInsightsSampler(100))).toEqual({
      decision: SamplingDecision.RECORD_AND_SAMPLED,
      attributes: {},
    });
  });

  it("makes a deterministic decision from the trace ID", () => {
    const score = getSamplingScore(TRACE_ID);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
    expect(sample(new ApplicationInsightsSampler(score))).toMatchObject({
      decision: SamplingDecision.NOT_RECORD,
    });
    expect(sample(new ApplicationInsightsSampler(score + 0.000_001))).toMatchObject({
      decision: SamplingDecision.RECORD_AND_SAMPLED,
    });
  });

  it.each([
    ["y", 1_406_544_563],
    ["ss", 1_179_811_869],
    ["kxi", 34_202_699],
    ["ynehgfhyuiltaiqovbpyhpm", 2_139_623_659],
    [TRACE_ID, 718_577_102],
    ["00000000000000000000000000000001", 50_237_190],
  ])("matches the Application Insights cross-SDK hash for %s", (traceId, expectedHash) => {
    expect(getSamplingScore(traceId)).toBe((expectedHash / 2_147_483_647) * 100);
  });

  it("adds the sample rate without mutating input attributes", () => {
    const attributes = { existing: "value" };
    const result = new ApplicationInsightsSampler(50).shouldSample(
      ROOT_CONTEXT,
      TRACE_ID,
      "test",
      SpanKind.INTERNAL,
      attributes,
      [],
    );

    expect(attributes).toEqual({ existing: "value" });
    expect(result.attributes).not.toBe(attributes);
    expect(result.attributes).toEqual({
      existing: "value",
      [AZURE_MONITOR_SAMPLE_RATE]: 50,
    });
  });

  it.each([
    [TraceFlags.SAMPLED, getSamplingScore(TRACE_ID), SamplingDecision.NOT_RECORD],
    [TraceFlags.NONE, getSamplingScore(TRACE_ID) + 0.000_001, SamplingDecision.RECORD_AND_SAMPLED],
  ] as const)(
    "uses the trace ID score instead of parent trace flags %s",
    (traceFlags, samplingPercentage, decision) => {
      const parent = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: TRACE_ID,
        spanId: "1111111111111111",
        traceFlags,
        isRemote: true,
      });
      expect(sample(new ApplicationInsightsSampler(samplingPercentage), parent)).toMatchObject({
        decision,
      });
    },
  );

  it("rejects a sampled-parent trace at zero percent", () => {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: "1111111111111111",
      traceFlags: TraceFlags.SAMPLED,
    });

    expect(sample(new ApplicationInsightsSampler(0), parent)).toEqual({
      decision: SamplingDecision.NOT_RECORD,
      attributes: {},
    });
  });

  it.each([
    [25, 50, 25],
    [50, 20, 20],
    [50, 75, 50],
    [50, "invalid", 50],
    [50, Number.NaN, 50],
    [50, -1, 50],
    [50, 0, 50],
    [50, 101, 50],
  ])(
    "reconciles configured percentage %s with producer sample rate %s",
    (samplingPercentage, producerSampleRate, expectedSampleRate) => {
      const attributes = { [AZURE_MONITOR_SAMPLE_RATE]: producerSampleRate };
      const result = new ApplicationInsightsSampler(samplingPercentage).shouldSample(
        ROOT_CONTEXT,
        LOW_SCORE_TRACE_ID,
        "test",
        SpanKind.INTERNAL,
        attributes,
        [],
      );

      expect(attributes).toEqual({ [AZURE_MONITOR_SAMPLE_RATE]: producerSampleRate });
      if (producerSampleRate === expectedSampleRate) {
        expect(result.attributes).toBe(attributes);
      } else {
        expect(result.attributes).not.toBe(attributes);
      }
      expect(result.attributes?.[AZURE_MONITOR_SAMPLE_RATE]).toBe(expectedSampleRate);
    },
  );

  it("preserves matching producer sampling metadata", () => {
    const attributes = { [AZURE_MONITOR_SAMPLE_RATE]: 50 };
    const result = new ApplicationInsightsSampler(50).shouldSample(
      ROOT_CONTEXT,
      TRACE_ID,
      "test",
      SpanKind.INTERNAL,
      attributes,
      [],
    );

    expect(result.attributes).toBe(attributes);
  });

  it("preserves producer sampling metadata at 100 percent", () => {
    const attributes = { [AZURE_MONITOR_SAMPLE_RATE]: 20 };
    const result = new ApplicationInsightsSampler(100).shouldSample(
      ROOT_CONTEXT,
      TRACE_ID,
      "test",
      SpanKind.INTERNAL,
      attributes,
      [],
    );

    expect(result.attributes).toBe(attributes);
    expect(result.attributes?.[AZURE_MONITOR_SAMPLE_RATE]).toBe(20);
  });
});
