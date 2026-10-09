// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineBrowserCommand } from "@vitest/browser";
import type {} from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    loadSnippetPage(pageUrl: string): Promise<{ state: string; diagnostics: string[] }>;
  }
}

/** Opens a plain HTML page in a new tab and returns the state its application script reports. */
export const loadSnippetPage = defineBrowserCommand(
  async ({ page }, pageUrl: string): Promise<{ state: string; diagnostics: string[] }> => {
    const snippetPage = await page.context().newPage();
    const diagnostics: string[] = [];
    snippetPage.on("console", (message) => diagnostics.push(`console: ${message.text()}`));
    snippetPage.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
    try {
      await snippetPage.goto(pageUrl);
      await snippetPage.waitForFunction(() => document.body?.dataset.state, undefined, {
        timeout: 10_000,
      });
      const state = await snippetPage.evaluate(() => document.body.dataset.state ?? "");
      return { state, diagnostics };
    } catch (error) {
      throw new Error(`Snippet page did not report a state. ${diagnostics.join(" | ")}`, {
        cause: error,
      });
    } finally {
      await snippetPage.close();
    }
  },
);
