// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";

vi.mock("@opentelemetry/browser-sdk", { spy: true });

const storageKey = "opentelemetry-session";
const handles = new Set<MicrosoftOpenTelemetryBrowser>();
let previousSession: string | null;

function resetApis() {
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
}

beforeEach(() => {
  previousSession = localStorage.getItem(storageKey);
  localStorage.removeItem(storageKey);
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.mocked(startBrowserSdk).mockClear();
});

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  const timerCount = vi.getTimerCount();
  vi.useRealTimers();
  resetApis();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousSession === null) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, previousSession);
  expect(timerCount).toBe(0);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

async function initialize(
  shutdown: () => Promise<void> = async () => {},
  options: Pick<MicrosoftOpenTelemetryBrowserOptions, "session"> = { session: { enabled: true } },
) {
  const spans: Span[] = [];
  const records: ReadWriteLogRecord[] = [];
  const handle = await useMicrosoftOpenTelemetry({
    ...options,
    pageView: { enabled: false },
    spanProcessors: [
      {
        onStart: (span) => {
          spans.push(span);
        },
        onEnd() {},
        async forceFlush() {},
        shutdown,
      },
    ],
    logRecordProcessors: [
      {
        onEmit: (record) => {
          records.push(record);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  handles.add(handle);
  function emit() {
    trace.getTracer("session-test").startSpan("operation").end();
    logs.getLogger("session-test").emit({ eventName: "occurrence" });
    const spanId = spans.at(-1)?.attributes["session.id"];
    expect(records.at(-1)?.attributes["session.id"]).toBe(spanId);
    return spanId;
  }
  return { handle, emit, spans, records };
}

it("generates and persists the same session ID when explicitly enabled", async () => {
  const { emit } = await initialize();
  const id = emit();
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    id,
    startTimestamp: Date.now(),
    lastActivityTimestamp: Date.now(),
  });
  expect(emit()).toBe(id);
});

it.each([undefined, {}, { enabled: false }])(
  "does not access storage, create timers, or enrich telemetry without opt-in (%j)",
  async (session) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ id: "previous", startTimestamp: Date.now() }),
    );
    const access = vi.spyOn(window, "localStorage", "get");
    const { emit, spans, records } = await initialize(undefined, { session });
    expect(emit()).toBeUndefined();
    trace
      .getTracer("application")
      .startSpan("manual", {
        attributes: { "session.id": "application-span" },
      })
      .end();
    logs.getLogger("application").emit({ attributes: { "session.id": "application-log" } });
    expect(spans.at(-1)?.attributes["session.id"]).toBe("application-span");
    expect(records.at(-1)?.attributes["session.id"]).toBe("application-log");
    expect(access).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["application-session", ""])(
  "preserves application-provided session IDs (%j) and enriches only missing IDs",
  async (id) => {
    const { emit, spans, records } = await initialize();
    trace
      .getTracer("application")
      .startSpan("manual", { attributes: { "session.id": id } })
      .end();
    logs.getLogger("application").emit({ attributes: { "session.id": id } });
    expect(spans.at(-1)?.attributes["session.id"]).toBe(id);
    expect(records.at(-1)?.attributes["session.id"]).toBe(id);
    const generated = emit();
    expect(generated).toMatch(/^[0-9a-f]{32}$/);
    expect(generated).not.toBe(id);
  },
);

it("awaits persisted restoration before starting providers or enabling instrumentation", async () => {
  const restored = { id: "restored-session", startTimestamp: Date.now() - 1000 };
  localStorage.setItem(storageKey, JSON.stringify(restored));
  const read = vi.spyOn(Storage.prototype, "getItem");
  const enable = vi.fn(() => {
    trace.getTracer("instrumentation").startSpan("first").end();
    logs.getLogger("instrumentation").emit({ eventName: "first" });
  });
  const spanIds: unknown[] = [];
  const logIds: unknown[] = [];
  const pending = useMicrosoftOpenTelemetry({
    session: { enabled: true },
    pageView: { enabled: false },
    spanProcessors: [
      {
        onStart: (span) => {
          spanIds.push(span.attributes["session.id"]);
        },
        onEnd() {},
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    logRecordProcessors: [
      {
        onEmit: (record) => {
          logIds.push(record.attributes["session.id"]);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    instrumentations: [
      {
        setTracerProvider() {},
        getConfig: () => ({ enabled: false }),
        enable,
        disable() {},
      },
    ],
  });
  expect(startBrowserSdk).not.toHaveBeenCalled();
  expect(enable).not.toHaveBeenCalled();
  handles.add(await pending);
  expect(read).toHaveBeenCalledExactlyOnceWith(storageKey);
  expect(spanIds).toEqual([restored.id]);
  expect(logIds).toEqual([restored.id]);
});

it("creates a session without an invalid-storage warning when the storage key is absent", async () => {
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const { emit } = await initialize();
  expect(emit()).toMatch(/^[0-9a-f]{32}$/);
  expect(warn).not.toHaveBeenCalled();
});

it.each(["", "{malformed-private-payload", "null"])(
  "replaces corrupt stored JSON (%j) with a diagnostic that excludes the payload",
  async (stored) => {
    localStorage.setItem(storageKey, stored);
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    const { emit } = await initialize();
    const id = emit();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
      id,
      startTimestamp: Date.now(),
      lastActivityTimestamp: Date.now(),
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Invalid stored session; creating a new session.");
  },
);

it.each([1799_999, 1800_000, 1800_001])(
  "restores only sessions idle for less than 30 minutes across reloads (%i ms)",
  async (idleMs) => {
    const first = await initialize();
    const id = first.emit();
    await first.handle.shutdown();
    resetApis();
    await vi.advanceTimersByTimeAsync(idleMs);
    const second = await initialize();
    if (idleMs < 1800_000) expect(second.emit()).toBe(id);
    else expect(second.emit()).not.toBe(id);
  },
);

it.each(["span", "log"])(
  "persists recent %s activity so an old but active session survives reload",
  async (signal) => {
    const first = await initialize();
    const id = first.emit();
    const started = Date.now();
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      if (signal === "span") trace.getTracer("activity").startSpan("activity").end();
      else logs.getLogger("activity").emit({ eventName: "activity" });
    }
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
      id,
      startTimestamp: started,
      lastActivityTimestamp: Date.now(),
    });
    await first.handle.shutdown();
    resetApis();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const second = await initialize();
    expect(second.emit()).toBe(id);
  },
);

it.each([1799_999, 1800_000])(
  "uses creation time to conservatively expire legacy sessions without activity timestamps (%i ms)",
  async (age) => {
    vi.setSystemTime(10_000_000);
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        id: "legacy-session",
        startTimestamp: Date.now() - age,
      }),
    );
    const { emit } = await initialize();
    if (age < 1800_000) expect(emit()).toBe("legacy-session");
    else expect(emit()).not.toBe("legacy-session");
  },
);

it.each([null, "bad", -1, 1e100])(
  "rejects invalid or future persisted activity timestamps (%j)",
  async (lastActivityTimestamp) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        id: "invalid-session",
        startTimestamp: Date.now(),
        lastActivityTimestamp,
      }),
    );
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    const { emit } = await initialize();
    expect(emit()).not.toBe("invalid-session");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Invalid stored session; creating a new session.");
  },
);

it("does not persist timer renewal or shutdown as user activity", async () => {
  const first = await initialize();
  first.emit();
  const activity = Date.now();
  await vi.advanceTimersByTimeAsync(2 * 1800_000);
  const idleSession = JSON.parse(localStorage.getItem(storageKey)!);
  expect(idleSession.lastActivityTimestamp).toBe(activity);
  await first.handle.shutdown();
  expect(JSON.parse(localStorage.getItem(storageKey)!).lastActivityTimestamp).toBe(activity);
  resetApis();
  const second = await initialize();
  expect(second.emit()).not.toBe(idleSession.id);
});

it("coalesces activity writes within the same millisecond", async () => {
  const { emit } = await initialize();
  const write = vi.spyOn(Storage.prototype, "setItem");
  await vi.advanceTimersByTimeAsync(1);
  emit();
  emit();
  expect(write).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  emit();
  expect(write).toHaveBeenCalledTimes(2);
});

it("does not extend persisted activity merely by restoring a session", async () => {
  const first = await initialize();
  const id = first.emit();
  const lastActivity = Date.now();
  await first.handle.shutdown();
  resetApis();
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  const restored = await initialize();
  expect(JSON.parse(localStorage.getItem(storageKey)!).lastActivityTimestamp).toBe(lastActivity);
  await restored.handle.shutdown();
  resetApis();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect((await initialize()).emit()).not.toBe(id);
});

it("keeps the in-memory session if persisting later activity becomes unavailable", async () => {
  const { emit } = await initialize();
  const id = emit();
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("denied", "QuotaExceededError");
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(emit()).toBe(id);
  await vi.advanceTimersByTimeAsync(1000);
  expect(emit()).toBe(id);
  expect(write).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "Session storage unavailable; using an in-memory session.",
  );
});

it.each([
  {},
  [],
  false,
  42,
  "session",
  { id: 42, startTimestamp: "bad" },
  { id: "", startTimestamp: 1000 },
  { id: "invalid", startTimestamp: -1 },
  { id: "invalid", startTimestamp: null },
])("replaces an invalid persisted session (%j) before emitting telemetry", async (stored) => {
  localStorage.setItem(storageKey, JSON.stringify(stored));
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const { emit } = await initialize();
  const id = emit();
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    id,
    startTimestamp: Date.now(),
    lastActivityTimestamp: Date.now(),
  });
  expect(warn).toHaveBeenCalledExactlyOnceWith("Invalid stored session; creating a new session.");
});

it("renews after the default 1800 seconds of inactivity without a telemetry-triggered timer", async () => {
  const { emit } = await initialize();
  const first = emit();
  await vi.advanceTimersByTimeAsync(1799_999);
  expect(JSON.parse(localStorage.getItem(storageKey)!).id).toBe(first);
  await vi.advanceTimersByTimeAsync(1);
  const renewed = JSON.parse(localStorage.getItem(storageKey)!).id;
  expect(renewed).not.toBe(first);
  expect(emit()).toBe(renewed);
});

it.each(["span", "log"])(
  "a %s refreshes upstream inactivity after its five-second debounce",
  async (signal) => {
    const { emit } = await initialize();
    const first = emit();
    await vi.advanceTimersByTimeAsync(6000);
    if (signal === "span") trace.getTracer("session-test").startSpan("activity").end();
    else logs.getLogger("session-test").emit({ eventName: "activity" });
    await vi.advanceTimersByTimeAsync(1799_999);
    expect(JSON.parse(localStorage.getItem(storageKey)!).id).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(emit()).not.toBe(first);
  },
);

it("preserves a span's start ID when the session renews after inactivity", async () => {
  const { emit, spans } = await initialize();
  const id = emit();
  const span = trace.getTracer("session-test").startSpan("long");
  await vi.advanceTimersByTimeAsync(1800_000);
  expect(emit()).not.toBe(id);
  span.end();
  expect(spans[1].attributes["session.id"]).toBe(id);
});

it("keeps an active session beyond 24 hours without a maximum lifetime", async () => {
  const { emit } = await initialize();
  const id = emit();
  for (let interval = 0; interval < 75; interval++) {
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(emit()).toBe(id);
  }
});

it.each(["getter", "read", "write", "missing"])(
  "warns once and retains an in-memory session when storage is unavailable (%s)",
  async (failure) => {
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    if (failure === "missing") vi.stubGlobal("localStorage", undefined);
    else if (failure === "getter") {
      vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      });
    } else {
      vi.spyOn(Storage.prototype, failure === "read" ? "getItem" : "setItem").mockImplementation(
        () => {
          throw new DOMException(
            "denied",
            failure === "read" ? "SecurityError" : "QuotaExceededError",
          );
        },
      );
    }
    const { emit } = await initialize();
    const id = emit();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(emit()).toBe(id);
    await vi.advanceTimersByTimeAsync(1800_000);
    expect(emit()).not.toBe(id);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Session storage unavailable; using an in-memory session.",
    );
  },
);

it.each(["getItem", "setItem"] as const)(
  "does not mask unexpected storage errors or start providers on %s failure",
  async (operation) => {
    const failure = new Error("unexpected storage failure");
    vi.spyOn(Storage.prototype, operation).mockImplementation(() => {
      throw failure;
    });
    await expect(useMicrosoftOpenTelemetry({ session: { enabled: true } })).rejects.toBe(failure);
    expect(startBrowserSdk).not.toHaveBeenCalled();
  },
);

it("stops session timers on SDK startup failure", async () => {
  const failure = new Error("SDK startup failed");
  vi.mocked(startBrowserSdk).mockImplementationOnce(() => {
    throw failure;
  });
  await expect(useMicrosoftOpenTelemetry({ session: { enabled: true } })).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops session timers even when instrumentation and SDK shutdown fail", async () => {
  const sdkFailure = new Error("SDK shutdown failed");
  const instrumentationFailure = new Error("disable failed");
  vi.mocked(startBrowserSdk).mockReturnValueOnce({
    shutdown: vi.fn().mockRejectedValue(sdkFailure),
  });
  const handle = await useMicrosoftOpenTelemetry({
    session: { enabled: true },
    pageView: { enabled: false },
    instrumentations: [
      {
        setTracerProvider() {},
        getConfig: () => ({ enabled: true }),
        enable() {},
        disable() {
          throw instrumentationFailure;
        },
      },
    ],
  });
  const shutdown = handle.shutdown();
  expect(handle.shutdown()).toBe(shutdown);
  await expect(shutdown).rejects.toMatchObject({
    errors: [instrumentationFailure, sdkFailure],
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up session timers when instrumentation initialization rolls back", async () => {
  const failure = new Error("enable failed");
  await expect(
    useMicrosoftOpenTelemetry({
      session: { enabled: true },
      spanProcessors: [],
      logRecordProcessors: [],
      instrumentations: [
        {
          setTracerProvider() {},
          getConfig: () => ({ enabled: false }),
          enable() {
            throw failure;
          },
          disable() {},
        },
      ],
    }),
  ).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});

it("stale tracer and logger handles do not restart session timers after shutdown", async () => {
  const { handle } = await initialize();
  const tracer = trace.getTracer("stale");
  const logger = logs.getLogger("stale");
  await handle.shutdown();
  await vi.advanceTimersByTimeAsync(6000);
  tracer.startSpan("after-shutdown").end();
  logger.emit({ eventName: "after-shutdown" });
  expect(vi.getTimerCount()).toBe(0);
});

it("stops session timers and persistence before pending provider shutdown completes", async () => {
  let finishShutdown!: () => void;
  const deferred = new Promise<void>((resolve) => {
    finishShutdown = resolve;
  });
  const providerShutdown = vi.fn(() => deferred);
  const { handle, emit } = await initialize(providerShutdown);
  emit();
  const tracer = trace.getTracer("stale");
  const logger = logs.getLogger("stale");
  const write = vi.spyOn(Storage.prototype, "setItem");
  const shutdown = handle.shutdown();
  let completed = false;
  void shutdown.then(() => {
    completed = true;
  });
  try {
    expect(providerShutdown).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 1800_000);
    tracer.startSpan("during-shutdown").end();
    logger.emit({ eventName: "during-shutdown" });
    expect(vi.getTimerCount()).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(completed).toBe(false);
  } finally {
    finishShutdown();
    await shutdown;
  }
});

it("stops session timers while failed initialization waits for provider shutdown", async () => {
  let finishShutdown!: () => void;
  const deferred = new Promise<void>((resolve) => {
    finishShutdown = resolve;
  });
  let notifyShutdownStarted!: () => void;
  const shutdownStarted = new Promise<void>((resolve) => {
    notifyShutdownStarted = resolve;
  });
  const failure = new Error("enable failed");
  const disableFailure = new Error("disable failed");
  const report = vi.spyOn(diag, "error").mockImplementation(() => {});
  const initialization = useMicrosoftOpenTelemetry({
    session: { enabled: true },
    pageView: { enabled: false },
    spanProcessors: [
      {
        onStart() {},
        onEnd() {},
        async forceFlush() {},
        shutdown() {
          notifyShutdownStarted();
          return deferred;
        },
      },
    ],
    logRecordProcessors: [
      {
        onEmit() {},
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    instrumentations: [
      {
        setTracerProvider() {},
        getConfig: () => ({ enabled: false }),
        enable() {
          throw failure;
        },
        disable() {
          throw disableFailure;
        },
      },
    ],
  });
  const rejected = expect(initialization).rejects.toBe(failure);
  try {
    await shutdownStarted;
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 1800_000);
    trace.getTracer("rollback").startSpan("after-rollback").end();
    logs.getLogger("rollback").emit({ eventName: "after-rollback" });
    expect(vi.getTimerCount()).toBe(0);
    expect(write).not.toHaveBeenCalled();
  } finally {
    finishShutdown();
    await rejected;
  }
  expect(report).toHaveBeenCalledExactlyOnceWith(
    "Telemetry initialization cleanup failed",
    disableFailure,
  );
});
