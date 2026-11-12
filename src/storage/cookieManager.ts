// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import type {
  MicrosoftOpenTelemetryBrowserCookieConfig,
  MicrosoftOpenTelemetryBrowserCookieManager,
} from "../types.js";

export type CookieReadResult = { success: true; value: string } | { success: false };

/**
 * Creates an instance-owned cookie manager without accessing cookies during construction.
 * Settings (including inherited/non-enumerable members and lists) are snapshotted.
 * Unlike AI JS, values cannot contain attribute suffixes: raw semicolons and control
 * characters are rejected to prevent cookie-header injection. Encode such values first.
 * Disabled writes/deletes are deferred by default; this is not a consent buffer for telemetry.
 */
export function createCookieManager(
  config?: MicrosoftOpenTelemetryBrowserCookieConfig,
): MicrosoftOpenTelemetryBrowserCookieManager & {
  read(name: string): CookieReadResult;
  canRead(name: string): boolean;
  setReplayFailureHandler(
    handler: ((name: string, removeSuperseded: () => boolean) => void) | undefined,
  ): void;
  shutdown(): void;
} {
  if (
    config !== undefined &&
    (config === null || typeof config !== "object" || Array.isArray(config))
  ) {
    throw new TypeError("cookieCfg must be a non-null, non-array object.");
  }
  const settings = {
    enabled: config?.enabled,
    domain: config?.domain,
    path: config?.path,
    ignoreCookies: config?.ignoreCookies,
    blockedCookies: config?.blockedCookies,
    disableCookieDefer: config?.disableCookieDefer,
    getCookie: config?.getCookie,
    setCookie: config?.setCookie,
    delCookie: config?.delCookie,
  };
  for (const key of ["enabled", "disableCookieDefer"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean") {
      throw new TypeError(`cookieCfg.${key} must be a boolean.`);
    }
  }
  for (const key of ["domain", "path"] as const) {
    const value = settings[key];
    if (value !== undefined && (typeof value !== "string" || !safeAttribute(value))) {
      throw new TypeError(`cookieCfg.${key} must be a safe cookie attribute string.`);
    }
  }
  for (const key of ["ignoreCookies", "blockedCookies"] as const) {
    const value = settings[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) || Array.from(value).some((name) => typeof name !== "string"))
    ) {
      throw new TypeError(`cookieCfg.${key} must be an array of strings.`);
    }
  }
  for (const key of ["getCookie", "setCookie", "delCookie"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "function") {
      throw new TypeError(`cookieCfg.${key} must be a function.`);
    }
  }

  const ignored = new Set(settings.ignoreCookies);
  const blocked = new Set(settings.blockedCookies);
  const pending = new Map<
    string,
    { value: string; formatted: string; remove: boolean; scope?: string }
  >();
  let enabled = settings.enabled !== false;
  let everEnabled = enabled;
  let stopped = false;
  let replaying = false;
  let inFlightReplay: { name: string; cleanup?: () => boolean } | undefined;
  let replayFailureHandler: ((name: string, removeSuperseded: () => boolean) => void) | undefined;

  function attempt<T>(operation: () => T, fallback: T): T {
    try {
      return operation();
    } catch {
      // Hooks and browser privacy restrictions must never interrupt telemetry. Do not log values.
      try {
        diag.warn("Cookie operation failed or cookies are unavailable.");
      } catch {
        // A consumer-provided diagnostic logger must not turn persistence into a failure.
      }
      return fallback;
    }
  }

  function write(name: string, formatted: string, remove: boolean): boolean {
    return attempt(() => {
      const hook = remove ? settings.delCookie : settings.setCookie;
      if (hook) hook(name, formatted);
      else document.cookie = `${name}=${formatted}`;
      return true;
    }, false);
  }

  function attributes(domain: string | undefined, path: string): string {
    return `${domain ? `; domain=${domain}` : ""}; path=${path}`;
  }

  function deletion(scope = attributes(settings.domain, settings.path || "/")): string {
    const secure = typeof location !== "undefined" && location.protocol === "https:";
    return `; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${secure ? "; secure; SameSite=None" : ""}${scope}`;
  }

  function validPrefixScope(name: string, path?: string, domain?: string): boolean {
    return (
      !name.startsWith("__Host-") ||
      (!(domain || settings.domain) && (path || settings.path || "/") === "/")
    );
  }

  function validScope(name: string, path?: string, domain?: string): boolean {
    return (
      typeof name === "string" &&
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) &&
      (path === undefined || (typeof path === "string" && safeAttribute(path))) &&
      (domain === undefined || (typeof domain === "string" && safeAttribute(domain)))
    );
  }

  function store(
    name: string,
    value: string,
    formatted: string,
    remove: boolean,
    scope?: string,
  ): boolean {
    if (enabled) {
      // A newer explicit operation supersedes even an in-flight or failed replay.
      pending.delete(name);
      const replay = inFlightReplay?.name === name ? inFlightReplay : undefined;
      const cleanup = replay?.cleanup;
      const accepted = write(name, formatted, remove);
      if (accepted && !remove && replay && replay.cleanup === cleanup) {
        replay.cleanup = undefined;
      }
      return accepted;
    }
    if (settings.disableCookieDefer) return false;
    if (!remove && inFlightReplay?.name === name) inFlightReplay.cleanup = undefined;
    // Delete before re-inserting so flush order also reflects the latest operation per name.
    pending.delete(name);
    pending.set(name, { value, formatted, remove, scope });
    return true;
  }

  function read(name: string): CookieReadResult {
    if (stopped || !validScope(name) || ignored.has(name)) return { success: true, value: "" };
    if (!enabled) return { success: true, value: pending.get(name)?.value ?? "" };
    return attempt<CookieReadResult>(
      () => {
        if (settings.getCookie) {
          const value = settings.getCookie(name);
          return typeof value === "string" ? { success: true, value } : { success: false };
        }
        for (const part of document.cookie.split(";")) {
          const cookie = part.trim();
          const separator = cookie.indexOf("=");
          if (cookie.slice(0, separator) === name) {
            return { success: true, value: cookie.slice(separator + 1) };
          }
        }
        return { success: true, value: "" };
      },
      { success: false },
    );
  }

  return {
    read,
    // Internal policy query: availability is checked separately, without re-reading caller config.
    canRead: (name) => !ignored.has(name),
    // Internal coordination only: generic cookie failures do not authorize destructive cleanup.
    // Identity may opt in using an exact-scope delete that preserves the pending replacement.
    setReplayFailureHandler(handler) {
      if (!stopped) replayFailureHandler = handler;
    },
    isEnabled: () =>
      enabled &&
      !stopped &&
      attempt(
        () =>
          !!(settings.getCookie || settings.setCookie || settings.delCookie) ||
          typeof document.cookie === "string",
        false,
      ),
    setEnabled(value) {
      if (stopped || typeof value !== "boolean") return;
      enabled = value;
      everEnabled ||= value;
      if (enabled && !replaying) {
        replaying = true;
        try {
          // Snapshot for a bounded pass; keep failures and unattempted operations for recovery.
          for (const [name, operation] of Array.from(pending)) {
            if (stopped || !enabled) break;
            if (pending.get(name) !== operation) continue;
            const replay: typeof inFlightReplay = operation.remove ? undefined : { name };
            inFlightReplay = replay;
            const success = write(name, operation.formatted, operation.remove);
            inFlightReplay = undefined;
            // A hook may finish writing after a nested purge. Honor that purge once more,
            // unless a newer same-name write superseded it while the hook was running.
            replay?.cleanup?.();
            // Hooks (including diagnostics) can re-enter, replace, purge, or stop the manager.
            if (pending.get(name) !== operation) continue;
            if (success) pending.delete(name);
            else if (!operation.remove && !stopped && enabled) {
              attempt(() => {
                replayFailureHandler?.(name, () => {
                  if (stopped || !enabled || pending.get(name) !== operation) return false;
                  return write(name, deletion(operation.scope), true);
                });
                return true;
              }, false);
            }
          }
        } finally {
          replaying = false;
        }
      }
    },
    get(name) {
      const result = read(name);
      return result.success ? result.value : "";
    },
    set(name, value, maxAgeSec, domain, path) {
      if (
        stopped ||
        !validScope(name, path, domain) ||
        !validPrefixScope(name, path, domain) ||
        typeof value !== "string" ||
        !safeAttribute(value) ||
        ignored.has(name) ||
        blocked.has(name) ||
        (maxAgeSec !== undefined && (typeof maxAgeSec !== "number" || !Number.isFinite(maxAgeSec)))
      ) {
        return false;
      }
      return attempt(() => {
        let formatted = value.trim();
        if (maxAgeSec !== undefined) {
          const expiry = new Date(Date.now() + maxAgeSec * 1000);
          if (!Number.isFinite(expiry.getTime())) return false;
          formatted += `; expires=${expiry.toUTCString()}; max-age=${Math.floor(maxAgeSec)}`;
        }
        if (typeof location !== "undefined" && location.protocol === "https:") {
          formatted += "; secure; SameSite=None";
        }
        const scope = attributes(domain || settings.domain, path || settings.path || "/");
        formatted += scope;
        // Browsers silently reject oversized cookies. Report failure before accepting/deferring
        // one so identity replacement can remove a previously persisted login.
        if (new TextEncoder().encode(`${name}=${formatted}`).byteLength > 4096) return false;
        return store(name, value.trim(), formatted, false, scope);
      }, false);
    },
    del(name, path) {
      if (stopped && !everEnabled) return false;
      if (!validScope(name, path) || !validPrefixScope(name, path)) return false;
      // Shutdown discards deferred operations, but explicit cleanup must remain available.
      const formatted = deletion(attributes(settings.domain, path || settings.path || "/"));
      if (stopped) return write(name, formatted, true);
      return store(name, "", formatted, true);
    },
    purge(name, path) {
      // Cleanup bypasses enabled, ignored/blocked lists and shutdown, and cannot resurrect a write.
      pending.delete(name);
      if (!validScope(name, path) || !validPrefixScope(name, path)) return false;
      const formatted = deletion(attributes(settings.domain, path || settings.path || "/"));
      if (inFlightReplay?.name === name) {
        inFlightReplay.cleanup = () => write(name, formatted, true);
      }
      return write(name, formatted, true);
    },
    shutdown() {
      stopped = true;
      enabled = false;
      pending.clear();
      replayFailureHandler = undefined;
    },
  };
}

function safeAttribute(value: string): boolean {
  // Intentionally reject cookie-header control characters, not just line breaks.
  // eslint-disable-next-line no-control-regex
  return !/[;\x00-\x1f\x7f]/.test(value);
}
