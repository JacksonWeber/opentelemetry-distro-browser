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

export function createLocalStorageKeyValueStorage(unavailableMessage: string): KeyValueStorage {
  // After a quota or security write failure, pause writes briefly instead of retrying every activity.
  let writesPausedUntil = 0;
  let warned = false;

  function warnOnce(): void {
    if (warned) return;
    warned = true;
    diag.warn(unavailableMessage);
  }

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
      if (typeof localStorage !== "undefined") {
        const result = operation(localStorage);
        if (operationType === "remove") writesPausedUntil = 0;
        return result;
      }
    } catch (error) {
      const errorName =
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        typeof error.name === "string"
          ? error.name
          : undefined;
      if (errorName !== "SecurityError" && errorName !== "QuotaExceededError") {
        throw error;
      }
      if (operationType === "write") {
        writesPausedUntil = Date.now() + WRITE_BACKOFF_MS;
      }
    }
    warnOnce();
    return fallback;
  }

  return {
    getItem: (key) =>
      useStorage<StorageReadResult>(
        (storage) => ({ success: true as const, value: storage.getItem(key) }),
        { success: false as const },
        "read",
      ),
    setItem: (key, value) =>
      useStorage(
        (storage) => {
          storage.setItem(key, value);
          return true;
        },
        false,
        "write",
      ),
    removeItem: (key) =>
      useStorage(
        (storage) => {
          storage.removeItem(key);
          return true;
        },
        false,
        "remove",
      ),
  };
}
