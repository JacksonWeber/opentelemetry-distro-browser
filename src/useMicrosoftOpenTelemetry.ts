// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  diag,
  propagation,
  trace,
  type ContextManager,
  type TextMapPropagator,
  type TracerProvider,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { SessionLogRecordProcessor, SessionSpanProcessor } from "./session/sessionProcessors.js";
import { createSession } from "./session/createSession.js";
import {
  BatchLogRecordProcessor,
  type BatchLogRecordProcessorBrowserOptions,
} from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { beginUnloading, endUnloading } from "./exporter/common.js";
import { AzureMonitorLogRecordExporter } from "./exporter/log.js";
import { AzureMonitorSpanExporter } from "./exporter/trace.js";
import { PageViewInstrumentation } from "./instrumentation/pageView/index.js";
import { PageViewCorrelation } from "./instrumentation/pageView/pageViewCorrelation.js";
import {
  ATTR_TELEMETRY_DISTRO_NAME,
  ATTR_TELEMETRY_DISTRO_VERSION,
} from "@opentelemetry/semantic-conventions";
import { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";

function snapshotRegistrations() {
  // API 1.x has no public context/propagator getters, and its tracer getter returns a proxy
  // even before registration. Read the shared registry only for identity, never mutate it.
  const api = Reflect.get(globalThis, Symbol.for("opentelemetry.js.api.1")) as
    | {
        trace?: TracerProvider;
        context?: ContextManager;
        propagation?: TextMapPropagator;
      }
    | undefined;
  return {
    trace: api?.trace,
    context: api?.context,
    propagation: api?.propagation,
    logs: logs.getLoggerProvider(),
  };
}

/**
 * Builds the instrumentations this distribution owns and turns on by itself.
 *
 * @remarks
 * Distribution-owned instrumentations are selected by configuration rather than by import,
 * because a bundler resolves imports before the application ever supplies its options. Page view
 * is on unless it is switched off.
 *
 * Returns nothing outside a browser. This entry point is routinely imported by a server-rendered
 * build, and these instrumentations observe the DOM, so constructing one there would throw during
 * initialization and take the host application down with it.
 *
 * Each is constructed with `enabled: false` so that collection starts only once the registration
 * loop below has bound its trace and log providers.
 */
function createOwnedInstrumentations(
  options: MicrosoftOpenTelemetryBrowserOptions,
): PageViewInstrumentation[] {
  if (typeof document === "undefined" || typeof location === "undefined") return [];

  const owned: PageViewInstrumentation[] = [];
  const pageView = options.pageView ?? {};
  if (pageView.enabled !== false) {
    owned.push(
      new PageViewInstrumentation(
        { ...pageView, enabled: false },
        options.traces?.contextManager?.active() ?? context.active(),
      ),
    );
  }
  return owned;
}

/**
 * Restores the session when enabled, then initializes traces, logs, and selected instrumentations.
 * Captures the initial page operation from the supplied manager or global context before awaiting
 * session restoration, so synchronous context scopes are preserved.
 * Await completion before emitting telemetry.
 * If initialization fails, unregisters globals installed by that attempt so initialization can
 * be retried with fresh processors and instrumentations. Existing global registrations are kept.
 * @public
 */
export async function useMicrosoftOpenTelemetry(
  options: MicrosoftOpenTelemetryBrowserOptions = {},
): Promise<MicrosoftOpenTelemetryBrowser> {
  const azureBatchOptions = {
    disableAutoFlushOnDocumentHide: true,
  } satisfies Pick<BatchLogRecordProcessorBrowserOptions, "disableAutoFlushOnDocumentHide">;
  const spanProcessors = options.azureMonitor
    ? [
        new BatchSpanProcessor(
          new AzureMonitorSpanExporter(options.azureMonitor),
          azureBatchOptions,
        ),
        ...(options.spanProcessors ?? []),
      ]
    : options.spanProcessors?.slice();
  const logRecordProcessors = options.azureMonitor
    ? [
        new BatchLogRecordProcessor({
          exporter: new AzureMonitorLogRecordExporter(options.azureMonitor),
          ...azureBatchOptions,
        }),
        ...(options.logRecordProcessors ?? []),
      ]
    : options.logRecordProcessors?.slice();
  const session = options.session?.enabled === true ? createSession() : undefined;
  const traceOptions = options.traces;
  const owned = createOwnedInstrumentations(options);
  const pageView = owned[0];
  const correlation = pageView
    ? new PageViewCorrelation(() => pageView.getOperationContext(), traceOptions?.contextManager)
    : undefined;
  // Publish the initial page operation before caller instrumentations can emit.
  const instrumentations = [...owned, ...(options.instrumentations ?? [])];
  let sdk: ReturnType<typeof startBrowserSdk> | undefined;
  let previousRegistrations: ReturnType<typeof snapshotRegistrations> | undefined;
  let installedRegistrations: ReturnType<typeof snapshotRegistrations> | undefined;
  let stopping = false;
  // Upstream stale tracers can still call processors after provider shutdown.
  const sessionProvider = {
    getSessionId: () => (stopping ? null : (session?.getSessionId() ?? null)),
  };

  let shutdownPromise: Promise<void> | undefined;
  let flushPromise: Promise<void> | undefined;
  let unloadFlushPromise: Promise<void> | undefined;
  const flushForUnload = (): void => {
    if (unloadFlushPromise) return;
    beginUnloading();
    const operation = flushProcessors()
      .catch((error: unknown) => {
        diag.error("Telemetry unload flush failed", error);
      })
      .finally(() => {
        endUnloading();
        if (unloadFlushPromise === operation) unloadFlushPromise = undefined;
      });
    unloadFlushPromise = operation;
  };
  const visibilityChange = (): void => {
    if (globalThis.document?.visibilityState === "hidden") flushForUnload();
  };
  globalThis.addEventListener?.("pagehide", flushForUnload);
  globalThis.document?.addEventListener("visibilitychange", visibilityChange);

  async function flushProcessors(): Promise<void> {
    const processors = [...(spanProcessors ?? []), ...(logRecordProcessors ?? [])];
    const results = await Promise.allSettled(
      processors.map((processor) => Promise.resolve().then(() => processor.forceFlush())),
    );
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Telemetry flush failed");
  }

  function forceFlush(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    if (!flushPromise) {
      const operation = flushProcessors();
      const tracked = operation.finally(() => {
        if (flushPromise === tracked) flushPromise = undefined;
      });
      flushPromise = tracked;
    }
    return flushPromise;
  }

  function shutdown(): Promise<void> {
    return (shutdownPromise ??= (async () => {
      stopping = true;
      void correlation?.shutdown();
      globalThis.removeEventListener?.("pagehide", flushForUnload);
      globalThis.document?.removeEventListener("visibilitychange", visibilityChange);
      const errors: unknown[] = [];
      try {
        session?.shutdown();
      } catch (error) {
        errors.push(error);
      }
      for (let i = sdk ? instrumentations.length - 1 : -1; i >= 0; i--) {
        try {
          instrumentations[i].disable();
        } catch (error) {
          errors.push(error);
        }
      }
      const activeFlushes = [flushPromise, unloadFlushPromise].filter(
        (operation): operation is Promise<void> => operation !== undefined,
      );
      if (activeFlushes.length > 0) {
        const flushResults = await Promise.allSettled(activeFlushes);
        for (const result of flushResults) {
          if (result.status === "rejected") errors.push(result.reason);
        }
      }
      try {
        await sdk?.shutdown();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Telemetry shutdown failed");
    })());
  }

  const handle = { forceFlush, shutdown };

  try {
    await session?.start();
    const logContextProcessors = [
      ...(session ? [new SessionLogRecordProcessor(sessionProvider)] : []),
      ...(correlation ? [correlation] : []),
    ];
    previousRegistrations = snapshotRegistrations();
    sdk = startBrowserSdk({
      // Spread last: the caller's attributes win, and each call gets a fresh object because the
      // SDK mutates this one in place and shares it between the traces and logs SDKs.
      resourceAttributes: {
        [ATTR_TELEMETRY_DISTRO_NAME]: "@microsoft/opentelemetry-browser",
        [ATTR_TELEMETRY_DISTRO_VERSION]: OPENTELEMETRY_BROWSER_VERSION,
        ...options.resource?.attributes,
      },
      traces: {
        ...(correlation
          ? { contextManager: correlation }
          : traceOptions?.contextManager === undefined
            ? {}
            : { contextManager: traceOptions.contextManager }),
        ...(traceOptions?.propagators === undefined
          ? {}
          : { propagators: traceOptions.propagators.slice() }),
        processors:
          session && spanProcessors?.length !== 0
            ? [new SessionSpanProcessor(sessionProvider), ...(spanProcessors ?? [])]
            : spanProcessors,
        // Supplying enrichment processors must not disable upstream default export.
        ...(session && spanProcessors === undefined ? { exportConfig: {} } : {}),
      },
      logs: {
        processors:
          logContextProcessors.length && logRecordProcessors?.length !== 0
            ? [...logContextProcessors, ...(logRecordProcessors ?? [])]
            : logRecordProcessors,
        ...(logContextProcessors.length && logRecordProcessors === undefined
          ? { exportConfig: {} }
          : {}),
      },
    });
    installedRegistrations = snapshotRegistrations();
    if (instrumentations.length === 0) return handle;

    const tracerProvider = trace.getTracerProvider();
    const loggerProvider = logs.getLoggerProvider();
    for (const instrumentation of instrumentations) {
      instrumentation.setTracerProvider(tracerProvider);
      instrumentation.setLoggerProvider?.(loggerProvider);
      if (!instrumentation.getConfig().enabled) instrumentation.enable();
    }
  } catch (error) {
    // Capture partial startup too, before asynchronous cleanup can yield to another initializer.
    if (previousRegistrations) installedRegistrations ??= snapshotRegistrations();
    try {
      await shutdown();
    } catch (cleanupError) {
      diag.error("Telemetry initialization cleanup failed", cleanupError);
    }
    if (previousRegistrations && installedRegistrations) {
      const apis = { trace, logs, propagation, context };
      for (const name of ["trace", "logs", "propagation", "context"] as const) {
        if (
          installedRegistrations[name] !== previousRegistrations[name] &&
          snapshotRegistrations()[name] === installedRegistrations[name]
        ) {
          try {
            apis[name].disable();
          } catch (cleanupError) {
            diag.error("Telemetry initialization cleanup failed", cleanupError);
          }
        }
      }
    }
    throw error;
  }

  return handle;
}
