// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { loadBrowserScript } from "../fixtures/browserBundle.js";
import { SDK_STATS_ENDPOINT, withoutSdkStats } from "../fixtures/sdkStats.js";

await loadBrowserScript("opentelemetry-browser.iife.js");
const bundle = window.Microsoft?.OpenTelemetry;
if (!bundle) throw new Error("The browser bundle did not initialize.");
const { useMicrosoftOpenTelemetry, trace } = bundle;

const parameters = new URLSearchParams(location.search);
const ingestionEndpoint = parameters.get("ingestionEndpoint");
const runId = parameters.get("runId");
const pageView = parameters.get("pageView") === "true";
const statsIngestionEndpoint = parameters.get("statsIngestionEndpoint");
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

await useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString:
      `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
      `IngestionEndpoint=${ingestionEndpoint}`,
  },
  pageView: { enabled: pageView, softNavigationSettleTimeoutMs: 60_000 },
});
if (pageView) {
  // Keep the route pending until the document navigates away.
  window.requestAnimationFrame = () => 0;
  history.pushState(null, "", "#unsettled");
}
trace
  .getTracer("browser-unload-test")
  .startSpan("navigation-away", { attributes: { "test.run_id": runId } })
  .end();
// Let the normal customer batch finish without flushing stats counters.
await statsReady;
document.body.dataset.ready = "true";
