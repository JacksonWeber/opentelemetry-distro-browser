import {
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
} from "@microsoft/opentelemetry-browser";
import { createTelemetryDebugger } from "@microsoft/opentelemetry-browser/debug";
import { ROOT_CONTEXT, trace, type Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function report(error: unknown): void {
  required("#error").textContent = String(error);
}

async function initialize(name: string): Promise<void> {
  const section = document.createElement("section");
  const title = document.createElement("h2");
  title.textContent = `Instance ${name}`;
  const controls = document.createElement("div");
  const mount = document.createElement("div");
  section.append(title, controls, mount);
  required("#pipelines").append(section);
  const debug = createTelemetryDebugger({
    container: mount,
    name: `Instance ${name}`,
    maxEntries: 50,
    performance: new URLSearchParams(location.search).get("timing") !== "off",
  });
  let tracer: Tracer | undefined;
  let logger: Logger | undefined;
  const binding: BrowserInstrumentation = {
    setTracerProvider: (provider) => {
      tracer = provider.getTracer(`sample-${name}`);
    },
    setLoggerProvider: (provider) => {
      logger = provider.getLogger(`sample-${name}`);
    },
    getConfig: () => ({ enabled: false }),
    enable() {},
    disable() {},
  };
  const batchOptions = { scheduledDelayMillis: 60000, disableAutoFlushOnDocumentHide: true };
  const telemetry = await debug
    .measure("initialize", () =>
      useMicrosoftOpenTelemetry({
        resource: resourceFromAttributes({ "service.name": `debug-sample-${name}` }),
        instrumentations: [binding],
        spanProcessors: [
          debug.wrapSpanProcessor(
            new BatchSpanProcessor(
              debug.wrapSpanExporter(
                new OTLPTraceExporter({ url: `${location.origin}/v1/traces` }),
              ),
              batchOptions,
            ),
          ),
        ],
        logRecordProcessors: [
          debug.wrapLogRecordProcessor(
            new BatchLogRecordProcessor({
              exporter: debug.wrapLogRecordExporter(
                new OTLPLogExporter({ url: `${location.origin}/v1/logs` }),
              ),
              ...batchOptions,
            }),
          ),
        ],
      }),
    )
    .catch((error: unknown) => {
      debug.dispose();
      throw error;
    });
  let sequence = 0;
  function emit(): void {
    if (!tracer || !logger) throw new Error("Telemetry did not initialize.");
    const span = tracer.startSpan(`${name} checkout ${++sequence}`, {
      attributes: { "cart.items": 3 },
    });
    logger.emit({
      eventName: `${name}.cart.ready`,
      body: {
        message: "Local debug example",
        markup: "<img src=x onerror=alert(1)>",
        items: [1, 2, 3],
      },
      context: trace.setSpan(ROOT_CONTEXT, span),
    });
    span.end();
  }
  function button(label: string, action: () => void | Promise<void>): void {
    const button = document.createElement("button");
    button.textContent = label;
    button.onclick = () => {
      void Promise.resolve().then(action).catch(report);
    };
    controls.append(button);
  }
  button(`Emit ${name}`, emit);
  button(`Burst 250 ${name}`, () => {
    for (let i = 0; i < 250; i++) emit();
  });
  button(`Flush ${name}`, () => debug.measure("handle.forceFlush", () => telemetry.forceFlush()));
  button(`Shutdown ${name}`, () => debug.measure("handle.shutdown", () => telemetry.shutdown()));
}

required<HTMLInputElement>("#fail").onchange = (event) => {
  const checked = (event.currentTarget as HTMLInputElement).checked;
  void fetch(`/debug-sink?fail=${checked}`, { method: "PUT" })
    .then((response) => {
      if (!response.ok) throw new Error("Could not configure the local test sink.");
    })
    .catch(report);
};

void initialize("A")
  .then(() => initialize("B"))
  .catch(report);
