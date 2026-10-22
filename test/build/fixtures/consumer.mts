import {
  AzureMonitorLogRecordExporter,
  AzureMonitorSpanExporter,
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
  type MicrosoftOpenTelemetryBrowserOptions,
  type MicrosoftOpenTelemetryBrowserSessionOptions,
} from "@microsoft/opentelemetry-browser";
// @ts-expect-error SDK stats types are internal.
import type { AzureMonitorSdkStatsOptions as _SdkStatsOptions } from "@microsoft/opentelemetry-browser";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

export const version: string = OPENTELEMETRY_BROWSER_VERSION;
export const session: MicrosoftOpenTelemetryBrowserSessionOptions = {
  enabled: true,
  persist: false,
  inactivityTimeout: 1800,
  maxDuration: 86400,
};
const headers = { "x-tenant": "consumer" };
export const instrumentation: BrowserInstrumentation = {
  setTracerProvider(provider) {
    provider.getTracer("consumer");
  },
  setLoggerProvider(provider) {
    provider.getLogger("consumer");
  },
  getConfig() {
    return { enabled: false };
  },
  enable() {},
  disable() {},
};
export const options: MicrosoftOpenTelemetryBrowserOptions = {
  samplingPercentage: 25,
  session,
  instrumentations: Object.freeze([instrumentation]),
  resource: resourceFromAttributes({
    "service.name": "consumer",
    "service.version": "1.0.0",
    "deployment.environment.name": "production",
    "custom.tenant.id": "consumer",
  }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: "https://example.test/v1/traces", headers }),
    ),
  ],
  logRecordProcessors: [
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: "https://example.test/v1/logs", headers }),
    }),
  ],
};
const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test";
export const azureMonitorOptions: MicrosoftOpenTelemetryBrowserOptions = {
  azureMonitor: { connectionString },
};
// An explicitly annotated pre-existing exporter configuration remains accepted.
const synchronousOptions: AzureMonitorOptions = { connectionString };
new AzureMonitorSpanExporter(synchronousOptions);
new AzureMonitorLogRecordExporter(synchronousOptions);
const asynchronousOptions: AzureMonitorOptions<Promise<string>> = {
  connectionString: Promise.resolve(connectionString),
};
useMicrosoftOpenTelemetry({ azureMonitor: synchronousOptions });
useMicrosoftOpenTelemetry({ azureMonitor: asynchronousOptions });
// @ts-expect-error Standalone trace exporters require a resolved connection string.
new AzureMonitorSpanExporter(asynchronousOptions);
// @ts-expect-error Standalone log exporters require a resolved connection string.
new AzureMonitorLogRecordExporter(asynchronousOptions);
// @ts-expect-error SDK stats options are internal.
useMicrosoftOpenTelemetry({ azureMonitor: { connectionString, sdkStats: {} } });
export const initialize: (
  config: MicrosoftOpenTelemetryBrowserOptions,
) => Promise<MicrosoftOpenTelemetryBrowser> = useMicrosoftOpenTelemetry;
// @ts-expect-error The previous distribution-specific option is no longer supported.
useMicrosoftOpenTelemetry({ samplingRatio: 1 });
// @ts-expect-error Service configuration goes through the resource option, not serviceName.
useMicrosoftOpenTelemetry({ serviceName: "consumer" });
// @ts-expect-error Upstream SDK controls are not exposed by the distro.
useMicrosoftOpenTelemetry({ disabled: true });
useMicrosoftOpenTelemetry({ session: { enabled: false } });
useMicrosoftOpenTelemetry({ session: { enabled: true, inactivityTimeout: 60 } });
// @ts-expect-error Session timeouts use seconds as numbers.
useMicrosoftOpenTelemetry({ session: { maxDuration: "86400" } });
// @ts-expect-error Persistence consent is a boolean.
useMicrosoftOpenTelemetry({ session: { persist: "false" } });
// @ts-expect-error Configure exporters through standard processors, not distro-specific options.
useMicrosoftOpenTelemetry({ otlp: { endpoint: "https://example.test" } });
// @ts-expect-error Configure exporters through standard processors, not upstream exportConfig.
useMicrosoftOpenTelemetry({ exportConfig: { url: "https://example.test" } });
// @ts-expect-error Processors are top-level distro options, not upstream signal configuration.
useMicrosoftOpenTelemetry({ traces: { processors: [] } });
// @ts-expect-error Processors are top-level distro options, not upstream signal configuration.
useMicrosoftOpenTelemetry({ logs: { processors: [] } });
// @ts-expect-error Azure Monitor connection strings belong to its exporters, not the initializer.
useMicrosoftOpenTelemetry({ connectionString: "InstrumentationKey=00000000" });

export async function updateSampling(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  const reset: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {
    samplingPercentage: undefined,
  };
  await handle.updateCfg({});
  await handle.updateCfg({ samplingPercentage: 25 });
  await handle.updateCfg({ samplingPercentage: undefined });
  await handle.updateCfg(reset);
}

export async function shutdown(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  await handle.forceFlush();
  await handle.shutdown();
}
