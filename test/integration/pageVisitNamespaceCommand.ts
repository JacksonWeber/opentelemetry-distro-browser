// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineBrowserCommand } from "@vitest/browser";
import type {} from "vitest/browser";
import type { Page, Frame } from "playwright";
import type { PageVisitNamespaceSnapshot } from "./pageVisitNamespaceFixture.js";
import { SDK_STATS_ENDPOINT } from "../fixtures/sdkStats.js";

interface NamespaceResult {
  documents: PageVisitNamespaceSnapshot[];
  popup?: {
    documents: PageVisitNamespaceSnapshot[];
    copiedStorage: Record<string, string>;
    openerAfterStart: PageVisitNamespaceSnapshot;
  };
  frame?: {
    initial: PageVisitNamespaceSnapshot;
    navigated: PageVisitNamespaceSnapshot;
    reloaded: PageVisitNamespaceSnapshot;
    parentAfterStart: PageVisitNamespaceSnapshot;
    parentAfterNavigation: PageVisitNamespaceSnapshot;
    parentAfterReload: PageVisitNamespaceSnapshot;
    parentAfterShutdown: PageVisitNamespaceSnapshot;
  };
}

interface PopupOptions {
  urls: string[];
  navigateOpenerBeforeStart?: boolean;
  openerAfterStart?: "closed" | "cross-origin";
}

declare module "vitest/browser" {
  interface BrowserCommands {
    inspectPageVisitNamespaces(
      urls: string[],
      child?: string | PopupOptions,
    ): Promise<NamespaceResult>;
  }
}

async function ready(target: Page | Frame): Promise<void> {
  await target.waitForFunction(() => document.body?.dataset.state, undefined, {
    timeout: 15_000,
  });
  const state = await target.evaluate(() => document.body.dataset.state);
  if (state !== "ready") throw new Error(`Page visit namespace fixture: ${state}`);
}

function snapshot(target: Page | Frame): Promise<PageVisitNamespaceSnapshot> {
  return target.evaluate(() => window.pageVisitNamespaceFixture.snapshot());
}

/** Source-backed real documents: no emitted artifacts or rebuild are needed for these regressions. */
export const inspectPageVisitNamespaces = defineBrowserCommand(
  async ({ page }, urls: string[], child?: string | PopupOptions): Promise<NamespaceResult> => {
    const frameUrl = typeof child === "string" ? child : undefined;
    const popupOptions = typeof child === "object" ? child : undefined;
    const browser = page.context().browser();
    if (!browser) throw new Error("Namespace tests require a browser connection.");
    const fixtureContext = await browser.newContext();
    try {
      // Keep exporter/statistics traffic local; assertions inspect the custom processor directly.
      await fixtureContext.route(SDK_STATS_ENDPOINT, (route) =>
        route.fulfill({ status: 200, body: "{}" }),
      );
      await fixtureContext.route("**/page-visit-namespace-ingestion/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ itemsAccepted: 1, itemsReceived: 1, errors: [] }),
        }),
      );
      const fixturePage = await fixtureContext.newPage();
      const result: NamespaceResult = { documents: [] };
      let openerNavigated = false;
      for (const [index, url] of urls.entries()) {
        if (index === 1 && openerNavigated) continue;
        // Do not shut down between documents: pagehide must preserve the previous visit.
        await fixturePage.goto(url);
        await ready(fixturePage);
        if (index === 0 && popupOptions) {
          await fixturePage.evaluate(() => {
            sessionStorage.setItem("pageVisitNamespace.application", "preserved");
          });
        }
        result.documents.push(await snapshot(fixturePage));
        if (index === 0 && popupOptions) {
          const popupUrl = new URL(popupOptions.urls[0]);
          popupUrl.searchParams.set("deferStart", "true");
          const [popup] = await Promise.all([
            fixturePage.waitForEvent("popup"),
            fixturePage.evaluate((href) => {
              if (!window.open(href, "page-visit-popup")) {
                throw new Error("Page visit popup was blocked.");
              }
            }, popupUrl.href),
          ]);
          await popup.waitForFunction(() => document.body?.dataset.state === "waiting");
          const copiedStorage = await popup.evaluate(() =>
            Object.fromEntries(Object.entries(sessionStorage)),
          );
          if (popupOptions.navigateOpenerBeforeStart) {
            await fixturePage.goto(urls[1]);
            await ready(fixturePage);
            result.documents.push(await snapshot(fixturePage));
            openerNavigated = true;
          }
          await popup.evaluate(() => window.startPageVisitNamespaceFixture());
          await ready(popup);
          result.popup = {
            documents: [await snapshot(popup)],
            copiedStorage,
            openerAfterStart: await snapshot(fixturePage),
          };
          if (popupOptions.openerAfterStart === "closed") {
            await fixturePage.close();
          } else if (popupOptions.openerAfterStart === "cross-origin") {
            const otherOrigin = "http://page-visit-other-origin.test/";
            await fixtureContext.route(otherOrigin, (route) =>
              route.fulfill({ contentType: "text/html", body: "<body>Other origin</body>" }),
            );
            await fixturePage.goto(otherOrigin);
          }
          for (const nextUrl of popupOptions.urls.slice(1)) {
            await popup.goto(nextUrl);
            await ready(popup);
            result.popup.documents.push(await snapshot(popup));
          }
        }
        if (index !== 0 || !frameUrl) continue;

        await fixturePage.evaluate((src) => {
          const frame = document.createElement("iframe");
          frame.id = "visit-child";
          frame.src = src;
          document.body.appendChild(frame);
        }, frameUrl);
        await fixturePage
          .frameLocator("#visit-child")
          .locator("body[data-state]")
          .waitFor({ state: "attached", timeout: 10_000 });
        const childFrame = fixturePage.frame({ url: frameUrl });
        if (!childFrame) throw new Error("Same-origin child frame was not created.");
        await ready(childFrame);
        const initial = await snapshot(childFrame);
        const parentAfterStart = await snapshot(fixturePage);
        await childFrame.evaluate(() => window.pageVisitNamespaceFixture.navigate());
        const navigated = await snapshot(childFrame);
        const parentAfterNavigation = await snapshot(fixturePage);
        await childFrame.goto(frameUrl);
        await ready(childFrame);
        const reloaded = await snapshot(childFrame);
        const parentAfterReload = await snapshot(fixturePage);
        await childFrame.evaluate(() => window.pageVisitNamespaceFixture.shutdown());
        await fixturePage.locator("#visit-child").evaluate((frame) => frame.remove());
        result.frame = {
          initial,
          navigated,
          reloaded,
          parentAfterStart,
          parentAfterNavigation,
          parentAfterReload,
          parentAfterShutdown: await snapshot(fixturePage),
        };
      }
      return result;
    } finally {
      await fixtureContext.close();
    }
  },
);
