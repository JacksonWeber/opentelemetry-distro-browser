// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect, it, vi } from "vitest";
import { getInternalSdkStatsConfiguration } from "../../../../src/exporter/sdkStatsConfiguration.js";
import { getInternalSdkStatsConfiguration as getDestination } from "../../../../src/exporter/sdkStatsDestination.js";
const endpoint = "https://westus2-2.in.applicationinsights.azure.com";

it("allows a test-local override of the default-disabled stats configuration", () => {
  expect(getDestination(endpoint)).toMatchObject({
    endpoint: "https://data.stats.monitor.azure.com/v2/track",
  });
  expect(getInternalSdkStatsConfiguration(endpoint)).toBeUndefined();
  const configuration = {
    instrumentationKey: "00000000-0000-0000-0000-000000000000",
    endpoint: "https://stats.example.test/v2/track",
  };
  vi.mocked(getInternalSdkStatsConfiguration).mockReturnValue(configuration);
  expect(getInternalSdkStatsConfiguration(endpoint)).toBe(configuration);
});

it("resets stats overrides before the next test", () => {
  expect(getInternalSdkStatsConfiguration(endpoint)).toBeUndefined();
  expect(getDestination(endpoint)).toBeDefined();
});
