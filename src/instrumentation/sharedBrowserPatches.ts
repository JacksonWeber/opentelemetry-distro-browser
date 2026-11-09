// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context } from "@opentelemetry/api";
import { conflict, getSharedRegistry, reportError } from "../shared/globalOwnership.js";
import { throwErrors } from "../shared/lifecycle.js";
import type { BrowserInstrumentation } from "../types.js";

type Method = (this: unknown, ...args: unknown[]) => unknown;
type Wrap = <T extends object, K extends keyof T>(
  target: T,
  name: K,
  factory: (original: T[K], name: K) => T[K],
) => unknown;

interface Patchable extends BrowserInstrumentation {
  instrumentationName: string;
  instrumentationVersion: string;
  _isEnabled?: boolean;
  _active?: boolean;
  enabledState?: boolean;
  _isFetchPatched?: boolean;
  _isXhrPatched?: boolean;
  _isHistoryPatched?: boolean;
  historyPatched?: boolean;
  _isPatched?: boolean;
  _xhrSpanMap?: WeakMap<object, { span?: unknown }>;
  _wrap: Wrap;
  _unwrap: <T extends object>(target: T, name: keyof T) => void;
}

interface Subscription {
  invoke: Method;
  next?: Method;
  prepareOpen?: (receiver: object) => () => void;
}

interface Patch {
  original: Method;
  wrapper: Method;
  descriptor?: PropertyDescriptor;
  subscribers: Set<Subscription>;
}

export interface BrowserPatchState {
  targets: WeakMap<object, Map<PropertyKey, Patch>>;
  adapted: WeakMap<BrowserInstrumentation, () => boolean>;
  owners: WeakSet<BrowserInstrumentation>;
  xhrHeaders: WeakMap<object, Set<string>>;
  injecting?: object;
  reporting?: boolean;
}

function state(): BrowserPatchState {
  return (getSharedRegistry().browserPatches ??= {
    targets: new WeakMap(),
    adapted: new WeakMap(),
    owners: new WeakSet(),
    xhrHeaders: new WeakMap(),
  });
}

function report(error: unknown): void {
  const shared = state();
  if (shared.reporting) return;
  shared.reporting = true;
  try {
    reportError("Browser instrumentation subscriber failed", error);
  } finally {
    shared.reporting = false;
  }
}

function notify(
  patch: Patch,
  receiver: unknown,
  args: unknown[],
  next: Method,
  onRejected: (error: unknown) => void = report,
): void {
  const active = context.active();
  for (const subscriber of [...patch.subscribers]) {
    if (!patch.subscribers.has(subscriber)) continue;
    const previous = subscriber.next;
    subscriber.next = next;
    try {
      const result = context.with(active, () => subscriber.invoke.apply(receiver, args));
      // Observe each subscriber's rejection without adding it to another subscriber's chain.
      if (result instanceof Promise) void result.catch(onRejected);
    } catch (error) {
      report(error);
    } finally {
      subscriber.next = previous;
    }
  }
}

function dispatch(
  patch: Patch,
  target: object,
  name: PropertyKey,
  receiver: unknown,
  args: unknown[],
): unknown {
  if (patch.subscribers.size === 0) return patch.original.apply(receiver, args);
  if (target === globalThis && name === "fetch") {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    let requestError: unknown;
    let failed = false;
    const completion = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // Every upstream observer sees the same application context, not another observer's span.
    // Like Application Insights, successive fetch hooks may replace propagated headers.
    notify(
      patch,
      receiver,
      args,
      function (...updated) {
        args.splice(0, args.length, ...updated);
        return completion;
      },
      (error) => {
        if (!failed || error !== requestError) report(error);
      },
    );
    try {
      const result = patch.original.apply(receiver, args);
      void Promise.resolve(result).then(resolve, (error: unknown) => {
        failed = true;
        requestError = error;
        reject(error);
      });
      return completion;
    } catch (error) {
      failed = true;
      requestError = error;
      reject(error);
      throw error;
    }
  }
  const shared = state();
  const isXhr = target === globalThis.XMLHttpRequest?.prototype;
  const isHistory = target === globalThis.history;
  if (isXhr && name === "setRequestHeader") {
    const xhr = receiver as XMLHttpRequest;
    const header = String(args[0]).toLowerCase();
    const headers = shared.xhrHeaders.get(xhr);
    // XHR appends duplicate headers. Keep the first instrumentation value, as Application Insights does.
    if (shared.injecting === xhr && headers?.has(header)) return;
    const result = patch.original.apply(receiver, args);
    headers?.add(header);
    return result;
  }
  if (isHistory) {
    const result = patch.original.apply(receiver, args);
    notify(patch, receiver, args, () => result);
    return result;
  }
  const rollbackOpen =
    isXhr && name === "open"
      ? [...patch.subscribers].flatMap((subscriber) =>
          subscriber.prepareOpen ? [subscriber.prepareOpen(receiver as object)] : [],
        )
      : [];
  const previousHeaders =
    isXhr && name === "open" ? shared.xhrHeaders.get(receiver as object) : undefined;
  if (isXhr && name === "open") shared.xhrHeaders.set(receiver as XMLHttpRequest, new Set());
  const previous = shared.injecting;
  if (isXhr && name === "send") {
    if (!shared.xhrHeaders.has(receiver as XMLHttpRequest))
      return patch.original.apply(receiver, args);
    shared.injecting = receiver as XMLHttpRequest;
  }
  try {
    notify(patch, receiver, args, () => undefined);
  } finally {
    shared.injecting = previous;
  }
  try {
    return patch.original.apply(receiver, args);
  } catch (error) {
    for (const rollback of rollbackOpen) rollback();
    if (rollbackOpen.length) {
      if (previousHeaders) shared.xhrHeaders.set(receiver as object, previousHeaders);
      else shared.xhrHeaders.delete(receiver as object);
    }
    throw error;
  }
}

function subscribe(target: object, name: PropertyKey, subscriber: Subscription): () => void {
  const targets = state().targets;
  let methods = targets.get(target);
  if (!methods) targets.set(target, (methods = new Map<PropertyKey, Patch>()));
  let patch = methods.get(name);
  if (!patch) {
    const original: unknown = Reflect.get(target, name);
    if (typeof original !== "function") {
      conflict("browser-patch-unavailable", `Cannot instrument ${String(name)}`);
    }
    const created: Patch = {
      original: original as Method,
      descriptor: Object.getOwnPropertyDescriptor(target, name),
      subscribers: new Set(),
      wrapper: function (...args) {
        return dispatch(created, target, name, this, args);
      },
    };
    if (target === globalThis.console) {
      // Standalone wrappers can retain this shared wrapper after its registration is removed.
      Object.defineProperty(created.wrapper, "__original", { get: () => created.original });
    }
    if (
      !Reflect.set(target, name, created.wrapper) ||
      Reflect.get(target, name) !== created.wrapper
    ) {
      conflict("browser-patch-unavailable", `Cannot patch ${String(name)}`);
    }
    methods.set(name, (patch = created));
  }
  patch.subscribers.add(subscriber);
  return () => {
    // A failed restoration can be retried after another owner installed a newer patch.
    // The stale subscription must never delete that newer patch's registry entry.
    if (methods.get(name) !== patch) return;
    patch.subscribers.delete(subscriber);
    if (patch.subscribers.size) return;
    if (target === globalThis.XMLHttpRequest?.prototype && name === "setRequestHeader") {
      // Requests opened before this tracking gap cannot safely inject headers after restart.
      state().xhrHeaders = new WeakMap();
    }
    if (Reflect.get(target, name) !== patch.wrapper) {
      methods.delete(name);
      return;
    }
    const restored = patch.descriptor
      ? Reflect.defineProperty(target, name, patch.descriptor)
      : Reflect.deleteProperty(target, name);
    if (!restored) conflict("browser-patch-cleanup", `Cannot restore ${String(name)}`);
    methods.delete(name);
  };
}

function isPatchable(value: BrowserInstrumentation): value is Patchable {
  return (
    "instrumentationName" in value &&
    typeof value.instrumentationName === "string" &&
    (value.instrumentationName === "@microsoft/opentelemetry-browser/page-view" ||
      /^@opentelemetry\/browser-instrumentation\/(fetch|xhr|console|navigation)$/.test(
        value.instrumentationName,
      ))
  );
}

/**
 * Bridges the pinned upstream InstrumentationBase wrapping seam, leaving telemetry collection,
 * configuration and provider binding on each supplied instrumentation. No upstream runtime import
 * is needed, so optional instrumentations remain outside the root bundle.
 */
function adapt(instrumentation: Patchable): void {
  const adapted = state().adapted.get(instrumentation);
  if (
    !adapted &&
    ((instrumentation.instrumentationName.startsWith("@opentelemetry/") &&
      instrumentation.instrumentationVersion !== "0.8.1") ||
      typeof instrumentation._wrap !== "function" ||
      typeof instrumentation._unwrap !== "function")
  ) {
    conflict("browser-instrumentation-version", "Unsupported browser instrumentation");
  }
  if (
    instrumentation.getConfig().enabled ||
    instrumentation._isEnabled ||
    instrumentation._active ||
    instrumentation.enabledState ||
    (adapted
      ? adapted()
      : instrumentation._isFetchPatched ||
        instrumentation._isXhrPatched ||
        instrumentation._isHistoryPatched ||
        instrumentation._isPatched ||
        instrumentation.historyPatched)
  ) {
    conflict(
      "browser-instrumentation-active",
      "Construct shared instrumentations with enabled: false",
    );
  }
  if (adapted) return;
  const entries: {
    target: object;
    name: PropertyKey;
    subscriber: Subscription;
    remove?: () => void;
  }[] = [];
  const enable = instrumentation.enable.bind(instrumentation);
  const disable = instrumentation.disable.bind(instrumentation);
  // Only collect sends whose open was observed by this subscriber since its last pause.
  // Keep upstream in-flight records intact so requests already sent can still complete.
  let xhrOpens = new WeakMap<object, Set<string> | undefined>();
  const failure: { error?: Error } = {};
  instrumentation._wrap = (target, name, factory) => {
    try {
      const existing = entries.find((entry) => entry.target === target && entry.name === name);
      if (existing) {
        existing.remove ??= subscribe(target, name, existing.subscriber);
        return;
      }
      const subscriber: Subscription = { invoke: () => undefined };
      if (instrumentation.instrumentationName.endsWith("/xhr") && name === "open") {
        subscriber.prepareOpen = (receiver) => {
          const record = instrumentation._xhrSpanMap?.get(receiver);
          const token = xhrOpens.get(receiver);
          const observed = xhrOpens.has(receiver);
          return () => {
            if (record) instrumentation._xhrSpanMap?.set(receiver, record);
            else instrumentation._xhrSpanMap?.delete(receiver);
            if (observed) xhrOpens.set(receiver, token);
            else xhrOpens.delete(receiver);
          };
        };
      }
      const next: Method = function (...args) {
        return subscriber.next?.apply(this, args);
      };
      // This is the same method-to-method boundary as upstream's generic wrapping API.
      const wrapped = factory(next as (typeof target)[typeof name], name);
      if (typeof wrapped !== "function") {
        conflict("browser-instrumentation-wrapper", "Instrumentation wrapper must be a function");
      }
      subscriber.invoke = instrumentation.instrumentationName.endsWith("/xhr")
        ? function (...args) {
            if (name === "open") {
              // Ignored opens do not replace upstream's previous unsent record.
              if (!instrumentation._xhrSpanMap?.get(this as object)?.span)
                instrumentation._xhrSpanMap?.delete(this as object);
              xhrOpens.set(this as object, state().xhrHeaders.get(this as object));
            }
            if (
              name === "send" &&
              (!xhrOpens.has(this as object) ||
                xhrOpens.get(this as object) !== state().xhrHeaders.get(this as object))
            )
              return;
            return (wrapped as Method).apply(this, args);
          }
        : (wrapped as Method);
      const entry = { target, name, subscriber, remove: subscribe(target, name, subscriber) };
      entries.push(entry);
    } catch (error) {
      failure.error =
        error instanceof Error ? error : new Error("Browser patch failed", { cause: error });
      throw error;
    }
  };
  instrumentation._unwrap = (target, name) => {
    const entry = entries.find((entry) => entry.target === target && entry.name === name);
    entry?.remove?.();
    if (entry) entry.remove = undefined;
  };
  const detach = (): void => {
    const errors: unknown[] = [];
    for (const entry of entries) {
      try {
        entry.remove?.();
        entry.remove = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Browser patch cleanup failed");
  };
  instrumentation.enable = () => {
    try {
      if (instrumentation.instrumentationName.endsWith("/xhr")) {
        instrumentation._wrap(XMLHttpRequest.prototype, "setRequestHeader", (original) => original);
      }
      enable();
      if (failure.error) throw failure.error;
      for (const entry of entries)
        entry.remove ??= subscribe(entry.target, entry.name, entry.subscriber);
    } catch (error) {
      failure.error = undefined;
      if (instrumentation._isPatched) instrumentation._isPatched = false;
      try {
        instrumentation.disable();
      } catch (cleanupError) {
        reportError("Browser patch rollback failed", cleanupError);
      }
      throw error;
    }
  };
  instrumentation.disable = () => {
    xhrOpens = new WeakMap();
    try {
      disable();
    } finally {
      detach();
    }
  };
  state().adapted.set(instrumentation, () => entries.some((entry) => entry.remove));
}

/** A disabled trace pipeline must not claim outgoing headers through a no-op tracer. */
export function isNetworkInstrumentation(instrumentation: BrowserInstrumentation): boolean {
  return isPatchable(instrumentation) && /\/(fetch|xhr)$/.test(instrumentation.instrumentationName);
}

/** Reserves every object before callbacks; each returned release only relinquishes its own claim. */
export function claimInstrumentationOwnership(
  instrumentations: readonly BrowserInstrumentation[],
  validate?: () => void,
) {
  const owners = state().owners;
  if (
    instrumentations.some(
      (item) => !item || (typeof item !== "object" && typeof item !== "function"),
    )
  ) {
    throw new TypeError("Instrumentation must be an object.");
  }
  const unique = new Set(instrumentations);
  if (
    unique.size !== instrumentations.length ||
    instrumentations.some((item) => owners.has(item))
  ) {
    conflict(
      "browser-instrumentation-owned",
      "Do not share instrumentation objects between instances",
    );
  }
  for (const instrumentation of instrumentations) owners.add(instrumentation);
  const claims = new Map(
    instrumentations.map((instrumentation) => {
      let held = true;
      return [
        instrumentation,
        () => {
          if (!held) return;
          held = false;
          owners.delete(instrumentation);
        },
      ] as const;
    }),
  );
  try {
    validate?.();
    for (const instrumentation of instrumentations) {
      if (isPatchable(instrumentation)) adapt(instrumentation);
    }
  } catch (error) {
    for (const release of claims.values()) release();
    throw error;
  }
  return claims;
}

/** Claims all inputs before binding any provider, including rollback of not-yet-enabled inputs. */
export function claimInstrumentations(
  instrumentations: readonly BrowserInstrumentation[],
): () => void {
  const claims = claimInstrumentationOwnership(instrumentations);
  return () => {
    const errors: unknown[] = [];
    for (const [instrumentation, release] of [...claims].reverse()) {
      try {
        instrumentation.disable();
        release();
        claims.delete(instrumentation);
      } catch (error) {
        errors.push(error);
      }
    }
    throwErrors(errors, "Instrumentation cleanup failed");
  };
}
