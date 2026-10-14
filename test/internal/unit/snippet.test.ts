// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, expect, it } from "vitest";
import {
  getSdkLoaderScript,
  type SdkLoaderConfig,
  type SdkLoaderInstrumentationName,
} from "../../../src/snippet.js";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../../src/shared/constants.js";
import type { AzureMonitorOptions } from "../../../src/exporter/base.js";
import type { PageViewInstrumentationConfig } from "../../../src/instrumentation/pageView/types.js";
import type {
  InstrumentationOptions,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/types.js";

type LoaderWindow = typeof window & {
  Microsoft?: {
    OpenTelemetry: {
      useMicrosoftOpenTelemetry(options: unknown): Promise<unknown>;
    };
  };
  microsoftOpenTelemetry?: Promise<unknown>;
  snippetOptions?: unknown;
};

const loaderWindow = window as LoaderWindow;
const fixtureUrl = new URL("../../fixtures/snippetBundle.js", import.meta.url).href;

const removeLoadedScript = (src: string): void => {
  Array.from(document.scripts)
    .find((candidate) => candidate.src === src)
    ?.remove();
};

const executeLoader = (
  config: Parameters<typeof getSdkLoaderScript>[0],
): {
  readonly inlineScript: HTMLScriptElement;
  readonly initialization: Promise<unknown>;
} => {
  const inlineScript = document.createElement("script");
  inlineScript.text = getSdkLoaderScript(config);
  document.head.append(inlineScript);
  if (!loaderWindow.microsoftOpenTelemetry) {
    throw new Error("Generated loader did not expose its initialization promise.");
  }
  return { inlineScript, initialization: loaderWindow.microsoftOpenTelemetry };
};

const createBundleUrl = (initializer: string): string =>
  URL.createObjectURL(
    new Blob(
      [
        `window.Microsoft={OpenTelemetry:{useMicrosoftOpenTelemetry:function(options){` +
          `window.snippetOptions=options;${initializer}}}};`,
      ],
      { type: "text/javascript" },
    ),
  );

const sri = async (src: string): Promise<string> => {
  const bytes = await fetch(src).then((response) => response.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-384", bytes));
  return `sha384-${btoa(String.fromCharCode(...hash))}`;
};

afterEach(() => {
  delete loaderWindow.Microsoft;
  delete loaderWindow.microsoftOpenTelemetry;
  delete loaderWindow.snippetOptions;
});

it("defaults to the versioned CDN bundle and validates explicit values", () => {
  const channel = /-([a-z]+)/.exec(OPENTELEMETRY_BROWSER_VERSION)?.[1] ?? "b";
  expect(getSdkLoaderScript({ connectionString: "connection" })).toContain(
    `"src":"https://js.monitor.azure.com/scripts/otel/${channel}/opentelemetry-browser.${OPENTELEMETRY_BROWSER_VERSION}.min.js"`,
  );
  expect(() => getSdkLoaderScript({ src: "", connectionString: "connection" })).toThrow(
    "SdkLoaderConfig.src must be a non-empty string when provided.",
  );
  expect(() =>
    getSdkLoaderScript({ src: null as unknown as string, connectionString: "connection" }),
  ).toThrow("SdkLoaderConfig.src must be a non-empty string when provided.");
  expect(() => getSdkLoaderScript(null as unknown as SdkLoaderConfig)).toThrow(
    "SdkLoaderConfig.connectionString must be a non-empty string.",
  );
  expect(() =>
    getSdkLoaderScript({ src: "https://example.test/sdk.js", connectionString: "" }),
  ).toThrow("SdkLoaderConfig.connectionString must be a non-empty string.");
  expect(() =>
    getSdkLoaderScript({
      src: "https://example.test/sdk.js",
      connectionString: "connection",
      integrity: "",
    }),
  ).toThrow("SdkLoaderConfig.integrity must be a non-empty string when provided.");
});

it("loads a matching integrity-protected bundle and initializes asynchronously", async () => {
  const integrity = await sri(fixtureUrl);
  const { inlineScript, initialization } = executeLoader({
    src: fixtureUrl,
    connectionString: "InstrumentationKey=test",
    integrity,
  });

  try {
    await expect(initialization).resolves.toMatchObject({
      forceFlush: expect.any(Function),
    });
    expect(loaderWindow.snippetOptions).toEqual({
      azureMonitor: { connectionString: "InstrumentationKey=test" },
      instrumentations: [],
    });
    expect(
      Array.from(document.scripts).find((candidate) => candidate.src === fixtureUrl)?.integrity,
    ).toBe(integrity);
  } finally {
    inlineScript.remove();
    removeLoadedScript(fixtureUrl);
  }
});

it("enables the default instrumentations the bundle provides", async () => {
  const src = URL.createObjectURL(
    new Blob(
      [
        `window.Microsoft={OpenTelemetry:{` +
          `getInstrumentations:function(options){window.instrumentationArguments=options;` +
          `return Promise.resolve(["fetch","xhr"])},` +
          `useMicrosoftOpenTelemetry:function(options){window.snippetOptions=options;` +
          `return Promise.resolve({})}}};`,
      ],
      { type: "text/javascript" },
    ),
  );
  const { inlineScript, initialization } = executeLoader({
    src,
    connectionString: "InstrumentationKey=test",
  });

  try {
    await initialization;
    expect((loaderWindow as { instrumentationArguments?: unknown }).instrumentationArguments).toBe(
      undefined,
    );
    expect(loaderWindow.snippetOptions).toEqual({
      azureMonitor: { connectionString: "InstrumentationKey=test" },
      instrumentations: ["fetch", "xhr"],
    });
  } finally {
    delete (loaderWindow as { instrumentationArguments?: unknown }).instrumentationArguments;
    inlineScript.remove();
    removeLoadedScript(src);
    URL.revokeObjectURL(src);
  }
});

it("rejects when the bundle cannot construct its instrumentations", async () => {
  const src = URL.createObjectURL(
    new Blob(
      [
        `window.Microsoft={OpenTelemetry:{` +
          `getInstrumentations:function(){return Promise.reject(new Error("instrumentation failure"))},` +
          `useMicrosoftOpenTelemetry:function(options){window.snippetOptions=options;` +
          `return Promise.resolve({})}}};`,
      ],
      { type: "text/javascript" },
    ),
  );
  const { inlineScript, initialization } = executeLoader({
    src,
    connectionString: "InstrumentationKey=test",
  });

  try {
    await expect(initialization).rejects.toThrow("instrumentation failure");
    expect(loaderWindow.snippetOptions).toBeUndefined();
  } finally {
    inlineScript.remove();
    removeLoadedScript(src);
    URL.revokeObjectURL(src);
  }
});

it("rejects when the integrity hash does not match", async () => {
  const { inlineScript, initialization } = executeLoader({
    src: fixtureUrl,
    connectionString: "InstrumentationKey=test",
    integrity: `sha384-${"A".repeat(64)}`,
  });

  try {
    await expect(initialization).rejects.toThrow("OpenTelemetry browser bundle failed to load");
  } finally {
    inlineScript.remove();
    removeLoadedScript(fixtureUrl);
  }
});

it("rejects network failures", async () => {
  const src = new URL(`/missing-snippet-${crypto.randomUUID()}.js`, location.origin).href;
  const { inlineScript, initialization } = executeLoader({
    src,
    connectionString: "InstrumentationKey=test",
  });

  try {
    await expect(initialization).rejects.toThrow(
      `OpenTelemetry browser bundle failed to load: ${src}`,
    );
  } finally {
    inlineScript.remove();
    removeLoadedScript(src);
  }
});

it("rejects when the loaded script does not expose the required global", async () => {
  const src = URL.createObjectURL(new Blob(["void 0;"], { type: "text/javascript" }));
  const { inlineScript, initialization } = executeLoader({
    src,
    connectionString: "InstrumentationKey=test",
  });

  try {
    await expect(initialization).rejects.toThrow(
      "OpenTelemetry browser bundle did not expose Microsoft.OpenTelemetry",
    );
  } finally {
    inlineScript.remove();
    removeLoadedScript(src);
    URL.revokeObjectURL(src);
  }
});

it.each([
  ["synchronous errors", 'throw new Error("sync initialization failure")'],
  ["promise rejections", 'return Promise.reject(new Error("async initialization failure"))'],
])("rejects initializer %s", async (_label, initializer) => {
  const src = createBundleUrl(initializer);
  const { inlineScript, initialization } = executeLoader({
    src,
    connectionString: "InstrumentationKey=test",
  });

  try {
    await expect(initialization).rejects.toThrow(/initialization failure/);
  } finally {
    inlineScript.remove();
    removeLoadedScript(src);
    URL.revokeObjectURL(src);
  }
});

it("escapes values embedded in an inline script", () => {
  const generated = getSdkLoaderScript({
    src: "https://example.test/sdk.js",
    connectionString: "</script>\u2028",
  });

  expect(generated).not.toContain("</script>");
  expect(generated).toContain("\\u003c/script\\u003e\\u2028");
});

// Compile-time guards: every snippet option must stay assignable to its npm counterpart.
type Options = MicrosoftOpenTelemetryBrowserOptions;
const snippetOptionsMatchTheDistribution = (
  config: Required<SdkLoaderConfig>,
): Pick<Options, "samplingPercentage" | "session" | "userContext" | "pageView"> & {
  azureMonitor: Partial<AzureMonitorOptions>;
  instrumentationOptions: InstrumentationOptions;
} => config;
const pageViewDataFields = (
  config: Required<PageViewInstrumentationConfig>,
): Required<NonNullable<SdkLoaderConfig["pageView"]>> => config;
void snippetOptionsMatchTheDistribution;
void pageViewDataFields;
const instrumentationNamesMatch = (
  name: keyof InstrumentationOptions,
): SdkLoaderInstrumentationName => name;
const instrumentationNamesExist = (
  name: SdkLoaderInstrumentationName,
): keyof InstrumentationOptions => name;
void instrumentationNamesMatch;
void instrumentationNamesExist;

const configuredOptions = {
  samplingPercentage: 25,
  azureMonitor: { disableBeacon: true },
  session: { enabled: true, persist: false, inactivityTimeout: 60, maxDuration: 600 },
  userContext: { enabled: false },
  pageView: {
    enabled: true,
    redactedQueryParams: ["token"],
    softNavigationSettleTimeoutMs: 500,
    useNavigationApiIfAvailable: true,
  },
  instrumentationOptions: { errors: { enabled: true }, fetch: { enabled: false } },
  resourceAttributes: { "service.name": "shop", "service.version": "1.2.3", "build.number": 7 },
} satisfies Omit<SdkLoaderConfig, "connectionString">;

it("leaves optional settings out of the default loader", () => {
  const generated = getSdkLoaderScript({
    src: "https://example.test/sdk.js",
    connectionString: "connection",
  });

  expect(generated).toMatch(
    /\(window,document,\{"src":"https:\/\/example\.test\/sdk\.js","crossOrigin":"anonymous","cfg":\{"azureMonitor":\{"connectionString":"connection"\}\}\}\);$/,
  );
});

it("passes configured options to the bundle", async () => {
  const src = URL.createObjectURL(
    new Blob(
      [
        `window.Microsoft={OpenTelemetry:{` +
          `getInstrumentations:function(options){window.instrumentationArguments=options;` +
          `return Promise.resolve(["errors"])},` +
          `resourceFromAttributes:function(attributes){return {attributes:attributes,built:true}},` +
          `useMicrosoftOpenTelemetry:function(options){window.snippetOptions=options;` +
          `return Promise.resolve({})}}};`,
      ],
      { type: "text/javascript" },
    ),
  );
  const { inlineScript, initialization } = executeLoader({
    src,
    connectionString: "InstrumentationKey=test",
    ...configuredOptions,
  });

  try {
    await initialization;
    expect(
      (loaderWindow as { instrumentationArguments?: unknown }).instrumentationArguments,
    ).toEqual(configuredOptions.instrumentationOptions);
    expect(loaderWindow.snippetOptions).toEqual({
      samplingPercentage: 25,
      azureMonitor: { connectionString: "InstrumentationKey=test", disableBeacon: true },
      session: configuredOptions.session,
      userContext: configuredOptions.userContext,
      pageView: configuredOptions.pageView,
      instrumentations: ["errors"],
      resource: { attributes: configuredOptions.resourceAttributes, built: true },
    });
  } finally {
    delete (loaderWindow as { instrumentationArguments?: unknown }).instrumentationArguments;
    inlineScript.remove();
    removeLoadedScript(src);
    URL.revokeObjectURL(src);
  }
});

it("keeps the connection string when azureMonitor is configured", () => {
  const generated = getSdkLoaderScript({
    src: "https://example.test/sdk.js",
    connectionString: "connection",
    azureMonitor: { connectionString: "other" } as SdkLoaderConfig["azureMonitor"],
  });

  expect(generated).toContain('"cfg":{"azureMonitor":{"connectionString":"connection"}}');
});

it("rejects resource attributes when the bundle cannot build a resource", async () => {
  const src = createBundleUrl("return Promise.resolve({})");
  const { inlineScript, initialization } = executeLoader({
    src,
    connectionString: "InstrumentationKey=test",
    resourceAttributes: { "service.name": "shop" },
  });

  try {
    await expect(initialization).rejects.toThrow(TypeError);
    expect(loaderWindow.snippetOptions).toBeUndefined();
  } finally {
    inlineScript.remove();
    removeLoadedScript(src);
    URL.revokeObjectURL(src);
  }
});

it.each([
  ["samplingPercentage", -1, "a number from 0 through 100 when provided"],
  ["samplingPercentage", 101, "a number from 0 through 100 when provided"],
  ["samplingPercentage", Number.NaN, "a number from 0 through 100 when provided"],
  ["samplingPercentage", "50", "a number from 0 through 100 when provided"],
  ["azureMonitor", null, "a JSON object when provided"],
  ["azureMonitor", { disableBeacon: "yes" }, undefined],
  ["session", true, "a JSON object when provided"],
  ["session", [], "a JSON object when provided"],
  ["userContext", "enabled", "a JSON object when provided"],
  ["pageView", { routeResolver: () => "/" }, "a JSON object when provided"],
  ["pageView", { redactedQueryParams: [/token/] }, "a JSON object when provided"],
  ["instrumentationOptions", { fetch: { ignoreUrls: [/health/] } }, "a JSON object when provided"],
  [
    "instrumentationOptions",
    { errors: { enabled: true, ratio: Infinity } },
    "a JSON object when provided",
  ],
  ["instrumentationOptions", new Map(), "a JSON object when provided"],
  ["resourceAttributes", "service.name=shop", "a JSON object when provided"],
  ["resourceAttributes", { "service.name": null }, "an object of strings, numbers and booleans"],
  ["resourceAttributes", { tags: ["a"] }, "an object of strings, numbers and booleans"],
  ["resourceAttributes", { nested: { value: 1 } }, "an object of strings, numbers and booleans"],
  ["loadDelay", -1, "a nonnegative number when provided"],
  ["loadDelay", "10", "a nonnegative number when provided"],
  ["loadDelay", Infinity, "a nonnegative number when provided"],
  ["cdnFallback", "yes", "a boolean when provided"],
  ["cdnFallback", true, undefined],
  ["reportLoadFailure", 1, "a boolean when provided"],
  ["crossOrigin", 1, "a string when provided"],
])("rejects invalid %s %#", (name, value, expected) => {
  const message =
    expected !== undefined
      ? `SdkLoaderConfig.${name} must be ${expected}.`
      : name === "cdnFallback"
        ? "SdkLoaderConfig.src must be on an Azure Monitor CDN host for cdnFallback."
        : "SdkLoaderConfig.azureMonitor.disableBeacon must be a boolean when provided.";
  expect(() =>
    getSdkLoaderScript({
      src: "https://example.test/sdk.js",
      connectionString: "connection",
      [name]: value,
    } as SdkLoaderConfig),
  ).toThrow(new TypeError(message));
});

it.each([
  ["session.enabled", { session: { enabled: "false" } }, "a boolean when provided"],
  [
    "session.inactivityTimeout",
    { session: { inactivityTimeout: -1 } },
    "a nonnegative number when provided",
  ],
  ["userContext.enabled", { userContext: { enabled: "false" } }, "a boolean when provided"],
  [
    "pageView.redactedQueryParams",
    { pageView: { redactedQueryParams: "token" } },
    "an array of strings when provided",
  ],
  [
    "pageView.redactedQueryParams",
    { pageView: { redactedQueryParams: [1] } },
    "an array of strings when provided",
  ],
  [
    "pageView.softNavigationSettleTimeoutMs",
    { pageView: { softNavigationSettleTimeoutMs: "5" } },
    "a nonnegative number when provided",
  ],
  [
    "pageView.useNavigationApiIfAvailable",
    { pageView: { useNavigationApiIfAvailable: 1 } },
    "a boolean when provided",
  ],
  [
    "instrumentationOptions.errors",
    { instrumentationOptions: { errors: true } },
    "a JSON object when provided",
  ],
  [
    "instrumentationOptions.errors.enabled",
    { instrumentationOptions: { errors: { enabled: "true" } } },
    "a boolean when provided",
  ],
])("rejects invalid nested field %s %#", (field, options, expected) => {
  expect(() =>
    getSdkLoaderScript({
      src: "https://example.test/sdk.js",
      connectionString: "connection",
      ...options,
    } as SdkLoaderConfig),
  ).toThrow(new TypeError(`SdkLoaderConfig.${field} must be ${expected}.`));
});

it("accepts an empty crossOrigin value", () => {
  expect(
    getSdkLoaderScript({
      src: "https://example.test/sdk.js",
      connectionString: "connection",
      crossOrigin: "",
    }),
  ).toContain('"crossOrigin":""');
});

it("falls back from the canonical CDN URL the browser requests", () => {
  const generated = getSdkLoaderScript({
    src: "https://user:pass@JS.monitor.azure.com\\scripts\\otel\\b\\sdk.js",
    connectionString: "connection",
    cdnFallback: true,
  });
  const src = /"src":"([^"]+)"/.exec(generated)?.[1] ?? "";

  expect(src).toBe("https://user:pass@js.monitor.azure.com/scripts/otel/b/sdk.js");
  expect(src.replace(/\/\/[^/]+/, "//js.cdn.applicationinsights.io")).toBe(
    "https://js.cdn.applicationinsights.io/scripts/otel/b/sdk.js",
  );
});

it("accepts fully qualified CDN host names for cdnFallback", () => {
  expect(
    getSdkLoaderScript({
      src: "https://js.monitor.azure.com./scripts/otel/b/sdk.js",
      connectionString: "connection",
      cdnFallback: true,
    }),
  ).toContain('"fallbackHosts":["js.cdn.applicationinsights.io",');
});

it("rejects unsupported instrumentation names", () => {
  expect(() =>
    getSdkLoaderScript({
      src: "https://example.test/sdk.js",
      connectionString: "connection",
      instrumentationOptions: {
        erros: { enabled: true },
      } as SdkLoaderConfig["instrumentationOptions"],
    }),
  ).toThrow(
    new TypeError(
      "SdkLoaderConfig.instrumentationOptions.erros must be a supported instrumentation.",
    ),
  );
});

it("accepts CDN hosts in any case for cdnFallback", () => {
  expect(
    getSdkLoaderScript({
      src: "https://JS.MONITOR.AZURE.COM/scripts/otel/b/sdk.js",
      connectionString: "connection",
      cdnFallback: true,
    }),
  ).toContain('"fallbackHosts":["js.cdn.applicationinsights.io",');
});

const cyclic: Record<string, unknown> = { enabled: true };
cyclic.self = cyclic;

it.each([
  ["session", cyclic],
  ["instrumentationOptions", { errors: { enabled: true, nested: [cyclic] } }],
  ["pageView", { redactedQueryParams: new Array<string>(1) }],
  ["instrumentationOptions", JSON.parse('{"__proto__":{"errors":{"enabled":true}}}') as object],
  ["resourceAttributes", JSON.parse('{"__proto__":"shop"}') as object],
])("rejects %s values JSON cannot represent as an own property %#", (name, value) => {
  expect(() =>
    getSdkLoaderScript({
      src: "https://example.test/sdk.js",
      connectionString: "connection",
      [name]: value,
    } as SdkLoaderConfig),
  ).toThrow(new TypeError(`SdkLoaderConfig.${name} must be a JSON object when provided.`));
});

it("accepts JSON objects with a null prototype and undefined members", () => {
  const session = Object.assign(Object.create(null) as object, { enabled: true });
  expect(
    getSdkLoaderScript({
      src: "https://example.test/sdk.js",
      connectionString: "connection",
      session,
      pageView: { enabled: undefined },
      instrumentationOptions: { errors: undefined, fetch: { enabled: true } },
    }),
  ).toContain('"session":{"enabled":true},"pageView":{}},"instrumentationOptions":{"fetch"');
});

it("leaves loader extras out of the default loader", () => {
  const generated = getSdkLoaderScript({ connectionString: "connection" });

  expect(generated).not.toMatch(/setTimeout|fallbackHosts|loadFailureReport|fetch\(/);
  expect(generated).toContain("}l(c.src)})})(window,document,");
});

it("delays adding the bundle by loadDelay milliseconds", async () => {
  const src = createBundleUrl("return Promise.resolve({})");
  const { inlineScript, initialization } = executeLoader({
    src,
    connectionString: "InstrumentationKey=test",
    loadDelay: 20,
  });

  try {
    expect(Array.from(document.scripts).some((candidate) => candidate.src === src)).toBe(false);
    await expect(initialization).resolves.toEqual({});
  } finally {
    inlineScript.remove();
    removeLoadedScript(src);
    URL.revokeObjectURL(src);
  }
});

it("rejects when adding the delayed bundle throws", async () => {
  const { inlineScript, initialization } = executeLoader({
    src: "https://example.test/sdk.js",
    connectionString: "InstrumentationKey=test",
    loadDelay: 0,
  });
  const appendChild = document.head.appendChild.bind(document.head);
  const failure = new TypeError("script insertion blocked");
  document.head.appendChild = () => {
    throw failure;
  };
  try {
    await expect(initialization).rejects.toBe(failure);
  } finally {
    document.head.appendChild = appendChild;
    inlineScript.remove();
  }
});

/** Intercepts CDN script elements so fallback runs without network access. */
const interceptCdnScripts = (
  succeedOn: string | undefined,
): { requested: string[]; restore(): void } => {
  const requested: string[] = [];
  const appendChild = document.head.appendChild.bind(document.head);
  document.head.appendChild = <T extends Node>(node: T): T => {
    if (!(node instanceof HTMLScriptElement) || !new URL(node.src).hostname.startsWith("js")) {
      return appendChild(node);
    }
    requested.push(node.src);
    setTimeout(() => {
      if (new URL(node.src).host === succeedOn) {
        loaderWindow.Microsoft = {
          OpenTelemetry: {
            useMicrosoftOpenTelemetry: () => Promise.resolve({ loaded: node.src }),
          },
        } as unknown as LoaderWindow["Microsoft"];
        node.onload?.(new Event("load"));
      } else {
        node.onerror?.(new Event("error"));
      }
    });
    return node;
  };
  return {
    requested,
    restore: () => {
      document.head.appendChild = appendChild;
    },
  };
};

const cdnPath = "/scripts/otel/alpha/opentelemetry-browser.0.0.0-alpha.0.min.js";

it("retries the bundle from backup CDN hosts", async () => {
  const cdn = interceptCdnScripts("js0.cdn.applicationinsights.io");
  try {
    const { inlineScript, initialization } = executeLoader({
      src: `https://js.monitor.azure.com${cdnPath}`,
      connectionString: "InstrumentationKey=test",
      cdnFallback: true,
    });
    await expect(initialization).resolves.toEqual({
      loaded: `https://js0.cdn.applicationinsights.io${cdnPath}`,
    });
    expect(cdn.requested.map((url) => new URL(url).host)).toEqual([
      "js.monitor.azure.com",
      "js.cdn.applicationinsights.io",
      "js.cdn.monitor.azure.com",
      "js0.cdn.applicationinsights.io",
    ]);
    inlineScript.remove();
  } finally {
    cdn.restore();
  }
});

it("rejects when adding a backup CDN bundle throws", async () => {
  const appendChild = document.head.appendChild.bind(document.head);
  const failure = new TypeError("script insertion blocked");
  const requested: string[] = [];
  document.head.appendChild = <T extends Node>(node: T): T => {
    if (!(node instanceof HTMLScriptElement) || !node.src.endsWith(cdnPath)) {
      return appendChild(node);
    }
    requested.push(node.src);
    if (requested.length > 1) throw failure;
    setTimeout(() => node.onerror?.(new Event("error")));
    return node;
  };
  try {
    const { inlineScript, initialization } = executeLoader({
      src: `https://js.monitor.azure.com${cdnPath}`,
      connectionString: "InstrumentationKey=test",
      cdnFallback: true,
    });
    await expect(initialization).rejects.toBe(failure);
    expect(requested.map((url) => new URL(url).host)).toEqual([
      "js.monitor.azure.com",
      "js.cdn.applicationinsights.io",
    ]);
    inlineScript.remove();
  } finally {
    document.head.appendChild = appendChild;
  }
});

it("reports a load failure to the ingestion endpoint after every fallback fails", async () => {
  const cdn = interceptCdnScripts(undefined);
  const sent: { url: string; init: RequestInit }[] = [];
  const originalFetch = window.fetch;
  window.fetch = (input, init) => {
    sent.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  try {
    const { inlineScript, initialization } = executeLoader({
      src: `https://js2.cdn.monitor.azure.com${cdnPath}`,
      connectionString:
        "InstrumentationKey=00000000-0000-0000-0000-000000000000;EndpointSuffix=example.test;Location=westus",
      cdnFallback: true,
      reportLoadFailure: true,
    });
    const lastUrl = `https://js2.cdn.applicationinsights.io${cdnPath}`;
    await expect(initialization).rejects.toThrow(
      `OpenTelemetry browser bundle failed to load: ${lastUrl}`,
    );
    expect(cdn.requested).toHaveLength(7);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://westus.dc.example.test/v2/track");
    expect(sent[0].init).toMatchObject({
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
    });
    const [envelope] = JSON.parse(String(sent[0].init.body)) as Record<string, unknown>[];
    expect(envelope).toMatchObject({
      name: "Microsoft.ApplicationInsights.Exception",
      iKey: "00000000-0000-0000-0000-000000000000",
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      tags: { "ai.internal.sdkVersion": `browser:snippet:mot${OPENTELEMETRY_BROWSER_VERSION}` },
      data: {
        baseType: "ExceptionData",
        baseData: {
          ver: 2,
          exceptions: [
            {
              typeName: "SDKLoadFailed",
              message: `OpenTelemetry browser bundle failed to load: ${lastUrl}`,
              hasFullStack: false,
            },
          ],
        },
      },
    });
    inlineScript.remove();
  } finally {
    window.fetch = originalFetch;
    cdn.restore();
  }
});

it.each([
  `https://user:secret@js.monitor.azure.com${cdnPath}`,
  `https://js.monitor.azure.com${cdnPath}?access_token=secret`,
  `https://js.monitor.azure.com${cdnPath}#secret`,
  `https:\\\\user:secret@js.monitor.azure.com${cdnPath.replaceAll("/", "\\")}`,
])("leaves credentials, query and fragment out of the failure report for %s", async (src) => {
  const cdn = interceptCdnScripts(undefined);
  const bodies: string[] = [];
  const originalFetch = window.fetch;
  window.fetch = (_input, init) => {
    bodies.push(String(init?.body));
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  try {
    const { inlineScript, initialization } = executeLoader({
      src,
      connectionString: "InstrumentationKey=test",
      reportLoadFailure: true,
    });
    await expect(initialization).rejects.toThrow("OpenTelemetry browser bundle failed to load");
    expect(cdn.requested).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("secret");
    expect(bodies[0]).toContain(
      `"message":"OpenTelemetry browser bundle failed to load: https://js.monitor.azure.com${cdnPath}"`,
    );
    inlineScript.remove();
  } finally {
    window.fetch = originalFetch;
    cdn.restore();
  }
});

it.each([
  ["InstrumentationKey=key;IngestionEndpoint=https://ingest.test/", "https://ingest.test/v2/track"],
  ["InstrumentationKey=key", "https://dc.services.visualstudio.com/v2/track"],
  ["InstrumentationKey=key;EndpointSuffix=example.test", "https://dc.example.test/v2/track"],
  [
    "InstrumentationKey=key;IngestionEndpoint=http://collector.test;EndpointSuffix=example.test",
    "https://dc.example.test/v2/track",
  ],
  [
    "InstrumentationKey=key;IngestionEndpoint=http://collector.test",
    "https://dc.services.visualstudio.com/v2/track",
  ],
  [
    "InstrumentationKey=key;IngestionEndpoint=not a url",
    "https://dc.services.visualstudio.com/v2/track",
  ],
  [
    "InstrumentationKey=key;IngestionEndpoint=http://127.0.0.1:4318/",
    "http://127.0.0.1:4318/v2/track",
  ],
  [
    "InstrumentationKey=key;IngestionEndpoint=http://localhost:4318",
    "http://localhost:4318/v2/track",
  ],
])("resolves the failure report endpoint from %s", (connectionString, url) => {
  expect(
    getSdkLoaderScript({
      src: "https://example.test/sdk.js",
      connectionString,
      reportLoadFailure: true,
    }),
  ).toContain(`"loadFailureReport":{"url":"${url}"`);
});
