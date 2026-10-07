// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  propagation,
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
  type SpanContext,
  type TextMapPropagator,
} from "@opentelemetry/api";
import { withoutPageOperation } from "../instrumentation/pageView/pageViewCorrelation.js";

/** Page correlation contributed by one instance with page views. */
export interface PageCorrelation {
  decorate(active: Context): Context;
  operation(): SpanContext | undefined;
}

// Instances with page views in initialization order; the first supplies the page operation.
const owners: PageCorrelation[] = [];
let storage: ContextManager | undefined;
// Attempted once per page; the API reports a conflicting registration.
let propagatorAttempted = false;
// Cached because active() is on the hot path; updated whenever owners change.
let correlation: PageCorrelation | undefined;

/**
 * The page-lifetime context manager. The OpenTelemetry API allows only one registration, so
 * context storage is shared for the page, while the page operation comes from the earliest
 * running instance with page views and passes on when that instance shuts down. Contexts bound before a
 * handoff therefore stay valid.
 */
const pageContextManager: ContextManager = {
  active() {
    const active = storage?.active() ?? ROOT_CONTEXT;
    return correlation ? correlation.decorate(active) : withoutPageOperation(active);
  },
  with: (ctx, fn, thisArg, ...args) =>
    storage ? storage.with(ctx, fn, thisArg, ...args) : fn.apply(thisArg, args),
  bind: (ctx, target) => (storage ? storage.bind(ctx, target) : target),
  enable() {
    return this;
  },
  // Called when the global context API is disabled, which unregisters this manager.
  disable() {
    storage?.disable();
    storage = undefined;
    propagatorAttempted = false;
    return this;
  },
};

/**
 * Registers the page context manager and propagator for the first tracing instance, which then
 * serve the page for its lifetime. Never replaces registrations by another SDK; the API reports
 * conflicts.
 *
 * @param supplied - Caller-owned manager. It may already be the global one, so a registration
 * conflict leaves it enabled; only the default manager is disabled.
 */
export function registerPageContext(
  supplied: ContextManager | undefined,
  createDefault: () => ContextManager,
  createPropagator: () => TextMapPropagator,
): void {
  // Built before any registration, so a construction failure leaves nothing for a retry to skip.
  const propagator = propagatorAttempted ? undefined : createPropagator();
  if (!storage) {
    const manager = (supplied ?? createDefault()).enable();
    storage = manager;
    if (!context.setGlobalContextManager(pageContextManager)) {
      storage = undefined;
      if (!supplied) manager.disable();
    }
  }
  // Registered independently, so an application context manager does not cost trace headers.
  if (propagator) {
    propagatorAttempted = true;
    propagation.setGlobalPropagator(propagator);
  }
}

/**
 * Adds an instance's page correlation, whether or not it collects traces, so every instance with
 * page views shares the page operation.
 *
 * @returns Removes the correlation, passing the page operation to the next instance.
 */
export function addPageCorrelation(owner: PageCorrelation): () => void {
  owners.push(owner);
  correlation = owners[0];
  return () => {
    const index = owners.indexOf(owner);
    if (index >= 0) owners.splice(index, 1);
    correlation = owners[0];
  };
}

/**
 * The page operation supplied by another instance, which later instances adopt so their page
 * views match the correlation on their spans and logs.
 */
export function getPageOperation(self: PageCorrelation | undefined): SpanContext | undefined {
  return correlation === self ? undefined : correlation?.operation();
}

/** Whether a distribution instance has registered the page context and propagation. */
export function isPageContextRegistered(): boolean {
  return storage !== undefined;
}
