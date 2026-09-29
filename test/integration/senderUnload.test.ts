// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { commands } from "vitest/browser";
import { expect, inject, it } from "vitest";

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
