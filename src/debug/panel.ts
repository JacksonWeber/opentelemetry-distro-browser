// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TelemetryDebugEntry } from "./types.js";

export function createPanel(
  container: HTMLElement,
  name: string,
  actions: { pause: () => void; clear: () => void; dispose: () => void },
) {
  const document = container.ownerDocument;
  const element = document.createElement("aside");
  element.setAttribute("aria-label", `${name} debugger`);
  const root = element.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { display:block; font:13px system-ui,sans-serif; color:#eee; }
    section { background:#17212b; border:1px solid #718096; border-radius:8px; padding:12px; }
    h2 { font-size:16px; margin:0 0 8px; }
    nav { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
    button,input,select { font:inherit; }
    button,select { cursor:pointer; padding:4px 8px; }
    input { min-width:100px; flex:1; }
    ol { max-height:240px; overflow:auto; padding:0; list-style:none; }
    li button { width:100%; text-align:left; overflow-wrap:anywhere; }
    pre { max-height:260px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
    p { margin:6px 0; }
  `;
  const section = document.createElement("section");
  const title = document.createElement("h2");
  title.textContent = name;
  const explanation = document.createElement("p");
  explanation.textContent =
    "Development only. Exported = exporter success, not verified ingestion. Payloads may be sensitive.";
  const controls = document.createElement("nav");
  function button(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = onClick;
    controls.append(button);
    return button;
  }
  const pause = button("Pause", actions.pause);
  button("Clear", actions.clear);
  button("Dispose", actions.dispose);
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search payloads or trace IDs";
  search.setAttribute("aria-label", "Search telemetry");
  controls.append(search);
  function select(label: string, values: string[]): HTMLSelectElement {
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    controls.append(select);
    return select;
  }
  const signal = select("Signal", ["all signals", "span", "log"]);
  const phase = select("Phase", ["all phases", "emitted", "exporting", "exported", "failed"]);
  const status = document.createElement("output");
  const list = document.createElement("ol");
  list.setAttribute("aria-label", "Telemetry observations");
  const details = document.createElement("pre");
  details.setAttribute("aria-label", "Telemetry details");
  let entries: readonly TelemetryDebugEntry[] = [];
  let selected: number | undefined;
  function render(): void {
    const focused =
      root.activeElement instanceof HTMLElement ? root.activeElement.dataset.id : undefined;
    const query = search.value.toLowerCase();
    list.replaceChildren();
    const current = entries.find((entry) => entry.id === selected);
    details.textContent = current
      ? `${current.phase} ${current.signal}\n${current.payload}`
      : "Select an observation to inspect its OpenTelemetry payload.";
    for (const entry of [...entries].reverse()) {
      if (signal.selectedIndex > 0 && entry.signal !== signal.value) continue;
      if (phase.selectedIndex > 0 && entry.phase !== phase.value) continue;
      if (
        query &&
        !`${entry.name} ${entry.traceId ?? ""} ${entry.payload}`.toLowerCase().includes(query)
      )
        continue;
      const item = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.id = String(entry.id);
      row.textContent = `${entry.phase} | ${entry.signal} | ${entry.name}`;
      row.setAttribute("aria-pressed", String(entry.id === selected));
      row.onclick = () => {
        selected = entry.id;
        render();
      };
      item.append(row);
      list.append(item);
      if (focused === row.dataset.id) row.focus({ preventScroll: true });
    }
  }
  search.oninput = render;
  signal.onchange = render;
  phase.onchange = render;
  section.append(title, explanation, controls, status, list, details);
  root.append(style, section);
  container.append(element);
  return {
    element,
    update(next: readonly TelemetryDebugEntry[], dropped: number, paused: boolean): void {
      entries = next;
      pause.textContent = paused ? "Resume" : "Pause";
      status.textContent = `${entries.length} retained, ${dropped} older observations evicted${paused ? " (paused)" : ""}`;
      render();
    },
    dispose(): void {
      entries = [];
      root.replaceChildren();
      element.remove();
    },
  };
}
