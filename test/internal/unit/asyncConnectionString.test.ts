// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { isUnloading } from "../../../src/exporter/common.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import type { AzureMonitorEnvelope } from "../../../src/exporter/telemetryModels.js";
import { installFakeClock } from "../../fixtures/clock.js";
import { getSharedRegistry } from "../../../src/shared/globalOwnership.js";

const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://customer.example.test";
const handles: MicrosoftOpenTelemetryBrowser[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: () => void;
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = () => fail(new Error("private reason"));
  });
  return { promise, resolve, reject };
}

async function start(options: MicrosoftOpenTelemetryBrowserOptions) {
  const bodies: Promise<AzureMonitorEnvelope[]>[] = [];
  vi.stubGlobal("CompressionStream", undefined);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    bodies.push(new Request(url, init).json() as Promise<AzureMonitorEnvelope[]>);
    return new Response(null);
  });
  vi.stubGlobal("fetch", fetch);
  const handle = await useMicrosoftOpenTelemetry({
    session: { enabled: false },
    userContext: { enabled: false },
    pageView: { enabled: false },
    ...options,
  });
  handles.push(handle);
  return { handle, fetch, envelopes: async () => (await Promise.all(bodies)).flat() };
}

it("returns before resolution and bounds traces and logs together before batching", async () => {
  installFakeClock();
  const pending = deferred();
  const customSpan = { onStart() {}, onEnd: vi.fn(), async forceFlush() {}, async shutdown() {} };
  const customLog = { onEmit: vi.fn(), async forceFlush() {}, async shutdown() {} };
  const result = await start({
    azureMonitor: { connectionString: pending.promise, initInMemoMaxSize: 2 },
    spanProcessors: [customSpan],
    logRecordProcessors: [customLog],
  });
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  trace.getTracer("startup").startSpan("retained span").end();
  logs.getLogger("startup").emit({ body: "retained log" });
  logs.getLogger("startup").emit({ body: "overflow" });
  expect(customSpan.onEnd).toHaveBeenCalledOnce();
  expect(customLog.onEmit).toHaveBeenCalledTimes(2);
  await result.handle.forceFlush();
  expect(result.fetch).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith("Telemetry startup queue full; dropping new items");
  pending.resolve(connectionString);
  await Promise.resolve();
  await result.handle.forceFlush();
  const envelopes = await result.envelopes();
  expect(envelopes).toHaveLength(2);
  expect(envelopes.map((item) => item.iKey)).toEqual(
    Array(2).fill("00000000-0000-0000-0000-000000000000"),
  );
  expect(envelopes[0].data.baseData).toMatchObject({ name: "retained span" });
  expect(envelopes[1].data.baseData).toMatchObject({ message: "retained log" });
  logs.getLogger("startup").emit({ body: "after resolution" });
  await result.handle.forceFlush();
  expect(await result.envelopes()).toHaveLength(3);
});

it.each(["timeout", "rejected", "invalid"] as const)(
  "disables Azure Monitor after %s and ignores late resolution",
  async (failure) => {
    const clock = installFakeClock();
    const pending = deferred();
    const result = await start({
      azureMonitor: { connectionString: pending.promise, initTimeOut: 10 },
    });
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    logs.getLogger("failure").emit({ body: "buffered" });
    if (failure === "timeout") await clock.advance(10);
    else if (failure === "rejected") pending.reject();
    else pending.resolve("invalid");
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      "Telemetry startup failed or timed out; dropping 1 buffered items",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private reason");
    pending.resolve(connectionString);
    await Promise.resolve();
    logs.getLogger("failure").emit({ body: "after failure" });
    await result.handle.forceFlush();
    expect(result.fetch).not.toHaveBeenCalled();
  },
);

it.each(["rejected", "invalid", "timeout"] as const)(
  "reports early %s after installing diagnostics on a fresh page",
  async (failure) => {
    const clock = installFakeClock();
    diag.disable();
    getSharedRegistry().diagInitialized = false;
    const originalWarn = diag.warn.bind(diag);
    const warn = vi.spyOn(diag, "warn").mockImplementation((...args) => {
      // DiagConsoleLogger captures console methods at module load; observe the public dispatch
      // instead and require a real diagnostic registration before allowing the warning through.
      expect(getSharedRegistry().diagInitialized).toBe(true);
      originalWarn(...args);
    });
    const resource = resourceFromAttributes({});
    resource.waitForAsyncAttributes = async () => {
      if (failure === "timeout") await clock.advance(10);
      expect(warn).not.toHaveBeenCalled();
    };
    const result = await start({
      resource,
      azureMonitor: {
        connectionString:
          failure === "rejected"
            ? Promise.reject(new Error("private rejection reason"))
            : failure === "invalid"
              ? Promise.resolve("private invalid connection string")
              : new Promise<string>(() => {}),
        initTimeOut: 10,
      },
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Telemetry startup failed or timed out; dropping 0 buffered items",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
    logs.getLogger("early failure").emit({ body: "dropped" });
    await result.handle.forceFlush();
    expect(result.fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["traces", "logs"] as const)(
  "keeps an explicitly disabled %s signal off",
  async (signal) => {
    const result = await start({
      azureMonitor: { connectionString: Promise.resolve(connectionString) },
      ...(signal === "traces" ? { spanProcessors: [] } : { logRecordProcessors: [] }),
    });
    trace.getTracer("disabled").startSpan("span").end();
    logs.getLogger("disabled").emit({ body: "log" });
    await result.handle.forceFlush();
    const envelopes = await result.envelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].data.baseType).toBe(
      signal === "traces" ? "MessageData" : "RemoteDependencyData",
    );
  },
);

it("cancels pending resolution on shutdown", async () => {
  installFakeClock();
  const pending = deferred();
  const result = await start({ azureMonitor: { connectionString: pending.promise } });
  logs.getLogger("stop").emit({ body: "pending" });
  await result.handle.shutdown();
  pending.resolve(connectionString);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  expect(result.fetch).not.toHaveBeenCalled();
});

it("coalesces pending flushes without waiting for the connection string", async () => {
  installFakeClock();
  const pending = deferred();
  const result = await start({ azureMonitor: { connectionString: pending.promise } });
  logs.getLogger("flush").emit({ body: "retained" });
  const first = result.handle.forceFlush();
  expect(result.handle.forceFlush()).toBe(first);
  await first;
  expect(result.fetch).not.toHaveBeenCalled();
  pending.resolve(connectionString);
  await Promise.resolve();
  await result.handle.forceFlush();
  expect(await result.envelopes()).toHaveLength(1);
});

it("retains the queue on page hide and releases unload state before resolution", async () => {
  const clock = installFakeClock();
  const pending = deferred();
  const result = await start({ azureMonitor: { connectionString: pending.promise } });
  logs.getLogger("pagehide").emit({ body: "retained" });
  globalThis.dispatchEvent(new Event("pagehide"));
  await clock.advance(0);
  expect(isUnloading()).toBe(false);
  expect(result.fetch).not.toHaveBeenCalled();
  pending.resolve(connectionString);
  await Promise.resolve();
  await result.handle.forceFlush();
  expect(await result.envelopes()).toHaveLength(1);
});

it("cancels pending startup when resource initialization fails", async () => {
  installFakeClock();
  const pending = deferred();
  const resource = resourceFromAttributes({});
  resource.waitForAsyncAttributes = async () => {
    throw new Error("resource failed");
  };
  await expect(
    start({ azureMonitor: { connectionString: pending.promise }, resource }),
  ).rejects.toThrow("resource failed");
  pending.resolve(connectionString);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("cleans up exporters resolved before a subsequent initialization failure", async () => {
  installFakeClock();
  const resource = resourceFromAttributes({});
  resource.waitForAsyncAttributes = async () => {
    throw new Error("resource failed");
  };
  await expect(
    start({ azureMonitor: { connectionString: Promise.resolve(connectionString) }, resource }),
  ).rejects.toThrow("resource failed");
  expect(vi.getTimerCount()).toBe(0);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("keeps buffers independent when the first instance stops before resolution", async () => {
  installFakeClock();
  const firstPromise = deferred();
  const secondPromise = deferred();
  const first = await start({ azureMonitor: { connectionString: firstPromise.promise } });
  const cachedLogger = logs.getLogger("first");
  cachedLogger.emit({ body: "discard first" });
  const second = await start({ azureMonitor: { connectionString: secondPromise.promise } });
  await first.handle.shutdown();
  cachedLogger.emit({ body: "stale first" });
  logs.getLogger("second").emit({ body: "retain second" });
  firstPromise.resolve(connectionString);
  secondPromise.resolve(connectionString);
  await Promise.resolve();
  await second.handle.forceFlush();
  const envelopes = await second.envelopes();
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0].data.baseData).toMatchObject({ message: "retain second" });
  await second.handle.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([0, 100])(
  "preserves %s percent sampling before and after resolution",
  async (samplingPercentage) => {
    const pending = deferred();
    const result = await start({
      azureMonitor: { connectionString: pending.promise },
      samplingPercentage,
    });
    trace.getTracer("sampling").startSpan("before").end();
    logs.getLogger("sampling").emit({ body: "before" });
    pending.resolve(connectionString);
    await Promise.resolve();
    trace.getTracer("sampling").startSpan("after").end();
    logs.getLogger("sampling").emit({ body: "after" });
    await result.handle.forceFlush();
    expect(await result.envelopes()).toHaveLength(samplingPercentage === 0 ? 0 : 4);
  },
);

it("flushes resolved processors during idempotent shutdown", async () => {
  installFakeClock();
  const result = await start({
    azureMonitor: { connectionString: Promise.resolve(connectionString) },
  });
  trace.getTracer("shutdown").startSpan("final span").end();
  logs.getLogger("shutdown").emit({ body: "final log" });
  const shutdown = result.handle.shutdown();
  expect(result.handle.shutdown()).toBe(shutdown);
  await shutdown;
  expect(await result.envelopes()).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
