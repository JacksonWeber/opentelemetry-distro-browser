// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SpanContext } from "@opentelemetry/api";
import { getPageContexts, getSharedRegistry } from "./globalOwnership.js";

/**
 * Contexts used only for page correlation, not application spans.
 * Weak membership follows buffered telemetry without retaining completed page operations.
 */
export function markPageContext(context: SpanContext): void {
  const registry = getSharedRegistry();
  (registry.pageContexts ??= new WeakSet<SpanContext>()).add(context);
}

/** Recognizes contexts from any compatible distribution copy without retaining them. */
export function isPageContext(context: SpanContext): boolean {
  return getPageContexts()?.has(context) ?? false;
}
