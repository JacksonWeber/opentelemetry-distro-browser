import { defineConfig } from "vitest/config";
import config, { browserInstances } from "./vitest.config.js";

// Sends telemetry to the real Azure Monitor ingestion service; requires network access.
export default defineConfig({
  ...config,
  resolve: { ...config.resolve, alias: [] },
  test: {
    ...config.test,
    setupFiles: [],
    browser: { ...config.test?.browser, instances: browserInstances },
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
