// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import {
  createDefaultSessionIdGenerator,
  createSessionManager,
} from "@opentelemetry/browser-sdk/session";
import type { Session, SessionStore } from "@opentelemetry/browser-sdk/session";

const storageKey = "opentelemetry-session";
const inactivityTimeoutSeconds = 30 * 60;

function createDefaultStore() {
  let unavailable = false;
  let lastActivityTimestamp = Date.now();

  function useStorage<T>(operation: () => T, fallback: T): T {
    if (unavailable) return fallback;
    try {
      if (typeof localStorage !== "undefined") return operation();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error.name !== "SecurityError" && error.name !== "QuotaExceededError")
      ) {
        throw error;
      }
    }
    unavailable = true;
    diag.warn("Session storage unavailable; using an in-memory session.");
    return fallback;
  }

  const store: SessionStore = {
    get() {
      // The upstream store collapses malformed JSON and stored null into an absent key.
      const stored = useStorage(() => localStorage.getItem(storageKey), null);
      if (stored === null) return Promise.resolve(null);
      let session: unknown;
      try {
        session = JSON.parse(stored);
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
      // The manager does not await saves; unexpected storage failures must throw synchronously.
      useStorage(
        () =>
          localStorage.setItem(storageKey, JSON.stringify({ ...session, lastActivityTimestamp })),
        undefined,
      );
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
export function createSession() {
  const { store, recordActivity } = createDefaultStore();
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
