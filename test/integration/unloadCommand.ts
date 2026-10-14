// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineBrowserCommand } from "@vitest/browser";
import type {} from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    verifyUnloadDelivery(
      fixtureUrl: string,
      captureUrl: string,
      expectedCount?: number,
    ): Promise<unknown[]>;
  }
}

export const verifyUnloadDelivery = defineBrowserCommand(
  async (
    { page },
    fixtureUrl: string,
    captureUrl: string,
    expectedCount: number = 1,
  ): Promise<unknown[]> => {
    const fixturePage = await page.context().newPage();
    const diagnostics: string[] = [];
    fixturePage.on("console", (message) => diagnostics.push(`console: ${message.text()}`));
    fixturePage.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
    fixturePage.on("requestfailed", (request) =>
      diagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`),
    );
    fixturePage.on("request", (request) => {
      if (request.method() === "POST") diagnostics.push(`POST: ${request.url()}`);
    });
    fixturePage.on("response", (response) => {
      if (response.status() >= 400) {
        diagnostics.push(`response: ${response.status()} ${response.url()}`);
      }
    });
    try {
      await fixturePage.goto(fixtureUrl);
      try {
        await fixturePage.waitForFunction(() => document.body.dataset.ready === "true", undefined, {
          timeout: 15_000,
        });
      } catch (error) {
        throw new Error(`Unload fixture did not initialize. ${diagnostics.join(" | ")}`, {
          cause: error,
        });
      }
      await fixturePage.goto("about:blank");

      const deadline = Date.now() + 5_000;
      let envelopes: unknown[] = [];
      do {
        const response = await fetch(captureUrl);
        envelopes = (await response.json()) as unknown[];
        if (envelopes.length >= expectedCount) return envelopes;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);

      throw new Error(
        `Unload delivered ${envelopes.length}/${expectedCount} envelopes. ${diagnostics.join(" | ")}`,
      );
    } finally {
      await fixturePage.close();
    }
  },
);
