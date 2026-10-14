import {
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
} from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
// @ts-expect-error Internal SDK stats do not have a public configuration type.
import type { AzureMonitorSdkStatsOptions as _SdkStatsOptions } from "@microsoft/opentelemetry-browser";

void OPENTELEMETRY_BROWSER_VERSION;
void useMicrosoftOpenTelemetry;
void getInstrumentations;

export const options: AzureMonitorOptions = {
  connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
  // @ts-expect-error SDK stats cannot be configured through public exporter options.
  sdkStats: {},
};
