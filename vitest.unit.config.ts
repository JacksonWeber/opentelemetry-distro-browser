import { defineConfig, type TestUserConfig } from "vitest/config";
import config, { browserInstances } from "./vitest.config.js";

const historyHeavySuite = "test/internal/unit/pageViewInstrumentation.test.ts";
type BrowserInstance = NonNullable<NonNullable<TestUserConfig["browser"]>["instances"]>[number];

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    browser: {
      ...config.test?.browser,
      // WebKit counts History API calls across test iframes sharing one runner page.
      // Keep this suite's many real navigations from exhausting another file's quota.
      instances: browserInstances.flatMap<BrowserInstance>((instance) =>
        instance.browser === "webkit"
          ? [
              { ...instance, exclude: [historyHeavySuite] },
              { ...instance, name: "webkit-page-view", include: [historyHeavySuite] },
            ]
          : [instance],
      ),
    },
    include: ["test/internal/unit/**/*.test.ts"],
  },
});
