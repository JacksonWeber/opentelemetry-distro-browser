// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type LogRecord } from "@opentelemetry/api-logs";
import { InstrumentationBase, safeExecuteInTheMiddle } from "@opentelemetry/instrumentation";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../shared/constants.js";
import { createPageViewContext, generatePageViewId } from "./pageViewContext.js";
import {
  ATTR_PAGE_VIEW_DURATION,
  ATTR_PAGE_VIEW_DURATION_SOURCE,
  ATTR_PAGE_VIEW_ID,
  ATTR_PAGE_VIEW_INDEX,
  ATTR_PAGE_VIEW_NAME,
  ATTR_PAGE_VIEW_NAME_SOURCE,
  ATTR_PAGE_VIEW_REFERRER,
  ATTR_PAGE_VIEW_SAME_DOCUMENT,
  ATTR_PAGE_VIEW_TYPE,
  ATTR_URL_FULL,
  DURATION_SOURCE_DOCUMENT_LOAD,
  DURATION_SOURCE_NAVIGATION_TIMING,
  DURATION_SOURCE_PAGE_HIDE,
  DURATION_SOURCE_BFCACHE_RESTORE,
  DURATION_SOURCE_BFCACHE_CAPPED,
  DURATION_SOURCE_SOFT_CAPPED,
  DURATION_SOURCE_SOFT_INTERRUPTED,
  DURATION_SOURCE_SOFT_SETTLED,
  EVENT_BROWSER_PAGE_VIEW,
  NAME_SOURCE_DOCUMENT_TITLE,
  NAME_SOURCE_EXPLICIT,
  NAME_SOURCE_ROUTE,
  NAME_SOURCE_URL_PATH,
  PAGE_VIEW_TYPE_BACK_FORWARD,
  PAGE_VIEW_TYPE_NAVIGATE,
  PAGE_VIEW_TYPE_PRERENDER,
  PAGE_VIEW_TYPE_PUSH,
  PAGE_VIEW_TYPE_RELOAD,
  PAGE_VIEW_TYPE_REPLACE,
  PAGE_VIEW_TYPE_TRAVERSE,
  SEVERITY_NUMBER_INFO,
} from "./semconv.js";
import {
  type InternalPageViewInstrumentationConfig,
  type PageView,
  type PageViewContext,
  type PageViewDurationSource,
  type PageViewNameSource,
  type PageViewNavigationType,
  type PageViewSource,
} from "./types.js";

/**
 * Instrumentation scope name for the page-view event.
 * @public
 */
export const PAGE_VIEW_INSTRUMENTATION_NAME = "@microsoft/opentelemetry-browser/page-view";

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 1_000;

type SoftNavigationTrigger =
  "pushState" | "replaceState" | "popstate" | "hashchange" | "currententrychange";

interface PendingPageView {
  /**
   * Mutable so a late {@link PageViewInstrumentation.setPageName} can correct the name in place.
   * Callbacks scheduled for this navigation hold the pending object by identity, so replacing it
   * would orphan them and the record would never be emitted.
   */
  pageView: PageView;
  /**
   * The unsanitized URL this navigation landed on, used to tell whether the document still shows
   * this page. `pageView.url` cannot serve: `sanitizeUrl` may rewrite it beyond recognition.
   */
  readonly rawUrl: string;
  /** Monotonic start, from `performance.now()`. */
  readonly startedAt: number;
  capTimerId?: number;
}

/**
 * Minimal structural view of the experimental Navigation API, typed locally because it is absent
 * from the DOM library and must not be reached through an upstream internal path.
 */
interface NavigationApiLike extends EventTarget {
  readonly currentEntry?: { readonly url?: string | null } | null;
}

interface NavigationCurrentEntryChangeEventLike extends Event {
  readonly navigationType?: string | null;
}

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
}

type RequestIdleCallbackLike = (
  callback: (deadline: IdleDeadlineLike) => void,
  options?: { timeout: number },
) => number;

/**
 * Emits one `browser.page_view` log record per navigation: the initial document load, plus every
 * in-document route change in a single-page application.
 *
 * @remarks
 * Upstream `@opentelemetry/browser-instrumentation` has no page-view concept, and its
 * `browser.navigation` event carries no page name, no duration, no referrer and no correlation id.
 * This instrumentation is additive and distribution-owned: it extends the same upstream
 * `InstrumentationBase`, so it composes with the upstream modules instead of replacing them, and
 * it emits portable OpenTelemetry with no backend schema or vendor field names.
 *
 * Running this alongside upstream `NavigationInstrumentation` produces two records per navigation.
 * `browser.page_view` is a superset of the useful content, so prefer enabling one of the two.
 *
 * @example
 * ```ts
 * const pageView = new PageViewInstrumentation({
 *   routeResolver: () => router.currentRoute.value.matched[0]?.path,
 * });
 * const pageViewId = pageView.pageViews.getCurrentPageView()?.id;
 * ```
 *
 * @public
 */
export class PageViewInstrumentation extends InstrumentationBase<InternalPageViewInstrumentationConfig> {
  private enabledState = false;
  private historyPatched = false;
  /**
   * Whether this document's load was already reported. Deliberately not reset by `disable()`: a
   * document loads once, so re-enabling must not emit a second record carrying the same
   * `PerformanceNavigationTiming` duration.
   */
  private documentLoadReported = false;
  private readonly context: PageViewContext;
  private readonly ownsContext: boolean;

  private pending: PendingPageView | undefined;
  private pageViewIndex = 0;
  private lastUrl = "";
  /**
   * `history.length` as of the last navigation this instrumentation observed. A `popstate` that
   * arrives with a higher count appended an entry and is therefore a push, not a traversal.
   */
  private historyLength = 0;
  private explicitName: string | undefined;

  private onLoad: (() => void) | undefined;
  private onPopState: (() => void) | undefined;
  private onHashChange: (() => void) | undefined;
  private onPageHide: (() => void) | undefined;
  private onPageShow: ((event: Event) => void) | undefined;
  private onCurrentEntryChange: ((event: Event) => void) | undefined;
  private ownPushState: unknown;
  private ownReplaceState: unknown;
  /** The target the `currententrychange` listener was attached to, so it can always be removed. */
  private navigationApiTarget: NavigationApiLike | undefined;

  public constructor(config: InternalPageViewInstrumentationConfig = {}) {
    // `InstrumentationBase` calls `enable()` from its own constructor, which runs before this
    // subclass's field initializers. That would observe an undefined page-view context, and the
    // initializers would then overwrite the state `enable()` had just set. Start disabled, finish
    // construction, then honor the caller's setting.
    super(PAGE_VIEW_INSTRUMENTATION_NAME, OPENTELEMETRY_BROWSER_VERSION, {
      ...config,
      enabled: false,
    });
    this.ownsContext = config.pageViewContext === undefined;
    this.context = config.pageViewContext ?? createPageViewContext();
    this.setConfig(config);
    if (this.getConfig().enabled) {
      this.enable();
    }
  }

  /**
   * Read-only page-view seam.
   *
   * @remarks
   * A correlation processor reads the current page-view id from here and stamps it onto the
   * signals it sees. Exposed as {@link PageViewSource} rather than the writable context, so a
   * consumer cannot mint or mutate page views.
   */
  public get pageViews(): PageViewSource {
    return this.context;
  }

  /**
   * Supplies an application-controlled page name, which outranks every other name source.
   *
   * @remarks
   * Applies to the page view currently in flight when it has not been emitted yet, and to every
   * later navigation until changed. For a soft navigation the in-flight window is the settle
   * window, so a router should call this synchronously from its route-change handler. Pass
   * undefined to fall back to route, then title, then path.
   *
   * @param name - The page name, or undefined to clear it.
   */
  public setPageName(name: string | undefined): void {
    this.explicitName = name;
    const pending = this.pending;
    if (pending && name !== undefined && pending.pageView.name !== name) {
      // Mutated in place: callbacks already scheduled for this navigation hold `pending` by
      // identity, so replacing it would strand both the settle path and the cap timer.
      const updated: PageView = { ...pending.pageView, name, nameSource: NAME_SOURCE_EXPLICIT };
      pending.pageView = updated;
      // Republish so a correlation consumer sees the corrected name before the record is emitted.
      this.context.setCurrentPageView(updated);
    }
  }

  protected init(): void {
    // Nothing is patched at module load. This instrumentation observes browser APIs only while it
    // is enabled, so importing it has no side effects.
  }

  public override enable(): void {
    if (this.enabledState) {
      return;
    }
    this.enabledState = true;
    this.lastUrl = location.href;
    this.historyLength = history.length;

    const navigationApi = this.getNavigationApi();
    if (navigationApi) {
      this.onCurrentEntryChange = (event: Event): void => {
        this.handleSoftNavigation("currententrychange", event);
      };
      // Remember the target: config is publicly replaceable through `setConfig`, so re-deriving
      // it in `disable()` could return undefined and strand the listener.
      this.navigationApiTarget = navigationApi;
      navigationApi.addEventListener("currententrychange", this.onCurrentEntryChange);
    } else {
      if (!this.historyPatched) {
        this._wrap(history, "pushState", this.patchHistoryMethod("pushState"));
        this._wrap(history, "replaceState", this.patchHistoryMethod("replaceState"));
        // Remember the exact functions installed, so `disable()` can tell whether it is still the
        // outermost wrapper before unwrapping.
        this.ownPushState = Reflect.get(history, "pushState");
        this.ownReplaceState = Reflect.get(history, "replaceState");
        this.historyPatched = true;
      }
      this.onPopState = (): void => {
        this.handleSoftNavigation("popstate");
      };
      window.addEventListener("popstate", this.onPopState);
      this.onHashChange = (): void => {
        this.handleSoftNavigation("hashchange");
      };
      window.addEventListener("hashchange", this.onHashChange);
    }

    // A soft navigation that never settles would otherwise be lost when the user leaves.
    this.onPageHide = (): void => {
      this.settle(DURATION_SOURCE_PAGE_HIDE);
    };
    window.addEventListener("pagehide", this.onPageHide);

    // A restore from the back/forward cache reuses the document, so nothing else here fires: no
    // load event, no history entry change. Without this the user is looking at a page that
    // produced no page view, and every signal they generate is stamped with the correlation id of
    // the visit they made before they navigated away.
    this.onPageShow = (event: Event): void => {
      if ((event as PageTransitionEvent).persisted) {
        this.handleBackForwardRestore();
      }
    };
    window.addEventListener("pageshow", this.onPageShow);

    this.startHardNavigation();
  }

  public override disable(): void {
    if (!this.enabledState) {
      return;
    }
    this.enabledState = false;

    if (this.onLoad) {
      window.removeEventListener("load", this.onLoad);
      this.onLoad = undefined;
    }
    if (this.onPopState) {
      window.removeEventListener("popstate", this.onPopState);
      this.onPopState = undefined;
    }
    if (this.onHashChange) {
      window.removeEventListener("hashchange", this.onHashChange);
      this.onHashChange = undefined;
    }
    if (this.onPageHide) {
      window.removeEventListener("pagehide", this.onPageHide);
      this.onPageHide = undefined;
    }
    if (this.onPageShow) {
      window.removeEventListener("pageshow", this.onPageShow);
      this.onPageShow = undefined;
    }
    if (this.onCurrentEntryChange) {
      this.navigationApiTarget?.removeEventListener(
        "currententrychange",
        this.onCurrentEntryChange,
      );
      this.onCurrentEntryChange = undefined;
      this.navigationApiTarget = undefined;
    }
    if (this.historyPatched) {
      // Unwrap only while this instance is still the outermost wrapper. `history` is global: if
      // another instance wrapped after this one, unwrapping here restores the function this
      // instance wrapped and silently deletes the other instance's wrapper with it. Leaving the
      // wrapper installed is harmless, because it checks `enabledState` and passes straight
      // through once disabled, and `historyPatched` stays set so a re-enable does not stack a
      // second wrapper on top.
      const outermost =
        Reflect.get(history, "pushState") === this.ownPushState &&
        Reflect.get(history, "replaceState") === this.ownReplaceState;
      if (outermost) {
        this._unwrap(history, "pushState");
        this._unwrap(history, "replaceState");
        this.ownPushState = undefined;
        this.ownReplaceState = undefined;
        this.historyPatched = false;
      }
    }

    // Drop rather than emit. Distribution shutdown disables instrumentations before providers, and
    // a truncated record produced by shutdown is noise rather than signal.
    this.clearPending();
    if (this.ownsContext) {
      this.context.clear();
    }
    // `pageViewIndex` is not reset: it is an ordinal within the document's lifetime, and
    // restarting it would make a re-enabled instrumentation emit indices that collide with the
    // ones it already reported.
  }

  private startHardNavigation(): void {
    if (this.documentLoadReported) {
      // Re-enabled within the same document. The load happened once and was already reported, so
      // there is nothing to observe until the next route change.
      return;
    }
    const timing = this.getNavigationTiming();
    const documentNavigation = this.begin({
      navigationType: this.mapHardNavigationType(timing?.type),
      sameDocument: false,
      referrer: document.referrer,
      // Anchor to the navigation start the browser reports, not to when the SDK initialized.
      startTimeUnixMs: performance.timeOrigin + (timing?.startTime ?? 0),
      startedAt: timing?.startTime ?? 0,
    });

    if (document.readyState === "complete") {
      this.scheduleMacrotask(() => {
        this.finalizeHardNavigation(documentNavigation);
      });
      return;
    }
    this.onLoad = (): void => {
      // `loadEventEnd` is populated only after the load event finishes dispatching.
      this.scheduleMacrotask(() => {
        this.finalizeHardNavigation(documentNavigation);
      });
    };
    window.addEventListener("load", this.onLoad, { once: true });
  }

  /**
   * Ends the document navigation with its browser-reported load duration.
   *
   * @param target - The navigation this callback was scheduled for. A soft navigation can start
   * before `load` fires, and that one has no document load duration, so anything but the original
   * navigation is left alone for its own settle path to finish.
   */
  private finalizeHardNavigation(target: PendingPageView): void {
    if (!this.enabledState || this.pending !== target) {
      return;
    }
    const timing = this.getNavigationTiming();
    if (timing && timing.loadEventEnd > 0) {
      this.emit(target, timing.loadEventEnd - timing.startTime, DURATION_SOURCE_NAVIGATION_TIMING);
      return;
    }
    this.emit(target, performance.now() - target.startedAt, DURATION_SOURCE_DOCUMENT_LOAD);
  }

  private getNavigationTiming(): PerformanceNavigationTiming | undefined {
    if (typeof performance?.getEntriesByType !== "function") {
      return undefined;
    }
    const [entry] = performance.getEntriesByType("navigation");
    return entry as PerformanceNavigationTiming | undefined;
  }

  private mapHardNavigationType(type: string | undefined): PageViewNavigationType {
    switch (type) {
      case "reload":
        return PAGE_VIEW_TYPE_RELOAD;
      case "back_forward":
        return PAGE_VIEW_TYPE_BACK_FORWARD;
      case "prerender":
        return PAGE_VIEW_TYPE_PRERENDER;
      default:
        // Also covers a missing navigation entry: a document exists, so it was navigated to.
        return PAGE_VIEW_TYPE_NAVIGATE;
    }
  }

  private getNavigationApi(): NavigationApiLike | undefined {
    if (!this.getConfig().useNavigationApiIfAvailable) {
      return undefined;
    }
    return (globalThis as { navigation?: NavigationApiLike }).navigation;
  }

  private patchHistoryMethod(
    trigger: "pushState" | "replaceState",
  ): (original: History["pushState"]) => History["pushState"] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const instrumentation = this;
    return (original: History["pushState"]): History["pushState"] => {
      return function patchedHistoryMethod(
        this: History,
        ...args: Parameters<History["pushState"]>
      ): void {
        if (!instrumentation.enabledState) {
          original.apply(this, args);
          return;
        }
        original.apply(this, args);
        // Keep the entry count in step even when the call does not start a page view, so a later
        // traversal is not mistaken for a push against a stale count.
        instrumentation.historyLength = history.length;
        if (location.href !== instrumentation.lastUrl) {
          instrumentation.handleSoftNavigation(trigger);
        }
      };
    };
  }

  private handleSoftNavigation(
    trigger: SoftNavigationTrigger,
    event?: NavigationCurrentEntryChangeEventLike,
  ): void {
    if (!this.enabledState) {
      return;
    }
    const previousUrl = this.lastUrl;
    // Read before anything else: the count is only meaningful relative to the last navigation.
    const historyGrew = history.length > this.historyLength;
    this.historyLength = history.length;
    const currentUrl =
      trigger === "currententrychange"
        ? (this.getNavigationApi()?.currentEntry?.url ?? location.href)
        : location.href;
    if (currentUrl === previousUrl) {
      return;
    }

    // Close out whatever was in flight first, so exactly one record is emitted per navigation.
    this.settle(DURATION_SOURCE_SOFT_INTERRUPTED);

    this.begin({
      navigationType: this.mapSoftNavigationType(trigger, historyGrew, event),
      sameDocument: true,
      referrer: previousUrl,
      url: currentUrl,
      startTimeUnixMs: Date.now(),
      startedAt: performance.now(),
    });
    this.scheduleSoftSettle();
  }

  /**
   * Starts a page view for a document restored from the back/forward cache.
   *
   * @remarks
   * The document, and every module-level variable in it, survives the round trip, so this mints a
   * fresh id: the restored visit is a separate page view and must not inherit the correlation id
   * of the visit that preceded it. `documentLoadReported` stays set, because the load itself
   * happened once and was already reported.
   */
  private handleBackForwardRestore(): void {
    // The page was hidden on the way into the cache, which already settled anything in flight.
    this.settle(DURATION_SOURCE_PAGE_HIDE);

    this.begin({
      navigationType: PAGE_VIEW_TYPE_BACK_FORWARD,
      sameDocument: false,
      // No referrer. `document.referrer` is frozen at the document's original load, so on a
      // restore it names whatever referred the user here the first time -- which the document-load
      // record already reported. Repeating it here would claim a fresh arrival from that site that
      // never happened, and the page actually navigated back from is not exposed to the restored
      // document. An omitted attribute is the honest answer; an empty referrer is dropped by
      // `emit`.
      referrer: "",
      startTimeUnixMs: Date.now(),
      startedAt: performance.now(),
    });
    // No load event fires on a restore, so the observed settle heuristic supplies the duration.
    this.scheduleSoftSettle(DURATION_SOURCE_BFCACHE_RESTORE, DURATION_SOURCE_BFCACHE_CAPPED);
  }

  private mapSoftNavigationType(
    trigger: SoftNavigationTrigger,
    historyGrew: boolean,
    event?: NavigationCurrentEntryChangeEventLike,
  ): PageViewNavigationType {
    if (trigger === "currententrychange") {
      switch (event?.navigationType) {
        case "traverse":
          return PAGE_VIEW_TYPE_TRAVERSE;
        case "replace":
          return PAGE_VIEW_TYPE_REPLACE;
        case "reload":
          return PAGE_VIEW_TYPE_RELOAD;
        default:
          return PAGE_VIEW_TYPE_PUSH;
      }
    }
    if (trigger === "replaceState") {
      return PAGE_VIEW_TYPE_REPLACE;
    }
    if (trigger === "pushState") {
      return PAGE_VIEW_TYPE_PUSH;
    }
    // `popstate` and `hashchange` cannot be told apart by name. Assigning `location.hash` pushes a
    // new entry, yet Chromium fires `popstate` for it exactly as it does for a real traversal, so
    // classifying by the event alone reports every fragment link as back/forward navigation. The
    // entry count is the available signal: a push appends an entry, a traversal moves between
    // entries that already exist.
    return historyGrew ? PAGE_VIEW_TYPE_PUSH : PAGE_VIEW_TYPE_TRAVERSE;
  }

  /**
   * Schedules the end of a soft-navigation duration.
   *
   * @remarks
   * The browser reports no duration for an in-document route change, so this approximates one:
   * wait two animation frames, which lands after the first paint reflecting the new route, then
   * wait for the first idle callback, which lands after the synchronous work that paint triggered
   * has drained. A cap timer bounds the wait.
   *
   * @param settledSource - Duration source to report when the settle heuristic completes.
   * @param cappedSource - Duration source to report when the cap timer fires first.
   */
  private scheduleSoftSettle(
    settledSource: PageViewDurationSource = DURATION_SOURCE_SOFT_SETTLED,
    cappedSource: PageViewDurationSource = DURATION_SOURCE_SOFT_CAPPED,
  ): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    const timeout = this.getConfig().softNavigationSettleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    pending.capTimerId = window.setTimeout(() => {
      this.emit(pending, timeout, cappedSource);
    }, timeout);

    const afterPaint = (): void => {
      if (this.pending !== pending) {
        return;
      }
      this.whenIdle(() => {
        this.emit(pending, performance.now() - pending.startedAt, settledSource);
      });
    };

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        requestAnimationFrame(afterPaint);
      });
    } else {
      this.scheduleMacrotask(afterPaint);
    }
  }

  private whenIdle(callback: () => void): void {
    const requestIdle = (globalThis as { requestIdleCallback?: RequestIdleCallbackLike })
      .requestIdleCallback;
    if (typeof requestIdle === "function") {
      requestIdle(
        () => {
          callback();
        },
        { timeout: IDLE_TIMEOUT_MS },
      );
      return;
    }
    this.scheduleMacrotask(callback);
  }

  private scheduleMacrotask(callback: () => void): void {
    window.setTimeout(callback, 0);
  }

  /** Starts a new page view and publishes it. Returns the pending record callbacks should target. */
  private begin(input: {
    navigationType: PageViewNavigationType;
    sameDocument: boolean;
    referrer: string;
    url?: string;
    startTimeUnixMs: number;
    startedAt: number;
  }): PendingPageView {
    const config = this.getConfig();
    const rawUrl = input.url ?? location.href;
    const resolved = this.resolveName();

    const pageView: PageView = {
      id: this.mintId(config.generatePageViewId),
      index: this.pageViewIndex++,
      name: resolved.name,
      nameSource: resolved.source,
      url: this.sanitize(rawUrl),
      referrer: input.referrer ? this.sanitize(input.referrer) : "",
      navigationType: input.navigationType,
      sameDocument: input.sameDocument,
      startTimeUnixMs: input.startTimeUnixMs,
    };

    this.lastUrl = rawUrl;
    const pending: PendingPageView = { pageView, rawUrl, startedAt: input.startedAt };
    this.pending = pending;
    // Publish before the record is emitted, so signals produced during the navigation correlate.
    this.context.setCurrentPageView(pageView);
    return pending;
  }

  /**
   * Applies the `sanitizeUrl` hook.
   *
   * @remarks
   * Returns an empty string when the hook fails or returns a non-string, and the caller then omits
   * the URL entirely. Falling back to the unmodified URL would publish exactly the credentials or
   * personal data the hook exists to strip, so a broken redactor drops the field instead.
   *
   * This runs synchronously inside the application's own `history.pushState` call, so it must
   * never propagate.
   */
  private sanitize(url: string): string {
    const sanitize = this.getConfig().sanitizeUrl;
    if (!sanitize) {
      return url;
    }
    const result = safeExecuteInTheMiddle(
      () => sanitize(url),
      (error) => {
        if (error) {
          this._diag.error("sanitizeUrl hook failed; dropping the URL", error);
        }
      },
      true,
    );
    return typeof result === "string" ? result : "";
  }

  /** Mints a page-view id, falling back to the built-in generator if a supplied one throws. */
  private mintId(generate: (() => string) | undefined): string {
    if (!generate) {
      return generatePageViewId();
    }
    const result = safeExecuteInTheMiddle(
      () => generate(),
      (error) => {
        if (error) {
          this._diag.error("generatePageViewId hook failed", error);
        }
      },
      true,
    );
    return typeof result === "string" && result ? result : generatePageViewId();
  }

  /**
   * Resolves the page name from the first source that produces one.
   */
  private resolveName(): { name: string; source: PageViewNameSource } {
    const explicit = this.explicitName;
    if (explicit) {
      return { name: explicit, source: NAME_SOURCE_EXPLICIT };
    }

    const routeResolver = this.getConfig().routeResolver;
    if (routeResolver) {
      const route = safeExecuteInTheMiddle(
        () => routeResolver(),
        (error) => {
          if (error) {
            this._diag.error("routeResolver hook failed", error);
          }
        },
        true,
      );
      if (route) {
        return { name: route, source: NAME_SOURCE_ROUTE };
      }
    }

    const title = document.title;
    if (title) {
      return { name: title, source: NAME_SOURCE_DOCUMENT_TITLE };
    }

    return { name: location.pathname, source: NAME_SOURCE_URL_PATH };
  }

  /**
   * Re-resolves the name of a page view that was interrupted before it settled.
   *
   * @remarks
   * Its sources went stale at different moments. `location` advanced synchronously with the
   * navigation that replaced this page view, so the pathname already describes somewhere it was
   * never at and is not read. The title is committed by the router when a route renders, and the
   * replacing route has not rendered yet, so it still describes this page and is worth reading:
   * that is the whole point, because the title a router sets for a route arrives after the
   * navigation that started it and would otherwise never be picked up.
   *
   * The `routeResolver` hook is not called again either. It is application code of unknown
   * timing, and a resolver that reads `location` would return the successor's route. A route that
   * was already resolved is kept as it is, rather than being downgraded to a title.
   */
  private resolveInterruptedName(
    pending: PendingPageView,
  ): { name: string; source: PageViewNameSource } | undefined {
    const explicit = this.explicitName;
    if (explicit) {
      return { name: explicit, source: NAME_SOURCE_EXPLICIT };
    }

    const source = pending.pageView.nameSource;
    if (source === NAME_SOURCE_EXPLICIT || source === NAME_SOURCE_ROUTE) {
      return undefined;
    }

    const title = document.title;
    return title ? { name: title, source: NAME_SOURCE_DOCUMENT_TITLE } : undefined;
  }

  /** Ends whatever page view is in flight, if any, with the supplied reason. */
  private settle(source: PageViewDurationSource): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.emit(pending, performance.now() - pending.startedAt, source);
  }

  /**
   * Resolves the page name a final time, now that the navigation has settled.
   *
   * @remarks
   * A router commits its route and title *after* the URL changes, so the name captured when the
   * navigation started belongs to the previous page and has to be read again before the record is
   * emitted.
   *
   * When the page view is interrupted, it is emitted from the handler for the navigation that
   * replaced it, at which point `location` has already advanced while the title has not. See
   * {@link resolveInterruptedName} for which sources are still trustworthy at that moment.
   *
   * Republishes through the context when the name changed, so a correlation consumer holding the
   * page view sees the same name that is about to be emitted rather than the provisional one.
   */
  private finalizeName(pending: PendingPageView): PageView {
    const resolved =
      location.href === pending.rawUrl ? this.resolveName() : this.resolveInterruptedName(pending);
    if (
      !resolved ||
      (resolved.name === pending.pageView.name && resolved.source === pending.pageView.nameSource)
    ) {
      return pending.pageView;
    }
    const updated: PageView = {
      ...pending.pageView,
      name: resolved.name,
      nameSource: resolved.source,
    };
    pending.pageView = updated;
    this.context.setCurrentPageView(updated);
    return updated;
  }

  private emit(
    pending: PendingPageView,
    durationMs: number,
    durationSource: PageViewDurationSource,
  ): void {
    if (this.pending !== pending) {
      return;
    }
    this.clearPending();

    if (!pending.pageView.sameDocument) {
      // Records the document load exactly once, whichever path closed it out.
      this.documentLoadReported = true;
    }

    // Re-resolve: a router typically sets `document.title` and commits its route *after* the URL
    // changes, so the name captured when the navigation started is the previous page's. Resolving
    // again here, once the navigation has settled, is what makes the name describe this page.
    const pageView = this.finalizeName(pending);
    const logRecord: LogRecord = {
      eventName: EVENT_BROWSER_PAGE_VIEW,
      severityNumber: SEVERITY_NUMBER_INFO,
      timestamp: pageView.startTimeUnixMs,
      attributes: {
        // Omitted when the sanitizer dropped it, rather than reported as an empty string.
        ...(pageView.url ? { [ATTR_URL_FULL]: pageView.url } : {}),
        [ATTR_PAGE_VIEW_ID]: pageView.id,
        [ATTR_PAGE_VIEW_INDEX]: pageView.index,
        [ATTR_PAGE_VIEW_NAME]: pageView.name,
        [ATTR_PAGE_VIEW_NAME_SOURCE]: pageView.nameSource,
        [ATTR_PAGE_VIEW_DURATION]: Math.max(0, durationMs),
        [ATTR_PAGE_VIEW_DURATION_SOURCE]: durationSource,
        [ATTR_PAGE_VIEW_TYPE]: pageView.navigationType,
        [ATTR_PAGE_VIEW_SAME_DOCUMENT]: pageView.sameDocument,
        ...(pageView.referrer ? { [ATTR_PAGE_VIEW_REFERRER]: pageView.referrer } : {}),
      },
    };

    const hook = this.getConfig().applyCustomLogRecordData;
    if (hook) {
      safeExecuteInTheMiddle(
        () => {
          hook(logRecord);
        },
        (error) => {
          if (error) {
            this._diag.error("applyCustomLogRecordData hook failed", error);
          }
        },
        true,
      );
    }

    // The log pipeline is application-supplied and reached synchronously from the app's own
    // `history.pushState`, so a throwing processor or exporter must not break navigation.
    safeExecuteInTheMiddle(
      () => {
        this.logger.emit(logRecord);
      },
      (error) => {
        if (error) {
          this._diag.error("failed to emit a page-view record", error);
        }
      },
      true,
    );
  }
  private clearPending(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    if (pending.capTimerId !== undefined) {
      clearTimeout(pending.capTimerId);
    }
    this.pending = undefined;
  }
}
