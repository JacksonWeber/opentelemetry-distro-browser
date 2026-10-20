// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  SpanKind,
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
import type { Sampler } from "@opentelemetry/sdk-trace-base";
import { TracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { redactUrl } from "../shared/urlRedaction.js";
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
  readonly redactedQueryParams?: readonly string[];
  readonly resourceAttributes: Attributes;
  readonly sampler?: Sampler;
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
  const parameters = options.redactedQueryParams;
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
      const spanProcessors = options.spanProcessors.map((processor): SpanProcessor => ({
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
      }));
      if (parameters) {
        // SDK 2.11 runs all onEnding hooks before any onEnd, while setters still work.
        // Keep redaction last so it also sanitizes attributes added by application hooks.
        spanProcessors.push({
          onStart() {},
          onEnding: (span) => {
            if (
              stopped ||
              (span.instrumentationScope.name !== "@opentelemetry/browser-instrumentation/fetch" &&
                span.instrumentationScope.name !== "@opentelemetry/browser-instrumentation/xhr") ||
              span.kind !== SpanKind.CLIENT ||
              typeof (span.attributes["http.request.method"] ?? span.attributes["http.method"]) !==
                "string"
            ) {
              return;
            }
            for (const name of ["url.full", "http.url"]) {
              const url = span.attributes[name];
              if (typeof url !== "string" || !url.trim()) continue;
              try {
                span.setAttribute(name, redactUrl(url, parameters));
              } catch {
                try {
                  // Resolve relative sanitizer output only; absolute URLs need no browser globals.
                  const base =
                    (typeof document !== "undefined" && document.baseURI) ||
                    (typeof location !== "undefined" ? location.href : undefined);
                  const baseUrl = base ? new URL(base) : undefined;
                  if (baseUrl) {
                    // Never restore page data removed by an application sanitizer.
                    baseUrl.search = "";
                    baseUrl.hash = "";
                  }
                  span.setAttribute(name, redactUrl(new URL(url, baseUrl).href, parameters));
                } catch {
                  // Unparseable sanitizer output may still contain sensitive parameters.
                  span.setAttribute(name, "");
                }
              }
            }
          },
          onEnd() {},
          async forceFlush() {},
          shutdown: shutdownProcessor,
        });
      }
      tracerProvider = new TracerProvider({
        resource,
        sampler: options.sampler,
        spanProcessors,
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
