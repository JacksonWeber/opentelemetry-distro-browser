import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { MicrosoftOpenTelemetryBrowser } from "@microsoft/opentelemetry-browser";

export function startApplication(telemetry: MicrosoftOpenTelemetryBrowser): void {
  const tracer = trace.getTracer("azure-monitor-sample", "0.1.0");
  const logger = logs.getLogger("azure-monitor-sample", "0.1.0");
  const status = document.querySelector<HTMLOutputElement>("#status");

  const show = (message: string): void => {
    if (status) status.value = message;
  };

  document.querySelector("#checkout")?.addEventListener("click", async () => {
    await tracer.startActiveSpan("checkout", async (span) => {
      span.setAttribute("cart.item_count", 3);
      await fetch(`/api/cart?time=${Date.now()}`);
      logger.emit({
        eventName: "app.checkout_completed",
        attributes: { "cart.item_count": 3 },
      });
      span.end();
      show("Checkout trace and log queued for Azure Monitor.");
    });
  });

  document.querySelector("#route")?.addEventListener("click", () => {
    const route = `/products/${Date.now()}`;
    history.pushState({}, "", route);
    show(`Navigated to ${route}. A browser.page_view log record was queued.`);
  });

  document.querySelector("#flush")?.addEventListener("click", async () => {
    await telemetry.forceFlush();
    show("Pending telemetry flushed to Azure Monitor.");
  });
}
