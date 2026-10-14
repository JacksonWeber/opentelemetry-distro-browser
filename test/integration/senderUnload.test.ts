// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { commands } from "vitest/browser";
import { expect, inject, it } from "vitest";
import { assertAzureMonitorEnvelope } from "../fixtures/azureMonitor.js";

it("delivers accumulated SDK stats after the source document navigates away", async () => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${runId}`;
  const origin = new URL(ingestionEndpoint).origin;
  const fixtureUrl = new URL("./unloadFixture.html", import.meta.url);
  fixtureUrl.searchParams.set("ingestionEndpoint", ingestionEndpoint);
  fixtureUrl.searchParams.set("runId", runId);
  fixtureUrl.searchParams.set("statsIngestionEndpoint", `${origin}/ingest/${runId}-stats/v2/track`);
  const envelopes = await commands.verifyUnloadDelivery(
    fixtureUrl.href,
    `${origin}/captured?runId=${runId}-stats`,
  );
  expect(envelopes.length).toBeGreaterThan(0);
  envelopes.forEach(assertAzureMonitorEnvelope);
  expect(envelopes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        iKey: "c4a29126-a7cb-47e5-b348-11414998b11e",
        data: expect.objectContaining({
          baseType: "MetricData",
          baseData: expect.objectContaining({
            metrics: [{ name: "Request_Success_Count", kind: 0, value: 1 }],
          }),
        }),
      }),
    ]),
  );
}, 30_000);

it("delivers queued telemetry after the source document navigates away", async () => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
  const fixtureUrl = new URL("./unloadFixture.html", import.meta.url);
  fixtureUrl.searchParams.set("ingestionEndpoint", ingestionEndpoint);
  fixtureUrl.searchParams.set("runId", runId);
  const captureUrl = `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`;

  await expect(commands.verifyUnloadDelivery(fixtureUrl.href, captureUrl)).resolves.toEqual([
    expect.objectContaining({
      name: "Microsoft.ApplicationInsights.RemoteDependency",
      data: expect.objectContaining({
        baseType: "RemoteDependencyData",
        baseData: expect.objectContaining({
          name: "navigation-away",
          properties: expect.objectContaining({ "test.run_id": runId }),
        }),
      }),
    }),
  ]);
});

it("delivers an unsettled page view after the source document navigates away", async () => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
  const fixtureUrl = new URL("./unloadFixture.html", import.meta.url);
  fixtureUrl.searchParams.set("ingestionEndpoint", ingestionEndpoint);
  fixtureUrl.searchParams.set("runId", runId);
  fixtureUrl.searchParams.set("pageView", "true");
  const captureUrl = `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`;

  await expect(commands.verifyUnloadDelivery(fixtureUrl.href, captureUrl, 3)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Microsoft.ApplicationInsights.PageView",
        data: expect.objectContaining({
          baseType: "PageViewData",
          baseData: expect.objectContaining({
            url: `${fixtureUrl.href}#unsettled`,
            properties: expect.objectContaining({
              "browser.page_view.duration_source": "page_hide",
            }),
          }),
        }),
      }),
    ]),
  );
});
