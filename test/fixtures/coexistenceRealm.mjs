// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const bundleUrl = new URL("/isolated/host.mjs", import.meta.url);
const sdk = await import(/* @vite-ignore */ bundleUrl.href);

const send = (message) =>
  globalThis.document
    ? globalThis.parent.postMessage(message, new URL(import.meta.url).origin)
    : globalThis.postMessage(message);

const pipeline = sdk.createPipeline();
let handle;
globalThis.addEventListener("message", async ({ data }) => {
  if (data !== "shutdown") return;
  try {
    await handle?.shutdown();
    send({ stopped: true });
  } catch (error) {
    send({ error: String(error) });
  }
});
try {
  handle = await sdk.useMicrosoftOpenTelemetry(pipeline.options);
  sdk.trace.getTracer("realm").startSpan("realm-span").end();
  sdk.logs.getLogger("realm").emit({ eventName: "realm-log" });
  await handle.forceFlush();
  send({
    spans: pipeline.spans.getFinishedSpans().map((span) => span.name),
    logs: pipeline.records.getFinishedLogRecords().map((record) => record.eventName),
  });
} catch (error) {
  send({ error: String(error) });
}
