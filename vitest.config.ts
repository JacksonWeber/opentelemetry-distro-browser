import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type TestUserConfig } from "vitest/config";

export const browserInstances = [
  { browser: "chromium" },
  { browser: "firefox" },
  { browser: "webkit" },
] satisfies NonNullable<NonNullable<TestUserConfig["browser"]>["instances"]>;

export default defineConfig({
  optimizeDeps: {
    include: [
      "@opentelemetry/api",
      "@opentelemetry/api-logs",
      "@opentelemetry/browser-instrumentation/experimental/errors",
      "@opentelemetry/browser-instrumentation/experimental/fetch",
      "@opentelemetry/browser-instrumentation/experimental/navigation",
      "@opentelemetry/browser-sdk",
      "@opentelemetry/browser-sdk/session",
      "@opentelemetry/core",
      "@opentelemetry/exporter-logs-otlp-http",
      "@opentelemetry/exporter-trace-otlp-http",
      "@opentelemetry/instrumentation",
      "@opentelemetry/resources",
      "@opentelemetry/sdk-logs",
      "@opentelemetry/sdk-trace",
      "@opentelemetry/sdk-trace-base",
      "@opentelemetry/sdk-trace-web",
      "@opentelemetry/semantic-conventions",
      "@opentelemetry/semantic-conventions/incubating",
    ],
  },
  test: {
    include: ["test/internal/unit/**/*.test.ts"],
    reporters: ["default"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov", "json-summary"],
    },
  },
});
