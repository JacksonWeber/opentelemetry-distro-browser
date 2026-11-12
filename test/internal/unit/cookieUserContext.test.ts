// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { createCookieManager } from "../../../src/storage/cookieManager.js";
import { createKeyValueStorage } from "../../../src/storage/keyValueStorage.js";
import { createSession } from "../../../src/session/createSession.js";
import type { MicrosoftOpenTelemetryBrowserCookieManager } from "../../../src/types.js";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import { createCookieUserContext } from "../../../src/user/createCookieUserContext.js";
import { createUserContext } from "../../../src/user/createUserContext.js";
import { MemoryStorage } from "../../fixtures/sessionStorageSetup.js";

const anonymousCookie = "ai_user";
const authenticatedCookie = "ai_authUser";
const legacyEncode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const encode = (
  value:
    | { anonymousId: string; acquisitionTimestamp: number }
    | { authenticatedUserId: string; accountId?: string },
) =>
  "anonymousId" in value
    ? `${value.anonymousId}|${new Date(value.acquisitionTimestamp).toISOString()}`
    : encodeURI(
        value.authenticatedUserId + (value.accountId === undefined ? "" : `|${value.accountId}`),
      );
function decode(value: string) {
  const parts = decodeURI(value).split("|");
  if (parts[1]?.includes("T")) {
    return { anonymousId: parts[0], acquisitionTimestamp: Date.parse(parts[1]) };
  }
  return { authenticatedUserId: parts[0], ...(parts.length > 1 && { accountId: parts[1] }) };
}

function fakeManager() {
  const values = new Map<string, string>();
  const cookies = {
    isEnabled: vi.fn(() => true),
    setEnabled: vi.fn(),
    get: vi.fn((name: string) => values.get(name) ?? ""),
    set: vi.fn((name: string, value: string, _maxAgeSec?: number) => {
      values.set(name, value);
      return true;
    }),
    del: vi.fn((name: string) => {
      values.delete(name);
      return true;
    }),
    purge: vi.fn((name: string) => {
      values.delete(name);
      return true;
    }),
  } satisfies MicrosoftOpenTelemetryBrowserCookieManager;
  return { cookies, values };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["hook", "browser"] as const)(
  "retries a failed anonymous %s read without replacing identity or notifying a new user",
  (source) => {
    const existing = encode({ anonymousId: "existing-user", acquisitionTimestamp: 42 });
    let unavailable = true;
    const read = vi.fn((name: string) => {
      if (unavailable && (source === "browser" || name === anonymousCookie)) {
        throw new Error("cookie read unavailable");
      }
      return name === anonymousCookie ? existing : "";
    });
    if (source === "browser") {
      vi.spyOn(document, "cookie", "get").mockImplementation(() => {
        const value = read(anonymousCookie);
        return `${anonymousCookie}=${value}`;
      });
    }
    const write = vi.fn();
    const cookies = createCookieManager({
      ...(source === "hook" ? { getCookie: read } : {}),
      setCookie: write,
    });
    const onNewUser = vi.fn();
    const { context, provider } = createCookieUserContext(true, cookies, "", onNewUser);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    context.setEnabled(true);
    expect(write).not.toHaveBeenCalled();
    expect(onNewUser).not.toHaveBeenCalled();
    unavailable = false;
    expect(provider.getAnonymousUserId()).toBe("existing-user");
    expect(write).not.toHaveBeenCalled();
    expect(onNewUser).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "invokes legacy cleanup only for explicit logout and disable (initially enabled: %s)",
  (enabled) => {
    const { cookies } = fakeManager();
    const cleanup = vi.fn((_action: "clear" | "purge") => {});
    const { context, provider, shutdown } = createCookieUserContext(
      enabled,
      cookies,
      "app-",
      undefined,
      true,
      cleanup,
    );
    provider.getAnonymousUserId();
    context.setAuthenticatedUserContext("memory-user", "account");
    context.setEnabled(true);
    context.setAuthenticatedUserContext("persisted-user", "account", true);
    expect(cleanup).not.toHaveBeenCalled();

    context.clearAuthenticatedUserContext();
    expect(cleanup.mock.calls).toEqual([["clear"]]);
    context.setEnabled(false);
    context.setEnabled(false);
    expect(cleanup.mock.calls).toEqual([["clear"], ["purge"], ["purge"]]);

    cleanup.mockClear();
    shutdown();
    context.setEnabled(true);
    context.setAuthenticatedUserContext("stale-user", undefined, true);
    provider.getAnonymousUserId();
    expect(cleanup).not.toHaveBeenCalled();
    context.clearAuthenticatedUserContext();
    context.setEnabled(false);
    expect(cleanup.mock.calls).toEqual([["clear"], ["purge"]]);
  },
);

it.each(["clear", "purge"] as const)(
  "contains legacy %s cleanup failures independently of cookie cleanup failures",
  (action) => {
    const { cookies } = fakeManager();
    const cleanup = vi.fn((_action: "clear" | "purge") => {
      throw new Error("private legacy identity");
    });
    const warn = vi.spyOn(diag, "warn");
    const { context, provider } = createCookieUserContext(
      true,
      cookies,
      "",
      undefined,
      true,
      cleanup,
    );
    context.setAuthenticatedUserContext("user", "account", true);
    cookies.del.mockImplementation(() => {
      throw new Error("cookie deletion failed");
    });
    cookies.purge.mockImplementation(() => {
      throw new Error("cookie purge failed");
    });

    expect(() => {
      if (action === "clear") context.clearAuthenticatedUserContext();
      else context.setEnabled(false);
    }).not.toThrow();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(action);
    if (action === "clear") {
      expect(provider.getAuthenticatedUserId()).toBeUndefined();
      expect(provider.getAccountId()).toBeUndefined();
      expect(provider.getAnonymousUserId()).toBeDefined();
      expect(cookies.del).toHaveBeenCalledWith(authenticatedCookie);
    } else {
      expect(provider.getAnonymousUserId()).toBeUndefined();
      expect(provider.getAuthenticatedUserId()).toBe("user");
      expect(provider.getAccountId()).toBe("account");
      expect(cookies.purge.mock.calls).toEqual([[anonymousCookie], [authenticatedCookie]]);
    }
    expect(warn).not.toHaveBeenCalled();
  },
);

it.each([
  { prefix: "", enabled: false },
  { prefix: "", enabled: true },
  { prefix: "app-", enabled: false },
  { prefix: "app-", enabled: true },
])("scopes legacy cleanup without restoring identity (%j)", ({ prefix, enabled }) => {
  const localStorage = new MemoryStorage();
  const legacy = JSON.stringify({
    anonymousId: "old-anonymous",
    authenticatedUserId: "old-user",
    accountId: "old-account",
  });
  const key = `${prefix}opentelemetry-user`;
  const otherKey = `${prefix ? "" : "other-"}opentelemetry-user`;
  localStorage.setItem(key, legacy);
  localStorage.setItem(otherKey, legacy);
  const local = vi.spyOn(window, "localStorage", "get").mockReturnValue(localStorage);
  const session = vi.spyOn(window, "sessionStorage", "get");
  const storage = createKeyValueStorage("localStorage", "Legacy cleanup unavailable.", prefix);
  // The previous provider is a cleanup reference, not a source for cookie-backed identity.
  const previous = createUserContext(false, storage);
  const cleanup = vi.fn((action: "clear" | "purge") => {
    if (action === "clear") previous.context.clearAuthenticatedUserContext();
    else previous.context.setEnabled(false);
  });
  const { cookies } = fakeManager();
  const { context, provider } = createCookieUserContext(
    enabled,
    cookies,
    prefix,
    undefined,
    true,
    cleanup,
  );
  expect(provider.getAnonymousUserId()).not.toBe("old-anonymous");
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(provider.getAccountId()).toBeUndefined();
  expect(cleanup).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe(legacy);

  context.setAuthenticatedUserContext("current-user", "current-account", true);
  context.clearAuthenticatedUserContext();
  expect(cleanup).toHaveBeenCalledExactlyOnceWith("clear");
  expect(local).toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe(JSON.stringify({ anonymousId: "old-anonymous" }));
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(provider.getAccountId()).toBeUndefined();
  context.setEnabled(true);
  expect(provider.getAnonymousUserId()).not.toBe("old-anonymous");
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(cookies.get(`${prefix}${authenticatedCookie}`)).toBe("");
  expect(localStorage.getItem(otherKey)).toBe(legacy);

  // Disabling removes the whole old record, but still keeps current authentication in memory.
  localStorage.setItem(key, legacy);
  context.setAuthenticatedUserContext("current-user", "current-account", true);
  context.setEnabled(false);
  expect(localStorage.getItem(key)).toBeNull();
  expect(localStorage.getItem(otherKey)).toBe(legacy);
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(provider.getAuthenticatedUserId()).toBe("current-user");
  expect(provider.getAccountId()).toBe("current-account");
  expect(cleanup.mock.calls).toEqual([["clear"], ["purge"]]);
  expect(session).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps legacy cleanup free of Web Storage access when permission is denied (initially enabled: %s)",
  (enabled) => {
    const local = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("Web Storage must not be accessed");
    });
    const session = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("Web Storage must not be accessed");
    });
    const storage = createKeyValueStorage("localStorage", "Legacy cleanup unavailable.", "app-");
    const previous = createUserContext(false, storage, false);
    const cleanup = vi.fn((action: "clear" | "purge") => {
      if (action === "clear") previous.context.clearAuthenticatedUserContext();
      else previous.context.setEnabled(false);
    });
    const { context, shutdown } = createCookieUserContext(
      enabled,
      fakeManager().cookies,
      "app-",
      undefined,
      true,
      cleanup,
    );
    context.setAuthenticatedUserContext("user", "account", true);
    context.clearAuthenticatedUserContext();
    context.setEnabled(false);
    context.setEnabled(true);
    shutdown();
    context.clearAuthenticatedUserContext();
    context.setEnabled(false);
    expect(cleanup.mock.calls).toEqual([["clear"], ["purge"], ["clear"], ["purge"]]);
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  },
);

it("does not restore a previous login after an oversized cookie replacement", () => {
  const prefix = "oversized-auth-test-";
  const cookies = createCookieManager();
  try {
    const first = createCookieUserContext(true, cookies, prefix);
    first.context.setAuthenticatedUserContext("previous-user", "previous-account", true);
    expect(cookies.get(`${prefix}${authenticatedCookie}`)).not.toBe("");
    const replacement = "雪".repeat(1000);
    first.context.setAuthenticatedUserContext(replacement, "new-account", true);
    expect(first.provider.getAuthenticatedUserId()).toBe(replacement);
    const restored = createCookieUserContext(true, cookies, prefix);
    expect(restored.provider.getAuthenticatedUserId()).toBeUndefined();
    expect(restored.provider.getAccountId()).toBeUndefined();
  } finally {
    cookies.purge(`${prefix}${anonymousCookie}`);
    cookies.purge(`${prefix}${authenticatedCookie}`);
  }
});

it.each([undefined, true])("creates a year-long anonymous cookie when enabled is %s", (enabled) => {
  const local = vi.spyOn(window, "localStorage", "get");
  const session = vi.spyOn(window, "sessionStorage", "get");
  vi.spyOn(Date, "now").mockReturnValue(123456);
  const { cookies, values } = fakeManager();
  const { provider } = createCookieUserContext(enabled, cookies);
  const anonymousId = provider.getAnonymousUserId();
  expect(anonymousId).toMatch(/^[0-9a-f]{32}$/);
  expect(decode(values.get(anonymousCookie)!)).toEqual({
    anonymousId,
    acquisitionTimestamp: 123456,
  });
  expect(cookies.set).toHaveBeenCalledExactlyOnceWith(
    anonymousCookie,
    values.get(anonymousCookie),
    31536000,
  );
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(provider.getAccountId()).toBeUndefined();
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
  expect(cookies.isEnabled).not.toHaveBeenCalled();
});

it("uses Web Crypto and falls back when it is missing or throws", () => {
  vi.spyOn(crypto, "getRandomValues").mockImplementationOnce((array) => {
    (array as Uint8Array).fill(171);
    return array;
  });
  expect(createCookieUserContext(true, fakeManager().cookies).provider.getAnonymousUserId()).toBe(
    "ab".repeat(16),
  );
  vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
    throw new Error("restricted");
  });
  expect(
    createCookieUserContext(true, fakeManager().cookies).provider.getAnonymousUserId(),
  ).toMatch(/^[0-9a-f]{32}$/);
  vi.stubGlobal("crypto", undefined);
  expect(
    createCookieUserContext(true, fakeManager().cookies).provider.getAnonymousUserId(),
  ).toMatch(/^[0-9a-f]{32}$/);
});

it("restores canonical identities without rewriting them", () => {
  const { cookies, values } = fakeManager();
  values.set(anonymousCookie, encode({ anonymousId: "anonymous", acquisitionTimestamp: 42 }));
  values.set(
    authenticatedCookie,
    encode({ authenticatedUserId: "user=雪%2F", accountId: "account,100%" }),
  );
  const { provider } = createCookieUserContext(true, cookies);
  expect(provider.getAnonymousUserId()).toBe("anonymous");
  expect(provider.getAuthenticatedUserId()).toBe("user=雪%2F");
  expect(provider.getAccountId()).toBe("account,100%");
  expect(cookies.set).not.toHaveBeenCalled();
});

it("writes raw ISO anonymous values and encoded unicode/literal-percent authentication for reload", () => {
  vi.spyOn(Date, "now").mockReturnValue(42);
  const { cookies, values } = fakeManager();
  const first = createCookieUserContext(true, cookies);
  const anonymousId = first.provider.getAnonymousUserId();
  expect(values.get(anonymousCookie)).toBe(`${anonymousId}|1970-01-01T00:00:00.042Z`);
  first.context.setAuthenticatedUserContext("用户%2F%7C%", "tenant/雪%25#?", true);
  expect(values.get(authenticatedCookie)).toBe(encodeURI("用户%2F%7C%|tenant/雪%25#?"));
  const reloaded = createCookieUserContext(true, cookies);
  expect(reloaded.provider.getAnonymousUserId()).toBe(anonymousId);
  expect(reloaded.provider.getAuthenticatedUserId()).toBe("用户%2F%7C%");
  expect(reloaded.provider.getAccountId()).toBe("tenant/雪%25#?");
});

it("restores an Application Insights auth cookie whose delimiter was URI-encoded", () => {
  const { cookies, values } = fakeManager();
  values.set(anonymousCookie, "AI+anonymous/id|1970-01-01T00:00:00.042Z");
  values.set(authenticatedCookie, "user%7C%E9%9B%AA%252F");
  const { provider } = createCookieUserContext(true, cookies);
  expect(provider.getAnonymousUserId()).toBe("AI+anonymous/id");
  expect(provider.getAuthenticatedUserId()).toBe("user");
  expect(provider.getAccountId()).toBe("雪%2F");
  expect(cookies.set).not.toHaveBeenCalled();
});

it("isolates prefixed cookies and leaves other applications untouched", () => {
  const { cookies, values } = fakeManager();
  const first = createCookieUserContext(true, cookies, "first-");
  const second = createCookieUserContext(true, cookies, "second-");
  first.context.setAuthenticatedUserContext("first", undefined, true);
  second.context.setAuthenticatedUserContext("second", "account", true);
  first.context.setEnabled(false);
  expect(values.has(`first-${anonymousCookie}`)).toBe(false);
  expect(values.has(`first-${authenticatedCookie}`)).toBe(false);
  expect(decode(values.get(`second-${authenticatedCookie}`)!)).toEqual({
    authenticatedUserId: "second",
    accountId: "account",
  });
  expect(second.provider.getAnonymousUserId()).toBeDefined();
});

it("does not access cookies when initially disabled, but supports memory-only authentication", () => {
  const { cookies } = fakeManager();
  const { context, provider } = createCookieUserContext(false, cookies);
  context.setAuthenticatedUserContext("user", "account", true);
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(provider.getAuthenticatedUserId()).toBe("user");
  expect(provider.getAccountId()).toBe("account");
  for (const operation of Object.values(cookies)) expect(operation).not.toHaveBeenCalled();
  context.setEnabled(true);
  expect(provider.getAnonymousUserId()).toBeDefined();
  expect(cookies.set.mock.calls.map(([name]) => name)).toEqual([
    anonymousCookie,
    authenticatedCookie,
  ]);
});

it("persists authentication only on explicit opt-in and never gives auth cookies a lifetime", () => {
  const { cookies, values } = fakeManager();
  const { context, provider } = createCookieUserContext(true, cookies);
  context.setAuthenticatedUserContext("user", "account");
  expect(provider.getAuthenticatedUserId()).toBe("user");
  expect(values.has(authenticatedCookie)).toBe(false);
  context.setAuthenticatedUserContext("user=雪%2F", "account,100%", true);
  expect(cookies.set).toHaveBeenLastCalledWith(
    authenticatedCookie,
    encode({ authenticatedUserId: "user=雪%2F", accountId: "account,100%" }),
  );
  context.setAuthenticatedUserContext("replacement");
  expect(provider.getAccountId()).toBeUndefined();
  expect(values.has(authenticatedCookie)).toBe(false);
  context.setEnabled(false);
  context.setEnabled(true);
  expect(values.has(authenticatedCookie)).toBe(false);
});

it.each([false, true])(
  "preserves explicit auth storage preference %s across disable/enable",
  (store) => {
    const { cookies, values } = fakeManager();
    const { context, provider } = createCookieUserContext(true, cookies);
    const id = provider.getAnonymousUserId();
    context.setAuthenticatedUserContext("user", "account", store);
    context.setEnabled(false);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    expect(provider.getAuthenticatedUserId()).toBe("user");
    expect(provider.getAccountId()).toBe("account");
    expect(values.size).toBe(0);
    expect(cookies.purge.mock.calls).toEqual([[anonymousCookie], [authenticatedCookie]]);
    context.setEnabled(true);
    expect(provider.getAnonymousUserId()).toBe(id);
    expect(values.has(authenticatedCookie)).toBe(store);
  },
);

it("does not implicitly persist a memory-only login set while context is disabled", () => {
  const { cookies, values } = fakeManager();
  const { context } = createCookieUserContext(false, cookies);
  context.setAuthenticatedUserContext("user");
  context.setEnabled(true);
  expect(values.has(authenticatedCookie)).toBe(false);
});

it.each([false, true])(
  "clears a superseded persisted login on live enable after a disabled memory-only login (deferred: %s)",
  (deferred) => {
    const values = new Map([[authenticatedCookie, encode({ authenticatedUserId: "old-user" })]]);
    const delCookie = vi.fn((name: string) => values.delete(name));
    const cookies = createCookieManager({
      enabled: !deferred,
      getCookie: (name) => values.get(name) ?? "",
      setCookie: (name, value) => values.set(name, value.split(";")[0]!),
      delCookie,
    });
    const { context, provider } = createCookieUserContext(false, cookies);
    context.setAuthenticatedUserContext("new-user");
    expect(delCookie).not.toHaveBeenCalled();
    expect(values.has(authenticatedCookie)).toBe(true);
    context.setEnabled(true);
    cookies.setEnabled(true);
    expect(values.has(authenticatedCookie)).toBe(false);
    expect(provider.getAuthenticatedUserId()).toBe("new-user");
    expect(
      createCookieUserContext(true, cookies).provider.getAuthenticatedUserId(),
    ).toBeUndefined();
    values.set(authenticatedCookie, encode({ authenticatedUserId: "other-user" }));
    context.setEnabled(true);
    expect(decode(values.get(authenticatedCookie)!)).toEqual({ authenticatedUserId: "other-user" });
  },
);

it("does not delete another handle's login when enabling without an authentication change", () => {
  const { cookies, values } = fakeManager();
  const { context } = createCookieUserContext(false, cookies);
  values.set(authenticatedCookie, encode({ authenticatedUserId: "other-user" }));
  context.setEnabled(true);
  expect(decode(values.get(authenticatedCookie)!)).toEqual({ authenticatedUserId: "other-user" });
  expect(cookies.del).not.toHaveBeenCalled();
});

it.each([false, true])(
  "clear auth removes memory and uses del even when context enabled is %s",
  (enabled) => {
    const { cookies, values } = fakeManager();
    const { context, provider } = createCookieUserContext(enabled, cookies);
    context.setAuthenticatedUserContext("user", "account", true);
    context.clearAuthenticatedUserContext();
    expect(provider.getAuthenticatedUserId()).toBeUndefined();
    expect(provider.getAccountId()).toBeUndefined();
    expect(values.has(authenticatedCookie)).toBe(false);
    expect(cookies.del).toHaveBeenLastCalledWith(authenticatedCookie);
    expect(cookies.purge).not.toHaveBeenCalled();
    context.setEnabled(true);
    expect(values.has(authenticatedCookie)).toBe(false);
  },
);

it.each(["", null, 123, {}, false])(
  "validates ID %j without altering identity or persistence",
  (invalid) => {
    const { cookies, values } = fakeManager();
    const { context, provider } = createCookieUserContext(true, cookies);
    context.setAuthenticatedUserContext("user", "account", true);
    const stored = values.get(authenticatedCookie);
    expect(() => context.setAuthenticatedUserContext(invalid as string)).toThrow(TypeError);
    expect(() => context.setAuthenticatedUserContext("new", invalid as string)).toThrow(TypeError);
    expect(provider.getAuthenticatedUserId()).toBe("user");
    expect(provider.getAccountId()).toBe("account");
    expect(values.get(authenticatedCookie)).toBe(stored);
  },
);

it.each([
  "%",
  "%E0%A4%A",
  legacyEncode("private-user"),
  legacyEncode(null),
  legacyEncode([]),
  legacyEncode({}),
  legacyEncode({ anonymousId: "", acquisitionTimestamp: 42 }),
  legacyEncode({ anonymousId: "private-user" }),
  legacyEncode({ anonymousId: "private-user", acquisitionTimestamp: "42" }),
  legacyEncode({ anonymousId: "private-user", acquisitionTimestamp: -1 }),
  legacyEncode({ anonymousId: "private-user", acquisitionTimestamp: null }),
  "private-user|not-a-date",
  "private-user|1970-01-01T00:00:00.042Z|extra",
  encodeURIComponent('{"anonymousId":"private-user","acquisitionTimestamp":1e400}'),
  encodeURIComponent('{"__proto__":{"anonymousId":"private-user","acquisitionTimestamp":42}}'),
])("recovers malformed anonymous cookie %s without logging identity", (value) => {
  const warn = vi.spyOn(diag, "warn");
  const { cookies, values } = fakeManager();
  values.set(anonymousCookie, value);
  const { provider } = createCookieUserContext(true, cookies);
  expect(provider.getAnonymousUserId()).toMatch(/^[0-9a-f]{32}$/);
  expect(decode(values.get(anonymousCookie)!).anonymousId).toBe(provider.getAnonymousUserId());
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  "%",
  "%E0%A4%A",
  "|account",
  "private-user|",
  "private-user|account|extra",
  "private-user%7Caccount%7Cextra",
])("removes malformed auth cookie %s without restoring or logging it", (value) => {
  const warn = vi.spyOn(diag, "warn");
  const { cookies, values } = fakeManager();
  values.set(authenticatedCookie, value);
  const { provider } = createCookieUserContext(true, cookies);
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(provider.getAccountId()).toBeUndefined();
  expect(values.has(authenticatedCookie)).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});

it("rejects anonymous JSON without restoring identity or a parsed prototype", () => {
  const { cookies, values } = fakeManager();
  values.set(
    anonymousCookie,
    encodeURIComponent(
      '{"anonymousId":"user","acquisitionTimestamp":42,"authenticatedUserId":"wrong","__proto__":{"polluted":true}}',
    ),
  );
  const { provider } = createCookieUserContext(true, cookies);
  expect(provider.getAnonymousUserId()).toMatch(/^[0-9a-f]{32}$/);
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(provider.getAccountId()).toBeUndefined();
  expect(Object.prototype).not.toHaveProperty("polluted");
});

it.each([anonymousCookie, authenticatedCookie])(
  "contains initialization read failures for %s and retries anonymous reads independently",
  (failedName) => {
    const { cookies } = fakeManager();
    cookies.get.mockImplementation((name) => {
      if (name === failedName) throw new Error("private identity");
      return "";
    });
    const { context, provider } = createCookieUserContext(true, cookies);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(provider.getAnonymousUserId() !== undefined).toBe(failedName === authenticatedCookie);
    context.setAuthenticatedUserContext("memory-user");
    expect(provider.getAuthenticatedUserId()).toBe("memory-user");
    cookies.get.mockReturnValue("");
    context.setEnabled(true);
    expect(provider.getAnonymousUserId()).toBeDefined();
  },
);

it.each(["{}", "[]", "null", '{"authenticatedUserId":"literal-id"}'])(
  "roundtrips JSON-shaped authenticated IDs as literal strings (%s)",
  (userId) => {
    const { cookies } = fakeManager();
    const first = createCookieUserContext(true, cookies);
    first.context.setAuthenticatedUserContext(userId, undefined, true);
    const restored = createCookieUserContext(true, cookies);
    expect(restored.provider.getAuthenticatedUserId()).toBe(userId);
    expect(restored.provider.getAccountId()).toBeUndefined();
  },
);

it.each(["false", "throw"])(
  "suppresses anonymous enrichment after %s writes and can recover",
  (failure) => {
    const { cookies } = fakeManager();
    cookies.set.mockImplementation(() => {
      if (failure === "throw") throw new Error("private identity");
      return false;
    });
    const { context, provider } = createCookieUserContext(true, cookies);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    context.setEnabled(true);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    cookies.set.mockReturnValue(true);
    context.setEnabled(true);
    expect(provider.getAnonymousUserId()).toBeDefined();
  },
);

it("keeps auth in memory and removes stale auth after a failed replacement", () => {
  const { cookies, values } = fakeManager();
  const { context, provider } = createCookieUserContext(true, cookies);
  context.setAuthenticatedUserContext("old", undefined, true);
  cookies.set.mockReturnValue(false);
  context.setAuthenticatedUserContext("new", undefined, true);
  expect(provider.getAuthenticatedUserId()).toBe("new");
  expect(values.has(authenticatedCookie)).toBe(false);
});

it("attempts both purges and clears enrichment even when cleanup throws", () => {
  const { cookies } = fakeManager();
  const { context, provider } = createCookieUserContext(true, cookies);
  cookies.purge.mockImplementation(() => {
    throw new Error("denied");
  });
  context.setEnabled(false);
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(cookies.purge.mock.calls).toEqual([[anonymousCookie], [authenticatedCookie]]);
});

it("allows deferred anonymous identity but disable purges pending identities without resurrection", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const cookies = createCookieManager({ enabled: false, setCookie, delCookie });
  const { context, provider } = createCookieUserContext(true, cookies);
  expect(provider.getAnonymousUserId()).toBeDefined();
  context.setAuthenticatedUserContext("user", "account", true);
  expect(setCookie).not.toHaveBeenCalled();
  context.setEnabled(false);
  expect(delCookie.mock.calls.map(([name]) => name)).toEqual([
    anonymousCookie,
    authenticatedCookie,
  ]);
  expect(cookies.get(anonymousCookie)).toBe("");
  expect(cookies.get(authenticatedCookie)).toBe("");
  cookies.setEnabled(true);
  expect(setCookie).not.toHaveBeenCalled();
});

it("honors disabled deferral and replaces pending auth writes with deferred deletes on clear", () => {
  const unavailable = createCookieManager({ enabled: false, disableCookieDefer: true });
  expect(createCookieUserContext(true, unavailable).provider.getAnonymousUserId()).toBeUndefined();
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const cookies = createCookieManager({ enabled: false, setCookie, delCookie });
  const { context } = createCookieUserContext(true, cookies);
  context.setAuthenticatedUserContext("user", undefined, true);
  context.clearAuthenticatedUserContext();
  expect(delCookie).not.toHaveBeenCalled();
  cookies.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual([anonymousCookie]);
  expect(delCookie.mock.calls.map(([name]) => name)).toEqual([authenticatedCookie]);
});

it("clears persisted authentication after cookie-manager shutdown without resuming writes", () => {
  const values = new Map<string, string>();
  const setCookie = vi.fn((name: string, value: string) => values.set(name, value));
  const delCookie = vi.fn((name: string) => values.delete(name));
  const cookies = createCookieManager({
    getCookie: (name) => values.get(name) ?? "",
    setCookie,
    delCookie,
  });
  const { context, provider } = createCookieUserContext(true, cookies);
  context.setAuthenticatedUserContext("old-user", "account", true);
  expect(values.has(authenticatedCookie)).toBe(true);
  cookies.shutdown();
  setCookie.mockClear();
  context.clearAuthenticatedUserContext();
  expect(values.has(authenticatedCookie)).toBe(false);
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(provider.getAccountId()).toBeUndefined();
  expect(delCookie).toHaveBeenCalledWith(authenticatedCookie, expect.stringContaining("max-age=0"));
  cookies.setEnabled(true);
  expect(setCookie).not.toHaveBeenCalled();
});

it.each([false, true])(
  "does not let stale identity controls remove a persisted login after SDK shutdown (newer instance: %s)",
  async (newerInstance) => {
    const values = new Map<string, string>();
    const getCookie = vi.fn((name: string) => values.get(name) ?? "");
    const setCookie = vi.fn((name: string, value: string) =>
      values.set(name, value.split(";")[0]!),
    );
    const delCookie = vi.fn((name: string) => values.delete(name));
    const initialize = () =>
      useMicrosoftOpenTelemetry({
        cookieCfg: { getCookie, setCookie, delCookie },
        session: { enabled: false },
        pageView: { enabled: false },
        spanProcessors: [],
        logRecordProcessors: [],
      });
    const first = await initialize();
    let second: Awaited<ReturnType<typeof initialize>> | undefined;
    try {
      first.userContext.setAuthenticatedUserContext("old-user", "old-account", true);
      await first.shutdown();
      if (newerInstance) {
        second = await initialize();
        second.userContext.setAuthenticatedUserContext("new-user", "new-account", true);
      }
      const persisted = new Map(values);
      getCookie.mockClear();
      setCookie.mockClear();
      delCookie.mockClear();
      first.userContext.setEnabled(true);
      first.userContext.setAuthenticatedUserContext("stale-user", undefined, true);
      first.userContext.setAuthenticatedUserContext("stale-memory-user");
      expect(values).toEqual(persisted);
      expect(getCookie).not.toHaveBeenCalled();
      expect(setCookie).not.toHaveBeenCalled();
      expect(delCookie).not.toHaveBeenCalled();

      // Explicit logout and purge remain intentional even on a stopped handle.
      first.userContext.clearAuthenticatedUserContext();
      expect(values.has(authenticatedCookie)).toBe(false);
      first.userContext.setEnabled(false);
      expect(values.has(anonymousCookie)).toBe(false);
      expect(delCookie.mock.calls.map(([name]) => name)).toEqual([
        authenticatedCookie,
        anonymousCookie,
        authenticatedCookie,
      ]);
    } finally {
      await first.shutdown();
      await second?.shutdown();
    }
  },
);

it.each(["persisted", "memory-only"])(
  "does not replay a disabled %s authentication change through a stale handle",
  async (storage) => {
    const values = new Map([[authenticatedCookie, encode({ authenticatedUserId: "old-user" })]]);
    const delCookie = vi.fn((name: string) => values.delete(name));
    const handle = await useMicrosoftOpenTelemetry({
      cookieCfg: {
        getCookie: (name) => values.get(name) ?? "",
        setCookie: (name, value) => values.set(name, value.split(";")[0]!),
        delCookie,
      },
      userContext: { enabled: false },
      session: { enabled: false },
      pageView: { enabled: false },
      spanProcessors: [],
      logRecordProcessors: [],
    });
    try {
      handle.userContext.setAuthenticatedUserContext(
        "new-user",
        undefined,
        storage === "persisted",
      );
      await handle.shutdown();
      handle.userContext.setEnabled(true);
      expect(decode(values.get(authenticatedCookie)!)).toEqual({ authenticatedUserId: "old-user" });
      expect(delCookie).not.toHaveBeenCalled();
    } finally {
      await handle.shutdown();
    }
  },
);

it.each([false, true])(
  "recovers anonymous enrichment on telemetry after cookie enablement (existing cookie: %s) without auth replay",
  (existing) => {
    const { values } = fakeManager();
    if (existing) {
      values.set(
        anonymousCookie,
        encode({ anonymousId: "existing-user", acquisitionTimestamp: 42 }),
      );
    }
    values.set(authenticatedCookie, encode({ authenticatedUserId: "old-login" }));
    const setCookie = vi.fn((name: string, value: string) => values.set(name, value));
    const cookies = createCookieManager({
      enabled: false,
      disableCookieDefer: true,
      getCookie: (name) => values.get(name) ?? "",
      setCookie,
    });
    const onNewUser = vi.fn();
    const { context, provider } = createCookieUserContext(true, cookies, "", onNewUser);
    context.setAuthenticatedUserContext("current-login", undefined, true);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    expect(onNewUser).not.toHaveBeenCalled();
    cookies.setEnabled(true);
    const id = provider.getAnonymousUserId();
    expect(id).toEqual(existing ? "existing-user" : expect.stringMatching(/^[0-9a-f]{32}$/));
    expect(provider.getAnonymousUserId()).toBe(id);
    expect(provider.getAuthenticatedUserId()).toBe("current-login");
    expect(onNewUser).toHaveBeenCalledTimes(existing ? 0 : 1);
    expect(setCookie.mock.calls.map(([name]) => name)).toEqual(existing ? [] : [anonymousCookie]);
  },
);

it.each(["", "%", legacyEncode({ anonymousId: "invalid" })])(
  "notifies a new user before saving a missing or invalid anonymous cookie %s",
  (value) => {
    const { cookies, values } = fakeManager();
    values.set(anonymousCookie, value);
    const onNewUser = vi.fn(() => {
      expect(cookies.set).not.toHaveBeenCalled();
    });
    createCookieUserContext(true, cookies, "", onNewUser);
    expect(onNewUser).toHaveBeenCalledExactlyOnceWith();
    expect(cookies.set).toHaveBeenCalledTimes(1);
  },
);

it("does not notify a new user for an existing valid anonymous cookie", () => {
  const { cookies, values } = fakeManager();
  values.set(anonymousCookie, encode({ anonymousId: "existing-user", acquisitionTimestamp: 42 }));
  const onNewUser = vi.fn();
  const { provider } = createCookieUserContext(true, cookies, "", onNewUser);
  expect(provider.getAnonymousUserId()).toBe("existing-user");
  expect(onNewUser).not.toHaveBeenCalled();
  expect(cookies.set).not.toHaveBeenCalled();
});

it.each(["", "app-"])(
  "retains the session backup when anonymous and session cookies are ignored (prefix=%j)",
  async (prefix) => {
    const sessionCookie = `${prefix}ai_session`;
    const values = new Map<string, string>();
    const cookieValues = new Map<string, string>();
    const now = Date.now();
    const backup = JSON.stringify({
      id: "existing-session",
      startTimestamp: now,
      lastActivityTimestamp: now,
    });
    values.set("opentelemetry-session", backup);
    const storage = {
      getItem: (name: string) => ({ success: true as const, value: values.get(name) ?? null }),
      setItem: (name: string, value: string) => {
        values.set(name, value);
        return true;
      },
      removeItem: vi.fn((name: string) => values.delete(name)),
    };
    for (let reload = 0; reload < 2; reload++) {
      const cookies = createCookieManager({
        ignoreCookies: [`${prefix}${anonymousCookie}`, sessionCookie],
        getCookie: (name) => cookieValues.get(name) ?? "",
        setCookie: (name, value) => cookieValues.set(name, value),
      });
      const session = createSession({}, storage, cookies, sessionCookie);
      const onNewUser = vi.fn(() => session.discardBackup());
      // Internal permission comes from the same validated snapshot as the cookie manager.
      createCookieUserContext(true, cookies, prefix, onNewUser, false);
      try {
        await session.start();
        expect(session.getSessionId()).toBe("existing-session");
        expect(onNewUser).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();
        expect(values.get("opentelemetry-session")).toBe(backup);
        expect(cookieValues.size).toBe(0);
      } finally {
        session.shutdown();
        cookies.shutdown();
      }
    }
  },
);

it("still detects a missing anonymous cookie when writes are blocked but reads are permitted", () => {
  const cookies = createCookieManager({
    blockedCookies: [anonymousCookie],
    getCookie: () => "",
    setCookie: vi.fn(),
  });
  const onNewUser = vi.fn();
  const { provider } = createCookieUserContext(true, cookies, "", onNewUser, true);
  expect(onNewUser).toHaveBeenCalledExactlyOnceWith();
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(onNewUser).toHaveBeenCalledTimes(1);
});

it.each(["disabled", "unavailable", "throws"])(
  "does not notify a new user while cookie access is %s",
  (state) => {
    const { cookies } = fakeManager();
    cookies.isEnabled.mockImplementation(() => {
      if (state === "throws") throw new Error("denied");
      return false;
    });
    const onNewUser = vi.fn();
    const { provider } = createCookieUserContext(true, cookies, "", onNewUser);
    provider.getAnonymousUserId();
    expect(onNewUser).not.toHaveBeenCalled();
  },
);

it("does not access cookies or notify new users while user context is disabled", () => {
  const { cookies } = fakeManager();
  const onNewUser = vi.fn();
  const { context, provider } = createCookieUserContext(false, cookies, "", onNewUser);
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(onNewUser).not.toHaveBeenCalled();
  expect(cookies.isEnabled).not.toHaveBeenCalled();
  context.setEnabled(true);
  expect(onNewUser).toHaveBeenCalledTimes(1);
  expect(provider.getAnonymousUserId()).toBeDefined();
});

it.each([
  ["user|delimiter", "account"],
  ["user", "account|delimiter"],
  ["user\ud800", "account"],
  ["user", "account\udfff"],
] as const)(
  "retains memory identity but clears a superseded login when canonical encoding cannot roundtrip (%j, %j)",
  (userId, accountId) => {
    const { cookies, values } = fakeManager();
    const { context, provider } = createCookieUserContext(true, cookies);
    context.setAuthenticatedUserContext("previous-user", "previous-account", true);
    cookies.set.mockClear();
    expect(() => context.setAuthenticatedUserContext(userId, accountId, true)).not.toThrow();
    expect(provider.getAuthenticatedUserId()).toBe(userId);
    expect(provider.getAccountId()).toBe(accountId);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(values.has(authenticatedCookie)).toBe(false);
    expect(cookies.del).toHaveBeenCalledWith(authenticatedCookie);
    expect(
      createCookieUserContext(true, cookies).provider.getAuthenticatedUserId(),
    ).toBeUndefined();
  },
);

it("preserves punctuation in memory when the canonical auth value is rejected as header injection", () => {
  const values = new Map<string, string>();
  const setCookie = vi.fn((name: string, value: string) => values.set(name, value.split(";")[0]!));
  const cookies = createCookieManager({
    getCookie: (name) => values.get(name) ?? "",
    setCookie,
    delCookie: (name) => values.delete(name),
  });
  const { context, provider } = createCookieUserContext(true, cookies);
  context.setAuthenticatedUserContext("previous", undefined, true);
  setCookie.mockClear();
  context.setAuthenticatedUserContext("user;= 雪", "account,;\n", true);
  expect(provider.getAuthenticatedUserId()).toBe("user;= 雪");
  expect(provider.getAccountId()).toBe("account,;\n");
  expect(setCookie).not.toHaveBeenCalled();
  expect(values.has(authenticatedCookie)).toBe(false);
  cookies.shutdown();
});

it.each(
  [
    { cookie: anonymousCookie, disableBeforeWrite: false },
    { cookie: anonymousCookie, disableBeforeWrite: true },
    { cookie: authenticatedCookie, disableBeforeWrite: false },
    { cookie: authenticatedCookie, disableBeforeWrite: true },
  ].flatMap((options) => [false, true].map((deferred) => ({ ...options, deferred }))),
)(
  "keeps enrichment disabled and cookies purged after a reentrant opt-out (%j)",
  ({ cookie, disableBeforeWrite, deferred }) => {
    const values = new Map<string, string>();
    const cookies = createCookieManager({
      enabled: !deferred,
      getCookie: (name) => values.get(name) ?? "",
      setCookie(name, value) {
        if (name === cookie && disableBeforeWrite) context.setEnabled(false);
        values.set(name, value.split(";")[0]!);
        if (name === cookie && !disableBeforeWrite) context.setEnabled(false);
      },
      delCookie: (name) => values.delete(name),
    });
    const { context, provider } = createCookieUserContext(false, cookies);
    context.setAuthenticatedUserContext("memory-user", "account", true);
    context.setEnabled(true);
    if (deferred) cookies.setEnabled(true);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    expect(provider.getAuthenticatedUserId()).toBe("memory-user");
    expect(provider.getAccountId()).toBe("account");
    expect(values.has(anonymousCookie)).toBe(false);
    expect(values.has(authenticatedCookie)).toBe(false);
    expect(cookies.get(anonymousCookie)).toBe("");
    cookies.shutdown();
  },
);

it("replaces an unsupported anonymous JSON cookie with a safe canonical identity", () => {
  const { cookies, values } = fakeManager();
  values.set(anonymousCookie, legacyEncode({ anonymousId: "anon;=雪", acquisitionTimestamp: 42 }));
  const { context, provider } = createCookieUserContext(true, cookies);
  const anonymousId = provider.getAnonymousUserId();
  expect(anonymousId).toMatch(/^[0-9a-f]{32}$/);
  context.setEnabled(false);
  context.setEnabled(true);
  expect(provider.getAnonymousUserId()).toBe(anonymousId);
  expect(values.get(anonymousCookie)).toMatch(/^[0-9a-f]{32}\|\d{4}-/);
});

it("bounds new-user notification across failed retries and contains callback failures", () => {
  const { cookies } = fakeManager();
  cookies.set.mockReturnValue(false);
  const onNewUser = vi.fn(() => {
    throw new Error("backup cleanup failed");
  });
  const { provider } = createCookieUserContext(true, cookies, "", onNewUser);
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(onNewUser).toHaveBeenCalledTimes(1);
  cookies.set.mockReturnValue(true);
  expect(provider.getAnonymousUserId()).toBeDefined();
});
