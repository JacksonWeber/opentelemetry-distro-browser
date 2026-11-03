import {
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowserTraceOptions,
} from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";

void OPENTELEMETRY_BROWSER_VERSION;
void useMicrosoftOpenTelemetry;
void getInstrumentations;

const traces: MicrosoftOpenTelemetryBrowserTraceOptions = {
  distributedTracingMode: 17,
  appId: "frontend",
};
void useMicrosoftOpenTelemetry({ traces });
// @ts-expect-error Unsupported tracing modes must be rejected by declarations too.
void useMicrosoftOpenTelemetry({ traces: { distributedTracingMode: 3 } });
