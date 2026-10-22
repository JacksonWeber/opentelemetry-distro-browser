// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach } from "vitest";

/** In-memory `Storage` so test files, which share one tab, cannot adopt each other's telemetry. */
export class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  public get length(): number {
    return this.#items.size;
  }

  public clear(): void {
    this.#items.clear();
  }

  public getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.#items.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.#items.set(key, String(value));
  }
}

export const testSessionStorage = new MemoryStorage();

/** Replaces `window.sessionStorage`; `vi.unstubAllGlobals()` does not undo it. */
export function setSessionStorage(storage: Storage | undefined): void {
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    get: () => {
      if (!storage) throw new DOMException("The operation is insecure.", "SecurityError");
      return storage;
    },
  });
}

beforeEach(() => {
  testSessionStorage.clear();
  setSessionStorage(testSessionStorage);
});
