import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const tracer = trace.getTracer("console-sample", "0.1.0");
const logger = logs.getLogger("console-sample", "0.1.0");
const status = document.querySelector<HTMLOutputElement>("#status");

function show(message: string): void {
  if (status) status.value = message;
}

document.querySelector("#span")?.addEventListener("click", () => {
  const span = tracer.startSpan("sample.manual_span");
  span.setAttribute("sample.source", "button");
  span.end();
  show("Manual span exported to the console.");
});

document.querySelector("#log")?.addEventListener("click", () => {
  logger.emit({
    eventName: "sample.button_clicked",
    attributes: { "sample.button": "log" },
  });
  show("Log record exported to the console.");
});

document.querySelector("#request")?.addEventListener("click", async () => {
  await fetch(`/sample-request?time=${Date.now()}`);
  show("Fetch completed. The development server returns 404, but the request span is recorded.");
});

document.querySelector("#route")?.addEventListener("click", () => {
  const route = `/sample-route/${Date.now()}`;
  history.pushState({}, "", route);
  show(`Navigated to ${route}. A browser.page_view log record was emitted.`);
});
