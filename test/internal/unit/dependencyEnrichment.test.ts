// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace, type Attributes } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { addDependencyTiming } from "../../../src/instrumentation/browserInstrumentation/dependencyEnrichment.js";
import { getInstrumentations } from "../../../src/instrumentation/browserInstrumentation/index.js";
import type { DependencyInstrumentationOptions } from "../../../src/types.js";
import { createSpanContext } from "../../fixtures/telemetry.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { captureRequestHeaders: "true" },
  { captureResponseHeaders: 1 },
  { includeErrorStatusText: null },
  { enableResourceTiming: "false" },
  { maxDependenciesPerView: -1 },
  { maxDependenciesPerView: 1.5 },
  { maxDependenciesPerView: Infinity },
  { maxDependenciesPerView: NaN },
  { maxDependenciesPerView: Number.MAX_SAFE_INTEGER + 1 },
  { ignoreHeaders: "Authorization" },
  { ignoreHeaders: [""] },
  { ignoreHeaders: ["x-secret\r\nx-extra"] },
  { ignoreHeaders: [42] },
])("rejects invalid dependency policy before patching: %j", async (dependencies) => {
  const fetchBefore = globalThis.fetch;
  const xhrBefore = XMLHttpRequest.prototype.open;
  await expect(
    getInstrumentations({
      dependencies: dependencies as unknown as DependencyInstrumentationOptions,
    }),
  ).rejects.toThrow(TypeError);
  expect(globalThis.fetch).toBe(fetchBefore);
  expect(XMLHttpRequest.prototype.open).toBe(xhrBefore);
});

function timing(overrides: Partial<PerformanceResourceTiming> = {}): PerformanceResourceTiming {
  return {
    entryType: "resource",
    name: "https://example.test/api",
    initiatorType: "fetch",
    startTime: 100,
    duration: 60,
    domainLookupStart: 101,
    domainLookupEnd: 102,
    connectStart: 102,
    secureConnectionStart: 103,
    connectEnd: 105,
    requestStart: 106,
    responseStart: 140,
    responseEnd: 160,
    redirectStart: 0,
    redirectEnd: 0,
    ...overrides,
  } as PerformanceResourceTiming;
}

function enrich(
  entries: PerformanceResourceTiming[],
  attributes: Attributes = {},
  ambiguous = false,
) {
  vi.spyOn(performance, "now").mockReturnValue(165);
  vi.spyOn(performance, "getEntriesByName").mockReturnValue(entries);
  const span = Object.assign(trace.wrapSpanContext(createSpanContext()), { attributes });
  vi.spyOn(span, "setAttribute").mockImplementation((name, value) => {
    attributes[name] = value;
    return span;
  });
  addDependencyTiming(
    span,
    { url: "https://example.test/api", start: 100, timing: { count: 1, ambiguous } },
    "fetch",
  );
  return attributes;
}

it("calculates finite millisecond phases and preserves explicit attributes", () => {
  expect(enrich([timing()], { "browser.dependency.duration": 42 })).toEqual({
    "browser.dependency.duration": 42,
    "browser.dependency.dns.duration": 1,
    "browser.dependency.connect.duration": 3,
    "browser.dependency.tls.duration": 2,
    "browser.dependency.request.duration": 34,
    "browser.dependency.response.duration": 20,
  });
});

it.each(
  [
    [],
    [timing({ startTime: 50 })],
    [timing({ startTime: 99.5 })],
    [timing({ responseEnd: 200 })],
    [timing({ responseEnd: 0 })],
    [timing({ initiatorType: "xmlhttprequest" })],
    [timing(), timing({ startTime: 101 })],
  ].map((entries) => ({ entries })),
)("omits absent, unrelated, unfinished or ambiguous entries", ({ entries }) => {
  expect(enrich(entries)).toEqual({});
});

it("does not report redacted, negative or nonfinite timing phases", () => {
  expect(
    enrich([
      timing({
        duration: NaN,
        domainLookupStart: 0,
        domainLookupEnd: 0,
        connectEnd: 1,
        requestStart: 150,
        responseStart: 140,
        responseEnd: 130,
      }),
    ]),
  ).toEqual({});
});

it("omits a lone surviving entry when same-URL requests overlap", () => {
  expect(enrich([timing()], {}, true)).toEqual({});
});
