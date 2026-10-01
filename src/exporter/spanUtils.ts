// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  createEnvelope,
  createTags,
  hrTimeToDate,
  hrTimeToMilliseconds,
  mapAttributes,
  millisecondsToTimeSpan,
} from "./common.js";
import {
  HTTP_METHOD,
  HTTP_STATUS_CODE,
  SERVER_ADDRESS,
  SERVER_PORT,
  URL_FULL,
} from "./constants.js";
import type { AzureMonitorEnvelope, RemoteDependencyData, RequestData } from "./telemetryModels.js";

const promotedSpanAttributes = /* @__PURE__ */ new Set([
  HTTP_METHOD,
  HTTP_STATUS_CODE,
  SERVER_ADDRESS,
  SERVER_PORT,
  URL_FULL,
]);

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
  const customFields = mapAttributes(span.attributes, promotedSpanAttributes);
  const tags = createTags(
    spanContext.traceId,
    span.parentSpanContext?.spanId,
    span.resource.attributes["service.name"],
  );

  if (span.kind === SpanKind.SERVER || span.kind === SpanKind.CONSUMER) {
    const baseData: RequestData = {
      ver: 2,
      id: spanContext.spanId,
      name: span.name,
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
  const baseData: RemoteDependencyData = {
    ver: 2,
    id: spanContext.spanId,
    name: dependencyName,
    duration,
    success: spanSucceeded(span, statusCode),
    resultCode: String(statusCode),
    type: method ? "Http" : "Dependency",
    data: url === undefined ? undefined : String(url),
    target,
    ...customFields,
  };
  return createEnvelope(
    instrumentationKey,
    "Microsoft.ApplicationInsights.RemoteDependency",
    hrTimeToDate(span.startTime),
    tags,
    "RemoteDependencyData",
    baseData,
  );
}
