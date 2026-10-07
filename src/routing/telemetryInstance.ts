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
import {
  commitGlobals,
  getSharedRegistry,
  reportError,
  rollbackGlobals,
} from "../shared/globalOwnership.js";

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
  /** Commits globals after instrumentation setup succeeds. */
  commit(): void;
  /** Releases provisional globals without disturbing surviving instances. */
  abort(): void;
  /** Hands off routing and page context before waiting for flushes. */
  detach(): void;
  /** Stops routing to the instance, then shuts down both of its providers. */
  shutdown(): Promise<void>;
}

/**
 * Creates isolated providers behind shared routers and page context.
 * Takes processor ownership on entry and cleans up every failed startup.
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
      registerPageContext(
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
    rollbackGlobals();
    try {
      await shutdownProviders();
    } catch (cleanupFailure) {
      reportError("Telemetry initialization cleanup failed", cleanupFailure);
    }
    throw error;
  }

  return {
    tracerProvider: tracerProvider ?? noopTracerProvider,
    loggerProvider: loggerProvider ?? noopLoggerProvider,
    commit() {
      commitGlobals(!!tracerProvider, !!loggerProvider);
    },
    abort() {
      removeInstance?.();
      removeCorrelation?.();
      rollbackGlobals();
    },
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
