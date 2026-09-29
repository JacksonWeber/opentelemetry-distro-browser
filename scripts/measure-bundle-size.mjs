// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { rollup, VERSION as rollupVersion } from "rollup";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDirectory = resolve(root, "reports");
const temporaryDirectory = resolve(reportsDirectory, ".size-inputs");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packageName = packageJson.name;

const API_IMPORTS = `
import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
`;
const API_SYMBOLS = ["context", "diag", "propagation", "trace", "logs"];

const SDK_IMPORTS = `
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
`;
const SDK_SYMBOLS = [...API_SYMBOLS, "startBrowserSdk"];

const DISTRIBUTION_IMPORTS = `
import { useMicrosoftOpenTelemetry } from "${packageName}";
`;
const DISTRIBUTION_SYMBOLS = [...SDK_SYMBOLS, "useMicrosoftOpenTelemetry"];

const EXPORTER_IMPORTS = `
import { AzureMonitorLogRecordExporter, AzureMonitorSpanExporter } from "${packageName}";
`;
const EXPORTER_SYMBOLS = [
  ...SDK_SYMBOLS,
  "AzureMonitorLogRecordExporter",
  "AzureMonitorSpanExporter",
];

const INSTRUMENTATIONS = [
  ["fetch", "fetch", "FetchInstrumentation"],
  ["xhr", "xhr", "XhrInstrumentation"],
  ["console", "console", "ConsoleInstrumentation"],
  ["errors", "errors", "ErrorsInstrumentation"],
  ["navigation", "navigation", "NavigationInstrumentation"],
  ["navigation-timing", "navigation-timing", "NavigationTimingInstrumentation"],
  ["resource-timing", "resource-timing", "ResourceTimingInstrumentation"],
  ["user-action", "user-action", "UserActionInstrumentation"],
  ["web-vitals", "web-vitals", "WebVitalsInstrumentation"],
];

const sink = (...symbols) => `globalThis.__bundleSizeSink = [${symbols.join(", ")}];\n`;
const baseCode = (imports, symbols) => API_IMPORTS + imports + sink(...symbols);

const apiScenario = {
  id: "api",
  label: "OpenTelemetry API only (traces and logs)",
  group: "layer",
  entryPoint: "@opentelemetry/api + @opentelemetry/api-logs",
  code: API_IMPORTS + sink(...API_SYMBOLS),
};

const sdkScenario = {
  id: "sdk",
  label: "+ browser SDK",
  group: "layer",
  entryPoint: "@opentelemetry/browser-sdk",
  baseline: "api",
  code: baseCode(SDK_IMPORTS, SDK_SYMBOLS),
};

const distributionScenario = {
  id: "distribution",
  label: "+ browser distribution initializer",
  group: "layer",
  entryPoint: ".",
  baseline: "sdk",
  code: baseCode(SDK_IMPORTS + DISTRIBUTION_IMPORTS, DISTRIBUTION_SYMBOLS),
};

const exporterScenario = {
  id: "azure-monitor-exporters",
  label: "+ Azure Monitor span and log exporters",
  group: "exporter",
  entryPoint: ".",
  baseline: "api",
  code: API_IMPORTS + EXPORTER_IMPORTS + sink(...API_SYMBOLS, ...EXPORTER_SYMBOLS.slice(-2)),
};

const instrumentationScenarios = INSTRUMENTATIONS.map(([id, subpath, symbol]) => ({
  id: `instrumentation-${id}`,
  label: `+ ${id} instrumentation`,
  group: "instrumentation",
  entryPoint: `@opentelemetry/browser-instrumentation/experimental/${subpath}`,
  baseline: "distribution",
  code:
    API_IMPORTS +
    SDK_IMPORTS +
    DISTRIBUTION_IMPORTS +
    `import { ${symbol} } from "@opentelemetry/browser-instrumentation/experimental/${subpath}";\n` +
    sink(...DISTRIBUTION_SYMBOLS, symbol),
}));

const publishedRootScenario = {
  id: "published-root",
  label: "Published root entry (complete runtime exports)",
  group: "entry-point",
  entryPoint: ".",
  code: `import * as publishedRoot from "${packageName}";\n${sink("publishedRoot")}`,
};

const publishedInstrumentationsScenario = {
  id: "published-instrumentations",
  label: "Published instrumentations entry (loader and async chunks)",
  group: "entry-point",
  entryPoint: "./instrumentations",
  code: `import * as publishedInstrumentations from "${packageName}/instrumentations";\n${sink("publishedInstrumentations")}`,
};

const everythingScenario = {
  id: "everything",
  label: "Distribution, exporters, loader, and every instrumentation",
  group: "total",
  entryPoint: ". + ./instrumentations",
  code:
    API_IMPORTS +
    SDK_IMPORTS +
    DISTRIBUTION_IMPORTS +
    EXPORTER_IMPORTS +
    `import { getInstrumentations } from "${packageName}/instrumentations";\n` +
    sink(
      ...DISTRIBUTION_SYMBOLS,
      "AzureMonitorLogRecordExporter",
      "AzureMonitorSpanExporter",
      "getInstrumentations",
    ),
};

export const scenarios = [
  apiScenario,
  sdkScenario,
  distributionScenario,
  exporterScenario,
  publishedRootScenario,
  publishedInstrumentationsScenario,
  ...instrumentationScenarios,
  everythingScenario,
];

export const executablePublishedEntryPoints = Object.entries(packageJson.exports)
  .filter(([, target]) => typeof target === "object" && target?.import?.default)
  .map(([entryPoint]) => entryPoint);

function validateScenarios() {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  if (byId.size !== scenarios.length) throw new Error("Bundle-size scenario IDs must be unique.");

  for (const scenario of scenarios) {
    if (scenario.baseline && !byId.has(scenario.baseline)) {
      throw new Error(`Unknown baseline ${scenario.baseline} for scenario ${scenario.id}.`);
    }
  }

  const coveredEntries = new Set(
    scenarios
      .filter((scenario) => scenario.group === "entry-point")
      .map(({ entryPoint }) => entryPoint),
  );
  for (const entryPoint of executablePublishedEntryPoints) {
    if (!coveredEntries.has(entryPoint)) {
      throw new Error(`Published JavaScript entry point ${entryPoint} has no size scenario.`);
    }
  }
}

async function measureScenario(scenario) {
  const input = resolve(temporaryDirectory, `${scenario.id}.mjs`);
  await writeFile(input, scenario.code, "utf8");
  const bundle = await rollup({
    input,
    plugins: [nodeResolve({ browser: true }), commonjs()],
    onwarn(warning, defaultHandler) {
      if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
      defaultHandler(warning);
    },
    treeshake: {
      moduleSideEffects: "no-external",
      propertyReadSideEffects: false,
      tryCatchDeoptimization: false,
    },
  });

  try {
    const { output } = await bundle.generate({
      format: "es",
      entryFileNames: "entry.js",
      chunkFileNames: "chunks/[name].js",
      plugins: [terser()],
    });
    const chunks = output
      .filter((item) => item.type === "chunk")
      .map((chunk) => {
        const rawBytes = Buffer.byteLength(chunk.code);
        return {
          fileName: chunk.fileName,
          type: chunk.isEntry ? "entry" : chunk.isDynamicEntry ? "dynamic" : "shared",
          rawBytes,
          gzipBytes: gzipSync(chunk.code, { level: 9 }).byteLength,
          brotliBytes: brotliCompressSync(chunk.code, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
          }).byteLength,
        };
      })
      .sort((left, right) => left.fileName.localeCompare(right.fileName));

    return {
      id: scenario.id,
      label: scenario.label,
      group: scenario.group,
      entryPoint: scenario.entryPoint,
      ...(scenario.baseline ? { baseline: scenario.baseline } : {}),
      rawBytes: chunks.reduce((total, chunk) => total + chunk.rawBytes, 0),
      gzipBytes: chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0),
      brotliBytes: chunks.reduce((total, chunk) => total + chunk.brotliBytes, 0),
      chunks,
    };
  } finally {
    await bundle.close();
  }
}

const formatKilobytes = (bytes) => `${(bytes / 1024).toFixed(2)} kB`;
const formatDelta = (bytes) => `${bytes >= 0 ? "+" : "-"}${formatKilobytes(Math.abs(bytes))}`;

export function addDeltas(measurements) {
  const byId = new Map(measurements.map((measurement) => [measurement.id, measurement]));
  return measurements.map((measurement) => {
    if (!measurement.baseline) return measurement;
    const baseline = byId.get(measurement.baseline);
    if (!baseline) throw new Error(`Missing measured baseline ${measurement.baseline}.`);
    return {
      ...measurement,
      baselineGzipBytes: baseline.gzipBytes,
      gzipDeltaBytes: measurement.gzipBytes - baseline.gzipBytes,
      baselineBrotliBytes: baseline.brotliBytes,
      brotliDeltaBytes: measurement.brotliBytes - baseline.brotliBytes,
    };
  });
}

function markdownTable(rows, includeBaseline = true) {
  const lines = [
    includeBaseline
      ? "| Scenario | Baseline | Minified | Total gzip | Gzip delta | Total Brotli | Brotli delta | Chunks |"
      : "| Scenario | Minified | Total gzip | Total Brotli | Chunks |",
    includeBaseline ? "|---|---|---:|---:|---:|---:|---:|---:|" : "|---|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push(
      includeBaseline
        ? `| ${row.label} | ${row.baseline ?? "-"} | ${formatKilobytes(row.rawBytes)} | ${formatKilobytes(row.gzipBytes)} | ${row.gzipDeltaBytes === undefined ? "-" : formatDelta(row.gzipDeltaBytes)} | ${formatKilobytes(row.brotliBytes)} | ${row.brotliDeltaBytes === undefined ? "-" : formatDelta(row.brotliDeltaBytes)} | ${row.chunks.length} |`
        : `| ${row.label} | ${formatKilobytes(row.rawBytes)} | ${formatKilobytes(row.gzipBytes)} | ${formatKilobytes(row.brotliBytes)} | ${row.chunks.length} |`,
    );
  }
  return lines;
}

export function createMarkdownReport(report) {
  const byGroup = (group) => report.scenarios.filter((scenario) => scenario.group === group);
  const lines = [
    "# Browser bundle size report",
    "",
    "Generated by `npm run size`. Every total is an independent Rollup browser build of a real",
    "consumer entry point, tree-shaken, minified, and reported as gzip and Brotli transfer size.",
    "",
    "Per-package deltas are marginal costs relative to the named baseline. **Do not sum deltas:**",
    "shared dependencies are counted once in a combined bundle. Use the independently measured",
    "totals, especially the `everything` scenario, when comparing complete configurations.",
    "",
    `Package: \`${report.package.name}@${report.package.version}\``,
    "",
    "## Layers",
    "",
    ...markdownTable(byGroup("layer")),
    "",
    "## Azure Monitor exporter",
    "",
    ...markdownTable(byGroup("exporter")),
    "",
    "## Published entry points",
    "",
    ...markdownTable(byGroup("entry-point"), false),
    "",
    "The metadata-only `./package.json` export is excluded because it is not executable browser",
    "JavaScript.",
    "",
    "## Instrumentations",
    "",
    ...markdownTable(byGroup("instrumentation")),
    "",
    "## Combined total",
    "",
    ...markdownTable(byGroup("total"), false),
    "",
  ];
  return lines.join("\n");
}

export function createReport(measurements) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    package: { name: packageName, version: packageJson.version },
    bundler: { name: "rollup", version: rollupVersion },
    target: "browser ES module",
    compression: "gzip level 9 and Brotli quality 11, measured per emitted JavaScript chunk",
    scenarios: addDeltas(measurements),
  };
}

export async function run() {
  validateScenarios();
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { recursive: true });

  try {
    const measurements = [];
    for (const scenario of scenarios) {
      process.stderr.write(`Measuring ${scenario.id}\n`);
      measurements.push(await measureScenario(scenario));
    }
    const report = createReport(measurements);
    const markdown = createMarkdownReport(report);
    await writeFile(
      resolve(reportsDirectory, "bundle-size.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await writeFile(resolve(reportsDirectory, "bundle-size.md"), markdown, "utf8");
    process.stdout.write(markdown);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
