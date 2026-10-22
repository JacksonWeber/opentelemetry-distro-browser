// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createKeyValueStorage, type WebKeyValueStorage } from "../storage/keyValueStorage.js";

export const SESSION_BUFFER_KEY_PREFIX = "opentelemetry-buffer|";
/** Stored UTF-16 code units per exporter; oldest batches are evicted first. */
export const MAX_SESSION_BUFFER_LENGTH: number = 512 * 1024;
export const MAX_SESSION_BUFFER_AGE_MS: number = 60 * 60 * 1000;

/**
 * Buffer storage for exporter options created by `useMicrosoftOpenTelemetry`, keyed by the options
 * object. `null` disables buffering; absent options use unprefixed `sessionStorage`.
 */
export const sessionBufferStorage = new WeakMap<object, WebKeyValueStorage | null>();

export function createSessionBufferStorage(namePrefix?: string): WebKeyValueStorage {
  return createKeyValueStorage(
    "sessionStorage",
    "Unsent telemetry cannot be buffered in sessionStorage.",
    namePrefix,
  );
}

type Entry = [time: number, body: string, dispatched?: boolean];

const pageListeners = new Set<() => void>();
let pageHidden = false;
const onPageTransition = (event: Event): void => {
  pageHidden = event.type === "pagehide";
  for (const listener of pageListeners) listener();
};

function subscribeToPageTransitions(listener: () => void): () => void {
  if (pageListeners.size === 0) {
    pageHidden = false;
    globalThis.addEventListener?.("pagehide", onPageTransition);
    globalThis.addEventListener?.("pageshow", onPageTransition);
  }
  pageListeners.add(listener);
  return () => {
    if (!pageListeners.delete(listener) || pageListeners.size > 0) return;
    globalThis.removeEventListener?.("pagehide", onPageTransition);
    globalThis.removeEventListener?.("pageshow", onPageTransition);
  };
}

/**
 * Mirrors one exporter's unsent request bodies into a tab-scoped `sessionStorage` record so the
 * next page load in the same tab can send them.
 *
 * @remarks
 * Each record is `[released, [time, envelopes], ...]` under a key unique to the destination,
 * document and exporter. A record is released only on `pagehide`, and only released records from
 * another document are adopted, so live same-origin frames, including hidden ones, never send each
 * other's telemetry. Adoption removes the record. Before each use, a page whose released record is
 * gone drops its copy, ignores later outcomes of requests started before the handoff and stops
 * their retries. Any failed write removes the record, so a stale copy cannot resend delivered
 * telemetry.
 */
export class SessionBuffer {
  readonly #entries = new Map<number, Entry>();
  readonly #prefix: string;
  readonly #pagePrefix: string;
  readonly #key: string;
  readonly #storage: WebKeyValueStorage;
  readonly #unsubscribe: () => void;
  #nextId = 0;
  /** IDs with a request in progress that this document still owns. */
  readonly #live = new Set<number>();
  #stored = false;
  /** The stored record is marked released for adoption. */
  #released = false;

  public constructor(destination: string, storage = createSessionBufferStorage()) {
    this.#storage = storage;
    // Encoded so a `|` in the endpoint cannot make one destination's prefix match another's keys.
    this.#prefix = `${SESSION_BUFFER_KEY_PREFIX}${encodeURIComponent(destination)}|`;
    this.#pagePrefix = `${this.#prefix}${globalThis.performance?.timeOrigin}|`;
    this.#key = `${this.#pagePrefix}${Math.random().toString(36).slice(2)}`;
    this.#unsubscribe = subscribeToPageTransitions(() => {
      this.#reconcile();
      this.#write();
    });
  }

  /** Marks a request in progress for a buffered ID, until {@link SessionBuffer.end}. */
  public begin(id: number): void {
    this.#live.add(id);
  }

  public end(id: number): void {
    this.#live.delete(id);
  }

  /**
   * Whether a request's batch still belongs to this document rather than one that adopted it or
   * a disposed exporter.
   */
  public owns(id: number): boolean {
    this.#reconcile();
    return this.#live.has(id);
  }

  /** Buffers a serialized envelope array and returns its ID. */
  public add(body: string, time = Date.now()): number {
    this.#reconcile();
    const id = this.#nextId++;
    this.#entries.set(id, [time, body]);
    this.#write();
    return id;
  }

  /**
   * Leaves an unload request the browser accepted out of the record; it returns if the request
   * is later observed to fail.
   */
  public dispatch(id: number): void {
    const entry = this.owns(id) ? this.#entries.get(id) : undefined;
    if (!entry || entry[2]) return;
    entry[2] = true;
    this.#write();
  }

  /**
   * Keeps `body` for a buffered ID, replacing any earlier body, or removes it once delivered or
   * permanently rejected. Evicted, removed and handed-off IDs stay gone.
   */
  public settle(id: number, body: string, keep: boolean): void {
    const entry = this.owns(id) ? this.#entries.get(id) : undefined;
    if (!entry || (keep && !entry[2] && entry[1] === body)) return;
    if (keep) this.#entries.set(id, [entry[0], body]);
    else this.#entries.delete(id);
    this.#write();
  }

  /**
   * Takes ownership of released records left for this destination by earlier documents in the tab.
   * Expired and malformed records are discarded.
   */
  public adopt(): Array<[id: number, body: string]> {
    const adopted: Array<[number, string]> = [];
    const now = Date.now();
    for (const key of this.#storage.keys()) {
      if (!key.startsWith(this.#prefix) || key.startsWith(this.#pagePrefix)) continue;
      const read = this.#storage.getItem(key);
      if (!read.success) continue;
      let record: unknown;
      try {
        record = JSON.parse(read.value ?? "");
      } catch {
        // Malformed records are removed below.
      }
      const released = Array.isArray(record) && record[0] === 1;
      const entries = Array.isArray(record)
        ? record
            .slice(1)
            .filter(
              (entry): entry is [number, unknown[]] =>
                Array.isArray(entry) &&
                typeof entry[0] === "number" &&
                now - entry[0] <= MAX_SESSION_BUFFER_AGE_MS &&
                Array.isArray(entry[1]) &&
                entry[1].length > 0,
            )
        : [];
      // Live records belong to another open document; leave them until they expire.
      if (!released && entries.length > 0) continue;
      this.#storage.removeItem(key);
      if (!released) continue;
      for (const [time, envelopes] of entries) {
        const body = JSON.stringify(envelopes);
        const id = this.#nextId++;
        this.#entries.set(id, [time, body]);
        adopted.push([id, body]);
      }
    }
    if (adopted.length > 0) this.#write();
    return adopted;
  }

  /** Removes this exporter's record and stops tracking page transitions. */
  public dispose(): void {
    this.#unsubscribe();
    this.#entries.clear();
    // Requests that settle later must not recreate the record.
    this.#live.clear();
    this.#storage.removeItem(this.#key);
  }

  /**
   * Drops entries handed off to a document that adopted this page's released record. Dispatched
   * entries were not in the record, so they stay owned.
   */
  #reconcile(): void {
    if (!this.#released) return;
    const read = this.#storage.getItem(this.#key);
    if (!read.success || read.value !== null) return;
    for (const [id, [, , dispatched]] of this.#entries) {
      if (dispatched) continue;
      this.#entries.delete(id);
      this.#live.delete(id);
    }
    this.#stored = this.#released = false;
  }

  #write(): void {
    const now = Date.now();
    const parts: string[] = [];
    let length = 0;
    // Newest first, so the oldest batches are evicted even when adopted records interleave.
    const entries = [...this.#entries].sort(([, [left]], [, [right]]) => left - right).reverse();
    let full = false;
    for (const [id, [time, body, dispatched]] of entries) {
      if (dispatched) continue;
      const part = `[${time},${body}]`;
      // Once a batch overflows, it and every older batch are evicted. A batch that cannot fit
      // even alone is dropped without evicting older ones.
      if (
        full ||
        now - time > MAX_SESSION_BUFFER_AGE_MS ||
        part.length > MAX_SESSION_BUFFER_LENGTH ||
        (full = length + part.length > MAX_SESSION_BUFFER_LENGTH)
      ) {
        this.#entries.delete(id);
        continue;
      }
      length += part.length + 1;
      parts.unshift(part);
    }
    const stored = this.#stored;
    if (parts.length === 0 && !stored) return;
    this.#stored =
      parts.length > 0 &&
      this.#storage.setItem(this.#key, `[${pageHidden ? 1 : 0},${parts.join(",")}]`);
    this.#released = this.#stored && pageHidden;
    // Only remove a record that exists, since a removal ends the storage write backoff.
    if (stored && !this.#stored) this.#storage.removeItem(this.#key);
  }
}
