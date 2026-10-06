// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
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

/** The browser SDK ignores registration failure, so verify it before binding instrumentations. */
export function assertGlobalsRegistered(tracesEnabled: boolean, logsEnabled: boolean): void {
  const registry = realm[apiKey];
  if (
    tracesEnabled &&
    !(typeof registry === "object" && registry !== null && "trace" in registry && registry.trace)
  ) {
    // Startup is synchronous after preflight. Only the logs registration can have succeeded
    // when the loaded trace API rejects the registry version. Remove it before yielding.
    if (logsEnabled) logs.disable();
    conflict("api-version-conflict", "OpenTelemetry trace registration failed");
  }
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
