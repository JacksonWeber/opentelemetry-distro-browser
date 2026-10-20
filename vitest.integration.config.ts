import { defineConfig } from "vitest/config";
import config, { browserInstances } from "./vitest.config.js";
import { loadSnippetPage } from "./test/integration/snippetPageCommand.js";
import { verifyReloadDelivery, verifyUnloadDelivery } from "./test/integration/unloadCommand.js";

export default defineConfig({
  ...config,
  resolve: { ...config.resolve, alias: [] },
  test: {
    ...config.test,
    // Keep unit mocks out of integration tests.
    setupFiles: [],
    browser: {
      ...config.test?.browser,
      commands: { loadSnippetPage, verifyReloadDelivery, verifyUnloadDelivery },
      instances: browserInstances,
    },
    globalSetup: ["./test/integration/redirectServer.ts", "./test/integration/cdnServer.ts"],
    include: ["test/integration/**/*.test.ts"],
  },
});
