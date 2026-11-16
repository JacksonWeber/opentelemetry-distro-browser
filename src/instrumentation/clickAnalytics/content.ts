// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import type { ClickAnalyticsInstrumentationConfig, ClickAnalyticsProperties } from "./types.js";

/** Reads the actual DOM parent, bypassing form named properties. @internal */
export function getParentElement(element: Element): Element | null {
  return Reflect.get(Node.prototype, "parentElement", element);
}

function getAttributes(element: Element): Attr[] {
  return Array.from(Reflect.get(Element.prototype, "attributes", element));
}

function getAttribute(element: Element, name: string): string | null {
  return Element.prototype.getAttribute.call(element, name);
}

/** Reads and normalizes the native tag name despite form named properties. @internal */
export function getTagName(element: Element): string {
  return Reflect.get(Element.prototype, "tagName", element).toUpperCase();
}

function getDataPrefix(config: ClickAnalyticsInstrumentationConfig): string {
  const prefix = config.dataTags?.customDataPrefix;
  return typeof prefix === "string" && prefix.startsWith("data-") ? prefix : "data-";
}

function isAssigned(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function createContent(): ClickAnalyticsProperties {
  // Attribute names and blob keys are untrusted, including __proto__ and constructor.
  return Object.create(null) as ClickAnalyticsProperties;
}

function parseBlob(blob: string): ClickAnalyticsProperties {
  const content = createContent();
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    // Neither the blob nor the parser error is logged: both can disclose page content.
    diag.warn("Click analytics could not parse a content blob.");
    return content;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    diag.warn("Click analytics content blob must be a JSON object.");
    return content;
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      content[key] = value;
    } else if (value !== null && typeof value === "object") {
      content[key] = value;
    }
  }
  return content;
}

function removeEmptyContent(content: ClickAnalyticsProperties): void {
  for (const [key, value] of Object.entries(content)) {
    if (!isAssigned(value) || (typeof value === "object" && JSON.stringify(value) === "{}")) {
      delete content[key];
    }
  }
}

function getText(value: unknown): string {
  // Form named properties can return elements or collections; never coerce those into content.
  return value && (typeof value === "string" || typeof value === "number") ? String(value) : "";
}

function getHtmlContent(
  element: Element | null,
  config: ClickAnalyticsInstrumentationConfig,
): { id: string; contentName: string } {
  if (!element || !config.dataTags?.useDefaultContentNameOrId) {
    return { id: "", contentName: "" };
  }
  // Structural access works with SVG elements and elements from another browser realm.
  const html = element as HTMLElement & {
    text?: unknown;
    value?: unknown;
    name?: unknown;
    alt?: unknown;
  };
  const customizedName = config.callback?.contentName?.(element, true);
  let defaultName: string;
  switch (getTagName(element)) {
    case "A":
      defaultName = getText(html.text) || getText(html.innerHTML);
      break;
    case "IMG":
    case "AREA":
      defaultName = getText(html.alt);
      break;
    default:
      defaultName =
        getText(html.value) ||
        getText(html.name) ||
        getText(html.alt) ||
        getText(html.innerText) ||
        getText(getAttribute(element, "id"));
  }
  return {
    id: getAttribute(element, "id") ?? "",
    contentName:
      customizedName || defaultName.substring(0, 200) || getAttribute(element, "alt") || "",
  };
}

function hasDataAttributes(element: Element, prefix: string): boolean {
  return getAttributes(element).some((attribute) => attribute.name.startsWith(prefix));
}

function collectContent(
  element: Element,
  content: ClickAnalyticsProperties,
  prefix: string,
  parentAttribute: string,
  blobAttribute: string,
): void {
  let current: Element | null = element;
  while (current) {
    let boundaryFound = false;
    for (const attribute of getAttributes(current)) {
      if (!attribute.name.startsWith(prefix)) continue;
      // Include boundary-level attributes before stopping, even for an empty boundary value.
      if (attribute.name.startsWith(parentAttribute)) boundaryFound = true;
      if (attribute.name.startsWith(blobAttribute)) continue;
      const key = attribute.name.substring(prefix.length);
      if (current !== element && key === "id") continue;
      if (!Object.hasOwn(content, key) || !isAssigned(content[key])) {
        content[key] = attribute.value;
      }
    }
    if (boundaryFound) break;
    current = getParentElement(current);
  }
}

function populateParentContent(
  element: Element,
  content: ClickAnalyticsProperties,
  config: ClickAnalyticsInstrumentationConfig,
  prefix: string,
  blobAttribute: string,
): void {
  if (
    (Object.hasOwn(content, "parentid") && content.parentid) ||
    (Object.hasOwn(content, "parentname") && content.parentname)
  ) {
    return;
  }
  // Upstream parent identification is a separate search, not bounded by parentDataTag.
  let parent = getParentElement(element);
  let parentId: ClickAnalyticsProperties[string];
  while (parent) {
    if (hasDataAttributes(parent, prefix)) {
      const blob = getAttribute(parent, blobAttribute);
      if (blob) {
        const parentContent = parseBlob(blob);
        if (Object.hasOwn(parentContent, "id")) parentId = parentContent.id;
      } else {
        parentId = getAttribute(parent, `${prefix}id`) ?? undefined;
      }
      // Only the closest tagged ancestor participates, even if it has no identifier.
      break;
    }
    parent = getParentElement(parent);
  }
  if (parentId) {
    content.parentid = parentId;
  } else {
    const html = getHtmlContent(getParentElement(element), config);
    content.parentid = html.id;
    content.parentname = html.contentName;
  }
}

/**
 * Extracts click content without mutating the element or configuration.
 *
 * @remarks
 * A nonempty blob takes precedence over individual tags and HTML fallbacks. Ancestor data is
 * collected only with a nonempty `parentDataTag`; nearer assigned values win and ancestor `id`
 * tags are excluded. Tagged keys keep DOM casing (normally lowercase), whereas the HTML fallback
 * is named `contentName`. The boundary tag remains for the main capture path to remove.
 *
 * @internal
 */
export function getElementContent(
  element: Element,
  config: ClickAnalyticsInstrumentationConfig,
): ClickAnalyticsProperties {
  if (!element) return createContent();
  const prefix = getDataPrefix(config);
  const blobAttribute = prefix + (config.dataTags?.aiBlobAttributeTag ?? "ai-blob");
  const parentTag = config.dataTags?.parentDataTag;
  const parentAttribute = parentTag ? prefix + parentTag : "";
  const blob = getAttribute(element, blobAttribute);
  let content = createContent();

  if (blob) {
    content = parseBlob(blob);
  } else {
    // An explicitly empty blob still selects upstream's untagged-element path.
    const tracked = blob === null && hasDataAttributes(element, prefix);
    const html = getHtmlContent(element, config);
    if (!tracked) {
      content.id = html.id;
      content.contentName = html.contentName;
    }
    if (parentAttribute) {
      collectContent(element, content, prefix, parentAttribute, blobAttribute);
    } else if (tracked) {
      for (const attribute of getAttributes(element)) {
        if (attribute.name.startsWith(prefix)) {
          content[attribute.name.substring(prefix.length)] = attribute.value;
        }
      }
    }
    if (tracked && config.dataTags?.useDefaultContentNameOrId) {
      if (!Object.hasOwn(content, "id") || !isAssigned(content.id)) content.id = html.id;
      content.contentName = html.contentName;
    }
  }

  removeEmptyContent(content);
  if (parentAttribute) {
    populateParentContent(element, content, config, prefix, blobAttribute);
    removeEmptyContent(content);
  }
  return content;
}

/**
 * Collects named document metadata, retaining prefixes and letting the last duplicate name win.
 * An empty metadata prefix matches all names, as in Application Insights.
 * @internal
 */
export function getMetadata(config: ClickAnalyticsInstrumentationConfig): Record<string, string> {
  if (typeof document === "undefined") return Object.fromEntries([]);
  const prefix = config.dataTags?.metaDataPrefix ?? "";
  return Object.fromEntries(
    Array.from(document.querySelectorAll("meta"))
      .filter(
        (meta) =>
          meta.name && (config.dataTags?.captureAllMetaDataContent || meta.name.startsWith(prefix)),
      )
      .map((meta) => [meta.name, meta.content]),
  );
}

/**
 * Checks the element and its ancestors for a nonempty do-not-track attribute.
 *
 * @remarks
 * Matches upstream's actual value-based behavior, not its misleading presence-based comment:
 * an empty attribute does not suppress capture. Any nonempty value, including `false`, does.
 * This check is independent of the content traversal boundary.
 * Pass `false` for `includeAncestors` when the caller already visits every composed-path element.
 *
 * @internal
 */
export function isDoNotTrack(
  element: Element,
  config: ClickAnalyticsInstrumentationConfig,
  includeAncestors = true,
): boolean {
  const attribute = getDataPrefix(config) + (config.dataTags?.dntDataTag ?? "ai-dnt");
  let current: Element | null = element;
  while (current) {
    if (isAssigned(getAttribute(current, attribute))) return true;
    current = includeAncestors ? getParentElement(current) : null;
  }
  return false;
}
