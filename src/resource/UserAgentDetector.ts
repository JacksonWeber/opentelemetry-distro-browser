// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  DetectedResource,
  DetectedResourceAttributes,
  ResourceDetector,
} from "@opentelemetry/resources";
import { ATTR_USER_AGENT_ORIGINAL } from "@opentelemetry/semantic-conventions";
import {
  ATTR_USER_AGENT_NAME,
  ATTR_USER_AGENT_OS_NAME,
  ATTR_USER_AGENT_OS_VERSION,
  ATTR_USER_AGENT_VERSION,
} from "@opentelemetry/semantic-conventions/incubating";
import { isBrowserEnvironment } from "./isBrowserEnvironment.js";

interface Matcher {
  /** Value reported for the attribute when {@link Matcher.detect} matches. */
  name: string;
  /** Token that identifies this product. */
  detect: RegExp;
  /** Version patterns, tried in order; the first one that matches wins. */
  version?: readonly RegExp[];
  /** Translates a raw version capture into the reported value, when the two differ. */
  releases?: Readonly<Record<string, string>>;
}

interface NavigatorUAData {
  getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: unknown }>;
}

interface NavigatorWithUAData extends Navigator {
  userAgentData?: NavigatorUAData;
}

const platformVersionCache = new WeakMap<NavigatorUAData, Promise<string | undefined>>();

// Chromium reports Universal API Contract versions for Windows: 13 and later identify Windows 11,
// while earlier supported values identify Windows 10.
const WINDOWS_11_PLATFORM_VERSION = 13;

const VERSION_TOKEN = /Version\/([\d.]+)/;

/**
 * Ordered browser matchers. Order is significant because user agent strings deliberately
 * impersonate each other: every Chromium browser contains `Chrome`, every WebKit-derived browser
 * contains `Safari`, and Chromium-based Edge and Opera contain both. The first match wins, so the
 * most specific token is always listed first.
 */
const BROWSERS: readonly Matcher[] = [
  { name: "Opera Mini", detect: /Opera Mini/, version: [/Opera Mini\/([\d.]+)/, VERSION_TOKEN] },
  { name: "Opera", detect: /OPR\//, version: [/OPR\/([\d.]+)/] },
  // Presto-era Opera reports the engine release in `Opera/` (always 9.80) and the real browser
  // release in `Version/`, so the `Version/` token must be preferred here.
  { name: "Opera", detect: /Opera[\s/]/, version: [VERSION_TOKEN, /Opera[\s/]([\d.]+)/] },
  { name: "Edge", detect: /EdgiOS\//, version: [/EdgiOS\/([\d.]+)/] },
  { name: "Edge", detect: /EdgA\//, version: [/EdgA\/([\d.]+)/] },
  { name: "Edge", detect: /Edg\//, version: [/Edg\/([\d.]+)/] },
  { name: "Edge", detect: /Edge\//, version: [/Edge\/([\d.]+)/] },
  { name: "Vivaldi", detect: /Vivaldi\//, version: [/Vivaldi\/([\d.]+)/] },
  { name: "Yandex Browser", detect: /YaBrowser\//, version: [/YaBrowser\/([\d.]+)/] },
  { name: "UC Browser", detect: /UCBrowser\//, version: [/UCBrowser\/([\d.]+)/] },
  { name: "Samsung Internet", detect: /SamsungBrowser\//, version: [/SamsungBrowser\/([\d.]+)/] },
  { name: "Amazon Silk", detect: /Silk\//, version: [/Silk\/([\d.]+)/] },
  { name: "Electron", detect: /Electron\//, version: [/Electron\/([\d.]+)/] },
  { name: "PhantomJS", detect: /PhantomJS/, version: [/PhantomJS\/([\d.]+)/] },
  { name: "Firefox", detect: /FxiOS\//, version: [/FxiOS\/([\d.]+)/] },
  { name: "Chrome", detect: /CriOS\//, version: [/CriOS\/([\d.]+)/] },
  { name: "Chrome", detect: /Chrome\//, version: [/Chrome\/([\d.]+)/] },
  { name: "Firefox", detect: /Firefox\//, version: [/Firefox\/([\d.]+)/] },
  // IEMobile must precede the desktop Internet Explorer tokens, which it also carries.
  { name: "IE Mobile", detect: /IEMobile/, version: [/IEMobile\/([\d.]+)/, /MSIE ([\d.]+)/] },
  { name: "Internet Explorer", detect: /MSIE /, version: [/MSIE ([\d.]+)/] },
  { name: "Internet Explorer", detect: /Trident\//, version: [/rv:([\d.]+)/] },
  { name: "BlackBerry Browser", detect: /BlackBerry|BB10/, version: [VERSION_TOKEN] },
  // Anything left that is on Android and carries a `Version/` token is the pre-Chrome stock
  // browser; Chrome and the other Android browsers have already been matched above.
  { name: "Android Browser", detect: /Android.*Version\/.*Safari/, version: [VERSION_TOKEN] },
  // Safari reports its release in `Version/`; the `Safari/` token carries the WebKit build number,
  // which is not the browser version, so it is deliberately not used as a version fallback.
  { name: "Safari", detect: /Safari\//, version: [VERSION_TOKEN] },
];

/**
 * Maps a Windows NT kernel version to its marketing release. Windows 10 and Windows 11 both report
 * `Windows NT 10.0`, so 11 is not distinguishable from the user agent string alone and such agents
 * are reported as `10`. Unrecognised kernel versions yield no version at all.
 */
const WINDOWS_NT_VERSIONS: Readonly<Record<string, string>> = {
  "10.0": "10",
  "6.3": "8.1",
  "6.2": "8",
  "6.1": "7",
  "6.0": "Vista",
  "5.2": "XP",
  "5.1": "XP",
  "5.0": "2000",
};

/**
 * Ordered operating system matchers. Android, Chrome OS and Ubuntu user agents also contain
 * `Linux`, and iOS user agents contain `like Mac OS X`, so the more specific entries are first.
 */
const OPERATING_SYSTEMS: readonly Matcher[] = [
  { name: "Windows Phone", detect: /Windows Phone/, version: [/Windows Phone(?: OS)? (\d[\d.]*)/] },
  { name: "iOS", detect: /iPhone|iPad|iPod/, version: [/OS (\d[\d_]*)/] },
  { name: "Android", detect: /Android/, version: [/Android[\s/](\d[\d.]*)/] },
  { name: "Chrome OS", detect: /CrOS/, version: [/CrOS \S+ (\d[\d.]*)/] },
  { name: "BlackBerry", detect: /BlackBerry|BB10/, version: [/Version\/([\d.]+)/] },
  { name: "macOS", detect: /Mac OS X|Macintosh/, version: [/Mac OS X (\d[\d_.]*)/] },
  {
    name: "Windows",
    detect: /Windows NT/,
    version: [/Windows NT (\d[\d.]*)/],
    releases: WINDOWS_NT_VERSIONS,
  },
  { name: "Windows", detect: /Windows (?:95|98|ME)/, version: [/Windows (95|98|ME)/] },
  { name: "Windows", detect: /Windows/ },
  { name: "Ubuntu", detect: /Ubuntu/ },
  { name: "Fedora", detect: /Fedora/ },
  { name: "FreeBSD", detect: /FreeBSD/ },
  { name: "OpenBSD", detect: /OpenBSD/ },
  { name: "NetBSD", detect: /NetBSD/ },
  { name: "DragonFly BSD", detect: /DragonFly/ },
  { name: "Solaris", detect: /SunOS|Solaris/ },
  // `X11` only means the X Window System, which the BSDs and Solaris also run, so it is not
  // evidence of Linux. A scope that reaches here with `X11` alone reports no operating system.
  { name: "Linux", detect: /Linux/ },
];

/**
 * Returns the first capture group of the first matching pattern, or `undefined` when none match.
 * Apple platforms separate version components with underscores (`10_15_7`), which are normalised
 * to dots.
 */
function matchVersion(userAgent: string, patterns: readonly RegExp[] | undefined) {
  for (const pattern of patterns ?? []) {
    const version = pattern.exec(userAgent)?.[1];
    if (version) {
      return version.replace(/_/g, ".");
    }
  }

  return undefined;
}

function findMatch(userAgent: string, matchers: readonly Matcher[]): Matcher | undefined {
  for (const matcher of matchers) {
    if (matcher.detect.test(userAgent)) {
      return matcher;
    }
  }

  return undefined;
}

function getPlatformVersion(uaData: NavigatorUAData): Promise<string | undefined> {
  const cached = platformVersionCache.get(uaData);
  if (cached) {
    return cached;
  }

  let platformVersion: Promise<string | undefined>;
  try {
    platformVersion = Promise.resolve(uaData.getHighEntropyValues?.(["platformVersion"]))
      .then((values) => {
        const value = values?.platformVersion;
        return typeof value === "string" && value !== "" ? value : undefined;
      })
      .catch(() => undefined);
  } catch {
    platformVersion = Promise.resolve(undefined);
  }

  platformVersionCache.set(uaData, platformVersion);
  return platformVersion;
}

function mapPlatformVersion(
  osName: string,
  platformVersion: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (!platformVersion) {
    return fallback;
  }

  if (osName !== "Windows") {
    return platformVersion;
  }

  const majorVersion = /^(\d+)(?:\.|$)/.exec(platformVersion)?.[1];
  if (majorVersion === undefined) {
    return fallback;
  }

  const major = Number(majorVersion);
  if (major === 0) {
    return fallback;
  }
  return major >= WINDOWS_11_PLATFORM_VERSION ? "11" : "10";
}

/**
 * Detects the `user_agent.*` resource attributes: the raw user agent string and the browser and
 * operating system details extracted from it.
 *
 * Unlike the client-hints-based `BrowserDetector`, this works on every browser, current or legacy,
 * because every browser exposes `navigator.userAgent`. The trade-off is that the values are derived
 * by pattern matching, which is inherently approximate: user agent strings impersonate one another
 * by design, are frozen or reduced by modern browsers, and change without notice. Register this
 * detector when broad coverage matters more than exactness.
 *
 * User-agent parsing is synchronous. When User-Agent Client Hints are available, the OS version is
 * resolved asynchronously from the cached high-entropy `platformVersion`; failures fall back to the
 * user-agent-derived version. Detection yields no attributes outside a browser scope — server-side
 * rendering and prerendering under Node, Deno or Bun included, since those runtimes expose a
 * `navigator` global whose `userAgent` describes the runtime rather than a browser. Web workers
 * remain supported.
 *
 * @public
 */
export class UserAgentDetector implements ResourceDetector {
  /**
   * Returns the user agent resource attributes that can be determined in the current environment.
   */
  detect(): DetectedResource {
    const attributes: DetectedResourceAttributes = {};

    // Node, Deno and Bun all expose a `navigator` global whose `userAgent` describes the runtime
    // rather than a browser, so require a real browser scope before reading it.
    if (!isBrowserEnvironment()) {
      return { attributes };
    }

    const nav: NavigatorWithUAData | undefined =
      typeof navigator === "undefined" ? undefined : navigator;
    const userAgent = nav?.userAgent;

    if (typeof userAgent !== "string" || userAgent === "") {
      return { attributes };
    }

    attributes[ATTR_USER_AGENT_ORIGINAL] = userAgent;

    const browser = findMatch(userAgent, BROWSERS);
    if (browser) {
      attributes[ATTR_USER_AGENT_NAME] = browser.name;

      const version = matchVersion(userAgent, browser.version);
      if (version) {
        attributes[ATTR_USER_AGENT_VERSION] = version;
      }
    }

    const os = findMatch(userAgent, OPERATING_SYSTEMS);
    if (os) {
      attributes[ATTR_USER_AGENT_OS_NAME] = os.name;

      const version = matchVersion(userAgent, os.version);
      // An unrecognised Windows kernel version yields no release rather than a raw NT number.
      const release = version ? (os.releases ? os.releases[version] : version) : undefined;
      const uaData = nav?.userAgentData;
      if (typeof uaData?.getHighEntropyValues === "function") {
        attributes[ATTR_USER_AGENT_OS_VERSION] = getPlatformVersion(uaData).then(
          (platformVersion) => mapPlatformVersion(os.name, platformVersion, release),
        );
      } else if (release) {
        attributes[ATTR_USER_AGENT_OS_VERSION] = release;
      }
    }

    return { attributes };
  }
}

/**
 * Shared {@link UserAgentDetector} instance.
 *
 * @public
 */
export const userAgentDetector = /* @__PURE__ */ new UserAgentDetector();
