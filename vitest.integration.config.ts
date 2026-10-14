import { defineConfig } from "vitest/config";
import config, { browserInstances } from "./vitest.config.js";
import { loadSnippetPage } from "./test/integration/snippetPageCommand.js";
import { verifyUnloadDelivery } from "./test/integration/unloadCommand.js";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    // Plain navigation fixtures must not inherit the unit suite's module-mocking routes.
    setupFiles: [],
    browser: {
      ...config.test?.browser,
      commands: { loadSnippetPage, verifyUnloadDelivery },
      instances: browserInstances,
    },
    globalSetup: ["./test/integration/redirectServer.ts", "./test/integration/cdnServer.ts"],
    include: ["test/integration/**/*.test.ts"],
  },
});
