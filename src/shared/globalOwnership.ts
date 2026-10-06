// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace, type ContextManager } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const initializationKey = Symbol.for("@microsoft/opentelemetry-browser.initializing");
const apiKey = Symbol.for("opentelemetry.js.api.1");
const logsKey = Symbol.for("io.opentelemetry.js.api.logs");
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };

function conflict(code: string, detail: string): never {
  const message = `[${code}] ${detail}. Initialize OpenTelemetry once per JavaScript realm.`;
  diag.error(message);
  throw Object.assign(new Error(message), { code });
}

/**
 * Read-only inspection is necessary because the public APIs hide incompatible registrations
 * behind no-op providers and expose no context-manager or propagator ownership query.
 * Version compatibility is decided by the loaded API during registration, not by this guard.
 */
export function assertGlobalsAvailable(tracesEnabled = true): void {
  const registry = realm[apiKey];
  if (registry !== undefined) {
    if (
      typeof registry !== "object" ||
      registry === null ||
      !("version" in registry) ||
      typeof registry.version !== "string"
    ) {
      conflict("api-version-conflict", "Invalid OpenTelemetry API registry");
    }
    if ("trace" in registry && registry.trace) {
      conflict("tracer-provider-conflict", "A tracer provider is already registered");
    }
    if (tracesEnabled && "context" in registry && registry.context) {
      conflict("context-manager-conflict", "A context manager is already registered");
    }
    if (tracesEnabled && "propagation" in registry && registry.propagation) {
      conflict("propagator-conflict", "A propagator is already registered");
    }
  }
  if (realm[logsKey] !== undefined) {
    conflict("logger-provider-conflict", "A logger provider is already registered");
  }
}

function getGlobal(name: string): unknown {
  const registry = realm[apiKey];
  return typeof registry === "object" && registry !== null
    ? Reflect.get(registry, name)
    : undefined;
}

interface GlobalRegistrations {
  trace: unknown;
  logs: unknown;
  context: unknown;
  propagation: unknown;
}

/**
 * Captures SDK registrations before the context manager's application callback can replace them.
 * Unconfigured managers use the SDK default, which has no application callback.
 */
export function trackGlobals(
  tracesEnabled: boolean,
  logsEnabled: boolean,
  manager?: ContextManager,
  applicationManager?: ContextManager,
) {
  let expected: GlobalRegistrations | undefined;
  let enableCalled = false;
  let enableFailed = false;
  let enableError: unknown;
  const managedContext: ContextManager | undefined =
    tracesEnabled && manager
      ? {
          active: () => manager.active(),
          with: (ctx, fn, thisArg, ...args) => manager.with(ctx, fn, thisArg, ...args),
          bind: (ctx, target) => manager.bind(ctx, target),
          enable() {
            capture();
            enableCalled = true;
            try {
              manager.enable();
            } catch (error) {
              // Defer the failure until the SDK returns its pipeline shutdown handle.
              enableFailed = true;
              enableError = error;
            }
            return this;
          },
          disable() {
            manager.disable();
            return this;
          },
        }
      : undefined;

  function capture(): GlobalRegistrations {
    return (expected = {
      trace: tracesEnabled ? getGlobal("trace") : undefined,
      logs: logsEnabled ? realm[logsKey] : undefined,
      context: tracesEnabled ? (managedContext ?? getGlobal("context")) : undefined,
      propagation: tracesEnabled ? getGlobal("propagation") : undefined,
    });
  }

  return {
    contextManager: managedContext ?? manager,
    assert(): void {
      const owned = expected ?? capture();
      if (enableFailed) throw enableError;
      if (tracesEnabled && !owned.trace) {
        conflict("api-version-conflict", "OpenTelemetry trace registration failed");
      }
      if (getGlobal("trace") !== owned.trace) {
        conflict("tracer-provider-conflict", "The tracer provider changed during startup");
      }
      if (realm[logsKey] !== owned.logs || (logsEnabled && !owned.logs)) {
        conflict(
          "logger-provider-conflict",
          "Logger registration failed or changed during startup",
        );
      }
      if (tracesEnabled && (!owned.context || getGlobal("context") !== owned.context)) {
        conflict("context-manager-conflict", "Context manager registration failed");
      }
      if (tracesEnabled && (!owned.propagation || getGlobal("propagation") !== owned.propagation)) {
        conflict("propagator-conflict", "Propagator registration failed or changed during startup");
      }
    },
    rollback(): void {
      if (!expected) return;
      const errors: unknown[] = [];
      const attempt = (dispose: () => void): void => {
        try {
          dispose();
        } catch (error) {
          errors.push(error);
        }
      };
      const activeManager = getGlobal("context");
      if (expected.context && activeManager === expected.context) {
        attempt(() => context.disable());
      } else if (enableCalled && (!applicationManager || activeManager !== applicationManager)) {
        attempt(() => manager?.disable());
      }
      if (expected.propagation && getGlobal("propagation") === expected.propagation) {
        attempt(() => propagation.disable());
      }
      if (expected.trace && getGlobal("trace") === expected.trace) {
        attempt(() => trace.disable());
      }
      if (expected.logs && realm[logsKey] === expected.logs) {
        attempt(() => logs.disable());
      }
      if (errors.length) throw new AggregateError(errors, "Telemetry global rollback failed");
    },
  };
}

/** The browser SDK ignores registration failure, so verify it before binding instrumentations. */
export function assertGlobalsRegistered(registration: ReturnType<typeof trackGlobals>): void {
  registration.assert();
}

/** Reserves startup across independently bundled copies without retaining pipeline state. */
export function reserveGlobals(tracesEnabled: boolean): () => void {
  if (realm[initializationKey] !== undefined) {
    conflict("initialization-in-progress", "Another distribution is initializing");
  }
  assertGlobalsAvailable(tracesEnabled);
  const reservation = {};
  realm[initializationKey] = reservation;
  return () => {
    if (realm[initializationKey] === reservation) delete realm[initializationKey];
  };
}
