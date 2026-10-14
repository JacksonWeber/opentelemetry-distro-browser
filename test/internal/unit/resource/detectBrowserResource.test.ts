// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { detectResources, resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it, vi } from "vitest";
import {
  browserDetector,
  detectBrowserResource,
  userAgentDetector,
} from "../../../../src/resource/index.js";

describe("detectBrowserResource", () => {
  it("leaves the browser attributes out by default", () => {
    expect(detectBrowserResource().attributes).not.toHaveProperty("browser.language");
  });

  it("leaves the user agent attributes out by default", () => {
    expect(detectBrowserResource().attributes).not.toHaveProperty("user_agent.original");
  });

  it("keeps the default resource attributes", () => {
    expect(detectBrowserResource().attributes["service.name"]).toBeDefined();
  });

  it("includes the browser attributes when the caller opts in", () => {
    const resource = detectBrowserResource(detectResources({ detectors: [browserDetector] }));

    expect(typeof resource.attributes["browser.language"]).toBe("string");
  });

  it("includes the user agent attributes when the caller opts in", () => {
    const resource = detectBrowserResource(detectResources({ detectors: [userAgentDetector] }));

    expect(typeof resource.attributes["user_agent.original"]).toBe("string");
  });

  it("resolves the high-entropy Windows version when the caller opts in", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      userAgentData: {
        getHighEntropyValues: vi.fn().mockResolvedValue({ platformVersion: "15.0.0" }),
      },
    });
    try {
      const resource = detectResources({ detectors: [userAgentDetector] });
      await resource.waitForAsyncAttributes?.();

      expect(resource.attributes["user_agent.os.version"]).toBe("11");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("includes both sets of attributes when the caller opts into both detectors", () => {
    const resource = detectBrowserResource(
      detectResources({ detectors: [browserDetector, userAgentDetector] }),
    );

    expect(typeof resource.attributes["browser.language"]).toBe("string");
    expect(typeof resource.attributes["user_agent.original"]).toBe("string");
  });

  it("lets the caller resource override a detected attribute", () => {
    const resource = detectBrowserResource(
      detectResources({ detectors: [browserDetector] }).merge(
        resourceFromAttributes({ "browser.language": "xx-XX", "service.name": "checkout" }),
      ),
    );

    expect(resource.attributes["browser.language"]).toBe("xx-XX");
    expect(resource.attributes["service.name"]).toBe("checkout");
  });

  it("degrades to the default resource outside a browser", () => {
    vi.stubGlobal("navigator", undefined);
    try {
      const attributes = detectBrowserResource().attributes;

      expect(attributes).not.toHaveProperty("browser.language");
      expect(attributes["service.name"]).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not throw outside a browser", () => {
    vi.stubGlobal("navigator", undefined);
    try {
      expect(() => detectBrowserResource()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
