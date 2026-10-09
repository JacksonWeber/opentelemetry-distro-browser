// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const sdk = globalThis.Microsoft.OpenTelemetry;
const send = (message) =>
  globalThis.document
    ? globalThis.parent.postMessage(message, globalThis.parent.location.origin)
    : globalThis.postMessage(message);
const spans = [];
const logs = [];
let handle;
globalThis.addEventListener("message", async ({ data }) => {
  if (data !== "shutdown") return;
  try {
    await handle.shutdown();
    send({ stopped: true });
  } catch (error) {
    send({ error: String(error) });
  }
});
sdk
  .useMicrosoftOpenTelemetry({
    pageView: { enabled: false },
    spanProcessors: [
      {
        onStart() {},
        onEnd(span) {
          spans.push(span.name);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    logRecordProcessors: [
      {
        onEmit(record) {
          logs.push(record.eventName);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  })
  .then(async (telemetry) => {
    handle = telemetry;
    sdk.trace.getTracer("realm").startSpan("realm-span").end();
    sdk.logs.getLogger("realm").emit({ eventName: "realm-log" });
    await handle.forceFlush();
    send({ spans, logs });
  })
  .catch((error) => send({ error: String(error) }));
