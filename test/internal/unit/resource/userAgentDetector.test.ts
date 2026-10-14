// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { UserAgentDetector, userAgentDetector } from "../../../../src/resource/index.js";

function detectWith(userAgent: unknown): Record<string, unknown> {
  vi.stubGlobal("navigator", userAgent === undefined ? undefined : { userAgent });
  try {
    return userAgentDetector.detect().attributes as Record<string, unknown>;
  } finally {
    vi.unstubAllGlobals();
  }
}

function detectWithNavigator(nav: unknown): Record<string, unknown> {
  vi.stubGlobal("navigator", nav);
  try {
    return userAgentDetector.detect().attributes as Record<string, unknown>;
  } finally {
    vi.unstubAllGlobals();
  }
}

interface Expectation {
  label: string;
  userAgent: string;
  /** Omitted when the browser is not expected to be recognised. */
  name?: string;
  version?: string;
  /** Omitted when the operating system is not expected to be recognised. */
  osName?: string;
  osVersion?: string;
}

/**
 * User agent strings of browsers that are long out of support. These are the cases where naive
 * matching breaks: Internet Explorer spells its version three different ways, Presto-era Opera
 * reports the engine release rather than the browser release, and the Android stock browser
 * impersonates Safari.
 */
const LEGACY_CASES: Expectation[] = [
  {
    label: "Internet Explorer 5 on Windows 98",
    userAgent: "Mozilla/4.0 (compatible; MSIE 5.0; Windows 98)",
    name: "Internet Explorer",
    version: "5.0",
    osName: "Windows",
    osVersion: "98",
  },
  {
    label: "Internet Explorer 6 on Windows 2000",
    userAgent: "Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.0)",
    name: "Internet Explorer",
    version: "6.0",
    osName: "Windows",
    osVersion: "2000",
  },
  {
    label: "Internet Explorer 6 on Windows XP",
    userAgent: "Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; SV1; .NET CLR 2.0.50727)",
    name: "Internet Explorer",
    version: "6.0",
    osName: "Windows",
    osVersion: "XP",
  },
  {
    label: "Internet Explorer 7 on Windows Vista",
    userAgent: "Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 6.0; SLCC1)",
    name: "Internet Explorer",
    version: "7.0",
    osName: "Windows",
    osVersion: "Vista",
  },
  {
    label: "Internet Explorer 8 on Windows XP",
    userAgent: "Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 5.1; Trident/4.0)",
    name: "Internet Explorer",
    version: "8.0",
    osName: "Windows",
    osVersion: "XP",
  },
  {
    label: "Internet Explorer 9 on Windows 7",
    userAgent: "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)",
    name: "Internet Explorer",
    version: "9.0",
    osName: "Windows",
    osVersion: "7",
  },
  {
    label: "Internet Explorer 10 on Windows 8",
    userAgent: "Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2; Trident/6.0)",
    name: "Internet Explorer",
    version: "10.0",
    osName: "Windows",
    osVersion: "8",
  },
  {
    label: "Internet Explorer 11 on Windows 8.1",
    userAgent: "Mozilla/5.0 (Windows NT 6.3; Trident/7.0; rv:11.0) like Gecko",
    name: "Internet Explorer",
    version: "11.0",
    osName: "Windows",
    osVersion: "8.1",
  },
  {
    label: "Internet Explorer 11 on Windows 7",
    userAgent: "Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko",
    name: "Internet Explorer",
    version: "11.0",
    osName: "Windows",
    osVersion: "7",
  },
  {
    label: "Internet Explorer Mobile 9 on Windows Phone 7.5",
    userAgent:
      "Mozilla/4.0 (compatible; MSIE 9.0; Windows Phone OS 7.5; Trident/5.0; IEMobile/9.0; SAMSUNG; SGH-i917)",
    name: "IE Mobile",
    version: "9.0",
    osName: "Windows Phone",
    osVersion: "7.5",
  },
  {
    label: "Internet Explorer Mobile 11 on Windows Phone 8.1",
    userAgent:
      "Mozilla/5.0 (Mobile; Windows Phone 8.1; Android 4.0; ARM; Trident/7.0; Touch; rv:11.0; IEMobile/11.0; NOKIA; Lumia 520) like iPhone OS 7_0_3 Mac OS X AppleWebKit/537 (KHTML, like Gecko) Mobile Safari/537",
    name: "IE Mobile",
    version: "11.0",
    osName: "Windows Phone",
    osVersion: "8.1",
  },
  {
    label: "Legacy Edge 18 on Windows 10",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.140 Safari/537.36 Edge/18.17763",
    name: "Edge",
    version: "18.17763",
    osName: "Windows",
    osVersion: "10",
  },
  {
    label: "Presto Opera 12 on Windows 7",
    userAgent: "Opera/9.80 (Windows NT 6.1; WOW64) Presto/2.12.388 Version/12.16",
    name: "Opera",
    version: "12.16",
    osName: "Windows",
    osVersion: "7",
  },
  {
    label: "Presto Opera 11 on macOS",
    userAgent: "Opera/9.80 (Macintosh; Intel Mac OS X 10.6.8; U; en) Presto/2.8.131 Version/11.11",
    name: "Opera",
    version: "11.11",
    osName: "macOS",
    osVersion: "10.6.8",
  },
  {
    label: "Opera Mini on Android",
    userAgent:
      "Opera/9.80 (Android; Opera Mini/7.5.33361/34.1160; U; en) Presto/2.8.119 Version/11.10",
    name: "Opera Mini",
    version: "7.5.33361",
    osName: "Android",
  },
  {
    label: "Firefox 3.6 on Windows XP",
    userAgent:
      "Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US; rv:1.9.2) Gecko/20100115 Firefox/3.6",
    name: "Firefox",
    version: "3.6",
    osName: "Windows",
    osVersion: "XP",
  },
  {
    label: "Firefox 52 ESR on Windows 7",
    userAgent: "Mozilla/5.0 (Windows NT 6.1; rv:52.0) Gecko/20100101 Firefox/52.0",
    name: "Firefox",
    version: "52.0",
    osName: "Windows",
    osVersion: "7",
  },
  {
    label: "Safari 5.1 on Windows 7",
    userAgent:
      "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/534.57.2 (KHTML, like Gecko) Version/5.1.7 Safari/534.57.2",
    name: "Safari",
    version: "5.1.7",
    osName: "Windows",
    osVersion: "7",
  },
  {
    label: "Safari on iPhone OS 5",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 5_1 like Mac OS X) AppleWebKit/534.46 (KHTML, like Gecko) Version/5.1 Mobile/9B179 Safari/7534.48.3",
    name: "Safari",
    version: "5.1",
    osName: "iOS",
    osVersion: "5.1",
  },
  {
    label: "Safari on iPad iOS 6",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 6_0 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10A5355d Safari/8536.25",
    name: "Safari",
    version: "6.0",
    osName: "iOS",
    osVersion: "6.0",
  },
  {
    label: "Android 4.3 stock browser",
    userAgent:
      "Mozilla/5.0 (Linux; U; Android 4.3; en-us; SM-N900T Build/JSS15J) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30",
    name: "Android Browser",
    version: "4.0",
    osName: "Android",
    osVersion: "4.3",
  },
  {
    label: "BlackBerry 10",
    userAgent:
      "Mozilla/5.0 (BB10; Touch) AppleWebKit/537.10+ (KHTML, like Gecko) Version/10.0.9.2372 Mobile Safari/537.10+",
    name: "BlackBerry Browser",
    version: "10.0.9.2372",
    osName: "BlackBerry",
    osVersion: "10.0.9.2372",
  },
  {
    label: "BlackBerry OS 5 feature phone",
    userAgent:
      "BlackBerry9700/5.0.0.862 Profile/MIDP-2.1 Configuration/CLDC-1.1 VendorID/331 UP.Link/5.1.2.12",
    name: "BlackBerry Browser",
    osName: "BlackBerry",
  },
  {
    label: "Samsung Internet 4 on Android 6",
    userAgent:
      "Mozilla/5.0 (Linux; Android 6.0.1; SAMSUNG SM-G935F Build/MMB29K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/4.0 Chrome/44.0.2403.133 Mobile Safari/537.36",
    name: "Samsung Internet",
    version: "4.0",
    osName: "Android",
    osVersion: "6.0.1",
  },
  {
    label: "PhantomJS 2 on Linux",
    userAgent:
      "Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/534.34 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/534.34",
    name: "PhantomJS",
    version: "2.1.1",
    osName: "Linux",
  },
  {
    label: "UC Browser on Android 9",
    userAgent:
      "Mozilla/5.0 (Linux; U; Android 9; en-US; Redmi Note 8 Build/PKQ1) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Chrome/40.0.2214.89 UCBrowser/12.13.5.1209 Mobile Safari/533.1",
    name: "UC Browser",
    version: "12.13.5.1209",
    osName: "Android",
    osVersion: "9",
  },
];

/** User agent strings of currently shipping browsers across every major platform. */
const MODERN_CASES: Expectation[] = [
  {
    label: "Chrome 131 on Windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    name: "Chrome",
    version: "131.0.0.0",
    osName: "Windows",
    osVersion: "10",
  },
  {
    label: "Chrome 131 on macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    name: "Chrome",
    version: "131.0.0.0",
    osName: "macOS",
    osVersion: "10.15.7",
  },
  {
    label: "Chrome 131 on Linux",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    name: "Chrome",
    version: "131.0.0.0",
    osName: "Linux",
  },
  {
    label: "Chrome 131 on Android 15",
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    name: "Chrome",
    version: "131.0.0.0",
    osName: "Android",
    osVersion: "15",
  },
  {
    label: "Chrome 131 on iOS",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
    name: "Chrome",
    version: "131.0.6778.73",
    osName: "iOS",
    osVersion: "18.1",
  },
  {
    label: "Chrome 131 on Chrome OS",
    userAgent:
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    name: "Chrome",
    version: "131.0.0.0",
    osName: "Chrome OS",
    osVersion: "14541.0.0",
  },
  {
    label: "Headless Chrome on Linux",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
    name: "Chrome",
    version: "131.0.0.0",
    osName: "Linux",
  },
  {
    label: "Brave on Windows, which is indistinguishable from Chrome",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    name: "Chrome",
    version: "131.0.0.0",
    osName: "Windows",
    osVersion: "10",
  },
  {
    label: "Edge 131 on Windows 11, which reports itself as Windows 10",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
    name: "Edge",
    version: "131.0.2903.70",
    osName: "Windows",
    osVersion: "10",
  },
  {
    label: "Edge 131 on macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
    name: "Edge",
    version: "131.0.2903.70",
    osName: "macOS",
    osVersion: "10.15.7",
  },
  {
    label: "Edge on Android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 10; HD1913) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.2903.87",
    name: "Edge",
    version: "131.0.2903.87",
    osName: "Android",
    osVersion: "10",
  },
  {
    label: "Edge on iOS",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/131.2903.92 Mobile/15E148 Safari/605.1.15",
    name: "Edge",
    version: "131.2903.92",
    osName: "iOS",
    osVersion: "18.1",
  },
  {
    label: "Firefox 133 on Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    name: "Firefox",
    version: "133.0",
    osName: "Windows",
    osVersion: "10",
  },
  {
    label: "Firefox 133 on macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    name: "Firefox",
    version: "133.0",
    osName: "macOS",
    osVersion: "10.15",
  },
  {
    label: "Firefox 133 on Ubuntu",
    userAgent: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    name: "Firefox",
    version: "133.0",
    osName: "Ubuntu",
  },
  {
    label: "Firefox 133 on Fedora",
    userAgent: "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    name: "Firefox",
    version: "133.0",
    osName: "Fedora",
  },
  {
    label: "Firefox on FreeBSD, which uses X11 without being Linux",
    userAgent: "Mozilla/5.0 (X11; FreeBSD amd64; rv:133.0) Gecko/20100101 Firefox/133.0",
    name: "Firefox",
    version: "133.0",
    osName: "FreeBSD",
  },
  {
    label: "Firefox on OpenBSD",
    userAgent: "Mozilla/5.0 (X11; OpenBSD amd64; rv:128.0) Gecko/20100101 Firefox/128.0",
    name: "Firefox",
    version: "128.0",
    osName: "OpenBSD",
  },
  {
    label: "Firefox on NetBSD",
    userAgent: "Mozilla/5.0 (X11; NetBSD amd64; rv:115.0) Gecko/20100101 Firefox/115.0",
    name: "Firefox",
    version: "115.0",
    osName: "NetBSD",
  },
  {
    label: "Firefox on Solaris",
    userAgent: "Mozilla/5.0 (X11; SunOS i86pc; rv:115.0) Gecko/20100101 Firefox/115.0",
    name: "Firefox",
    version: "115.0",
    osName: "Solaris",
  },
  {
    label: "Firefox on Android",
    userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0",
    name: "Firefox",
    version: "133.0",
    osName: "Android",
    osVersion: "14",
  },
  {
    label: "Firefox on iOS",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15",
    name: "Firefox",
    version: "133.0",
    osName: "iOS",
    osVersion: "18.1",
  },
  {
    label: "Safari 18 on macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    name: "Safari",
    version: "18.1",
    osName: "macOS",
    osVersion: "10.15.7",
  },
  {
    label: "Safari 18 on iOS",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    name: "Safari",
    version: "18.1",
    osName: "iOS",
    osVersion: "18.1",
  },
  {
    label: "Safari 18 on iPadOS",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    name: "Safari",
    version: "18.1",
    osName: "iOS",
    osVersion: "18.1",
  },
  {
    label: "Opera 115 on Windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
    name: "Opera",
    version: "115.0.0.0",
    osName: "Windows",
    osVersion: "10",
  },
  {
    label: "Vivaldi on Windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Vivaldi/7.0.3495.11",
    name: "Vivaldi",
    version: "7.0.3495.11",
    osName: "Windows",
    osVersion: "10",
  },
  {
    label: "Yandex Browser on Windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36",
    name: "Yandex Browser",
    version: "24.10.0.0",
    osName: "Windows",
    osVersion: "10",
  },
  {
    label: "Samsung Internet 27 on Android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
    name: "Samsung Internet",
    version: "27.0",
    osName: "Android",
    osVersion: "14",
  },
  {
    label: "Amazon Silk on Fire OS",
    userAgent:
      "Mozilla/5.0 (Linux; Android 9; KFONWI Build/PS7326) AppleWebKit/537.36 (KHTML, like Gecko) Silk/104.4.3 like Chrome/104.0.5112.97 Safari/537.36",
    name: "Amazon Silk",
    version: "104.4.3",
    osName: "Android",
    osVersion: "9",
  },
  {
    label: "Electron application on Windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MyApp/1.0.0 Chrome/128.0.6613.36 Electron/32.0.1 Safari/537.36",
    name: "Electron",
    version: "32.0.1",
    osName: "Windows",
    osVersion: "10",
  },
];

const ALL_CASES = [...LEGACY_CASES, ...MODERN_CASES];

/** Inputs a detector running during SDK start-up can plausibly be handed in the wild. */
const HOSTILE_INPUTS: unknown[] = [
  "",
  " ",
  "\u0000",
  "()))((( malformed",
  "Mozilla/5.0 (Windows NT",
  "Chrome/",
  "Version/",
  "Windows NT",
  "Android",
  "MSIE",
  "🦊 Firefox/133.0 🦊",
  `Mozilla/5.0 ${"A".repeat(10_000)}`,
  42,
  true,
  null,
  {},
  [],
  () => "Chrome/131.0.0.0",
];

describe("UserAgentDetector", () => {
  it("exports a shared instance of the class", () => {
    expect(userAgentDetector).toBeInstanceOf(UserAgentDetector);
  });

  it("detects attributes from the real browser it runs in", () => {
    const attributes = userAgentDetector.detect().attributes ?? {};

    expect(typeof attributes["user_agent.original"]).toBe("string");
    expect(typeof attributes["user_agent.name"]).toBe("string");
    expect(typeof attributes["user_agent.os.name"]).toBe("string");
  });

  describe.each(ALL_CASES)("$label", (expectation) => {
    it("extracts the browser and operating system", () => {
      const attributes = detectWith(expectation.userAgent);

      expect(attributes).toEqual({
        "user_agent.original": expectation.userAgent,
        ...(expectation.name === undefined ? {} : { "user_agent.name": expectation.name }),
        ...(expectation.version === undefined ? {} : { "user_agent.version": expectation.version }),
        ...(expectation.osName === undefined ? {} : { "user_agent.os.name": expectation.osName }),
        ...(expectation.osVersion === undefined
          ? {}
          : { "user_agent.os.version": expectation.osVersion }),
      });
    });
  });

  describe("across the whole user agent corpus", () => {
    it("always reports the original string unchanged", () => {
      for (const { userAgent } of ALL_CASES) {
        expect(detectWith(userAgent)["user_agent.original"]).toBe(userAgent);
      }
    });

    it("never emits a placeholder in place of an unknown value", () => {
      for (const { userAgent } of ALL_CASES) {
        for (const value of Object.values(detectWith(userAgent))) {
          expect(typeof value).toBe("string");
          expect(value).not.toBe("");
          expect(value).not.toBe("unknown");
          expect(value).not.toBe("Unknown");
        }
      }
    });

    it("never emits a version without the product it belongs to", () => {
      for (const { userAgent } of ALL_CASES) {
        const attributes = detectWith(userAgent);

        if ("user_agent.version" in attributes) {
          expect(attributes).toHaveProperty("user_agent.name");
        }
        if ("user_agent.os.version" in attributes) {
          expect(attributes).toHaveProperty("user_agent.os.name");
        }
      }
    });

    it("never emits a version that still contains underscores", () => {
      for (const { userAgent } of ALL_CASES) {
        const attributes = detectWith(userAgent);

        expect(String(attributes["user_agent.version"] ?? "")).not.toContain("_");
        expect(String(attributes["user_agent.os.version"] ?? "")).not.toContain("_");
      }
    });

    it("stays inside the user_agent namespace", () => {
      for (const { userAgent } of ALL_CASES) {
        for (const key of Object.keys(detectWith(userAgent))) {
          expect(key.startsWith("user_agent.")).toBe(true);
        }
      }
    });

    it("recognises the browser for every agent in the corpus", () => {
      const unrecognised = ALL_CASES.filter(
        ({ userAgent }) => !("user_agent.name" in detectWith(userAgent)),
      ).map(({ label }) => label);

      expect(unrecognised).toEqual([]);
    });
  });

  describe("version extraction edge cases", () => {
    it("uses a cached high-entropy platform version to distinguish Windows 11", async () => {
      const getHighEntropyValues = vi.fn().mockResolvedValue({ platformVersion: "15.0.0" });
      const nav = {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        userAgentData: { getHighEntropyValues },
      };

      const first = detectWithNavigator(nav);
      const second = detectWithNavigator(nav);

      await expect(first["user_agent.os.version"]).resolves.toBe("11");
      await expect(second["user_agent.os.version"]).resolves.toBe("11");
      expect(getHighEntropyValues).toHaveBeenCalledOnce();
      expect(getHighEntropyValues).toHaveBeenCalledWith(["platformVersion"]);
    });

    it.each([
      ["12.0.0", "10"],
      ["13.0.0", "11"],
    ])("maps Windows platform version %s to Windows %s", async (platformVersion, expected) => {
      const attributes = detectWithNavigator({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        userAgentData: {
          getHighEntropyValues: vi.fn().mockResolvedValue({ platformVersion }),
        },
      });

      await expect(attributes["user_agent.os.version"]).resolves.toBe(expected);
    });

    it("falls back to the user agent OS version for a malformed platform version", async () => {
      const attributes = detectWithNavigator({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        userAgentData: {
          getHighEntropyValues: vi.fn().mockResolvedValue({ platformVersion: "13beta" }),
        },
      });

      await expect(attributes["user_agent.os.version"]).resolves.toBe("10");
    });

    it("falls back to the user agent OS version when high-entropy hints fail", async () => {
      const attributes = detectWithNavigator({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        userAgentData: { getHighEntropyValues: vi.fn().mockRejectedValue(new Error("denied")) },
      });

      await expect(attributes["user_agent.os.version"]).resolves.toBe("10");
    });

    it("does not use the WebKit build number as the Safari version", () => {
      const attributes = detectWith(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15",
      );

      expect(attributes["user_agent.name"]).toBe("Safari");
      expect(attributes).not.toHaveProperty("user_agent.version");
    });

    it("prefers the Presto Opera release over the frozen engine version", () => {
      const attributes = detectWith(
        "Opera/9.80 (Windows NT 6.1; WOW64) Presto/2.12.388 Version/12.16",
      );

      expect(attributes["user_agent.version"]).toBe("12.16");
    });

    it("omits the Windows release when the NT version is unrecognised", () => {
      const attributes = detectWith("Mozilla/5.0 (Windows NT 99.0; Win64; x64)");

      expect(attributes["user_agent.os.name"]).toBe("Windows");
      expect(attributes).not.toHaveProperty("user_agent.os.version");
    });

    it("recognises Windows without a version when no release token is present", () => {
      const attributes = detectWith("Mozilla/4.0 (compatible; MSIE 5.5; Windows)");

      expect(attributes["user_agent.os.name"]).toBe("Windows");
      expect(attributes).not.toHaveProperty("user_agent.os.version");
    });

    it("keeps the original string when nothing can be recognised", () => {
      const attributes = detectWith("SomeCompletelyUnknownAgent");

      expect(attributes).toEqual({ "user_agent.original": "SomeCompletelyUnknownAgent" });
    });
  });

  describe("ordering between browsers that impersonate each other", () => {
    const chromium =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    it.each([
      ["Edg/131.0.2903.70", "Edge"],
      ["OPR/115.0.0.0", "Opera"],
      ["Vivaldi/7.0.3495.11", "Vivaldi"],
      ["YaBrowser/24.10.0.0", "Yandex Browser"],
      ["Electron/32.0.1", "Electron"],
      ["SamsungBrowser/27.0", "Samsung Internet"],
      ["UCBrowser/12.13.5.1209", "UC Browser"],
    ])("prefers %s over the Chrome and Safari tokens it also carries", (token, expected) => {
      expect(detectWith(`${chromium} ${token}`)["user_agent.name"]).toBe(expected);
    });
  });

  describe("operating systems that share the X11 token", () => {
    it("does not claim Linux for an X11 user agent that names no known system", () => {
      const attributes = detectWith(
        "Mozilla/5.0 (X11; AIX 7.2; rv:115.0) Gecko/20100101 Firefox/115.0",
      );

      expect(attributes).not.toHaveProperty("user_agent.os.name");
      expect(attributes["user_agent.name"]).toBe("Firefox");
    });

    it.each([
      ["FreeBSD amd64", "FreeBSD"],
      ["OpenBSD amd64", "OpenBSD"],
      ["NetBSD amd64", "NetBSD"],
      ["DragonFly x86_64", "DragonFly BSD"],
      ["SunOS i86pc", "Solaris"],
      ["Linux x86_64", "Linux"],
    ])("reports %s as %s", (token, expected) => {
      expect(
        detectWith(`Mozilla/5.0 (X11; ${token}; rv:133.0) Gecko/20100101 Firefox/133.0`)[
          "user_agent.os.name"
        ],
      ).toBe(expected);
    });
  });

  describe("non-browser and hostile environments", () => {
    it("returns no attributes when navigator is undefined", () => {
      expect(detectWith(undefined)).toEqual({});
    });

    it("returns no attributes when navigator has no userAgent", () => {
      vi.stubGlobal("navigator", {});
      try {
        expect(userAgentDetector.detect().attributes).toEqual({});
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("never throws and never emits an empty value for hostile input", () => {
      for (const input of HOSTILE_INPUTS) {
        expect(() => detectWith(input)).not.toThrow();

        for (const value of Object.values(detectWith(input))) {
          expect(typeof value).toBe("string");
          expect(value).not.toBe("");
        }
      }
    });

    it("ignores user agent values that are not strings", () => {
      expect(detectWith(42)).toEqual({});
      expect(detectWith(null)).toEqual({});
      expect(detectWith({})).toEqual({});
    });

    it("reports very long user agents verbatim", () => {
      const userAgent = `Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0 ${"x".repeat(5000)}`;

      expect(detectWith(userAgent)["user_agent.original"]).toBe(userAgent);
    });
  });
});
