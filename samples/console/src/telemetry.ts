import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ConsoleLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

export async function initializeTelemetry(): Promise<void> {
  await useMicrosoftOpenTelemetry({
    resource: resourceFromAttributes({
      "service.name": "opentelemetry-browser-console-sample",
      "service.version": "0.1.0",
    }),
    session: { enabled: true },
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
    logRecordProcessors: [
      new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() }),
    ],
    instrumentations: await getInstrumentations({
      errors: { enabled: true },
      userAction: { enabled: true },
    }),
  });
}
