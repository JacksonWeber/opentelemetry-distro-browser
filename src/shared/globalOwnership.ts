// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, type SpanContext } from "@opentelemetry/api";
import type { RouterState } from "../routing/instanceRouter.js";
import type { PageContextState } from "../routing/pageContext.js";
import type { BrowserPatchState } from "../instrumentation/sharedBrowserPatches.js";

const distroKey = /* @__PURE__ */ Symbol.for("@microsoft/opentelemetry-browser");
const apiKey = /* @__PURE__ */ Symbol.for("opentelemetry.js.api.1");
const logsKey = /* @__PURE__ */ Symbol.for("io.opentelemetry.js.api.logs");
const ingestionUrlsKey = /* @__PURE__ */ Symbol.for(
  "@microsoft/opentelemetry-browser/sdk-ingestion-urls/1",
);
const activeIngestionUrlsKey = /* @__PURE__ */ Symbol.for(
  "@microsoft/opentelemetry-browser/active-sdk-ingestion-urls/1",
);
const keepaliveKey = /* @__PURE__ */ Symbol.for("@microsoft/opentelemetry-browser/keepalive/1");
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };

interface SharedRegistry {
  version: 1;
  diagInitialized?: boolean;
  reportingSdkStats?: boolean;
  pageContexts?: WeakSet<SpanContext>;
  operationNames?: WeakMap<object, string>;
  router?: RouterState;
  page?: PageContextState;
  unloadSubscribers?: Set<() => void>;
  removeUnloadListeners?: () => void;
  browserPatches?: BrowserPatchState;
  pageVisitSlots?: Map<string, Set<number>>;
  pending?: { signal: "trace" | "logs"; rollback: () => void }[];
}

/** Application reservations in slot 0. Slot 1 remains available to older SDK copies. */
export function getKeepaliveReservations(): [number, number][] {
  return (realm[keepaliveKey] ??= [
    [0, 0],
    [0, 0],
  ]) as [number, number][];
}

/** Keep the last 256 exact destinations for delayed resource timings, independently of distro state. */
export function rememberSdkIngestionUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.hash = "";
  const urls = (realm[ingestionUrlsKey] ??= new Set<string>()) as Set<string>;
  urls.delete(url.href);
  urls.add(url.href);
  if (urls.size > 256) {
    for (const oldest of urls) {
      urls.delete(oldest);
      break;
    }
  }
  return url.href;
}

/** Active senders keep their destinations protected until their owner releases them. */
export function registerSdkIngestionUrl(endpoint: string): () => void {
  const url = rememberSdkIngestionUrl(endpoint);
  const active = (realm[activeIngestionUrlsKey] ??= new Map<string, number>()) as Map<
    string,
    number
  >;
  active.set(url, (active.get(url) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (active.get(url) ?? 1) - 1;
    if (remaining) active.set(url, remaining);
    else active.delete(url);
    rememberSdkIngestionUrl(url);
  };
}

export function isSdkIngestionUrl(url: string): boolean {
  return (
    (realm[activeIngestionUrlsKey] as Map<string, number> | undefined)?.has(url) === true ||
    (realm[ingestionUrlsKey] as Set<string> | undefined)?.has(url) === true
  );
}

/** Exporter-only consumers may read page membership without initializing a distribution. */
export function getPageContexts(): WeakSet<SpanContext> | undefined {
  const registry = realm[distroKey] as SharedRegistry | undefined;
  return registry?.version === 1 ? registry.pageContexts : undefined;
}

/** Prevents diagnostic feedback into telemetry. */
export function isReportingSdkStats(): boolean {
  const registry = realm[distroKey] as SharedRegistry | undefined;
  return registry?.version === 1 && registry.reportingSdkStats === true;
}

export function reportWithoutTelemetry(report: () => void): void {
  const existing = realm[distroKey] as SharedRegistry | undefined;
  const registry = existing?.version === 1 ? existing : undefined;
  const previous = registry?.reportingSdkStats;
  if (registry) registry.reportingSdkStats = true;
  const restore: (() => void)[] = [];
  try {
    // Standalone providers do not consult our emission guard. Bypass OpenTelemetry's
    // console wrappers while reporting, even without a registered context manager.
    if (typeof console !== "undefined") {
      type ConsoleMethod = typeof console.warn & { __original?: ConsoleMethod };
      /* eslint-disable no-console, @typescript-eslint/unbound-method -- Preserve and restore console wrapper identities without invoking them. */
      for (const name of ["debug", "info", "log", "warn", "error"] as const) {
        const wrapped = console[name];
        const patch = registry?.browserPatches?.targets.get(console)?.get(name);
        let original: ConsoleMethod = wrapped;
        while (true) {
          if (patch && original === patch.wrapper) original = patch.original;
          else if (typeof original.__original === "function") original = original.__original;
          else break;
        }
        if (original === wrapped) continue;
        const descriptor =
          patch && wrapped === patch.wrapper
            ? patch.descriptor
            : Object.getOwnPropertyDescriptor(console, name);
        console[name] = original;
        restore.push(() => {
          const current = registry?.browserPatches?.targets.get(console)?.get(name);
          const restored =
            patch && wrapped === patch.wrapper && current !== patch ? patch.original : wrapped;
          // A restart must not retain the temporarily unwrapped method for calls or teardown.
          if (current && current !== patch && current.original === original) {
            current.original = restored;
            current.descriptor = descriptor;
          }
          if (console[name] === original) console[name] = restored;
        });
      }
      /* eslint-enable no-console, @typescript-eslint/unbound-method */
    }
    report();
  } finally {
    for (const undo of restore) undo();
    if (registry) registry.reportingSdkStats = previous;
  }
}

/** Exporter-only consumers may read operation names without initializing a distribution. */
export function getOperationName(record: object): string | undefined {
  const registry = realm[distroKey] as SharedRegistry | undefined;
  return registry?.version === 1 ? registry.operationNames?.get(record) : undefined;
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
