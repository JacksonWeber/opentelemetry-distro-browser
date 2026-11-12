// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace, type Tracer } from "@opentelemetry/api";
import { logs, type Logger } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { getSdkLoaderScript } from "../../../src/snippet.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";
import { MemoryStorage } from "../../fixtures/sessionStorageSetup.js";

const AZURE_MONITOR_CONNECTION_STRING = `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=https://example.test`;

const handles: MicrosoftOpenTelemetryBrowser[] = [];
const keys = ["opentelemetry-session", "opentelemetry-user"];
const cookieKeys = ["ai_session", "ai_user", "ai_authUser"];
const saved = new Map<string, string | null>();

function clearCookies() {
  for (const prefix of ["", "app-a-", "app-b-", "shop-"]) {
    for (const key of cookieKeys) {
      document.cookie = `${prefix}${key}=; max-age=0; path=/`;
    }
  }
}

function readCookie(name: string) {
  const value = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
  return value ? decodeCookie(name, value.slice(name.length + 1)) : null;
}

function decodeCookie(name: string, value: string) {
  const parts = (name.endsWith("ai_authUser") ? decodeURI(value) : value).split("|");
  if (name.endsWith("ai_user")) {
    return { anonymousId: parts[0], acquisitionTimestamp: Date.parse(parts[1]!) };
  }
  if (name.endsWith("ai_session")) {
    return {
      id: parts[0],
      startTimestamp: Number(parts[1]),
      lastActivityTimestamp: Number(parts[2]),
    };
  }
  return { authenticatedUserId: parts[0], ...(parts.length > 1 && { accountId: parts[1] }) };
}

beforeEach(clearCookies);

function preserve(key: string, value: string | null = null) {
  if (!saved.has(key)) saved.set(key, localStorage.getItem(key));
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearCookies();
  for (const [key, value] of saved) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  saved.clear();
});

async function initialize(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
  const spans: Span[] = [];
  const records: ReadWriteLogRecord[] = [];
  let tracer: Tracer;
  let logger: Logger;
  const handle = await useMicrosoftOpenTelemetry({
    ...options,
    pageView: { enabled: false },
    instrumentations: [
      ...(options.instrumentations ?? []),
      {
        // Bind emissions to this instance even when another live handle owns the global route.
        setTracerProvider(provider) {
          tracer = provider.getTracer("storage-test");
        },
        setLoggerProvider(provider) {
          logger = provider.getLogger("storage-test");
        },
        getConfig: () => ({ enabled: false }),
        enable() {},
        disable() {},
      },
    ],
    spanProcessors: [
      {
        onStart: (span) => {
          spans.push(span);
        },
        onEnd() {},
        async forceFlush() {},
        async shutdown() {},
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
  handles.push(handle);
  return {
    handle,
    spans,
    records,
    emit(attributes = {}, firstSignal: "span" | "log" = "span") {
      if (firstSignal === "span") tracer.startSpan("operation", { attributes }).end();
      logger.emit({ attributes });
      if (firstSignal === "log") tracer.startSpan("operation", { attributes }).end();
      const enriched = spans.at(-1)!.attributes;
      expect(records.at(-1)!.attributes).toMatchObject(enriched);
      return enriched;
    },
  };
}

function legacyUserStorage(namePrefix: string) {
  const storage = new MemoryStorage();
  const key = `${namePrefix}opentelemetry-user`;
  const otherKey = `${namePrefix ? "" : "app-a-"}opentelemetry-user`;
  const legacy = JSON.stringify({
    anonymousId: "legacy-anonymous",
    authenticatedUserId: "legacy-user",
    accountId: "legacy-account",
  });
  storage.setItem(key, legacy);
  storage.setItem(otherKey, legacy);
  return { storage, key, otherKey, legacy };
}

function sessionRecoveryFixture(prefix: string, failedCookie: "session" | "user") {
  const sessionKey = `${prefix}opentelemetry-session`;
  const sessionCookie = `${prefix}ai_session`;
  const userKey = `${prefix}ai_user`;
  const otherPrefix = prefix ? "" : "shop-";
  const otherSessionKey = `${otherPrefix}opentelemetry-session`;
  const now = Date.now();
  const backupSession = {
    id: "0123456789abcdef0123456789abcdef",
    startTimestamp: now - 2000,
    lastActivityTimestamp: now - 1000,
  };
  const cookieSession = {
    id: "fedcba9876543210fedcba9876543210",
    startTimestamp: now - 1000,
    lastActivityTimestamp: now - 500,
  };
  const backup = JSON.stringify(backupSession);
  const otherBackup = JSON.stringify({
    ...backupSession,
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  preserve(sessionKey, backup);
  preserve(otherSessionKey, otherBackup);
  const anonymous = `existing-user|${new Date(now - 2000).toISOString()}`;
  const otherCookies = new Map([
    [`${otherPrefix}ai_session`, `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|${now - 2000}|${now - 1000}`],
    [`${otherPrefix}ai_user`, `other-user|${new Date(now - 2000).toISOString()}`],
    [`${otherPrefix}ai_authUser`, encodeURI("other-login")],
  ]);
  const cookies = new Map(otherCookies);
  let failed = false;
  const cookieCfg = {
    getCookie: vi.fn((name: string) => {
      if (name === `${prefix}ai_${failedCookie}` && !failed) {
        failed = true;
        throw new Error("transient cookie read failure");
      }
      return cookies.get(name) ?? "";
    }),
    setCookie: vi.fn((name: string, formatted: string) => {
      cookies.set(name, formatted.split(";")[0]!);
    }),
    delCookie: vi.fn((name: string) => {
      cookies.delete(name);
    }),
  };
  return {
    sessionKey,
    sessionCookie,
    userKey,
    backupSession,
    cookieSession,
    backup,
    anonymous,
    cookies,
    cookieCfg,
    expectOtherPrefixUnchanged() {
      expect(localStorage.getItem(otherSessionKey)).toBe(otherBackup);
      for (const [name, value] of otherCookies) expect(cookies.get(name)).toBe(value);
      for (const operation of [cookieCfg.setCookie, cookieCfg.delCookie]) {
        expect(operation.mock.calls.every(([name]) => name.startsWith(prefix))).toBe(true);
        expect(operation.mock.calls.some(([name]) => otherCookies.has(name))).toBe(false);
      }
    },
  };
}

it.each(["", "shop-"])(
  "restores the authoritative cookie after a session-cookie read failure without replacing it from backup (prefix=%j)",
  async (prefix) => {
    const fixture = sessionRecoveryFixture(prefix, "session");
    const {
      sessionKey,
      sessionCookie,
      userKey,
      backup,
      cookieSession,
      anonymous,
      cookies,
      cookieCfg,
    } = fixture;
    const authoritative = `${cookieSession.id}|${cookieSession.startTimestamp}|${cookieSession.lastActivityTimestamp}`;
    cookies.set(userKey, anonymous);
    cookies.set(sessionCookie, authoritative);
    const { handle, emit } = await initialize({
      storage: { namePrefix: prefix },
      cookieCfg,
    });
    expect(cookieCfg.getCookie.mock.calls.filter(([name]) => name === sessionCookie)).toHaveLength(
      1,
    );
    expect(cookieCfg.setCookie).not.toHaveBeenCalled();
    expect(cookieCfg.delCookie).not.toHaveBeenCalled();
    expect(cookies.get(sessionCookie)).toBe(authoritative);
    expect(localStorage.getItem(sessionKey)).toBe(backup);

    expect(emit()).toMatchObject({
      "session.id": cookieSession.id,
      "enduser.pseudo.id": "existing-user",
    });
    expect(decodeCookie(sessionCookie, cookies.get(sessionCookie)!)).toMatchObject({
      id: cookieSession.id,
      startTimestamp: cookieSession.startTimestamp,
    });
    expect(cookies.get(userKey)).toBe(anonymous);
    expect(localStorage.getItem(sessionKey)).toBe(backup);
    await handle.shutdown();
    expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({
      id: cookieSession.id,
      startTimestamp: cookieSession.startTimestamp,
    });
    fixture.expectOtherPrefixUnchanged();
  },
);

it.each(["", "shop-"])(
  "invalidates an already restored backup before first enrichment when late anonymous recovery finds no cookies (prefix=%j)",
  async (prefix) => {
    const fixture = sessionRecoveryFixture(prefix, "user");
    const { sessionKey, sessionCookie, userKey, backupSession, backup, cookies, cookieCfg } =
      fixture;
    const readStorage = vi.spyOn(Storage.prototype, "getItem");
    const { handle, emit } = await initialize({
      storage: { namePrefix: prefix },
      cookieCfg,
    });
    expect(cookieCfg.getCookie.mock.calls.filter(([name]) => name === userKey)).toHaveLength(1);
    expect(cookieCfg.getCookie).toHaveBeenCalledWith(sessionCookie);
    expect(readStorage).toHaveBeenCalledWith(sessionKey);
    expect(localStorage.getItem(sessionKey)).toBe(backup);
    expect(cookies.has(userKey)).toBe(false);
    expect(cookies.has(sessionCookie)).toBe(false);
    expect(cookieCfg.setCookie).not.toHaveBeenCalled();

    // emit() starts the span before the log and checks that both receive the same attributes.
    const attributes = emit();
    expect(attributes["session.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(attributes["session.id"]).not.toBe(backupSession.id);
    expect(attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(decodeCookie(userKey, cookies.get(userKey)!)).toMatchObject({
      anonymousId: attributes["enduser.pseudo.id"],
    });
    expect(decodeCookie(sessionCookie, cookies.get(sessionCookie)!)).toMatchObject({
      id: attributes["session.id"],
    });
    expect(localStorage.getItem(sessionKey)).toBeNull();
    await handle.shutdown();
    expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({
      id: attributes["session.id"],
    });
    fixture.expectOtherPrefixUnchanged();
  },
);

it.each(["", "shop-"])(
  "preserves a cookie-derived session when late anonymous recovery finds no identity (prefix=%j)",
  async (prefix) => {
    const fixture = sessionRecoveryFixture(prefix, "user");
    const { sessionKey, sessionCookie, userKey, backup, cookieSession, cookies, cookieCfg } =
      fixture;
    const authoritative = `${cookieSession.id}|${cookieSession.startTimestamp}|${cookieSession.lastActivityTimestamp}`;
    cookies.set(sessionCookie, authoritative);
    const { handle, emit } = await initialize({
      storage: { namePrefix: prefix },
      cookieCfg,
    });
    expect(cookieCfg.getCookie.mock.calls.filter(([name]) => name === userKey)).toHaveLength(1);
    expect(cookies.has(userKey)).toBe(false);
    expect(cookies.get(sessionCookie)).toBe(authoritative);
    expect(localStorage.getItem(sessionKey)).toBe(backup);
    expect(cookieCfg.setCookie).not.toHaveBeenCalled();

    const attributes = emit();
    expect(attributes["session.id"]).toBe(cookieSession.id);
    expect(attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(decodeCookie(userKey, cookies.get(userKey)!)).toMatchObject({
      anonymousId: attributes["enduser.pseudo.id"],
    });
    expect(decodeCookie(sessionCookie, cookies.get(sessionCookie)!)).toMatchObject({
      id: cookieSession.id,
      startTimestamp: cookieSession.startTimestamp,
    });
    await handle.shutdown();
    expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({
      id: cookieSession.id,
      startTimestamp: cookieSession.startTimestamp,
    });
    fixture.expectOtherPrefixUnchanged();
  },
);

it.each(["", "shop-"])(
  "preserves the backup when late anonymous recovery restores an existing identity (prefix=%j)",
  async (prefix) => {
    const fixture = sessionRecoveryFixture(prefix, "user");
    const { sessionKey, userKey, backupSession, backup, anonymous, cookies, cookieCfg } = fixture;
    cookies.set(userKey, anonymous);
    const { handle, emit } = await initialize({
      storage: { namePrefix: prefix },
      cookieCfg,
    });
    expect(localStorage.getItem(sessionKey)).toBe(backup);
    expect(cookieCfg.setCookie).not.toHaveBeenCalled();
    expect(cookieCfg.getCookie.mock.calls.filter(([name]) => name === userKey)).toHaveLength(1);
    expect(emit()).toMatchObject({
      "session.id": backupSession.id,
      "enduser.pseudo.id": "existing-user",
    });
    expect(cookies.get(userKey)).toBe(anonymous);
    expect(localStorage.getItem(sessionKey)).toBe(backup);
    await handle.shutdown();
    expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({
      id: backupSession.id,
      startTimestamp: backupSession.startTimestamp,
    });
    fixture.expectOtherPrefixUnchanged();
  },
);

it.each(
  ["", "shop-"].flatMap((prefix) =>
    (["record", "resource"] as const).flatMap((identity) =>
      (["span", "log"] as const).map((firstSignal) => ({ prefix, identity, firstSignal })),
    ),
  ),
)(
  "recovers anonymous state before $firstSignal session enrichment while preserving explicit $identity identity (prefix=$prefix)",
  async ({ prefix, identity, firstSignal }) => {
    const fixture = sessionRecoveryFixture(prefix, "user");
    const explicit = { "enduser.pseudo.id": "application-anonymous" };
    const consumer = await initialize({
      storage: { namePrefix: prefix },
      cookieCfg: fixture.cookieCfg,
      ...(identity === "resource" && { resource: resourceFromAttributes(explicit) }),
    });
    expect(localStorage.getItem(fixture.sessionKey)).toBe(fixture.backup);
    const attributes = consumer.emit(identity === "record" ? explicit : {}, firstSignal);
    expect(attributes["session.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(attributes["session.id"]).not.toBe(fixture.backupSession.id);
    for (const record of [consumer.spans.at(-1)!, consumer.records.at(-1)!]) {
      expect(record.attributes["session.id"]).toBe(attributes["session.id"]);
      if (identity === "record") expect(record.attributes).toMatchObject(explicit);
      else {
        expect(record.attributes["enduser.pseudo.id"]).toBeUndefined();
        expect(record.resource.attributes).toMatchObject(explicit);
      }
    }
    expect(
      decodeCookie(fixture.userKey, fixture.cookies.get(fixture.userKey)!).anonymousId,
    ).not.toBe("application-anonymous");
    expect(localStorage.getItem(fixture.sessionKey)).toBeNull();
    await consumer.handle.shutdown();
    expect(JSON.parse(localStorage.getItem(fixture.sessionKey)!).id).toBe(attributes["session.id"]);
    fixture.expectOtherPrefixUnchanged();
  },
);

it.each(["string", "promise"] as const)(
  "blocks Web Storage and cookie persistence throughout identity controls, expiry, flush and shutdown (%s)",
  async (destination) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    for (const key of keys) preserve(key, "previous-value");
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const cookie = vi.spyOn(document, "cookie", "get");
    const cookieWrite = vi.spyOn(document, "cookie", "set");
    const fetch = vi.fn(
      async () => new Response("", { status: 503, headers: { "retry-after": "86400" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const { handle, emit } = await initialize({
      storage: { enabled: false },
      azureMonitor: {
        connectionString:
          destination === "string"
            ? AZURE_MONITOR_CONNECTION_STRING
            : Promise.resolve(AZURE_MONITOR_CONNECTION_STRING),
      },
      cookieCfg: { enabled: false, disableCookieDefer: true },
      session: { persist: true, inactivityTimeout: 0.001 },
      userContext: { enabled: true },
    });
    const first = emit()["session.id"];
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    handle.userContext.setEnabled(true);
    handle.userContext.setAuthenticatedUserContext("user", "account");
    expect(emit()["user.id"]).toBe("user");
    expect(emit()["enduser.pseudo.id"]).toBeUndefined();
    handle.userContext.clearAuthenticatedUserContext();
    expect(emit()["user.id"]).toBeUndefined();
    expect(cookieWrite).not.toHaveBeenCalled();
    handle.userContext.setEnabled(false);
    // Explicit identity removal uses purge, which intentionally bypasses disabled cookies.
    expect(cookieWrite.mock.calls).toEqual([
      ["ai_user=; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0; path=/"],
      ["ai_authUser=; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0; path=/"],
    ]);
    cookieWrite.mockClear();
    clock.mockReturnValue(now + 1000);
    expect(emit()["session.id"]).not.toBe(first);
    await handle.forceFlush().catch(() => {});
    expect(fetch).toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    await handle.shutdown();
    handle.userContext.setEnabled(true);
    handle.userContext.clearAuthenticatedUserContext();
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
    expect(cookieWrite).not.toHaveBeenCalled();
    local.mockRestore();
    for (const key of keys) expect(localStorage.getItem(key)).toBe("previous-value");
  },
);

it.each(["string", "promise"] as const)(
  "prefixes unsent telemetry buffer keys (%s)",
  async (destination) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503, headers: { "retry-after": "86400" } })),
    );
    const { handle, emit } = await initialize({
      storage: { namePrefix: "shop-" },
      azureMonitor: {
        connectionString:
          destination === "string"
            ? AZURE_MONITOR_CONNECTION_STRING
            : Promise.resolve(AZURE_MONITOR_CONNECTION_STRING),
      },
    });
    emit();
    await handle.forceFlush().catch(() => {});
    const bufferKeys = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index),
    ).filter((key) => key?.includes("opentelemetry-buffer|"));
    expect(bufferKeys.length).toBeGreaterThan(0);
    for (const key of bufferKeys) expect(key).toMatch(/^shop-opentelemetry-buffer\|/);
  },
);

it("isolates prefixed sessions and users, restores them, and scopes identity removal", async () => {
  for (const prefix of ["", "app-a-", "app-b-"]) {
    for (const key of keys) preserve(prefix + key);
  }
  const first = await initialize({ storage: { namePrefix: "app-a-" } });
  first.handle.userContext.setAuthenticatedUserContext("user-a", undefined, true);
  const a = first.emit();
  await first.handle.shutdown();
  const second = await initialize({ storage: { namePrefix: "app-b-" } });
  const b = second.emit();
  expect(b["session.id"]).not.toBe(a["session.id"]);
  expect(b["enduser.pseudo.id"]).not.toBe(a["enduser.pseudo.id"]);
  expect(b["user.id"]).toBeUndefined();
  for (const key of keys) expect(localStorage.getItem(key)).toBeNull();
  await second.handle.shutdown();
  const restored = await initialize({ storage: { namePrefix: "app-a-" } });
  expect(restored.emit()).toMatchObject(a);
  restored.handle.userContext.clearAuthenticatedUserContext();
  expect(readCookie("app-a-ai_authUser")).toBeNull();
  expect(readCookie("app-a-ai_user")).toEqual({
    anonymousId: a["enduser.pseudo.id"],
    acquisitionTimestamp: expect.any(Number),
  });
  restored.handle.userContext.setEnabled(false);
  expect(readCookie("app-a-ai_user")).toBeNull();
  expect(readCookie("app-b-ai_user")).toEqual({
    anonymousId: b["enduser.pseudo.id"],
    acquisitionTimestamp: expect.any(Number),
  });
  await restored.handle.shutdown();
  const activeSecond = await initialize({ storage: { namePrefix: "app-b-" } });
  expect(activeSecond.emit()).toMatchObject(b);
  const disabled = await initialize({
    storage: { enabled: false },
    cookieCfg: { enabled: false, disableCookieDefer: true },
  });
  disabled.handle.userContext.setEnabled(true);
  activeSecond.handle.userContext.setAuthenticatedUserContext("user-b", undefined, true);
  expect(readCookie("app-b-ai_authUser")).toEqual({
    authenticatedUserId: "user-b",
  });
  expect(readCookie("app-b-ai_user")).toMatchObject({
    anonymousId: b["enduser.pseudo.id"],
  });
});

it("keeps cookies independent of disabled Web Storage for both signals and restores them", async () => {
  const local = vi.spyOn(window, "localStorage", "get");
  const session = vi.spyOn(window, "sessionStorage", "get");
  const first = await initialize({ storage: { enabled: false } });
  first.handle.userContext.setAuthenticatedUserContext("user-b", "account", true);
  const attributes = first.emit();
  expect(attributes["session.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(readCookie("ai_session")!.id).toBe(attributes["session.id"]);
  expect(readCookie("ai_authUser")).toEqual({
    authenticatedUserId: "user-b",
    accountId: "account",
  });
  await first.handle.forceFlush();
  await first.handle.shutdown();
  const restored = await initialize({ storage: { enabled: false } });
  expect(restored.emit()).toMatchObject(attributes);
  await restored.handle.shutdown();
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
});

it.each(["", "app-a-"])(
  "discards the session backup when both identity and session cookies are missing (prefix=%j)",
  async (namePrefix) => {
    const sessionKey = `${namePrefix}opentelemetry-session`;
    const sessionCookie = `${namePrefix}ai_session`;
    preserve(sessionKey);
    const first = await initialize({ storage: { namePrefix } });
    const previous = first.emit();
    await first.handle.shutdown();
    expect(JSON.parse(localStorage.getItem(sessionKey)!).id).toBe(previous["session.id"]);
    clearCookies();
    expect(readCookie(`${namePrefix}ai_user`)).toBeNull();
    expect(readCookie(sessionCookie)).toBeNull();

    const restored = await initialize({ storage: { namePrefix } });
    const current = restored.emit();
    expect(current["session.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(current["session.id"]).not.toBe(previous["session.id"]);
    expect(current["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(current["enduser.pseudo.id"]).not.toBe(previous["enduser.pseudo.id"]);
    expect(localStorage.getItem(sessionKey)).toBeNull();
    expect(readCookie(sessionCookie)!.id).toBe(current["session.id"]);
    await restored.handle.shutdown();
    expect(JSON.parse(localStorage.getItem(sessionKey)!).id).toBe(current["session.id"]);
  },
);

it.each(["", "app-a-"])(
  "retains and restores the session backup when user and session cookies are ignored (prefix=%j)",
  async (namePrefix) => {
    const sessionKey = `${namePrefix}opentelemetry-session`;
    const sessionCookie = `${namePrefix}ai_session`;
    const userKey = `${namePrefix}ai_user`;
    const otherSessionKey = `${namePrefix ? "" : "app-a-"}opentelemetry-session`;
    const now = Date.now();
    const previous = {
      id: "0123456789abcdef0123456789abcdef",
      startTimestamp: now - 1000,
      lastActivityTimestamp: now - 500,
    };
    const backup = JSON.stringify(previous);
    const otherBackup = JSON.stringify({ ...previous, id: "fedcba9876543210fedcba9876543210" });
    preserve(sessionKey, backup);
    preserve(otherSessionKey, otherBackup);
    const options = {
      storage: { namePrefix },
      cookieCfg: { ignoreCookies: [userKey, sessionCookie] },
    };

    const first = await initialize(options);
    expect(first.handle.getCookieMgr().isEnabled()).toBe(true);
    expect(localStorage.getItem(sessionKey)).toBe(backup);
    const attributes = first.emit();
    expect(attributes["session.id"]).toBe(previous.id);
    expect(attributes["enduser.pseudo.id"]).toBeUndefined();
    expect(localStorage.getItem(sessionKey)).toBe(backup);
    expect(readCookie(userKey)).toBeNull();
    expect(readCookie(sessionCookie)).toBeNull();
    await first.handle.shutdown();
    const savedBackup = localStorage.getItem(sessionKey);
    expect(JSON.parse(savedBackup!)).toMatchObject({
      id: previous.id,
      startTimestamp: previous.startTimestamp,
    });

    const restored = await initialize(options);
    expect(localStorage.getItem(sessionKey)).toBe(savedBackup);
    expect(restored.emit()).toMatchObject(attributes);
    expect(localStorage.getItem(sessionKey)).toBe(savedBackup);
    await restored.handle.shutdown();
    expect(JSON.parse(localStorage.getItem(sessionKey)!).id).toBe(previous.id);
    expect(localStorage.getItem(otherSessionKey)).toBe(otherBackup);
    expect(readCookie(userKey)).toBeNull();
    expect(readCookie(sessionCookie)).toBeNull();
  },
);

it.each(["trace", "logs"])(
  "rejects an invalid Azure %s destination without browser persistence or cookie hook calls",
  async (signal) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const read = vi.spyOn(document, "cookie", "get");
    const write = vi.spyOn(document, "cookie", "set");
    const getCookie = vi.fn(() => "");
    const setCookie = vi.fn();
    const delCookie = vi.fn();
    await expect(
      useMicrosoftOpenTelemetry({
        azureMonitor: { connectionString: "InstrumentationKey=not-an-instrumentation-key" },
        ...(signal === "logs" ? { spanProcessors: [] } : {}),
        cookieCfg: { getCookie, setCookie, delCookie },
        pageView: { enabled: false },
      }),
    ).rejects.toThrow("valid InstrumentationKey UUID");
    for (const operation of [local, session, read, write, getCookie, setCookie, delCookie]) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it.each(["invalid prefix", "invalid;prefix", "invalid=prefix", "invalid\nprefix", "雪"])(
  "rejects an invalid cookie name prefix before browser persistence or cookie hook calls (%j)",
  async (namePrefix) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const read = vi.spyOn(document, "cookie", "get");
    const write = vi.spyOn(document, "cookie", "set");
    const getCookie = vi.fn(() => "");
    const setCookie = vi.fn();
    const delCookie = vi.fn();
    await expect(
      initialize({ storage: { namePrefix }, cookieCfg: { getCookie, setCookie, delCookie } }),
    ).rejects.toThrow("storage.namePrefix must contain only cookie-name token characters.");
    for (const operation of [local, session, read, write, getCookie, setCookie, delCookie]) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it("disables cookies without touching them and writes only a session Web Storage backup", async () => {
  for (const key of keys) preserve(key);
  const cookie = vi.spyOn(document, "cookie", "get");
  const cookieWrite = vi.spyOn(document, "cookie", "set");
  const write = vi.spyOn(Storage.prototype, "setItem");
  const { handle, emit } = await initialize({
    cookieCfg: { enabled: false, disableCookieDefer: true },
  });
  const attributes = emit();
  expect(attributes["enduser.pseudo.id"]).toBeUndefined();
  handle.userContext.setAuthenticatedUserContext("memory-user", "account", true);
  expect(emit()["user.id"]).toBe("memory-user");
  handle.userContext.clearAuthenticatedUserContext();
  expect(emit()["user.id"]).toBeUndefined();
  await handle.forceFlush();
  expect(write).not.toHaveBeenCalled();
  await handle.shutdown();
  expect(write).toHaveBeenCalledExactlyOnceWith("opentelemetry-session", expect.any(String));
  expect(JSON.parse(localStorage.getItem("opentelemetry-session")!).id).toBe(
    attributes["session.id"],
  );
  expect(localStorage.getItem("opentelemetry-user")).toBeNull();
  expect(cookie).not.toHaveBeenCalled();
  expect(cookieWrite).not.toHaveBeenCalled();
});

it("enables deferred SDK cookies while traces and logs flow immediately", async () => {
  const { handle, emit } = await initialize({
    storage: { enabled: false },
    cookieCfg: { enabled: false },
  });
  handle.userContext.setAuthenticatedUserContext("deferred-user", "account", true);
  const before = emit();
  expect(before["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(before["user.id"]).toBe("deferred-user");
  expect(document.cookie).toBe("");
  const manager = handle.getCookieMgr();
  expect(manager.isEnabled()).toBe(false);
  manager.setEnabled(true);
  expect(manager.isEnabled()).toBe(true);
  expect(readCookie("ai_session")!.id).toBe(before["session.id"]);
  expect(readCookie("ai_user")!.anonymousId).toBe(before["enduser.pseudo.id"]);
  expect(readCookie("ai_authUser")).toEqual({
    authenticatedUserId: "deferred-user",
    accountId: "account",
  });
  expect(emit()).toMatchObject(before);
});

it.each([
  { namePrefix: "", cleanupFails: false },
  { namePrefix: "", cleanupFails: true },
  { namePrefix: "app-a-", cleanupFails: false },
  { namePrefix: "app-a-", cleanupFails: true },
])(
  "removes only superseded authentication on failed deferred replay and retries B (%j)",
  async ({ namePrefix, cleanupFails }) => {
    const name = `${namePrefix}ai_authUser`;
    const values = new Map<string, string>();
    let failWrites = false;
    let failCleanup = cleanupFails;
    const setCookie = vi.fn((key: string, value: string) => {
      if (failWrites) throw new Error("Cookie write denied");
      values.set(key, value.split(";")[0]!);
    });
    const delCookie = vi.fn((key: string) => {
      if (failCleanup) throw new Error("Cookie removal denied");
      values.delete(key);
    });
    const options = {
      storage: { enabled: false, namePrefix },
      session: { enabled: false },
      cookieCfg: {
        getCookie: (key: string) => values.get(key) ?? "",
        setCookie,
        delCookie,
      },
    };
    const first = await initialize(options);
    first.handle.userContext.setAuthenticatedUserContext("A", "account-A", true);
    expect(first.emit()).toMatchObject({ "user.id": "A", "user.account.id": "account-A" });
    const previousAuthentication = values.get(name);
    expect(decodeCookie(name, previousAuthentication!)).toEqual({
      authenticatedUserId: "A",
      accountId: "account-A",
    });
    const manager = first.handle.getCookieMgr();
    const controlNames = [
      `${namePrefix}ai_user`,
      `${namePrefix}ai_session`,
      `${namePrefix}custom-cookie`,
      `${namePrefix ? "" : "app-a-"}ai_authUser`,
    ];
    for (const key of controlNames.slice(1)) expect(manager.set(key, "previous")).toBe(true);
    const previousControls = controlNames.map((key) => [key, values.get(key)]);
    manager.setEnabled(false);
    first.handle.userContext.setAuthenticatedUserContext("B", "account-B", true);
    for (const key of controlNames) expect(manager.set(key, values.get(key)!)).toBe(true);
    expect(values.get(name)).toBe(previousAuthentication);
    failWrites = true;
    expect(() => manager.setEnabled(true)).not.toThrow();
    expect(first.emit()).toMatchObject({ "user.id": "B", "user.account.id": "account-B" });
    expect(delCookie.mock.calls.map(([key]) => key)).toEqual([name]);
    expect(controlNames.map((key) => [key, values.get(key)])).toEqual(previousControls);
    if (cleanupFails) {
      expect(values.get(name)).toBe(previousAuthentication);
      failCleanup = false;
      // A failed removal must leave the pending replacement available for another bounded pass.
      expect(() => manager.setEnabled(true)).not.toThrow();
      expect(delCookie.mock.calls.map(([key]) => key)).toEqual([name, name]);
    }
    expect(values.has(name)).toBe(false);

    // Keep the first manager alive for its pending retry; emissions are instance-bound.
    const restored = await initialize(options);
    const withoutAuthentication = restored.emit();
    expect(withoutAuthentication["user.id"]).toBeUndefined();
    expect(withoutAuthentication["user.account.id"]).toBeUndefined();
    await restored.handle.shutdown();

    failWrites = false;
    manager.setEnabled(true);
    expect(decodeCookie(name, values.get(name)!)).toEqual({
      authenticatedUserId: "B",
      accountId: "account-B",
    });
    const writes = setCookie.mock.calls.length;
    manager.setEnabled(true);
    expect(setCookie).toHaveBeenCalledTimes(writes);
    const recovered = await initialize(options);
    expect(recovered.emit()).toMatchObject({ "user.id": "B", "user.account.id": "account-B" });
  },
);

it.each([
  { namePrefix: "", enabled: false },
  { namePrefix: "", enabled: true },
  { namePrefix: "app-a-", enabled: false },
  { namePrefix: "app-a-", enabled: true },
])(
  "cleans legacy Web Storage only through explicit identity controls (%j)",
  async ({ namePrefix, enabled }) => {
    const { storage, key, otherKey, legacy } = legacyUserStorage(namePrefix);
    const local = vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
    const session = vi.spyOn(window, "sessionStorage", "get");
    const read = vi.spyOn(storage, "getItem");
    const write = vi.spyOn(storage, "setItem");
    const remove = vi.spyOn(storage, "removeItem");
    const { handle, emit } = await initialize({
      storage: { namePrefix },
      session: { enabled: false },
      userContext: { enabled },
    });
    const initial = emit();
    expect(initial["user.id"]).toBeUndefined();
    expect(initial["user.account.id"]).toBeUndefined();
    if (enabled) expect(initial["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
    else expect(initial["enduser.pseudo.id"]).toBeUndefined();
    handle.userContext.setEnabled(true);
    handle.userContext.setAuthenticatedUserContext("current-user", "current-account", true);
    const current = emit();
    expect(current).toMatchObject({
      "user.id": "current-user",
      "user.account.id": "current-account",
    });
    expect(current["enduser.pseudo.id"]).not.toBe("legacy-anonymous");
    await handle.forceFlush();
    for (const operation of [local, session, read, write, remove]) {
      expect(operation).not.toHaveBeenCalled();
    }
    expect(storage.getItem(key)).toBe(legacy);
    expect(storage.getItem(otherKey)).toBe(legacy);

    handle.userContext.clearAuthenticatedUserContext();
    expect(storage.getItem(key)).toBe(JSON.stringify({ anonymousId: "legacy-anonymous" }));
    expect(storage.getItem(otherKey)).toBe(legacy);
    const cleared = emit();
    expect(cleared["user.id"]).toBeUndefined();
    expect(cleared["user.account.id"]).toBeUndefined();
    expect(cleared["enduser.pseudo.id"]).toBe(current["enduser.pseudo.id"]);
    expect(readCookie(`${namePrefix}ai_authUser`)).toBeNull();

    // Disable must remove the whole legacy record, even when it still contains authentication.
    storage.setItem(key, legacy);
    handle.userContext.setAuthenticatedUserContext("current-user", "current-account", true);
    handle.userContext.setEnabled(false);
    expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem(otherKey)).toBe(legacy);
    expect(emit()["enduser.pseudo.id"]).toBeUndefined();
    expect(readCookie(`${namePrefix}ai_user`)).toBeNull();
    expect(readCookie(`${namePrefix}ai_authUser`)).toBeNull();
    expect(session).not.toHaveBeenCalled();
  },
);

it.each(["", "app-a-"])(
  "never accesses legacy Web Storage through explicit controls when storage is disabled (prefix=%j)",
  async (namePrefix) => {
    const { storage, key, otherKey, legacy } = legacyUserStorage(namePrefix);
    const local = vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
    const session = vi.spyOn(window, "sessionStorage", "get");
    const read = vi.spyOn(storage, "getItem");
    const write = vi.spyOn(storage, "setItem");
    const remove = vi.spyOn(storage, "removeItem");
    const { handle, emit } = await initialize({ storage: { enabled: false, namePrefix } });
    expect(emit()["user.id"]).toBeUndefined();
    handle.userContext.setEnabled(true);
    handle.userContext.setAuthenticatedUserContext("current-user", "current-account", true);
    expect(emit()["user.id"]).toBe("current-user");
    handle.userContext.clearAuthenticatedUserContext();
    handle.userContext.setEnabled(false);
    handle.userContext.setEnabled(true);
    await handle.forceFlush();
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    await handle.shutdown();
    handle.userContext.clearAuthenticatedUserContext();
    handle.userContext.setEnabled(false);
    for (const operation of [local, session, read, write, remove]) {
      expect(operation).not.toHaveBeenCalled();
    }
    expect(storage.getItem(key)).toBe(legacy);
    expect(storage.getItem(otherKey)).toBe(legacy);
  },
);

it.each(["read", "write", "write and remove"] as const)(
  "contains legacy logout %s failures independently of cookie removal failures",
  async (failure) => {
    const { storage, key, otherKey, legacy } = legacyUserStorage("app-a-");
    vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
    const delCookie = vi.fn((_name: string) => {
      throw new Error("Cookie removal denied");
    });
    const { handle, emit } = await initialize({
      storage: { namePrefix: "app-a-" },
      session: { enabled: false },
      cookieCfg: { delCookie },
    });
    handle.userContext.setAuthenticatedUserContext("current-user", "current-account", true);
    const deny = () => {
      throw new Error("Web Storage operation denied");
    };
    if (failure === "read") vi.spyOn(storage, "getItem").mockImplementationOnce(deny);
    else vi.spyOn(storage, "setItem").mockImplementationOnce(deny);
    if (failure === "write and remove") {
      vi.spyOn(storage, "removeItem").mockImplementationOnce(deny);
    }
    expect(() => handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
    const cleared = emit();
    expect(cleared["user.id"]).toBeUndefined();
    expect(cleared["user.account.id"]).toBeUndefined();
    expect(delCookie).toHaveBeenCalledWith("app-a-ai_authUser", expect.any(String));
    expect(storage.getItem(key)).toBe(failure === "write and remove" ? legacy : null);
    expect(storage.getItem(otherKey)).toBe(legacy);
    // A retry removes stale authentication even while a failed write remains in backoff.
    handle.userContext.clearAuthenticatedUserContext();
    expect(storage.getItem(key)).toBeNull();
  },
);

it("retries explicit legacy disable after Web Storage and cookie removal fail", async () => {
  const { storage, key, otherKey, legacy } = legacyUserStorage("app-a-");
  vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
  const delCookie = vi.fn((_name: string) => {
    throw new Error("Cookie removal denied");
  });
  const { handle, emit } = await initialize({
    storage: { namePrefix: "app-a-" },
    session: { enabled: false },
    cookieCfg: { delCookie },
  });
  vi.spyOn(storage, "removeItem").mockImplementationOnce(() => {
    throw new Error("Web Storage removal denied");
  });
  expect(() => handle.userContext.setEnabled(false)).not.toThrow();
  expect(emit()["enduser.pseudo.id"]).toBeUndefined();
  expect(delCookie.mock.calls.map(([name]) => name)).toEqual([
    "app-a-ai_user",
    "app-a-ai_authUser",
  ]);
  expect(storage.getItem(key)).toBe(legacy);
  expect(() => handle.userContext.setEnabled(false)).not.toThrow();
  expect(storage.getItem(key)).toBeNull();
  expect(storage.getItem(otherKey)).toBe(legacy);
});

it("cancels deferred SDK cookie writes on shutdown and ignores stale enable calls", async () => {
  const { handle, emit } = await initialize({
    storage: { enabled: false },
    cookieCfg: { enabled: false },
  });
  handle.userContext.setAuthenticatedUserContext("queued-user", undefined, true);
  const attributes = emit();
  const manager = handle.getCookieMgr();
  expect(manager.get("ai_session")).not.toBe("");
  expect(manager.get("ai_authUser")).not.toBe("");
  expect(attributes["user.id"]).toBe("queued-user");
  const tracer = trace.getTracer("stale");
  const logger = logs.getLogger("stale");
  await handle.shutdown();
  const write = vi.spyOn(document, "cookie", "set");
  manager.setEnabled(true);
  handle.userContext.setEnabled(true);
  handle.userContext.setAuthenticatedUserContext("stale-user", undefined, true);
  tracer.startSpan("after-shutdown").end();
  logger.emit({});
  expect(manager.isEnabled()).toBe(false);
  expect(manager.get("ai_session")).toBe("");
  expect(manager.get("ai_authUser")).toBe("");
  expect(write).not.toHaveBeenCalled();
  expect(document.cookie).toBe("");
});

it.each([false, null, [], true, 0, "", "disabled", () => {}])(
  "rejects a malformed storage container before accessing browser storage (%j)",
  async (storage) => {
    for (const key of keys) preserve(key);
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const cookie = vi.spyOn(document, "cookie", "get");
    await expect(
      initialize({
        // @ts-expect-error Verify untyped JavaScript input.
        storage,
      }),
    ).rejects.toThrow("storage must be a non-null, non-array object.");
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  },
);

it.each(["inherited getters", "non-enumerable properties"])(
  "preserves session persistence and lifetime settings supplied through %s",
  async (kind) => {
    preserve("opentelemetry-session");
    class SessionOptions {
      get persist() {
        return false;
      }
      get inactivityTimeout() {
        return 1;
      }
      get maxDuration() {
        return 3;
      }
    }
    const session =
      kind === "inherited getters"
        ? new SessionOptions()
        : Object.defineProperties(
            {},
            {
              persist: { value: false },
              inactivityTimeout: { value: 1 },
              maxDuration: { value: 3 },
            },
          );
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const access = vi.spyOn(window, "localStorage", "get");
    const { emit, handle } = await initialize({ session, userContext: { enabled: false } });
    const first = emit()["session.id"];
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    clock.mockReturnValue(now + 1000);
    const renewed = emit()["session.id"];
    expect(renewed).not.toBe(first);
    for (const offset of [1500, 2000, 2500, 3000, 3500]) {
      clock.mockReturnValue(now + offset);
      expect(emit()["session.id"]).toBe(renewed);
    }
    clock.mockReturnValue(now + 4000);
    expect(emit()["session.id"]).not.toBe(renewed);
    await handle.shutdown();
    expect(access).not.toHaveBeenCalled();
  },
);

it.each([{ enabled: "false" }, { enabled: null }, { namePrefix: 42 }, { namePrefix: null }])(
  "rejects invalid storage options before accessing storage (%j)",
  async (storage) => {
    const access = vi.spyOn(window, "localStorage", "get");
    await expect(
      useMicrosoftOpenTelemetry({
        // @ts-expect-error Verify untyped JavaScript input.
        storage,
      }),
    ).rejects.toThrow("storage.enabled must be a boolean and storage.namePrefix a string.");
    expect(access).not.toHaveBeenCalled();
  },
);

it("accepts an empty prefix in the loader and validates storage options", () => {
  expect(
    getSdkLoaderScript({ connectionString: "connection", storage: { namePrefix: "" } }),
  ).toContain('"storage":{"namePrefix":""}');
  for (const storage of [{ enabled: "false" }, { namePrefix: 42 }]) {
    expect(() =>
      getSdkLoaderScript({
        connectionString: "connection",
        // @ts-expect-error Verify untyped JavaScript input.
        storage,
      }),
    ).toThrow(TypeError);
  }
});
