// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, vi } from "vitest";
import { getInternalSdkStatsConfiguration } from "../../src/exporter/sdkStatsConfiguration.js";

// Source-based tests opt in with a mock, so unrelated suites never send internal telemetry.
vi.mock("../../src/exporter/sdkStatsConfiguration.js", () => ({
  getInternalSdkStatsConfiguration: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getInternalSdkStatsConfiguration).mockReset();
});
