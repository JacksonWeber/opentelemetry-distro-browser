// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ContextManager, TextMapPropagator, TracerProvider } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { Resource } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ConsoleInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/console";
import type { ErrorsInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/errors";
import type { FetchInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import type { NavigationInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import type { NavigationTimingInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/navigation-timing";
import type { ResourceTimingInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/resource-timing";
import type { UserActionInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/user-action";
import type { WebVitalsInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/web-vitals";
import type { XhrInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import type { AzureMonitorOptions } from "./exporter/base.js";
import type { PageViewInstrumentationConfig } from "./instrumentation/pageView/types.js";

/**
 * Selects and configures the instrumentations that `getInstrumentations` constructs.
 *
 * @remarks
 * Each key configures one instrumentation, and its value is that instrumentation's own
 * configuration type, so every setting it supports is available and stays in step with its source
 * without being restated here.
 *
 * `fetch` and `xhr` are constructed unless `enabled` is `false`. Every other instrumentation is
 * constructed only when `enabled` is `true`. Nothing is constructed until `getInstrumentations`
 * is called, so a caller that never calls it registers no instrumentations at all.
 *
 * The instrumentations below come from `@opentelemetry/browser-instrumentation`. This distribution
 * selects which of them are constructed and supplies defaults; it does not implement or wrap them.
 * Their source module defaults `enabled` to `true` for all of them.
 *
 * @public
 */
export interface InstrumentationOptions {
  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/errors`. */
  errors?: ErrorsInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/fetch`. */
  fetch?: FetchInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/xhr`. */
  xhr?: XhrInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/navigation`. */
  navigation?: NavigationInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/navigation-timing`. */
  navigationTiming?: NavigationTimingInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/resource-timing`. */
  resourceTiming?: ResourceTimingInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/user-action`. */
  userAction?: UserActionInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/web-vitals`. */
  webVitals?: WebVitalsInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/console`. */
  console?: ConsoleInstrumentationConfig;
}

/**
 * The trace and log registration contract implemented by OpenTelemetry instrumentations.
 *
 * @remarks
 * This browser-only subset accepts upstream instrumentation instances without exposing the
 * Node-specific declarations from `@opentelemetry/instrumentation`. Metrics are not initialized
 * by this distribution.
 *
 * @public
 */
export interface BrowserInstrumentation {
  /** Binds the instrumentation to the active tracer provider. */
  setTracerProvider(provider: TracerProvider): void;
  /** Binds log-producing instrumentations to the active logger provider. */
  setLoggerProvider?(provider: LoggerProvider): void;
  /** Returns the instrumentation's configuration without modifying it. */
  getConfig(): { enabled?: boolean };
  /** Starts observing when construction was deferred with `enabled: false`. */
  enable(): void;
  /** Stops observing before telemetry providers shut down. */
  disable(): void;
}

/**
 * Advanced configuration for browser trace context and propagation.
 *
 * @remarks
 * When omitted, the upstream browser SDK installs its default browser context manager and W3C
 * Trace Context and Baggage propagators. Supplying either setting replaces that upstream default
 * when the trace pipeline starts.
 *
 * The OpenTelemetry global context and propagation APIs are page-lifetime registrations. Like the
 * tracer and logger providers, they are not unregistered by `shutdown`; initialize this
 * distribution once per page.
 *
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserTraceOptions {
  /**
   * Context manager used to track the active span across browser callbacks.
   * Omit this setting to use the upstream browser SDK default when traces are initialized.
   */
  contextManager?: ContextManager;
  /**
   * Propagators combined for extraction and injection.
   * Omit this setting for W3C Trace Context and Baggage; use an empty array to disable propagation.
   */
  propagators?: readonly TextMapPropagator[];
}

/**
 * Microsoft browser distribution configuration for traces and logs.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserOptions {
  /** Azure Monitor destination. When provided, Azure Monitor export is enabled. */
  azureMonitor?: AzureMonitorOptions;
  /**
   * Resource describing the entity producing telemetry.
   *
   * @remarks
   * Build it with `resourceFromAttributes` or `detectResources` from `@opentelemetry/resources`.
   * Merged over the SDK defaults, so `service.name` set here replaces the `unknown_service`
   * placeholder. Resolved once at initialization, so only values fixed for the lifetime of the
   * page belong here. Only its attributes are used; the schema URL is not carried through.
   */
  resource?: Resource;
  /**
   * Opt-in session tracking. Set enabled to true to persist sessions in localStorage and
   * supply missing session.id attributes on spans and logs. Uses a 30-minute inactivity
   * timeout with no maximum lifetime; application-provided IDs are preserved.
   * Omitted or disabled session tracking does not access session storage or start session timers.
   */
  session?: { enabled?: boolean };
  /** Advanced trace context and propagation configuration. */
  traces?: MicrosoftOpenTelemetryBrowserTraceOptions;
  /** Span processors to register with the tracer provider. An empty array skips trace initialization. */
  spanProcessors?: SpanProcessor[];
  /** Log record processors to register with the logger provider. An empty array skips log initialization. */
  logRecordProcessors?: LogRecordProcessor[];
  /**
   * Individually imported OpenTelemetry instrumentation instances to register.
   *
   * @remarks
   * No instrumentations are included by default. Construct selected instances with
   * `enabled: false` to defer collection until their trace and log providers are bound.
   * Like OpenTelemetry's registration API, registration enables those instances; omit an
   * instance from this array to opt out. Already-enabled instances are rebound without
   * calling `enable()` again, but telemetry emitted before initialization cannot be recovered.
   *
   * The returned handle owns disabling these instances. Do not share them between SDKs.
   * Configure collection filters and sanitization on each instance before registration.
   */
  instrumentations?: readonly BrowserInstrumentation[];
  /**
   * Page-view collection, which this distribution owns and turns on by itself.
   *
   * @remarks
   * Emits one `browser.page_view` log record per navigation, covering the initial document load
   * and subsequent route changes, and mints a per-navigation correlation id.
   *
   * Collection is on by default; set `enabled: false` to turn it off. Doing so stops collection
   * but does not remove the implementation from the bundle, because a bundler resolves imports
   * long before this object exists.
   */
  pageView?: PageViewInstrumentationConfig;
}

/**
 * Browser telemetry lifecycle handle.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowser {
  /** Flushes pending trace and log telemetry. */
  forceFlush(): Promise<void>;
  /**
   * Stops session timers immediately, then disables registered instrumentations and shuts down
   * trace and log providers.
   * Does not unregister global APIs. Cleanup continues if an instrumentation throws,
   * and the returned promise rejects with the cleanup failure(s).
   */
  shutdown(): Promise<void>;
}
