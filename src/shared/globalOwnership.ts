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

/**
 * Public API getters hide incompatible registrations behind no-op providers.
 * Inspect registry identities without invoking foreign code or importing dependency internals.
 */
export function getRegisteredGlobal(name: "trace" | "context" | "propagation" | "logs"): unknown {
  if (name === "logs") return realm[logsKey];
  const registry = realm[apiKey];
  return typeof registry === "object" && registry !== null
    ? Reflect.get(registry, name)
    : undefined;
}

export function conflict(code: string, detail: string): never {
  const message = `[${code}] ${detail}.`;
  diag.error(message);
  throw Object.assign(new Error(message), { code });
}
