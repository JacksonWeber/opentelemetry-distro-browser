// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// The default CDN and global bundle. A script tag cannot tree-shake, so this lists the root exports
// explicitly and leaves out npm-only resource detectors and Click Analytics exports. Customer SDK
// Stats and Click Analytics implementations are stripped at build time. Keep this in sync with
// `index.ts`; `test/build/cdn.test.mjs` compares them.
export { context, diag, metrics, propagation, trace } from "@opentelemetry/api";
export { logs } from "@opentelemetry/api-logs";
export { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
export { AzureMonitorLogRecordExporter } from "./exporter/log.js";
export { AzureMonitorSpanExporter } from "./exporter/trace.js";
export { useMicrosoftOpenTelemetry } from "./useMicrosoftOpenTelemetry.js";
// CDN-supported instrumentations are inlined; npm-only factories are not exported.
export { getInstrumentations } from "./instrumentation/browserInstrumentation/browser.js";
// Lets the loader snippet turn JSON `resourceAttributes` into a resource. Already bundled.
export { resourceFromAttributes } from "@opentelemetry/resources";
