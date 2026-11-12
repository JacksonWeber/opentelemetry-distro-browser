// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
} from "../../../src/index.js";
import { USER_STORAGE_KEY as storageKey } from "../../../src/user/constants.js";

const handles = new Set<MicrosoftOpenTelemetryBrowser>();
let previousUser: string | null;
const userCookie = "ai_user";
const authKey = "ai_authUser";

function clearCookies() {
  for (const key of [userCookie, authKey, "ai_session"]) {
    document.cookie = `${key}=; max-age=0; path=/`;
  }
}

function readCookie(key = userCookie) {
  const value = document.cookie.split("; ").find((part) => part.startsWith(`${key}=`));
  if (!value) return null;
  const raw = value.slice(key.length + 1);
  if (raw.startsWith("%7B")) return JSON.parse(decodeURIComponent(raw));
  const [id, second] = (key === authKey ? decodeURI(raw) : raw).split("|");
  return key === userCookie
    ? { anonymousId: id, acquisitionTimestamp: Date.parse(second!) }
    : { authenticatedUserId: id, ...(second !== undefined && { accountId: second }) };
}

function storeCookie(value: string, key = userCookie) {
  let encoded = encodeURIComponent(value);
  try {
    const record = JSON.parse(value);
    if (
      key === userCookie &&
      typeof record?.anonymousId === "string" &&
      typeof record.acquisitionTimestamp === "number"
    ) {
      encoded = `${record.anonymousId}|${new Date(record.acquisitionTimestamp).toISOString()}`;
    } else if (key === authKey && typeof record?.authenticatedUserId === "string") {
      encoded = encodeURI(
        record.authenticatedUserId + (record.accountId === undefined ? "" : `|${record.accountId}`),
      );
    }
  } catch {
    // Keep malformed JSON fixtures encoded for negative restoration tests.
  }
  document.cookie = `${key}=${encoded}; path=/`;
}

function failWrites() {
  return vi.spyOn(document, "cookie", "set").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
}

beforeEach(() => {
  clearCookies();
  previousUser = localStorage.getItem(storageKey);
  localStorage.removeItem(storageKey);
});

afterEach(async () => {
  await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearCookies();
  if (previousUser === null) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, previousUser);
});

async function initialize(
  persistence: boolean | "default" = false,
  resourceAttributes?: Record<string, string>,
) {
  const spans: Span[] = [];
  const records: ReadWriteLogRecord[] = [];
  const handle = await useMicrosoftOpenTelemetry({
    ...(persistence === "default" ? {} : { userContext: { enabled: persistence } }),
    session: { enabled: false },
    pageView: { enabled: false },
    ...(resourceAttributes && { resource: resourceFromAttributes(resourceAttributes) }),
    spanProcessors: [
      {
        onStart: (span) => spans.push(span),
        onEnd() {},
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    logRecordProcessors: [
      {
        onEmit: (record) => records.push(record),
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  handles.add(handle);
  function emit(attributes = {}) {
    trace.getTracer("user-test").startSpan("operation", { attributes }).end();
    logs.getLogger("user-test").emit({ attributes });
    const span = spans.at(-1)!;
    const log = records.at(-1)!;
    for (const key of ["enduser.pseudo.id", "user.id", "user.account.id"]) {
      expect(log.attributes[key]).toEqual(span.attributes[key]);
    }
    return { span, log };
  }
  return { handle, emit };
}

it("does not apply anonymous identity or access storage before persistence is enabled", async () => {
  const access = vi.spyOn(window, "localStorage", "get");
  const { emit } = await initialize();
  const first = emit();
  const second = emit();
  for (const record of [first.span, first.log, second.span, second.log]) {
    expect(record.attributes["enduser.pseudo.id"]).toBeUndefined();
  }
  expect(access).not.toHaveBeenCalled();
});

it("persists anonymous identity for a year but keeps default authentication in memory", async () => {
  const write = vi.spyOn(document, "cookie", "set");
  const first = await initialize("default");
  const anonymousId = first.emit().span.attributes["enduser.pseudo.id"];
  expect(anonymousId).toMatch(/^[0-9a-f]{32}$/);
  const stored = readCookie();
  expect(stored).toEqual({ anonymousId, acquisitionTimestamp: expect.any(Number) });
  expect(write).toHaveBeenCalledWith(expect.stringContaining("max-age=31536000"));
  expect(localStorage.getItem(storageKey)).toBeNull();

  first.handle.userContext.setAuthenticatedUserContext("signed-in-user", "tenant-42");
  expect(first.emit().span.attributes).toMatchObject({
    "enduser.pseudo.id": anonymousId,
    "user.id": "signed-in-user",
    "user.account.id": "tenant-42",
  });
  expect(readCookie()).toEqual(stored);
  expect(readCookie(authKey)).toBeNull();

  await first.handle.shutdown();
  handles.delete(first.handle);
  trace.disable();
  logs.disable();

  const restored = await initialize("default");
  const emitted = restored.emit();
  for (const record of [emitted.span, emitted.log]) {
    expect(record.attributes["enduser.pseudo.id"]).toBe(anonymousId);
    expect(record.attributes["user.id"]).toBeUndefined();
    expect(record.attributes["user.account.id"]).toBeUndefined();
  }
});

it("restores explicitly opted-in authentication by default without changing cookies", async () => {
  const optedIn = await initialize(true);
  optedIn.handle.userContext.setAuthenticatedUserContext("signed-in-user", "tenant-42", true);
  const stored = readCookie();
  const authentication = readCookie(authKey);
  expect(authentication).toEqual({ authenticatedUserId: "signed-in-user", accountId: "tenant-42" });
  await optedIn.handle.shutdown();
  handles.delete(optedIn.handle);
  trace.disable();
  logs.disable();

  const defaultHandle = await initialize("default");
  expect(defaultHandle.emit().span.attributes).toMatchObject({
    "enduser.pseudo.id": stored.anonymousId,
  });
  expect(defaultHandle.emit().span.attributes["user.id"]).toBe("signed-in-user");
  expect(defaultHandle.emit().span.attributes["user.account.id"]).toBe("tenant-42");
  expect(readCookie()).toEqual(stored);
  expect(readCookie(authKey)).toEqual(authentication);
  await defaultHandle.handle.shutdown();
  handles.delete(defaultHandle.handle);
  trace.disable();
  logs.disable();

  const restored = await initialize(true);
  expect(restored.emit().span.attributes).toMatchObject({
    "enduser.pseudo.id": stored.anonymousId,
    "user.id": "signed-in-user",
    "user.account.id": "tenant-42",
  });
});

it("persists, restores, and removes identity when persistence is enabled or disabled", async () => {
  const first = await initialize();
  first.handle.userContext.setAuthenticatedUserContext("signed-in-user", "tenant-42", true);
  expect(localStorage.getItem(storageKey)).toBeNull();
  const emitted = first.emit();
  expect(emitted.span.attributes).toMatchObject({
    "user.id": "signed-in-user",
    "user.account.id": "tenant-42",
  });
  expect(emitted.span.attributes["enduser.pseudo.id"]).toBeUndefined();

  first.handle.userContext.setEnabled(true);
  const persisted = first.emit();
  const stored = readCookie();
  expect(stored).toMatchObject({
    anonymousId: persisted.span.attributes["enduser.pseudo.id"],
    acquisitionTimestamp: expect.any(Number),
  });
  expect(readCookie(authKey)).toEqual({
    authenticatedUserId: "signed-in-user",
    accountId: "tenant-42",
  });
  await first.handle.shutdown();
  handles.delete(first.handle);
  trace.disable();
  logs.disable();

  const restored = await initialize(true);
  expect(restored.emit().span.attributes).toMatchObject({
    "enduser.pseudo.id": stored.anonymousId,
    "user.id": "signed-in-user",
    "user.account.id": "tenant-42",
  });
  restored.handle.userContext.clearAuthenticatedUserContext();
  expect(restored.emit().span.attributes["user.id"]).toBeUndefined();
  expect(readCookie()).toEqual(stored);
  expect(readCookie(authKey)).toBeNull();
  restored.handle.userContext.setEnabled(false);
  expect(readCookie()).toBeNull();
  expect(readCookie(authKey)).toBeNull();
});

it("creates and persists an anonymous identity when enabled without stored state", async () => {
  const { emit } = await initialize(true);
  const anonymousId = emit().span.attributes["enduser.pseudo.id"];

  expect(readCookie()).toEqual({ anonymousId, acquisitionTimestamp: expect.any(Number) });
});

it("removes persisted authentication on logout after shutdown without resurrecting it on reload", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("signed-in-user", "tenant-42", true);
  const anonymous = readCookie();
  await current.handle.shutdown();
  expect(readCookie(authKey)).toEqual({
    authenticatedUserId: "signed-in-user",
    accountId: "tenant-42",
  });
  const read = vi.spyOn(document, "cookie", "get");
  current.handle.userContext.clearAuthenticatedUserContext();
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  expect(readCookie(authKey)).toBeNull();
  expect(readCookie()).toEqual(anonymous);

  const restored = await initialize(true);
  const { span, log } = restored.emit();
  for (const record of [span, log]) {
    expect(record.attributes["enduser.pseudo.id"]).toBe(anonymous.anonymousId);
    expect(record.attributes["user.id"]).toBeUndefined();
    expect(record.attributes["user.account.id"]).toBeUndefined();
  }
  expect(readCookie(authKey)).toBeNull();
});

it.each([false, true])(
  "preserves explicit authentication cookie opt-in=%s across identity disable/enable and reload",
  async (storeAuthentication) => {
    const first = await initialize();
    first.handle.userContext.setAuthenticatedUserContext(
      "user 雪%2F",
      "account=42",
      storeAuthentication,
    );
    expect(readCookie(authKey)).toBeNull();
    const write = vi.spyOn(document, "cookie", "set");
    first.handle.userContext.setEnabled(true);
    const identity = first.emit().span.attributes;
    expect(identity).toMatchObject({ "user.id": "user 雪%2F", "user.account.id": "account=42" });
    expect(identity["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
    const authentication = { authenticatedUserId: "user 雪%2F", accountId: "account=42" };
    expect(readCookie(authKey)).toEqual(storeAuthentication ? authentication : null);
    if (storeAuthentication) {
      const authWrite = write.mock.calls.find(([value]) => value.startsWith(`${authKey}=`))![0];
      expect(authWrite).not.toMatch(/max-age=|expires=/);
    }
    first.handle.userContext.setEnabled(false);
    expect(readCookie()).toBeNull();
    expect(readCookie(authKey)).toBeNull();
    expect(first.emit().span.attributes).toMatchObject({
      "user.id": "user 雪%2F",
      "user.account.id": "account=42",
    });
    first.handle.userContext.setEnabled(true);
    expect(readCookie(authKey)).toEqual(storeAuthentication ? authentication : null);
    await first.handle.shutdown();
    handles.delete(first.handle);
    trace.disable();
    logs.disable();
    const restored = await initialize("default");
    const attributes = restored.emit().span.attributes;
    expect(attributes["enduser.pseudo.id"]).toBe(identity["enduser.pseudo.id"]);
    expect(attributes["user.id"]).toBe(storeAuthentication ? "user 雪%2F" : undefined);
    expect(attributes["user.account.id"]).toBe(storeAuthentication ? "account=42" : undefined);
  },
);

it.each([
  "",
  "{malformed-private-payload",
  "null",
  '{"anonymousId":""}',
  '{"anonymousId":"anonymous","accountId":"tenant"}',
  '["anonymous"]',
])("replaces invalid stored identity (%j) without logging its contents", async (stored) => {
  storeCookie(stored);
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});

  const { emit } = await initialize(true);
  const anonymousId = emit().span.attributes["enduser.pseudo.id"];

  expect(anonymousId).toMatch(/^[0-9a-f]{32}$/);
  expect(readCookie()).toEqual({ anonymousId, acquisitionTimestamp: expect.any(Number) });
  expect(warn).not.toHaveBeenCalled();
});

it("suppresses invalid stored identity when replacement cookie persistence fails", async () => {
  storeCookie("{malformed-private-payload");
  failWrites();
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});

  const { emit } = await initialize(true);

  expect(emit().span.attributes["enduser.pseudo.id"]).toBeUndefined();
  expect(warn.mock.calls).toEqual(
    Array.from({ length: 3 }, () => ["Cookie operation failed or cookies are unavailable."]),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain("malformed-private-payload");
});

it("recovers anonymous persistence on telemetry after a transient replacement failure", async () => {
  storeCookie("{malformed-private-payload");
  const write = vi.spyOn(document, "cookie", "set").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const { emit } = await initialize(true);
  expect(write).toHaveBeenCalledOnce();

  const { span, log } = emit();
  const anonymousId = span.attributes["enduser.pseudo.id"];
  expect(anonymousId).toMatch(/^[0-9a-f]{32}$/);
  expect(log.attributes["enduser.pseudo.id"]).toBe(anonymousId);
  expect(readCookie()).toEqual({ anonymousId, acquisitionTimestamp: expect.any(Number) });
  expect(write).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "Cookie operation failed or cookies are unavailable.",
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain("malformed-private-payload");
});

it("continues in memory when invalid stored identity cannot be replaced or removed", async () => {
  storeCookie("{malformed-private-payload");
  failWrites();

  const { handle, emit } = await initialize(true);

  expect(emit().span.attributes["enduser.pseudo.id"]).toBeUndefined();
  expect(() => handle.userContext.setEnabled(false)).not.toThrow();
  handle.userContext.setAuthenticatedUserContext("memory-user");
  expect(emit().span.attributes["user.id"]).toBe("memory-user");
});

it.each([
  ["anonymousId", "{}", /^[0-9a-f]{32}$/, { "user.id": undefined, "user.account.id": undefined }],
  [
    "authenticatedUserId",
    '{"anonymousId":"own-anonymous","acquisitionTimestamp":42}',
    /^own-anonymous$/,
    { "user.id": undefined, "user.account.id": undefined },
  ],
  [
    "accountId",
    '{"anonymousId":"own-anonymous","acquisitionTimestamp":42}',
    /^own-anonymous$/,
    { "user.id": "own-user", "user.account.id": undefined },
  ],
] as const)("ignores inherited %s on stored identity", async (key, stored, pseudoId, expected) => {
  storeCookie(stored);
  if (key === "accountId") storeCookie('{"authenticatedUserId":"own-user"}', authKey);
  Object.defineProperty(Object.prototype, key, { value: "polluted", configurable: true });
  try {
    const { emit } = await initialize(true);
    const attributes = emit().span.attributes;

    expect(attributes["enduser.pseudo.id"]).toMatch(pseudoId);
    for (const [name, value] of Object.entries(expected)) {
      expect(attributes[name]).toBe(value);
    }
  } finally {
    delete (Object.prototype as Record<string, unknown>)[key];
  }
});

it.each([
  ["missing Web Crypto", undefined],
  ["Web Crypto without getRandomValues", {}],
])("generates an anonymous identity with %s", async (_name, crypto) => {
  vi.stubGlobal("crypto", crypto);

  const { emit } = await initialize(true);

  expect(emit().span.attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
});

it("retains anonymous cookie identity when localStorage is unavailable", async () => {
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  vi.stubGlobal("localStorage", undefined);

  const { handle, emit } = await initialize(true);

  expect(emit().span.attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(() => handle.userContext.setAuthenticatedUserContext("signed-in-user")).not.toThrow();
  expect(warn).not.toHaveBeenCalled();
});

it("can enable persistence after cookies become available", async () => {
  const write = failWrites();
  const current = await initialize(true);
  expect(current.emit().span.attributes["enduser.pseudo.id"]).toBeUndefined();
  write.mockRestore();

  expect(() => current.handle.userContext.setEnabled(true)).not.toThrow();
  expect(readCookie()).toEqual({
    anonymousId: current.emit().span.attributes["enduser.pseudo.id"],
    acquisitionTimestamp: expect.any(Number),
  });
});

it("reports cookie cleanup failure but disables enrichment when identity cannot be removed", async () => {
  const current = await initialize(true);
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  failWrites();

  expect(() => current.handle.userContext.setEnabled(false)).not.toThrow();
  expect(current.emit().span.attributes["enduser.pseudo.id"]).toBeUndefined();
  expect(readCookie()).not.toBeNull();
  expect(warn).toHaveBeenCalledWith("Cookie operation failed or cookies are unavailable.");
});

it("does not throw when disabling in-memory persistence with inaccessible storage", async () => {
  const current = await initialize();
  vi.spyOn(diag, "warn").mockImplementation(() => {});
  failWrites();

  expect(() => current.handle.userContext.setEnabled(false)).not.toThrow();
});

it("removes identity persisted by an earlier page load when disabling", async () => {
  storeCookie(JSON.stringify({ anonymousId: "earlier-page", acquisitionTimestamp: 42 }));
  const current = await initialize();

  current.handle.userContext.setEnabled(false);

  expect(readCookie()).toBeNull();
});

it("does not throw when signing out with inaccessible storage and persistence disabled", async () => {
  vi.spyOn(diag, "warn").mockImplementation(() => {});
  vi.stubGlobal("localStorage", undefined);
  const current = await initialize();
  current.handle.userContext.setAuthenticatedUserContext("signed-in-user");

  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
  expect(current.emit().span.attributes["user.id"]).toBeUndefined();
});

it.each([
  ["application user.id", { "user.id": "application-user" }],
  ["application enduser.id", { "enduser.id": "application-user" }],
  ["application user.account.id", { "user.account.id": "application-account" }],
])("does not mix managed identity with %s", async (_name, attributes) => {
  const { handle, emit } = await initialize();
  handle.userContext.setAuthenticatedUserContext("managed-user", "managed-account");

  const { span, log } = emit(attributes);

  for (const record of [span, log]) {
    expect(record.attributes).toEqual(expect.objectContaining(attributes));
    expect(record.attributes["user.id"]).not.toBe("managed-user");
    expect(record.attributes["user.account.id"]).not.toBe("managed-account");
  }
});

it("preserves a resource enduser.pseudo.id instead of generating one", async () => {
  const { emit } = await initialize(false, { "enduser.pseudo.id": "resource-anonymous" });

  const { span, log } = emit();

  for (const record of [span, log]) {
    expect(record.attributes["enduser.pseudo.id"]).toBeUndefined();
    expect(record.resource.attributes["enduser.pseudo.id"]).toBe("resource-anonymous");
  }
});

it.each([
  ["user.id", { "user.id": "resource-user" }],
  ["enduser.id", { "enduser.id": "resource-user" }],
  ["user.account.id", { "user.account.id": "resource-account" }],
])("does not mix managed identity with resource %s", async (_name, resourceAttributes) => {
  const { handle, emit } = await initialize(false, resourceAttributes);
  handle.userContext.setAuthenticatedUserContext("managed-user", "managed-account");

  const { span, log } = emit();

  for (const record of [span, log]) {
    expect(record.attributes["user.id"]).toBeUndefined();
    expect(record.attributes["user.account.id"]).toBeUndefined();
    expect(record.resource.attributes).toEqual(expect.objectContaining(resourceAttributes));
  }
});

it("reports cookie failure without throwing or retaining in-memory auth on sign-out", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("signed-in-user", undefined, true);
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  failWrites();

  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
  expect(current.emit().span.attributes["user.id"]).toBeUndefined();
  expect(readCookie(authKey)).toEqual({ authenticatedUserId: "signed-in-user" });
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "Cookie operation failed or cookies are unavailable.",
  );
});

it("removes superseded identity when a new authenticated identity cannot be saved", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("persisted-user", undefined, true);
  const write = vi.spyOn(document, "cookie", "set").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });

  expect(() =>
    current.handle.userContext.setAuthenticatedUserContext("new-user", undefined, true),
  ).not.toThrow();
  expect(write).toHaveBeenCalledWith(expect.stringContaining(`${authKey}=; expires=`));
  expect(readCookie(authKey)).toBeNull();
  expect(current.emit().span.attributes["user.id"]).toBe("new-user");

  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
  const stored = readCookie();
  expect(stored).toEqual({
    anonymousId: expect.any(String),
    acquisitionTimestamp: expect.any(Number),
  });
  expect(current.emit().span.attributes["enduser.pseudo.id"]).toBe(stored.anonymousId);
  expect(current.emit().span.attributes["user.id"]).toBeUndefined();
});

it("recovers from a quota-limited cookie write on an explicit authentication retry", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("persisted-user", undefined, true);
  vi.spyOn(document, "cookie", "set").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });

  expect(() =>
    current.handle.userContext.setAuthenticatedUserContext("new-user", undefined, true),
  ).not.toThrow();
  expect(readCookie(authKey)).toBeNull();
  current.handle.userContext.setAuthenticatedUserContext("new-user", undefined, true);
  expect(readCookie(authKey)).toMatchObject({
    authenticatedUserId: "new-user",
  });
});

it("clears a previous account when authenticated identity is set without one", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("first-user", "first-account", true);

  current.handle.userContext.setAuthenticatedUserContext("second-user", undefined, true);

  expect(current.emit().span.attributes["user.account.id"]).toBeUndefined();
  expect(readCookie(authKey)).toEqual({ authenticatedUserId: "second-user" });
});

it("retries authenticated identity persistence after storage recovers", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("persisted-user", undefined, true);
  const write = failWrites();

  expect(() =>
    current.handle.userContext.setAuthenticatedUserContext("new-user", undefined, true),
  ).not.toThrow();
  expect(readCookie(authKey)).toEqual({ authenticatedUserId: "persisted-user" });
  write.mockRestore();

  expect(() =>
    current.handle.userContext.setAuthenticatedUserContext("retried-user", undefined, true),
  ).not.toThrow();
  const stored = readCookie(authKey);
  expect(stored).toMatchObject({ authenticatedUserId: "retried-user" });
  expect(current.emit().span.attributes).toMatchObject({
    "enduser.pseudo.id": readCookie().anonymousId,
    "user.id": "retried-user",
  });
});

it("retries authenticated persistence after a default-mode clear failure", async () => {
  const current = await initialize("default");
  current.handle.userContext.setAuthenticatedUserContext("old-user", undefined, true);
  const write = failWrites();

  current.handle.userContext.clearAuthenticatedUserContext();
  expect(readCookie(authKey)).toEqual({ authenticatedUserId: "old-user" });
  expect(current.emit().span.attributes["user.id"]).toBeUndefined();
  write.mockRestore();

  expect(() =>
    current.handle.userContext.setAuthenticatedUserContext(
      "in-memory-user",
      "in-memory-account",
      true,
    ),
  ).not.toThrow();
  const stored = readCookie(authKey);
  expect(stored).toEqual({
    authenticatedUserId: "in-memory-user",
    accountId: "in-memory-account",
  });
  expect(current.emit().span.attributes).toMatchObject({
    "enduser.pseudo.id": readCookie().anonymousId,
    "user.id": "in-memory-user",
    "user.account.id": "in-memory-account",
  });
});

it("reports cookie write failure while keeping anonymous and authenticated enrichment available", async () => {
  const current = await initialize(true);
  const anonymousId = readCookie().anonymousId;
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  failWrites();

  expect(() =>
    current.handle.userContext.setAuthenticatedUserContext("signed-in-user", undefined, true),
  ).not.toThrow();
  const { span, log } = current.emit();
  for (const record of [span, log]) {
    expect(record.attributes["enduser.pseudo.id"]).toBe(anonymousId);
    expect(record.attributes["user.id"]).toBe("signed-in-user");
  }
  expect(readCookie(authKey)).toBeNull();
  expect(warn).toHaveBeenCalledWith("Cookie operation failed or cookies are unavailable.");
});

it("keeps reporting cookie cleanup failure and retries disabling stale persisted identity", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("persisted-user", undefined, true);
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const write = failWrites();

  expect(() =>
    current.handle.userContext.setAuthenticatedUserContext("new-user", undefined, true),
  ).not.toThrow();
  expect(() => current.handle.userContext.setEnabled(false)).not.toThrow();
  expect(current.emit().span.attributes["enduser.pseudo.id"]).toBeUndefined();
  expect(readCookie(authKey)).toMatchObject({
    authenticatedUserId: "persisted-user",
  });

  expect(warn).toHaveBeenCalledTimes(4);
  write.mockRestore();
  expect(() => current.handle.userContext.setEnabled(false)).not.toThrow();
  expect(readCookie()).toBeNull();
  expect(readCookie(authKey)).toBeNull();
});

it("clears absent authentication idempotently without Web Storage access", async () => {
  const current = await initialize();
  const remove = vi.spyOn(Storage.prototype, "removeItem");

  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
  expect(remove).not.toHaveBeenCalled();
  expect(readCookie(authKey)).toBeNull();
});

it("removes persisted authentication without reading an inaccessible cookie", async () => {
  storeCookie(JSON.stringify({ authenticatedUserId: "signed-in-user" }), authKey);
  const current = await initialize();
  const read = vi.spyOn(document, "cookie", "get").mockImplementation(() => {
    throw { name: "SecurityError" };
  });

  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  expect(readCookie(authKey)).toBeNull();
});

it("can remove persisted identity after quota-limited writes", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("old-user", undefined, true);
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const remove = vi.spyOn(document, "cookie", "set").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });

  expect(() =>
    current.handle.userContext.setAuthenticatedUserContext("signed-in-user", undefined, true),
  ).not.toThrow();
  expect(() => current.handle.userContext.setEnabled(false)).not.toThrow();

  expect(remove).toHaveBeenCalledWith(expect.stringContaining(`${authKey}=; expires=`));
  expect(readCookie()).toBeNull();
  expect(readCookie(authKey)).toBeNull();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "Cookie operation failed or cookies are unavailable.",
  );
});

it("removes invalid persisted state while clearing authentication", async () => {
  storeCookie("{malformed-private-payload", authKey);
  const current = await initialize();

  current.handle.userContext.clearAuthenticatedUserContext();

  expect(readCookie(authKey)).toBeNull();
});

it("clears previously persisted authentication when persistence is disabled", async () => {
  storeCookie(
    JSON.stringify({
      anonymousId: "persisted-anonymous",
      acquisitionTimestamp: 42,
    }),
  );
  storeCookie(
    JSON.stringify({
      authenticatedUserId: "signed-out-user",
      accountId: "signed-out-account",
    }),
    authKey,
  );
  const current = await initialize();

  current.handle.userContext.clearAuthenticatedUserContext();

  expect(readCookie()).toEqual({
    anonymousId: "persisted-anonymous",
    acquisitionTimestamp: 42,
  });
  expect(readCookie(authKey)).toBeNull();
  await current.handle.shutdown();
  handles.delete(current.handle);
  trace.disable();
  logs.disable();

  const restored = await initialize(true);
  expect(restored.emit().span.attributes).toMatchObject({
    "enduser.pseudo.id": "persisted-anonymous",
  });
  expect(restored.emit().span.attributes["user.id"]).toBeUndefined();
  expect(restored.emit().span.attributes["user.account.id"]).toBeUndefined();
});

it("preserves application-provided identity attributes", async () => {
  const { handle, emit } = await initialize();
  handle.userContext.setAuthenticatedUserContext("managed-user", "managed-account");
  const { span, log } = emit({
    "enduser.pseudo.id": "application-anonymous",
    "enduser.id": "application-authenticated",
    "user.account.id": "application-account",
  });
  for (const record of [span, log]) {
    expect(record.attributes).toMatchObject({
      "enduser.pseudo.id": "application-anonymous",
      "enduser.id": "application-authenticated",
      "user.account.id": "application-account",
    });
    expect(record.attributes["user.id"]).toBeUndefined();
  }
});

it.each([
  ["", undefined, "Authenticated user ID"],
  ["user", "", "Account ID"],
] as const)(
  "rejects invalid authenticated context (%j, %j)",
  async (userId, accountId, message) => {
    const { handle } = await initialize();
    expect(() => handle.userContext.setAuthenticatedUserContext(userId, accountId)).toThrow(
      message,
    );
  },
);
