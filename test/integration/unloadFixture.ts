// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { loadBrowserScript } from "../fixtures/browserBundle.js";
import { SDK_STATS_ENDPOINT, withoutSdkStats } from "../fixtures/sdkStats.js";
import { trace as sourceTrace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { useMicrosoftOpenTelemetry as initializeSource } from "../../src/index.js";
import { useMicrosoftOpenTelemetry as initializeEsm } from "../../dist/esm/index.js";
import { useMicrosoftOpenTelemetry as initializeMinifiedEsm } from "../../dist/esm/index.min.js";

const parameters = new URLSearchParams(location.search);
const ingestionEndpoint = parameters.get("ingestionEndpoint");
const runId = parameters.get("runId");
const pageView = parameters.get("pageView") === "true";
const statsIngestionEndpoint = parameters.get("statsIngestionEndpoint");
const inFlight = parameters.get("inFlight") === "true";
const artifact = parameters.get("artifact");
const largeBatch = parameters.get("largeBatch") === "true";
const throttle = parameters.get("throttle") === "true";
if (!ingestionEndpoint || !runId) {
  throw new Error("Unload fixture requires ingestionEndpoint and runId parameters.");
}

let statsReady: Promise<void> | undefined;
if (statsIngestionEndpoint) {
  const fetch = globalThis.fetch.bind(globalThis);
  statsReady = new Promise<void>((resolve) => {
    globalThis.fetch = async (url, init) => {
      const response = await fetch(url === SDK_STATS_ENDPOINT ? statsIngestionEndpoint : url, init);
      if (url === `${ingestionEndpoint}/v2/track`) {
        const text = response.text.bind(response);
        response.text = async () => {
          const body = await text();
          resolve();
          return body;
        };
      }
      return response;
    };
  });
} else {
  const fetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = withoutSdkStats(fetch);
}
let useMicrosoftOpenTelemetry =
  artifact === "index.js"
    ? initializeEsm
    : artifact === "index.min.js"
      ? initializeMinifiedEsm
      : initializeSource;
let trace = sourceTrace;
if (statsIngestionEndpoint) {
  await loadBrowserScript("opentelemetry-browser.iife.js");
  const bundle = window.Microsoft?.OpenTelemetry;
  if (!bundle) throw new Error("The browser bundle did not initialize.");
  useMicrosoftOpenTelemetry = bundle.useMicrosoftOpenTelemetry;
  trace = bundle.trace;
}

const telemetry = await useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString:
      `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
      `IngestionEndpoint=${ingestionEndpoint}`,
  },
  pageView: {
    enabled: pageView,
    softNavigationSettleTimeoutMs: 60_000,
    applyCustomLogRecordData: (record) => {
      record.attributes = {
        ...record.attributes,
        "test.duration_source": record.attributes?.["browser.page_view.duration_source"],
      };
    },
  },
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
const tracer = trace.getTracer("browser-unload-test");
if (throttle) {
  // Ingestion throttles this export, leaving it buffered for the next page load.
  tracer.startSpan("throttled-before-reload", { attributes: { "test.run_id": runId } }).end();
  await telemetry.forceFlush().catch(() => {});
}
const spanCount = largeBatch ? 8 : 1;
for (let index = 0; index < spanCount; index++) {
  tracer
    .startSpan(largeBatch ? `navigation-away-${index}` : "navigation-away", {
      attributes: {
        "test.run_id": runId,
        ...(largeBatch ? { payload: "x".repeat(10 * 1024) } : {}),
      },
    })
    .end();
}
// Wait for customer delivery without flushing stats.
await statsReady;
document.body.dataset.ready = "true";
