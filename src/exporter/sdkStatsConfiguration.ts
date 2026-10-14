// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { InternalSdkStatsConfiguration } from "./sdkStats.js";

const EU_REGION = /^(?:france|germany|northeurope|norway|sweden|switzerland|uk|westeurope)/i;
const GOVERNMENT_CLOUD =
  /(?:^|\.)(?:azure\.us|applicationinsights\.us|usgovcloudapi\.net|azure\.microsoft\.scloud|azure\.eaglex\.ic\.gov)\.*$/i;

/**
 * Distro-owned production ingestion destination with the .NET exporter's resource key.
 * Global routing is pinned to the production configuration observed on 2026-10-13.
 * EU stats remain disabled, matching the production EU configuration, without exporting them globally.
 * Government and air-gapped clouds do not participate in public-cloud SDK stats.
 * These ingestion identifiers are not authentication credentials.
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
