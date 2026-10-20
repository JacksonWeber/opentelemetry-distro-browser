// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { getSdkLoaderScript } from "../../../src/snippet.js";

const handles: MicrosoftOpenTelemetryBrowser[] = [];
const keys = ["opentelemetry-session", "opentelemetry-user"];
const saved = new Map<string, string | null>();

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
  for (const [key, value] of saved) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  saved.clear();
});

async function initialize(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
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
    emit() {
      trace.getTracer("storage-test").startSpan("operation").end();
      logs.getLogger("storage-test").emit({});
      const attributes = spans.at(-1)!.attributes;
      expect(records.at(-1)!.attributes).toMatchObject(attributes);
      return attributes;
    },
  };
}

it("blocks storage throughout identity controls, expiry, flush and shutdown", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  for (const key of keys) preserve(key, "previous-value");
  const local = vi.spyOn(window, "localStorage", "get");
  const session = vi.spyOn(window, "sessionStorage", "get");
  const cookie = vi.spyOn(document, "cookie", "get");
  const cookieWrite = vi.spyOn(document, "cookie", "set");
  const { handle, emit } = await initialize({
    storage: { enabled: false },
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
  handle.userContext.setEnabled(false);
  clock.mockReturnValue(now + 1000);
  expect(emit()["session.id"]).not.toBe(first);
  await handle.forceFlush();
  await handle.shutdown();
  handle.userContext.setEnabled(true);
  handle.userContext.clearAuthenticatedUserContext();
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
  expect(cookie).not.toHaveBeenCalled();
  expect(cookieWrite).not.toHaveBeenCalled();
  local.mockRestore();
  for (const key of keys) expect(localStorage.getItem(key)).toBe("previous-value");
});

it("isolates prefixed sessions and users, restores them, and scopes identity removal", async () => {
  for (const prefix of ["", "app-a-", "app-b-"]) {
    for (const key of keys) preserve(prefix + key);
  }
  const first = await initialize({ storage: { namePrefix: "app-a-" } });
  first.handle.userContext.setAuthenticatedUserContext("user-a");
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
  expect(JSON.parse(localStorage.getItem("app-a-opentelemetry-user")!)).toEqual({
    anonymousId: a["enduser.pseudo.id"],
  });
  restored.handle.userContext.setEnabled(false);
  expect(localStorage.getItem("app-a-opentelemetry-user")).toBeNull();
  expect(JSON.parse(localStorage.getItem("app-b-opentelemetry-user")!)).toEqual({
    anonymousId: b["enduser.pseudo.id"],
  });
  const disabled = await initialize({ storage: { enabled: false } });
  disabled.handle.userContext.setEnabled(true);
  second.handle.userContext.setAuthenticatedUserContext("user-b");
  expect(JSON.parse(localStorage.getItem("app-b-opentelemetry-user")!)).toMatchObject({
    authenticatedUserId: "user-b",
  });
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
