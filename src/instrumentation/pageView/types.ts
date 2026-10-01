// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type LogRecord } from "@opentelemetry/api-logs";

/**
 * Which resolution step produced the page name.
 *
 * @remarks
 * Resolution order is explicit name, then framework route pattern, then `document.title`, then
 * `location.pathname`. Aggregate on the page name only where the source is `explicit` or `route`;
 * treat `document_title` and `url_path` as high-cardinality diagnostic values.
 *
 * @internal
 */
export type PageViewNameSource = "explicit" | "route" | "document_title" | "url_path";

/**
 * How the emitted page-view duration was obtained.
 *
 * @remarks
 * Only `navigation_timing` is browser-reported. Every `soft_navigation_*` value is a heuristic
 * owned by this distribution and is not comparable with a document-load duration. The
 * `soft_navigation_capped`, `soft_navigation_interrupted` and `page_hide` values are lower bounds
 * rather than measurements, and should be excluded from duration percentiles.
 *
 * @internal
 */
export type PageViewDurationSource =
  | "navigation_timing"
  | "document_load"
  | "soft_navigation_settled"
  | "soft_navigation_capped"
  | "soft_navigation_interrupted"
  | "page_hide"
  | "bfcache_restore_settled"
  | "bfcache_restore_capped";

/**
 * Normalized navigation type.
 *
 * @remarks
 * The first four values describe a document load and mirror `PerformanceNavigationTiming.type`.
 * The last three describe an in-document route change and mirror the upstream
 * `browser.navigation.type` vocabulary. Unlike upstream `browser.navigation`, this is always
 * populated, so a missing value never has to be guessed at query time.
 *
 * @internal
 */
export type PageViewNavigationType =
  "navigate" | "reload" | "back_forward" | "prerender" | "push" | "replace" | "traverse";

/**
 * An in-flight or completed page view.
 *
 * @remarks
 * Published as soon as the navigation is observed, which is well before the log record is emitted.
 * Its operation is available to other telemetry while the page is loading, not after it settles.
 *
 * @internal
 */
export interface PageView {
  /**
   * Operation trace ID for this navigation, also used as the default Application Insights page-view ID.
   */
  readonly id: string;
  /** Zero-based ordinal of this page view within the document's lifetime. */
  readonly index: number;
  /** Resolved page name. */
  readonly name: string;
  /** Which resolution step produced {@link PageView.name}. */
  readonly nameSource: PageViewNameSource;
  /** Full URL, after `sanitizeUrl` when one is configured. */
  readonly url: string;
  /** Referring URL, after `sanitizeUrl`. Empty when unknown. */
  readonly referrer: string;
  /** Normalized navigation type. */
  readonly navigationType: PageViewNavigationType;
  /** False for a document load, true for an in-document route change. */
  readonly sameDocument: boolean;
  /** Wall-clock start of the navigation, in epoch milliseconds. */
  readonly startTimeUnixMs: number;
}

/**
 * Notified whenever a new page view becomes current.
 * @internal
 */
export type PageViewListener = (pageView: PageView) => void;

/**
 * Read-only view of the current page view.
 *
 * @remarks
 * This is the seam a correlation processor consumes. It exposes no way to mint or mutate a page
 * view, so a consumer cannot influence page-view lifetime, and it carries no dependency on the
 * instrumentation itself.
 *
 * @internal
 */
export interface PageViewSource {
  /**
   * The page view that is current now, or undefined before the first navigation is observed.
   */
  getCurrentPageView(): PageView | undefined;
  /**
   * Subscribe to page-view changes.
   *
   * @returns A handle that removes the subscription. Release it during shutdown.
   */
  onPageViewChanged(listener: PageViewListener): () => void;
}

/**
 * Writable side of the page-view seam, owned by whatever mints page views.
 *
 * @remarks
 * Split from {@link PageViewSource} so that consumers can only read. Create one with
 * `createPageViewContext` and pass it to both the instrumentation and the component that needs to
 * read from it.
 *
 * @internal
 */
export interface PageViewContext extends PageViewSource {
  /** Publishes a new current page view and notifies subscribers. */
  setCurrentPageView(pageView: PageView): void;
  /**
   * Drops the current page view, so a consumer stops correlating against a finished navigation.
   *
   * @remarks
   * Subscriptions are deliberately kept: the instrumentation calls this on `disable()`, and a
   * correlation processor that subscribed once must keep working across a disable/enable cycle.
   * Unsubscribe through the function {@link PageViewSource.onPageViewChanged} returns.
   */
  clear(): void;
}

/**
 * Configuration for the page-view instrumentation.
 *
 * @remarks
 * This is the only page-view type in the package's public API. Hook signatures are written inline
 * rather than as named aliases, and the context-injection seam lives on the internal configuration,
 * so configuring page views pulls no other type into the public surface.
 *
 * Structurally compatible with `InstrumentationConfig` from `@opentelemetry/instrumentation`, but
 * declared standalone rather than extending it. That package's type entry point resolves to its
 * Node platform build, which references Node built-ins, so inheriting from it would force every
 * browser consumer of this package's declarations to install Node typings.
 *
 * @public
 */
export interface PageViewInstrumentationConfig {
  /**
   * Whether the instrumentation starts observing as soon as it is constructed.
   *
   * @defaultValue true
   */
  readonly enabled?: boolean;

  /**
   * Supplies the framework route pattern, such as `/orders/:id`. Called when the navigation is
   * observed and again when it settles, so a router that commits its route asynchronously is
   * still reflected. Must be cheap and free of side effects.
   *
   * @remarks
   * Prefer a route pattern over a resolved path: patterns aggregate, concrete paths do not. Return
   * undefined when no route is known, so resolution falls through to `document.title`.
   */
  readonly routeResolver?: () => string | undefined;

  /** Sanitizes the page URL and the referrer before they are recorded. */
  readonly sanitizeUrl?: (url: string) => string;

  /** Modifies the log record immediately before it is emitted. */
  readonly applyCustomLogRecordData?: (logRecord: LogRecord) => void;

  /**
   * Upper bound, in milliseconds, on how long a soft navigation may wait to settle before its page
   * view is emitted anyway with a `soft_navigation_capped` duration source.
   *
   * @defaultValue 10000
   */
  readonly softNavigationSettleTimeoutMs?: number;

  /**
   * Use the experimental Navigation API when the browser exposes it, instead of patching `history`.
   *
   * @defaultValue false
   */
  readonly useNavigationApiIfAvailable?: boolean;
}

/**
 * Configuration including the seams that are not part of the public API.
 *
 * @remarks
 * Context sharing and ID generation are internal seams. An injected generator must return a
 * valid OpenTelemetry trace ID.
 *
 * @internal
 */
export interface InternalPageViewInstrumentationConfig extends PageViewInstrumentationConfig {
  /**
   * Page-view context to publish into. When omitted the instrumentation creates its own and
   * exposes it through `pageViews`. Never a module-level global, so independent instances stay
   * independent.
   */
  readonly pageViewContext?: PageViewContext;

  /** Overrides page-view id generation. */
  readonly generatePageViewId?: () => string;
}
