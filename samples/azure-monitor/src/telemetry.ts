import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
} from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
import { resourceFromAttributes } from "@opentelemetry/resources";

export async function initializeTelemetry(): Promise<MicrosoftOpenTelemetryBrowser> {
  const connectionString = import.meta.env.VITE_APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error(
      "Set VITE_APPLICATIONINSIGHTS_CONNECTION_STRING in samples/.env.local before starting this sample.",
    );
  }

  return useMicrosoftOpenTelemetry({
    azureMonitor: { connectionString },
    resource: resourceFromAttributes({
      "service.name": "opentelemetry-browser-azure-monitor-sample",
      "service.version": "0.1.0",
    }),
    session: { enabled: true },
    instrumentations: await getInstrumentations({
      errors: { enabled: true },
      userAction: { enabled: true },
      webVitals: { enabled: true },
    }),
  });
}
