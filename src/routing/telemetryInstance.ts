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
import {
  addPageCorrelation,
  registerPageContext,
  releasePageContext,
  type PageCorrelation,
} from "./pageContext.js";
import { runLifecycleTasks } from "../shared/lifecycle.js";
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
  let stopped = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdownProviders = (): Promise<void> =>
    (shutdownPromise ??= runLifecycleTasks(
      [
        ...options.spanProcessors,
        ...options.logRecordProcessors,
        ...(tracerProvider ? [tracerProvider] : []),
        ...(loggerProvider ? [loggerProvider] : []),
      ].map((owner) => () => owner.shutdown()),
      "Telemetry provider shutdown failed",
    ));
  // Processor cleanup is owned here so a synchronous failure cannot skip sibling processors.
  const shutdownProcessor = async (): Promise<void> => {};

  let removeCorrelation: (() => void) | undefined;
  let removeInstance: (() => void) | undefined;
  const detach = (): void => {
    if (stopped) return;
    stopped = true;
    removeInstance?.();
    removeCorrelation?.();
    releasePageContext();
  };
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
        spanProcessors: options.spanProcessors.map((processor): SpanProcessor => ({
          onStart: (span, ctx) => {
            if (!stopped) processor.onStart(span, ctx);
          },
          onEnding: (span) => {
            if (!stopped) processor.onEnding?.(span);
          },
          onEnd: (span) => {
            if (!stopped) processor.onEnd(span);
          },
          forceFlush: () => processor.forceFlush(),
          shutdown: shutdownProcessor,
        })),
      });
    }
    if (options.logRecordProcessors.length) {
      loggerProvider = new LoggerProvider({
        resource,
        processors: options.logRecordProcessors.map((processor): LogRecordProcessor => ({
          enabled: (options) => !stopped && (processor.enabled?.(options) ?? true),
          onEmit: (record, ctx) => {
            if (!stopped) processor.onEmit(record, ctx);
          },
          forceFlush: (options) => processor.forceFlush(options),
          shutdown: shutdownProcessor,
        })),
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
    stopped = true;
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
      stopped = true;
      removeInstance?.();
      removeCorrelation?.();
      rollbackGlobals();
    },
    detach,
    async shutdown() {
      try {
        detach();
      } finally {
        await shutdownProviders();
      }
    },
  };
}
