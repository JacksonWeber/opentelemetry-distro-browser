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
} from "./telemetryModels.js";

const promotedLogAttributes = /* @__PURE__ */ new Set([
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  EXCEPTION_TYPE,
  NAVIGATION_DURATION,
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
]);

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
  );
  const severityLevel = mapSeverity(logRecord.severityNumber);
  let name: string;
  let baseType: AzureMonitorEnvelope["data"]["baseType"];
  let baseData: MessageData | ExceptionData | PageViewData | CustomEventData;

  if (logRecord.eventName === "exception" || logRecord.attributes[EXCEPTION_TYPE]) {
    const stack = logRecord.attributes[EXCEPTION_STACKTRACE];
    name = "Microsoft.ApplicationInsights.Exception";
    baseType = "ExceptionData";
    baseData = {
      ver: 2,
      exceptions: [
        {
          typeName: serializeAttribute(logRecord.attributes[EXCEPTION_TYPE] ?? "Error"),
          message: serializeAttribute(
            logRecord.attributes[EXCEPTION_MESSAGE] ?? logRecord.body ?? "Exception",
          ),
          hasFullStack: Boolean(stack),
          stack: stack === undefined ? undefined : serializeAttribute(stack),
        },
      ],
      severityLevel,
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

  return createEnvelope(
    instrumentationKey,
    name,
    hrTimeToDate(logRecord.hrTime),
    tags,
    baseType,
    baseData,
  );
}
