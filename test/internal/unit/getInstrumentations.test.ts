// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { getInstrumentations } from "../../../src/instrumentation/browserInstrumentation/index.js";
import type { BrowserInstrumentation, InstrumentationOptions } from "../../../src/types.js";

/** Every key of {@link InstrumentationOptions}, paired with the name upstream reports. */
const ALL: ReadonlyArray<[keyof InstrumentationOptions, string]> = [
  ["errors", "@opentelemetry/browser-instrumentation/errors"],
  ["fetch", "@opentelemetry/browser-instrumentation/fetch"],
  ["xhr", "@opentelemetry/browser-instrumentation/xhr"],
  ["navigation", "@opentelemetry/browser-instrumentation/navigation"],
  ["navigationTiming", "@opentelemetry/browser-instrumentation/navigation-timing"],
  ["resourceTiming", "@opentelemetry/browser-instrumentation/resource-timing"],
  ["userAction", "@opentelemetry/browser-instrumentation/user-action"],
  ["webVitals", "@opentelemetry/browser-instrumentation/web-vitals"],
  ["console", "@opentelemetry/browser-instrumentation/console"],
];

/** The instrumentations that collect unless they are turned off. */
const DEFAULT_ON = ALL.filter(([key]) => key === "fetch" || key === "xhr");

/** The instrumentations that collect nothing until they are turned on. */
const DEFAULT_OFF = ALL.filter(([key]) => key !== "fetch" && key !== "xhr");

/** Silences the default-on instrumentations, so a test can assert on an empty result. */
const OFF = { fetch: { enabled: false }, xhr: { enabled: false } } as const;

function names(instrumentations: readonly BrowserInstrumentation[]): string[] {
  return instrumentations.map(
    (instrumentation) =>
      (instrumentation as unknown as { instrumentationName: string }).instrumentationName,
  );
}

function configOf<T>(instrumentations: readonly BrowserInstrumentation[], name: string): T {
  const match = instrumentations.find(
    (instrumentation) =>
      (instrumentation as unknown as { instrumentationName: string }).instrumentationName === name,
  );
  if (match === undefined) {
    throw new Error(`${name} was not constructed`);
  }
  return match.getConfig() as T;
}

/** Builds options that enable exactly one instrumentation. */
function only(
  key: keyof InstrumentationOptions,
  settings: Record<string, unknown> = {},
): InstrumentationOptions {
  return { ...OFF, [key]: { enabled: true, ...settings } } as InstrumentationOptions;
}

describe("getInstrumentations", () => {
  describe("enabling", () => {
    it("captures outgoing requests when called with no options at all", async () => {
      // Matches the Application Insights JavaScript SDK, where `disableAjaxTracking` and
      // `disableFetchTracking` both default to false.
      expect(names(await getInstrumentations()).sort()).toEqual([
        "@opentelemetry/browser-instrumentation/fetch",
        "@opentelemetry/browser-instrumentation/xhr",
      ]);
    });

    it("captures outgoing requests when instrumentationOptions is empty", async () => {
      expect(names(await getInstrumentations({})).sort()).toEqual([
        "@opentelemetry/browser-instrumentation/fetch",
        "@opentelemetry/browser-instrumentation/xhr",
      ]);
    });

    it.each(DEFAULT_ON)("constructs %s without being asked", async (key, expected) => {
      expect(names(await getInstrumentations())).toContain(expected);
      expect(names(await getInstrumentations({ [key]: {} }))).toContain(expected);
    });

    it.each(DEFAULT_ON)("does not construct %s once it is disabled", async (key, expected) => {
      const options = { [key]: { enabled: false } } as InstrumentationOptions;

      expect(names(await getInstrumentations(options))).not.toContain(expected);
    });

    it("returns nothing when the defaults are turned off and nothing else is enabled", async () => {
      expect(
        await getInstrumentations({ fetch: { enabled: false }, xhr: { enabled: false } }),
      ).toEqual([]);
    });

    it.each(DEFAULT_OFF)("does not construct %s unless it is enabled", async (key, expected) => {
      expect(names(await getInstrumentations())).not.toContain(expected);
      expect(names(await getInstrumentations({ [key]: {} }))).not.toContain(expected);
    });

    it.each(DEFAULT_OFF)("constructs %s once it is enabled", async (key, expected) => {
      expect(names(await getInstrumentations(only(key)))).toEqual([expected]);
    });

    it.each(DEFAULT_OFF)("does not construct %s when it is disabled explicitly", async (key) => {
      const options = { ...OFF, [key]: { enabled: false } } as InstrumentationOptions;

      expect(await getInstrumentations(options)).toEqual([]);
    });

    it.each(ALL)("treats a non-true enabled on %s as disabled", async (key, expected) => {
      // Guards the `=== true` check against a truthy-but-not-true value arriving from
      // configuration that was parsed rather than written in TypeScript.
      const options = { ...OFF, [key]: { enabled: "yes" } } as unknown as InstrumentationOptions;

      expect(names(await getInstrumentations(options))).not.toContain(expected);
    });

    it("constructs every instrumentation when all are enabled", async () => {
      const instrumentationOptions = Object.fromEntries(
        ALL.map(([key]) => [key, { enabled: true }]),
      ) as InstrumentationOptions;

      expect(names(await getInstrumentations(instrumentationOptions)).sort()).toEqual(
        ALL.map(([, name]) => name).sort(),
      );
    });

    it("returns every instrumentation inert, for registration to enable", async () => {
      const instrumentationOptions = Object.fromEntries(
        ALL.map(([key]) => [key, { enabled: true }]),
      ) as InstrumentationOptions;

      for (const instrumentation of await getInstrumentations(instrumentationOptions)) {
        expect(instrumentation.getConfig().enabled).toBe(false);
      }
    });

    it("returns a fresh array and fresh instances on each call", async () => {
      const first = await getInstrumentations();
      const second = await getInstrumentations();

      expect(first).not.toBe(second);
      expect(first[0]).not.toBe(second[0]);
    });
  });
  describe("resource timing volume bounds", () => {
    it("bounds initiator types and queue size by default", async () => {
      const config = configOf<{ initiatorTypes?: string[]; maxQueueSize?: number }>(
        await getInstrumentations(only("resourceTiming")),
        "@opentelemetry/browser-instrumentation/resource-timing",
      );

      expect(config.initiatorTypes).toEqual(["script", "link", "css"]);
      expect(config.maxQueueSize).toBe(256);
    });

    it("lets the caller replace the bounds", async () => {
      const config = configOf<{
        initiatorTypes?: string[];
        maxQueueSize?: number;
        batchSize?: number;
      }>(
        await getInstrumentations(
          only("resourceTiming", { initiatorTypes: ["img"], maxQueueSize: 10, batchSize: 5 }),
        ),
        "@opentelemetry/browser-instrumentation/resource-timing",
      );

      expect(config.initiatorTypes).toEqual(["img"]);
      expect(config.maxQueueSize).toBe(10);
      expect(config.batchSize).toBe(5);
    });

    it("lets the caller widen capture to every initiator type", async () => {
      const config = configOf<{ initiatorTypes?: string[] }>(
        await getInstrumentations(only("resourceTiming", { initiatorTypes: [] })),
        "@opentelemetry/browser-instrumentation/resource-timing",
      );

      expect(config.initiatorTypes).toEqual([]);
    });

    it("does not share the default array between calls", async () => {
      const first = configOf<{ initiatorTypes?: string[] }>(
        await getInstrumentations(only("resourceTiming")),
        "@opentelemetry/browser-instrumentation/resource-timing",
      );
      first.initiatorTypes?.push("img");

      const second = configOf<{ initiatorTypes?: string[] }>(
        await getInstrumentations(only("resourceTiming")),
        "@opentelemetry/browser-instrumentation/resource-timing",
      );

      expect(second.initiatorTypes).toEqual(["script", "link", "css"]);
    });
  });

  describe("upstream settings pass through", () => {
    it("forwards fetch settings", async () => {
      const requestHook = (): void => {};
      const sanitizeUrl = (url: string): string => url;
      const corsUrls = [/^https:\/\/api\.example\.test/];
      const config = configOf<{
        propagateTraceHeaderCorsUrls?: (string | RegExp)[];
        measureRequestSize?: boolean;
        requestHook?: unknown;
        sanitizeUrl?: unknown;
      }>(
        await getInstrumentations(
          only("fetch", {
            propagateTraceHeaderCorsUrls: corsUrls,
            measureRequestSize: true,
            requestHook,
            sanitizeUrl,
          }),
        ),
        "@opentelemetry/browser-instrumentation/fetch",
      );

      expect(config.propagateTraceHeaderCorsUrls).toEqual(corsUrls);
      expect(config.measureRequestSize).toBe(true);
      expect(config.requestHook).toBe(requestHook);
      expect(config.sanitizeUrl).toBe(sanitizeUrl);
    });

    it("forwards xhr settings", async () => {
      const applyCustomAttributesOnSpan = (): void => {};
      const config = configOf<{
        propagateTraceHeaderCorsUrls?: (string | RegExp)[];
        applyCustomAttributesOnSpan?: unknown;
      }>(
        await getInstrumentations(
          only("xhr", {
            propagateTraceHeaderCorsUrls: ["https://api.example.test"],
            applyCustomAttributesOnSpan,
          }),
        ),
        "@opentelemetry/browser-instrumentation/xhr",
      );

      expect(config.propagateTraceHeaderCorsUrls).toEqual(["https://api.example.test"]);
      expect(config.applyCustomAttributesOnSpan).toBe(applyCustomAttributesOnSpan);
    });

    it("forwards console settings", async () => {
      const messageSerializer = (): string => "";
      const config = configOf<{ logMethods?: string[]; messageSerializer?: unknown }>(
        await getInstrumentations(only("console", { logMethods: ["error"], messageSerializer })),
        "@opentelemetry/browser-instrumentation/console",
      );

      expect(config.logMethods).toEqual(["error"]);
      expect(config.messageSerializer).toBe(messageSerializer);
    });

    it("forwards navigation, user action, web vitals and errors settings", async () => {
      const applyCustomLogRecordData = (): void => {};
      const applyCustomAttributes = (): Record<string, never> => ({});
      const instrumentations = await getInstrumentations({
        navigation: { enabled: true, useNavigationApiIfAvailable: true },
        userAction: { enabled: true, autoCapturedActions: ["click"], applyCustomLogRecordData },
        webVitals: { enabled: true, includeRawAttribution: true },
        errors: { enabled: true, applyCustomAttributes },
      });

      expect(
        configOf<{ useNavigationApiIfAvailable?: boolean }>(
          instrumentations,
          "@opentelemetry/browser-instrumentation/navigation",
        ).useNavigationApiIfAvailable,
      ).toBe(true);
      expect(
        configOf<{ autoCapturedActions?: string[]; applyCustomLogRecordData?: unknown }>(
          instrumentations,
          "@opentelemetry/browser-instrumentation/user-action",
        ),
      ).toMatchObject({ autoCapturedActions: ["click"], applyCustomLogRecordData });
      expect(
        configOf<{ includeRawAttribution?: boolean }>(
          instrumentations,
          "@opentelemetry/browser-instrumentation/web-vitals",
        ).includeRawAttribution,
      ).toBe(true);
      expect(
        configOf<{ applyCustomAttributes?: unknown }>(
          instrumentations,
          "@opentelemetry/browser-instrumentation/errors",
        ).applyCustomAttributes,
      ).toBe(applyCustomAttributes);
    });

    it("does not let a caller pre-enable an instrumentation it asked for", async () => {
      // `enabled` is applied after the spread, so a constructed instrumentation is always inert and
      // is enabled only once registration has bound its providers.
      const instrumentations = await getInstrumentations(only("fetch"));

      expect(instrumentations[0]?.getConfig().enabled).toBe(false);
    });

    it("does not mutate the caller's options", async () => {
      const instrumentationOptions: InstrumentationOptions = {
        resourceTiming: { enabled: true },
        fetch: { enabled: true },
      };
      const snapshot = structuredClone(instrumentationOptions);
      await getInstrumentations(instrumentationOptions);

      expect(instrumentationOptions).toEqual(snapshot);
    });
  });
});
