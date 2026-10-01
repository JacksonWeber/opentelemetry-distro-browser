import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
} from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ViewerLogRecordExporter, ViewerSpanExporter } from "./telemetryStore.js";

export async function initializeTelemetry(): Promise<MicrosoftOpenTelemetryBrowser> {
  return useMicrosoftOpenTelemetry({
    resource: resourceFromAttributes({
      "service.name": "contoso-telemetry-lab",
      "service.version": "0.1.0",
      "deployment.environment.name": "local",
    }),
    session: { enabled: true },
    spanProcessors: [new SimpleSpanProcessor(new ViewerSpanExporter())],
    logRecordProcessors: [
      new SimpleLogRecordProcessor({ exporter: new ViewerLogRecordExporter() }),
    ],
    instrumentations: await getInstrumentations(),
  });
}
