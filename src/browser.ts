// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { context, diag, metrics, propagation, trace } from "@opentelemetry/api";
export { logs } from "@opentelemetry/api-logs";
export * from "./index.js";
// The CDN bundle cannot rely on a bundler to add instrumentations later, so it carries every one.
export { getInstrumentations } from "./instrumentation/browserInstrumentation/index.js";
