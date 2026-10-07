// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { createDefaultSessionIdGenerator } from "@opentelemetry/browser-sdk/session";
import {
  createLocalStorageKeyValueStorage,
  type KeyValueStorage,
} from "../storage/keyValueStorage.js";
import { isNonEmptyString } from "../shared/isNonEmptyString.js";
import type { MicrosoftOpenTelemetryBrowserUserContext } from "../types.js";
import { USER_STORAGE_KEY } from "./constants.js";

interface StoredUser {
  anonymousId: string;
  authenticatedUserId?: string;
  accountId?: string;
}

interface StoredUserFields {
  anonymousId: string;
  authenticatedUserId: string | undefined;
  accountId: string | undefined;
}

/**
 * Generates a 128-bit hexadecimal identifier from the platform's cryptographic random source.
 * Where Web Crypto is unavailable, falls back to the upstream session ID generator, which uses
 * `Math.random()` and is not cryptographically secure.
 */
function generateAnonymousId(): string {
  const random = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  if (!random) return createDefaultSessionIdGenerator().generateSessionId();
  return Array.from(random(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Parses stored JSON, returning `undefined` for malformed values. */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

function readOwn(value: object, key: keyof StoredUser): unknown {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Returns a normalized identity built only from own properties, or `undefined` when invalid.
 * Every field is an own property so later reads never fall through to the prototype chain.
 */
function toStoredUser(value: unknown): StoredUserFields | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const anonymousId = readOwn(value, "anonymousId");
  const authenticatedUserId = readOwn(value, "authenticatedUserId");
  const accountId = readOwn(value, "accountId");
  if (!isNonEmptyString(anonymousId)) return undefined;
  if (authenticatedUserId === undefined) {
    return accountId === undefined
      ? { anonymousId, authenticatedUserId: undefined, accountId: undefined }
      : undefined;
  }
  if (!isNonEmptyString(authenticatedUserId)) return undefined;
  if (accountId !== undefined && !isNonEmptyString(accountId)) return undefined;
  return { anonymousId, authenticatedUserId, accountId };
}

export interface UserContextProvider {
  getAnonymousUserId(): string;
  getAuthenticatedUserId(): string | undefined;
  getAccountId(): string | undefined;
}

export function createUserContext(
  initialEnabled: boolean,
  storage: KeyValueStorage = createLocalStorageKeyValueStorage(
    "User storage unavailable; using in-memory identity.",
  ),
): {
  context: MicrosoftOpenTelemetryBrowserUserContext;
  provider: UserContextProvider;
} {
  let enabled = initialEnabled;
  let anonymousId = generateAnonymousId();
  let authenticatedUserId: string | undefined;
  let accountId: string | undefined;

  function currentUser(): StoredUser {
    return {
      anonymousId,
      ...(authenticatedUserId === undefined ? {} : { authenticatedUserId }),
      ...(accountId === undefined ? {} : { accountId }),
    };
  }

  function save(): boolean {
    if (!enabled) return true;
    return storage.setItem(USER_STORAGE_KEY, JSON.stringify(currentUser()));
  }

  /**
   * Saves the current identity. A failed write removes the stale record, which also frees space
   * and ends the storage adapter's write backoff, then retries once. Returns `false` only after
   * the stale record was removed, so a later page load cannot restore superseded identity.
   */
  function persist(): boolean {
    if (save()) return true;
    requireIdentityCleared(storage.removeItem(USER_STORAGE_KEY));
    return save();
  }

  function requireIdentityCleared(cleared: boolean): void {
    if (!cleared) {
      throw new Error("Unable to clear persisted user identity.");
    }
  }

  function requireIdentityPersisted(persisted: boolean): void {
    if (!persisted) {
      throw new Error("Unable to persist user identity.");
    }
  }

  // Best effort: identity may have been persisted by an earlier page load, but this instance has
  // not enabled persistence, so storage that stays inaccessible must not break the caller.
  function clearPersistedAuthenticatedContext(): void {
    const result = storage.getItem(USER_STORAGE_KEY);
    if (!result.success) {
      storage.removeItem(USER_STORAGE_KEY);
      return;
    }
    if (result.value === null) return;
    const stored = toStoredUser(tryParseJson(result.value));
    if (!stored) {
      storage.removeItem(USER_STORAGE_KEY);
      return;
    }
    const anonymousOnly = JSON.stringify({ anonymousId: stored.anonymousId });
    if (!storage.setItem(USER_STORAGE_KEY, anonymousOnly)) {
      storage.removeItem(USER_STORAGE_KEY);
    }
  }

  if (enabled) {
    const result = storage.getItem(USER_STORAGE_KEY);
    if (!result.success) {
      enabled = false;
    } else {
      if (result.value === null) {
        if (!save()) enabled = false;
      } else {
        const stored = toStoredUser(tryParseJson(result.value));
        if (stored) {
          anonymousId = stored.anonymousId;
          authenticatedUserId = stored.authenticatedUserId;
          accountId = stored.accountId;
        } else {
          diag.warn("Invalid stored user identity; creating a new identity.");
          if (!save()) {
            // The storage adapter already reports failures; initialization continues in memory.
            storage.removeItem(USER_STORAGE_KEY);
            enabled = false;
          }
        }
      }
    }
  }

  const context: MicrosoftOpenTelemetryBrowserUserContext = {
    setAuthenticatedUserContext(userId, newAccountId) {
      if (!isNonEmptyString(userId)) {
        throw new TypeError("Authenticated user ID must be a non-empty string.");
      }
      if (newAccountId !== undefined && !isNonEmptyString(newAccountId)) {
        throw new TypeError("Account ID must be a non-empty string when provided.");
      }
      authenticatedUserId = userId;
      accountId = newAccountId;
      requireIdentityPersisted(persist());
    },
    clearAuthenticatedUserContext() {
      authenticatedUserId = undefined;
      accountId = undefined;
      if (!enabled) {
        clearPersistedAuthenticatedContext();
      } else if (!persist()) {
        // Stale authentication is already removed; keep the anonymous identity in memory.
        enabled = false;
        diag.warn("User identity persistence disabled; storage writes failed.");
      }
    },
    setEnabled(newEnabled) {
      if (newEnabled) {
        enabled = true;
        try {
          requireIdentityPersisted(persist());
        } catch (error) {
          enabled = false;
          throw error;
        }
      } else {
        const removed = storage.removeItem(USER_STORAGE_KEY);
        // Only an instance that persisted identity must guarantee removal; otherwise clear any
        // identity left by an earlier page load on a best-effort basis.
        if (enabled) requireIdentityCleared(removed);
        enabled = false;
      }
    },
  };

  return {
    context,
    provider: {
      getAnonymousUserId: () => anonymousId,
      getAuthenticatedUserId: () => authenticatedUserId,
      getAccountId: () => accountId,
    },
  };
}
