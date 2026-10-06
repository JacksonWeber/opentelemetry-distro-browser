// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  type Attributes,
  type ContextManager,
  type TextMapPropagator,
  type TracerProvider as TracerProviderApi,
} from "@opentelemetry/api";
import type { LoggerProvider as LoggerProviderApi } from "@opentelemetry/api-logs";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { TracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { addInstance, noopLoggerProvider, noopTracerProvider } from "./instanceRouter.js";
import { addPageCorrelation, registerPageContext, type PageCorrelation } from "./pageContext.js";
import { getSharedRegistry } from "../shared/globalOwnership.js";

/** Resolved pipeline configuration for one distribution instance. */
export interface TelemetryInstanceOptions {
  readonly resourceAttributes: Attributes;
  /** An empty list leaves traces off for this instance. */
  readonly spanProcessors: readonly SpanProcessor[];
  /** An empty list leaves logs off for this instance. */
  readonly logRecordProcessors: readonly LogRecordProcessor[];
  readonly contextManager?: ContextManager;
  /** Page correlation shared with other instances while this is the earliest with page views. */
  readonly correlation?: PageCorrelation;
  readonly propagators?: readonly TextMapPropagator[];
}

/** One instance's isolated providers, which its instrumentations bind to directly. */
export interface TelemetryInstance {
  readonly tracerProvider: TracerProviderApi;
  readonly loggerProvider: LoggerProviderApi;
  /**
   * Stops routing new tracers and loggers to the instance and passes the page operation on at
   * once, before shutdown awaits pending flushes.
   */
  detach(): void;
  /** Stops routing to the instance, then shuts down both of its providers. */
  shutdown(): Promise<void>;
}

/**
 * Creates an instance's own tracer and logger providers and adds it to the global router.
 *
 * @remarks
 * Nothing is shared with other instances except the page-wide context manager and propagator,
 * which the OpenTelemetry API allows only one SDK to register: the first tracing instance on the
 * page registers them for the page's lifetime. The page operation comes from the earliest running
 * instance with page views, including logs-only instances, and passes on when it shuts down.
 * Processor ownership transfers on entry. Any startup failure shuts down created providers and
 * processors not yet bound to a provider before the failure is rethrown.
 */
export async function startTelemetryInstance(
  options: TelemetryInstanceOptions,
): Promise<TelemetryInstance> {
  let tracerProvider: TracerProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  const shutdownProviders = async (): Promise<void> => {
    const owners = [
      ...(tracerProvider ? [tracerProvider] : options.spanProcessors),
      ...(loggerProvider ? [loggerProvider] : options.logRecordProcessors),
    ];
    const results = await Promise.allSettled(owners.map(async (owner) => owner.shutdown()));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Telemetry provider shutdown failed");
  };

  let rollbackContext: (() => void) | undefined;
  let removeCorrelation: (() => void) | undefined;
  let removeInstance: (() => void) | undefined;
  try {
    const registry = getSharedRegistry();
    // Matches the upstream browser SDK's once-per-page diagnostic initialization.
    if (!registry.diagInitialized) {
      registry.diagInitialized = diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    }
    const resource = defaultResource().merge(resourceFromAttributes(options.resourceAttributes));
    if (options.spanProcessors.length) {
      tracerProvider = new TracerProvider({
        resource,
        spanProcessors: options.spanProcessors.slice(),
      });
    }
    if (options.logRecordProcessors.length) {
      loggerProvider = new LoggerProvider({
        resource,
        processors: options.logRecordProcessors.slice(),
      });
    }
    if (tracerProvider) {
      rollbackContext = registerPageContext(
        options.contextManager,
        () => new StackContextManager(),
        () =>
          new CompositePropagator({
            propagators: options.propagators?.slice() ?? [
              new W3CTraceContextPropagator(),
              new W3CBaggagePropagator(),
            ],
          }),
      );
    }
    removeCorrelation = options.correlation && addPageCorrelation(options.correlation);
    removeInstance = addInstance({ tracerProvider, loggerProvider });
  } catch (error) {
    removeCorrelation?.();
    removeInstance?.();
    try {
      rollbackContext?.();
    } catch (cleanupFailure) {
      diag.error("Telemetry global rollback failed", cleanupFailure);
    }
    try {
      await shutdownProviders();
    } catch (cleanupFailure) {
      diag.error("Telemetry initialization cleanup failed", cleanupFailure);
    }
    throw error;
  }

  return {
    tracerProvider: tracerProvider ?? noopTracerProvider,
    loggerProvider: loggerProvider ?? noopLoggerProvider,
    detach() {
      removeInstance?.();
      removeCorrelation?.();
    },
    async shutdown() {
      removeInstance?.();
      removeCorrelation?.();
      await shutdownProviders();
    },
  };
}
