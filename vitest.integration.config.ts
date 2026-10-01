import { defineConfig } from "vitest/config";
import config from "./vitest.config.js";
import { verifyUnloadDelivery } from "./test/integration/unloadCommand.js";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    browser: {
      ...config.test?.browser,
      commands: { verifyUnloadDelivery },
    },
    globalSetup: ["./test/integration/redirectServer.ts"],
    include: ["test/integration/**/*.test.ts"],
  },
});
