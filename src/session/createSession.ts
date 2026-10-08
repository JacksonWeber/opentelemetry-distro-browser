// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import {
  createDefaultSessionIdGenerator,
  createSessionManager,
} from "@opentelemetry/browser-sdk/session";
import type { Session, SessionStore } from "@opentelemetry/browser-sdk/session";
import {
  createLocalStorageKeyValueStorage,
  type KeyValueStorage,
} from "../storage/keyValueStorage.js";
import type { MicrosoftOpenTelemetryBrowserSessionOptions } from "../types.js";

const storageKey = "opentelemetry-session";

function lifetimeSeconds(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`session.${name} must be a finite, nonnegative number of seconds.`);
  }
  return value;
}

export function createSession(
  options: MicrosoftOpenTelemetryBrowserSessionOptions,
  storage: KeyValueStorage = createLocalStorageKeyValueStorage(
    "Session storage unavailable; using an in-memory session.",
  ),
) {
  const inactivityTimeout = lifetimeSeconds(
    options.inactivityTimeout,
    30 * 60,
    "inactivityTimeout",
  );
  const maxDuration = lifetimeSeconds(options.maxDuration, 0, "maxDuration");
  const persist = options.persist === undefined ? true : options.persist;
  if (typeof persist !== "boolean") throw new TypeError("session.persist must be a boolean.");
  let lastActivityTimestamp = Date.now();

  function expired(session: Session, now: number): boolean {
    return (
      now < session.startTimestamp ||
      now < lastActivityTimestamp ||
      (inactivityTimeout > 0 && (now - lastActivityTimestamp) / 1000 >= inactivityTimeout) ||
      (maxDuration > 0 && (now - session.startTimestamp) / 1000 >= maxDuration)
    );
  }

  function save(session: Session): void {
    // Keep errors synchronous because upstream does not await saves.
    if (persist) {
      storage.setItem(storageKey, JSON.stringify({ ...session, lastActivityTimestamp }));
    }
  }

  const store: SessionStore = {
    get() {
      if (!persist) return Promise.resolve(null);
      // The upstream store collapses malformed JSON and stored null into an absent key.
      const result = storage.getItem(storageKey);
      if (!result.success || result.value === null) return Promise.resolve(null);
      let session: unknown;
      try {
        session = JSON.parse(result.value);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (
        typeof session === "object" &&
        session !== null &&
        "id" in session &&
        typeof session.id === "string" &&
        session.id.length > 0 &&
        "startTimestamp" in session &&
        typeof session.startTimestamp === "number" &&
        Number.isFinite(session.startTimestamp) &&
        session.startTimestamp >= 0 &&
        session.startTimestamp <= Date.now()
      ) {
        const lastActivity =
          "lastActivityTimestamp" in session
            ? session.lastActivityTimestamp
            : session.startTimestamp;
        if (
          typeof lastActivity === "number" &&
          Number.isFinite(lastActivity) &&
          lastActivity >= session.startTimestamp &&
          lastActivity <= Date.now()
        ) {
          lastActivityTimestamp = lastActivity;
          const restored = { id: session.id, startTimestamp: session.startTimestamp };
          return Promise.resolve(expired(restored, Date.now()) ? null : restored);
        }
      }
      diag.warn("Invalid stored session; creating a new session.");
      return Promise.resolve(null);
    },
    save(session) {
      lastActivityTimestamp = session.startTimestamp;
      save(session);
      return Promise.resolve();
    },
  };
  // Avoid upstream's five-second activity debounce.
  const createManager = () =>
    createSessionManager({
      sessionIdGenerator: createDefaultSessionIdGenerator(),
      sessionStore: store,
    });
  let manager = createManager();
  return {
    start: () => manager.start(),
    shutdown: () => manager.shutdown(),
    getSessionId() {
      const session = manager.getSession();
      const now = Date.now();
      if (expired(session, now)) {
        manager.shutdown();
        manager = createManager();
        return manager.getSession().id;
      }
      if (now !== lastActivityTimestamp) {
        lastActivityTimestamp = now;
        save(session);
      }
      return session.id;
    },
  };
}
