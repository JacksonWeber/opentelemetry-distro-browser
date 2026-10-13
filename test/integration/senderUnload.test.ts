// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { commands } from "vitest/browser";
import { expect, inject, it } from "vitest";

it.each([
  ["source", undefined],
  ["index.js", undefined],
  ["index.min.js", undefined],
  ["source", 100],
  ["index.js", 100],
  ["index.min.js", 100],
])(
  "delivers queued logs from %s with sampling=%s during an in-flight export on first load",
  async (artifact, sampling) => {
    const runId = crypto.randomUUID();
    const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
    const fixtureUrl = new URL("./unloadFixture.html", import.meta.url);
    fixtureUrl.searchParams.set("ingestionEndpoint", ingestionEndpoint);
    fixtureUrl.searchParams.set("runId", runId);
    fixtureUrl.searchParams.set("inFlight", "true");
    if (artifact !== "source") fixtureUrl.searchParams.set("artifact", artifact);
    if (sampling !== undefined) fixtureUrl.searchParams.set("sampling", String(sampling));
    const captureUrl = `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`;

    await expect(commands.verifyUnloadDelivery(fixtureUrl.href, captureUrl, 3)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            baseType: "MessageData",
            baseData: expect.objectContaining({ message: "queued-before-navigation" }),
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            baseType: "RemoteDependencyData",
            baseData: expect.objectContaining({ name: "navigation-away" }),
          }),
        }),
      ]),
    );
  },
);

it.each([
  { name: "a normal batch", largeBatch: false, expectedNames: ["navigation-away"] },
  {
    name: "a batch above the aggregate keepalive limit",
    largeBatch: true,
    expectedNames: Array.from({ length: 8 }, (_, index) => `navigation-away-${index}`),
  },
])(
  "delivers $name after the source document navigates away",
  async ({ largeBatch, expectedNames }) => {
    const runId = crypto.randomUUID();
    const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
    const fixtureUrl = new URL("./unloadFixture.html", import.meta.url);
    fixtureUrl.searchParams.set("ingestionEndpoint", ingestionEndpoint);
    fixtureUrl.searchParams.set("runId", runId);
    if (largeBatch) fixtureUrl.searchParams.set("largeBatch", "true");
    const captureUrl = `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`;

    const envelopes = await commands.verifyUnloadDelivery(fixtureUrl.href, captureUrl);
    expect(envelopes).toHaveLength(expectedNames.length);
    expect(envelopes).toEqual(
      expectedNames.map((name) =>
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.RemoteDependency",
          data: expect.objectContaining({
            baseType: "RemoteDependencyData",
            baseData: expect.objectContaining({
              name,
              properties: expect.objectContaining({ "test.run_id": runId }),
            }),
          }),
        }),
      ),
    );
    if (largeBatch) {
      expect(envelopes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              baseData: expect.objectContaining({ properties: { "test.run_id": runId } }),
            }),
          }),
        ]),
      );
    }
  },
);

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
