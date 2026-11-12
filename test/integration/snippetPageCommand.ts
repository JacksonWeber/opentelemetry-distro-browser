// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineBrowserCommand } from "@vitest/browser";
import { readFile } from "node:fs/promises";
import type {} from "vitest/browser";
import { SDK_STATS_ENDPOINT } from "../fixtures/sdkStats.js";

type CookieCleanup = "del" | "purge" | "clear" | "deferred-clear" | "disable" | "shutdown-del";

declare module "vitest/browser" {
  interface BrowserCommands {
    loadSnippetPage(pageUrl: string): Promise<{ state: string; diagnostics: string[] }>;
    inspectCrossSiteCookieCleanup(
      minified: boolean,
      cleanup: CookieCleanup,
    ): Promise<{ before: string; after: string; reloaded: string }>;
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
      await snippetPage.route(SDK_STATS_ENDPOINT, (route) =>
        route.fulfill({
          status: route.request().method() === "OPTIONS" ? 204 : 200,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "content-type,content-encoding",
          },
        }),
      );
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

/** Exercises emitted bundles in a real HTTPS iframe on a different site, without network access. */
export const inspectCrossSiteCookieCleanup = defineBrowserCommand(
  async ({ page }, minified: boolean, cleanup: CookieCleanup) => {
    const file = minified ? "opentelemetry-browser.iife.min.js" : "opentelemetry-browser.iife.js";
    const sdk = await readFile(new URL(`../../dist/browser/${file}`, import.meta.url), "utf8");
    const browser = page.context().browser();
    if (!browser) throw new Error("Cross-site cookie tests require a browser connection.");
    const fixtureContext = await browser.newContext();
    try {
      // Separate .test sites, not just ports/subdomains. Fulfill HTTPS locally without a server.
      await fixtureContext.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === "https://cookie-embedded.test" && url.pathname === "/sdk.js") {
          return route.fulfill({ contentType: "application/javascript", body: sdk });
        }
        if (url.href === "https://cookie-parent.test/") {
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><iframe src="https://cookie-embedded.test/"></iframe>',
          });
        }
        if (url.href === "https://cookie-embedded.test/") {
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><script src="/sdk.js"></script>',
          });
        }
        return route.abort();
      });
      const fixturePage = await fixtureContext.newPage();
      await fixturePage.goto("https://cookie-parent.test/");
      const frame = fixturePage.frame({ url: "https://cookie-embedded.test/" });
      if (!frame) throw new Error("Cross-site cookie iframe was not created.");
      await frame.waitForFunction(() => !!window.Microsoft?.OpenTelemetry);
      const result = await frame.evaluate(async (action) => {
        const sdk = window.Microsoft?.OpenTelemetry;
        if (!sdk) throw new Error("Cross-site cookie bundle did not load.");
        const handle = await sdk.useMicrosoftOpenTelemetry({
          pageView: { enabled: false },
          session: { enabled: false },
          storage: { enabled: false },
          spanProcessors: [],
          logRecordProcessors: [],
        });
        try {
          handle.userContext.setAuthenticatedUserContext("iframe-user", "iframe-account", true);
          const before = document.cookie;
          const manager = handle.getCookieMgr();
          if (action === "deferred-clear") {
            manager.setEnabled(false);
            handle.userContext.clearAuthenticatedUserContext();
            if (document.cookie !== before) throw new Error("Cookie deletion was not deferred.");
            manager.setEnabled(true);
          } else if (action === "clear") {
            handle.userContext.clearAuthenticatedUserContext();
          } else if (action === "disable") {
            handle.userContext.setEnabled(false);
          } else if (action === "purge") {
            manager.purge("ai_authUser");
          } else {
            if (action === "shutdown-del") await handle.shutdown();
            manager.del("ai_authUser");
          }
          // Read the browser directly: manager.get() intentionally returns empty after shutdown.
          return { before, after: document.cookie };
        } finally {
          await handle.shutdown();
        }
      }, cleanup);
      await frame.goto("https://cookie-embedded.test/");
      return { ...result, reloaded: await frame.evaluate(() => document.cookie) };
    } finally {
      await fixtureContext.close();
    }
  },
);
