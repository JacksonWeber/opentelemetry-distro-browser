// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Attributes } from "@opentelemetry/api";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { generatePageViewId } from "../instrumentation/pageView/pageViewContext.js";
import {
  ATTR_PAGE_VIEW_DURATION,
  ATTR_PAGE_VIEW_ID,
  ATTR_PAGE_VIEW_NAME,
  ATTR_PAGE_VIEW_REFERRER,
  EVENT_BROWSER_PAGE_VIEW,
} from "../instrumentation/pageView/semconv.js";
import {
  createEnvelope,
  createTags,
  hrTimeToDate,
  mapAttributes,
  millisecondsToTimeSpan,
  serializeAttribute,
} from "./common.js";
import {
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  EXCEPTION_TYPE,
  MAX_BEACON_BODY_SIZE,
  NAVIGATION_DURATION,
  NAVIGATION_EVENT_NAME,
  URL_FULL,
  DEFAULT_LOG_MESSAGE,
} from "./constants.js";
import type {
  AzureMonitorEnvelope,
  CustomEventData,
  ExceptionData,
  MessageData,
  PageViewData,
  SeverityLevel,
  StackFrame,
} from "./telemetryModels.js";
import {
  ATTR_ENDUSER_ID,
  ATTR_ENDUSER_PSEUDO_ID,
  ATTR_USER_ACCOUNT_ID,
  ATTR_USER_ID,
} from "../user/constants.js";

const promotedLogAttributes = /* @__PURE__ */ new Set([
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  EXCEPTION_TYPE,
  NAVIGATION_DURATION,
  ATTR_ENDUSER_ID,
  ATTR_ENDUSER_PSEUDO_ID,
  ATTR_USER_ACCOUNT_ID,
  ATTR_USER_ID,
]);
const promotedPageViewAttributes = /* @__PURE__ */ new Set([
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  EXCEPTION_TYPE,
  NAVIGATION_DURATION,
  ATTR_PAGE_VIEW_DURATION,
  ATTR_PAGE_VIEW_ID,
  ATTR_PAGE_VIEW_NAME,
  ATTR_PAGE_VIEW_REFERRER,
  URL_FULL,
  ATTR_ENDUSER_ID,
  ATTR_ENDUSER_PSEUDO_ID,
  ATTR_USER_ACCOUNT_ID,
  ATTR_USER_ID,
]);
// Azure Monitor ExceptionDetails schema limits (character lengths).
const MAX_EXCEPTION_TYPE_LENGTH = 1024;
const MAX_EXCEPTION_MESSAGE_LENGTH = 32 * 1024;
const MAX_EXCEPTION_STACK_LENGTH = 32 * 1024;
const MAX_STACK_FRAME_FIELD_LENGTH = 1024;
// Distro byte budgets that keep the raw and parsed stacks from crowding out each other.
const MAX_EXCEPTION_STACK_SIZE_IN_BYTES = 32 * 1024;
const MAX_PARSED_STACK_SIZE_IN_BYTES = 32 * 1024;
// Budgets core exception data (message, stack, parsed frames) to fit the unload beacon limit.
// Custom fields are intentionally excluded: they are optional, so during unload the exporter's
// custom-field fitting drops the largest ones first instead of truncating the exception here.
const MAX_EXCEPTION_ENVELOPE_SIZE_IN_BYTES = MAX_BEACON_BODY_SIZE;
let textEncoder: TextEncoder | undefined;

function isPageView(eventName: string | undefined): boolean {
  return eventName === EVENT_BROWSER_PAGE_VIEW || eventName === NAVIGATION_EVENT_NAME;
}

function mapSeverity(severityNumber: number | undefined): SeverityLevel | undefined {
  if (!severityNumber || severityNumber < 1 || severityNumber > 24) return undefined;
  if (severityNumber < 9) return 0;
  if (severityNumber < 13) return 1;
  if (severityNumber < 17) return 2;
  if (severityNumber < 21) return 3;
  return 4;
}

function getUtf8Size(value: string): number {
  textEncoder ??= new TextEncoder();
  return textEncoder.encode(value).byteLength;
}

function truncateToLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function truncateJsonStringToSize(value: string, maxSizeInBytes: number): string | undefined {
  if (maxSizeInBytes < 2) return undefined;
  if (getUtf8Size(JSON.stringify(value)) <= maxSizeInBytes) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (getUtf8Size(JSON.stringify(truncateToLength(value, middle))) <= maxSizeInBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return truncateToLength(value, low);
}

function isLikelyCodeSource(source: string): boolean {
  return (
    source.includes("://") ||
    source.includes("/") ||
    source.includes("\\") ||
    /\.(?:[cm]?js|jsx|ts|tsx|wasm|html?)$/i.test(source)
  );
}

// Firefox function names may contain "/" (e.g. "outer/inner", "Foo/<"), but a path or URL that
// itself contains "@" (e.g. "node_modules/@scope/pkg.js") must not be split at the "@".
function isLikelyAtFunctionName(prefix: string): boolean {
  return !/:\/\/|\\|^[./]|\/$/.test(prefix);
}

function parseStackFrame(trimmed: string, level: number): StackFrame | undefined {
  const locationWithColumn = /:(\d+):\d+\)?$/.exec(trimmed);
  const location = locationWithColumn ?? /:(\d+)\)?$/.exec(trimmed);
  if (!location) return undefined;

  const prefix = trimmed.slice(0, location.index);
  const openParenthesis = prefix.indexOf(" (");
  const startsWithAt = trimmed.startsWith("at ");
  const atSign = trimmed.indexOf("@");
  const atPrefix = atSign >= 0 ? trimmed.slice(0, atSign) : "";
  const atSource =
    atSign >= 0 && atSign < location.index ? trimmed.slice(atSign + 1, location.index) : "";
  const hasAtLocation =
    !startsWithAt &&
    atSign >= 0 &&
    atSign < location.index &&
    isLikelyAtFunctionName(atPrefix) &&
    isLikelyCodeSource(atSource);
  const bareSource = trimmed.slice(0, location.index);
  const isBareSourceLocation =
    !bareSource.includes(" ") && isLikelyCodeSource(bareSource.replace(/\)?$/, ""));
  const hasParenthesizedLocation =
    openParenthesis >= 0 && isLikelyCodeSource(prefix.slice(openParenthesis + 2));
  if (!startsWithAt && !hasAtLocation && !isBareSourceLocation && !hasParenthesizedLocation) {
    return undefined;
  }

  let method = "<no_method>";
  let fileName = prefix.replace(/^\s*at\s+/, "").trim();
  if (openParenthesis >= 0) {
    method =
      prefix
        .slice(0, openParenthesis)
        .replace(/^\s*at\s+/, "")
        .trim() || method;
    fileName = prefix.slice(openParenthesis + 2).trim();
  } else if (hasAtLocation) {
    method =
      prefix
        .slice(0, atSign)
        .replace(/^\s*at\s+/, "")
        .trim() || method;
    fileName = prefix.slice(atSign + 1).trim();
  } else if (startsWithAt) {
    const separator = fileName.lastIndexOf(" ");
    if (separator >= 0) {
      method = fileName.slice(0, separator).trim() || method;
      fileName = fileName.slice(separator + 1).trim();
    }
  }
  if (!fileName) return undefined;
  const line = Number(location[1]);
  if (!Number.isSafeInteger(line)) return undefined;

  return {
    level,
    method: truncateToLength(method, MAX_STACK_FRAME_FIELD_LENGTH),
    assembly: truncateToLength(trimmed, MAX_STACK_FRAME_FIELD_LENGTH),
    fileName: truncateToLength(fileName, MAX_STACK_FRAME_FIELD_LENGTH),
    line,
  };
}

/**
 * Parses stack frames into at most `maxSizeInBytes` of JSON, keeping frames from both ends.
 *
 * Neither end of the capped result can contain more than `maxSizeInBytes` of frames, so only the
 * longest head prefix and tail suffix within that budget are retained while streaming. Memory stays
 * proportional to the budget rather than to the raw stack.
 */
function parseStack(stack: string, maxSizeInBytes: number): readonly StackFrame[] | undefined {
  const head: StackFrame[] = [];
  const headSizes: number[] = [];
  let headSize = 2;
  let headComplete = true;
  let tail: StackFrame[] = [];
  let tailSizes: number[] = [];
  let tailStart = 0;
  let tailSize = 2;
  let frameCount = 0;

  for (let start = 0; start <= stack.length;) {
    const newline = stack.indexOf("\n", start);
    const end = newline < 0 ? stack.length : newline;
    const frame = parseStackFrame(stack.slice(start, end).trim(), frameCount);
    start = end + 1;
    if (!frame) continue;
    frameCount++;

    const size = getUtf8Size(JSON.stringify(frame));
    if (headComplete && headSize + (head.length > 0 ? 1 : 0) + size <= maxSizeInBytes) {
      headSize += (head.length > 0 ? 1 : 0) + size;
      head.push(frame);
      headSizes.push(size);
    } else {
      headComplete = false;
    }

    tailSize += (tail.length > tailStart ? 1 : 0) + size;
    tail.push(frame);
    tailSizes.push(size);
    while (tailSize > maxSizeInBytes && tailStart < tail.length) {
      tailSize -= tailSizes[tailStart] + (tail.length - tailStart > 1 ? 1 : 0);
      tailStart++;
    }
    if (tailStart > 64 && tailStart * 2 > tail.length) {
      tail = tail.slice(tailStart);
      tailSizes = tailSizes.slice(tailStart);
      tailStart = 0;
    }
  }

  if (frameCount === 0) return undefined;
  if (headComplete) return head;

  // Merge the windows. Frames between them (or after the head, if no tail frame fits) were dropped,
  // so the capping loop below must stop at that gap, exactly as it would on reaching a frame that
  // cannot fit within the budget.
  const frames = head.slice();
  const sizes = headSizes.slice();
  let gapIndex = head.length;
  for (let index = tailStart; index < tail.length; index++) {
    if (tail[index].level < head.length) continue;
    if (frames.length === head.length && tail[index].level === head.length) gapIndex = -1;
    frames.push(tail[index]);
    sizes.push(tailSizes[index]);
  }

  const first: StackFrame[] = [];
  const last: StackFrame[] = [];
  let selectedSize = 2;
  let left = 0;
  let right = frames.length - 1;
  while (left <= right && left !== gapIndex && right !== gapIndex - 1) {
    const isPair = left !== right;
    const addedSize =
      sizes[left] +
      (isPair ? sizes[right] : 0) +
      (first.length + last.length === 0 ? 0 : 1) +
      (isPair ? 1 : 0);
    if (selectedSize + addedSize > maxSizeInBytes) break;
    first.push(frames[left]);
    if (isPair) last.push(frames[right]);
    selectedSize += addedSize;
    left++;
    right--;
  }

  const capped = [...first, ...last.reverse()];
  // Preserve original levels so gaps identify frames omitted from the middle by byte capping.
  return capped.length === 0 ? undefined : capped;
}

/**
 * Builds a single ExceptionDetails entry whose JSON fits in `maxSizeInBytes`.
 *
 * Fields are first truncated to Azure Monitor schema lengths. The remaining byte budget is then
 * allocated in priority order: type name, raw stack (up to its distro byte cap), message, and
 * finally parsed frames from whatever space is left.
 */
function createExceptionDetails(
  attributes: ReadableLogRecord["attributes"],
  body: ReadableLogRecord["body"],
  maxSizeInBytes: number,
): ExceptionData["exceptions"][number] {
  const stack = attributes[EXCEPTION_STACKTRACE];
  const serializedStack = stack === undefined ? undefined : serializeAttribute(stack);
  const typeName = truncateToLength(
    serializeAttribute(attributes[EXCEPTION_TYPE] ?? "Error"),
    MAX_EXCEPTION_TYPE_LENGTH,
  );
  const schemaLimitedMessage = truncateToLength(
    serializeAttribute(attributes[EXCEPTION_MESSAGE] ?? body ?? "Exception"),
    MAX_EXCEPTION_MESSAGE_LENGTH,
  );
  const schemaLimitedStack =
    serializedStack === undefined
      ? undefined
      : truncateToLength(serializedStack, MAX_EXCEPTION_STACK_LENGTH);
  const emptyStringSize = getUtf8Size(JSON.stringify(""));
  const exceptionWithEmptyStrings = {
    typeName,
    message: "",
    hasFullStack: false,
    ...(schemaLimitedStack === undefined ? {} : { stack: "" }),
  };
  const availableStringSize =
    maxSizeInBytes -
    getUtf8Size(JSON.stringify(exceptionWithEmptyStrings)) +
    emptyStringSize * (schemaLimitedStack === undefined ? 1 : 2);
  const stackSize =
    schemaLimitedStack === undefined
      ? 0
      : Math.min(
          getUtf8Size(JSON.stringify(schemaLimitedStack)),
          MAX_EXCEPTION_STACK_SIZE_IN_BYTES,
          Math.max(emptyStringSize, availableStringSize),
        );
  const messageSize =
    schemaLimitedStack === undefined
      ? availableStringSize
      : Math.max(emptyStringSize, availableStringSize - stackSize);
  const message = truncateJsonStringToSize(schemaLimitedMessage, messageSize) ?? "";
  const emittedStack =
    schemaLimitedStack === undefined
      ? undefined
      : truncateJsonStringToSize(schemaLimitedStack, stackSize);
  const exception = {
    typeName,
    message,
    hasFullStack: Boolean(serializedStack) && emittedStack === serializedStack,
    stack: emittedStack,
  };
  const parsedStackSize = Math.min(
    MAX_PARSED_STACK_SIZE_IN_BYTES,
    maxSizeInBytes - getUtf8Size(JSON.stringify(exception)) - getUtf8Size(',"parsedStack":'),
  );
  const parsedStack =
    serializedStack === undefined || parsedStackSize < 2
      ? undefined
      : parseStack(serializedStack, parsedStackSize);
  return { ...exception, parsedStack };
}

export function logToEnvelope(
  logRecord: ReadableLogRecord,
  instrumentationKey: string,
): AzureMonitorEnvelope<MessageData | ExceptionData | PageViewData | CustomEventData> {
  const customFields = mapAttributes(
    logRecord.attributes as Attributes,
    isPageView(logRecord.eventName) ? promotedPageViewAttributes : promotedLogAttributes,
  );
  const tags = createTags(
    logRecord.spanContext?.traceId,
    logRecord.spanContext,
    logRecord.resource.attributes["service.name"],
    logRecord.attributes as Attributes,
    logRecord.resource.attributes,
  );
  const severityLevel = mapSeverity(logRecord.severityNumber);
  const time = hrTimeToDate(logRecord.hrTime);
  let name: string;
  let baseType: AzureMonitorEnvelope["data"]["baseType"];
  let baseData: MessageData | ExceptionData | PageViewData | CustomEventData;

  if (logRecord.eventName === "exception" || logRecord.attributes[EXCEPTION_TYPE]) {
    name = "Microsoft.ApplicationInsights.Exception";
    baseType = "ExceptionData";
    const baseDataWithoutException: ExceptionData = {
      ver: 2,
      exceptions: [],
      severityLevel,
    };
    const envelopeWithoutException = createEnvelope(
      instrumentationKey,
      name,
      time,
      tags,
      baseType,
      baseDataWithoutException,
    );
    const maxExceptionSize =
      MAX_EXCEPTION_ENVELOPE_SIZE_IN_BYTES -
      2 -
      getUtf8Size(JSON.stringify(envelopeWithoutException));
    baseData = {
      ...baseDataWithoutException,
      exceptions: [createExceptionDetails(logRecord.attributes, logRecord.body, maxExceptionSize)],
      ...customFields,
    };
  } else if (isPageView(logRecord.eventName)) {
    const duration =
      logRecord.attributes[ATTR_PAGE_VIEW_DURATION] ?? logRecord.attributes[NAVIGATION_DURATION];
    const explicitId = logRecord.attributes[ATTR_PAGE_VIEW_ID];
    const pageViewId =
      explicitId === undefined || explicitId === "" ? logRecord.spanContext?.traceId : explicitId;
    const referrer = logRecord.attributes[ATTR_PAGE_VIEW_REFERRER];
    name = "Microsoft.ApplicationInsights.PageView";
    baseType = "PageViewData";
    baseData = {
      ver: 2,
      id: pageViewId === undefined ? generatePageViewId() : serializeAttribute(pageViewId),
      name: serializeAttribute(
        logRecord.body ??
          logRecord.attributes[ATTR_PAGE_VIEW_NAME] ??
          logRecord.attributes[URL_FULL] ??
          "Page View",
      ),
      url:
        logRecord.attributes[URL_FULL] === undefined
          ? undefined
          : serializeAttribute(logRecord.attributes[URL_FULL]),
      duration: typeof duration === "number" ? millisecondsToTimeSpan(duration) : undefined,
      ...(referrer === undefined ? {} : { referredUri: serializeAttribute(referrer) }),
      ...customFields,
    };
  } else if (
    logRecord.eventName &&
    logRecord.body === undefined &&
    logRecord.severityNumber === undefined
  ) {
    name = "Microsoft.ApplicationInsights.Event";
    baseType = "EventData";
    baseData = {
      ver: 2,
      name: logRecord.eventName,
      ...customFields,
    };
  } else {
    name = "Microsoft.ApplicationInsights.Message";
    baseType = "MessageData";
    const message =
      logRecord.body === undefined || logRecord.body === null
        ? DEFAULT_LOG_MESSAGE
        : serializeAttribute(logRecord.body) || DEFAULT_LOG_MESSAGE;
    baseData = {
      ver: 2,
      message,
      severityLevel,
      ...customFields,
    };
  }

  return createEnvelope(instrumentationKey, name, time, tags, baseType, baseData);
}
