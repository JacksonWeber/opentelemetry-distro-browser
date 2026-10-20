// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";

type StorageReadResult = { success: true; value: string | null } | { success: false };

export const WRITE_BACKOFF_MS = 60_000;

/**
 * Minimal persistence contract shared by browser context managers.
 *
 * A future cookie manager can implement this contract without changing user or session lifecycle
 * code. Values remain owned and serialized by each manager.
 */
export interface KeyValueStorage {
  getItem(key: string): StorageReadResult;
  setItem(key: string, value: string): boolean;
  removeItem(key: string): boolean;
}

/** Same-origin Web Storage with key listing, used to discover records written by earlier pages. */
export interface WebKeyValueStorage extends KeyValueStorage {
  /** Keys that start with the storage name prefix, without that prefix. */
  keys(): string[];
}

/**
 * Wraps `localStorage` or `sessionStorage` so storage failures never reach callers. Any error,
 * including unavailable, blocked or full storage, logs `unavailableMessage` once and returns a
 * failure result. Keys are prefixed with `namePrefix`.
 */
export function createKeyValueStorage(
  area: "localStorage" | "sessionStorage",
  unavailableMessage: string,
  namePrefix = "",
): WebKeyValueStorage {
  // After a write failure, pause writes briefly instead of retrying every activity.
  let writesPausedUntil = 0;
  let warned = false;

  function useStorage<T>(
    operation: (storage: Storage) => T,
    fallback: T,
    operationType: "read" | "write" | "remove",
  ): T {
    const now = Date.now();
    // A backwards clock adjustment must not extend the pause beyond one backoff window.
    if (
      operationType === "write" &&
      now < writesPausedUntil &&
      now >= writesPausedUntil - WRITE_BACKOFF_MS
    ) {
      return fallback;
    }
    try {
      const storage = globalThis[area];
      if (storage) {
        const result = operation(storage);
        if (operationType === "remove") writesPausedUntil = 0;
        return result;
      }
    } catch {
      if (operationType === "write") writesPausedUntil = Date.now() + WRITE_BACKOFF_MS;
    }
    if (!warned) {
      warned = true;
      diag.warn(unavailableMessage);
    }
    return fallback;
  }

  return {
    getItem: (key) =>
      useStorage<StorageReadResult>(
        (storage) => ({ success: true as const, value: storage.getItem(namePrefix + key) }),
        { success: false as const },
        "read",
      ),
    setItem: (key, value) =>
      useStorage(
        (storage) => {
          storage.setItem(namePrefix + key, value);
          return true;
        },
        false,
        "write",
      ),
    removeItem: (key) =>
      useStorage(
        (storage) => {
          storage.removeItem(namePrefix + key);
          return true;
        },
        false,
        "remove",
      ),
    keys: () =>
      useStorage(
        (storage) =>
          Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "")
            .filter((key) => key.startsWith(namePrefix))
            .map((key) => key.slice(namePrefix.length)),
        [],
        "read",
      ),
  };
}
