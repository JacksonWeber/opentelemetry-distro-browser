// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// The default CDN and global bundle. A script tag cannot tree-shake, so this lists the root exports
// explicitly and leaves out the opt-in resource detectors, which only npm consumers can use. Keep this
// in sync with `index.ts`; `test/build/cdn.test.mjs` compares them.
export { context, diag, metrics, propagation, trace } from "@opentelemetry/api";
export { logs } from "@opentelemetry/api-logs";
export { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
export { AzureMonitorLogRecordExporter } from "./exporter/log.js";
export { AzureMonitorSpanExporter } from "./exporter/trace.js";
export { useMicrosoftOpenTelemetry } from "./useMicrosoftOpenTelemetry.js";
// The CDN bundle cannot rely on a bundler to add instrumentations later, so it carries every one.
export { getInstrumentations } from "./instrumentation/browserInstrumentation/index.js";
// Lets the loader snippet turn JSON `resourceAttributes` into a resource. Already bundled.
export { resourceFromAttributes } from "@opentelemetry/resources";
