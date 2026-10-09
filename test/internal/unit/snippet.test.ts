// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, expect, it } from "vitest";
import { getSdkLoaderScript, type SdkLoaderConfig } from "../../../src/snippet.js";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../../src/shared/constants.js";

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
    });
    expect(
      Array.from(document.scripts).find((candidate) => candidate.src === fixtureUrl)?.integrity,
    ).toBe(integrity);
  } finally {
    inlineScript.remove();
    removeLoadedScript(fixtureUrl);
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
