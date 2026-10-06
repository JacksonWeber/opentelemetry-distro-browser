// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { CompositePropagator } from "@opentelemetry/core";
import {
  BrowserContextLogRecordProcessor,
  BrowserContextSpanProcessor,
} from "./context/contextProcessors.js";
import { createSession } from "./session/createSession.js";
import { createUserContext } from "./user/createUserContext.js";
import {
  BatchLogRecordProcessor,
  type BatchLogRecordProcessorBrowserOptions,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
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
import {
  assertGlobalsAvailable,
  assertGlobalsRegistered,
  reserveGlobals,
  trackGlobals,
} from "./shared/globalOwnership.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";

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
 * @public
 */
export async function useMicrosoftOpenTelemetry(
  options: MicrosoftOpenTelemetryBrowserOptions = {},
): Promise<MicrosoftOpenTelemetryBrowser> {
  const tracesEnabled = options.spanProcessors?.length !== 0;
  const release = reserveGlobals(tracesEnabled);
  try {
    return await initialize(options, tracesEnabled);
  } finally {
    release();
  }
}

async function initialize(
  options: MicrosoftOpenTelemetryBrowserOptions,
  tracesEnabled: boolean,
): Promise<MicrosoftOpenTelemetryBrowser> {
  const userContext = createUserContext(options.userContext?.enabled === true);
  // The handle flushes owned processors on page hide; avoid a second per-processor hide flush.
  const batchOptions = {
    disableAutoFlushOnDocumentHide: true,
  } satisfies Pick<BatchLogRecordProcessorBrowserOptions, "disableAutoFlushOnDocumentHide">;
  const azureMonitor = options.azureMonitor ? { ...options.azureMonitor } : undefined;
  let spanProcessors: SpanProcessor[] | undefined = options.spanProcessors?.slice();
  let logRecordProcessors: LogRecordProcessor[] | undefined = options.logRecordProcessors?.slice();
  const ownedProcessors: (SpanProcessor | LogRecordProcessor)[] = [];
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
  let registration: ReturnType<typeof trackGlobals> | undefined;
  let instrumentationsStarted = false;
  let stopping = false;
  // Upstream stale tracers can still call processors after provider shutdown.
  const sessionProvider = {
    getSessionId: () => (stopping ? null : (session?.getSessionId() ?? null)),
  };
  const contextProvider = {
    ...userContext.provider,
    ...sessionProvider,
  };
  const contextSpanProcessor = new BrowserContextSpanProcessor(contextProvider);
  const contextLogRecordProcessor = new BrowserContextLogRecordProcessor(contextProvider);

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
      for (let i = sdk && instrumentationsStarted ? instrumentations.length - 1 : -1; i >= 0; i--) {
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
      if (!sdk) {
        for (const processor of ownedProcessors) {
          try {
            await processor.shutdown();
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Telemetry shutdown failed");
    })());
  }

  const handle = { forceFlush, shutdown, userContext: userContext.context };

  try {
    if (spanProcessors?.length !== 0 && (azureMonitor || spanProcessors === undefined)) {
      const spanProcessor = new BatchSpanProcessor(
        azureMonitor ? new AzureMonitorSpanExporter(azureMonitor) : new OTLPTraceExporter(),
        batchOptions,
      );
      ownedProcessors.push(spanProcessor);
      spanProcessors = [spanProcessor, ...(spanProcessors ?? [])];
    }
    if (logRecordProcessors?.length !== 0 && (azureMonitor || logRecordProcessors === undefined)) {
      const logProcessor = new BatchLogRecordProcessor({
        exporter: azureMonitor
          ? new AzureMonitorLogRecordExporter(azureMonitor)
          : new OTLPLogExporter(),
        ...batchOptions,
      });
      ownedProcessors.push(logProcessor);
      logRecordProcessors = [logProcessor, ...(logRecordProcessors ?? [])];
    }
    await session?.start();
    const propagators = traceOptions?.propagators?.slice();
    // Run application fields() callbacks before the SDK starts registering globals.
    const preparedPropagators =
      tracesEnabled && propagators ? [new CompositePropagator({ propagators })] : propagators;
    registration = trackGlobals(
      tracesEnabled,
      logRecordProcessors?.length !== 0,
      correlation ?? traceOptions?.contextManager,
      traceOptions?.contextManager,
    );
    const sdkOptions = {
      // Spread last: the caller's attributes win, and each call gets a fresh object because the
      // SDK mutates this one in place and shares it between the traces and logs SDKs.
      resourceAttributes: {
        [ATTR_TELEMETRY_DISTRO_NAME]: "@microsoft/opentelemetry-browser",
        [ATTR_TELEMETRY_DISTRO_VERSION]: OPENTELEMETRY_BROWSER_VERSION,
        ...options.resource?.attributes,
      },
      traces: {
        ...(registration.contextManager === undefined
          ? {}
          : { contextManager: registration.contextManager }),
        ...(preparedPropagators === undefined ? {} : { propagators: preparedPropagators }),
        processors:
          spanProcessors?.length === 0 ? [] : [contextSpanProcessor, ...(spanProcessors ?? [])],
      },
      logs: {
        processors:
          logRecordProcessors?.length === 0
            ? []
            : [
                contextLogRecordProcessor,
                ...(correlation ? [correlation] : []),
                ...(logRecordProcessors ?? []),
              ],
      },
    };
    // Session restoration and application configuration callbacks can register a foreign SDK.
    assertGlobalsAvailable(tracesEnabled);
    sdk = startBrowserSdk(sdkOptions);
    assertGlobalsRegistered(registration);
    globalThis.addEventListener?.("pagehide", flushForUnload);
    globalThis.document?.addEventListener("visibilitychange", visibilityChange);
    if (instrumentations.length === 0) return handle;

    const tracerProvider = trace.getTracerProvider();
    const loggerProvider = logs.getLoggerProvider();
    instrumentationsStarted = true;
    for (const instrumentation of instrumentations) {
      instrumentation.setTracerProvider(tracerProvider);
      instrumentation.setLoggerProvider?.(loggerProvider);
      if (!instrumentation.getConfig().enabled) instrumentation.enable();
    }
  } catch (error) {
    try {
      registration?.rollback();
    } catch (rollbackError) {
      diag.error("Telemetry initialization rollback failed", rollbackError);
    }
    try {
      await shutdown();
    } catch (cleanupError) {
      diag.error("Telemetry initialization cleanup failed", cleanupError);
    }
    throw error;
  }

  return handle;
}
