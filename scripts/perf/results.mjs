// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export const artifactPath = "dist/esm/index.min.js";
export const suite = "mot-browser";
export const metricPrefix = "microsoft.opentelemetry.benchmark.";
export const compression = { gzipLevel: 9, brotliQuality: 11 };
const profiles = {
  "bundle.minified.size": ["bundle_esm", "By", "value", "node"],
  "bundle.gzip.size": ["bundle_esm", "By", "value", "node"],
  "bundle.brotli.size": ["bundle_esm", "By", "value", "node"],
  "sdk.init.duration": ["sdk_init", "ms", "median", "browser"],
  "span.record.duration": ["recording_span", "ms", "median", "browser"],
  "span.record.throughput": ["recording_span", "operations/s", "median", "browser"],
};
const scenarioSizes = {
  minified: "rawBytes",
  gzip: "gzipBytes",
  brotli: "brotliBytes",
};

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSha256(value, name) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

export function measureBundle(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0)
    throw new Error("Bundle must be nonempty bytes");
  return {
    path: artifactPath,
    format: "esm",
    sha256: sha256(bytes),
    compression,
    sizes: {
      "bundle.minified.size": bytes.length,
      "bundle.gzip.size": gzipSync(bytes, { level: compression.gzipLevel }).length,
      "bundle.brotli.size": brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: compression.brotliQuality },
      }).length,
    },
  };
}

// Reports written before scenarios recorded their format contain only Rollup ESM scenarios.
const scenarioFormats = new Set([
  "rollup-esm-scenario",
  "browser-umd-bundle",
  "browser-iife-bundle",
]);

function bundleScenarios(report) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.scenarios)) {
    throw new Error("Invalid bundle-size report");
  }
  const ids = new Set();
  for (const scenario of report.scenarios) {
    if (
      !/^[a-z0-9-]+$/.test(scenario?.id) ||
      typeof scenario.label !== "string" ||
      !scenario.label.trim() ||
      typeof scenario.group !== "string" ||
      !scenario.group.trim() ||
      typeof scenario.entryPoint !== "string" ||
      !scenario.entryPoint.trim() ||
      (scenario.format !== undefined && !scenarioFormats.has(scenario.format)) ||
      Object.values(scenarioSizes).some(
        (field) => !Number.isSafeInteger(scenario[field]) || scenario[field] <= 0,
      )
    ) {
      throw new Error("Invalid bundle-size scenario");
    }
    if (ids.has(scenario.id)) throw new Error(`Duplicate bundle-size scenario ${scenario.id}`);
    ids.add(scenario.id);
  }
  return report.scenarios;
}

export function createBundleScenarioResults(report, timeUnixNano) {
  return bundleScenarios(report).flatMap((scenario) =>
    Object.entries(scenarioSizes).map(([size, field]) => ({
      metric: `${metricPrefix}bundle.scenario.${scenario.id}.${size}.size`,
      samples: [scenario[field]],
      operationsPerSample: 1,
      warmupCount: 0,
      timeUnixNano,
    })),
  );
}

export function median(samples) {
  if (!samples.length || samples.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error("Measurements must contain positive finite samples");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return value;
}

function count(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}

function attributes(values) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value:
      typeof value === "number"
        ? { intValue: String(value) }
        : typeof value === "boolean"
          ? { boolValue: value }
          : { stringValue: text(value, key) },
  }));
}

export function createPayload(run) {
  if (run.package?.name !== "@microsoft/opentelemetry-browser")
    throw new Error("Unexpected package");
  text(run.package?.version, "package.version");
  if (!/^[0-9a-f]{40}$/.test(run.revision)) throw new Error("Invalid tested revision");
  if (!/^[0-9a-f-]{36}$/.test(run.runId)) throw new Error("Invalid generated run ID");
  if (typeof run.dirty !== "boolean") throw new Error("Missing dirty status");
  if (run.artifact?.path !== artifactPath || run.artifact.format !== "esm") {
    throw new Error("Unexpected measured artifact");
  }
  validateSha256(run.artifact.sha256, "artifact hash");
  validateSha256(run.provenance?.rollupConfigSha256, "Rollup config hash");
  validateSha256(run.provenance?.bundleSizeReportSha256, "bundle-size report hash");
  validateSha256(run.provenance?.bundleSizeConfigSha256, "bundle-size config hash");
  if (JSON.stringify(run.artifact.compression) !== JSON.stringify(compression)) {
    throw new Error("Unexpected compression configuration");
  }
  const scenarios = bundleScenarios(run.bundleSizeReport);
  if (
    run.bundleSizeReport.package?.name !== run.package.name ||
    run.bundleSizeReport.package?.version !== run.package.version ||
    run.bundleSizeReport.bundler?.name !== "rollup" ||
    run.bundleSizeReport.bundler?.version !== run.provenance?.rollup ||
    run.bundleSizeReport.bundler?.version !== run.provenance?.rollupLock
  ) {
    throw new Error("Bundle-size report does not match the measured build");
  }
  const scenarioByMetric = new Map(
    scenarios.flatMap((scenario) =>
      Object.entries(scenarioSizes).map(([size, field]) => [
        `bundle.scenario.${scenario.id}.${size}.size`,
        { scenario, size, value: scenario[field] },
      ]),
    ),
  );
  if (run.results?.length !== Object.keys(profiles).length + scenarioByMetric.size) {
    throw new Error("Incomplete results");
  }
  const spans = run.results.find(
    (result) => result.metric === metricPrefix + "span.record.duration",
  );
  const throughput = run.results.find(
    (result) => result.metric === metricPrefix + "span.record.throughput",
  );
  if (
    !spans ||
    !throughput ||
    spans.operationsPerSample !== throughput.operationsPerSample ||
    spans.warmupCount !== throughput.warmupCount ||
    spans.timeUnixNano !== throughput.timeUnixNano ||
    spans.samples.length !== throughput.samples.length ||
    spans.samples.some((ms, i) => throughput.samples[i] !== (spans.operationsPerSample * 1000) / ms)
  ) {
    throw new Error("Throughput must derive from the measured span batches");
  }
  const expectedSpans = 1 + (spans.samples.length + spans.warmupCount) * spans.operationsPerSample;
  if (
    !Number.isSafeInteger(expectedSpans) ||
    run.workload?.startedSpans !== expectedSpans ||
    run.workload?.endedSpans !== expectedSpans
  ) {
    throw new Error("Workload did not record every span");
  }
  const seen = new Set();
  const resources = new Map();
  for (const result of run.results) {
    const shortMetric = result.metric.startsWith(metricPrefix)
      ? result.metric.slice(metricPrefix.length)
      : "";
    const scenarioProfile = scenarioByMetric.get(shortMetric);
    const profile =
      profiles[shortMetric] ??
      (scenarioProfile
        ? [`bundle_${scenarioProfile.scenario.id}`, "By", "value", "node"]
        : undefined);
    if (!profile || seen.has(result.metric)) throw new Error("Unknown or duplicate metric");
    seen.add(result.metric);
    const [testCase, unit, statistic, environment] = profile;
    const value = median(result.samples);
    const sampleCount = count(result.samples.length, "sample count");
    const operations = count(result.operationsPerSample, "operations per sample");
    count(sampleCount * operations, "operation count");
    const warmup = count(result.warmupCount, "warmup count", 0);
    if (
      typeof result.timeUnixNano !== "string" ||
      !/^[1-9][0-9]{15,19}$/.test(result.timeUnixNano)
    ) {
      throw new Error("Invalid result timestamp");
    }
    if (BigInt(result.timeUnixNano) > 18446744073709551615n) throw new Error("Timestamp overflow");
    if (environment === "node") {
      const expectedValue = scenarioProfile
        ? scenarioProfile.value
        : run.artifact.sizes[shortMetric];
      if (
        sampleCount !== 1 ||
        operations !== 1 ||
        warmup !== 0 ||
        !Number.isSafeInteger(value) ||
        value !== expectedValue
      ) {
        throw new Error("Size result does not match artifact measurement");
      }
    }
    const env = run.environments?.[environment];
    if (!env) throw new Error(`Missing ${environment} environment`);
    if (env.name !== (environment === "browser" ? "Chromium" : "Node.js")) {
      throw new Error("Incorrect benchmark runtime");
    }
    if (!resources.has(environment)) {
      const resource = {
        resource: {
          attributes: attributes({
            "package.name": run.package.name,
            "package.version": run.package.version,
            "service.name": "mot-browser-performance",
            "benchmark.run_id": run.runId,
            "benchmark.source": "mot-browser",
            "benchmark.profile": "mot-browser-v1",
            "vcs.ref.head.revision": run.revision,
            "vcs.dirty": run.dirty,
            "user_agent.synthetic.type": "test",
            "os.type": text(run.os, "os.type"),
            "host.arch": text(run.arch, "host.arch"),
            "benchmark.environment": environment === "browser" ? "headless-browser" : "node-build",
            "process.runtime.name": text(env.name, "runtime name"),
            "process.runtime.version": text(env.version, "runtime version"),
            ...(environment === "browser"
              ? { "browser.name": "Chromium", "browser.version": env.version }
              : {}),
          }),
        },
        scopeLogs: [{ scope: { name: "mot-browser-performance", version: "1" }, logRecords: [] }],
      };
      resources.set(environment, resource);
    }
    const record = {
      eventName: "microsoft.opentelemetry.benchmark.result",
      timeUnixNano: result.timeUnixNano,
      attributes: [
        ...attributes({
          "test.suite.name": suite,
          "test.case.name": testCase,
          "benchmark.metric": result.metric,
          "benchmark.unit": unit,
          "benchmark.statistic": statistic,
          "benchmark.sample_count": sampleCount,
          "benchmark.operations_per_sample": operations,
          "benchmark.operation_count": sampleCount * operations,
          "benchmark.warmup_count": warmup,
          "benchmark.artifact.path": scenarioProfile
            ? "reports/bundle-size.json"
            : run.artifact.path,
          "benchmark.artifact.format": scenarioProfile
            ? (scenarioProfile.scenario.format ?? "rollup-esm-scenario")
            : run.artifact.format,
          "benchmark.artifact.sha256": scenarioProfile
            ? text(run.provenance?.bundleSizeReportSha256, "bundle-size report hash")
            : run.artifact.sha256,
          "benchmark.build.config.sha256": text(
            scenarioProfile
              ? run.provenance?.bundleSizeConfigSha256
              : run.provenance?.rollupConfigSha256,
            "build config hash",
          ),
          "benchmark.minifier.name": "terser",
          "benchmark.minifier.version": text(run.provenance?.terser, "minifier version"),
          ...(scenarioProfile
            ? {
                "benchmark.bundle.scenario.id": scenarioProfile.scenario.id,
                "benchmark.bundle.scenario.label": scenarioProfile.scenario.label,
                "benchmark.bundle.scenario.group": scenarioProfile.scenario.group,
                "benchmark.bundle.entry_point": scenarioProfile.scenario.entryPoint,
              }
            : {}),
          ...(environment === "node"
            ? {
                "benchmark.compression.method": (scenarioProfile?.size ?? shortMetric).includes(
                  "gzip",
                )
                  ? "gzip"
                  : (scenarioProfile?.size ?? shortMetric).includes("brotli")
                    ? "brotli"
                    : "none",
                ...((scenarioProfile?.size ?? shortMetric).includes("gzip")
                  ? { "benchmark.compression.level": compression.gzipLevel }
                  : (scenarioProfile?.size ?? shortMetric).includes("brotli")
                    ? { "benchmark.compression.level": compression.brotliQuality }
                    : {}),
              }
            : {}),
        }),
        { key: "benchmark.value", value: { doubleValue: value } },
      ],
    };
    resources.get(environment).scopeLogs[0].logRecords.push(record);
  }
  return { resourceLogs: [...resources.values()] };
}

export function mergedRevision(event, repository, eventName) {
  const pr = event?.pull_request;
  if (
    eventName !== "pull_request_target" ||
    repository !== "microsoft/opentelemetry-distro-browser" ||
    event.repository?.full_name !== repository ||
    event.action !== "closed" ||
    pr?.merged !== true ||
    pr.base?.ref !== "main" ||
    pr.base?.repo?.full_name !== repository ||
    !/^[0-9a-f]{40}$/.test(pr.merge_commit_sha)
  ) {
    throw new Error("Performance publishing requires an actual upstream PR merge into main");
  }
  return pr.merge_commit_sha;
}

export async function writeJobSummary(run, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return;
  createPayload(run);
  const code = (value) =>
    `<code>${String(value).replace(/[^a-zA-Z0-9 .@/_-]/gu, (character) => `&#${character.codePointAt(0)};`)}</code>`;
  await appendFile(
    summaryPath,
    [
      "## MOT for Browser performance run",
      "",
      `**Explicit run:** ${code(run.runId)}`,
      "",
      "After publishing, open **MOT for Browser** in Power BI, then select this exact UUID in **Explicit run**.",
      "Use **GitRevision** in the detail view to cross-check the measured commit.",
      "",
      `**Measured commit:** [${run.revision}](https://github.com/microsoft/opentelemetry-distro-browser/commit/${run.revision})`,
      `**SDK:** ${code(run.package.name)} ${code(run.package.version)}`,
      `**Working tree dirty:** ${run.dirty}`,
      "",
      `**Artifact:** ${code(run.artifact.path)} (ESM size-check bundle; external OpenTelemetry APIs are not included)`,
      "",
      "| Measurement | Bytes |",
      "| --- | ---: |",
      `| Minified | ${run.artifact.sizes["bundle.minified.size"]} |`,
      `| Gzip | ${run.artifact.sizes["bundle.gzip.size"]} |`,
      `| Brotli | ${run.artifact.sizes["bundle.brotli.size"]} |`,
      "",
      "**Generated measurements only; this command does not upload results.**",
      "Collector acceptance does not confirm downstream ingestion or report refresh.",
      "",
    ].join("\n"),
    "utf8",
  );
}
