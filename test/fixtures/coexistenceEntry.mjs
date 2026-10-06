// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

export { context, diag, propagation, trace } from "@opentelemetry/api";
export { logs } from "@opentelemetry/api-logs";
export { useMicrosoftOpenTelemetry } from "../../dist/esm/index.js";

export function createPipeline() {
  const spans = new InMemorySpanExporter();
  const records = new InMemoryLogRecordExporter();
  const options = {
    spanProcessors: [new SimpleSpanProcessor(spans)],
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: records })],
    pageView: { enabled: false },
  };
  return { spans, records, options };
}
