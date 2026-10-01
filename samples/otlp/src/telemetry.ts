import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

export async function initializeTelemetry(): Promise<void> {
  const configuredEndpoint = import.meta.env.VITE_OTLP_ENDPOINT;
  if (!configuredEndpoint) {
    throw new Error("Set VITE_OTLP_ENDPOINT in samples/.env.local before starting this sample.");
  }

  const endpoint = configuredEndpoint.replace(/\/$/, "");
  await useMicrosoftOpenTelemetry({
    resource: resourceFromAttributes({
      "service.name": "opentelemetry-browser-otlp-sample",
      "service.version": "0.1.0",
    }),
    session: { enabled: true },
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
      }),
    ],
    instrumentations: await getInstrumentations({
      errors: { enabled: true },
      userAction: { enabled: true },
      webVitals: { enabled: true },
    }),
  });
}
