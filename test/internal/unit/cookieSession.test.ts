// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSession } from "../../../src/session/createSession.js";
import { createCookieManager } from "../../../src/storage/cookieManager.js";
import type { KeyValueStorage } from "../../../src/storage/keyValueStorage.js";
import type { MicrosoftOpenTelemetryBrowserCookieManager } from "../../../src/types.js";

const key = "ai_session";
const storageKey = "opentelemetry-session";
const legacyEncode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const encode = (value: { id: string; startTimestamp: number; lastActivityTimestamp?: number }) =>
  `${value.id}|${value.startTimestamp}|${value.lastActivityTimestamp ?? value.startTimestamp}`;
function decode(value: string) {
  const [id, start, activity] = value.split("|");
  return { id, startTimestamp: Number(start), lastActivityTimestamp: Number(activity) };
}

function fakeBackends() {
  const values = new Map<string, string>();
  const cookies = {
    isEnabled: vi.fn(() => true),
    setEnabled: vi.fn(),
    get: vi.fn((name: string) => values.get(name) ?? ""),
    set: vi.fn((name: string, value: string, _maxAgeSec?: number) => {
      values.set(name, value);
      return true;
    }),
    del: vi.fn(() => true),
    purge: vi.fn(() => true),
  } satisfies MicrosoftOpenTelemetryBrowserCookieManager;
  const storage = {
    getItem: vi.fn((_name: string) => ({ success: true as const, value: null as string | null })),
    setItem: vi.fn((_name: string, _value: string) => true),
    removeItem: vi.fn(() => true),
  } satisfies KeyValueStorage;
  return { cookies, storage, values };
}

function expiringCookieBackend() {
  const values = new Map<string, { value: string; expiresAt?: number }>();
  return {
    getCookie(name: string) {
      const cookie = values.get(name);
      if (cookie?.expiresAt !== undefined && Date.now() >= cookie.expiresAt) {
        values.delete(name);
        return "";
      }
      return cookie?.value ?? "";
    },
    setCookie: vi.fn((name: string, formatted: string) => {
      const maxAge = /; max-age=(-?\d+)/.exec(formatted)?.[1];
      values.set(name, {
        value: formatted.split(";")[0]!,
        expiresAt: maxAge === undefined ? undefined : Date.now() + Number(maxAge) * 1000,
      });
    }),
    closeBrowserSession() {
      for (const [name, cookie] of values) {
        if (cookie.expiresAt === undefined) values.delete(name);
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("restores the complete prefixed cookie first without reading or writing storage", async () => {
  const { cookies, storage, values } = fakeBackends();
  const record = { id: "ai+cookie/id", startTimestamp: 900_000, lastActivityTimestamp: 990_000 };
  values.set(`app-${key}`, encode(record));
  storage.getItem.mockReturnValue({
    success: true,
    value: JSON.stringify({ ...record, id: "backup" }),
  });
  const session = createSession({}, storage, cookies, `app-${key}`);
  await session.start();
  expect(session.getSessionId()).toBe(record.id);
  expect(cookies.get).toHaveBeenCalledExactlyOnceWith(`app-${key}`);
  expect(decode(values.get(`app-${key}`)!)).toEqual({
    ...record,
    lastActivityTimestamp: Date.now(),
  });
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
  session.shutdown();
});

it("falls back to a missing cookie's storage backup and migrates it on activity", async () => {
  const { cookies, storage, values } = fakeBackends();
  storage.getItem.mockReturnValue({
    success: true,
    value: JSON.stringify({
      id: "backup",
      startTimestamp: 900_000,
      lastActivityTimestamp: 990_000,
    }),
  });
  const session = createSession({}, storage, cookies);
  await session.start();
  expect(session.getSessionId()).toBe("backup");
  expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(storageKey);
  expect(decode(values.get(key)!)).toEqual({
    id: "backup",
    startTimestamp: 900_000,
    lastActivityTimestamp: Date.now(),
  });
  expect(storage.setItem).not.toHaveBeenCalled();
});

it.each(["existing", "missing", "malformed"])(
  "keeps a stable provisional session without persistence until read recovery (%s cookie)",
  async (state) => {
    const { storage } = fakeBackends();
    storage.getItem.mockReturnValue({
      success: true,
      value: JSON.stringify({ id: "backup", startTimestamp: Date.now() }),
    });
    const values = new Map<string, string>();
    if (state === "existing") {
      values.set(key, encode({ id: "authoritative", startTimestamp: Date.now() }));
    } else if (state === "malformed") values.set(key, "%");
    let unavailable = true;
    const setCookie = vi.fn((name: string, formatted: string) => {
      values.set(name, formatted.split(";")[0]!);
    });
    const cookies = createCookieManager({
      getCookie(name) {
        if (unavailable) throw new Error("cookie read unavailable");
        return values.get(name) ?? "";
      },
      setCookie,
    });
    const session = createSession({}, storage, cookies);
    await session.start();
    const provisional = session.getSessionId();
    expect(provisional).toMatch(/^[0-9a-f]{32}$/);
    vi.setSystemTime(Date.now() + 1000);
    expect(session.getSessionId()).toBe(provisional);
    session.backup();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(setCookie).not.toHaveBeenCalled();

    unavailable = false;
    const id = session.getSessionId();
    expect(id).not.toBe(provisional);
    if (state === "existing") expect(id).toBe("authoritative");
    else if (state === "missing") expect(id).toBe("backup");
    else expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(session.getSessionId()).toBe(id);
    expect(decode(values.get(key)!)).toHaveProperty("id", id);
    expect(storage.getItem).toHaveBeenCalledTimes(state === "missing" ? 1 : 0);
    session.backup();
    expect(JSON.parse(storage.setItem.mock.calls.at(-1)![1])).toHaveProperty("id", id);
    session.shutdown();
    cookies.shutdown();
  },
);

it("never restores a discarded user backup even when its removal fails", async () => {
  const { cookies, storage } = fakeBackends();
  storage.getItem.mockReturnValue({
    success: true,
    value: JSON.stringify({ id: "previous-user", startTimestamp: Date.now() }),
  });
  storage.removeItem.mockReturnValue(false);
  const session = createSession({}, storage, cookies);
  session.discardBackup();
  await session.start();
  expect(session.getSessionId()).not.toBe("previous-user");
  expect(storage.getItem).not.toHaveBeenCalled();
  session.shutdown();
});

it("does not clear Web Storage for memory-only sessions on a user reset", async () => {
  const { cookies, storage } = fakeBackends();
  const session = createSession({ persist: false }, storage, cookies);
  session.discardBackup();
  await session.start();
  expect(storage.removeItem).not.toHaveBeenCalled();
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(cookies.get).not.toHaveBeenCalled();
  session.shutdown();
});

it.each([
  "%",
  "%E0%A4%A",
  "not-json",
  legacyEncode(null),
  legacyEncode({ id: "invalid" }),
  "invalid||1000000",
  "invalid|1000000|",
  "invalid|NaN|1000000",
  "invalid|1000000|Infinity",
  "invalid|1000000|999999",
  "invalid|1000000|1000001",
  "invalid|1000000|1000000|extra",
  encode({ id: "future", startTimestamp: 1_000_001 }),
  encode({ id: "invalid-activity", startTimestamp: 900_000, lastActivityTimestamp: 899_999 }),
])("does not fall back from a present malformed cookie (%s)", async (value) => {
  const { cookies, storage, values } = fakeBackends();
  values.set(key, value);
  storage.getItem.mockReturnValue({
    success: true,
    value: JSON.stringify({ id: "backup", startTimestamp: Date.now() }),
  });
  const session = createSession({}, storage, cookies);
  await session.start();
  expect(session.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
  expect(storage.getItem).not.toHaveBeenCalled();
});

it.each([
  [120, 300, 120],
  [300, 120, 120],
  [0, 120, 120],
  [120, 0, undefined],
  [0, 0, undefined],
] as const)(
  "sets cookie age for inactivity=%s, maximum=%s",
  async (inactivityTimeout, maxDuration, age) => {
    const { cookies, storage } = fakeBackends();
    const session = createSession({ inactivityTimeout, maxDuration }, storage, cookies);
    await session.start();
    const id = session.getSessionId();
    expect(cookies.set).toHaveBeenCalledExactlyOnceWith(
      key,
      encode({
        id,
        startTimestamp: Date.now(),
        lastActivityTimestamp: Date.now(),
      }),
      age,
    );
  },
);

it.each([
  { field: "maxDuration", before: 2, after: 100, age: 99 },
  { field: "maxDuration", before: 300, after: 5, age: 4 },
  { field: "maxDuration", before: 2, after: 0, age: undefined },
  { field: "maxDuration", before: 0, after: 100, age: 99 },
  { field: "inactivityTimeout", before: 2, after: 120, age: 120 },
  { field: "inactivityTimeout", before: 120, after: 2, age: 2 },
] as const)(
  "refreshes persisted $field from $before to $after on activity and survives reload",
  async ({ field, before, after, age }) => {
    const backend = expiringCookieBackend();
    const cookies = createCookieManager(backend);
    const initial = { inactivityTimeout: 120, maxDuration: 300, [field]: before };
    let policy = initial;
    const session = createSession(initial, null, cookies, key, () => policy);
    await session.start();
    const started = Date.now();
    const id = session.getSessionId();
    expect(backend.setCookie).toHaveBeenCalledOnce();

    vi.setSystemTime(started + 1000);
    policy = { ...policy, [field]: after };
    expect(backend.setCookie).toHaveBeenCalledOnce();
    expect(session.getSessionId()).toBe(id);
    expect(backend.setCookie).toHaveBeenCalledTimes(2);
    const formatted = backend.setCookie.mock.calls.at(-1)![1];
    if (age === undefined) expect(formatted).not.toContain("max-age=");
    else expect(formatted).toContain(`; max-age=${age};`);

    vi.setSystemTime(started + 1500);
    expect(session.getSessionId()).toBe(id);
    expect(backend.setCookie).toHaveBeenCalledTimes(policy.inactivityTimeout <= 60 ? 3 : 2);
    session.shutdown();
    cookies.shutdown();

    vi.setSystemTime(started + 2500);
    const reloadedCookies = createCookieManager(backend);
    const reloaded = createSession(policy, null, reloadedCookies);
    await reloaded.start();
    expect(reloaded.getSessionId()).toBe(id);
    reloaded.shutdown();
    reloadedCookies.shutdown();
  },
);

it("throttles refreshes at 60 seconds while preserving latest activity and remaining maximum age", async () => {
  const { cookies, storage, values } = fakeBackends();
  const start = Date.now();
  const session = createSession({ inactivityTimeout: 120, maxDuration: 150 }, storage, cookies);
  await session.start();
  const id = session.getSessionId();
  for (const elapsed of [1, 30_000, 59_999]) {
    vi.setSystemTime(start + elapsed);
    expect(session.getSessionId()).toBe(id);
  }
  expect(cookies.set).toHaveBeenCalledTimes(1);
  vi.setSystemTime(start + 60_000);
  expect(session.getSessionId()).toBe(id);
  expect(cookies.set).toHaveBeenLastCalledWith(
    key,
    encode({
      id,
      startTimestamp: start,
      lastActivityTimestamp: start + 60_000,
    }),
    90,
  );
  expect(decode(values.get(key)!)).toHaveProperty("lastActivityTimestamp", start + 60_000);
  expect(storage.setItem).not.toHaveBeenCalled();
});

it.each([
  { inactivityTimeout: 10, activity: [5000, 10_000], reload: 15_000 },
  { inactivityTimeout: 60, activity: [30_000, 59_000], reload: 89_000 },
])(
  "preserves active $inactivityTimeout-second inactivity windows across reloads without Web Storage",
  async ({ inactivityTimeout, activity, reload }) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const backend = expiringCookieBackend();
    const cookies = createCookieManager(backend);
    const options = { inactivityTimeout };
    const first = createSession(options, null, cookies);
    const start = Date.now();
    await first.start();
    const id = first.getSessionId();
    for (const elapsed of activity) {
      vi.setSystemTime(start + elapsed);
      expect(first.getSessionId()).toBe(id);
    }
    first.shutdown();
    vi.setSystemTime(start + reload);
    const reloaded = createSession(options, null, cookies);
    await reloaded.start();
    expect(reloaded.getSessionId()).toBe(id);
    vi.setSystemTime(Date.now() + inactivityTimeout * 1000);
    expect(reloaded.getSessionId()).not.toBe(id);
    reloaded.shutdown();
    cookies.shutdown();
    expect(local).not.toHaveBeenCalled();
  },
);

it("the built-in cookie manager floors a generic 0.5-second lifetime to immediate expiry", () => {
  const backend = expiringCookieBackend();
  const cookies = createCookieManager(backend);
  expect(cookies.set(key, "value", 0.5)).toBe(true);
  expect(backend.setCookie.mock.calls.at(-1)?.[1]).toContain("; max-age=0;");
  expect(cookies.get(key)).toBe("");
  cookies.shutdown();
});

it.each(
  [
    { inactivityTimeout: 0.5, maxDuration: 60, write: 0, reload: 100, boundary: 600, age: 1 },
    { inactivityTimeout: 0, maxDuration: 0.5, write: 0, reload: 100, boundary: 500, age: 1 },
    { inactivityTimeout: 1.5, maxDuration: 60, write: 0, reload: 1100, boundary: 2600, age: 2 },
    { inactivityTimeout: 10, maxDuration: 2, write: 1500, reload: 1600, boundary: 2000, age: 1 },
    { inactivityTimeout: 10, maxDuration: 2, write: 500, reload: 1600, boundary: 2000, age: 2 },
  ].flatMap((options) =>
    [false, true].map((reloadAtBoundary) => ({ ...options, reloadAtBoundary })),
  ),
)(
  "preserves fractional cookie lifetime (idle=$inactivityTimeout, max=$maxDuration, write=$write) without storage; boundary reload=$reloadAtBoundary",
  async ({ inactivityTimeout, maxDuration, write, reload, boundary, age, reloadAtBoundary }) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const backend = expiringCookieBackend();
    const cookies = createCookieManager(backend);
    const options = { inactivityTimeout, maxDuration };
    const first = createSession(options, null, cookies);
    const start = Date.now();
    await first.start();
    const id = first.getSessionId();
    vi.setSystemTime(start + write);
    expect(first.getSessionId()).toBe(id);
    const formatted = backend.setCookie.mock.calls.at(-1)?.[1];
    first.shutdown();

    vi.setSystemTime(start + reload);
    // A new manager models a reload without retaining any pending or instance-local state.
    cookies.shutdown();
    const reloadedCookies = createCookieManager(backend);
    const reloaded = createSession(options, null, reloadedCookies);
    await reloaded.start();
    expect(reloaded.getSessionId()).toBe(id);
    expect(formatted).toContain(`; max-age=${age};`);

    vi.setSystemTime(start + boundary);
    // The rounded-up cookie still exists: timestamps, not browser expiry, must end the session.
    expect(decode(reloadedCookies.get(key))).toEqual({
      id,
      startTimestamp: start,
      lastActivityTimestamp: start + reload,
    });
    if (reloadAtBoundary) {
      reloaded.shutdown();
      reloadedCookies.shutdown();
      const boundaryCookies = createCookieManager(backend);
      const atBoundary = createSession(options, null, boundaryCookies);
      await atBoundary.start();
      expect(atBoundary.getSessionId()).not.toBe(id);
      atBoundary.shutdown();
      boundaryCookies.shutdown();
    } else {
      expect(reloaded.getSessionId()).not.toBe(id);
      reloaded.shutdown();
      reloadedCookies.shutdown();
    }
    expect(local).not.toHaveBeenCalled();
  },
);

it.each([0, 10])(
  "retains browser-session cookie semantics with maxDuration=0 and inactivity=%s",
  async (inactivityTimeout) => {
    const backend = expiringCookieBackend();
    const cookies = createCookieManager(backend);
    const options = { maxDuration: 0, inactivityTimeout };
    const first = createSession(options, null, cookies);
    const start = Date.now();
    await first.start();
    const id = first.getSessionId();
    for (const elapsed of [5000, 10_000]) {
      vi.setSystemTime(start + elapsed);
      expect(first.getSessionId()).toBe(id);
    }
    first.shutdown();
    vi.setSystemTime(start + 15_000);
    const reloaded = createSession(options, null, cookies);
    await reloaded.start();
    expect(reloaded.getSessionId()).toBe(id);
    vi.setSystemTime(
      Date.now() + (inactivityTimeout ? inactivityTimeout * 1000 : 25 * 60 * 60_000),
    );
    const current = reloaded.getSessionId();
    if (inactivityTimeout) expect(current).not.toBe(id);
    else expect(current).toBe(id);
    reloaded.shutdown();
    for (const [, formatted] of backend.setCookie.mock.calls) {
      expect(formatted).not.toMatch(/; (?:max-age|expires)=/);
    }
    backend.closeBrowserSession();
    const reopened = createSession(options, null, cookies);
    await reopened.start();
    expect(reopened.getSessionId()).not.toBe(current);
    reopened.shutdown();
    cookies.shutdown();
  },
);

it.each([{}, { inactivityTimeout: 0 }])(
  "preserves default 60-second coalescing with options %j",
  async (options) => {
    const { cookies } = fakeBackends();
    const session = createSession(options, null, cookies);
    const start = Date.now();
    await session.start();
    const id = session.getSessionId();
    for (const elapsed of [1, 30_000, 59_999]) {
      vi.setSystemTime(start + elapsed);
      expect(session.getSessionId()).toBe(id);
    }
    expect(cookies.set).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 60_000);
    expect(session.getSessionId()).toBe(id);
    expect(cookies.set).toHaveBeenCalledTimes(2);
    session.shutdown();
  },
);

it.each(["reject", "throw"])(
  "retries a %s without throttling the first accepted write",
  async (failure) => {
    const { cookies, values } = fakeBackends();
    cookies.set.mockImplementation(() => {
      if (failure === "throw") throw new Error("unavailable");
      return false;
    });
    const session = createSession({}, null, cookies);
    await session.start();
    const start = Date.now();
    const id = session.getSessionId();
    cookies.set.mockClear().mockImplementation((name, value) => {
      values.set(name, value);
      return true;
    });
    vi.setSystemTime(start + 1);
    expect(session.getSessionId()).toBe(id);
    expect(cookies.set).toHaveBeenCalledTimes(1);
    expect(decode(values.get(key)!)).toEqual({
      id,
      startTimestamp: start,
      lastActivityTimestamp: start + 1,
    });
    vi.setSystemTime(start + 30_000);
    expect(session.getSessionId()).toBe(id);
    expect(cookies.set).toHaveBeenCalledTimes(1);
    session.shutdown();
  },
);

it.each(["reject", "throw"])(
  "does not inherit an old session's throttle after a forced renewal write %s",
  async (failure) => {
    const { cookies, values } = fakeBackends();
    const session = createSession({ maxDuration: 30 }, null, cookies);
    await session.start();
    const start = Date.now();
    const id = session.getSessionId();
    cookies.set.mockImplementationOnce(() => {
      if (failure === "throw") throw new Error("unavailable");
      return false;
    });
    vi.setSystemTime(start + 30_000);
    const renewed = session.getSessionId();
    expect(renewed).not.toBe(id);
    expect(decode(values.get(key)!)).toHaveProperty("id", id);
    vi.setSystemTime(start + 30_001);
    expect(session.getSessionId()).toBe(renewed);
    expect(decode(values.get(key)!)).toHaveProperty("id", renewed);
    session.shutdown();
  },
);

it("writes on the first activity after enabling cookies with deferral disabled", async () => {
  const backend = expiringCookieBackend();
  const cookies = createCookieManager({ ...backend, enabled: false, disableCookieDefer: true });
  const session = createSession({}, null, cookies);
  await session.start();
  const start = Date.now();
  const id = session.getSessionId();
  vi.setSystemTime(start + 5000);
  expect(session.getSessionId()).toBe(id);
  expect(backend.setCookie).not.toHaveBeenCalled();
  cookies.setEnabled(true);
  expect(backend.setCookie).not.toHaveBeenCalled();
  expect(session.getSessionId()).toBe(id);
  expect(backend.setCookie).toHaveBeenCalledTimes(1);
  expect(decode(cookies.get(key))).toEqual({
    id,
    startTimestamp: start,
    lastActivityTimestamp: start + 5000,
  });
  session.getSessionId();
  expect(backend.setCookie).toHaveBeenCalledTimes(1);
  session.shutdown();
  cookies.shutdown();
});

it("retries a failed real cookie-manager hook on the next activity", async () => {
  const backend = expiringCookieBackend();
  const setCookie = vi.fn<(name: string, value: string) => void>(() => {
    throw new Error("unavailable");
  });
  const cookies = createCookieManager({ ...backend, setCookie });
  const session = createSession({}, null, cookies);
  await session.start();
  const id = session.getSessionId();
  setCookie.mockImplementation(backend.setCookie);
  vi.setSystemTime(Date.now() + 1);
  expect(session.getSessionId()).toBe(id);
  expect(decode(cookies.get(key))).toHaveProperty("id", id);
  session.shutdown();
  cookies.shutdown();
});

it("coalesces accepted deferred writes before and after cookie enablement", async () => {
  const backend = expiringCookieBackend();
  const cookies = createCookieManager({ ...backend, enabled: false });
  const set = vi.spyOn(cookies, "set");
  const session = createSession({}, null, cookies);
  const start = Date.now();
  await session.start();
  const id = session.getSessionId();
  vi.setSystemTime(start + 30_000);
  expect(session.getSessionId()).toBe(id);
  expect(set).toHaveBeenCalledTimes(1);
  expect(backend.setCookie).not.toHaveBeenCalled();
  expect(decode(cookies.get(key))).toHaveProperty("lastActivityTimestamp", start);
  cookies.setEnabled(true);
  expect(backend.setCookie).toHaveBeenCalledTimes(1);
  vi.setSystemTime(start + 59_999);
  expect(session.getSessionId()).toBe(id);
  expect(set).toHaveBeenCalledTimes(1);
  vi.setSystemTime(start + 60_000);
  expect(session.getSessionId()).toBe(id);
  expect(set).toHaveBeenCalledTimes(2);
  expect(backend.setCookie).toHaveBeenCalledTimes(2);
  expect(decode(cookies.get(key))).toHaveProperty("lastActivityTimestamp", start + 60_000);
  session.shutdown();
  cookies.shutdown();
});

it.each(["inactivityTimeout", "maxDuration"] as const)(
  "renews at the exact %s boundary despite throttling",
  async (option) => {
    const { cookies, storage, values } = fakeBackends();
    const session = createSession({ [option]: 2 }, storage, cookies);
    await session.start();
    const id = session.getSessionId();
    vi.setSystemTime(Date.now() + 2000);
    expect(session.getSessionId()).not.toBe(id);
    expect(cookies.set).toHaveBeenCalledTimes(2);
    expect(decode(values.get(key)!)).toHaveProperty("startTimestamp", Date.now());
  },
);

it("renews immediately after timestamp regression", async () => {
  const { cookies, storage } = fakeBackends();
  const session = createSession({}, storage, cookies);
  await session.start();
  const id = session.getSessionId();
  vi.setSystemTime(Date.now() + 1000);
  expect(session.getSessionId()).toBe(id);
  vi.setSystemTime(Date.now() - 1);
  expect(session.getSessionId()).not.toBe(id);
  expect(cookies.set).toHaveBeenCalledTimes(2);
});

it.each([
  { id: "idle", startTimestamp: 900_000, lastActivityTimestamp: 998_000 },
  { id: "old", startTimestamp: 998_000, lastActivityTimestamp: 999_999 },
])("rejects expired cookie sessions without restoring a backup ($id)", async (record) => {
  const { cookies, storage, values } = fakeBackends();
  values.set(key, encode(record));
  const session = createSession({ inactivityTimeout: 2, maxDuration: 2 }, storage, cookies);
  await session.start();
  expect(session.getSessionId()).not.toBe(record.id);
  expect(storage.getItem).not.toHaveBeenCalled();
});

it("backs up only explicitly, using current activity without refreshing cookies", async () => {
  const { cookies, storage } = fakeBackends();
  const session = createSession({}, storage, cookies);
  session.backup();
  expect(storage.setItem).not.toHaveBeenCalled();
  await session.start();
  const start = Date.now();
  const id = session.getSessionId();
  vi.setSystemTime(start + 1234);
  session.getSessionId();
  session.shutdown();
  expect(storage.setItem).not.toHaveBeenCalled();
  session.backup();
  expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
    storageKey,
    JSON.stringify({
      id,
      startTimestamp: start,
      lastActivityTimestamp: start + 1234,
    }),
  );
  expect(cookies.set).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "does not touch either backend when persist=false (cookies=%s)",
  async (cookieMode) => {
    const { cookies, storage } = fakeBackends();
    const session = createSession(
      { persist: false, inactivityTimeout: 1 },
      storage,
      cookieMode ? cookies : undefined,
    );
    await session.start();
    const id = session.getSessionId();
    vi.setSystemTime(Date.now() + 1000);
    expect(session.getSessionId()).not.toBe(id);
    session.backup();
    session.shutdown();
    for (const method of [...Object.values(cookies), ...Object.values(storage)]) {
      expect(method).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])(
  "null storage never accesses Web Storage (cookies=%s)",
  async (cookieMode) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const { cookies } = fakeBackends();
    const session = createSession({}, null, cookieMode ? cookies : undefined);
    await session.start();
    expect(session.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
    session.backup();
    session.shutdown();
    expect(local).not.toHaveBeenCalled();
    expect(cookies.set).toHaveBeenCalledTimes(cookieMode ? 1 : 0);
  },
);

it.each([false, true])(
  "honors disabled-cookie deferral independently of explicit backup (disableCookieDefer=%s)",
  async (disableCookieDefer) => {
    const setCookie = vi.fn();
    const cookies = createCookieManager({ enabled: false, disableCookieDefer, setCookie });
    const { storage } = fakeBackends();
    const session = createSession({}, storage, cookies);
    await session.start();
    const start = Date.now();
    const id = session.getSessionId();
    vi.setSystemTime(start + 60_000);
    expect(session.getSessionId()).toBe(id);
    expect(setCookie).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    session.backup();
    expect(storage.setItem).toHaveBeenCalledOnce();
    cookies.setEnabled(true);
    if (disableCookieDefer) expect(setCookie).not.toHaveBeenCalled();
    else {
      expect(setCookie).toHaveBeenCalledOnce();
      expect(decode(setCookie.mock.calls[0][1].split(";")[0])).toEqual({
        id,
        startTimestamp: start,
        lastActivityTimestamp: start + 60_000,
      });
    }
    session.shutdown();
    cookies.shutdown();
  },
);

it("keeps the legacy storage path writing on each activity without cookie encoding", async () => {
  const { storage } = fakeBackends();
  const session = createSession({}, storage);
  await session.start();
  const start = Date.now();
  const id = session.getSessionId();
  vi.setSystemTime(start + 1);
  expect(session.getSessionId()).toBe(id);
  expect(storage.setItem).toHaveBeenCalledTimes(2);
  expect(storage.setItem).toHaveBeenLastCalledWith(
    storageKey,
    JSON.stringify({
      id,
      startTimestamp: start,
      lastActivityTimestamp: start + 1,
    }),
  );
});

it.each(["inactivityTimeout", "maxDuration"] as const)(
  "expires provisional sessions normally at the %s boundary without writing either backend",
  async (option) => {
    const { storage } = fakeBackends();
    const setCookie = vi.fn();
    const cookies = createCookieManager({
      getCookie() {
        throw new Error("cookie read unavailable");
      },
      setCookie,
    });
    const session = createSession({ [option]: 2 }, storage, cookies);
    await session.start();
    const first = session.getSessionId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    vi.setSystemTime(Date.now() + 1000);
    expect(session.getSessionId()).toBe(first);
    // Activity extends inactivity, but not maximum lifetime.
    vi.setSystemTime(Date.now() + (option === "inactivityTimeout" ? 2000 : 1000));
    const renewed = session.getSessionId();
    expect(renewed).toMatch(/^[0-9a-f]{32}$/);
    expect(renewed).not.toBe(first);
    expect(session.getSessionId()).toBe(renewed);
    session.backup();
    expect(setCookie).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    session.shutdown();
    cookies.shutdown();
  },
);

it.each(["legacy-session", "cookie; 雪", "cookie|delimiter"])(
  "restores a JSON Web Storage backup without emitting unsafe raw cookie values (%s)",
  async (id) => {
    const { cookies, storage, values } = fakeBackends();
    const record = { id, startTimestamp: 900_000, lastActivityTimestamp: 990_000 };
    storage.getItem.mockReturnValue({ success: true, value: JSON.stringify(record) });
    const session = createSession({}, storage, cookies);
    await session.start();
    expect(session.getSessionId()).toBe(id);
    if (id === "legacy-session") {
      expect(values.get(key)).toBe(`${id}|900000|1000000`);
    } else {
      expect(cookies.set).not.toHaveBeenCalled();
      expect(values.has(key)).toBe(false);
    }
    session.backup();
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      storageKey,
      JSON.stringify({ ...record, lastActivityTimestamp: Date.now() }),
    );
    session.shutdown();
  },
);

it("writes raw Application Insights session values and preserves the JSON backup key across reloads", async () => {
  const { cookies, storage, values } = fakeBackends();
  values.set(key, "AI+session/id|900000|990000");
  const first = createSession({}, storage, cookies);
  await first.start();
  expect(first.getSessionId()).toBe("AI+session/id");
  expect(values.get(key)).toBe("AI+session/id|900000|1000000");
  first.backup();
  expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
    storageKey,
    '{"id":"AI+session/id","startTimestamp":900000,"lastActivityTimestamp":1000000}',
  );
  first.shutdown();
  const reloaded = createSession({}, storage, cookies);
  await reloaded.start();
  expect(reloaded.getSessionId()).toBe("AI+session/id");
  expect(storage.getItem).not.toHaveBeenCalled();
  reloaded.shutdown();
});
