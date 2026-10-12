// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { useMicrosoftOpenTelemetry as initializeSource } from "../../src/index.js";
import { useMicrosoftOpenTelemetry as initializeEsm } from "../../dist/esm/index.js";
import { useMicrosoftOpenTelemetry as initializeMinifiedEsm } from "../../dist/esm/index.min.js";

const parameters = new URLSearchParams(location.search);
const ingestionEndpoint = parameters.get("ingestionEndpoint");
const runId = parameters.get("runId");
const pageView = parameters.get("pageView") === "true";
const inFlight = parameters.get("inFlight") === "true";
const artifact = parameters.get("artifact");
if (!ingestionEndpoint || !runId) {
  throw new Error("Unload fixture requires ingestionEndpoint and runId parameters.");
}

const useMicrosoftOpenTelemetry =
  artifact === "index.js"
    ? initializeEsm
    : artifact === "index.min.js"
      ? initializeMinifiedEsm
      : initializeSource;

await useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString:
      `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
      `IngestionEndpoint=${ingestionEndpoint}`,
  },
  pageView: { enabled: pageView, softNavigationSettleTimeoutMs: 60_000 },
  samplingPercentage: parameters.has("sampling") ? Number(parameters.get("sampling")) : undefined,
  instrumentations: inFlight
    ? [new ConsoleInstrumentation({ enabled: false, logMethods: ["error"] })]
    : [],
});
if (inFlight) {
  logs.getLogger("browser-unload-test").emit({ body: "pending-before-navigation" });
  const captureUrl = `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`;
  const deadline = Date.now() + 5_000;
  let exporting = false;
  // Wait for ingestion to receive the default-batched export while its response is delayed.
  while (Date.now() < deadline) {
    const response = await fetch(captureUrl);
    if (!response.ok) throw new Error(`Capture request failed: ${response.status}`);
    const captured: unknown = await response.json();
    if (Array.isArray(captured) && captured.length > 0) {
      exporting = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!exporting) throw new Error("The initial log export did not reach ingestion.");
  console.error("queued-before-navigation");
}
if (pageView) {
  // Keep the route pending until the document navigates away.
  window.requestAnimationFrame = () => 0;
  history.pushState(null, "", "#unsettled");
}
trace
  .getTracer("browser-unload-test")
  .startSpan("navigation-away", { attributes: { "test.run_id": runId } })
  .end();
document.body.dataset.ready = "true";
