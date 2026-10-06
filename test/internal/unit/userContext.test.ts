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

beforeEach(() => {
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
  if (previousUser === null) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, previousUser);
});

async function initialize(enabled = false, resourceAttributes?: Record<string, string>) {
  const spans: Span[] = [];
  const records: ReadWriteLogRecord[] = [];
  const handle = await useMicrosoftOpenTelemetry({
    userContext: { enabled },
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
    return { span: spans.at(-1)!, log: records.at(-1)! };
  }
  return { handle, emit };
}

it("uses one anonymous in-memory identity without accessing storage before persistence is enabled", async () => {
  const access = vi.spyOn(window, "localStorage", "get");
  const { emit } = await initialize();
  const first = emit();
  const second = emit();
  expect(first.span.attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(first.log.attributes["enduser.pseudo.id"]).toBe(
    first.span.attributes["enduser.pseudo.id"],
  );
  expect(second.span.attributes["enduser.pseudo.id"]).toBe(
    first.span.attributes["enduser.pseudo.id"],
  );
  expect(access).not.toHaveBeenCalled();
});

it("persists, restores, and removes identity when persistence is enabled or disabled", async () => {
  const first = await initialize();
  first.handle.userContext.setAuthenticatedUserContext("signed-in-user", "tenant-42");
  expect(localStorage.getItem(storageKey)).toBeNull();
  const emitted = first.emit();
  expect(emitted.span.attributes).toMatchObject({
    "user.id": "signed-in-user",
    "user.account.id": "tenant-42",
  });

  first.handle.userContext.setEnabled(true);
  const stored = JSON.parse(localStorage.getItem(storageKey)!);
  expect(stored).toMatchObject({
    anonymousId: emitted.span.attributes["enduser.pseudo.id"],
    authenticatedUserId: "signed-in-user",
    accountId: "tenant-42",
  });
  await first.handle.shutdown();
  handles.delete(first.handle);
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();

  const restored = await initialize(true);
  expect(restored.emit().span.attributes).toMatchObject({
    "enduser.pseudo.id": stored.anonymousId,
    "user.id": "signed-in-user",
    "user.account.id": "tenant-42",
  });
  restored.handle.userContext.clearAuthenticatedUserContext();
  expect(restored.emit().span.attributes["user.id"]).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    anonymousId: stored.anonymousId,
  });
  restored.handle.userContext.setEnabled(false);
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("creates and persists an anonymous identity when enabled without stored state", async () => {
  const { emit } = await initialize(true);
  const anonymousId = emit().span.attributes["enduser.pseudo.id"];

  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ anonymousId });
});

it.each([
  "",
  "{malformed-private-payload",
  "null",
  '{"anonymousId":""}',
  '{"anonymousId":"anonymous","accountId":"tenant"}',
  '["anonymous"]',
])("replaces invalid stored identity (%j) without logging its contents", async (stored) => {
  localStorage.setItem(storageKey, stored);
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});

  const { emit } = await initialize(true);
  const anonymousId = emit().span.attributes["enduser.pseudo.id"];

  expect(anonymousId).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ anonymousId });
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "Invalid stored user identity; creating a new identity.",
  );
});

it("removes invalid stored identity when replacement persistence fails", async () => {
  localStorage.setItem(storageKey, "{malformed-private-payload");
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  const remove = vi.spyOn(Storage.prototype, "removeItem");

  const { emit } = await initialize(true);

  expect(emit().span.attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(remove).toHaveBeenCalledWith(storageKey);
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("continues in memory when invalid stored identity cannot be replaced or removed", async () => {
  localStorage.setItem(storageKey, "{malformed-private-payload");
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => {
    throw new DOMException("denied", "SecurityError");
  });

  const { emit } = await initialize(true);

  expect(emit().span.attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
});

it.each([
  ["anonymousId", "{}", /^[0-9a-f]{32}$/, { "user.id": undefined, "user.account.id": undefined }],
  [
    "authenticatedUserId",
    '{"anonymousId":"own-anonymous"}',
    /^own-anonymous$/,
    { "user.id": undefined, "user.account.id": undefined },
  ],
  [
    "accountId",
    '{"anonymousId":"own-anonymous","authenticatedUserId":"own-user"}',
    /^own-anonymous$/,
    { "user.id": "own-user", "user.account.id": undefined },
  ],
] as const)("ignores inherited %s on stored identity", async (key, stored, pseudoId, expected) => {
  localStorage.setItem(storageKey, stored);
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

  const { emit } = await initialize();

  expect(emit().span.attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
});

it("uses in-memory identity when localStorage is unavailable", async () => {
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  vi.stubGlobal("localStorage", undefined);

  const { handle, emit } = await initialize(true);

  expect(emit().span.attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(() => handle.userContext.setAuthenticatedUserContext("signed-in-user")).not.toThrow();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "User storage unavailable; using in-memory identity.",
  );
});

it("can enable persistence after localStorage becomes available", async () => {
  const storage = localStorage;
  vi.stubGlobal("localStorage", undefined);
  const current = await initialize(true);
  vi.stubGlobal("localStorage", storage);

  expect(() => current.handle.userContext.setEnabled(true)).not.toThrow();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    anonymousId: current.emit().span.attributes["enduser.pseudo.id"],
  });
});

it("reports a persistence failure when disabling cannot remove stored identity", async () => {
  const current = await initialize(true);
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => {
    throw new DOMException("denied", "SecurityError");
  });

  expect(() => current.handle.userContext.setEnabled(false)).toThrow(
    "Unable to clear persisted user identity.",
  );
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "User storage unavailable; using in-memory identity.",
  );
});

it("does not throw when disabling in-memory persistence with inaccessible storage", async () => {
  const current = await initialize();
  vi.spyOn(diag, "warn").mockImplementation(() => {});
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });

  expect(() => current.handle.userContext.setEnabled(false)).not.toThrow();
});

it("removes identity persisted by an earlier page load when disabling", async () => {
  localStorage.setItem(storageKey, JSON.stringify({ anonymousId: "earlier-page" }));
  const current = await initialize();

  current.handle.userContext.setEnabled(false);

  expect(localStorage.getItem(storageKey)).toBeNull();
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

it("reports a persistence failure when sign-out cannot mutate storage", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("signed-in-user");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });

  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).toThrow(
    "Unable to clear persisted user identity.",
  );
});

it("removes superseded identity when a new authenticated identity cannot be saved", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("persisted-user");
  vi.spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    })
    .mockImplementationOnce(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
  const remove = vi.spyOn(Storage.prototype, "removeItem");

  expect(() => current.handle.userContext.setAuthenticatedUserContext("new-user")).toThrow(
    "Unable to persist user identity.",
  );
  expect(remove).toHaveBeenCalledWith(storageKey);
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(current.emit().span.attributes["user.id"]).toBe("new-user");

  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    anonymousId: current.emit().span.attributes["enduser.pseudo.id"],
  });
});

it("recovers from a quota-limited write by replacing the stored identity", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("persisted-user");
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });

  expect(() => current.handle.userContext.setAuthenticatedUserContext("new-user")).not.toThrow();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
    authenticatedUserId: "new-user",
  });
});

it("clears a previous account when authenticated identity is set without one", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("first-user", "first-account");

  current.handle.userContext.setAuthenticatedUserContext("second-user");

  expect(current.emit().span.attributes["user.account.id"]).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).not.toHaveProperty("accountId");
});

it("falls back to in-memory identity when anonymous persistence cannot be restored", async () => {
  const current = await initialize(true);
  current.handle.userContext.setAuthenticatedUserContext("persisted-user");
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });

  expect(() => current.handle.userContext.setAuthenticatedUserContext("new-user")).toThrow(
    "Unable to persist user identity.",
  );
  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(warn).toHaveBeenCalledWith("User identity persistence disabled; storage writes failed.");
  expect(() =>
    current.handle.userContext.setAuthenticatedUserContext("in-memory-user"),
  ).not.toThrow();
});

it("reports a persistence failure when authenticated identity cannot be saved", async () => {
  const current = await initialize(true);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });

  expect(() => current.handle.userContext.setAuthenticatedUserContext("signed-in-user")).toThrow(
    "Unable to persist user identity.",
  );
});

it("does not remove an absent persisted identity", async () => {
  const current = await initialize();
  const remove = vi.spyOn(Storage.prototype, "removeItem");

  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
  expect(remove).not.toHaveBeenCalled();
});

it("removes persisted identity after a transient read failure", async () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      anonymousId: "persisted-anonymous",
      authenticatedUserId: "signed-in-user",
    }),
  );
  const current = await initialize();
  vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
    throw { name: "SecurityError" };
  });

  expect(() => current.handle.userContext.clearAuthenticatedUserContext()).not.toThrow();
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("can remove persisted identity after quota-limited writes", async () => {
  const current = await initialize(true);
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  const remove = vi.spyOn(Storage.prototype, "removeItem");

  expect(() => current.handle.userContext.setAuthenticatedUserContext("signed-in-user")).toThrow(
    "Unable to persist user identity.",
  );
  expect(() => current.handle.userContext.setEnabled(false)).not.toThrow();

  expect(remove).toHaveBeenCalledWith(storageKey);
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "User storage unavailable; using in-memory identity.",
  );
});

it("removes invalid persisted state while clearing authentication", async () => {
  localStorage.setItem(storageKey, "{malformed-private-payload");
  const current = await initialize();

  current.handle.userContext.clearAuthenticatedUserContext();

  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("clears previously persisted authentication when persistence is disabled", async () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      anonymousId: "persisted-anonymous",
      authenticatedUserId: "signed-out-user",
      accountId: "signed-out-account",
    }),
  );
  const current = await initialize();

  current.handle.userContext.clearAuthenticatedUserContext();

  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    anonymousId: "persisted-anonymous",
  });
  await current.handle.shutdown();
  handles.delete(current.handle);
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();

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
