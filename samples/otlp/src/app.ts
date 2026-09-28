import { SpanStatusCode, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const tracer = trace.getTracer("otlp-sample", "0.1.0");
const logger = logs.getLogger("otlp-sample", "0.1.0");
const status = document.querySelector<HTMLOutputElement>("#status");

function show(message: string): void {
  if (status) status.value = message;
}

document.querySelector("#checkout")?.addEventListener("click", async () => {
  await tracer.startActiveSpan("checkout", async (span) => {
    try {
      span.setAttribute("cart.item_count", 3);
      await fetch(`/api/cart?time=${Date.now()}`);
      logger.emit({
        eventName: "app.checkout_completed",
        attributes: { "cart.item_count": 3 },
      });
      show("Checkout trace and log queued for OTLP export.");
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
});

document.querySelector("#route")?.addEventListener("click", () => {
  const route = `/products/${Date.now()}`;
  history.pushState({}, "", route);
  show(`Navigated to ${route}. A browser.page_view log record was queued.`);
});

document.querySelector("#error")?.addEventListener("click", () => {
  const error = new Error("Sample handled error");
  logger.emit({
    eventName: "app.error",
    attributes: {
      "error.type": error.name,
      "error.message": error.message,
    },
  });
  show("Handled error log queued for OTLP export.");
});
