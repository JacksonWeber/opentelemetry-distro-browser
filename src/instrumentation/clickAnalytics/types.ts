// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LoggerProvider, LogRecord } from "@opentelemetry/api-logs";
import type { InstrumentationConfig } from "@opentelemetry/instrumentation";
import type { BrowserInstrumentation } from "../../types.js";

/**
 * Deferred Click Analytics capture APIs, registered through the browser distribution.
 *
 * @remarks
 * Obtain instances from `createClickAnalyticsInstrumentation`. This interface has no runtime
 * constructor export. Both manual methods are inert until registration and after shutdown.
 *
 * @public
 */
export interface ClickAnalyticsInstrumentation extends BrowserInstrumentation {
  /** Identifies this instrumentation's telemetry scope. */
  readonly instrumentationName: string;
  /** Binds capture to the instance-owned logger provider. */
  setLoggerProvider(provider: LoggerProvider): void;
  /** Returns the current configuration. */
  getConfig(): ClickAnalyticsInstrumentationConfig;
  /** Replaces configuration and updates automatic capture listeners. */
  setConfig(config: ClickAnalyticsInstrumentationConfig): void;
  /** Extracts DOM content and assembles a page action. Manual capture does not enforce DOM DNT. */
  capturePageAction(
    element: Element,
    overrides?: ClickAnalyticsPageActionOverrides,
    customProperties?: ClickAnalyticsProperties,
    isRightClick?: boolean,
  ): void;
  /** Emits a supplied action without DOM extraction, defaulting or invalid-content filtering. */
  trackPageAction(
    action: ClickAnalyticsPageAction,
    customProperties?: ClickAnalyticsProperties,
  ): void;
}

/**
 * Application-defined click content, page tags, or event properties.
 *
 * @remarks
 * Object values are serialized as part of the click payload, not used directly as OpenTelemetry
 * attributes. Do not include personal or sensitive information.
 *
 * @public
 */
export type ClickAnalyticsProperties = Record<
  string,
  string | number | boolean | string[] | number[] | boolean[] | object | undefined
>;

/**
 * Configuration for Application Insights-compatible click analytics.
 *
 * @remarks
 * Tagged DOM content and metadata can contain sensitive information. Review application markup
 * before enabling capture; HTML-derived names and identifiers require an explicit opt-in.
 *
 * @public
 */
export interface ClickAnalyticsInstrumentationConfig extends InstrumentationConfig {
  /** Automatically captures supported mouse and keyboard actions. @defaultValue true */
  readonly autoCapture?: boolean;

  /** Application callbacks used while assembling a page action. */
  readonly callback?: {
    /** Overrides the default page name, including with an empty result. */
    readonly pageName?: () => string;
    /** Adds page tags for the acted-on element. */
    readonly pageActionPageTags?: (element?: Element) => ClickAnalyticsProperties;
    /**
     * Supplies an HTML fallback name when `useDefaultContentNameOrId` is enabled. An empty return
     * value falls back to the default HTML name. Blob content bypasses this callback.
     */
    readonly contentName?: (element?: Element, useDefaultContentName?: boolean) => string;
  };

  /** Page tags included with captured actions. */
  readonly pageTags?: ClickAnalyticsProperties;

  /** Overrides for common page information. */
  readonly coreData?: {
    /** Overrides `document.referrer`. */
    readonly referrerUri?: string;
    /** Overrides the current document URL. */
    readonly requestUri?: string;
    /** Overrides the default page name. */
    readonly pageName?: string;
    /** Overrides the page type obtained from metadata. */
    readonly pageType?: string;
  };

  /** Controls DOM content and metadata collection. Attribute suffixes exclude the data prefix. */
  readonly dataTags?: {
    /**
     * Allows HTML identifiers and names, including input values, as fallbacks. Default names are
     * limited to 200 characters; callback names are not truncated.
     * @defaultValue false
     */
    readonly useDefaultContentNameOrId?: boolean;
    /** Attribute prefix; values not starting with `data-` fall back to `data-`. @defaultValue "data-" */
    readonly customDataPrefix?: string;
    /** JSON content blob attribute suffix. Blob content takes precedence over individual tags. @defaultValue "ai-blob" */
    readonly aiBlobAttributeTag?: string;
    /**
     * Metadata name prefix. Matching names retain their prefix. An empty prefix matches all named
     * meta elements, even when `captureAllMetaDataContent` is false, matching Application Insights.
     * @defaultValue ""
     */
    readonly metaDataPrefix?: string;
    /** Collects all named metadata regardless of `metaDataPrefix`. @defaultValue false */
    readonly captureAllMetaDataContent?: boolean;
    /**
     * Enables ancestor content collection and stops after including an element with an attribute
     * starting with this suffix and the configured prefix. Empty disables ancestor collection.
     * @defaultValue ""
     */
    readonly parentDataTag?: string;
    /**
     * Do-not-track attribute suffix, checked on the element and all its ancestors. Only nonempty
     * values suppress capture: `data-ai-dnt=""` does not, but `data-ai-dnt="false"` does. Use an
     * explicit nonempty value for privacy exclusions; attribute presence alone is insufficient.
     * @defaultValue "ai-dnt"
     */
    readonly dntDataTag?: string;
  };

  /** Validates or maps a behavior value; return an empty string to reject it. */
  readonly behaviorValidator?: (value: string | number) => string | number;
  /** Default right-click behavior, overridden by an explicit behavior tag. */
  readonly defaultRightClickBhvr?: string | number;
  /** Drops actions with no useful name, parent identifier, or content. @defaultValue false */
  readonly dropInvalidEvents?: boolean;
  /** Includes the URL fragment in the collected page URI. @defaultValue false */
  readonly urlCollectHash?: boolean;
  /** Includes the URL query string in the collected page URI. @defaultValue false */
  readonly urlCollectQuery?: boolean;
  /** Comma-separated element names replacing the default A, BUTTON, AREA, and INPUT elements. */
  readonly trackElementTypes?: string;
  /** Modifies the log record immediately before it is emitted. */
  readonly applyCustomLogRecordData?: (record: LogRecord) => void;
}

/**
 * Values supplied when capturing a page action from an element.
 * @public
 */
export interface ClickAnalyticsPageActionOverrides {
  /** Referring page URI. */
  readonly refUri?: string;
  /** Action classification, such as a mouse or keyboard action. */
  readonly actionType?: string;
  /** Destination URI of the acted-on content. */
  readonly targetUri?: string;
  /** Horizontal click position relative to the document. */
  readonly clickCoordinateX?: number;
  /** Vertical click position relative to the document. */
  readonly clickCoordinateY?: number;
  /** Additional content properties, overriding collected properties with the same keys. */
  readonly contentTags?: ClickAnalyticsProperties;
  /** Behavior classification. */
  readonly behavior?: string | number;
  /** Page name. */
  readonly pageName?: string;
  /** Page type. */
  readonly pageType?: string;
  /** Additional page tags. */
  readonly pageTags?: ClickAnalyticsProperties;
  /** Whether the action was captured automatically. */
  readonly isAuto?: boolean;
}

/**
 * A fully specified page action that can be tracked without DOM content extraction.
 * @public
 */
export interface ClickAnalyticsPageAction {
  /** Required action name, normally the content identifier or content name. */
  name: string;
  /** URI identifying the page. */
  uri?: string;
  /** Page name. */
  pageName?: string;
  /** Page type. */
  pageType?: string;
  /** Referring page URI. */
  refUri?: string;
  /** Destination URI. */
  targetUri?: string;
  /** Action classification. */
  actionType?: string;
  /** Behavior classification. */
  behavior?: string | number;
  /** Document-relative coordinates encoded as `xXy`. */
  clickCoordinates?: string;
  /** JSON-formatted array of content objects. */
  content?: string;
  /** Elapsed milliseconds from document navigation to the action. */
  timeToAction?: number;
  /** Identifier of the parent content. */
  parentId?: string;
  /** Additional event properties. */
  properties?: ClickAnalyticsProperties;
}
