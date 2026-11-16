// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag } from "@opentelemetry/api";
import { SeverityNumber, type LogRecord } from "@opentelemetry/api-logs";
import { InstrumentationBase } from "@opentelemetry/instrumentation";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../shared/constants.js";
import { redactUrl } from "../../shared/urlRedaction.js";
import { getElementContent, getMetadata, getTagName, isDoNotTrack } from "./content.js";
import type {
  ClickAnalyticsInstrumentationConfig,
  ClickAnalyticsPageAction,
  ClickAnalyticsPageActionOverrides,
  ClickAnalyticsProperties,
} from "./types.js";

const NOT_SPECIFIED = "not_specified";
const INPUT_TYPES = new Set(["button", "checkbox", "radio", "reset", "submit"]);
const DEFAULT_ELEMENTS = ["A", "BUTTON", "AREA", "INPUT"];

function assigned(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function contentName(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : NOT_SPECIFIED;
}

function targetUri(element: Element): string {
  const tagName = getTagName(element);
  let value: string | null;
  if (tagName === "A" || tagName === "AREA") {
    const href = (element as HTMLAnchorElement).href;
    if (typeof href === "string" && !href) return "";
    value =
      typeof href === "string"
        ? href
        : (element.getAttribute("href") ??
          element.getAttributeNS("http://www.w3.org/1999/xlink", "href"));
  } else if (tagName === "INPUT" && INPUT_TYPES.has((element as HTMLInputElement).type)) {
    const form = (element as HTMLInputElement).form;
    if (!form) return location.pathname;
    value = Element.prototype.getAttribute.call(form, "action") || element.ownerDocument.URL;
  } else {
    return "";
  }
  if (value === null) return "";
  try {
    return new URL(value, element.baseURI).href;
  } catch {
    // Invalid DOM destinations must not bypass URL redaction or discard the click.
    return "";
  }
}

/**
 * Optional Application Insights-compatible click-content capture using OpenTelemetry logs.
 *
 * @remarks
 * Obtain a deferred instance from `createClickAnalyticsInstrumentation`, or select
 * `clickAnalytics: { enabled: true }` in `getInstrumentations`. Both factories are available from
 * the instrumentations entry point, not the SDK root. Do not also enable `userAction` unless duplicate action records
 * are intended. Each instance owns its listeners and emits through its bound logger provider.
 *
 * @internal
 */
export class ClickAnalyticsInstrumentation extends InstrumentationBase<ClickAnalyticsInstrumentationConfig> {
  // Read by the shared instrumentation ownership guard before providers are bound.
  private enabledState = false;
  #onAction?: EventListener;
  readonly #pendingCleanup = new Set<EventListener>();
  #cleaning = false;
  #metadata: Record<string, string> = {};

  public constructor(config: ClickAnalyticsInstrumentationConfig = {}) {
    // The base constructor otherwise enables before subclass fields have initialized.
    super("@microsoft/opentelemetry-browser/click-analytics", OPENTELEMETRY_BROWSER_VERSION, {
      ...config,
      enabled: false,
    });
    this.setConfig(config);
    if (this.getConfig().enabled) this.enable();
  }

  protected init(): void {}

  /** Applies a replacement configuration and updates automatic capture listeners. */
  public override setConfig(config: ClickAnalyticsInstrumentationConfig): void {
    super.setConfig(config);
    // The base constructor calls setConfig before private fields exist.
    if (this.enabledState) {
      this.disable();
      if (config.enabled !== false) this.enable();
    }
  }

  /** Starts capture; repeated calls do not add duplicate listeners. */
  public enable(): void {
    if (this.enabledState) return;
    this.enabledState = true;
    // Each activation owns a distinct callback so cancelled registration cannot remove a newer one.
    const listener: EventListener = (event) => {
      if (this.#onAction === listener) this.#safely(() => this.#captureAutomatic(event));
    };
    this.#onAction = listener;
    try {
      this.#metadata = getMetadata(this.getConfig());
      if (this.#onAction !== listener) return;
      if (this.getConfig().autoCapture !== false && typeof window !== "undefined") {
        for (const type of ["mousedown", "keyup"]) {
          try {
            window.addEventListener(type, listener);
          } finally {
            // A wrapper can disable/re-enable before it actually installs the old callback.
            if (this.#onAction !== listener) {
              this.#removeListeners(listener);
            }
          }
          if (this.#onAction !== listener) return;
        }
      }
    } catch (error) {
      if (this.#onAction === listener) this.disable();
      throw error;
    }
  }

  /** Removes this instance's listeners and suppresses manual capture until re-enabled. */
  public disable(): void {
    this.enabledState = false;
    const listener = this.#onAction;
    this.#onAction = undefined;
    if (listener) this.#pendingCleanup.add(listener);
    // Snapshot the work so cleanup reentrancy cannot consume a newer activation's listeners.
    for (const pending of [...this.#pendingCleanup]) this.#removeListeners(pending);
  }

  #removeListeners(listener: EventListener): void {
    if (this.#cleaning) {
      this.#pendingCleanup.add(listener);
      return;
    }
    // Remove from the retry queue before invoking application wrappers, which may reenter disable.
    this.#pendingCleanup.delete(listener);
    if (typeof window === "undefined") return;
    this.#cleaning = true;
    try {
      let failed = false;
      for (const type of ["mousedown", "keyup"]) {
        try {
          window.removeEventListener(type, listener);
        } catch {
          // Shutdown may never call disable again; retry once before reporting failure.
          try {
            window.removeEventListener(type, listener);
          } catch {
            failed = true;
          }
        }
      }
      if (failed) {
        this.#pendingCleanup.add(listener);
        diag.warn("Click cleanup failed after retry.");
      }
    } finally {
      this.#cleaning = false;
    }
  }

  /** Captures element content and applies page-action overrides and custom properties. */
  public capturePageAction(
    element: Element,
    overrides: ClickAnalyticsPageActionOverrides = {},
    customProperties: ClickAnalyticsProperties = {},
    isRightClick = false,
  ): void {
    if (!this.enabledState) return;
    this.#safely(() => {
      const config = this.getConfig();
      const content = getElementContent(element, config);
      const validate = config.behaviorValidator ?? ((value: string | number) => value || "");
      let behavior = validate(
        assigned(overrides.behavior)
          ? (overrides.behavior as string | number)
          : (this.#metadata.behavior ?? ""),
      );
      if (isRightClick) behavior = config.defaultRightClickBhvr ?? "";
      if (content.bhvr && !assigned(overrides.behavior)) {
        behavior = validate(content.bhvr as string | number);
        delete content.bhvr;
      }
      const name = contentName(content.id || content.contentName || NOT_SPECIFIED);
      // Upstream uses parentName here, even though extraction produces parentname.
      const parentId = contentName(content.parentid || content.parentName || NOT_SPECIFIED);
      delete content.id;
      delete content.parentid;
      delete content.parentname;
      if (config.dataTags?.parentDataTag) delete content[config.dataTags.parentDataTag];
      const serialized = JSON.stringify([{ ...content, ...overrides.contentTags }]);
      if (
        config.dropInvalidEvents &&
        name === NOT_SPECIFIED &&
        parentId === NOT_SPECIFIED &&
        serialized === "[{}]"
      )
        return;

      const pageTags = {
        ...config.pageTags,
        ...config.callback?.pageActionPageTags?.(element),
        ...overrides.pageTags,
        metaTags: Object.fromEntries(
          Object.entries(this.#metadata).filter(
            ([key]) => !["behavior", "market", "pageType"].includes(key),
          ),
        ),
      };
      let uri = config.coreData?.requestUri;
      if (!uri && typeof location !== "undefined") {
        uri = location.origin + location.pathname;
        // Preserve the upstream hash-before-query order for compatibility.
        if (config.urlCollectHash) uri += location.hash;
        if (config.urlCollectQuery) uri += location.search;
      }
      this.trackPageAction(
        {
          name,
          parentId,
          uri,
          pageName:
            overrides.pageName ||
            (config.callback?.pageName
              ? config.callback.pageName()
              : config.coreData?.pageName || document.title),
          pageType: overrides.pageType || config.coreData?.pageType || this.#metadata.pageType,
          refUri: assigned(overrides.refUri)
            ? overrides.refUri
            : (config.coreData?.referrerUri ?? document.referrer),
          targetUri: overrides.targetUri ?? targetUri(element),
          behavior,
          actionType: overrides.actionType,
          clickCoordinates:
            assigned(overrides.clickCoordinateX) && assigned(overrides.clickCoordinateY)
              ? `${overrides.clickCoordinateX}X${overrides.clickCoordinateY}`
              : undefined,
          content: serialized,
          timeToAction:
            typeof performance !== "undefined" && performance.timeOrigin
              ? Date.now() - performance.timeOrigin
              : -1,
          properties: { pageTags },
        },
        customProperties,
      );
    });
  }

  /** Emits a supplied page action without DOM extraction or invalid-content filtering. */
  public trackPageAction(
    action: ClickAnalyticsPageAction,
    customProperties: ClickAnalyticsProperties = {},
  ): void {
    if (!this.enabledState) return;
    this.#safely(() => {
      const attributes: NonNullable<LogRecord["attributes"]> = {};
      const fields = {
        "browser.click.name": action.name,
        "url.full": action.uri,
        "browser.page_view.name": action.pageName,
        "browser.click.page_type": action.pageType,
        "url.referrer": action.refUri,
        "browser.click.target_url": action.targetUri,
        "browser.click.action_type": action.actionType,
        "browser.click.behavior": action.behavior,
        "browser.click.coordinates": action.clickCoordinates,
        "browser.click.content": action.content,
        "browser.click.time_to_action": action.timeToAction,
        "browser.click.parent_id": action.parentId,
      };
      for (const [key, value] of Object.entries(fields)) {
        if (assigned(value)) attributes[key] = value;
      }
      attributes["browser.click.properties"] = JSON.stringify({
        ...customProperties,
        ...action.properties,
      });
      const record: LogRecord = {
        eventName: "browser.click",
        severityNumber: SeverityNumber.INFO,
        context: context.active(),
        attributes,
      };
      this.getConfig().applyCustomLogRecordData?.(record);
      record.attributes = { ...record.attributes };
      // Protect explicit URLs and hook-added values too; DOM content remains application-owned.
      for (const key of ["url.full", "url.referrer", "browser.click.target_url"]) {
        const outputAttributes = record.attributes;
        const url = outputAttributes?.[key];
        if (!outputAttributes || typeof url !== "string" || !url) continue;
        try {
          outputAttributes[key] = redactUrl(url);
        } catch {
          // Preserve non-URL labels, but fail closed for malformed absolute URLs.
          // eslint-disable-next-line no-control-regex -- URL parsing trims leading ASCII C0/space.
          const normalized = url.replace(/^[\x00-\x20]+|[\t\n\r]/g, "");
          if (/^(?:[a-z][a-z\d+.-]*:|[^\s/?#]*:\/\/)/i.test(normalized)) {
            delete outputAttributes[key];
          }
        }
      }
      if (this.enabledState) this.logger.emit(record);
    });
  }

  #captureAutomatic(event: Event): void {
    if (!this.enabledState) return;
    const config = this.getConfig();
    const key = event as KeyboardEvent;
    const mouse = event as MouseEvent;
    const actionType =
      event.type === "keyup"
        ? key.key === "Enter" || key.keyCode === 13
          ? "KE"
          : key.key === " " || key.keyCode === 32
            ? "KS"
            : undefined
        : ["CL", "CM", "CR"][mouse.button];
    if (!actionType) return;
    const elements = new Set(
      (config.trackElementTypes ?? DEFAULT_ELEMENTS.join(","))
        .toUpperCase()
        .split(",")
        .map((tag) => tag.trim()),
    );
    const path: Element[] = [];
    // Retargeting hides shadow descendants from event.target, but not from the composed path.
    // Form named controls can shadow nodeType; use the native getter on path nodes, not Window.
    const nodeType = Object.getOwnPropertyDescriptor(Node.prototype, "nodeType");
    for (const target of event.composedPath()) {
      if (target !== window && nodeType?.get?.call(target) === 1) {
        const element = target as Element;
        if (isDoNotTrack(element, config, false)) return;
        path.push(element);
      }
    }
    for (let element of path) {
      const control =
        getTagName(element) === "LABEL" ? (element as HTMLLabelElement).control : null;
      if (control && elements.has(getTagName(control))) {
        // An associated control can live outside the event path, so check its ancestors too.
        if (isDoNotTrack(control, config)) return;
        element = control;
      }
      if (!elements.has(getTagName(element))) continue;
      if (getTagName(element) !== "INPUT" || INPUT_TYPES.has((element as HTMLInputElement).type)) {
        this.capturePageAction(
          element,
          {
            actionType,
            clickCoordinateX: mouse.pageX,
            clickCoordinateY: mouse.pageY,
            isAuto: true,
          },
          {},
          actionType === "CR",
        );
      }
      break;
    }
  }

  #safely(callback: () => void): void {
    try {
      callback();
    } catch {
      // Application callbacks, markup, and telemetry errors must not break user interactions.
      diag.warn("Click analytics could not capture a page action.");
    }
  }
}
