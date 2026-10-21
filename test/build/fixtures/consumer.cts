import {
  AzureMonitorLogRecordExporter,
  AzureMonitorSpanExporter,
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
} from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
// @ts-expect-error SDK stats types are internal.
import type { AzureMonitorSdkStatsOptions as _SdkStatsOptions } from "@microsoft/opentelemetry-browser";

void OPENTELEMETRY_BROWSER_VERSION;
void useMicrosoftOpenTelemetry;
void getInstrumentations;

export const options: AzureMonitorOptions = {
  connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
  // @ts-expect-error SDK stats options are internal.
  sdkStats: {},
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
