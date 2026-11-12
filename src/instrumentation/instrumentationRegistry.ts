// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TelemetryInstance } from "../routing/telemetryInstance.js";
import type { BrowserInstrumentation } from "../types.js";
import { claimInstrumentationOwnership, isNetworkInstrumentation } from "./sharedBrowserPatches.js";
import { throwErrors } from "../shared/lifecycle.js";

interface Entry {
  instrumentation: BrowserInstrumentation;
  kind: string | undefined;
  requested: boolean;
  active: boolean;
  release: () => void;
  errorHandlers?: Set<EventListener>;
  transitioning?: boolean;
}

type Gates = { readonly disableFetchTracking: boolean; readonly disableAjaxTracking: boolean };

/** Optional metadata must not invoke application accessors or prevent startup. */
function metadata(instrumentation: BrowserInstrumentation, key: string): unknown {
  try {
    let target: object | null = instrumentation;
    while (target) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor.value as unknown;
      target = Object.getPrototypeOf(target) as object | null;
    }
  } catch {
    /* Treat unavailable metadata as unnamed. */
  }
  return undefined;
}

function kind(instrumentation: BrowserInstrumentation): string | undefined {
  const name = metadata(instrumentation, "instrumentationName");
  return metadata(instrumentation, "instrumentationVersion") === "0.8.1" && typeof name === "string"
    ? /^@opentelemetry\/browser-instrumentation\/(fetch|xhr|console|errors|user-action|web-vitals)$/.exec(
        name,
      )?.[1]
    : undefined;
}

/** Owns startup and runtime registrations for one instance, without changing shared patch ownership. */
export function createInstrumentationRegistry(
  instrumentations: readonly BrowserInstrumentation[],
  providers: Pick<TelemetryInstance, "tracerProvider" | "loggerProvider">,
  tracesEnabled: boolean,
  isStopped: () => boolean = () => false,
) {
  // Claim the whole list before any application callback can bind or enable an entry.
  const owned = new Map<BrowserInstrumentation, Entry>(
    [...claimInstrumentationOwnership(instrumentations)].map(([instrumentation, release]) => [
      instrumentation,
      { instrumentation, release, kind: kind(instrumentation), requested: true, active: false },
    ]),
  );
  const entries = new Map<string, Entry>();
  let gates: Gates = { disableFetchTracking: false, disableAjaxTracking: false };
  let failed = false;

  function check(): void {
    if (isStopped()) throw new Error("Telemetry instance is stopped.");
    if (failed) throw new Error("Instrumentation rollback failed; shutdown is required.");
  }

  // Upstream errors clears its flag before removing listeners. Retain the exact handler so
  // partial removals and shutdown reentered from addEventListener can still be cleaned up.
  function rememberErrors(entry: Entry): void {
    if (entry.kind !== "errors") return;
    const handler = (
      entry.instrumentation as BrowserInstrumentation & {
        _onErrorHandler?: EventListener;
      }
    )._onErrorHandler;
    if (handler) (entry.errorHandlers ??= new Set()).add(handler);
  }

  function cleanErrors(entry: Entry): void {
    const errors: unknown[] = [];
    for (const handler of entry.errorHandlers ?? []) {
      for (const name of ["error", "unhandledrejection"]) {
        try {
          window.removeEventListener(name, handler);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    throwErrors(errors, "Instrumentation listener cleanup failed");
    if (!entry.transitioning) entry.errorHandlers?.clear();
  }

  function invoke(entry: Entry, active: boolean): void {
    rememberErrors(entry);
    const errors: unknown[] = [];
    const transitioning = entry.transitioning;
    entry.transitioning = true;
    try {
      entry.instrumentation[active ? "enable" : "disable"]();
    } catch (error) {
      errors.push(error);
    } finally {
      entry.transitioning = transitioning;
    }
    rememberErrors(entry);
    if (active && isStopped()) {
      try {
        entry.instrumentation.disable();
      } catch (error) {
        errors.push(error);
      }
    }
    if (!active || isStopped()) {
      try {
        cleanErrors(entry);
      } catch (error) {
        errors.push(error);
      }
    }
    throwErrors(errors, "Instrumentation lifecycle failed");
  }

  function effective(entry: Entry, requested: boolean, policy: Gates): boolean {
    return (
      requested &&
      (entry.kind === "fetch"
        ? tracesEnabled && !policy.disableFetchTracking
        : entry.kind === "xhr"
          ? tracesEnabled && !policy.disableAjaxTracking
          : true)
    );
  }

  function bind(entry: Entry): void {
    check();
    entry.instrumentation.setTracerProvider(providers.tracerProvider);
    check();
    entry.instrumentation.setLoggerProvider?.(providers.loggerProvider);
    check();
  }

  function forget(entry: Entry): void {
    entry.release();
    owned.delete(entry.instrumentation);
  }

  function validateId(id: string): void {
    if (typeof id !== "string" || !id.trim()) {
      throw new TypeError("Instrumentation ID must be a non-empty string.");
    }
  }

  function mutable(entry: Entry): void {
    if (!entry.kind || entry.kind === "web-vitals") {
      throw new Error("Runtime add/remove/replace is unsupported for this instrumentation.");
    }
  }

  function candidate(instrumentation: BrowserInstrumentation, requested: boolean): Entry {
    if (!instrumentation || typeof instrumentation !== "object") {
      throw new TypeError("Instrumentation must be an object.");
    }
    const entry: Entry = {
      instrumentation,
      kind: kind(instrumentation),
      requested,
      active: false,
      release: () => {},
    };
    mutable(entry);
    if ((entry.kind === "fetch" || entry.kind === "xhr") && !tracesEnabled) {
      throw new Error("Runtime network instrumentation requires an enabled trace pipeline.");
    }
    // Reserve ownership before getters, adaptation or provider callbacks can reenter startup.
    const claims = claimInstrumentationOwnership([instrumentation], () => {
      for (const method of ["getConfig", "setTracerProvider", "enable", "disable"] as const) {
        if (typeof instrumentation[method] !== "function") {
          throw new TypeError(`Instrumentation ${method} must be a function.`);
        }
      }
      if (
        instrumentation.getConfig().enabled !== false ||
        metadata(instrumentation, "_isEnabled") ||
        metadata(instrumentation, "_active")
      ) {
        throw new Error("Construct runtime instrumentations with enabled: false.");
      }
      check();
    });
    entry.release = claims.get(instrumentation) ?? entry.release;
    owned.set(instrumentation, entry);
    return entry;
  }

  function change(id: string, instrumentation?: BrowserInstrumentation): void {
    check();
    validateId(id);
    const previous = entries.get(id);
    if (previous) mutable(previous);
    let next: Entry | undefined;
    let touchedPrevious = false;
    try {
      if (instrumentation) {
        next = candidate(instrumentation, previous?.requested ?? true);
        // Shutdown can run inside any callback below. Keep staged ownership until this change settles.
        next.transitioning = true;
        // User-action has no enabled flag and retains its click handler after disable.
        // Normalize it while exclusively owned so a manually enabled candidate cannot bypass a pause.
        if (next.kind === "user-action") invoke(next, false);
        bind(next);
      }
      if (previous) {
        touchedPrevious = true;
        previous.transitioning = true;
        invoke(previous, false);
        check();
      }
      if (next) {
        const active = effective(next, next.requested, gates);
        if (active) invoke(next, true);
        check();
        next.active = active;
        entries.set(id, next);
      } else entries.delete(id);
      if (previous) forget(previous);
    } catch (error) {
      // Validation/ownership rejection must not touch a foreign object or poison this handle.
      if (!next && !touchedPrevious) throw error;
      failed = true;
      const errors = [error];
      if (next) {
        try {
          invoke(next, false);
          forget(next);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      if (touchedPrevious && previous) {
        try {
          invoke(previous, previous.active && !isStopped());
          if (isStopped()) forget(previous);
        } catch (rollbackError) {
          errors.push(rollbackError);
        }
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Instrumentation rollback failed; shutdown is required.", {
          cause: error,
        });
      }
      throw error;
    } finally {
      if (next) next.transitioning = false;
      if (previous) previous.transitioning = false;
    }
  }

  function transition(changes: { entry: Entry; active: boolean }[]): void {
    check();
    const attempted: Entry[] = [];
    try {
      for (const { entry, active } of changes) {
        if (entry.active === active) continue;
        attempted.push(entry);
        entry.transitioning = true;
        invoke(entry, active);
        check();
      }
    } catch (error) {
      // A lifecycle exception may follow partial listener changes or hidden adapter cleanup.
      // Inverse calls are best effort, not proof that the original state was restored.
      failed = true;
      const errors = [error];
      for (const entry of attempted.reverse()) {
        try {
          // A synchronous lifecycle callback may have shut the handle down. Never revive it.
          invoke(entry, entry.active && !isStopped());
          if (isStopped()) forget(entry);
        } catch (rollbackError) {
          errors.push(rollbackError);
        }
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Instrumentation rollback failed; shutdown is required.", {
          cause: error,
        });
      }
      throw error;
    } finally {
      for (const entry of attempted) entry.transitioning = false;
    }
    // Keep committed state unchanged until every lifecycle call succeeds; rollback reads it.
    for (const { entry, active } of changes) {
      entry.active = active;
      if (!active) entry.errorHandlers?.clear();
    }
  }

  return {
    enable(): void {
      // Bind directly to this instance, never to the global routing providers.
      for (const instrumentation of instrumentations) {
        const entry = owned.get(instrumentation);
        if (!entry) throw new Error("Instrumentation registry is unavailable.");
        instrumentation.setTracerProvider(providers.tracerProvider);
        instrumentation.setLoggerProvider?.(providers.loggerProvider);
        const active = tracesEnabled || !isNetworkInstrumentation(instrumentation);
        if (active && !instrumentation.getConfig().enabled) instrumentation.enable();
        // Do not invoke new application getters merely to assign inspection IDs.
        const name = metadata(instrumentation, "instrumentationName");
        const base =
          typeof name === "string"
            ? name.startsWith("@opentelemetry/browser-instrumentation/")
              ? name.slice(name.lastIndexOf("/") + 1)
              : name
            : "instrumentation";
        let id = base;
        let suffix = 2;
        while (entries.has(id)) id = `${base}#${suffix++}`;
        entry.active = active;
        entries.set(id, entry);
      }
    },
    check,
    get: (id: string): BrowserInstrumentation | undefined => entries.get(id)?.instrumentation,
    add(id: string, instrumentation: BrowserInstrumentation): void {
      check();
      validateId(id);
      if (entries.has(id)) throw new Error(`Instrumentation ID already exists: ${id}`);
      if (!instrumentation) throw new TypeError("Instrumentation must be an object.");
      change(id, instrumentation);
    },
    remove(id: string): void {
      check();
      validateId(id);
      if (!entries.has(id)) throw new Error(`Unknown instrumentation: ${id}`);
      change(id);
    },
    replace(id: string, instrumentation: BrowserInstrumentation): void {
      check();
      validateId(id);
      if (!entries.has(id)) throw new Error(`Unknown instrumentation: ${id}`);
      if (!instrumentation) throw new TypeError("Instrumentation must be an object.");
      change(id, instrumentation);
    },
    setEnabled(id: string, enabled: boolean): void {
      check();
      if (typeof id !== "string" || typeof enabled !== "boolean") {
        throw new TypeError("Instrumentation ID must be a string and enabled must be a boolean.");
      }
      const entry = entries.get(id);
      if (!entry) throw new Error(`Unknown instrumentation: ${id}`);
      if (!entry.kind)
        throw new Error(`Runtime lifecycle is unsupported for instrumentation: ${id}`);
      transition([{ entry, active: effective(entry, enabled, gates) }]);
      entry.requested = enabled;
    },
    setNetworkGates(next: Gates): void {
      transition(
        [...entries.values()]
          .filter((entry) => entry.kind === "fetch" || entry.kind === "xhr")
          .map((entry) => ({ entry, active: effective(entry, entry.requested, next) })),
      );
      gates = next;
    },
    // The owning handle coalesces shutdown and invokes this once, even after failed startup.
    shutdown(): void {
      const errors: unknown[] = [];
      for (const entry of [...owned.values()].reverse()) {
        const transitioning = entry.transitioning;
        try {
          invoke(entry, false);
          if (!transitioning) forget(entry);
        } catch (error) {
          errors.push(error);
          // Errors has retained handler references and explicit cleanup. Other upstream modules
          // can hide partial removals behind cleared flags; never infer recovery from a retry.
          if (entry.kind !== "errors") continue;
          try {
            invoke(entry, false);
            if (!transitioning) forget(entry);
          } catch (retryError) {
            if (retryError !== error) errors.push(retryError);
          }
        }
      }
      throwErrors(errors, "Instrumentation cleanup failed");
    },
  };
}
