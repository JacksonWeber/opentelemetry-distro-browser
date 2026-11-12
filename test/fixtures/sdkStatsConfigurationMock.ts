// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { vi } from "vitest";
import type { getInternalSdkStatsConfiguration as GetConfiguration } from "../../src/exporter/sdkStatsDestination.js";

// A unit-only alias avoids native ESM mock races.
export const getInternalSdkStatsConfiguration = vi.fn<typeof GetConfiguration>();
