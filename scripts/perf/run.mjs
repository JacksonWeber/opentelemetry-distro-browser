// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { measureBrowser } from "./browser.mjs";
import {
  artifactPath,
  createBundleScenarioResults,
  createPayload,
  measureBundle,
  metricPrefix,
  sha256,
  writeJobSummary,
} from "./results.mjs";

const { values } = parseArgs({
  options: { output: { type: "string", default: "artifacts/performance" } },
});
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const revision = git("rev-parse", "HEAD");

const runId = randomUUID();
const output = resolve(values.output, runId);
await mkdir(output, { recursive: true });
const writeJson = (name, value) =>
  writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const bundleSizeReportBytes = await readFile("reports/bundle-size.json");
const bundleSizeReport = JSON.parse(bundleSizeReportBytes);
const bundleSizeConfig = await readFile("scripts/measure-bundle-size.mjs", "utf8");
const status = git("status", "--porcelain");
const diff = git("diff", "--binary", "HEAD");
await writeFile(join(output, "source.diff"), `${diff}\n`, { flag: "wx" });
const changedFiles = [
  ...git("diff", "--name-only", "HEAD").split("\n"),
  ...git("ls-files", "--others", "--exclude-standard").split("\n"),
].filter(Boolean);
const sourceFiles = {};
for (const path of changedFiles) {
  try {
    sourceFiles[path] = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sourceFiles[path] = null;
  }
}
await writeJson("source-files.json", sourceFiles);
const provenance = {
  requiredPreparationCommands: ["npm ci", "npm run build", "npm run size"],
  measurementCommand: process.argv,
  sourceStatus: status,
  node: process.version,
  zlib: process.versions.zlib,
  brotli: process.versions.brotli,
  rollup: bundleSizeReport.bundler.version,
  rollupLock: lock.packages["node_modules/rollup"].version,
  terser: lock.packages["node_modules/terser"].version,
  terserPlugin: lock.packages["node_modules/@rollup/plugin-terser"].version,
  playwright: lock.packages["node_modules/playwright"].version,
  rollupConfig: await readFile("rollup.config.mjs", "utf8"),
  rollupConfigSha256: sha256(await readFile("rollup.config.mjs")),
  bundleSizeConfig,
  bundleSizeConfigSha256: sha256(bundleSizeConfig),
  packageLockSha256: sha256(await readFile("package-lock.json")),
  bundleSizeReportSha256: sha256(bundleSizeReportBytes),
  externalImports: ["@opentelemetry/api", "@opentelemetry/api-logs"],
};
await writeJson("provenance.json", provenance);
const bundleBytes = await readFile(artifactPath);
const artifact = measureBundle(bundleBytes);
await writeFile(join(output, "index.min.js"), bundleBytes, { flag: "wx" });
const timeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
const sizeResults = Object.entries(artifact.sizes).map(([metric, value]) => ({
  metric: metricPrefix + metric,
  samples: [value],
  operationsPerSample: 1,
  warmupCount: 0,
  timeUnixNano,
}));
await writeJson("bundle.json", artifact);
const browser = await measureBrowser();
if (browser.packageVersion !== packageJson.version) {
  throw new Error("Built SDK version does not match the measured package");
}
const run = {
  runId,
  revision,
  dirty: status.length !== 0,
  package: { name: packageJson.name, version: packageJson.version },
  os:
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform,
  arch: process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch,
  environments: {
    node: { name: "Node.js", version: process.versions.node },
    browser: browser.environment,
  },
  artifact,
  bundleSizeReport,
  provenance,
  workload: { startedSpans: browser.started, endedSpans: browser.ended },
  results: [
    ...sizeResults,
    ...browser.results.map((result) => ({ ...result, metric: metricPrefix + result.metric })),
    ...createBundleScenarioResults(bundleSizeReport, timeUnixNano),
  ],
};
await writeJson("raw.json", run);
await writeJson("payload.json", createPayload(run));
await writeJobSummary(run);
console.log(`Performance results (not uploaded): ${output}`);
console.log(JSON.stringify({ runId, revision, dirty: run.dirty, sizes: artifact.sizes }));
if (process.env.GITHUB_OUTPUT) {
  // Only generated UUIDs go into the Actions command file, never CLI-supplied paths.
  await writeFile(process.env.GITHUB_OUTPUT, `run-id=${runId}\n`, { flag: "a" });
}
