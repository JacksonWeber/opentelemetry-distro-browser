import {
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
