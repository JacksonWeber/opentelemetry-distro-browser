import { defineConfig } from "vitest/config";
import config, { browserInstances } from "./vitest.config.js";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    browser: {
      ...config.test?.browser,
      instances: browserInstances,
    },
    include: ["test/internal/unit/**/*.test.ts"],
  },
});
