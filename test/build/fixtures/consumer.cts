import {
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
} from "@microsoft/opentelemetry-browser";
import {
  getInstrumentations,
  type DependencyInstrumentationOptions,
} from "@microsoft/opentelemetry-browser/instrumentations";

const dependencies: DependencyInstrumentationOptions = {
  captureRequestHeaders: true,
  captureResponseHeaders: true,
  ignoreHeaders: ["x-secret"],
  includeErrorStatusText: true,
  maxDependenciesPerView: 500,
  enableResourceTiming: true,
};
void getInstrumentations({ dependencies });

void OPENTELEMETRY_BROWSER_VERSION;
void useMicrosoftOpenTelemetry;
void getInstrumentations;
