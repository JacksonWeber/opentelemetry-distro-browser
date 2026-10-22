import {
  AzureMonitorLogRecordExporter,
  AzureMonitorSpanExporter,
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
} from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
import type { AzureMonitorSdkStatsOptions } from "@microsoft/opentelemetry-browser";

void OPENTELEMETRY_BROWSER_VERSION;
void useMicrosoftOpenTelemetry;
void getInstrumentations;

export const options: AzureMonitorOptions = {
  connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
  sdkStats: { enabled: true } satisfies AzureMonitorSdkStatsOptions,
};
new AzureMonitorSpanExporter(options);
new AzureMonitorLogRecordExporter(options);
const asynchronousOptions: AzureMonitorOptions<Promise<string>> = {
  connectionString: Promise.resolve(options.connectionString),
};
useMicrosoftOpenTelemetry({ azureMonitor: options });
useMicrosoftOpenTelemetry({ azureMonitor: asynchronousOptions });
// @ts-expect-error Standalone trace exporters require a resolved connection string.
new AzureMonitorSpanExporter(asynchronousOptions);
// @ts-expect-error Standalone log exporters require a resolved connection string.
new AzureMonitorLogRecordExporter(asynchronousOptions);

export async function updateSampling(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  const reset: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {
    samplingPercentage: undefined,
  };
  await handle.updateCfg({});
  await handle.updateCfg({ samplingPercentage: 25 });
  await handle.updateCfg({ samplingPercentage: undefined });
  await handle.updateCfg(reset);
}
