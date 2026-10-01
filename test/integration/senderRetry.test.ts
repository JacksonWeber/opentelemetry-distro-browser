// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect, it, vi } from "vitest";
import { Sender } from "../../src/exporter/sender.js";

it.each(["AbortError", "TimeoutError"] as const)(
  "retries a browser %s transport failure",
  async (errorName) => {
    const transportError = new DOMException("Request failed", errorName);
    expect(transportError).toBeInstanceOf(DOMException);
    expect(transportError.name).toBe(errorName);

    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const delay = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      delay,
      random: () => 0,
    });

    await expect(
      sender.send({ body: new TextEncoder().encode("telemetry"), contentType: "application/json" }),
    ).resolves.toMatchObject({ transport: "fetch", statusCode: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
  },
);
