// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  createEnvelope,
  createTags,
  getSampleRate,
  hrTimeToDate,
  hrTimeToMilliseconds,
  mapAttributes,
  millisecondsToTimeSpan,
  truncateToLength,
} from "./common.js";
import {
  HTTP_METHOD,
  HTTP_STATUS_CODE,
  MAX_BEACON_BODY_SIZE,
  MaxPropertyLengths,
  SERVER_ADDRESS,
  SERVER_PORT,
  URL_FULL,
} from "./constants.js";
import { createExceptionDetails, getUtf8Size } from "./logUtils.js";
import type {
  AzureMonitorEnvelope,
  ExceptionData,
  MessageData,
  RemoteDependencyData,
  RequestData,
} from "./telemetryModels.js";
import {
  ATTR_ENDUSER_ID,
  ATTR_ENDUSER_PSEUDO_ID,
  ATTR_USER_ACCOUNT_ID,
  ATTR_USER_ID,
} from "../user/constants.js";
import { AZURE_MONITOR_SAMPLE_RATE } from "../sampling.js";
import { selectNonEmptyString } from "../shared/isNonEmptyString.js";
import { getManagedOperationName } from "../context/operationName.js";

const promotedSpanAttributes = /* @__PURE__ */ new Set([
  HTTP_METHOD,
  HTTP_STATUS_CODE,
  SERVER_ADDRESS,
  SERVER_PORT,
  URL_FULL,
  ATTR_ENDUSER_ID,
  ATTR_ENDUSER_PSEUDO_ID,
  ATTR_USER_ACCOUNT_ID,
  ATTR_USER_ID,
  AZURE_MONITOR_SAMPLE_RATE,
]);
const promotedExceptionEventAttributes = /* @__PURE__ */ new Set([
  "exception.message",
  "exception.stacktrace",
  "exception.type",
  "session.id",
]);
const promotedEventAttributes = /* @__PURE__ */ new Set(["session.id"]);

function omitCustomFields(envelope: AzureMonitorEnvelope): AzureMonitorEnvelope {
  const {
    properties: _properties,
    measurements: _measurements,
    ...baseData
  } = envelope.data.baseData;
  return { ...envelope, data: { ...envelope.data, baseData } };
}

function spanSucceeded(span: ReadableSpan, statusCode: number): boolean {
  if (span.status.code !== SpanStatusCode.UNSET) {
    return span.status.code === SpanStatusCode.OK;
  }
  return statusCode === 0 || statusCode < 400;
}

export function spanToEnvelope(
  span: ReadableSpan,
  instrumentationKey: string,
): AzureMonitorEnvelope<RequestData | RemoteDependencyData> {
  const spanContext = span.spanContext();
  const statusCode = Number(span.attributes[HTTP_STATUS_CODE]) || 0;
  const method = span.attributes[HTTP_METHOD];
  const url = span.attributes[URL_FULL];
  const duration = millisecondsToTimeSpan(hrTimeToMilliseconds(span.duration));
  const customFields = mapAttributes(span.attributes, promotedSpanAttributes, true);
  const sampleRate = getSampleRate(span.attributes);
  const tags = createTags(
    spanContext.traceId,
    span.parentSpanContext,
    span.resource.attributes["service.name"],
    span.attributes,
    span.resource.attributes,
    getManagedOperationName(span),
  );

  if (span.kind === SpanKind.SERVER || span.kind === SpanKind.CONSUMER) {
    const baseData: RequestData = {
      ver: 2,
      id: spanContext.spanId.substring(0, MaxPropertyLengths.NINE_BIT),
      name: truncateToLength(span.name, MaxPropertyLengths.TEN_BIT),
      duration,
      success: spanSucceeded(span, statusCode),
      responseCode: String(statusCode),
      url: url === undefined ? undefined : String(url),
      ...customFields,
    };
    return createEnvelope(
      instrumentationKey,
      "Microsoft.ApplicationInsights.Request",
      hrTimeToDate(span.startTime),
      tags,
      "RequestData",
      baseData,
      sampleRate,
    );
  }

  let dependencyName = span.name;
  if (method && url) {
    try {
      dependencyName = `${String(method)} ${new URL(String(url)).pathname}`;
    } catch {
      dependencyName = span.name;
    }
  }
  const serverAddress = span.attributes[SERVER_ADDRESS];
  const serverPort = span.attributes[SERVER_PORT];
  const target = serverAddress
    ? `${String(serverAddress)}${serverPort ? `:${String(serverPort)}` : ""}`
    : undefined;
  let dependencyType =
    span.kind === SpanKind.INTERNAL && span.parentSpanContext ? "InProc" : "Dependency";
  if (method) dependencyType = "Http";
  const baseData: RemoteDependencyData = {
    ver: 2,
    id: spanContext.spanId.substring(0, MaxPropertyLengths.NINE_BIT),
    name: truncateToLength(dependencyName, MaxPropertyLengths.TEN_BIT),
    duration,
    success: spanSucceeded(span, statusCode),
    resultCode: String(statusCode).substring(0, MaxPropertyLengths.TEN_BIT),
    type: dependencyType.substring(0, MaxPropertyLengths.TEN_BIT),
    data:
      url === undefined
        ? undefined
        : truncateToLength(String(url), MaxPropertyLengths.THIRTEEN_BIT),
    target: target === undefined ? undefined : truncateToLength(target, MaxPropertyLengths.TEN_BIT),
    ...customFields,
  };
  return createEnvelope(
    instrumentationKey,
    "Microsoft.ApplicationInsights.RemoteDependency",
    hrTimeToDate(span.startTime),
    tags,
    "RemoteDependencyData",
    baseData,
    sampleRate,
  );
}

function spanEventToEnvelope(
  span: ReadableSpan,
  event: ReadableSpan["events"][number],
  instrumentationKey: string,
  unloadPrecedingEnvelopes: readonly AzureMonitorEnvelope[] | undefined,
  spanEnvelopes: readonly AzureMonitorEnvelope[],
): AzureMonitorEnvelope<MessageData | ExceptionData> {
  const spanContext = span.spanContext();
  const attributes = event.attributes ?? {};
  const isException = event.name === "exception";
  const customFields = mapAttributes(
    attributes,
    isException ? promotedExceptionEventAttributes : promotedEventAttributes,
  );
  const tags = createTags(
    spanContext.traceId,
    spanContext,
    span.resource.attributes["service.name"],
    span.attributes,
    span.resource.attributes,
    getManagedOperationName(span),
  );
  const eventSessionId = attributes["session.id"];
  const sessionId = selectNonEmptyString(eventSessionId, span.attributes["session.id"]);
  if (sessionId !== undefined) tags["ai.session.id"] = sessionId;
  const time = hrTimeToDate(event.time);
  const sampleRate = getSampleRate(span.attributes);

  if (isException) {
    const baseDataWithoutException: ExceptionData = {
      ver: 2,
      exceptions: [],
    };
    const envelopeWithoutException = createEnvelope(
      instrumentationKey,
      "Microsoft.ApplicationInsights.Exception",
      time,
      tags,
      "ExceptionData",
      baseDataWithoutException,
      sampleRate,
    );
    const budgetedEnvelopes =
      unloadPrecedingEnvelopes === undefined
        ? [envelopeWithoutException]
        : [...unloadPrecedingEnvelopes, ...spanEnvelopes, envelopeWithoutException].map(
            omitCustomFields,
          );
    const maxExceptionSize = MAX_BEACON_BODY_SIZE - getUtf8Size(JSON.stringify(budgetedEnvelopes));
    const baseData: ExceptionData = {
      ...baseDataWithoutException,
      exceptions: [createExceptionDetails(attributes, undefined, maxExceptionSize)],
      ...customFields,
    };
    return createEnvelope(
      instrumentationKey,
      "Microsoft.ApplicationInsights.Exception",
      time,
      tags,
      "ExceptionData",
      baseData,
      sampleRate,
    );
  }

  const baseData: MessageData = {
    ver: 2,
    message: truncateToLength(event.name, MaxPropertyLengths.FIFTEEN_BIT),
    ...customFields,
  };
  return createEnvelope(
    instrumentationKey,
    "Microsoft.ApplicationInsights.Message",
    time,
    tags,
    "MessageData",
    baseData,
    sampleRate,
  );
}

export function spanToEnvelopes(
  span: ReadableSpan,
  instrumentationKey: string,
  unloadPrecedingEnvelopes?: readonly AzureMonitorEnvelope[],
): readonly AzureMonitorEnvelope[] {
  const envelopes: AzureMonitorEnvelope[] = [spanToEnvelope(span, instrumentationKey)];
  for (const event of span.events) {
    envelopes.push(
      spanEventToEnvelope(span, event, instrumentationKey, unloadPrecedingEnvelopes, envelopes),
    );
  }
  return envelopes;
}
