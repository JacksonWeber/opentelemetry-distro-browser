// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect, it } from "vitest";
import { SDK_STATS_ENDPOINT } from "../../fixtures/sdkStats.js";
import { getInternalSdkStatsConfiguration } from "../../../src/exporter/sdkStatsDestination.js";

it.each(["westus", "eastus2", "australiaeast", "unknown"])(
  "uses the official non-EU SDK stats resource for %s",
  (region) => {
    expect(
      getInternalSdkStatsConfiguration(`https://${region}.in.applicationinsights.azure.com`),
    ).toEqual({
      instrumentationKey: "c4a29126-a7cb-47e5-b348-11414998b11e",
      endpoint: SDK_STATS_ENDPOINT,
    });
  },
);

it.each([
  "austriaeast",
  "belgiumcentral",
  "denmarkeast",
  "francecentral",
  "germanywestcentral",
  "northeurope",
  "norwayeast",
  "swedencentral",
  "switzerlandnorth",
  "uksouth",
  "westeurope",
  "italynorth",
  "polandcentral",
  "spaincentral",
])("keeps production EU stats disabled without routing %s data globally", (region) => {
  expect(
    getInternalSdkStatsConfiguration(`https://${region}-5.in.applicationinsights.azure.com`),
  ).toBeUndefined();
});

it.each([
  "https://usgovvirginia-0.in.applicationinsights.azure.us",
  "https://usgovarizona.monitor.azure.us",
  "https://dc.applicationinsights.us",
  "https://dc.applicationinsights.usgovcloudapi.net",
  "https://usnateast.dc.applicationinsights.azure.eaglex.ic.gov",
  "https://usseceast.dc.applicationinsights.azure.microsoft.scloud",
  "https://usgovvirginia-0.in.applicationinsights.azure.us.",
])(
  "does not enable public-cloud SDK stats for government or air-gapped endpoint %s",
  (endpoint) => {
    expect(getInternalSdkStatsConfiguration(endpoint)).toBeUndefined();
  },
);
