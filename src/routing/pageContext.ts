// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  diag,
  propagation,
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
  type SpanContext,
  type TextMapPropagator,
} from "@opentelemetry/api";
import { withoutPageOperation } from "../instrumentation/pageView/pageViewCorrelation.js";
import {
  conflict,
  getRegisteredGlobal,
  getSharedRegistry,
  reportError,
} from "../shared/globalOwnership.js";

/** Page correlation contributed by one instance with page views. */
export interface PageCorrelation {
  decorate(active: Context): Context;
  operation(): SpanContext | undefined;
}

export interface PageContextState {
  owners: PageCorrelation[];
  storage?: ContextManager;
  correlation?: PageCorrelation;
  manager: ContextManager;
  registering: boolean;
  foreignContext?: unknown;
  foreignPropagator?: unknown;
  propagator?: TextMapPropagator;
}

function getPageContext(): PageContextState {
  const registry = getSharedRegistry();
  if (registry.page) return registry.page;
  const state: PageContextState = {
    owners: [],
    registering: false,
    manager: {
      active() {
        const active = state.storage?.active() ?? ROOT_CONTEXT;
        return state.correlation
          ? state.correlation.decorate(active)
          : withoutPageOperation(active);
      },
      with: (ctx, fn, thisArg, ...args) =>
        state.storage ? state.storage.with(ctx, fn, thisArg, ...args) : fn.apply(thisArg, args),
      bind: (ctx, target) => (state.storage ? state.storage.bind(ctx, target) : target),
      enable() {
        return this;
      },
      disable() {
        const storage = state.storage;
        state.storage = undefined;
        storage?.disable();
        return this;
      },
    },
  };
  registry.page = state;
  return state;
}

/**
 * Registers page context without replacing foreign globals. Rejects re-entrant changes.
 * Returns a rollback callback for this attempt's registrations only.
 */
export function registerPageContext(
  supplied: ContextManager | undefined,
  createDefault: () => ContextManager,
  createPropagator: () => TextMapPropagator,
): () => void {
  const state = getPageContext();
  if (state.registering)
    conflict("initialization-in-progress", "Page context registration is already in progress");
  state.registering = true;
  const before = {
    context: getRegisteredGlobal("context"),
    propagation: getRegisteredGlobal("propagation"),
    trace: getRegisteredGlobal("trace"),
    logs: getRegisteredGlobal("logs"),
  };
  let manager: ContextManager | undefined;
  let propagator: TextMapPropagator | undefined;
  let enabled = false;
  let registeredContext = false;
  let registeredPropagation = false;

  const rollback = (): void => {
    if (registeredPropagation && getRegisteredGlobal("propagation") === propagator) {
      propagation.disable();
      state.propagator = undefined;
    }
    if (registeredContext && getRegisteredGlobal("context") === state.manager) {
      context.disable();
    } else if (enabled && manager && getRegisteredGlobal("context") !== manager) {
      if (state.storage === manager) state.storage = undefined;
      manager.disable();
    }
  };
  const verifyUnchanged = (): void => {
    for (const [key, code] of [
      ["context", "context-manager-conflict"],
      ["propagation", "propagator-conflict"],
      ["trace", "tracer-provider-conflict"],
      ["logs", "logger-provider-conflict"],
    ] as const) {
      if (getRegisteredGlobal(key) !== before[key])
        conflict(code, "OpenTelemetry globals changed during startup");
    }
  };
  try {
    propagator = before.propagation ? undefined : createPropagator();
    verifyUnchanged();
    if (!before.context) {
      manager = supplied ?? createDefault();
      enabled = true;
      manager.enable();
      verifyUnchanged();
      state.storage = manager;
      if (!context.setGlobalContextManager(state.manager)) {
        conflict("context-manager-conflict", "OpenTelemetry context registration failed");
      }
      registeredContext = true;
    } else if (before.context !== state.manager && before.context !== state.foreignContext) {
      state.foreignContext = before.context;
      diag.warn("[context-manager-conflict] Using the application's global context manager.");
    }
    if (propagator) {
      if (!propagation.setGlobalPropagator(propagator)) {
        conflict("propagator-conflict", "OpenTelemetry propagation registration failed");
      }
      state.propagator = propagator;
      registeredPropagation = true;
    } else if (
      before.propagation !== state.propagator &&
      before.propagation !== state.foreignPropagator
    ) {
      state.foreignPropagator = before.propagation;
      diag.warn("[propagator-conflict] Using the application's global propagator.");
    }
    if (getRegisteredGlobal("context") !== (registeredContext ? state.manager : before.context)) {
      conflict("context-manager-conflict", "OpenTelemetry context changed during registration");
    }
    if (
      getRegisteredGlobal("propagation") !==
      (registeredPropagation ? propagator : before.propagation)
    ) {
      conflict("propagator-conflict", "OpenTelemetry propagation changed during registration");
    }
    if (getRegisteredGlobal("trace") !== before.trace) {
      conflict("tracer-provider-conflict", "OpenTelemetry traces changed during registration");
    }
    if (getRegisteredGlobal("logs") !== before.logs) {
      conflict("logger-provider-conflict", "OpenTelemetry logs changed during registration");
    }
    return rollback;
  } catch (error) {
    try {
      rollback();
    } catch (cleanupError) {
      reportError("Page context rollback failed", cleanupError);
    }
    throw error;
  } finally {
    state.registering = false;
  }
}

/** Adds page correlation and returns a removal callback that hands off to the next owner. */
export function addPageCorrelation(owner: PageCorrelation): () => void {
  const state = getPageContext();
  state.owners.push(owner);
  state.correlation = state.owners[0];
  return () => {
    const index = state.owners.indexOf(owner);
    if (index >= 0) state.owners.splice(index, 1);
    state.correlation = state.owners[0];
  };
}

/** Returns another instance's page operation, if any. */
export function getPageOperation(self: PageCorrelation | undefined): SpanContext | undefined {
  const { correlation } = getPageContext();
  return correlation === self ? undefined : correlation?.operation();
}

/** Whether a distribution instance has registered the page context and propagation. */
export function isPageContextRegistered(): boolean {
  const state = getPageContext();
  return state.storage !== undefined && getRegisteredGlobal("context") === state.manager;
}
