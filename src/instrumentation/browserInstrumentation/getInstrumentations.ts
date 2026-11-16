// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { BrowserInstrumentation, InstrumentationOptions } from "../../types.js";
import { CLICK_ANALYTICS_ENABLED } from "../../shared/buildFeatures.js";
import type {
  ClickAnalyticsInstrumentation,
  ClickAnalyticsInstrumentationConfig,
} from "../clickAnalytics/types.js";

/**
 * Creates a deferred npm-only Click Analytics instance with manual capture APIs, without eagerly
 * loading its implementation into applications that use only other instrumentations.
 * @public
 */
export async function createClickAnalyticsInstrumentation(
  config: ClickAnalyticsInstrumentationConfig = {},
): Promise<ClickAnalyticsInstrumentation> {
  const { ClickAnalyticsInstrumentation } =
    await import("../clickAnalytics/clickAnalyticsInstrumentation.js");
  return new ClickAnalyticsInstrumentation({ ...config, enabled: false });
}

const DEFAULT_INITIATOR_TYPES: readonly string[] = ["script", "link", "css"];
const DEFAULT_MAX_QUEUE_SIZE = 256;

/** `fetch` and `xhr` are constructed unless a caller turns them off. */
const ON_BY_DEFAULT = true;

/**
 * Constructed instrumentations are left inert, so `useMicrosoftOpenTelemetry` enables them only
 * after it has bound their trace and log providers.
 */
const DEFERRED = { enabled: false } as const;

/**
 * Whether an instrumentation should be constructed.
 *
 * @remarks
 * An omitted `enabled` falls back to this distribution's default for that instrumentation, which
 * differs from the source module, where `InstrumentationConfig.enabled` defaults to `true`. An
 * explicit value must be exactly `true`, so a truthy-but-not-boolean value arriving from parsed
 * configuration cannot switch construction on by accident.
 */
function isEnabled(options: { enabled?: boolean } | undefined, defaultEnabled: boolean): boolean {
  return options?.enabled === undefined ? defaultEnabled : options.enabled === true;
}

/**
 * Constructs the instrumentations a caller has selected, ready to pass as
 * `MicrosoftOpenTelemetryBrowserOptions.instrumentations`.
 *
 * @remarks
 * Every instrumentation is imported on demand, so an application only downloads and parses the
 * ones it turns on, and a bundler can split the rest out. Calling this function at all is opt-in;
 * an application that constructs its own instances never reaches this code.
 *
 * `fetch` and `xhr` are constructed unless they are turned off, matching the Application Insights
 * JavaScript SDK, where `disableAjaxTracking` and `disableFetchTracking` both default to false.
 * Everything else is constructed only when `enabled` is `true`.
 * Click Analytics is npm-only; CDN bundles reject its configuration.
 *
 * Instances are returned inert, with `enabled: false`, which is the deferred-enablement contract
 * `MicrosoftOpenTelemetryBrowserOptions.instrumentations` documents: registration binds their
 * providers first and enables them afterwards, so nothing is collected before it can be exported.
 *
 * The only settings applied beyond what a caller passes are bounds on subresource timing volume,
 * which are defaults a caller can override. Apart from distribution-owned Click Analytics,
 * instrumentations come from `@opentelemetry/browser-instrumentation`. Registration shares their browser method patches
 * without replacing their collection logic or per-instance configuration.
 *
 * @param options - Selects which instrumentations to construct and configures each one.
 * @returns The constructed instrumentations, in the order they were selected.
 *
 * @public
 */
export async function getInstrumentations(
  options: InstrumentationOptions = {},
): Promise<BrowserInstrumentation[]> {
  if (!CLICK_ANALYTICS_ENABLED && "clickAnalytics" in options) {
    throw new Error("Click Analytics is only available through the npm package.");
  }
  const pending: Promise<BrowserInstrumentation>[] = [];

  if (isEnabled(options.fetch, ON_BY_DEFAULT)) {
    pending.push(
      import("@opentelemetry/browser-instrumentation/experimental/fetch").then(
        ({ FetchInstrumentation }) => new FetchInstrumentation({ ...options.fetch, ...DEFERRED }),
      ),
    );
  }

  if (isEnabled(options.xhr, ON_BY_DEFAULT)) {
    pending.push(
      import("@opentelemetry/browser-instrumentation/experimental/xhr").then(
        ({ XhrInstrumentation }) => new XhrInstrumentation({ ...options.xhr, ...DEFERRED }),
      ),
    );
  }

  if (isEnabled(options.console, false)) {
    pending.push(
      import("@opentelemetry/browser-instrumentation/experimental/console").then(
        ({ ConsoleInstrumentation }) =>
          new ConsoleInstrumentation({ ...options.console, ...DEFERRED }),
      ),
    );
  }

  if (isEnabled(options.errors, false)) {
    pending.push(
      import("@opentelemetry/browser-instrumentation/experimental/errors").then(
        ({ ErrorsInstrumentation }) =>
          new ErrorsInstrumentation({ ...options.errors, ...DEFERRED }),
      ),
    );
  }

  if (isEnabled(options.navigation, false)) {
    pending.push(
      import("@opentelemetry/browser-instrumentation/experimental/navigation").then(
        ({ NavigationInstrumentation }) =>
          new NavigationInstrumentation({ ...options.navigation, ...DEFERRED }),
      ),
    );
  }

  if (isEnabled(options.navigationTiming, false)) {
    pending.push(
      import("@opentelemetry/browser-instrumentation/experimental/navigation-timing").then(
        ({ NavigationTimingInstrumentation }) =>
          new NavigationTimingInstrumentation({ ...options.navigationTiming, ...DEFERRED }),
      ),
    );
  }

  if (isEnabled(options.resourceTiming, false)) {
    pending.push(
      import("@opentelemetry/browser-instrumentation/experimental/resource-timing").then(
        ({ ResourceTimingInstrumentation }) =>
          new ResourceTimingInstrumentation({
            // Copied rather than passed by reference, so a caller that mutates the array it
            // receives cannot change the default for every later call.
            initiatorTypes: [...DEFAULT_INITIATOR_TYPES],
            maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
            ...options.resourceTiming,
            ...DEFERRED,
          }),
      ),
    );
  }

  if (isEnabled(options.userAction, false)) {
    pending.push(
      import("@opentelemetry/browser-instrumentation/experimental/user-action").then(
        ({ UserActionInstrumentation }) =>
          new UserActionInstrumentation({ ...options.userAction, ...DEFERRED }),
      ),
    );
  }

  if (isEnabled(options.webVitals, false)) {
    pending.push(
      import("@opentelemetry/browser-instrumentation/experimental/web-vitals").then(
        ({ WebVitalsInstrumentation }) =>
          new WebVitalsInstrumentation({ ...options.webVitals, ...DEFERRED }),
      ),
    );
  }

  if (CLICK_ANALYTICS_ENABLED && isEnabled(options.clickAnalytics, false)) {
    pending.push(
      import("../clickAnalytics/clickAnalyticsInstrumentation.js").then(
        ({ ClickAnalyticsInstrumentation }) =>
          new ClickAnalyticsInstrumentation({ ...options.clickAnalytics, ...DEFERRED }),
      ),
    );
  }

  return Promise.all(pending);
}
