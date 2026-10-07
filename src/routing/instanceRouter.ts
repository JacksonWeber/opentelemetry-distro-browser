// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  createContextKey,
  diag,
  ProxyTracerProvider,
  trace,
  type TracerProvider,
} from "@opentelemetry/api";
import { createNoopLogger, logs, type LoggerProvider } from "@opentelemetry/api-logs";

/**
 * The isolated pipelines owned by one distribution instance. A signal the instance does not
 * collect is left undefined, so it is never served by another instance's pipeline.
 */
export interface InstancePipelines {
  readonly tracerProvider?: TracerProvider;
  readonly loggerProvider?: LoggerProvider;
}

// Running instances in initialization order; per signal, the first that collects it is the default.
const running: InstancePipelines[] = [];
const SELECTED_INSTANCE = createContextKey("@microsoft/opentelemetry-browser instance");
// Signals already reported as dropped; cleared when an instance starts.
const reportedDrops = new Set<keyof InstancePipelines>();
// Providers registered by another SDK that the routers already deferred to.
let foreignTracerProvider: unknown;
let foreignLoggerProvider: unknown;

/** Hands out no-op tracers: a proxy without a delegate never records. */
export const noopTracerProvider: TracerProvider = /* @__PURE__ */ new ProxyTracerProvider();
/** Hands out no-op loggers. */
export const noopLoggerProvider: LoggerProvider = { getLogger: () => createNoopLogger() };

/**
 * Resolves the provider for one signal: the selected instance's own provider, or by default the
 * first running instance that collects the signal. A selected instance that does not collect it
 * gets none, never another instance's.
 */
function selectProvider<K extends keyof InstancePipelines>(
  signal: K,
): InstancePipelines[K] | undefined {
  const selected = context.active().getValue(SELECTED_INSTANCE) as InstancePipelines | undefined;
  const instance = selected
    ? running.includes(selected)
      ? selected
      : undefined
    : running.find((candidate) => candidate[signal]);
  if (!instance && !reportedDrops.has(signal)) {
    reportedDrops.add(signal);
    diag.warn("No running @microsoft/opentelemetry-browser instance; its telemetry is dropped");
  }
  return instance?.[signal];
}

/**
 * The global tracer provider. Resolves the owning instance once, when a tracer is acquired, and
 * returns that instance's own tracer, so later spans never depend on mutable routing state.
 */
const tracerRouter: TracerProvider = {
  getTracer: (name, version, options) =>
    (selectProvider("tracerProvider") ?? noopTracerProvider).getTracer(name, version, options),
};

/** The global logger provider, with the same binding rules as {@link tracerRouter}. */
const loggerRouter: LoggerProvider = {
  getLogger: (name, version, options) =>
    (selectProvider("loggerProvider") ?? noopLoggerProvider).getLogger(name, version, options),
};

/**
 * Adds an instance to the routing table and registers the global router for each signal it
 * collects. Never replaces a provider registered by another SDK, and attempts registration only
 * once per conflicting provider.
 *
 * @returns Removes the instance from routing. Tracers and loggers already bound to it stay bound
 * to its own pipelines rather than moving to another instance.
 */
export function addInstance(instance: InstancePipelines): () => void {
  const tracerDelegate = () => (trace.getTracerProvider() as ProxyTracerProvider).getDelegate?.();
  if (
    instance.tracerProvider &&
    tracerDelegate() !== tracerRouter &&
    tracerDelegate() !== foreignTracerProvider &&
    // The API reports a conflicting registration itself.
    !trace.setGlobalTracerProvider(tracerRouter)
  ) {
    foreignTracerProvider = tracerDelegate();
  }
  const loggerProvider = logs.getLoggerProvider();
  if (
    instance.loggerProvider &&
    loggerProvider !== loggerRouter &&
    loggerProvider !== foreignLoggerProvider &&
    logs.setGlobalLoggerProvider(loggerRouter) !== loggerRouter
  ) {
    foreignLoggerProvider = logs.getLoggerProvider();
    diag.warn("Another OpenTelemetry LoggerProvider is registered; it serves the global Logs API");
  }
  reportedDrops.clear();
  running.push(instance);
  return () => {
    const index = running.indexOf(instance);
    if (index >= 0) running.splice(index, 1);
  };
}

/**
 * Routes tracers and loggers acquired inside `callback` to `instance` instead of the default.
 *
 * @internal Application-facing instance selection is follow-up work.
 */
export function withInstance<T>(instance: InstancePipelines, callback: () => T): T {
  return context.with(context.active().setValue(SELECTED_INSTANCE, instance), callback);
}
