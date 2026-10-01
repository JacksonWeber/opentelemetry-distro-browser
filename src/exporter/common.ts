// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Attributes, HrTime, SpanContext } from "@opentelemetry/api";
import { OPENTELEMETRY_BROWSER_VERSION } from "../shared/constants.js";
import { syntheticPageContexts } from "../shared/pageOperationContext.js";
import type { AzureMonitorBaseData, AzureMonitorEnvelope } from "./telemetryModels.js";

let unloadingCount = 0;

export function isUnloading(): boolean {
  return unloadingCount > 0;
}

export function beginUnloading(): void {
  unloadingCount++;
}

export function endUnloading(): void {
  unloadingCount = Math.max(0, unloadingCount - 1);
}

export function hrTimeToMilliseconds(hrTime: HrTime): number {
  return hrTime[0] * 1_000 + hrTime[1] / 1_000_000;
}

export function hrTimeToDate(hrTime: HrTime): string {
  return new Date(hrTimeToMilliseconds(hrTime)).toISOString();
}

export function millisecondsToTimeSpan(milliseconds: number): string {
  const totalTicks = Number.isFinite(milliseconds)
    ? Math.max(0, Math.round(milliseconds * 10_000))
    : 0;
  const days = Math.floor(totalTicks / 864_000_000_000);
  const hours = Math.floor((totalTicks % 864_000_000_000) / 36_000_000_000);
  const minutes = Math.floor((totalTicks % 36_000_000_000) / 600_000_000);
  const seconds = Math.floor((totalTicks % 600_000_000) / 10_000_000);
  const fractionalTicks = totalTicks % 10_000_000;
  const dayPrefix = days > 0 ? `${days}.` : "";
  return `${dayPrefix}${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${fractionalTicks
    .toString()
    .padStart(7, "0")}`;
}

export function serializeAttribute(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? "";
  } catch {
    return "";
  }
}

export function mapAttributes(
  attributes: Attributes,
  promotedAttributes: ReadonlySet<string>,
): Pick<AzureMonitorBaseData, "properties" | "measurements"> {
  const properties: Record<string, string> = {};
  const measurements: Record<string, number> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || promotedAttributes.has(key)) {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      measurements[key] = value;
    } else {
      properties[key] = serializeAttribute(value);
    }
  }

  return {
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    measurements: Object.keys(measurements).length > 0 ? measurements : undefined,
  };
}

export function createTags(
  traceId: string | undefined,
  parentContext: SpanContext | undefined,
  serviceName: unknown,
): Record<string, string> {
  const tags: Record<string, string> = {
    "ai.internal.sdkVersion": `mot${OPENTELEMETRY_BROWSER_VERSION}`,
  };
  if (traceId) tags["ai.operation.id"] = traceId;
  if (parentContext?.spanId && !syntheticPageContexts.has(parentContext)) {
    tags["ai.operation.parentId"] = parentContext.spanId;
  }
  if (serviceName) tags["ai.cloud.role"] = serializeAttribute(serviceName);
  return tags;
}

export function createEnvelope<T extends AzureMonitorBaseData>(
  instrumentationKey: string,
  name: string,
  time: string,
  tags: Readonly<Record<string, string>>,
  baseType: AzureMonitorEnvelope["data"]["baseType"],
  baseData: T,
): AzureMonitorEnvelope<T> {
  return {
    name,
    time,
    iKey: instrumentationKey,
    sampleRate: 100,
    tags,
    ver: 1,
    data: { baseType, baseData },
  };
}
