import { defineConfig } from "vitest/config";
import config from "./vitest.config.js";
import { verifyUnloadDelivery } from "./test/integration/unloadCommand.js";
import buildCoexistenceFixtures from "./test/integration/coexistenceSetup.js";

export default defineConfig(async () => {
  // Public assets must exist before Vite snapshots the public directory.
  await buildCoexistenceFixtures();
  return {
    ...config,
    publicDir: "reports/coexistence",
    test: {
      ...config.test,
      browser: {
        ...config.test?.browser,
        commands: { verifyUnloadDelivery },
      },
      globalSetup: ["./test/integration/redirectServer.ts"],
      include: ["test/integration/**/*.test.ts"],
    },
  };
});
