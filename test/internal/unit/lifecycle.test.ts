// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ResourceTimingInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/resource-timing";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { isUnloading } from "../../../src/exporter/common.js";
import { getSharedRegistry } from "../../../src/shared/globalOwnership.js";
import { subscribeToUnload } from "../../../src/shared/lifecycle.js";

const handles = new Set<MicrosoftOpenTelemetryBrowser>();
const originalUrl = location.href;

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState(null, "", originalUrl);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function processors() {
  return {
    span: {
      onStart: vi.fn(),
      onEnding: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    },
    log: {
      onEmit: vi.fn(),
      forceFlush: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    },
  };
}

async function start(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
  const { span, log } = processors();
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: [span],
    logRecordProcessors: [log],
    pageView: { enabled: false },
    ...options,
  });
  handles.add(handle);
  return { handle, span, log };
}

it("shares unload hooks and removes them only after the last subscriber stops", async () => {
  const addWindow = vi.spyOn(globalThis, "addEventListener");
  const removeWindow = vi.spyOn(globalThis, "removeEventListener");
  const addDocument = vi.spyOn(document, "addEventListener");
  const removeDocument = vi.spyOn(document, "removeEventListener");
  const first = await start();
  const second = await start();
  expect(addWindow.mock.calls.filter(([type]) => type === "pagehide")).toHaveLength(1);
  expect(addDocument.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  await first.handle.shutdown();
  expect(removeWindow.mock.calls.filter(([type]) => type === "pagehide")).toHaveLength(0);
  globalThis.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => expect(isUnloading()).toBe(false));
  expect(first.span.forceFlush).not.toHaveBeenCalled();
  expect(second.span.forceFlush).toHaveBeenCalledOnce();
  await second.handle.shutdown();
  expect(removeWindow.mock.calls.filter(([type]) => type === "pagehide")).toHaveLength(1);
  expect(removeDocument.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  expect(getSharedRegistry().unloadSubscribers?.size).toBe(0);
});

it("rolls back partially installed unload listeners and permits retry", () => {
  const remove = vi.spyOn(globalThis, "removeEventListener");
  const failure = new Error("document listener failed");
  vi.spyOn(document, "addEventListener").mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => subscribeToUnload(vi.fn())).toThrow(failure);
  expect(remove).toHaveBeenCalledWith("pagehide", expect.any(Function));
  const flush = vi.fn();
  const unsubscribe = subscribeToUnload(flush);
  globalThis.dispatchEvent(new Event("pagehide"));
  expect(flush).toHaveBeenCalledOnce();
  unsubscribe();
  unsubscribe();
});

it("stops cached telemetry and in-flight span callbacks before waiting for a flush", async () => {
  const first = await start();
  const second = await start();
  const tracer = trace.getTracer("cached");
  const logger = logs.getLogger("cached");
  const before = tracer.startSpan("before");
  before.end();
  expect(first.span.onEnding).toHaveBeenCalledOnce();
  const inFlight = tracer.startSpan("in-flight");
  first.span.onStart.mockClear();
  first.span.onEnding.mockClear();
  first.span.onEnd.mockClear();
  const pending = deferred();
  first.span.forceFlush.mockReturnValue(pending.promise);
  const flush = first.handle.forceFlush();
  const stop = first.handle.shutdown();
  inFlight.end();
  tracer.startSpan("stale").end();
  logger.emit({ eventName: "stale" });
  expect(logger.enabled()).toBe(false);
  expect(first.span.onStart).not.toHaveBeenCalled();
  expect(first.span.onEnding).not.toHaveBeenCalled();
  expect(first.span.onEnd).not.toHaveBeenCalled();
  expect(first.log.onEmit).not.toHaveBeenCalled();
  trace.getTracer("survivor").startSpan("survivor").end();
  logs.getLogger("survivor").emit({ eventName: "survivor" });
  expect(second.span.onEnd).toHaveBeenCalledOnce();
  expect(second.log.onEmit).toHaveBeenCalledOnce();
  pending.resolve();
  await Promise.all([flush, stop]);
});

it("attempts every processor and waits for siblings after synchronous shutdown failures", async () => {
  const failure = new Error("span shutdown failed");
  const pending = deferred();
  const first = processors();
  const second = processors();
  first.span.shutdown.mockImplementation(() => {
    throw failure;
  });
  second.span.shutdown.mockReturnValue(pending.promise);
  const { handle } = await start({
    spanProcessors: [first.span, second.span],
    logRecordProcessors: [first.log, second.log],
  });
  handles.delete(handle);
  let settled = false;
  const stop = handle.shutdown();
  const rejection = expect(stop).rejects.toBe(failure);
  void stop.catch(() => {}).finally(() => (settled = true));
  await vi.waitFor(() => expect(second.log.shutdown).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  pending.resolve();
  await rejection;
  expect(handle.shutdown()).toBe(stop);
  expect(first.span.shutdown).toHaveBeenCalledOnce();
  expect(second.span.shutdown).toHaveBeenCalledOnce();
});

it("shares the shutdown promise with re-entrant cleanup", async () => {
  let reentrant: Promise<void> | undefined;
  const disable = vi.fn(() => (reentrant = handle.shutdown()));
  const { handle } = await start({
    instrumentations: [{ setTracerProvider() {}, getConfig: () => ({}), enable() {}, disable }],
  });
  const stop = handle.shutdown();
  expect(reentrant).toBe(stop);
  await stop;
  expect(disable).toHaveBeenCalledOnce();
});

it("releases context once after the last instance and accepts a new delegate on restart", async () => {
  const manager = new StackContextManager();
  const disable = vi.spyOn(manager, "disable");
  const first = await start({ traces: { contextManager: manager } });
  const second = await start({ spanProcessors: [] });
  const registration = getSharedRegistry().page?.manager;
  await first.handle.shutdown();
  expect(disable).not.toHaveBeenCalled();
  await second.handle.shutdown();
  expect(disable).toHaveBeenCalledOnce();
  expect(getSharedRegistry().page?.storage).toBeUndefined();
  const nextManager = new StackContextManager();
  const enable = vi.spyOn(nextManager, "enable");
  await start({ traces: { contextManager: nextManager } });
  expect(enable).toHaveBeenCalledOnce();
  expect(getSharedRegistry().page?.manager).toBe(registration);
});

it("does not disable a foreign context manager on final shutdown", async () => {
  const manager = new StackContextManager().enable();
  context.setGlobalContextManager(manager);
  const disable = vi.spyOn(manager, "disable");
  const { handle } = await start({ traces: { contextManager: manager } });
  await handle.shutdown();
  expect(disable).not.toHaveBeenCalled();
});

it("cleans a failed restart's context once and leaves the shared registration reusable", async () => {
  const first = await start();
  await first.handle.shutdown();
  const manager = new StackContextManager();
  const disable = vi.spyOn(manager, "disable");
  await expect(
    start({
      traces: { contextManager: manager },
      instrumentations: [
        {
          setTracerProvider() {},
          getConfig: () => ({}),
          enable() {
            throw new Error("restart failed");
          },
          disable() {},
        },
      ],
    }),
  ).rejects.toThrow("restart failed");
  expect(disable).toHaveBeenCalledOnce();
  expect(getSharedRegistry().page?.storage).toBeUndefined();
  expect(getSharedRegistry().pending).toEqual([]);
  const next = await start();
  trace.getTracer("restarted").startSpan("restarted").end();
  expect(next.span.onEnd).toHaveBeenCalledOnce();
});

it("preserves shared resources when a concurrent startup fails", async () => {
  const manager = new StackContextManager();
  const disable = vi.spyOn(manager, "disable");
  const results = await Promise.allSettled([
    start({
      traces: { contextManager: manager },
      instrumentations: [
        {
          setTracerProvider() {},
          getConfig: () => ({}),
          enable() {
            throw new Error("first failed");
          },
          disable() {},
        },
      ],
    }),
    start(),
  ]);
  expect(results[0].status).toBe("rejected");
  const survivor = results[1];
  if (survivor.status !== "fulfilled") throw survivor.reason;
  expect(disable).not.toHaveBeenCalled();
  expect(getSharedRegistry().unloadSubscribers?.size).toBe(1);
  await survivor.value.handle.shutdown();
  expect(disable).toHaveBeenCalledOnce();
});

it("waits for a stopped instance's pending unload without keeping its subscription", async () => {
  const first = await start();
  const second = await start();
  const pending = deferred();
  first.span.forceFlush.mockReturnValue(pending.promise);
  globalThis.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => expect(first.span.forceFlush).toHaveBeenCalledOnce());
  const stopped = first.handle.shutdown();
  expect(getSharedRegistry().unloadSubscribers?.size).toBe(1);
  expect(first.span.shutdown).not.toHaveBeenCalled();
  pending.resolve();
  await stopped;
  expect(first.span.shutdown).toHaveBeenCalledOnce();
  globalThis.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => expect(second.span.forceFlush).toHaveBeenCalledTimes(2));
  expect(first.span.forceFlush).toHaveBeenCalledOnce();
});

it("continues instrumentation and provider cleanup when final context cleanup throws", async () => {
  const failure = new Error("context cleanup failed");
  const manager = new StackContextManager();
  vi.spyOn(manager, "disable").mockImplementation(() => {
    throw failure;
  });
  const disable = vi.fn();
  const { handle, span, log } = await start({
    traces: { contextManager: manager },
    instrumentations: [{ setTracerProvider() {}, getConfig: () => ({}), enable() {}, disable }],
  });
  handles.delete(handle);
  await expect(handle.shutdown()).rejects.toBe(failure);
  expect(disable).toHaveBeenCalledOnce();
  expect(span.shutdown).toHaveBeenCalledOnce();
  expect(log.shutdown).toHaveBeenCalledOnce();
  expect(getSharedRegistry().unloadSubscribers?.size).toBe(0);
  expect(getSharedRegistry().page?.storage).toBeUndefined();
});

it.each(["flush", "shutdown"] as const)(
  "bounds a stuck processor %s at 30 seconds",
  async (operation) => {
    vi.useFakeTimers();
    const { handle, span, log } = await start();
    handles.delete(handle);
    const never = new Promise<void>(() => {});
    span[operation === "flush" ? "forceFlush" : "shutdown"].mockReturnValue(never);
    const work = operation === "flush" ? handle.forceFlush() : handle.shutdown();
    let settled = false;
    const rejection = expect(work).rejects.toThrow("Operation timed out");
    void work.catch(() => {}).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    if (operation === "flush") await handle.shutdown();
    expect(log.shutdown).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("continues shutdown after a pending flush times out", async () => {
  vi.useFakeTimers();
  const { handle, span, log } = await start();
  handles.delete(handle);
  span.forceFlush.mockReturnValue(new Promise<void>(() => {}));
  const flush = expect(handle.forceFlush()).rejects.toThrow("Operation timed out");
  const stop = expect(handle.shutdown()).rejects.toThrow("Operation timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  await Promise.all([flush, stop]);
  expect(span.shutdown).toHaveBeenCalledOnce();
  expect(log.shutdown).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "cleans observers, sessions and subscriptions after failed startup=%s",
  async (fail) => {
    vi.useFakeTimers();
    const disconnect = vi.fn();
    class Observer {
      static supportedEntryTypes = ["resource"];
      observe = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("PerformanceObserver", Observer);
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    for (let i = 0; i < 3; i++) {
      const instrumentation = new ResourceTimingInstrumentation({ enabled: false });
      const failure: BrowserInstrumentation = {
        setTracerProvider() {},
        getConfig: () => ({}),
        enable() {
          throw new Error("instrumentation failed");
        },
        disable() {},
      };
      const options: MicrosoftOpenTelemetryBrowserOptions = {
        pageView: {},
        session: { enabled: true },
        instrumentations: [instrumentation, ...(fail ? [failure] : [])],
      };
      if (fail) await expect(start(options)).rejects.toThrow("instrumentation failed");
      else {
        const { handle } = await start(options);
        await handle.shutdown();
      }
      expect(disconnect).toHaveBeenCalledTimes(i + 1);
      expect(vi.getTimerCount()).toBe(0);
      expect(getSharedRegistry().router?.running).toHaveLength(0);
      expect(getSharedRegistry().page?.owners).toHaveLength(0);
      expect(getSharedRegistry().unloadSubscribers?.size).toBe(0);
      expect(history.pushState).toBe(originalPush);
      expect(history.replaceState).toBe(originalReplace);
    }
  },
);

it("rolls back a failed second instance without disconnecting the surviving observer", async () => {
  const disconnect = vi.fn();
  class Observer {
    static supportedEntryTypes = ["resource"];
    observe = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal("PerformanceObserver", Observer);
  const first = await start({
    instrumentations: [new ResourceTimingInstrumentation({ enabled: false })],
  });
  await expect(
    start({
      instrumentations: [
        {
          setTracerProvider() {},
          getConfig: () => ({}),
          enable() {
            throw new Error("second failed");
          },
          disable() {},
        },
      ],
    }),
  ).rejects.toThrow("second failed");
  expect(disconnect).not.toHaveBeenCalled();
  expect(getSharedRegistry().unloadSubscribers?.size).toBe(1);
  trace.getTracer("survivor").startSpan("survivor").end();
  expect(first.span.onEnd).toHaveBeenCalledOnce();
  await first.handle.shutdown();
  expect(disconnect).toHaveBeenCalledOnce();
});
