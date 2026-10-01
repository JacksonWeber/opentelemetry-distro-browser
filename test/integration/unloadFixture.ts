// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace } from "@opentelemetry/api";
import { useMicrosoftOpenTelemetry } from "../../src/index.js";

const parameters = new URLSearchParams(location.search);
const ingestionEndpoint = parameters.get("ingestionEndpoint");
const runId = parameters.get("runId");
if (!ingestionEndpoint || !runId) {
  throw new Error("Unload fixture requires ingestionEndpoint and runId parameters.");
}

await useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString:
      `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
      `IngestionEndpoint=${ingestionEndpoint}`,
  },
  pageView: { enabled: false },
});
trace
  .getTracer("browser-unload-test")
  .startSpan("navigation-away", { attributes: { "test.run_id": runId } })
  .end();
document.body.dataset.ready = "true";
