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
import { getRegisteredGlobal, getSharedRegistry } from "../shared/globalOwnership.js";

/** Instance-owned providers. Omitted signals never fall back to another instance. */
export interface InstancePipelines {
  readonly tracerProvider?: TracerProvider;
  readonly loggerProvider?: LoggerProvider;
}

export interface RouterState {
  running: InstancePipelines[];
  selection: symbol;
  reportedDrops: Set<keyof InstancePipelines>;
  tracerRouter: TracerProvider;
  loggerRouter: LoggerProvider;
  traceRegistration?: unknown;
  logsRegistration?: unknown;
  foreignTracerProvider?: unknown;
  foreignLoggerProvider?: unknown;
}

function getRouter(): RouterState {
  const registry = getSharedRegistry();
  return (registry.router ??= {
    running: [],
    selection: createContextKey("@microsoft/opentelemetry-browser instance"),
    reportedDrops: new Set(),
    tracerRouter: {
      getTracer: (name, version, options) =>
        (selectProvider("tracerProvider") ?? noopTracerProvider).getTracer(name, version, options),
    },
    loggerRouter: {
      getLogger: (name, version, options) =>
        (selectProvider("loggerProvider") ?? noopLoggerProvider).getLogger(name, version, options),
    },
  });
}

/** Hands out no-op tracers: a proxy without a delegate never records. */
export const noopTracerProvider: TracerProvider = /* @__PURE__ */ new ProxyTracerProvider();
/** Hands out no-op loggers. */
export const noopLoggerProvider: LoggerProvider = { getLogger: () => createNoopLogger() };

/** Uses the selected instance, or defaults to the first running owner of this signal. */
function selectProvider<K extends keyof InstancePipelines>(
  signal: K,
): InstancePipelines[K] | undefined {
  const { running, selection, reportedDrops } = getRouter();
  const selected = context.active().getValue(selection) as InstancePipelines | undefined;
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
 * Adds an instance without replacing foreign providers.
 * Returns a removal callback. Acquired tracers and loggers stay bound to their instance.
 */
export function addInstance(instance: InstancePipelines): () => void {
  const state = getRouter();
  const traceRegistration = getRegisteredGlobal("trace");
  if (
    instance.tracerProvider &&
    (!traceRegistration || traceRegistration !== state.traceRegistration)
  ) {
    if (!traceRegistration && trace.setGlobalTracerProvider(state.tracerRouter)) {
      state.traceRegistration = getRegisteredGlobal("trace");
    } else if (!traceRegistration || traceRegistration !== state.foreignTracerProvider) {
      state.foreignTracerProvider = traceRegistration;
      diag.error(
        "[tracer-provider-conflict] Global traces remain with another installation. Instance pipelines are isolated.",
      );
    }
  }
  const logsRegistration = getRegisteredGlobal("logs");
  if (
    instance.loggerProvider &&
    (!logsRegistration || logsRegistration !== state.logsRegistration)
  ) {
    if (
      !logsRegistration &&
      logs.setGlobalLoggerProvider(state.loggerRouter) === state.loggerRouter
    ) {
      state.logsRegistration = getRegisteredGlobal("logs");
    } else if (!logsRegistration || logsRegistration !== state.foreignLoggerProvider) {
      state.foreignLoggerProvider = logsRegistration;
      diag.warn(
        "[logger-provider-conflict] Global logs remain with another installation. Instance pipelines are isolated.",
      );
    }
  }
  state.reportedDrops.clear();
  state.running.push(instance);
  return () => {
    const index = state.running.indexOf(instance);
    if (index >= 0) state.running.splice(index, 1);
  };
}

/**
 * Routes tracers and loggers acquired inside `callback` to `instance` instead of the default.
 *
 * @internal Application-facing instance selection is follow-up work.
 */
export function withInstance<T>(instance: InstancePipelines, callback: () => T): T {
  return context.with(context.active().setValue(getRouter().selection, instance), callback);
}
