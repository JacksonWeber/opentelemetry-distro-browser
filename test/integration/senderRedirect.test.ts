// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect, inject, it } from "vitest";
import { Sender } from "../../src/exporter/sender.js";

it("follows a cross-origin CORS redirect without remembering an untrusted endpoint", async () => {
  const endpoint = inject("redirectEndpoint");
  const sender = new Sender({ endpoint });
  const request = {
    body: new TextEncoder().encode("telemetry"),
    contentType: "application/json",
  };

  await expect(sender.send(request)).resolves.toMatchObject({
    transport: "fetch",
    statusCode: 200,
  });
  await expect(sender.send(request)).resolves.toMatchObject({
    transport: "fetch",
    statusCode: 200,
  });

  const counts = (await fetch(new URL("/counts", endpoint))).json();
  await expect(counts).resolves.toEqual({ redirectRequests: 2, finalRequests: 2 });
});
