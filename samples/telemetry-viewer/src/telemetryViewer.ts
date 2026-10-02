import { telemetryStore, type TelemetryItem, type TelemetryKind } from "./telemetryStore.js";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(timestamp);
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  return durationMs < 1 ? `${durationMs.toFixed(2)} ms` : `${durationMs.toFixed(1)} ms`;
}

function download(items: readonly TelemetryItem[], droppedItems: number): void {
  const anchor = document.createElement("a");
  const payload = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      service: "contoso-telemetry-lab",
      droppedItems,
      items: items.map(({ searchText: _, ...item }) => item),
    },
    null,
    2,
  );
  anchor.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  anchor.download = `browser-telemetry-${new Date().toISOString().replaceAll(":", "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

export function startTelemetryViewer(): void {
  const eventList = requiredElement<HTMLDivElement>("#event-list");
  const emptyState = requiredElement<HTMLDivElement>("#empty-state");
  const details = requiredElement<HTMLElement>("#event-details");
  const search = requiredElement<HTMLInputElement>("#telemetry-search");
  const retentionStatus = requiredElement<HTMLOutputElement>("#retention-status");
  const captureToggle = requiredElement<HTMLButtonElement>("#capture-toggle");
  const filterButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".summary-card"));
  let kind: TelemetryKind | "all" = "all";
  let selectedId: string | undefined;

  function select(item: TelemetryItem): void {
    selectedId = item.id;
    details.replaceChildren();

    const header = document.createElement("header");
    const heading = document.createElement("h3");
    const badge = document.createElement("span");
    heading.textContent = item.name;
    badge.className = `signal-badge ${item.kind}`;
    badge.textContent = item.kind;
    header.append(heading, badge);

    const metadata = document.createElement("dl");
    const fields = [
      ["Recorded", new Date(item.timestamp).toLocaleString()],
      ["Duration", formatDuration(item.durationMs)],
      ["Trace ID", item.traceId ?? ""],
      ["Span ID", item.spanId ?? ""],
    ].filter(([, value]) => value);
    for (const [label, value] of fields) {
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      metadata.append(term, description);
    }

    const payloadTitle = document.createElement("h4");
    const payload = document.createElement("pre");
    payloadTitle.textContent = "Exported payload";
    payload.textContent = JSON.stringify(item.details, null, 2);
    details.append(header, metadata, payloadTitle, payload);
    render();
  }

  function render(): void {
    const allItems = telemetryStore.getItems();
    const focusedItemId =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>(".event-row")?.dataset.itemId
        : undefined;
    const query = search.value.trim().toLowerCase();
    const filtered = allItems.filter(
      (item) =>
        (kind === "all" || item.kind === kind) && (!query || item.searchText.includes(query)),
    );
    requiredElement("#total-count").textContent = String(allItems.length);
    requiredElement("#span-count").textContent = String(
      allItems.filter((item) => item.kind === "span").length,
    );
    requiredElement("#log-count").textContent = String(
      allItems.filter((item) => item.kind === "log").length,
    );
    captureToggle.textContent = telemetryStore.isCapturing() ? "Pause capture" : "Resume capture";
    captureToggle.classList.toggle("paused", !telemetryStore.isCapturing());
    const droppedItems = telemetryStore.getDroppedItems();
    retentionStatus.hidden = droppedItems === 0;
    retentionStatus.textContent =
      droppedItems === 0
        ? ""
        : `${droppedItems.toLocaleString()} older telemetry items were dropped.`;
    emptyState.hidden = filtered.length > 0;
    eventList.replaceChildren();

    for (const item of filtered) {
      const row = document.createElement("button");
      const signal = document.createElement("span");
      const name = document.createElement("span");
      const time = document.createElement("span");
      const title = document.createElement("strong");
      const context = document.createElement("small");

      row.type = "button";
      row.className = `event-row${selectedId === item.id ? " selected" : ""}`;
      row.dataset.itemId = item.id;
      row.setAttribute("aria-pressed", String(selectedId === item.id));
      row.addEventListener("click", () => select(item));
      signal.className = `signal-icon ${item.kind}`;
      signal.textContent = item.kind === "span" ? "S" : "L";
      title.textContent = item.name;
      context.textContent =
        item.kind === "span"
          ? `${formatDuration(item.durationMs)} · ${item.traceId?.slice(0, 12) ?? "no trace"}`
          : `${item.severity ?? "unspecified"} · ${item.traceId?.slice(0, 12) ?? "no trace"}`;
      name.append(title, context);
      time.textContent = formatTime(item.timestamp);
      row.append(signal, name, time);
      eventList.append(row);
    }

    if (focusedItemId) {
      eventList
        .querySelector<HTMLButtonElement>(`[data-item-id="${focusedItemId}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  search.addEventListener("input", render);
  captureToggle.addEventListener("click", () => {
    telemetryStore.setCapturing(!telemetryStore.isCapturing());
  });
  requiredElement("#clear-telemetry").addEventListener("click", () => {
    selectedId = undefined;
    details.innerHTML =
      '<div class="details-placeholder"><strong>Select a telemetry item</strong><span>Its complete exported payload will appear here.</span></div>';
    telemetryStore.clear();
  });
  requiredElement("#download-telemetry").addEventListener("click", () => {
    download(telemetryStore.getItems(), telemetryStore.getDroppedItems());
  });
  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      kind = button.dataset.kind as TelemetryKind | "all";
      filterButtons.forEach((candidate) => {
        const selected = candidate === button;
        candidate.classList.toggle("selected", selected);
        candidate.setAttribute("aria-pressed", String(selected));
      });
      render();
    });
  }

  telemetryStore.subscribe(render);
  render();
}
