// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SpanContext } from "@opentelemetry/api";

/**
 * Contexts used only for page correlation, not application spans.
 * Weak membership follows buffered telemetry without retaining completed page operations.
 */
export const syntheticPageContexts = /* @__PURE__ */ new WeakSet<SpanContext>();
