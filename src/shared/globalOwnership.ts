// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, type SpanContext } from "@opentelemetry/api";
import type { RouterState } from "../routing/instanceRouter.js";
import type { PageContextState } from "../routing/pageContext.js";

const distroKey = /* @__PURE__ */ Symbol.for("@microsoft/opentelemetry-browser");
const apiKey = /* @__PURE__ */ Symbol.for("opentelemetry.js.api.1");
const logsKey = /* @__PURE__ */ Symbol.for("io.opentelemetry.js.api.logs");
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };

interface SharedRegistry {
  version: 1;
  diagInitialized?: boolean;
  pageContexts?: WeakSet<SpanContext>;
  router?: RouterState;
  page?: PageContextState;
  pending?: { signal: "trace" | "logs"; rollback: () => void }[];
}

/** Exporter-only consumers may read page membership without initializing a distribution. */
export function getPageContexts(): WeakSet<SpanContext> | undefined {
  const registry = realm[distroKey] as SharedRegistry | undefined;
  return registry?.version === 1 ? registry.pageContexts : undefined;
}

/** One versioned, realm-local registry shared by separately bundled distribution copies. */
export function getSharedRegistry(): SharedRegistry {
  const existing = realm[distroKey];
  if (existing !== undefined) {
    if (
      typeof existing !== "object" ||
      existing === null ||
      !("version" in existing) ||
      existing.version !== 1
    ) {
      conflict("distribution-version-conflict", "Incompatible browser distribution registry");
    }
    return existing as SharedRegistry;
  }
  const registry: SharedRegistry = { version: 1 };
  realm[distroKey] = registry;
  return registry;
}

/** Reads raw identities because API getters can hide incompatible registrations. */
export function getRegisteredGlobal(name: "trace" | "context" | "propagation" | "logs"): unknown {
  if (name === "logs") return realm[logsKey];
  const registry = realm[apiKey];
  return typeof registry === "object" && registry !== null
    ? Reflect.get(registry, name)
    : undefined;
}

export function conflict(code: string, detail: string): never {
  const message = `[${code}] ${detail}.`;
  reportError(message);
  throw Object.assign(new Error(message), { code });
}

export function reportError(...args: Parameters<typeof diag.error>): void {
  try {
    diag.error(...args);
  } catch {
    // A diagnostic logger must not interrupt cleanup or replace the startup error.
  }
}

/** Pending registrations can be adopted by another instance before startup settles. */
export function deferGlobalRollback(signal: "trace" | "logs", rollback: () => void): void {
  (getSharedRegistry().pending ??= []).push({ signal, rollback });
}

export function commitGlobals(traces: boolean, logs: boolean): void {
  const registry = getSharedRegistry();
  registry.pending = registry.pending?.filter(
    (entry) => !(entry.signal === "trace" ? traces : logs),
  );
}

export function rollbackGlobals(): void {
  const registry = getSharedRegistry();
  const pending = registry.pending ?? [];
  registry.pending = [];
  for (const entry of pending) {
    const provider = entry.signal === "trace" ? "tracerProvider" : "loggerProvider";
    if (registry.router?.running.some((instance) => instance[provider])) {
      registry.pending.push(entry);
      continue;
    }
    try {
      entry.rollback();
    } catch (error) {
      reportError("Telemetry global rollback failed", error);
    }
  }
}
