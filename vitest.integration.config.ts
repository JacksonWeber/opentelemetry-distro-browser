import { defineConfig, type TestUserConfig } from "vitest/config";
import config, { browserInstances } from "./vitest.config.js";
import {
  inspectCrossSiteCookieCleanup,
  loadSnippetPage,
} from "./test/integration/snippetPageCommand.js";
import { inspectPageVisitNamespaces } from "./test/integration/pageVisitNamespaceCommand.js";
import { verifyReloadDelivery, verifyUnloadDelivery } from "./test/integration/unloadCommand.js";

const sharedPatchesSuite = "test/integration/sharedBrowserPatches.test.ts";
type BrowserInstance = NonNullable<NonNullable<TestUserConfig["browser"]>["instances"]>[number];

export default defineConfig({
  ...config,
  resolve: { ...config.resolve, alias: [] },
  test: {
    ...config.test,
    // Commands create extra contexts and popups outside Vitest's managed-page budget.
    // Avoid resource contention between files without changing within-test concurrency.
    fileParallelism: false,
    // Keep unit mocks out of integration tests.
    setupFiles: [],
    browser: {
      ...config.test?.browser,
      commands: {
        inspectCrossSiteCookieCleanup,
        loadSnippetPage,
        inspectPageVisitNamespaces,
        verifyReloadDelivery,
        verifyUnloadDelivery,
      },
      // Sequential files still share a runner page and WebKit's History API quota.
      instances: browserInstances.flatMap<BrowserInstance>((instance) =>
        instance.browser === "webkit"
          ? [
              { ...instance, exclude: [sharedPatchesSuite] },
              { ...instance, name: "webkit-shared-patches", include: [sharedPatchesSuite] },
            ]
          : [instance],
      ),
    },
    globalSetup: ["./test/integration/redirectServer.ts", "./test/integration/cdnServer.ts"],
    include: ["test/integration/**/*.test.ts"],
  },
});
