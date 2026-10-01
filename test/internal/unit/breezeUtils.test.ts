// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import {
  isRetriable,
  isSamplingRejection,
  parseBreezeResponse,
  parseRetryAfterHeader,
} from "../../../src/exporter/breezeUtils.js";
import { MAX_RETRY_AFTER_MS } from "../../../src/exporter/constants.js";

describe("Breeze utilities", () => {
  it.each([206, 401, 403, 408, 429, 439, 500, 502, 503, 504])(
    "classifies %i as retriable",
    (statusCode) => {
      expect(isRetriable(statusCode)).toBe(true);
    },
  );

  it.each([200, 400, 404, 501])("classifies %i as non-retriable", (statusCode) => {
    expect(isRetriable(statusCode)).toBe(false);
  });

  it("recognizes sampled-out errors case-insensitively", () => {
    expect(
      isSamplingRejection({
        index: 0,
        statusCode: 500,
        message: "TELEMETRY SAMPLED OUT.",
      }),
    ).toBe(true);
  });

  it("parses a valid Breeze response", () => {
    expect(
      parseBreezeResponse(
        JSON.stringify({
          itemsReceived: 1,
          itemsAccepted: 0,
          errors: [{ index: 0, statusCode: 500, message: "Server error" }],
        }),
      ),
    ).toEqual({
      itemsReceived: 1,
      itemsAccepted: 0,
      errors: [{ index: 0, statusCode: 500, message: "Server error" }],
    });
  });

  it.each([
    "invalid",
    JSON.stringify({ itemsReceived: 1, itemsAccepted: 0 }),
    JSON.stringify({
      itemsReceived: 1,
      itemsAccepted: 0,
      errors: [{ index: "0", statusCode: 500, message: "Server error" }],
    }),
  ])("rejects a malformed Breeze response", (responseBody) => {
    expect(parseBreezeResponse(responseBody)).toBeUndefined();
  });

  it("parses Retry-After seconds", () => {
    expect(parseRetryAfterHeader("120")).toBe(120_000);
  });

  it("parses a future Retry-After date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));

    try {
      expect(parseRetryAfterHeader("Wed, 23 Sep 2026 00:00:05 GMT")).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps Retry-After to the configured maximum", () => {
    expect(parseRetryAfterHeader("9999999999")).toBe(MAX_RETRY_AFTER_MS);
  });

  it.each([null, "", "0", "invalid"])("ignores invalid Retry-After value %s", (value) => {
    expect(parseRetryAfterHeader(value)).toBeUndefined();
  });
});
