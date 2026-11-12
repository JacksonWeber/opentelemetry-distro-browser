// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, inject, it } from "vitest";
import { commands } from "vitest/browser";
import type {
  AzureMonitorEnvelope,
  MetricData,
  PageViewData,
} from "../../src/exporter/telemetryModels.js";
import { assertAzureMonitorEnvelope } from "../fixtures/azureMonitor.js";

function createFixture(artifact: "@js" | "@min.js", enabled: boolean) {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${runId}`;
  const pageUrl = new URL("/page-visit/first.html", inject("cdnPageOrigin"));
  pageUrl.searchParams.set("ingestionEndpoint", ingestionEndpoint);
  pageUrl.searchParams.set("namePrefix", `page-visit-${runId}.`);
  pageUrl.searchParams.set("artifact", artifact);
  // The default-off case omits the option, rather than explicitly passing false.
  if (enabled) pageUrl.searchParams.set("autoTrackPageVisitTime", "true");
  const captureUrl = `${new URL(ingestionEndpoint).origin}/captured?runId=${runId}`;
  return { pageUrl, captureUrl };
}

function validateEnvelopes(captured: unknown[]): AzureMonitorEnvelope[] {
  return captured.map((envelope) => {
    assertAzureMonitorEnvelope(envelope);
    return envelope;
  });
}

function pageViews(envelopes: AzureMonitorEnvelope[]): AzureMonitorEnvelope<PageViewData>[] {
  return envelopes.filter(
    (envelope): envelope is AzureMonitorEnvelope<PageViewData> =>
      envelope.data.baseType === "PageViewData",
  );
}

function pageVisits(envelopes: AzureMonitorEnvelope[]): AzureMonitorEnvelope<MetricData>[] {
  return envelopes.filter(
    (envelope): envelope is AzureMonitorEnvelope<MetricData> =>
      envelope.data.baseType === "MetricData" &&
      (envelope.data.baseData as MetricData).metrics.some(
        (metric) => metric.name === "PageVisitTime",
      ),
  );
}

function expectVisit(
  visit: AzureMonitorEnvelope<MetricData>,
  previous: AzureMonitorEnvelope<PageViewData>,
  next: AzureMonitorEnvelope<PageViewData>,
) {
  const { metrics, properties } = visit.data.baseData;
  expect(properties).toMatchObject({
    PageName: previous.data.baseData.name,
    PageUrl: previous.data.baseData.url,
  });
  expect(visit.tags["ai.operation.id"]).toBe(previous.data.baseData.id);
  expect(visit.tags).not.toHaveProperty("ai.operation.parentId");
  expect(metrics).toHaveLength(1);
  const { value } = metrics[0];
  expect(metrics[0]).toEqual({
    name: "PageVisitTime",
    kind: 0,
    value,
    count: 1,
    min: value,
    max: value,
  });
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
  // Milliseconds between page starts, not the page-load duration or seconds. Wire timestamps
  // have millisecond precision while performance.timeOrigin can include fractional milliseconds.
  const elapsed = Date.parse(next.time) - Date.parse(previous.time);
  expect(Math.abs(value - elapsed)).toBeLessThanOrEqual(2);
}

describe.each(["@js", "@min.js"] as const)("page visit time through emitted %s", (artifact) => {
  it.each([true, false])(
    "bridges two real documents in one tab with opt-in=%s",
    async (enabled) => {
      const { pageUrl, captureUrl } = createFixture(artifact, enabled);
      const secondUrl = new URL(pageUrl);
      secondUrl.pathname = "/page-visit/second.html";
      const envelopes = validateEnvelopes(
        await commands.verifyReloadDelivery(
          pageUrl.href,
          secondUrl.href,
          captureUrl,
          { "First document": 1, "Second document": 1 },
          { reloadCount: 1, navigateDirectly: true },
        ),
      );
      const views = pageViews(envelopes);
      expect(
        views.map(({ data }) => ({ name: data.baseData.name, url: data.baseData.url })),
      ).toEqual([
        { name: "First document", url: pageUrl.href },
        { name: "Second document", url: secondUrl.href },
      ]);
      expect(views[0].data.baseData.id).not.toBe(views[1].data.baseData.id);
      const visits = pageVisits(envelopes);
      // No metric on initial load, and leaving the final document must not emit a final visit.
      expect(visits).toHaveLength(enabled ? 1 : 0);
      if (enabled) expectVisit(visits[0], views[0], views[1]);
    },
    60_000,
  );

  it.each([true, false])(
    "attributes SPA visits to the previous route with opt-in=%s",
    async (enabled) => {
      const { pageUrl, captureUrl } = createFixture(artifact, enabled);
      pageUrl.pathname = "/page-visit/spa.html";
      const { state, diagnostics } = await commands.loadSnippetPage(pageUrl.href);
      expect(state, diagnostics.join("\n")).toBe("ready");
      const response = await fetch(captureUrl);
      expect(response.ok).toBe(true);
      const envelopes = validateEnvelopes((await response.json()) as unknown[]);
      const views = pageViews(envelopes);
      const productsUrl = new URL(pageUrl);
      productsUrl.hash = "products";
      const checkoutUrl = new URL(pageUrl);
      checkoutUrl.hash = "checkout";
      expect(
        views.map(({ data }) => ({ name: data.baseData.name, url: data.baseData.url })),
      ).toEqual([
        { name: "SPA start", url: pageUrl.href },
        { name: "SPA products", url: productsUrl.href },
        { name: "SPA checkout", url: checkoutUrl.href },
      ]);
      expect(new Set(views.map(({ data }) => data.baseData.id)).size).toBe(3);
      const visits = pageVisits(envelopes);
      expect(visits).toHaveLength(enabled ? 2 : 0);
      if (enabled) {
        expectVisit(visits[0], views[0], views[1]);
        expectVisit(visits[1], views[1], views[2]);
      }
    },
    30_000,
  );
});

it("does not adopt a previous document's visit from a different storage name prefix", async () => {
  const { pageUrl, captureUrl } = createFixture("@min.js", true);
  const secondUrl = new URL(pageUrl);
  secondUrl.pathname = "/page-visit/second.html";
  secondUrl.searchParams.set("namePrefix", `${pageUrl.searchParams.get("namePrefix")}other.`);
  const envelopes = validateEnvelopes(
    await commands.verifyReloadDelivery(
      pageUrl.href,
      secondUrl.href,
      captureUrl,
      { "First document": 1, "Second document": 1 },
      { reloadCount: 1, navigateDirectly: true },
    ),
  );
  expect(pageViews(envelopes).map(({ data }) => data.baseData.url)).toEqual([
    pageUrl.href,
    secondUrl.href,
  ]);
  expect(pageVisits(envelopes)).toEqual([]);
}, 60_000);
