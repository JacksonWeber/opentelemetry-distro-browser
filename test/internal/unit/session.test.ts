// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { noopLoggerProvider, noopTracerProvider } from "../../../src/routing/instanceRouter.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";
import { WRITE_BACKOFF_MS } from "../../../src/storage/keyValueStorage.js";

vi.mock("../../../src/routing/telemetryInstance.js", { spy: true });

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
  vi.mocked(startTelemetryInstance).mockClear();
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
  options: Pick<
    MicrosoftOpenTelemetryBrowserOptions,
    | "session"
    | "resource"
    | "samplingPercentage"
    | "sessionRenewalMs"
    | "sessionExpirationMs"
    | "storage"
    | "userContext"
  > = {},
) {
  const spans: Span[] = [];
  const records: ReadWriteLogRecord[] = [];
  const handle = await useMicrosoftOpenTelemetry({
    ...options,
    userContext: options.userContext ?? { enabled: false },
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

it.each(["native", "alias"] as const)(
  "captures inherited startup %s lifetime getters once and applies runtime updates afterward",
  async (kind) => {
    const inactivity = vi.fn(() => (kind === "alias" ? 1000 : 1));
    const maximum = vi.fn(() => (kind === "alias" ? 2000 : 2));
    const native = Object.create(null) as { inactivityTimeout?: number; maxDuration?: number };
    if (kind === "native") {
      Object.setPrototypeOf(native, {
        get inactivityTimeout() {
          return inactivity();
        },
        get maxDuration() {
          return maximum();
        },
      });
    }
    class Options {
      session = native;
      storage = { enabled: false };
      userContext = { enabled: false };
      pageView = { enabled: false };
      spanProcessors: MicrosoftOpenTelemetryBrowserOptions["spanProcessors"];
      get sessionRenewalMs() {
        return kind === "alias" ? inactivity() : undefined;
      }
      get sessionExpirationMs() {
        return kind === "alias" ? maximum() : undefined;
      }
    }
    const spans: Span[] = [];
    const options = new Options();
    options.spanProcessors = [
      {
        onStart: (span) => {
          spans.push(span);
        },
        onEnd() {},
        async forceFlush() {},
        async shutdown() {},
      },
    ];
    const handle = await useMicrosoftOpenTelemetry(options);
    handles.add(handle);
    const emit = () => {
      trace.getTracer("startup-getters").startSpan("activity").end();
      return spans.at(-1)?.attributes["session.id"];
    };
    const id = emit();
    await vi.advanceTimersByTimeAsync(1000);
    await handle.updateCfg({ session: { inactivityTimeout: 3, maxDuration: 4 } });
    expect(emit()).toBe(id);
    await vi.advanceTimersByTimeAsync(3000);
    expect(emit()).not.toBe(id);
    expect(inactivity).toHaveBeenCalledOnce();
    expect(maximum).toHaveBeenCalledOnce();
  },
);

it("rejects explicitly reset native lifetimes that conflict with startup aliases", async () => {
  const access = vi.spyOn(window, "localStorage", "get");
  await expect(
    useMicrosoftOpenTelemetry({
      session: { inactivityTimeout: undefined },
      sessionRenewalMs: 1000,
    }),
  ).rejects.toThrow("Conflicting configuration paths");
  expect(access).not.toHaveBeenCalled();
});

it("generates and persists the same session ID by default", async () => {
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

it("uses fresh memory-only sessions without touching storage when persistence consent is absent", async () => {
  const stored = JSON.stringify({ id: "previous", startTimestamp: Date.now() });
  localStorage.setItem(storageKey, stored);
  const access = vi.spyOn(window, "localStorage", "get");
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const options = { session: { persist: false, inactivityTimeout: 1 } };
  const first = await initialize(undefined, options);
  const id = first.emit();
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(first.emit()).toBe(id);
  await vi.advanceTimersByTimeAsync(1000);
  const renewed = first.emit();
  expect(renewed).not.toBe(id);
  await first.handle.shutdown();
  resetApis();
  const second = await initialize(undefined, options);
  expect(second.emit()).not.toBe(renewed);
  expect(access).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  access.mockRestore();
  expect(localStorage.getItem(storageKey)).toBe(stored);
});

it.each(["inactivityTimeout", "maxDuration"] as const)(
  "rejects invalid %s before accessing storage or creating exporters and providers",
  async (option) => {
    const access = vi.spyOn(window, "localStorage", "get");
    for (const value of [-1, NaN, Infinity, -Infinity, null, "10"]) {
      await expect(
        useMicrosoftOpenTelemetry({
          session: { enabled: true, [option]: value },
          azureMonitor: { connectionString: "invalid" },
        }),
      ).rejects.toThrow(`session.${option} must be a finite, nonnegative number of seconds.`);
    }
    expect(access).not.toHaveBeenCalled();
    expect(startTelemetryInstance).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("rejects invalid persistence configuration rather than enabling storage", async () => {
  const access = vi.spyOn(window, "localStorage", "get");
  await expect(
    useMicrosoftOpenTelemetry({
      // @ts-expect-error Exercise untyped JavaScript input.
      session: { enabled: true, persist: "false" },
    }),
  ).rejects.toThrow("session.persist must be a boolean.");
  expect(access).not.toHaveBeenCalled();
  expect(startTelemetryInstance).not.toHaveBeenCalled();
});

it.each([false, true])(
  "checks the exact inactivity boundary without waiting for timers (persist=%s)",
  async (persist) => {
    const { emit } = await initialize(undefined, {
      session: { enabled: true, persist, inactivityTimeout: 0.5 },
    });
    const id = emit();
    vi.setSystemTime(Date.now() + 499);
    expect(emit()).toBe(id);
    vi.setSystemTime(Date.now() + 500);
    expect(emit()).not.toBe(id);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["span", "log"])(
  "every %s refreshes short inactivity windows without a five-second debounce",
  async (signal) => {
    const { emit } = await initialize(undefined, {
      session: { enabled: true, inactivityTimeout: 1 },
    });
    const id = emit();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(900);
      if (signal === "span") trace.getTracer("activity").startSpan("activity").end();
      else logs.getLogger("activity").emit({ eventName: "activity" });
    }
    expect(emit()).toBe(id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(emit()).not.toBe(id);
  },
);

it.each([false, true])(
  "enforces maximum lifetime despite continuous activity (persist=%s)",
  async (persist) => {
    const { emit, spans } = await initialize(undefined, {
      session: { enabled: true, persist, inactivityTimeout: 1, maxDuration: 2 },
    });
    const id = emit();
    const span = trace.getTracer("session-test").startSpan("long");
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(500);
      expect(emit()).toBe(id);
    }
    vi.setSystemTime(Date.now() + 499);
    expect(emit()).toBe(id);
    vi.setSystemTime(Date.now() + 1);
    const renewed = emit();
    expect(renewed).not.toBe(id);
    span.end();
    expect(spans[1].attributes["session.id"]).toBe(id);
    expect(emit()).toBe(renewed);
  },
);

it.each([false, true])(
  "enforces the default 24-hour lifetime at the exact boundary (reload=%s)",
  async (reload) => {
    const start = Date.now();
    const first = await initialize();
    const id = first.emit();
    // Keep the session active so the default inactivity timeout cannot expire it first.
    for (let minute = 1; minute < 24 * 60; minute++) {
      vi.setSystemTime(start + minute * 60_000);
      expect(first.emit()).toBe(id);
    }
    vi.setSystemTime(start + 24 * 60 * 60_000 - 1);
    expect(first.emit()).toBe(id);
    let current = first;
    if (reload) {
      await first.handle.shutdown();
      handles.delete(first.handle);
      resetApis();
      current = await initialize();
      expect(current.emit()).toBe(id);
    }
    vi.setSystemTime(start + 24 * 60 * 60_000);
    const renewed = current.emit();
    expect(renewed).not.toBe(id);
    expect(renewed).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ id: renewed });
  },
);

it.each([30 * 60_000 - 1, 30 * 60_000, 30 * 60_000 + 1])(
  "enforces the default 30-minute inactivity timeout across reloads (%i ms)",
  async (idleMs) => {
    const first = await initialize();
    const id = first.emit();
    await first.handle.shutdown();
    handles.delete(first.handle);
    resetApis();
    vi.setSystemTime(Date.now() + idleMs);
    const restored = await initialize();
    if (idleMs < 30 * 60_000) expect(restored.emit()).toBe(id);
    else expect(restored.emit()).not.toBe(id);
  },
);

it.each([24 * 60 * 60_000 - 1, 24 * 60 * 60_000, 24 * 60 * 60_000 + 1])(
  "enforces the default maximum lifetime when restoring recent activity (%i ms)",
  async (age) => {
    vi.setSystemTime(age + 1_000_000);
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        id: "restored",
        startTimestamp: Date.now() - age,
        lastActivityTimestamp: Date.now() - 1,
      }),
    );
    const { emit } = await initialize();
    if (age < 24 * 60 * 60_000) expect(emit()).toBe("restored");
    else expect(emit()).not.toBe("restored");
  },
);

it.each([1999, 2000, 2001])(
  "enforces configured maximum lifetime across reloads (%i ms)",
  async (age) => {
    const options = { session: { enabled: true, inactivityTimeout: 1, maxDuration: 2 } };
    const first = await initialize(undefined, options);
    const id = first.emit();
    await vi.advanceTimersByTimeAsync(750);
    expect(first.emit()).toBe(id);
    await vi.advanceTimersByTimeAsync(750);
    expect(first.emit()).toBe(id);
    await first.handle.shutdown();
    resetApis();
    vi.setSystemTime(Date.now() + age - 1500);
    const second = await initialize(undefined, options);
    if (age < 2000) expect(second.emit()).toBe(id);
    else expect(second.emit()).not.toBe(id);
  },
);

it.each([499, 500, 501])(
  "enforces configured inactivity across reloads (%i ms)",
  async (idleMs) => {
    const options = { session: { enabled: true, inactivityTimeout: 0.5 } };
    const first = await initialize(undefined, options);
    const id = first.emit();
    await first.handle.shutdown();
    resetApis();
    vi.setSystemTime(Date.now() + idleMs);
    const second = await initialize(undefined, options);
    if (idleMs < 500) expect(second.emit()).toBe(id);
    else expect(second.emit()).not.toBe(id);
  },
);

it.each(["inactivityTimeout", "maxDuration"] as const)(
  "restoring a session does not restart its remaining %s window",
  async (option) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        id: "restored",
        startTimestamp: Date.now() - 1500,
        lastActivityTimestamp: Date.now() - 1500,
      }),
    );
    const { emit } = await initialize(undefined, {
      session: { enabled: true, [option]: 2 },
    });
    vi.setSystemTime(Date.now() + 500);
    expect(emit()).not.toBe("restored");
  },
);

it.each([0, 1])(
  "zero disables inactivity expiration independently of maximum lifetime (%i)",
  async (maxDuration) => {
    const options = { session: { enabled: true, inactivityTimeout: 0, maxDuration } };
    const first = await initialize(undefined, options);
    const id = first.emit();
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    if (maxDuration === 0) expect(first.emit()).toBe(id);
    else expect(first.emit()).not.toBe(id);
    const current = first.emit();
    await first.handle.shutdown();
    resetApis();
    const second = await initialize(undefined, options);
    expect(second.emit()).toBe(current);
  },
);

it("captures session configuration before asynchronous initialization", async () => {
  const session = { enabled: true, persist: false, inactivityTimeout: 1, maxDuration: 2 };
  const access = vi.spyOn(window, "localStorage", "get");
  const pending = initialize(undefined, { session });
  session.persist = true;
  session.inactivityTimeout = 0;
  session.maxDuration = 0;
  const { emit } = await pending;
  const id = emit();
  vi.setSystemTime(Date.now() + 1000);
  expect(emit()).not.toBe(id);
  expect(access).not.toHaveBeenCalled();
});

it.each([2999, 3000])(
  "shortens inactivity on next activity without update-time storage or timestamp changes (%i ms idle)",
  async (idleMs) => {
    const { handle, emit } = await initialize(undefined, {
      session: { inactivityTimeout: 10, maxDuration: 0 },
    });
    const started = Date.now();
    const id = emit();
    vi.setSystemTime(started + 1000);
    expect(emit()).toBe(id);
    const stored = localStorage.getItem(storageKey);
    vi.setSystemTime(started + 1000 + idleMs);
    const access = vi.spyOn(window, "localStorage", "get");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    await handle.updateCfg({ session: { inactivityTimeout: 3 } });
    expect(access).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(localStorage.getItem(storageKey)).toBe(stored);
    expect(JSON.parse(stored!)).toEqual({
      id,
      startTimestamp: started,
      lastActivityTimestamp: started + 1000,
    });
    const next = emit();
    if (idleMs < 3000) expect(next).toBe(id);
    else expect(next).not.toBe(id);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
      id: next,
      startTimestamp: idleMs < 3000 ? started : Date.now(),
      lastActivityTimestamp: Date.now(),
    });
  },
);

it("extends inactivity even after the old limit elapsed without restarting the activity window", async () => {
  const { handle, emit } = await initialize(undefined, {
    session: { inactivityTimeout: 1, maxDuration: 0 },
  });
  const started = Date.now();
  const id = emit();
  vi.setSystemTime(started + 500);
  expect(emit()).toBe(id);
  vi.setSystemTime(started + 2000);
  const access = vi.spyOn(window, "localStorage", "get");
  const read = vi.spyOn(Storage.prototype, "getItem");
  const write = vi.spyOn(Storage.prototype, "setItem");
  await handle.updateCfg({ session: { inactivityTimeout: 3 } });
  expect(access).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    id,
    startTimestamp: started,
    lastActivityTimestamp: started + 500,
  });
  vi.setSystemTime(started + 3499);
  expect(emit()).toBe(id);
  vi.setSystemTime(started + 6499);
  expect(emit()).not.toBe(id);
});

it.each(["shorten", "extend"] as const)(
  "%s maximum duration relative to creation time independently of recent activity",
  async (change) => {
    const { handle, emit } = await initialize(undefined, {
      session: { inactivityTimeout: 1, maxDuration: change === "shorten" ? 10 : 1 },
    });
    const started = Date.now();
    const id = emit();
    vi.setSystemTime(started + 750);
    expect(emit()).toBe(id);
    vi.setSystemTime(started + 1500);
    const access = vi.spyOn(window, "localStorage", "get");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    await handle.updateCfg({ session: { maxDuration: change === "shorten" ? 1 : 3 } });
    expect(access).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
      id,
      startTimestamp: started,
      lastActivityTimestamp: started + 750,
    });
    vi.setSystemTime(started + 1600);
    if (change === "shorten") {
      expect(emit()).not.toBe(id);
    } else {
      expect(emit()).toBe(id);
      vi.setSystemTime(started + 2400);
      expect(emit()).toBe(id);
      vi.setSystemTime(started + 2999);
      expect(emit()).toBe(id);
      vi.setSystemTime(started + 3000);
      expect(emit()).not.toBe(id);
    }
  },
);

it.each(["inactivityTimeout", "maxDuration"] as const)(
  "native zero disables runtime %s expiration rather than restoring the default",
  async (field) => {
    const { handle, emit } = await initialize(undefined, {
      session: { inactivityTimeout: 0, maxDuration: 0, [field]: 1 },
    });
    const id = emit();
    vi.setSystemTime(Date.now() + 2000);
    await handle.updateCfg({ session: { [field]: 0 } });
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    expect(emit()).toBe(id);
    await handle.updateCfg({ session: { [field]: 1 } });
    vi.setSystemTime(Date.now() + 1000);
    expect(emit()).not.toBe(id);
  },
);

const lifetimes = [
  { field: "inactivityTimeout", alias: "sessionRenewalMs", defaultSeconds: 1800 },
  { field: "maxDuration", alias: "sessionExpirationMs", defaultSeconds: 86400 },
] as const;

it.each(lifetimes)(
  "resets $field through native or session undefined and alias zero or undefined using existing timestamps",
  async ({ field, alias, defaultSeconds }) => {
    const { handle, emit } = await initialize(undefined, {
      session: { inactivityTimeout: 0, maxDuration: 0 },
    });
    // Each reset starts with unlimited lifetimes, not a newly created session at update time.
    for (const patch of [
      { session: { [field]: undefined } },
      { session: undefined },
      { [alias]: 0 },
      { [alias]: undefined },
    ]) {
      await handle.updateCfg({ session: { inactivityTimeout: 0, maxDuration: 0 } });
      const started = Date.now();
      const id = emit();
      vi.setSystemTime(started + defaultSeconds * 1000 - 1);
      if (field === "maxDuration") expect(emit()).toBe(id);
      await handle.updateCfg(patch);
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
        id,
        startTimestamp: started,
        lastActivityTimestamp: field === "maxDuration" ? Date.now() : started,
      });
      vi.setSystemTime(started + defaultSeconds * 1000);
      expect(emit()).not.toBe(id);
    }
  },
);

it("merges omissions without resetting sampling or the other session lifetime", async () => {
  const { handle, emit, spans } = await initialize(undefined, {
    samplingPercentage: 100,
    session: { persist: false, inactivityTimeout: 1, maxDuration: 2 },
  });
  const started = Date.now();
  const id = emit();
  expect(await handle.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  await handle.updateCfg({ session: { maxDuration: 0 } });
  const unsampledParent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "00000000000000000000000000000001",
    spanId: "0000000000000001",
    traceFlags: 0,
  });
  trace.getTracer("session-merge").startSpan("still-explicit-100", {}, unsampledParent).end();
  expect(spans.at(-1)?.name).toBe("still-explicit-100");
  vi.setSystemTime(started + 999);
  expect(emit()).toBe(id);
  await handle.updateCfg({ samplingPercentage: 100 });
  vi.setSystemTime(started + 1999);
  expect(emit()).not.toBe(id);
});

it.each(lifetimes)(
  "replacement resets sampling and omitted $field without resetting timestamps",
  async ({ field, defaultSeconds }) => {
    const { handle, emit, spans } = await initialize(undefined, {
      samplingPercentage: 100,
      session: { inactivityTimeout: 0, maxDuration: 0 },
    });
    const other = field === "inactivityTimeout" ? "maxDuration" : "inactivityTimeout";
    // Cover both an empty replacement and a replacement with a partial session object.
    for (const patch of [{}, { session: { [other]: 0 } }]) {
      await handle.updateCfg({
        samplingPercentage: 100,
        session: { inactivityTimeout: 0, maxDuration: 0 },
      });
      const started = Date.now();
      const id = emit();
      vi.setSystemTime(started + defaultSeconds * 1000 - 1);
      if (field === "maxDuration") expect(emit()).toBe(id);
      const stored = localStorage.getItem(storageKey);
      await handle.updateCfg(patch, false);
      expect(localStorage.getItem(storageKey)).toBe(stored);
      const count = spans.length;
      trace
        .getTracer("session-replacement")
        .startSpan(
          "default-unsampled-parent",
          {},
          trace.setSpanContext(ROOT_CONTEXT, {
            traceId: "00000000000000000000000000000001",
            spanId: "0000000000000001",
            traceFlags: 0,
          }),
        )
        .end();
      expect(spans).toHaveLength(count);
      vi.setSystemTime(started + defaultSeconds * 1000);
      expect(emit()).not.toBe(id);
    }
  },
);

it.each(lifetimes)(
  "preserves fractional $alias milliseconds at startup and runtime and accepts equivalent native values",
  async ({ field, alias }) => {
    const { handle, emit } = await initialize(undefined, {
      session: {
        persist: false,
        [field === "inactivityTimeout" ? "maxDuration" : "inactivityTimeout"]: 0,
      },
      [alias]: 500.5,
    });
    const id = emit();
    vi.setSystemTime(Date.now() + 500);
    expect(emit()).toBe(id);
    vi.setSystemTime(Date.now() + (field === "maxDuration" ? 1 : 501));
    const renewed = emit();
    expect(renewed).not.toBe(id);
    await handle.updateCfg({ [alias]: 2000.5 });
    vi.setSystemTime(Date.now() + 2000);
    expect(emit()).toBe(renewed);
    expect(await handle.updateCfg({ session: { [field]: 2.0005 }, [alias]: 2000.5 })).toMatchObject(
      {
        changedPaths: [],
      },
    );
    vi.setSystemTime(Date.now() + 2001);
    expect(emit()).not.toBe(renewed);
  },
);

it.each(lifetimes)(
  "startup $alias zero and undefined restore defaults rather than disabling expiration",
  async ({ field, alias, defaultSeconds }) => {
    for (const value of [0, undefined]) {
      const started = Date.now();
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          id: "alias-default",
          startTimestamp: started,
          lastActivityTimestamp: started,
        }),
      );
      vi.setSystemTime(started + defaultSeconds * 1000 - 1);
      const current = await initialize(undefined, {
        session: { [field === "inactivityTimeout" ? "maxDuration" : "inactivityTimeout"]: 0 },
        [alias]: value,
      });
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
        id: "alias-default",
        lastActivityTimestamp: started,
      });
      vi.setSystemTime(started + defaultSeconds * 1000);
      expect(current.emit()).not.toBe("alias-default");
      await current.handle.shutdown();
    }
  },
);

it.each(lifetimes)(
  "rejects conflicting $alias and native values before startup or any runtime sampling mutation",
  async ({ field, alias, defaultSeconds }) => {
    const access = vi.spyOn(window, "localStorage", "get");
    // Native zero means unlimited; alias zero means the default, so equal raw zeros conflict.
    for (const [native, milliseconds] of [
      [1, 2000],
      [0, 0],
    ]) {
      await expect(
        initialize(undefined, {
          session: { [field]: native },
          [alias]: milliseconds,
        }),
      ).rejects.toThrow();
    }
    expect(access).not.toHaveBeenCalled();
    expect(startTelemetryInstance).not.toHaveBeenCalled();
    const equivalent = await initialize(undefined, {
      session: { persist: false, [field]: defaultSeconds },
      [alias]: 0,
    });
    await equivalent.handle.shutdown();
    const { handle, emit, spans } = await initialize(undefined, {
      samplingPercentage: 100,
      session: { persist: false, inactivityTimeout: 10, maxDuration: 10 },
    });
    const id = emit();
    for (const [native, milliseconds] of [
      [1, 2000],
      [0, 0],
    ]) {
      await expect(
        handle.updateCfg({
          samplingPercentage: 0,
          session: { [field]: native },
          [alias]: milliseconds,
        }),
      ).rejects.toThrow();
      expect(await handle.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
    }
    vi.setSystemTime(Date.now() + 1500);
    const count = spans.length;
    expect(emit()).toBe(id);
    expect(spans).toHaveLength(count + 1);
    await handle.updateCfg({ session: { [field]: defaultSeconds }, [alias]: 0 });
  },
);

it.each([
  { session: { enabled: false } },
  { session: { persist: false } },
  { storage: { enabled: false } },
  { storage: { namePrefix: "runtime-" } },
])("rejects startup-only updates atomically (%j)", async (startupOnly) => {
  const { handle, emit, spans } = await initialize(undefined, {
    session: { inactivityTimeout: 10, maxDuration: 10 },
  });
  const id = emit();
  const write = vi.spyOn(Storage.prototype, "setItem");
  await expect(
    handle.updateCfg({
      ...startupOnly,
      samplingPercentage: 0,
      session: { inactivityTimeout: 1, ...startupOnly.session },
    } as MicrosoftOpenTelemetryBrowserConfigurationUpdate),
  ).rejects.toThrow();
  expect(await handle.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  expect(write).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 1500);
  expect(emit()).toBe(id);
  expect(spans).toHaveLength(2);
});

it.each(["session-disabled", "memory-only", "storage-disabled"] as const)(
  "updates lifetimes without accessing storage or changing startup consent (%s)",
  async (mode) => {
    const stored = JSON.stringify({ id: "previous", startTimestamp: Date.now() });
    localStorage.setItem(storageKey, stored);
    const user = localStorage.getItem("opentelemetry-user");
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    const cookie = vi.spyOn(document, "cookie", "get");
    const cookieWrite = vi.spyOn(document, "cookie", "set");
    const { handle, emit, spans, records } = await initialize(undefined, {
      session: {
        enabled: mode !== "session-disabled",
        persist: mode !== "memory-only",
        inactivityTimeout: 10,
      },
      storage: { enabled: mode !== "storage-disabled" },
      userContext: { enabled: mode === "storage-disabled" },
    });
    const id = emit();
    if (mode === "session-disabled") expect(id).toBeUndefined();
    else {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toBe("previous");
    }
    await handle.updateCfg({ session: { inactivityTimeout: 1, maxDuration: 0 } });
    vi.setSystemTime(Date.now() + 1000);
    const renewed = emit();
    if (mode === "session-disabled") expect(renewed).toBeUndefined();
    else expect(renewed).not.toBe(id);
    await handle.updateCfg({ sessionRenewalMs: 0, sessionExpirationMs: undefined });
    if (mode === "storage-disabled") {
      handle.userContext.setEnabled(true);
      handle.userContext.setAuthenticatedUserContext("memory-user", "memory-account");
      emit();
      for (const record of [spans.at(-1)!, records.at(-1)!]) {
        expect(record.attributes["user.id"]).toBe("memory-user");
        expect(record.attributes["user.account.id"]).toBe("memory-account");
        expect(record.attributes["enduser.pseudo.id"]).toBeUndefined();
      }
      handle.userContext.clearAuthenticatedUserContext();
      handle.userContext.setEnabled(false);
      emit();
      for (const record of [spans.at(-1)!, records.at(-1)!]) {
        expect(record.attributes["user.id"]).toBeUndefined();
        expect(record.attributes["user.account.id"]).toBeUndefined();
        expect(record.attributes["enduser.pseudo.id"]).toBeUndefined();
      }
    }
    await handle.updateCfg({}, false);
    expect(emit()).toBe(renewed);
    await handle.shutdown();
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
    expect(cookieWrite).not.toHaveBeenCalled();
    local.mockRestore();
    read.mockRestore();
    expect(localStorage.getItem(storageKey)).toBe(stored);
    expect(localStorage.getItem("opentelemetry-user")).toBe(user);
  },
);

it("keeps cached tracers and loggers on their own instance's mutable session lifetimes", async () => {
  const first = await initialize(undefined, {
    session: { persist: false, inactivityTimeout: 1, maxDuration: 0 },
  });
  const firstTracer = trace.getTracer("first-session");
  const firstLogger = logs.getLogger("first-session");
  const second = await initialize(undefined, {
    session: { persist: false, inactivityTimeout: 10, maxDuration: 0 },
  });
  const instance = await vi.mocked(startTelemetryInstance).mock.results.at(-1)!.value;
  const secondTracer = instance.tracerProvider.getTracer("second-session");
  const secondLogger = instance.loggerProvider.getLogger("second-session");
  function emitBoth() {
    firstTracer.startSpan("first").end();
    firstLogger.emit({ eventName: "first" });
    secondTracer.startSpan("second").end();
    secondLogger.emit({ eventName: "second" });
    for (const current of [first, second]) {
      expect(current.records.at(-1)?.attributes["session.id"]).toBe(
        current.spans.at(-1)?.attributes["session.id"],
      );
    }
    return [
      first.spans.at(-1)!.attributes["session.id"],
      second.spans.at(-1)!.attributes["session.id"],
    ];
  }
  const [firstId, secondId] = emitBoth();
  expect(firstId).not.toBe(secondId);
  vi.setSystemTime(Date.now() + 750);
  await first.handle.updateCfg({ session: { inactivityTimeout: 0.5 } });
  const [renewedFirst, retainedSecond] = emitBoth();
  expect(renewedFirst).not.toBe(firstId);
  expect(retainedSecond).toBe(secondId);
  await first.handle.updateCfg({ session: { inactivityTimeout: 0 } });
  vi.setSystemTime(Date.now() + 750);
  await second.handle.updateCfg({ session: { maxDuration: 1 } });
  const [retainedFirst, renewedSecond] = emitBoth();
  expect(retainedFirst).toBe(renewedFirst);
  expect(renewedSecond).not.toBe(secondId);
  expect(first.spans).toHaveLength(3);
  expect(second.spans).toHaveLength(3);
});

it("isolates persisted sessions and runtime lifetimes under independent storage name prefixes", async () => {
  const prefix = `runtime-session-${crypto.randomUUID()}-`;
  const firstPrefix = `${prefix}first-`;
  const secondPrefix = `${prefix}second-`;
  const keys = [firstPrefix + storageKey, secondPrefix + storageKey];
  const started = Date.now();
  for (const [index, key] of keys.entries()) {
    localStorage.setItem(
      key,
      JSON.stringify({
        id: `restored-${index}`,
        startTimestamp: started - 1500,
        lastActivityTimestamp: started - 500,
      }),
    );
  }
  try {
    const first = await initialize(undefined, {
      session: { inactivityTimeout: 10, maxDuration: 0 },
      storage: { namePrefix: firstPrefix },
    });
    const second = await initialize(undefined, {
      session: { inactivityTimeout: 10, maxDuration: 0 },
      storage: { namePrefix: secondPrefix },
    });
    const instance = await vi.mocked(startTelemetryInstance).mock.results.at(-1)!.value;
    const tracer = instance.tracerProvider.getTracer("prefixed-session");
    const logger = instance.loggerProvider.getLogger("prefixed-session");
    function emitSecond() {
      tracer.startSpan("second").end();
      logger.emit({ eventName: "second" });
      const id = second.spans.at(-1)?.attributes["session.id"];
      expect(second.records.at(-1)?.attributes["session.id"]).toBe(id);
      return id;
    }
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    await first.handle.updateCfg({ session: { maxDuration: 1 } });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    const firstId = first.emit();
    expect(firstId).not.toBe("restored-0");
    expect(emitSecond()).toBe("restored-1");
    vi.setSystemTime(started + 500);
    read.mockClear();
    write.mockClear();
    await second.handle.updateCfg({ sessionRenewalMs: 500 });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(first.emit()).toBe(firstId);
    const secondId = emitSecond();
    expect(secondId).not.toBe("restored-1");
    expect(secondId).not.toBe(firstId);
    expect(write.mock.calls.map(([key]) => key)).toEqual(keys);
    expect(JSON.parse(localStorage.getItem(keys[0])!)).toEqual({
      id: firstId,
      startTimestamp: started,
      lastActivityTimestamp: started + 500,
    });
    expect(JSON.parse(localStorage.getItem(keys[1])!)).toEqual({
      id: secondId,
      startTimestamp: started + 500,
      lastActivityTimestamp: started + 500,
    });
  } finally {
    await Promise.all([...handles].map((handle) => handle.shutdown()));
    for (const key of keys) localStorage.removeItem(key);
  }
});

it("rejects queued and future lifetime updates after shutdown without restarting session storage", async () => {
  const { handle, emit, spans, records } = await initialize();
  emit();
  await handle.updateCfg({ session: { inactivityTimeout: 0.5, maxDuration: 1 } });
  const tracer = trace.getTracer("stopped-session");
  const logger = logs.getLogger("stopped-session");
  const stored = localStorage.getItem(storageKey);
  const access = vi.spyOn(window, "localStorage", "get");
  const write = vi.spyOn(Storage.prototype, "setItem");
  const read = vi.spyOn(Storage.prototype, "getItem");
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const queued = Promise.allSettled([
    handle.updateCfg({ sessionRenewalMs: 1000 }),
    handle.updateCfg({ session: { maxDuration: 0 } }),
  ]);
  const shutdown = handle.shutdown();
  for (const result of await queued) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toMatchObject({ message: /stopped/ });
  }
  await shutdown;
  await expect(handle.updateCfg({ session: { inactivityTimeout: 0 } })).rejects.toThrow("stopped");
  vi.setSystemTime(Date.now() + 2 * 86400_000);
  tracer.startSpan("after-shutdown").end();
  logger.emit({ eventName: "after-shutdown" });
  expect(spans).toHaveLength(1);
  expect(records).toHaveLength(1);
  expect(access).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(localStorage.getItem(storageKey)).toBe(stored);
});

it("renews the session when the clock moves backwards", async () => {
  const { emit } = await initialize();
  const id = emit();
  vi.setSystemTime(Date.now() - 1);
  expect(emit()).not.toBe(id);
});

it.each([undefined, {}, { enabled: true }])(
  "tracks and restores sessions unless explicitly disabled (%j)",
  async (session) => {
    const first = await initialize(undefined, { session });
    const id = first.emit();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ id });
    await first.handle.shutdown();
    handles.delete(first.handle);
    resetApis();

    const restored = await initialize(undefined, { session });
    expect(restored.emit()).toBe(id);
  },
);

it.each([{ enabled: false }])(
  "does not access storage, create timers, or enrich telemetry when disabled (%j)",
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

it("preserves application-provided session IDs after a lifetime update makes managed activity due", async () => {
  const { handle, emit, spans, records } = await initialize(undefined, {
    session: { inactivityTimeout: 10, maxDuration: 0 },
  });
  const managedId = emit();
  const stored = localStorage.getItem(storageKey);
  vi.setSystemTime(Date.now() + 1000);
  await handle.updateCfg({ session: { inactivityTimeout: 1 } });
  const write = vi.spyOn(Storage.prototype, "setItem");
  trace
    .getTracer("application")
    .startSpan("manual", { attributes: { "session.id": "application-span" } })
    .end();
  logs.getLogger("application").emit({ attributes: { "session.id": "application-log" } });
  expect(spans.at(-1)?.attributes["session.id"]).toBe("application-span");
  expect(records.at(-1)?.attributes["session.id"]).toBe("application-log");
  expect(write).not.toHaveBeenCalled();
  expect(localStorage.getItem(storageKey)).toBe(stored);
  const renewed = emit();
  expect(renewed).not.toBe(managedId);
  expect(renewed).not.toBe("application-span");
  expect(renewed).not.toBe("application-log");
});

it("replaces an empty application session ID with managed context", async () => {
  const { spans, records } = await initialize();
  trace
    .getTracer("application")
    .startSpan("manual", { attributes: { "session.id": "" } })
    .end();
  logs.getLogger("application").emit({ attributes: { "session.id": "" } });
  expect(spans.at(-1)?.attributes["session.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(records.at(-1)?.attributes["session.id"]).toBe(spans.at(-1)?.attributes["session.id"]);
});

it.each([undefined, "", 0, false, ["invalid"], "application-record"])(
  "preserves resource session context with record session.id=%j",
  async (id) => {
    const { handle, emit, spans, records } = await initialize(undefined, {
      session: { enabled: true, persist: false, inactivityTimeout: 1, maxDuration: 2 },
      resource: resourceFromAttributes({ "session.id": "application-resource" }),
    });
    await handle.updateCfg({ session: { inactivityTimeout: 0.5, maxDuration: 1 } });
    trace
      .getTracer("application")
      .startSpan("manual", { attributes: { "session.id": id } })
      .end();
    logs.getLogger("application").emit({ attributes: { "session.id": id } });

    for (const record of [...spans, ...records]) {
      expect(record.attributes["session.id"]).toEqual(id);
      expect(record.resource.attributes["session.id"]).toBe("application-resource");
    }

    vi.setSystemTime(Date.now() + 2000);
    expect(emit()).toBeUndefined();
    for (const record of [spans.at(-1)!, records.at(-1)!]) {
      expect(record.resource.attributes["session.id"]).toBe("application-resource");
    }
  },
);

it.each([undefined, "", 0, false, ["invalid"]])(
  "uses managed context only when neither record nor resource has a valid session ID (resource=%j)",
  async (resourceId) => {
    const { emit, spans, records } = await initialize(undefined, {
      session: { enabled: true, persist: false },
      resource: resourceFromAttributes({ "session.id": resourceId }),
    });
    const managedId = emit();
    expect(managedId).toMatch(/^[0-9a-f]{32}$/);
    for (const recordId of [undefined, "", 0, false, ["invalid"]]) {
      trace
        .getTracer("application")
        .startSpan("manual", { attributes: { "session.id": recordId } })
        .end();
      logs.getLogger("application").emit({ attributes: { "session.id": recordId } });
      for (const record of [spans.at(-1)!, records.at(-1)!]) {
        expect(record.attributes["session.id"]).toBe(managedId);
        expect(record.resource.attributes["session.id"]).toEqual(resourceId);
      }
    }
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
    userContext: { enabled: false },
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
  expect(startTelemetryInstance).not.toHaveBeenCalled();
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

it("does not renew or persist idle sessions until telemetry arrives", async () => {
  const first = await initialize();
  const id = first.emit();
  const activity = Date.now();
  const write = vi.spyOn(Storage.prototype, "setItem");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(2 * 1800_000);
  const idleSession = JSON.parse(localStorage.getItem(storageKey)!);
  expect(idleSession.id).toBe(id);
  expect(idleSession.lastActivityTimestamp).toBe(activity);
  await first.handle.shutdown();
  expect(write).not.toHaveBeenCalled();
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

it.each(["QuotaExceededError", "SecurityError"])(
  "resumes session persistence after the %s backoff window",
  async (errorName) => {
    const { emit } = await initialize();
    const id = emit();
    vi.spyOn(diag, "warn").mockImplementation(() => {});
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("unavailable", errorName);
    });
    await vi.advanceTimersByTimeAsync(1000);
    emit();
    await vi.advanceTimersByTimeAsync(1000);
    emit();
    expect(write).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(WRITE_BACKOFF_MS);
    expect(emit()).toBe(id);
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem("opentelemetry-session")!)).toMatchObject({ id });
  },
);

it("does not extend the quota backoff when the clock moves backwards", async () => {
  const { emit } = await initialize();
  vi.spyOn(diag, "warn").mockImplementation(() => {});
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  await vi.advanceTimersByTimeAsync(1000);
  emit();
  expect(write).toHaveBeenCalledOnce();

  vi.setSystemTime(Date.now() - 60 * 60_000);
  await vi.advanceTimersByTimeAsync(1000);
  emit();
  expect(write).toHaveBeenCalledTimes(2);
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
  { id: "invalid", startTimestamp: 1_000_001 },
  { id: "invalid", startTimestamp: 1_000_000, lastActivityTimestamp: 999_999 },
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

it("renews on telemetry after the default 1800 seconds of inactivity", async () => {
  const { emit } = await initialize();
  const first = emit();
  await vi.advanceTimersByTimeAsync(1799_999);
  expect(JSON.parse(localStorage.getItem(storageKey)!).id).toBe(first);
  await vi.advanceTimersByTimeAsync(1);
  const renewed = emit();
  expect(renewed).not.toBe(first);
  expect(JSON.parse(localStorage.getItem(storageKey)!).id).toBe(renewed);
  expect(emit()).toBe(renewed);
});

it.each(["span", "log"])("a %s refreshes the default inactivity window", async (signal) => {
  const { emit } = await initialize();
  const first = emit();
  await vi.advanceTimersByTimeAsync(6000);
  if (signal === "span") trace.getTracer("session-test").startSpan("activity").end();
  else logs.getLogger("session-test").emit({ eventName: "activity" });
  await vi.advanceTimersByTimeAsync(1799_999);
  expect(JSON.parse(localStorage.getItem(storageKey)!).id).toBe(first);
  await vi.advanceTimersByTimeAsync(1);
  expect(emit()).not.toBe(first);
});

it("preserves a span's start ID when the session renews after inactivity", async () => {
  const { emit, spans } = await initialize();
  const id = emit();
  const span = trace.getTracer("session-test").startSpan("long");
  await vi.advanceTimersByTimeAsync(1800_000);
  expect(emit()).not.toBe(id);
  span.end();
  expect(spans[1].attributes["session.id"]).toBe(id);
});

it("keeps an active session beyond 24 hours with maxDuration explicitly set to zero", async () => {
  const { emit } = await initialize(undefined, { session: { maxDuration: 0 } });
  const id = emit();
  for (let interval = 0; interval < 75; interval++) {
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(emit()).toBe(id);
  }
});

it.each(["getter", "read", "write", "missing", "unexpected"])(
  "warns once and retains an in-memory session when storage is unavailable (%s)",
  async (failure) => {
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    if (failure === "missing") vi.stubGlobal("localStorage", undefined);
    else if (failure === "getter") {
      vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      });
    } else if (failure === "unexpected") {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("unexpected storage failure");
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

it("stops session timers on SDK startup failure", async () => {
  const failure = new Error("SDK startup failed");
  vi.mocked(startTelemetryInstance).mockImplementationOnce(() => {
    throw failure;
  });
  await expect(useMicrosoftOpenTelemetry({ session: { enabled: true } })).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops session timers even when instrumentation and SDK shutdown fail", async () => {
  const sdkFailure = new Error("SDK shutdown failed");
  const instrumentationFailure = new Error("disable failed");
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce({
    tracerProvider: noopTracerProvider,
    loggerProvider: noopLoggerProvider,
    commit: vi.fn(),
    abort: vi.fn(),
    detach: vi.fn(),
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
    await vi.advanceTimersByTimeAsync(0);
    expect(providerShutdown).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    tracer.startSpan("during-shutdown").end();
    logger.emit({ eventName: "during-shutdown" });
    expect(vi.getTimerCount()).toBe(1);
    expect(write).not.toHaveBeenCalled();
    expect(completed).toBe(false);
  } finally {
    finishShutdown();
    await shutdown;
  }
  await vi.advanceTimersByTimeAsync(2 * 1800_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(write).not.toHaveBeenCalled();
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
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    trace.getTracer("rollback").startSpan("after-rollback").end();
    logs.getLogger("rollback").emit({ eventName: "after-rollback" });
    expect(vi.getTimerCount()).toBe(1);
    expect(write).not.toHaveBeenCalled();
  } finally {
    finishShutdown();
    await rejected;
  }
  await vi.advanceTimersByTimeAsync(2 * 1800_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(report).toHaveBeenCalledExactlyOnceWith(
    "Telemetry initialization cleanup failed",
    disableFailure,
  );
});
