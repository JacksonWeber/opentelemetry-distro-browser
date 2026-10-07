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

const storageKey = "opentelemetry-session";
const inactivityTimeoutSeconds = 30 * 60;

function createDefaultStore(storage: KeyValueStorage) {
  let lastActivityTimestamp = Date.now();

  const store: SessionStore = {
    get() {
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
        session.startTimestamp >= 0
      ) {
        // Older records only contain creation time; do not give them a fresh inactivity window.
        const lastActivity =
          "lastActivityTimestamp" in session
            ? session.lastActivityTimestamp
            : session.startTimestamp;
        if (
          typeof lastActivity === "number" &&
          Number.isFinite(lastActivity) &&
          lastActivity >= 0 &&
          lastActivity <= Date.now()
        ) {
          if (Date.now() - lastActivity >= inactivityTimeoutSeconds * 1000) {
            return Promise.resolve(null);
          }
          lastActivityTimestamp = lastActivity;
          return Promise.resolve({ id: session.id, startTimestamp: session.startTimestamp });
        }
      }
      diag.warn("Invalid stored session; creating a new session.");
      return Promise.resolve(null);
    },
    save(session) {
      // The adapter reports expected browser storage failures; the session remains in memory.
      storage.setItem(storageKey, JSON.stringify({ ...session, lastActivityTimestamp }));
      return Promise.resolve();
    },
  };
  return {
    store,
    recordActivity: (session: Session) => {
      const now = Date.now();
      if (now === lastActivityTimestamp) return;
      lastActivityTimestamp = now;
      // Timer-driven session rotation is not activity; only telemetry updates this timestamp.
      void store.save(session);
    },
  };
}

/** Adds persisted last-activity expiry to the upstream manager's in-page session lifecycle. */
export function createSession(
  storage: KeyValueStorage = createLocalStorageKeyValueStorage(
    "Session storage unavailable; using an in-memory session.",
  ),
) {
  const { store, recordActivity } = createDefaultStore(storage);
  const manager = createSessionManager({
    inactivityTimeout: inactivityTimeoutSeconds,
    sessionIdGenerator: createDefaultSessionIdGenerator(),
    sessionStore: store,
  });
  return {
    start: () => manager.start(),
    shutdown: () => manager.shutdown(),
    getSessionId() {
      const session = manager.getSession();
      recordActivity(session);
      return session.id;
    },
  };
}
