// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { SessionLogRecordProcessor, SessionSpanProcessor } from "./session/sessionProcessors.js";
import { createSession } from "./session/createSession.js";
import {
  BatchLogRecordProcessor,
  type BatchLogRecordProcessorBrowserOptions,
} from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { setUnloading } from "./exporter/common.js";
import { AzureMonitorLogRecordExporter } from "./exporter/log.js";
import { AzureMonitorSpanExporter } from "./exporter/trace.js";
import { PageViewInstrumentation } from "./instrumentation/pageView/index.js";
import {
  ATTR_TELEMETRY_DISTRO_NAME,
  ATTR_TELEMETRY_DISTRO_VERSION,
} from "@opentelemetry/semantic-conventions";
import { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
import type {
  BrowserInstrumentation,
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
): BrowserInstrumentation[] {
  if (typeof document === "undefined" || typeof location === "undefined") return [];

  const owned: BrowserInstrumentation[] = [];
  const pageView = options.pageView ?? {};
  if (pageView.enabled !== false) {
    owned.push(new PageViewInstrumentation({ ...pageView, enabled: false }));
  }
  return owned;
}

/**
 * Restores the session when enabled, then initializes traces, logs, and selected instrumentations.
 * Await completion before emitting telemetry.
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
  // Distribution-owned instrumentations come last, so an application-supplied instance observing
  // the same API is installed first and is disabled last.
  const instrumentations = [
    ...(options.instrumentations ?? []),
    ...createOwnedInstrumentations(options),
  ];
  let sdk: ReturnType<typeof startBrowserSdk> | undefined;
  let stopping = false;
  // Upstream stale tracers can still call processors after provider shutdown.
  const sessionProvider = {
    getSessionId: () => (stopping ? null : (session?.getSessionId() ?? null)),
  };

  let shutdownPromise: Promise<void> | undefined;
  let unloading = false;
  const flushForUnload = (): void => {
    if (unloading) return;
    unloading = true;
    setUnloading(true);
    void forceFlush()
      .catch((error: unknown) => {
        diag.error("Telemetry unload flush failed", error);
      })
      .finally(() => {
        unloading = false;
        setUnloading(false);
      });
  };
  const visibilityChange = (): void => {
    if (globalThis.document?.visibilityState === "hidden") flushForUnload();
  };
  globalThis.addEventListener?.("pagehide", flushForUnload);
  globalThis.document?.addEventListener("visibilitychange", visibilityChange);

  async function forceFlush(): Promise<void> {
    await Promise.all([
      ...(spanProcessors ?? []).map((processor) => processor.forceFlush()),
      ...(logRecordProcessors ?? []).map((processor) => processor.forceFlush()),
    ]);
  }

  function shutdown(): Promise<void> {
    return (shutdownPromise ??= (async () => {
      stopping = true;
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
    sdk = startBrowserSdk({
      // Spread last: the caller's attributes win, and each call gets a fresh object because the
      // SDK mutates this one in place and shares it between the traces and logs SDKs.
      resourceAttributes: {
        [ATTR_TELEMETRY_DISTRO_NAME]: "@microsoft/opentelemetry-browser",
        [ATTR_TELEMETRY_DISTRO_VERSION]: OPENTELEMETRY_BROWSER_VERSION,
        ...options.resource?.attributes,
      },
      traces: {
        ...(traceOptions?.contextManager === undefined
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
          session && logRecordProcessors?.length !== 0
            ? [new SessionLogRecordProcessor(sessionProvider), ...(logRecordProcessors ?? [])]
            : logRecordProcessors,
        ...(session && logRecordProcessors === undefined ? { exportConfig: {} } : {}),
      },
    });
    if (instrumentations.length === 0) return handle;

    const tracerProvider = trace.getTracerProvider();
    const loggerProvider = logs.getLoggerProvider();
    for (const instrumentation of instrumentations) {
      instrumentation.setTracerProvider(tracerProvider);
      instrumentation.setLoggerProvider?.(loggerProvider);
      if (!instrumentation.getConfig().enabled) instrumentation.enable();
    }
  } catch (error) {
    try {
      await shutdown();
    } catch (cleanupError) {
      diag.error("Telemetry initialization cleanup failed", cleanupError);
    }
    throw error;
  }

  return handle;
}
