// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureMonitorExportClient } from "../../../src/exporter/base.js";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";
import { createReadableSpan } from "../../fixtures/telemetry.js";

const connectionString = `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=https://example.test`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["forceFlush", "shutdown"] as const)(
  "AzureMonitorExportClient callback errors during %s",
  (method) => {
    it.each([
      ["success", 200, ExportResultCode.SUCCESS],
      ["HTTP failure", 400, ExportResultCode.FAILED],
      ["transport failure", new Error("offline"), ExportResultCode.FAILED],
      ["non-Error transport failure", "offline", ExportResultCode.FAILED],
    ] as const)("does not invoke a throwing callback again after %s", async (_, response, code) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        if (typeof response !== "number") throw response;
        return new Response("", { status: response });
      });
      vi.stubGlobal("fetch", fetch);
      const client = new AzureMonitorExportClient({ connectionString });
      const callbackError = new Error("callback failed");
      const callback = vi.fn().mockImplementationOnce(() => {
        throw callbackError;
      });

      try {
        client.export([spanToEnvelope(createReadableSpan(), TEST_INSTRUMENTATION_KEY)], callback);
        const operation = client[method]();
        if (method === "shutdown") expect(client.shutdown()).toBe(operation);
        const results = await Promise.allSettled([operation]);

        expect(callback).toHaveBeenCalledExactlyOnceWith(
          code === ExportResultCode.SUCCESS
            ? { code }
            : {
                code,
                error: expect.objectContaining({
                  message:
                    typeof response === "number"
                      ? "Azure Monitor export failed with HTTP 400."
                      : "offline",
                }),
              },
        );
        expect(fetch).toHaveBeenCalledOnce();
        expect(results).toEqual([{ status: "rejected", reason: callbackError }]);
        await expect(client.forceFlush()).resolves.toBeUndefined();
      } finally {
        await expect(client.shutdown()).resolves.toBeUndefined();
      }
    });
  },
);

it("invokes a throwing callback only once for an empty export", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  const client = new AzureMonitorExportClient({ connectionString });
  const callbackError = new Error("callback failed");
  const callback = vi.fn().mockImplementationOnce(() => {
    throw callbackError;
  });

  try {
    client.export([], callback);
    const results = await Promise.allSettled([client.forceFlush()]);

    expect(callback).toHaveBeenCalledExactlyOnceWith({ code: ExportResultCode.SUCCESS });
    expect(results).toEqual([{ status: "rejected", reason: callbackError }]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.forceFlush()).resolves.toBeUndefined();
  } finally {
    await client.shutdown();
  }
});
