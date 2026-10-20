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
    verifyReloadDelivery(
      fixtureUrl: string,
      reloadUrl: string,
      captureUrl: string,
      expected: Record<string, number>,
    ): Promise<unknown[]>;
  }
}

/**
 * Loads the fixture, navigates away and loads `reloadUrl` twice in the same tab, then returns
 * everything ingestion captured once it holds at least the `expected` count of each envelope name.
 */
export const verifyReloadDelivery = defineBrowserCommand(
  async (
    { page },
    fixtureUrl: string,
    reloadUrl: string,
    captureUrl: string,
    expected: Record<string, number>,
  ) => {
    const browser = page.context().browser();
    if (!browser) throw new Error("Reload tests require a browser connection.");
    const fixtureContext = await browser.newContext();
    try {
      const fixturePage = await fixtureContext.newPage();
      for (const url of [fixtureUrl, reloadUrl, reloadUrl]) {
        await fixturePage.goto(url);
        await fixturePage.waitForFunction(() => document.body.dataset.ready === "true", undefined, {
          timeout: 15_000,
        });
        // Let leftovers adopted on load reach ingestion before leaving.
        await fixturePage.waitForTimeout(500);
        await fixturePage.goto("about:blank");
      }
      // The last navigation's keepalive request can still be in flight.
      const deadline = Date.now() + 5_000;
      let envelopes: unknown[] = [];
      do {
        envelopes = (await (await fetch(captureUrl)).json()) as unknown[];
        const names = envelopes.map(
          (envelope) => (envelope as { data: { baseData: { name?: string } } }).data.baseData.name,
        );
        if (
          Object.entries(expected).every(
            ([name, count]) => names.filter((value) => value === name).length >= count,
          )
        ) {
          return envelopes;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      return envelopes;
    } finally {
      await fixtureContext.close();
    }
  },
);

export const verifyUnloadDelivery = defineBrowserCommand(
  async (
    { page },
    fixtureUrl: string,
    captureUrl: string,
    expectedCount: number = 1,
  ): Promise<unknown[]> => {
    const browser = page.context().browser();
    if (!browser) throw new Error("Unload tests require a browser connection.");
    const fixtureContext = await browser.newContext();
    const fixturePage = await fixtureContext.newPage();
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
      await fixtureContext.close();
    }
  },
);
