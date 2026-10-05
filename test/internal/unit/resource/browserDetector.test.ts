// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { BrowserDetector, browserDetector } from "../../../../src/resource/index.js";

interface FakeNavigator {
  language?: unknown;
  userAgent?: unknown;
  userAgentData?: unknown;
}

function detectWith(nav: FakeNavigator | undefined): Record<string, unknown> {
  vi.stubGlobal("navigator", nav);
  try {
    return browserDetector.detect().attributes as Record<string, unknown>;
  } finally {
    vi.unstubAllGlobals();
  }
}

interface Brand {
  brand: string;
  version: string;
}

interface ClientHintsCase {
  label: string;
  language: string;
  brands: Brand[];
  platform: string;
  mobile: boolean;
  expectedBrands: string[];
}

/**
 * User-Agent Client Hints payloads as reported by shipping Chromium browsers. Every Chromium
 * browser pads its brand list with a deliberately nonsensical "Not A Brand" entry to stop sites
 * from hard-coding brand names, so those entries are expected to survive detection unchanged.
 */
const CLIENT_HINTS_CASES: ClientHintsCase[] = [
  {
    label: "Chrome on Windows",
    language: "en-US",
    brands: [
      { brand: "Google Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
    platform: "Windows",
    mobile: false,
    expectedBrands: ["Google Chrome 131", "Chromium 131", "Not_A Brand 24"],
  },
  {
    label: "Chrome on macOS",
    language: "en-GB",
    brands: [
      { brand: "Google Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
    platform: "macOS",
    mobile: false,
    expectedBrands: ["Google Chrome 131", "Chromium 131", "Not_A Brand 24"],
  },
  {
    label: "Chrome on Linux",
    language: "de-DE",
    brands: [
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
    platform: "Linux",
    mobile: false,
    expectedBrands: ["Chromium 131", "Not_A Brand 24"],
  },
  {
    label: "Chrome on Chrome OS",
    language: "en-US",
    brands: [
      { brand: "Google Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
    platform: "Chrome OS",
    mobile: false,
    expectedBrands: ["Google Chrome 131", "Chromium 131", "Not_A Brand 24"],
  },
  {
    label: "Chrome on Android",
    language: "pt-BR",
    brands: [
      { brand: "Google Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
    platform: "Android",
    mobile: true,
    expectedBrands: ["Google Chrome 131", "Chromium 131", "Not_A Brand 24"],
  },
  {
    label: "Edge on Windows",
    language: "ja",
    brands: [
      { brand: "Microsoft Edge", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
    platform: "Windows",
    mobile: false,
    expectedBrands: ["Microsoft Edge 131", "Chromium 131", "Not_A Brand 24"],
  },
  {
    label: "Opera on Windows",
    language: "zh-Hans-CN",
    brands: [
      { brand: "Opera", version: "115" },
      { brand: "Chromium", version: "130" },
      { brand: "Not_A Brand", version: "24" },
    ],
    platform: "Windows",
    mobile: false,
    expectedBrands: ["Opera 115", "Chromium 130", "Not_A Brand 24"],
  },
  {
    label: "Samsung Internet on Android",
    language: "ko-KR",
    brands: [
      { brand: "Samsung Internet", version: "27" },
      { brand: "Chromium", version: "125" },
      { brand: "Not_A Brand", version: "24" },
    ],
    platform: "Android",
    mobile: true,
    expectedBrands: ["Samsung Internet 27", "Chromium 125", "Not_A Brand 24"],
  },
  {
    label: "Chrome on an Android tablet, which is not mobile",
    language: "es-ES",
    brands: [
      { brand: "Google Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
    platform: "Android",
    mobile: false,
    expectedBrands: ["Google Chrome 131", "Chromium 131", "Not_A Brand 24"],
  },
];

/**
 * Browsers that do not implement User-Agent Client Hints. They are expected to yield the language
 * and nothing else, rather than guessed or placeholder values.
 */
const NO_CLIENT_HINTS_CASES: { label: string; language: string }[] = [
  { label: "Firefox on Windows", language: "en-US" },
  { label: "Safari on macOS", language: "en-GB" },
  { label: "Safari on iOS", language: "fr-FR" },
  { label: "Firefox on Android", language: "it-IT" },
  { label: "Internet Explorer 11", language: "en-US" },
];

describe("BrowserDetector", () => {
  it("exports a shared instance of the class", () => {
    expect(browserDetector).toBeInstanceOf(BrowserDetector);
  });

  it("detects attributes from the real browser it runs in", () => {
    const attributes = browserDetector.detect().attributes ?? {};

    expect(typeof attributes["browser.language"]).toBe("string");
    if ("userAgentData" in navigator && navigator.userAgentData != null) {
      expect(Array.isArray(attributes["browser.brands"])).toBe(true);
      expect(typeof attributes["browser.platform"]).toBe("string");
      expect(typeof attributes["browser.mobile"]).toBe("boolean");
    } else {
      expect(attributes).toMatchObject({ "browser.language": navigator.language });
    }
  });

  describe.each(CLIENT_HINTS_CASES)("$label", (expectation) => {
    it("emits every attribute when User-Agent Client Hints are available", () => {
      const attributes = detectWith({
        language: expectation.language,
        userAgent: "Mozilla/5.0 Test",
        userAgentData: {
          brands: expectation.brands,
          mobile: expectation.mobile,
          platform: expectation.platform,
        },
      });

      expect(attributes).toEqual({
        "browser.language": expectation.language,
        "browser.brands": expectation.expectedBrands,
        "browser.platform": expectation.platform,
        "browser.mobile": expectation.mobile,
      });
    });
  });

  describe.each(NO_CLIENT_HINTS_CASES)("$label", (expectation) => {
    it("emits only the language when User-Agent Client Hints are unavailable", () => {
      const attributes = detectWith({
        language: expectation.language,
        userAgent: "Mozilla/5.0 Test",
      });

      expect(attributes).toEqual({ "browser.language": expectation.language });
    });
  });

  it("leaves user agent attributes to the UserAgentDetector", () => {
    const attributes = detectWith({ language: "en-US", userAgent: "Mozilla/5.0 Test" });

    expect(attributes).not.toHaveProperty("user_agent.original");
    expect(attributes).toEqual({ "browser.language": "en-US" });
  });

  it("omits client-hint attributes when userAgentData is unavailable", () => {
    const attributes = detectWith({ language: "fr-FR", userAgent: "Mozilla/5.0 Firefox" });

    expect(attributes).toEqual({ "browser.language": "fr-FR" });
  });

  it("never falls back to the legacy navigator.platform", () => {
    const attributes = detectWith({
      language: "en-US",
      userAgent: "Mozilla/5.0 Safari",
      platform: "MacIntel",
    } as FakeNavigator);

    expect(attributes).not.toHaveProperty("browser.platform");
  });

  it("returns no attributes when navigator is undefined", () => {
    expect(detectWith(undefined)).toEqual({});
  });

  it("omits attributes rather than emitting empty or placeholder values", () => {
    const attributes = detectWith({
      language: "",
      userAgent: "",
      userAgentData: { brands: [], platform: "", mobile: undefined },
    });

    expect(attributes).toEqual({});
  });

  it("skips malformed brand entries and keeps well-formed ones", () => {
    const attributes = detectWith({
      language: "en-US",
      userAgentData: {
        brands: [null, { version: "1" }, { brand: "" }, { brand: "Chromium", version: "120" }],
      },
    });

    expect(attributes["browser.brands"]).toEqual(["Chromium 120"]);
  });

  it("keeps a brand with no version instead of dropping it", () => {
    const attributes = detectWith({
      language: "en-US",
      userAgentData: { brands: [{ brand: "Chromium" }] },
    });

    expect(attributes["browser.brands"]).toEqual(["Chromium"]);
  });

  it("does not emit the mutable document URL on the resource", () => {
    const attributes = browserDetector.detect().attributes ?? {};

    expect(attributes).not.toHaveProperty("browser.document.url.full");
  });

  it("does not throw when navigator members have unexpected types", () => {
    expect(() =>
      detectWith({ language: 42, userAgent: {}, userAgentData: { brands: "nope" } }),
    ).not.toThrow();
  });

  it("never throws for hostile navigator shapes", () => {
    const hostile: unknown[] = [
      { language: null, userAgentData: null },
      { language: "en-US", userAgentData: 42 },
      { language: "en-US", userAgentData: { brands: [undefined, 0, "x"] } },
      { language: "en-US", userAgentData: { brands: {}, platform: 7, mobile: "yes" } },
      { language: [], userAgentData: [] },
      {},
    ];

    for (const nav of hostile) {
      expect(() => detectWith(nav as FakeNavigator)).not.toThrow();

      for (const [key, value] of Object.entries(detectWith(nav as FakeNavigator))) {
        expect(key.startsWith("browser.")).toBe(true);
        expect(value).not.toBe("");
        expect(value).not.toBeNull();
      }
    }
  });

  it("emits only booleans for browser.mobile", () => {
    for (const mobile of [true, false]) {
      const attributes = detectWith({
        language: "en-US",
        userAgentData: { brands: [{ brand: "Chromium", version: "131" }], mobile, platform: "X" },
      });

      expect(attributes["browser.mobile"]).toBe(mobile);
    }
  });

  it("omits browser.mobile rather than coercing a non-boolean", () => {
    const attributes = detectWith({
      language: "en-US",
      userAgentData: { brands: [{ brand: "Chromium", version: "131" }], mobile: "true" },
    });

    expect(attributes).not.toHaveProperty("browser.mobile");
  });
});
