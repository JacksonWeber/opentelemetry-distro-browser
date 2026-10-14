// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { vi } from "vitest";
import type { getInternalSdkStatsConfiguration as GetConfiguration } from "../../src/exporter/sdkStatsDestination.js";

// A unit-only Vite alias avoids racing native ESM mock routes during browser coverage.
export const getInternalSdkStatsConfiguration = vi.fn<typeof GetConfiguration>();
