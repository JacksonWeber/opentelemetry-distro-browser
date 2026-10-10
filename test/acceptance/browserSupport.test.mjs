// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";
import { Builder } from "selenium-webdriver";
import packageJson from "../../package.json" with { type: "json" };

const browserConfigurations = {
  Chrome: { browserName: "Chrome", os: "Windows", osVersion: "10" },
  Edge: { browserName: "Edge", os: "Windows", osVersion: "10" },
  Firefox: { browserName: "Firefox", os: "Windows", osVersion: "10" },
  Safari: { browserName: "Safari", os: "OS X", osVersion: "Monterey" },
};

const sdkArtifacts = [
  "opentelemetry-browser.umd.js",
  "opentelemetry-browser.umd.min.js",
  "opentelemetry-browser.iife.js",
  "opentelemetry-browser.iife.min.js",
];

const instrumentationArtifacts = [
  "opentelemetry-browser-instrumentations.umd.js",
  "opentelemetry-browser-instrumentations.umd.min.js",
  "opentelemetry-browser-instrumentations.iife.js",
  "opentelemetry-browser-instrumentations.iife.min.js",
];

const npmArtifacts = [
  { name: "ESM root entry", path: "../../dist/esm/index.js", globalName: "NpmSdk" },
  { name: "CommonJS root entry", path: "../../dist/commonjs/index.cjs", globalName: "NpmSdk" },
  {
    name: "ESM instrumentations entry",
    path: "../../dist/esm/instrumentations.js",
    globalName: "NpmInstrumentations",
  },
  {
    name: "CommonJS instrumentations entry",
    path: "../../dist/commonjs/instrumentations.cjs",
    globalName: "NpmInstrumentations",
  },
  { name: "ESM snippet entry", path: "../../dist/esm/snippet.js", globalName: "NpmSnippet" },
];

const npmArtifactSources = new Map();
let inMemoryPipelineSource;

function supportMatrix() {
  return packageJson.browserslist.map((entry) => {
    const match = /^(Chrome|Edge|Firefox|Safari) >= ([\d.]+)$/.exec(entry);
    assert.ok(match, `Unsupported browserslist entry: ${entry}`);
    return { family: match[1], version: match[2] };
  });
}

async function bundleNpmArtifact(artifact) {
  const cached = npmArtifactSources.get(artifact.name);
  if (cached) return cached;

  const operation = createNpmArtifactBundle(artifact);
  npmArtifactSources.set(artifact.name, operation);
  return operation;
}

async function createNpmArtifactBundle(artifact) {
  const bundle = await rollup({
    input: fileURLToPath(new URL(artifact.path, import.meta.url)),
    plugins: [nodeResolve({ browser: true }), commonjs()],
    onwarn(warning, defaultHandler) {
      if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
      defaultHandler(warning);
    },
  });
  try {
    const { output } = await bundle.generate({
      format: "iife",
      name: artifact.globalName,
      inlineDynamicImports: true,
    });
    assert.equal(output.length, 1, artifact.name);
    assert.equal(output[0].type, "chunk", artifact.name);
    assert.deepEqual(output[0].imports, [], artifact.name);
    assert.deepEqual(output[0].dynamicImports, [], artifact.name);
    return output[0].code;
  } finally {
    await bundle.close();
  }
}

async function bundleInMemoryPipeline() {
  if (inMemoryPipelineSource) return inMemoryPipelineSource;

  const input = "\0in-memory-pipeline";
  const bundle = await rollup({
    input,
    plugins: [
      {
        name: "in-memory-pipeline",
        resolveId(id) {
          if (id === input) return input;
        },
        load(id) {
          if (id !== input) return;
          return `
            import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
            import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

            export function create() {
              const spanExporter = new InMemorySpanExporter();
              const logExporter = new InMemoryLogRecordExporter();
              return {
                spanExporter,
                logExporter,
                options: {
                  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
                  logRecordProcessors: [new SimpleLogRecordProcessor(logExporter)],
                },
              };
            }
          `;
        },
      },
      nodeResolve({ browser: true }),
      commonjs(),
    ],
  });
  try {
    const { output } = await bundle.generate({ format: "iife", name: "InMemoryPipeline" });
    assert.equal(output.length, 1);
    assert.equal(output[0].type, "chunk");
    inMemoryPipelineSource = output[0].code;
    return inMemoryPipelineSource;
  } finally {
    await bundle.close();
  }
}

const requestedFamily = process.env.BROWSER_FAMILY;
assert.ok(requestedFamily, "BROWSER_FAMILY is required");

test("browserslist declares each supported browser family once", () => {
  assert.deepEqual(
    supportMatrix().map(({ family }) => family),
    Object.keys(browserConfigurations),
  );
});

test("npm package entries bundle for browsers", async () => {
  for (const artifact of npmArtifacts) {
    assert.match(
      await bundleNpmArtifact(artifact),
      new RegExp(`(?:var|this\\.) ${artifact.globalName}`),
    );
  }
});

test("in-memory pipeline bundles for browsers", async () => {
  assert.match(await bundleInMemoryPipeline(), /InMemoryPipeline/);
});

test(`exercises the browser artifacts in the minimum supported ${requestedFamily}`, async (context) => {
  const supportedBrowser = supportMatrix().find(({ family }) => family === requestedFamily);
  assert.ok(supportedBrowser, `Unknown BROWSER_FAMILY: ${requestedFamily}`);

  const userName = process.env.BROWSERSTACK_USERNAME;
  const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
  assert.ok(userName, "BROWSERSTACK_USERNAME is required");
  assert.ok(accessKey, "BROWSERSTACK_ACCESS_KEY is required");

  const configuration = browserConfigurations[supportedBrowser.family];
  const driver = await new Builder()
    .usingServer("https://hub-cloud.browserstack.com/wd/hub")
    .withCapabilities({
      browserName: configuration.browserName,
      browserVersion: supportedBrowser.version,
      "bstack:options": {
        os: configuration.os,
        osVersion: configuration.osVersion,
        userName,
        accessKey,
        projectName: "opentelemetry-distro-browser",
        buildName: process.env.GITHUB_RUN_ID ?? "local",
        sessionName: `${supportedBrowser.family} ${supportedBrowser.version} support`,
      },
    })
    .build();

  let passed = false;
  try {
    const pipelineSource = await bundleInMemoryPipeline();
    for (const artifact of sdkArtifacts) {
      await driver.get("about:blank");
      const source = await readFile(
        new URL(`../../dist/browser/${artifact}`, import.meta.url),
        "utf8",
      );
      await driver.executeScript(
        "const script = document.createElement('script'); script.textContent = arguments[0]; document.head.appendChild(script);",
        source,
      );
      await driver.executeScript(
        "const script = document.createElement('script'); script.textContent = arguments[0]; document.head.appendChild(script);",
        pipelineSource,
      );

      const result = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const bundle = window.Microsoft?.OpenTelemetry;
            if (!bundle) throw new Error("Bundle did not define Microsoft.OpenTelemetry");
            const pipeline = InMemoryPipeline.create();
            const telemetry = await bundle.useMicrosoftOpenTelemetry({
              ...pipeline.options,
              pageView: { enabled: false },
            });
            let result;
            try {
              bundle.trace.getTracer("browser-support").startSpan("browser-support-span").end();
              bundle.logs.getLogger("browser-support").emit({ eventName: "browser-support-log" });
              await telemetry.forceFlush();
              result = {
                version: bundle.OPENTELEMETRY_BROWSER_VERSION,
                spans: pipeline.spanExporter.getFinishedSpans().map((span) => span.name),
                logs: pipeline.logExporter
                  .getFinishedLogRecords()
                  .map((record) => record.eventName),
              };
            } finally {
              await telemetry.shutdown();
            }
            done(result);
          } catch (error) {
            done({ error: error?.stack ?? String(error) });
          }
        })();
      `);
      assert.equal(result.error, undefined, `${artifact}: ${result.error}`);
      assert.equal(result.version, packageJson.version, artifact);
      assert.deepEqual(result.spans, ["browser-support-span"], artifact);
      assert.deepEqual(result.logs, ["browser-support-log"], artifact);
    }

    for (const artifact of npmArtifacts.filter(({ globalName }) => globalName === "NpmSdk")) {
      await driver.get("about:blank");
      const source = await bundleNpmArtifact(artifact);
      await driver.executeScript(
        "const script = document.createElement('script'); script.textContent = arguments[0]; document.head.appendChild(script);",
        source,
      );
      await driver.executeScript(
        "const script = document.createElement('script'); script.textContent = arguments[0]; document.head.appendChild(script);",
        pipelineSource,
      );

      const result = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const pipeline = InMemoryPipeline.create();
            const telemetry = await NpmSdk.useMicrosoftOpenTelemetry({
              ...pipeline.options,
              pageView: { enabled: false },
            });
            let result;
            try {
              NpmSdk.trace.getTracer("browser-support").startSpan("browser-support-span").end();
              NpmSdk.logs.getLogger("browser-support").emit({ eventName: "browser-support-log" });
              await telemetry.forceFlush();
              result = {
                version: NpmSdk.OPENTELEMETRY_BROWSER_VERSION,
                spans: pipeline.spanExporter.getFinishedSpans().map((span) => span.name),
                logs: pipeline.logExporter
                  .getFinishedLogRecords()
                  .map((record) => record.eventName),
              };
            } finally {
              await telemetry.shutdown();
            }
            done(result);
          } catch (error) {
            done({ error: error?.stack ?? String(error) });
          }
        })();
      `);
      assert.equal(result.error, undefined, `${artifact.name}: ${result.error}`);
      assert.equal(result.version, packageJson.version, artifact.name);
      assert.deepEqual(result.spans, ["browser-support-span"], artifact.name);
      assert.deepEqual(result.logs, ["browser-support-log"], artifact.name);
    }

    for (const artifact of instrumentationArtifacts) {
      await driver.get("about:blank");
      const source = await readFile(
        new URL(`../../dist/browser/${artifact}`, import.meta.url),
        "utf8",
      );
      await driver.executeScript(
        "const script = document.createElement('script'); script.textContent = arguments[0]; document.head.appendChild(script);",
        source,
      );

      const result = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const bundle = window.Microsoft?.OpenTelemetryInstrumentations;
            if (!bundle) {
              throw new Error("Bundle did not define Microsoft.OpenTelemetryInstrumentations");
            }
            const instrumentations = await bundle.getInstrumentations();
            done({ count: instrumentations.length });
          } catch (error) {
            done({ error: error?.stack ?? String(error) });
          }
        })();
      `);
      assert.equal(result.error, undefined, `${artifact}: ${result.error}`);
      assert.equal(result.count, 2, artifact);
    }

    for (const artifact of npmArtifacts.filter(
      ({ globalName }) => globalName === "NpmInstrumentations",
    )) {
      await driver.get("about:blank");
      const source = await bundleNpmArtifact(artifact);
      await driver.executeScript(
        "const script = document.createElement('script'); script.textContent = arguments[0]; document.head.appendChild(script);",
        source,
      );

      const result = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            const instrumentations = await NpmInstrumentations.getInstrumentations();
            done({ count: instrumentations.length });
          } catch (error) {
            done({ error: error?.stack ?? String(error) });
          }
        })();
      `);
      assert.equal(result.error, undefined, `${artifact.name}: ${result.error}`);
      assert.equal(result.count, 2, artifact.name);
    }

    for (const artifact of npmArtifacts.filter(({ globalName }) => globalName === "NpmSnippet")) {
      await driver.get("about:blank");
      const source = await bundleNpmArtifact(artifact);
      await driver.executeScript(
        "const script = document.createElement('script'); script.textContent = arguments[0]; document.head.appendChild(script);",
        source,
      );

      const result = await driver.executeScript(`
        try {
          const script = NpmSnippet.getSdkLoaderScript({
            connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
          });
          return { valid: script.includes("microsoftOpenTelemetry") };
        } catch (error) {
          return { error: error?.stack ?? String(error) };
        }
      `);
      assert.equal(result.error, undefined, `${artifact.name}: ${result.error}`);
      assert.equal(result.valid, true, artifact.name);
    }

    passed = true;
  } finally {
    await driver
      .executeScript(
        `browserstack_executor: {"action":"setSessionStatus","arguments":{"status":"${passed ? "passed" : "failed"}","reason":"Browser support acceptance test"}}`,
      )
      .catch((error) => context.diagnostic(`Could not set BrowserStack status: ${error}`));
    await driver.quit();
  }
});
