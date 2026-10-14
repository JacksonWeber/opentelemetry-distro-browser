// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { InternalSdkStatsConfiguration } from "./sdkStats.js";

const EU_REGION =
  /^(?:austria|belgium|denmark|france|germany|italy|northeurope|norway|poland|spain|sweden|switzerland|uk|westeurope)/i;
const GOVERNMENT_CLOUD =
  /(?:^|\.)(?:azure\.us|applicationinsights\.us|usgovcloudapi\.net|azure\.microsoft\.scloud|azure\.eaglex\.ic\.gov)\.*$/i;

/**
 * Production stats route as of 2026-10-13, using the .NET exporter's resource key.
 * EU, government, and air-gapped routes are excluded.
 * @see https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/monitor/Azure.Monitor.OpenTelemetry.Exporter/src/Internals/Statsbeat/StatsbeatConstants.cs
 */
export function getInternalSdkStatsConfiguration(
  endpoint: string,
): InternalSdkStatsConfiguration | undefined {
  const { hostname } = new URL(endpoint);
  if (EU_REGION.test(hostname) || GOVERNMENT_CLOUD.test(hostname)) return undefined;
  return {
    instrumentationKey: "c4a29126-a7cb-47e5-b348-11414998b11e",
    endpoint: "https://data.stats.monitor.azure.com/v2/track",
  };
}
