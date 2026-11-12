// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import {
  createDefaultSessionIdGenerator,
  createSessionManager,
} from "@opentelemetry/browser-sdk/session";
import type { Session, SessionStore } from "@opentelemetry/browser-sdk/session";
import type { CookieReadResult } from "../storage/cookieManager.js";
import { createKeyValueStorage, type KeyValueStorage } from "../storage/keyValueStorage.js";
import type {
  MicrosoftOpenTelemetryBrowserCookieManager,
  MicrosoftOpenTelemetryBrowserSessionOptions,
} from "../types.js";

const storageKey = "opentelemetry-session";

function lifetimeSeconds(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`session.${name} must be a finite, nonnegative number of seconds.`);
  }
  return value;
}

/**
 * Creates a session using legacy Web Storage persistence unless a cookie manager is supplied.
 * In cookie mode, storage is only a restoration fallback and an explicit `backup()` target;
 * pass `null` to disable Web Storage (passing `undefined` selects the legacy default).
 * The caller supplies the complete cookie name, including any instance prefix, and calls
 * `backup()` on unload/shutdown. Cookie policy and deferred writes belong to the manager.
 */
export function createSession(
  options: MicrosoftOpenTelemetryBrowserSessionOptions,
  storage: KeyValueStorage | null = createKeyValueStorage(
    "localStorage",
    "Session storage unavailable; using an in-memory session.",
  ),
  cookies?: MicrosoftOpenTelemetryBrowserCookieManager & {
    read?: (name: string) => CookieReadResult;
  },
  cookieName = "ai_session",
  readLifetimes?: () => { readonly inactivityTimeout: number; readonly maxDuration: number },
) {
  const inactivityTimeout = lifetimeSeconds(
    options.inactivityTimeout,
    30 * 60,
    "inactivityTimeout",
  );
  const maxDuration = lifetimeSeconds(options.maxDuration, 24 * 60 * 60, "maxDuration");
  const persist = options.persist === undefined ? true : options.persist;
  if (typeof persist !== "boolean") throw new TypeError("session.persist must be a boolean.");
  let lastActivityTimestamp = Date.now();
  let currentSession: Session | undefined;
  let lastCookieWrite: number | undefined;
  let lastCookiePolicy: { inactivityTimeout: number; maxDuration: number } | undefined;
  let ignoreBackup = false;
  let readFailed = false;
  let restoredFromBackup = false;

  function expired(session: Session, now: number): boolean {
    const policy = readLifetimes?.() ?? { inactivityTimeout, maxDuration };
    return (
      now < session.startTimestamp ||
      now < lastActivityTimestamp ||
      (policy.inactivityTimeout > 0 &&
        (now - lastActivityTimestamp) / 1000 >= policy.inactivityTimeout) ||
      (policy.maxDuration > 0 && (now - session.startTimestamp) / 1000 >= policy.maxDuration)
    );
  }

  function serialize(session: Session): string {
    return JSON.stringify({ ...session, lastActivityTimestamp });
  }

  function save(session: Session, force = false): void {
    // Keep errors synchronous because upstream does not await saves.
    if (!persist || readFailed) return;
    if (!cookies) {
      storage?.setItem(storageKey, serialize(session));
      return;
    }
    const now = Date.now();
    const policy = readLifetimes?.() ?? { inactivityTimeout, maxDuration };
    if (
      !force &&
      lastCookieWrite !== undefined &&
      lastCookiePolicy?.inactivityTimeout === policy.inactivityTimeout &&
      lastCookiePolicy.maxDuration === policy.maxDuration &&
      now >= lastCookieWrite &&
      (now === lastCookieWrite ||
        ((policy.inactivityTimeout === 0 || policy.inactivityTimeout > 60) &&
          now - lastCookieWrite < 60_000))
    ) {
      return;
    }
    // Short inactivity windows need each activity persisted to survive reloads.
    // A rejected renewal must not inherit the previous session's accepted-write throttle.
    lastCookieWrite = undefined;
    // Round cookie retention up to whole seconds; timestamps enforce the exact session deadline.
    const maxAge =
      policy.maxDuration === 0
        ? undefined
        : Math.ceil(
            Math.max(
              0,
              Math.min(
                policy.maxDuration - (now - session.startTimestamp) / 1000,
                policy.inactivityTimeout > 0
                  ? policy.inactivityTimeout - (now - lastActivityTimestamp) / 1000
                  : Infinity,
              ),
            ),
          );
    try {
      // Accepted deferred writes count too; never bypass cookie policy via Web Storage.
      // Legacy JSON IDs may not be safe in AI's raw pipe-delimited cookie format.
      // eslint-disable-next-line no-control-regex
      if (/[;|\x00-\x1f\x7f]/.test(session.id)) return;
      if (
        cookies.set(
          cookieName,
          `${session.id}|${session.startTimestamp}|${lastActivityTimestamp}`,
          maxAge,
        )
      ) {
        lastCookieWrite = now;
        lastCookiePolicy = { ...policy };
      }
    } catch {
      // Custom managers may throw; persistence must not interrupt telemetry.
    }
  }

  function restore(): Session | null {
    if (!persist) return null;
    // The upstream store collapses malformed JSON and stored null into an absent key.
    let value: string | null = null;
    if (cookies) {
      try {
        const result = cookies.read
          ? cookies.read(cookieName)
          : { success: true as const, value: cookies.get(cookieName) };
        readFailed = !result.success;
        if (!result.success) return null;
        value = result.value || null;
      } catch {
        readFailed = true;
        return null;
      }
    }
    const fromBackup = value === null;
    let id: unknown;
    let startTimestamp: unknown;
    let lastActivity: unknown;
    if (value === null) {
      if (ignoreBackup) return null;
      const result = storage?.getItem(storageKey);
      if (!result?.success || result.value === null) return null;
      try {
        const session: unknown = JSON.parse(result.value);
        if (typeof session === "object" && session !== null) {
          id = "id" in session ? session.id : undefined;
          startTimestamp = "startTimestamp" in session ? session.startTimestamp : undefined;
          lastActivity =
            "lastActivityTimestamp" in session ? session.lastActivityTimestamp : startTimestamp;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    } else {
      const parts = value.split("|");
      // A present malformed cookie is authoritative; do not resurrect a storage backup.
      if (parts.length !== 3) return null;
      id = parts[0];
      startTimestamp = parts[1] ? Number(parts[1]) : undefined;
      lastActivity = parts[2] ? Number(parts[2]) : undefined;
    }
    if (
      typeof id === "string" &&
      id.length > 0 &&
      typeof startTimestamp === "number" &&
      Number.isFinite(startTimestamp) &&
      startTimestamp >= 0 &&
      startTimestamp <= Date.now() &&
      typeof lastActivity === "number" &&
      Number.isFinite(lastActivity) &&
      lastActivity >= startTimestamp &&
      lastActivity <= Date.now()
    ) {
      lastActivityTimestamp = lastActivity;
      const restored = { id, startTimestamp };
      if (expired(restored, Date.now())) return null;
      currentSession = restored;
      restoredFromBackup = fromBackup;
      return restored;
    }
    diag.warn("Invalid stored session; creating a new session.");
    return null;
  }

  const store: SessionStore = {
    get() {
      return Promise.resolve(restore());
    },
    save(session) {
      // Keep a provisional session for correlation during read failures, without persisting
      // over unresolved cookies or backups. Later enrichment retries authoritative restoration.
      currentSession = session;
      restoredFromBackup = false;
      lastActivityTimestamp = session.startTimestamp;
      save(session, true);
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
    /** A missing user cookie must not resurrect the previous user's session backup. */
    discardBackup() {
      ignoreBackup = true;
      if (restoredFromBackup) {
        currentSession = undefined;
        restoredFromBackup = false;
        manager.shutdown();
        manager = createManager();
      }
      if (persist) storage?.removeItem(storageKey);
    },
    /** Saves the latest activity to the optional Web Storage backup without creating a session. */
    backup() {
      if (persist && !readFailed && currentSession) {
        storage?.setItem(storageKey, serialize(currentSession));
      }
    },
    getSessionId() {
      if (readFailed) {
        const restored = restore();
        if (!readFailed) {
          currentSession = restored ?? undefined;
          lastCookieWrite = undefined;
          manager.shutdown();
          manager = createManager();
        }
      }
      const session = currentSession ?? manager.getSession();
      const now = Date.now();
      if (expired(session, now)) {
        currentSession = undefined;
        manager.shutdown();
        manager = createManager();
        return manager.getSession().id;
      }
      if (now !== lastActivityTimestamp) {
        lastActivityTimestamp = now;
        save(session);
      } else if (cookies) {
        save(session);
      }
      return session.id;
    },
  };
}
