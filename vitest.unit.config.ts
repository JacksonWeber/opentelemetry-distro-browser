import { defineConfig, type TestUserConfig } from "vitest/config";
import config, { browserInstances } from "./vitest.config.js";

const pageViewSuite = "test/internal/unit/pageViewInstrumentation.test.ts";
const pageVisitSuite = "test/internal/unit/pageVisitInstrumentation.test.ts";
const urlRedactionSuite = "test/internal/unit/telemetryUrlRedaction.test.ts";
type BrowserInstance = NonNullable<NonNullable<TestUserConfig["browser"]>["instances"]>[number];

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    browser: {
      ...config.test?.browser,
      // Separate runner pages avoid WebKit's shared History API quota.
      instances: browserInstances.flatMap<BrowserInstance>((instance) =>
        instance.browser === "webkit"
          ? [
              { ...instance, exclude: [pageViewSuite, pageVisitSuite, urlRedactionSuite] },
              { ...instance, name: "webkit-page-view", include: [pageViewSuite] },
              { ...instance, name: "webkit-page-visit", include: [pageVisitSuite] },
              { ...instance, name: "webkit-url-redaction", include: [urlRedactionSuite] },
            ]
          : [instance],
      ),
    },
    include: ["test/internal/unit/**/*.test.ts"],
  },
});
