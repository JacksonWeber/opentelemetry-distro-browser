// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginUnloading, endUnloading } from "../../../src/exporter/common.js";
import {
  MAX_BEACON_BODY_SIZE,
  MAX_PENDING_KEEPALIVE_BODY_SIZE,
} from "../../../src/exporter/constants.js";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";
import { createMockIngestionEndpoint } from "../../fixtures/azureMonitor.js";
import { installFakeClock } from "../../fixtures/clock.js";
import { createReadableLogRecord } from "../../fixtures/telemetry.js";

const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function exportLogs(
  exporter: AzureMonitorLogRecordExporter,
  logs: ReadableLogRecord[],
): Promise<{ code: ExportResultCode }> {
  return new Promise((resolve) => exporter.export(logs, resolve));
}

function makePayloadAttributes(totalLength: number, fill: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (let remaining = totalLength, index = 0; remaining > 0; index++) {
    const length = Math.min(8 * 1024, remaining);
    attributes[`payload.${index}`] = fill.repeat(length);
    remaining -= length;
  }
  return attributes;
}

function totalPropertyLength(properties: Record<string, string> | undefined): number {
  return Object.values(properties ?? {}).reduce((total, value) => total + value.length, 0);
}

describe("AzureMonitorLogRecordExporter", () => {
  it("falls back to HTTPS instead of exporting logs to a non-loopback HTTP endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString:
        "InstrumentationKey=00000000-0000-0000-0000-000000000000;" +
        "IngestionEndpoint=http://example.test",
    });

    try {
      const result = await new Promise<{ code: ExportResultCode }>((resolve) => {
        exporter.export([createReadableLogRecord()], resolve);
      });
      expect(result).toEqual({ code: ExportResultCode.SUCCESS });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][0]).toBe("https://dc.services.visualstudio.com/v2/track");
    } finally {
      await exporter.shutdown();
    }
  });

  it("maps and exports log records", async () => {
    const ingestion = createMockIngestionEndpoint();
    vi.stubGlobal("fetch", ingestion.fetch);
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString: ingestion.connectionString,
    });

    try {
      const result = await new Promise<{ code: ExportResultCode }>((resolve) => {
        exporter.export([createReadableLogRecord({ body: "checkout completed" })], resolve);
      });
      await exporter.forceFlush();
      expect(result).toEqual({ code: ExportResultCode.SUCCESS });
      expect(ingestion.fetch).toHaveBeenCalledOnce();
      expect(ingestion.requests[0].envelopes[0]).toMatchObject({
        data: { baseType: "MessageData", baseData: { message: "checkout completed" } },
      });
    } finally {
      await exporter.shutdown();
    }
  });

  it.each(["forceFlush", "shutdown"] as const)(
    "settles %s promptly when ingestion requests a day-long retry delay",
    async (method) => {
      const clock = installFakeClock();
      vi.stubGlobal("CompressionStream", undefined);
      vi.spyOn(Response.prototype, "text").mockResolvedValue("");
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(null, { status: 503, headers: { "retry-after": "86400" } }),
        );
      vi.stubGlobal("fetch", fetch);
      const exporter = new AzureMonitorLogRecordExporter({ connectionString });
      const callback = vi.fn();
      const finished = vi.fn();

      exporter.export([createReadableLogRecord()], callback);
      const lifecycle = exporter[method]().then(finished);
      await clock.advance(1_500);

      expect(fetch).toHaveBeenCalledOnce();
      expect(finished).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledExactlyOnceWith({
        code: ExportResultCode.FAILED,
        error: expect.objectContaining({ message: expect.stringContaining("retry-wait budget") }),
      });
      await lifecycle;
      expect(vi.getTimerCount()).toBe(0);
      await exporter.shutdown();
    },
  );

  it("exports page-view and performance envelopes from one log record", async () => {
    const ingestion = createMockIngestionEndpoint();
    vi.stubGlobal("fetch", ingestion.fetch);
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString: ingestion.connectionString,
    });
    const log = createReadableLogRecord({
      eventName: "browser.page_view",
      attributes: {
        "browser.page_view.name": "Cart",
        "browser.page_view.performance.total": 170,
        "browser.page_view.performance.network_connect": 20,
        "browser.page_view.performance.sent_request": 50,
        "browser.page_view.performance.received_response": 30,
        "browser.page_view.performance.dom_processing": 70,
      },
    });

    try {
      const result = await new Promise<{ code: ExportResultCode }>((resolve) => {
        exporter.export([log], resolve);
      });
      await exporter.forceFlush();
      expect(result).toEqual({ code: ExportResultCode.SUCCESS });
      expect(ingestion.requests[0].envelopes.map((envelope) => envelope.data.baseType)).toEqual([
        "PageViewData",
        "PageviewPerformanceData",
      ]);
    } finally {
      await exporter.shutdown();
    }
  });

  it("delivers a fitting subset when required unload data exceeds the beacon limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("page unloading");
    });
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });
    beginUnloading();

    try {
      await expect(
        exportLogs(exporter, [
          createReadableLogRecord({
            eventName: "exception",
            attributes: {
              "exception.message": "m".repeat(25 * 1024),
              "exception.stacktrace": "s".repeat(25 * 1024),
              marker: "first",
            },
          }),
          createReadableLogRecord({ body: "x".repeat(20 * 1024) }),
          createReadableLogRecord({ body: "small", attributes: { marker: "last" } }),
        ]),
      ).resolves.toMatchObject({
        code: ExportResultCode.FAILED,
        error: expect.objectContaining({ message: expect.stringContaining("delivered 2 of 3") }),
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(sendBeacon).toHaveBeenCalledOnce();
      const body = (fetch.mock.calls[0]?.[1] as RequestInit).body as Uint8Array<ArrayBuffer>;
      expect(body.byteLength).toBeLessThanOrEqual(MAX_PENDING_KEEPALIVE_BODY_SIZE);
      const envelopes = JSON.parse(new TextDecoder().decode(body)) as Array<{
        data: {
          baseType: string;
          baseData: { message?: string; properties?: Record<string, string> };
        };
      }>;
      expect(envelopes).toHaveLength(2);
      expect(envelopes[0]?.data.baseType).toBe("ExceptionData");
      expect(envelopes[0]?.data.baseData.properties?.marker).toBe("first");
      expect(envelopes[1]?.data.baseData.message).toBe("small");
      expect(envelopes[1]?.data.baseData.properties?.marker).toBe("last");
    } finally {
      endUnloading();
    }
  });

  it("preserves a core exception above the keepalive limit for beacon delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });
    beginUnloading();

    try {
      await expect(
        exportLogs(exporter, [
          createReadableLogRecord({
            eventName: "exception",
            attributes: {
              "exception.message": "m".repeat(32 * 1024),
              "exception.stacktrace": "s".repeat(32 * 1024),
            },
          }),
        ]),
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(fetch).not.toHaveBeenCalled();
      expect(sendBeacon).toHaveBeenCalledOnce();
      const body = sendBeacon.mock.calls[0][1] as Blob;
      expect(body.size).toBeGreaterThan(MAX_PENDING_KEEPALIVE_BODY_SIZE);
      expect(body.size).toBeLessThanOrEqual(MAX_BEACON_BODY_SIZE);
    } finally {
      endUnloading();
    }
  });

  it("preserves custom fields when the unload batch fits the beacon limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });
    const attributes = makePayloadAttributes(60 * 1024, "x");
    beginUnloading();

    try {
      await expect(
        exportLogs(exporter, [createReadableLogRecord({ attributes })]),
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(fetch).not.toHaveBeenCalled();
      expect(sendBeacon).toHaveBeenCalledOnce();
      const body = sendBeacon.mock.calls[0][1] as Blob;
      expect(body.size).toBeGreaterThan(MAX_PENDING_KEEPALIVE_BODY_SIZE);
      expect(body.size).toBeLessThanOrEqual(MAX_BEACON_BODY_SIZE);
      const envelopes = JSON.parse(await body.text()) as Array<{
        data: { baseData: { properties?: Record<string, string> } };
      }>;
      expect(envelopes[0]?.data.baseData.properties).toEqual(attributes);
    } finally {
      endUnloading();
    }
  });

  it("fits optional unload data to the beacon limit instead of the keepalive limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });
    const attributes = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`payload${index}`, "x".repeat(4 * 1024)]),
    );
    beginUnloading();

    try {
      await expect(
        exportLogs(exporter, [createReadableLogRecord({ attributes })]),
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(fetch).not.toHaveBeenCalled();
      expect(sendBeacon).toHaveBeenCalledOnce();
      const body = sendBeacon.mock.calls[0][1] as Blob;
      expect(body.size).toBeGreaterThan(MAX_PENDING_KEEPALIVE_BODY_SIZE);
      expect(body.size).toBeLessThanOrEqual(MAX_BEACON_BODY_SIZE);
      const envelopes = JSON.parse(await body.text()) as Array<{
        data: { baseData: { properties?: Record<string, string> } };
      }>;
      expect(Object.keys(envelopes[0]?.data.baseData.properties ?? {})).toHaveLength(15);
    } finally {
      endUnloading();
    }
  });

  it("removes oversized custom fields before unload delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("page unloading");
    });
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });
    beginUnloading();

    try {
      await expect(
        exportLogs(exporter, [
          createReadableLogRecord({
            eventName: "exception",
            attributes: {
              "exception.message": "Large custom field",
              "exception.stacktrace": "Error\n    at checkout (https://example.test/app.js:42:7)",
              ...makePayloadAttributes(MAX_BEACON_BODY_SIZE, "x"),
            },
          }),
        ]),
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(sendBeacon).toHaveBeenCalledOnce();
      const body = sendBeacon.mock.calls[0][1] as Blob;
      expect(body.size).toBeLessThanOrEqual(MAX_BEACON_BODY_SIZE);
      const envelopes = JSON.parse(await body.text()) as Array<{
        data: {
          baseData: {
            exceptions: Array<{
              message: string;
              stack?: string;
              parsedStack?: unknown[];
            }>;
            properties?: Record<string, string>;
          };
        };
      }>;
      expect(totalPropertyLength(envelopes[0]?.data.baseData.properties)).toBeLessThan(
        MAX_BEACON_BODY_SIZE,
      );
      expect(envelopes[0]?.data.baseData.exceptions[0]).toMatchObject({
        message: "Large custom field",
        stack: "Error\n    at checkout (https://example.test/app.js:42:7)",
        parsedStack: [expect.objectContaining({ method: "checkout", line: 42 })],
      });
    } finally {
      endUnloading();
    }
  });

  it("removes custom fields to fit the aggregate unload limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("page unloading");
    });
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });
    beginUnloading();

    try {
      await expect(
        exportLogs(exporter, [
          createReadableLogRecord({ attributes: makePayloadAttributes(40 * 1024, "a") }),
          createReadableLogRecord({ attributes: makePayloadAttributes(40 * 1024, "b") }),
        ]),
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(fetch).toHaveBeenCalledOnce();
      expect(sendBeacon).toHaveBeenCalledOnce();
      const body = sendBeacon.mock.calls[0]?.[1] as Blob;
      expect(body.size).toBeLessThanOrEqual(MAX_PENDING_KEEPALIVE_BODY_SIZE);
      const envelopes = JSON.parse(await body.text()) as Array<{
        data: { baseData: { properties?: Record<string, string> } };
      }>;
      expect(envelopes).toHaveLength(2);
      const retainedLengths = envelopes
        .map((envelope) => totalPropertyLength(envelope.data.baseData.properties))
        .sort((left, right) => left - right);
      expect(retainedLengths).toEqual([16 * 1024, 40 * 1024]);
      const retainedProperties = envelopes.flatMap((envelope) =>
        Object.values(envelope.data.baseData.properties ?? {}),
      );
      expect(retainedProperties.every((value) => value.length <= 8 * 1024)).toBe(true);
    } finally {
      endUnloading();
    }
  });
});
