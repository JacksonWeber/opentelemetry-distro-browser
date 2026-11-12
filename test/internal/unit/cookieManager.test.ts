// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { createCookieManager } from "../../../src/storage/cookieManager.js";
import type { MicrosoftOpenTelemetryBrowserCookieConfig } from "../../../src/types.js";
import { createCookieUserContext } from "../../../src/user/createCookieUserContext.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "otel-cookie-manager-test=; max-age=0; path=/";
});

it("keeps internal failed-read status distinct from successful missing and ignored cookies", () => {
  const getCookie = vi.fn((_name: string): string => {
    throw new Error("cookie access failed");
  });
  const manager = createCookieManager({ getCookie, ignoreCookies: ["ignored"] });
  expect(manager.get("name")).toBe("");
  expect(manager.read("name")).toEqual({ success: false });
  expect(manager.read("ignored")).toEqual({ success: true, value: "" });
  expect(getCookie).toHaveBeenCalledTimes(2);
  getCookie.mockReturnValue("");
  expect(manager.read("name")).toEqual({ success: true, value: "" });
  getCookie.mockReturnValue("existing");
  expect(manager.read("name")).toEqual({ success: true, value: "existing" });
  manager.setEnabled(false);
  manager.set("name", "deferred");
  getCookie.mockClear();
  expect(manager.read("name")).toEqual({ success: true, value: "deferred" });
  expect(getCookie).not.toHaveBeenCalled();
});

it("reads, writes, and deletes actual browser cookies without touching web storage", () => {
  const local = vi.spyOn(window, "localStorage", "get");
  const session = vi.spyOn(window, "sessionStorage", "get");
  const manager = createCookieManager();
  expect(manager.isEnabled()).toBe(true);
  expect(manager.set("otel-cookie-manager-test", "a=b%20c", 60)).toBe(true);
  expect(manager.get("otel-cookie-manager-test")).toBe("a=b%20c");
  expect(manager.get("otel-cookie-manager-tes")).toBe("");
  expect(manager.del("otel-cookie-manager-test")).toBe(true);
  expect(manager.get("otel-cookie-manager-test")).toBe("");
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
});

it("formats session and persistent cookies and deletes the configured domain/path", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const manager = createCookieManager({
    domain: ".example.test",
    path: "/app",
    setCookie,
    delCookie,
  });
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  expect(manager.set("name", " value ", 60)).toBe(true);
  const secure = location.protocol === "https:" ? "; secure; SameSite=None" : "";
  expect(setCookie).toHaveBeenLastCalledWith(
    "name",
    `value; expires=Thu, 01 Jan 2026 00:01:00 GMT; max-age=60${secure}; domain=.example.test; path=/app`,
  );
  manager.set("name", "session", undefined, "override.test", "/other");
  expect(setCookie).toHaveBeenLastCalledWith(
    "name",
    `session${secure}; domain=override.test; path=/other`,
  );
  manager.del("name");
  expect(delCookie).toHaveBeenLastCalledWith(
    "name",
    `; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${secure}; domain=.example.test; path=/app`,
  );
  manager.purge("name", "/other");
  expect(delCookie).toHaveBeenLastCalledWith(
    "name",
    `; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${secure}; domain=.example.test; path=/other`,
  );
});

it("uses the configured path for actual host-only cookie deletion", () => {
  // Domain=localhost is not portable across browser engines. Explicit domain formatting and
  // matching deletion scope are covered by the hook-based test above.
  const manager = createCookieManager({ path: "/" });
  manager.set("otel-cookie-manager-test", "identity");
  expect(manager.get("otel-cookie-manager-test")).toBe("identity");
  expect(manager.purge("otel-cookie-manager-test")).toBe(true);
  expect(manager.get("otel-cookie-manager-test")).toBe("");
});

it("avoids cookie support probes when disabled without any hooks", () => {
  const read = vi.spyOn(document, "cookie", "get");
  const write = vi.spyOn(document, "cookie", "set");
  const manager = createCookieManager({ enabled: false });
  expect(manager.isEnabled()).toBe(false);
  expect(manager.set("name", "value")).toBe(true);
  expect(manager.get("name")).toBe("value");
  expect(manager.del("name")).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it.each([false, true])(
  "rejects oversized UTF-8 cookies before writing or deferring (enabled=%s)",
  (enabled) => {
    const setCookie = vi.fn();
    const manager = createCookieManager({ enabled, setCookie });
    expect(manager.set("name", "a".repeat(4083))).toBe(true);
    expect(manager.set("name", "a".repeat(4084))).toBe(false);
    expect(manager.set("other", "雪".repeat(1400))).toBe(false);
    expect(
      manager.set("large-attributes", "a".repeat(4050), undefined, "example.test", "/long-path"),
    ).toBe(false);
    manager.setEnabled(true);
    expect(setCookie).toHaveBeenCalledOnce();
    expect(setCookie.mock.calls[0]?.[0]).toBe("name");
  },
);

it("queries snapshotted per-name read permission without cookie access", () => {
  const ignored = ["ignored"];
  const manager = createCookieManager({ ignoreCookies: ignored, blockedCookies: ["blocked"] });
  ignored.length = 0;
  const read = vi.spyOn(document, "cookie", "get");
  expect(manager.canRead("ignored")).toBe(false);
  expect(manager.canRead("blocked")).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

it("flushes explicit deletes for ignored and blocked cookies", () => {
  const delCookie = vi.fn();
  const manager = createCookieManager({
    enabled: false,
    ignoreCookies: ["ignored"],
    blockedCookies: ["blocked"],
    delCookie,
  });
  expect(manager.del("ignored")).toBe(true);
  expect(manager.del("blocked")).toBe(true);
  manager.setEnabled(true);
  expect(delCookie.mock.calls.map(([name]) => name)).toEqual(["ignored", "blocked"]);
});

it("does not access cookies while disabled and flushes only the latest operation per name", () => {
  const read = vi.spyOn(document, "cookie", "get");
  const write = vi.spyOn(document, "cookie", "set");
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const manager = createCookieManager({ enabled: false, setCookie, delCookie });
  expect(manager.isEnabled()).toBe(false);
  expect(manager.get("old")).toBe("");
  expect(manager.set("name", "first")).toBe(true);
  expect(manager.set("name", "second")).toBe(true);
  expect(manager.get("name")).toBe("second");
  expect(manager.del("name")).toBe(true);
  expect(manager.get("name")).toBe("");
  manager.del("other");
  manager.set("other", "latest");
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(setCookie).not.toHaveBeenCalled();
  expect(delCookie).not.toHaveBeenCalled();
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(1);
  expect(setCookie.mock.calls[0]?.[0]).toBe("other");
  expect(delCookie).toHaveBeenCalledTimes(1);
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(1);
});

it("formats expiry at enqueue rather than extending it on enable", () => {
  const setCookie = vi.fn();
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const manager = createCookieManager({ enabled: false, setCookie });
  manager.set("name", "value", 60);
  now.mockReturnValue(Date.UTC(2026, 0, 2));
  manager.setEnabled(true);
  expect(setCookie.mock.calls[0]?.[1]).toContain("expires=Thu, 01 Jan 2026 00:01:00 GMT");
});

it("retains failed deferred writes and deletes for a later enable without generic cleanup", () => {
  const setCookie = vi.fn((): void => {
    throw new Error("denied");
  });
  const delCookie = vi.fn((): void => {
    throw new Error("denied");
  });
  const manager = createCookieManager({ enabled: false, setCookie, delCookie });
  manager.set("replace", "new", 60);
  manager.del("remove");
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(1);
  expect(delCookie.mock.calls).toEqual([["remove", expect.any(String)]]);
  manager.setEnabled(false);
  expect(manager.get("replace")).toBe("new");
  const formatted = setCookie.mock.calls[0];
  setCookie.mockImplementation(() => {});
  delCookie.mockImplementation(() => {});
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(2);
  expect(setCookie.mock.calls[1]).toEqual(formatted);
  expect(delCookie).toHaveBeenCalledTimes(2);
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(2);
  expect(delCookie).toHaveBeenCalledTimes(2);
});

it("does not restore superseded authentication after a deferred replacement hook throws", () => {
  const name = "ai_authUser";
  const values = new Map<string, string>();
  let fail = false;
  const cookies = createCookieManager({
    getCookie: (key) => values.get(key) ?? "",
    setCookie(key, value) {
      if (fail && key === name) throw new Error("denied");
      values.set(key, value.split(";")[0]!);
    },
    delCookie: (key) => values.delete(key),
  });
  // Mirror the initializer's internal identity policy, not a generic cookie-manager policy.
  cookies.setReplayFailureHandler((key, removeSuperseded) => {
    if (key === name) removeSuperseded();
  });
  const first = createCookieUserContext(true, cookies);
  first.context.setAuthenticatedUserContext("A", "account-A", true);
  cookies.setEnabled(false);
  first.context.setAuthenticatedUserContext("B", "account-B", true);
  fail = true;
  cookies.setEnabled(true);
  expect(first.provider.getAuthenticatedUserId()).toBe("B");
  const restored = createCookieUserContext(true, cookies);
  expect(restored.provider.getAuthenticatedUserId()).toBeUndefined();
  expect(restored.provider.getAccountId()).toBeUndefined();
  fail = false;
  cookies.setEnabled(true);
  const recovered = createCookieUserContext(true, cookies);
  expect(recovered.provider.getAuthenticatedUserId()).toBe("B");
  expect(recovered.provider.getAccountId()).toBe("account-B");
});

it.each([false, true])(
  "keeps a failed replacement retry even when scoped cleanup fails=%s",
  (initialCleanupFails) => {
    const name = "auth";
    let stored = "old";
    let fail = true;
    let cleanupFails = initialCleanupFails;
    const setCookie = vi.fn((_name: string, value: string) => {
      if (fail) throw new Error("write denied");
      stored = value.split(";")[0]!;
    });
    const delCookie = vi.fn(() => {
      if (cleanupFails) throw new Error("delete denied");
      stored = "";
    });
    const manager = createCookieManager({
      enabled: false,
      domain: "default.test",
      path: "/default",
      setCookie,
      delCookie,
    });
    const cleanupResults: boolean[] = [];
    manager.setReplayFailureHandler((_key, removeSuperseded) => {
      cleanupResults.push(removeSuperseded());
    });
    manager.set(name, "new", undefined, "override.test", "/override");
    manager.setEnabled(true);
    expect(stored).toBe(cleanupFails ? "old" : "");
    expect(cleanupResults).toEqual([!cleanupFails]);
    expect(delCookie).toHaveBeenCalledExactlyOnceWith(
      name,
      `; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${location.protocol === "https:" ? "; secure; SameSite=None" : ""}; domain=override.test; path=/override`,
    );
    if (cleanupFails) {
      cleanupFails = false;
      manager.setEnabled(true);
      expect(stored).toBe("");
      expect(cleanupResults).toEqual([false, true]);
    }
    fail = false;
    manager.setEnabled(true);
    expect(stored).toBe("new");
    expect(setCookie).toHaveBeenCalledTimes(initialCleanupFails ? 3 : 2);
    expect(delCookie).toHaveBeenCalledTimes(initialCleanupFails ? 2 : 1);
  },
);

it("uses the accepted Host cookie scope rather than the default path for failed replay cleanup", () => {
  const delCookie = vi.fn();
  const manager = createCookieManager({
    enabled: false,
    path: "/default",
    setCookie: () => {
      throw new Error("denied");
    },
    delCookie,
  });
  manager.setReplayFailureHandler((_name, removeSuperseded) => removeSuperseded());
  expect(manager.set("__Host-auth", "new", undefined, undefined, "/")).toBe(true);
  manager.setEnabled(true);
  expect(delCookie).toHaveBeenCalledWith("__Host-auth", expect.stringMatching(/; path=\/$/));
});

it("contains failure-handler errors, notifies only failed writes, and retains retries", () => {
  const fail = (): void => {
    throw new Error("denied");
  };
  const setCookie = vi.fn(fail);
  const delCookie = vi.fn(fail);
  const manager = createCookieManager({ enabled: false, setCookie, delCookie });
  const handler = vi.fn(fail);
  manager.setReplayFailureHandler(handler);
  manager.set("replace", "new");
  manager.del("remove");
  expect(() => manager.setEnabled(true)).not.toThrow();
  expect(handler).toHaveBeenCalledExactlyOnceWith("replace", expect.any(Function));
  manager.setReplayFailureHandler(undefined);
  setCookie.mockImplementation(() => {});
  delCookie.mockImplementation(() => {});
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(2);
  expect(delCookie).toHaveBeenCalledTimes(2);
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each(["set", "del", "purge", "defer", "shutdown"] as const)(
  "does not clean up or resurrect a failed replay superseded by reentrant %s",
  (action) => {
    const delCookie = vi.fn();
    const setCookie = vi.fn((_name: string, value: string) => {
      if (!value.startsWith("old;")) return;
      if (action === "defer") manager.setEnabled(false);
      if (action === "set" || action === "defer") manager.set("name", "new");
      else if (action === "del") manager.del("name");
      else if (action === "purge") manager.purge("name");
      else manager.shutdown();
      throw new Error("old write denied");
    });
    const manager = createCookieManager({ enabled: false, setCookie, delCookie });
    const handler = vi.fn((_name: string, removeSuperseded: () => boolean) => removeSuperseded());
    manager.setReplayFailureHandler(handler);
    manager.set("name", "old");
    manager.setEnabled(true);
    expect(handler).not.toHaveBeenCalled();
    manager.setEnabled(true);
    expect(setCookie.mock.calls.map(([, value]) => value.split(";")[0])).toEqual(
      action === "set" || action === "defer" ? ["old", "new"] : ["old"],
    );
    expect(delCookie).toHaveBeenCalledTimes(action === "purge" ? 2 : action === "del" ? 1 : 0);
  },
);

it.each([
  "none",
  "set",
  "set-fails",
  "del",
  "del-before-write",
  "defer",
  "shutdown",
  "other",
] as const)(
  "honors in-flight replay purge unless superseded by a newer same-name write (%s)",
  (action) => {
    const values = new Map<string, string>();
    const delCookie = vi.fn((name: string, _formatted: string) => values.delete(name));
    const manager = createCookieManager({
      enabled: false,
      domain: "example.test",
      path: "/scoped",
      getCookie: (name) => values.get(name) ?? "",
      setCookie(name, value) {
        if (!value.startsWith("old;")) {
          if (action === "set-fails") throw new Error("new write denied");
          values.set(name, value.split(";")[0]!);
          return;
        }
        manager.purge(name);
        if (action === "del-before-write") manager.del(name);
        values.set(name, "old");
        if (action === "defer") manager.setEnabled(false);
        if (action === "set" || action === "set-fails" || action === "defer") {
          manager.set(name, "new");
        } else if (action === "del") manager.del(name);
        else if (action === "shutdown") manager.shutdown();
        else if (action === "other") manager.set("other", "new");
      },
      delCookie,
    });
    manager.set("name", "old");
    manager.setEnabled(true);
    manager.setEnabled(true);
    expect(values.get("name")).toBe(action === "set" || action === "defer" ? "new" : undefined);
    expect(delCookie).toHaveBeenCalledTimes(
      action === "set" || action === "defer"
        ? 1
        : action === "del" || action === "del-before-write"
          ? 3
          : 2,
    );
    for (const [name, formatted] of delCookie.mock.calls) {
      expect(name).toBe("name");
      expect(formatted).toContain("; domain=example.test; path=/scoped");
    }
    manager.shutdown();
  },
);

it.each(["set", "del", "purge", "shutdown"] as const)(
  "invalidates scoped cleanup when a failure handler performs a newer %s",
  (action) => {
    const delCookie = vi.fn();
    const setCookie = vi.fn((_name: string, value: string) => {
      if (value.startsWith("old;")) throw new Error("denied");
    });
    const manager = createCookieManager({ enabled: false, setCookie, delCookie });
    const cleanupResults: boolean[] = [];
    manager.setReplayFailureHandler((_name, removeSuperseded) => {
      if (action === "set") manager.set("name", "new");
      else if (action === "del") manager.del("name");
      else if (action === "purge") manager.purge("name");
      else manager.shutdown();
      cleanupResults.push(removeSuperseded());
    });
    manager.set("name", "old");
    manager.setEnabled(true);
    manager.setEnabled(true);
    expect(cleanupResults).toEqual([false]);
    expect(setCookie).toHaveBeenCalledTimes(action === "set" ? 2 : 1);
    expect(delCookie).toHaveBeenCalledTimes(action === "del" || action === "purge" ? 1 : 0);
  },
);

it("does not resurrect a replacement when its failed cleanup writes a newer value", () => {
  const setCookie = vi.fn((_name: string, value: string) => {
    if (value.startsWith("old;")) throw new Error("write denied");
  });
  const manager = createCookieManager({
    enabled: false,
    setCookie,
    delCookie: () => {
      manager.set("name", "new");
      throw new Error("delete denied");
    },
  });
  const cleanupResults: boolean[] = [];
  manager.setReplayFailureHandler((_name, removeSuperseded) => {
    cleanupResults.push(removeSuperseded());
  });
  manager.set("name", "old");
  manager.setEnabled(true);
  manager.setEnabled(true);
  expect(cleanupResults).toEqual([false]);
  expect(setCookie.mock.calls.map(([, value]) => value.split(";")[0])).toEqual(["old", "new"]);
});

it("bounds nested enables and retains unattempted operations after a hook disables replay", () => {
  let fail = true;
  const setCookie = vi.fn((name: string) => {
    manager.setEnabled(true);
    if (fail && name === "first") {
      manager.setEnabled(false);
      throw new Error("denied");
    }
  });
  const manager = createCookieManager({ enabled: false, setCookie });
  manager.set("first", "one");
  manager.set("second", "two");
  manager.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual(["first"]);
  expect(manager.get("first")).toBe("one");
  expect(manager.get("second")).toBe("two");
  fail = false;
  manager.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual(["first", "first", "second"]);
});

it("skips a snapshot operation replaced by another replay hook", () => {
  const setCookie = vi.fn((name: string, _value: string) => {
    if (name === "first") {
      manager.setEnabled(false);
      manager.set("second", "new");
      manager.setEnabled(true);
    }
  });
  const manager = createCookieManager({ enabled: false, setCookie });
  manager.set("first", "one");
  manager.set("second", "old");
  manager.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual(["first"]);
  manager.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual(["first", "second"]);
  expect(setCookie.mock.calls[1]?.[1]).toMatch(/^new;/);
});

it("can disable deferral completely", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const manager = createCookieManager({
    enabled: false,
    disableCookieDefer: true,
    setCookie,
    delCookie,
  });
  expect(manager.set("name", "value")).toBe(false);
  expect(manager.del("name")).toBe(false);
  expect(manager.get("name")).toBe("");
  manager.setEnabled(true);
  expect(setCookie).not.toHaveBeenCalled();
  expect(delCookie).not.toHaveBeenCalled();
});

it("purges immediately while disabled and cancels pending writes even when deletion fails", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn(() => {
    throw new Error("denied");
  });
  const manager = createCookieManager({ enabled: false, setCookie, delCookie });
  manager.set("name", "identity");
  expect(manager.purge("name")).toBe(false);
  expect(manager.get("name")).toBe("");
  manager.setEnabled(true);
  expect(setCookie).not.toHaveBeenCalled();
});

it("snapshots ignored/blocked lists, allows blocked reads and permits explicit cleanup", () => {
  const ignoreCookies = ["ignored"];
  const blockedCookies = ["blocked"];
  const getCookie = vi.fn(() => "stored");
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const config = {
    ignoreCookies,
    blockedCookies,
    getCookie,
    setCookie,
    delCookie,
    path: "/original",
  };
  const manager = createCookieManager(config);
  ignoreCookies.length = 0;
  blockedCookies.length = 0;
  config.path = "/mutated";
  expect(manager.get("ignored")).toBe("");
  expect(getCookie).not.toHaveBeenCalled();
  expect(manager.get("blocked")).toBe("stored");
  expect(manager.set("ignored", "value")).toBe(false);
  expect(manager.set("blocked", "value")).toBe(false);
  manager.del("ignored");
  manager.purge("blocked");
  expect(delCookie).toHaveBeenCalledTimes(2);
  manager.set("allowed", "value");
  expect(setCookie.mock.calls[0]?.[1]).toContain("path=/original");
});

it.each([null, [], false, 1, "cookies", () => {}])(
  "rejects malformed config %j before cookie access",
  (config) => {
    const read = vi.spyOn(document, "cookie", "get");
    const write = vi.spyOn(document, "cookie", "set");
    expect(() => createCookieManager(config as MicrosoftOpenTelemetryBrowserCookieConfig)).toThrow(
      TypeError,
    );
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);

it.each([
  { enabled: "false" },
  { domain: 1 },
  { path: false },
  { disableCookieDefer: 0 },
  { ignoreCookies: "name" },
  { ignoreCookies: [1] },
  { blockedCookies: [null] },
  { blockedCookies: new Array(1) },
  { getCookie: true },
  { setCookie: 1 },
  { delCookie: {} },
  { domain: "example.test; secure" },
  { path: "/\r\ninjected" },
])("rejects malformed member %j before cookie access", (config) => {
  const read = vi.spyOn(document, "cookie", "get");
  const write = vi.spyOn(document, "cookie", "set");
  expect(() => createCookieManager(config as MicrosoftOpenTelemetryBrowserCookieConfig)).toThrow(
    TypeError,
  );
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it.each(["inherited", "non-enumerable"])("snapshots %s settings once", (kind) => {
  const enabled = vi.fn(() => false);
  const fields = { enabled: { get: enabled }, path: { value: "/scoped" } };
  const source = Object.defineProperties({}, fields);
  const config = kind === "inherited" ? Object.create(source) : source;
  const manager = createCookieManager(config);
  expect(manager.isEnabled()).toBe(false);
  expect(manager.set("name", "value")).toBe(true);
  expect(manager.get("name")).toBe("value");
  expect(enabled).toHaveBeenCalledTimes(1);
});

it.each(["bad;name", "bad=name", "bad name", "bad\r\nname", ""])(
  "rejects unsafe names %j",
  (name) => {
    const setCookie = vi.fn();
    const manager = createCookieManager({ setCookie });
    expect(manager.set(name, "value")).toBe(false);
    expect(manager.get(name)).toBe("");
    expect(manager.del(name)).toBe(false);
    expect(manager.purge(name)).toBe(false);
    expect(setCookie).not.toHaveBeenCalled();
  },
);

it("rejects value/attribute injection and invalid lifetimes without calling hooks", () => {
  const setCookie = vi.fn();
  const manager = createCookieManager({ setCookie });
  for (const value of ["value; secure", "value\n", "value\x00", "value\x7f"]) {
    expect(manager.set("name", value)).toBe(false);
  }
  expect(manager.set("name", "value", 60, "host; injected")).toBe(false);
  expect(manager.set("name", "value", 60, undefined, "/; injected")).toBe(false);
  for (const age of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    expect(manager.set("name", "value", age)).toBe(false);
  }
  expect(setCookie).not.toHaveBeenCalled();
});

it("contains document and hook failures with diagnostics", () => {
  const warn = vi.spyOn(diag, "warn");
  const read = vi.spyOn(document, "cookie", "get").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(document, "cookie", "set").mockImplementation(() => {
    throw new Error("denied");
  });
  const manager = createCookieManager();
  expect(manager.isEnabled()).toBe(false);
  expect(manager.get("name")).toBe("");
  expect(manager.set("name", "value")).toBe(false);
  expect(manager.del("name")).toBe(false);
  expect(manager.purge("name")).toBe(false);
  expect(read).toHaveBeenCalled();
  expect(warn).toHaveBeenCalled();
  const fail = () => {
    throw new Error("hook failure");
  };
  const hooked = createCookieManager({ getCookie: fail, setCookie: fail, delCookie: fail });
  expect(hooked.get("name")).toBe("");
  expect(hooked.set("name", "value")).toBe(false);
  expect(hooked.del("name")).toBe(false);
  expect(hooked.purge("name")).toBe(false);
  warn.mockImplementation(fail);
  expect(hooked.get("name")).toBe("");
});

it("isolates state and shuts down permanently while retaining explicit purge", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const first = createCookieManager({ enabled: false, setCookie, delCookie });
  const second = createCookieManager({ enabled: false, setCookie, delCookie });
  first.set("name", "first");
  second.set("name", "second");
  first.shutdown();
  first.shutdown();
  first.setEnabled(true);
  expect(first.isEnabled()).toBe(false);
  expect(first.get("name")).toBe("");
  expect(first.set("name", "later")).toBe(false);
  expect(first.del("name")).toBe(false);
  expect(first.purge("name")).toBe(true);
  expect(delCookie).toHaveBeenCalledTimes(1);
  expect(second.get("name")).toBe("second");
  second.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(1);
  expect(setCookie.mock.calls[0]?.[1]).toMatch(/^second;/);
});

it.each(["__Host-identity", "__Secure-identity"])(
  "formats %s cleanup for the current protocol, including after shutdown",
  (name) => {
    const setCookie = vi.fn();
    const delCookie = vi.fn();
    const manager = createCookieManager({ setCookie, delCookie });
    const secure = location.protocol === "https:" ? "; secure; SameSite=None" : "";
    expect(manager.set(name, "identity")).toBe(true);
    expect(setCookie).toHaveBeenCalledWith(name, `identity${secure}; path=/`);
    expect(manager.del(name)).toBe(true);
    expect(manager.purge(name)).toBe(true);
    manager.shutdown();
    expect(manager.del(name)).toBe(true);
    expect(delCookie).toHaveBeenCalledTimes(3);
    for (const [deletedName, value] of delCookie.mock.calls) {
      expect(deletedName).toBe(name);
      expect(value).toBe(`; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${secure}; path=/`);
    }
  },
);

it.each([{ domain: "example.test" }, { path: "/app" }])(
  "rejects invalid Host cookie scope %j without restricting reads",
  (scope) => {
    const setCookie = vi.fn();
    const delCookie = vi.fn();
    const manager = createCookieManager({
      ...scope,
      getCookie: () => "identity",
      setCookie,
      delCookie,
    });
    expect(manager.get("__Host-identity")).toBe("identity");
    expect(manager.set("__Host-identity", "identity")).toBe(false);
    expect(manager.del("__Host-identity")).toBe(false);
    expect(manager.purge("__Host-identity")).toBe(false);
    expect(setCookie).not.toHaveBeenCalled();
    expect(delCookie).not.toHaveBeenCalled();
  },
);

it("validates effective Host cookie overrides before writing or purging", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const manager = createCookieManager({ path: "/app", setCookie, delCookie });
  expect(manager.set("__Host-identity", "identity", undefined, undefined, "/")).toBe(true);
  expect(manager.purge("__Host-identity", "/")).toBe(true);
  expect(manager.set("__Host-identity", "identity", undefined, "example.test", "/")).toBe(false);
  expect(manager.purge("__Host-identity", "/other")).toBe(false);
  expect(setCookie).toHaveBeenCalledTimes(1);
  expect(delCookie).toHaveBeenCalledTimes(1);
});

it("contains post-shutdown deletion failures and never resumes deferred writes", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn(() => {
    throw new Error("denied");
  });
  const manager = createCookieManager({
    enabled: false,
    disableCookieDefer: true,
    setCookie,
    delCookie,
  });
  expect(manager.del("name")).toBe(false);
  expect(delCookie).not.toHaveBeenCalled();
  manager.setEnabled(true);
  manager.shutdown();
  expect(manager.del("name")).toBe(false);
  expect(delCookie).toHaveBeenCalledTimes(1);
  manager.setEnabled(true);
  expect(manager.set("name", "identity")).toBe(false);
  expect(setCookie).not.toHaveBeenCalled();
});
