// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Internal semantic conventions for the page-view event.
 *
 * @remarks
 * There is no upstream convention for page views.
 *
 * Two rules govern this module:
 *
 * 1. Every event name and attribute key used by the instrumentation lives here, never inline at a
 *    call site, so adopting an upstream convention later is a table edit rather than a rewrite.
 * 2. Everything is an individual `const`. Aggregate semantic-convention objects such as
 *    `SemanticResourceAttributes` are never imported, because they cannot be tree-shaken: reaching
 *    a single attribute through an aggregate costs kilobytes of minified output, against a few
 *    hundred bytes for the individual constants an instrumentation actually uses.
 *
 * This module is internal and is deliberately not part of the package's public API.
 */

import { type SeverityNumber } from "@opentelemetry/api-logs";

/** Event name carried as the log record's top-level `eventName`. */
export const EVENT_BROWSER_PAGE_VIEW = "browser.page_view";

/**
 * `SeverityNumber.INFO`, inlined as a numeric literal.
 *
 * @remarks
 * `SeverityNumber` is a runtime enum, so importing it as a value pulls the whole
 * `@opentelemetry/api-logs` entry point — which executes module-level side effects — into the
 * bundle, and that defeats tree-shaking for consumers who never touch page views. The value is
 * fixed by the OpenTelemetry logs data model, so inlining it is safe. The type-only import above
 * is erased at compile time and keeps the assignment checked.
 */
export const SEVERITY_NUMBER_INFO = 9 as SeverityNumber;

/**
 * Full URL of the page that was viewed. Reuses the upstream `url.full` key that
 * `browser.navigation` and `browser.navigation_timing` already emit, so a backend can join on it
 * without a distribution-specific alias.
 */
export const ATTR_URL_FULL = "url.full";

/** Correlation id minted once per navigation. */
export const ATTR_PAGE_VIEW_ID = "browser.page_view.id";

/** Human-meaningful page name. */
export const ATTR_PAGE_VIEW_NAME = "browser.page_view.name";

/**
 * Which resolution step produced the name. Without it a query cannot tell a stable route pattern
 * from a mutable document title, so page names cannot be safely aggregated.
 */
export const ATTR_PAGE_VIEW_NAME_SOURCE = "browser.page_view.name_source";

/** Page-view duration in milliseconds, as a double. */
export const ATTR_PAGE_VIEW_DURATION = "browser.page_view.duration";

/**
 * How the duration was obtained. A browser-reported navigation duration and a heuristic
 * soft-navigation duration are not comparable, so they must be distinguishable at query time.
 */
export const ATTR_PAGE_VIEW_DURATION_SOURCE = "browser.page_view.duration_source";

/** Where the user came from. */
export const ATTR_PAGE_VIEW_REFERRER = "browser.page_view.referrer";

/**
 * Normalized navigation type. Always set, including on the initial document load, where upstream
 * `browser.navigation` omits it and an absent value is indistinguishable from an older SDK that
 * never populated the field.
 */
export const ATTR_PAGE_VIEW_TYPE = "browser.page_view.type";

/** False for a document load, true for an in-document route change. */
export const ATTR_PAGE_VIEW_SAME_DOCUMENT = "browser.page_view.same_document";

/** Zero-based ordinal of this page view within the document's lifetime. */
export const ATTR_PAGE_VIEW_INDEX = "browser.page_view.index";

/** Name supplied by the application through `setPageName`. */
export const NAME_SOURCE_EXPLICIT = "explicit";
/** Name supplied by a router integration as a route pattern, such as `/orders/:id`. */
export const NAME_SOURCE_ROUTE = "route";
/** Name taken from `document.title`. */
export const NAME_SOURCE_DOCUMENT_TITLE = "document_title";
/** Name taken from `location.pathname`. */
export const NAME_SOURCE_URL_PATH = "url_path";

/** Duration read from `PerformanceNavigationTiming`. Browser-reported. */
export const DURATION_SOURCE_NAVIGATION_TIMING = "navigation_timing";
/** `PerformanceNavigationTiming` was unavailable; elapsed time since `timeOrigin` was used. */
export const DURATION_SOURCE_DOCUMENT_LOAD = "document_load";
/** Soft navigation observed to settle: the first idle callback after the next paint. */
export const DURATION_SOURCE_SOFT_SETTLED = "soft_navigation_settled";
/** Soft navigation did not settle within the configured cap; the duration is the cap. */
export const DURATION_SOURCE_SOFT_CAPPED = "soft_navigation_capped";
/** Superseded by the next navigation before it settled; the duration is truncated. */
export const DURATION_SOURCE_SOFT_INTERRUPTED = "soft_navigation_interrupted";
/** The page was hidden before the page view settled; the duration is truncated. */
export const DURATION_SOURCE_PAGE_HIDE = "page_hide";
/**
 * Restored from the back/forward cache, observed to settle. There is no document load to measure,
 * so this is the same observed settle heuristic as a soft navigation, reported separately because
 * a cache restore and a route change are not comparable populations.
 */
export const DURATION_SOURCE_BFCACHE_RESTORE = "bfcache_restore_settled";
/** Restored from the back/forward cache but did not settle within the cap; the duration is the cap. */
export const DURATION_SOURCE_BFCACHE_CAPPED = "bfcache_restore_capped";

/** Document load that was not a reload and not a history traversal. */
export const PAGE_VIEW_TYPE_NAVIGATE = "navigate";
/** Document reload. */
export const PAGE_VIEW_TYPE_RELOAD = "reload";
/** Document restored by a history traversal. */
export const PAGE_VIEW_TYPE_BACK_FORWARD = "back_forward";
/** Document prerendered by the browser before activation. */
export const PAGE_VIEW_TYPE_PRERENDER = "prerender";
/** In-document route change that pushed a new history entry. */
export const PAGE_VIEW_TYPE_PUSH = "push";
/** In-document route change that replaced the current history entry. */
export const PAGE_VIEW_TYPE_REPLACE = "replace";
/** In-document route change caused by a history traversal. */
export const PAGE_VIEW_TYPE_TRAVERSE = "traverse";
