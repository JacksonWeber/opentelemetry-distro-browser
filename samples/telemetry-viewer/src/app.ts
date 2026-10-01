import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { MicrosoftOpenTelemetryBrowser } from "@microsoft/opentelemetry-browser";

const tracer = trace.getTracer("contoso-store", "0.1.0");
const logger = logs.getLogger("contoso-store", "0.1.0");
const app = document.querySelector<HTMLElement>("#app");
const toast = document.querySelector<HTMLElement>("#toast");
let cartItems = 2;
let toastTimer: number | undefined;

interface BundleMeasurement {
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
  chunks: number;
}

interface BundleScenario {
  id: string;
  label: string;
  description: string;
  unminified: BundleMeasurement;
  minified: BundleMeasurement;
}

interface BuildInfo {
  scenarios: BundleScenario[];
}

const products = [
  { name: "Surface Studio", category: "Devices", price: "$3,499", color: "blue" },
  { name: "Ergonomic Keyboard", category: "Accessories", price: "$129", color: "purple" },
  { name: "Azure Mug", category: "Lifestyle", price: "$24", color: "orange" },
];

function notify(message: string): void {
  if (!toast) return;
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("visible");
    toastTimer = undefined;
  }, 2_400);
}

function pageTemplate(path: string): string {
  if (path === "/catalog") {
    return `
      <section class="page-heading">
        <div><p class="eyebrow">Product catalog</p><h1>Everything your team needs</h1>
        <p>Browse products and add one to the cart to generate a traced user journey.</p></div>
        <button class="primary" type="button" data-action="load-catalog">Refresh catalog</button>
      </section>
      <section class="product-grid">
        ${products
          .map(
            (product) => `
              <article class="product-card">
                <div class="product-art ${product.color}">${product.name.charAt(0)}</div>
                <small>${product.category}</small><h2>${product.name}</h2>
                <div><strong>${product.price}</strong>
                <button class="secondary" type="button" data-action="add-cart" data-product="${product.name}">Add to cart</button></div>
              </article>`,
          )
          .join("")}
      </section>`;
  }
  if (path === "/checkout") {
    return `
      <section class="page-heading">
        <div><p class="eyebrow">Secure checkout</p><h1>Review your order</h1>
        <p>Run a successful or failed transaction to compare correlated telemetry.</p></div>
      </section>
      <section class="checkout-layout">
        <article class="surface order-summary">
          <h2>Order summary</h2>
          <div><span>Surface Studio</span><strong>$3,499</strong></div>
          <div><span>Azure Mug × ${cartItems}</span><strong>$${24 * cartItems}</strong></div>
          <div class="total"><span>Total</span><strong>$${3_499 + 24 * cartItems}</strong></div>
        </article>
        <article class="surface payment">
          <h2>Payment simulation</h2>
          <p>No payment is made. These controls create nested spans, events, and correlated logs.</p>
          <button class="primary" type="button" data-action="checkout-success">Complete order</button>
          <button class="secondary danger" type="button" data-action="checkout-failure">Simulate decline</button>
        </article>
      </section>`;
  }
  if (path === "/settings") {
    return `
      <section class="page-heading"><div><p class="eyebrow">Validation controls</p>
        <h1>Exercise the SDK lifecycle</h1><p>Emit diagnostics and force pending processors to flush.</p></div></section>
      <section class="settings-grid">
        <article class="surface"><h2>Application log</h2><p>Emit a standalone structured log record.</p>
          <button class="secondary" type="button" data-action="emit-log">Emit log</button></article>
        <article class="surface"><h2>Manual trace</h2><p>Create a span with custom attributes and an event.</p>
          <button class="secondary" type="button" data-action="manual-span">Create span</button></article>
        <article class="surface"><h2>Processor flush</h2><p>Ask every configured span and log processor to flush.</p>
          <button class="secondary" type="button" data-action="flush">Force flush</button></article>
      </section>`;
  }
  return `
    <section class="hero">
      <div>
        <p class="eyebrow">OpenTelemetry browser validation</p>
        <h1>See every signal.<br /><em>As it happens.</em></h1>
        <p class="hero-copy">A real single-page storefront backed by the current Microsoft OpenTelemetry browser distribution. Explore the site, generate scenarios, and inspect every exported payload below.</p>
        <div class="hero-actions">
          <a class="primary button" href="/catalog" data-route="/catalog">Explore catalog</a>
          <button class="secondary" type="button" data-action="quick-trace">Generate sample trace</button>
        </div>
      </div>
      <div class="hero-visual" role="img" aria-label="Telemetry flow illustration">
        <div class="pulse"></div><span class="node browser-node">Browser</span>
        <span class="flow-line"></span><span class="node sdk-node">OTel SDK</span>
        <span class="flow-line second"></span><span class="node viewer-node">Viewer</span>
      </div>
    </section>
    <section class="feature-grid">
      <article><span>01</span><h2>Navigate</h2><p>SPA route changes produce page-view telemetry.</p></article>
      <article><span>02</span><h2>Interact</h2><p>Requests, clicks, logs, and spans exercise each signal path.</p></article>
      <article><span>03</span><h2>Inspect</h2><p>Filter events and review the complete exported representation.</p></article>
    </section>
    <section class="bundle-panel">
      <div class="bundle-heading">
        <div><p class="eyebrow">Current repository build</p><h2>Package bundle scenarios</h2></div>
        <p>Equivalent package consumers measured before and after minification.</p>
      </div>
      <div id="bundle-metrics" class="bundle-metrics" aria-live="polite">
        <span>Loading current build measurements…</span>
      </div>
    </section>`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_024).toFixed(2)} KiB`;
}

async function loadBuildInfo(): Promise<void> {
  const container = document.querySelector<HTMLElement>("#bundle-metrics");
  if (!container) return;

  try {
    const response = await fetch("/build-info.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Build information request failed: ${response.status}`);
    const info = (await response.json()) as BuildInfo;
    container.replaceChildren(
      ...info.scenarios.map((scenario) => {
        const section = document.createElement("section");
        const heading = document.createElement("div");
        const title = document.createElement("h3");
        const description = document.createElement("p");
        const cards = document.createElement("div");
        const difference = (scenario.minified.rawBytes / scenario.unminified.rawBytes - 1) * 100;
        const measurements = [
          [
            "Unminified",
            formatBytes(scenario.unminified.rawBytes),
            `${scenario.unminified.chunks} chunks`,
          ],
          [
            "Minified",
            formatBytes(scenario.minified.rawBytes),
            `${Math.abs(difference).toFixed(1)}% smaller`,
          ],
          ["Minified + gzip", formatBytes(scenario.minified.gzipBytes), "transfer size"],
          ["Minified + Brotli", formatBytes(scenario.minified.brotliBytes), "transfer size"],
        ];
        section.className = "bundle-scenario";
        heading.className = "bundle-scenario-heading";
        title.textContent = scenario.label;
        description.textContent = scenario.description;
        heading.append(title, description);
        cards.className = "bundle-cards";
        cards.append(
          ...measurements.map(([label, value, context]) => {
            const card = document.createElement("article");
            const labelElement = document.createElement("small");
            const valueElement = document.createElement("strong");
            const contextElement = document.createElement("span");
            labelElement.textContent = label;
            valueElement.textContent = value;
            contextElement.textContent = context;
            card.append(labelElement, valueElement, contextElement);
            return card;
          }),
        );
        section.append(heading, cards);
        return section;
      }),
    );
  } catch (error) {
    container.textContent =
      error instanceof Error ? error.message : "Bundle measurements could not be loaded.";
  }
}

function render(path = window.location.pathname): void {
  if (!app) return;
  const supportedPath = ["/", "/catalog", "/checkout", "/settings"].includes(path) ? path : "/";
  app.innerHTML = pageTemplate(supportedPath);
  document.querySelectorAll("[data-route]").forEach((link) => {
    const active = link.getAttribute("data-route") === supportedPath;
    link.classList.toggle("active", active);
    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
  app.focus({ preventScroll: true });
  if (supportedPath === "/") void loadBuildInfo();
}

function navigate(path: string): void {
  history.pushState({}, "", path);
  render(path);
}

async function runCheckout(success: boolean): Promise<void> {
  await tracer.startActiveSpan("checkout.submit", async (checkoutSpan) => {
    const checkoutContext = trace.setSpan(context.active(), checkoutSpan);
    checkoutSpan.setAttributes({
      "checkout.item_count": cartItems + 1,
      "checkout.total": 3_499 + 24 * cartItems,
      "checkout.currency": "USD",
    });
    await tracer.startActiveSpan("payment.authorize", async (paymentSpan) => {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      paymentSpan.setAttribute("payment.provider", "contoso-pay");
      if (success) {
        paymentSpan.setStatus({ code: SpanStatusCode.OK });
      } else {
        const error = new Error("The simulated card was declined");
        paymentSpan.recordException(error);
        paymentSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }
      paymentSpan.end();
    });

    if (success) {
      logger.emit({
        eventName: "checkout.completed",
        body: "Checkout completed successfully.",
        context: checkoutContext,
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        attributes: { "order.id": `ORD-${Date.now()}`, "checkout.item_count": cartItems + 1 },
      });
      checkoutSpan.addEvent("order.confirmed");
      notify("Order completed — inspect the correlated trace and log.");
    } else {
      logger.emit({
        eventName: "checkout.declined",
        context: checkoutContext,
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
        body: "The simulated payment provider declined the transaction.",
        attributes: { "error.type": "payment_declined", "payment.provider": "contoso-pay" },
      });
      checkoutSpan.setStatus({ code: SpanStatusCode.ERROR, message: "Payment declined" });
      notify("Payment declined — error telemetry captured.");
    }
    checkoutSpan.end();
  });
}

export function startApplication(telemetry: MicrosoftOpenTelemetryBrowser): void {
  document.addEventListener("click", async (event) => {
    const target = (event.target as Element).closest<HTMLElement>("[data-route], [data-action]");
    if (!target) return;
    const route = target.dataset.route;
    if (route) {
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      navigate(route);
      return;
    }

    switch (target.dataset.action) {
      case "load-catalog":
        try {
          await tracer.startActiveSpan("catalog.refresh", async (span) => {
            try {
              const response = await fetch(`/products.json?refresh=${Date.now()}`);
              span.setAttribute("http.response.status_code", response.status);
            } catch (error) {
              span.recordException(error instanceof Error ? error : String(error));
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
              });
              throw error;
            } finally {
              span.end();
            }
          });
          notify("Catalog request completed.");
        } catch {
          notify("Catalog request failed.");
        }
        break;
      case "add-cart":
        await tracer.startActiveSpan("cart.add_item", async (span) => {
          cartItems++;
          span.setAttributes({
            "product.name": target.dataset.product ?? "unknown",
            "cart.item_count": cartItems,
          });
          logger.emit({
            eventName: "cart.item_added",
            attributes: {
              "product.name": target.dataset.product ?? "unknown",
              "cart.item_count": cartItems,
            },
          });
          span.end();
        });
        notify(`${target.dataset.product ?? "Product"} added to cart.`);
        break;
      case "checkout-success":
        await runCheckout(true);
        break;
      case "checkout-failure":
        await runCheckout(false);
        break;
      case "emit-log":
        logger.emit({
          eventName: "settings.diagnostic",
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
          body: "Manual diagnostic emitted from the validation site.",
          attributes: { "app.route": window.location.pathname, "app.cart_size": cartItems },
        });
        notify("Structured log captured.");
        break;
      case "manual-span":
      case "quick-trace": {
        const span = tracer.startSpan("validation.manual_span");
        span.setAttributes({
          "validation.source": target.dataset.action,
          "validation.result": "ok",
        });
        span.addEvent("validation.complete");
        span.end();
        notify("Manual span captured.");
        break;
      }
      case "flush":
        await telemetry.forceFlush();
        notify("All telemetry processors flushed.");
        break;
    }
  });
  window.addEventListener("popstate", () => render());
  render();
  logger.emit({
    eventName: "app.ready",
    body: "Contoso telemetry lab is ready.",
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    attributes: { "app.route": window.location.pathname },
  });
}
