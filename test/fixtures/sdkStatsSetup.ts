// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach } from "vitest";
import { getInternalSdkStatsConfiguration } from "./sdkStatsConfigurationMock.js";

beforeEach(() => {
  getInternalSdkStatsConfiguration.mockReset();
});
