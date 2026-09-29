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

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
  if (!/^[0-9a-f]{64}$/.test(run.artifact.sha256)) throw new Error("Invalid artifact hash");
  if (JSON.stringify(run.artifact.compression) !== JSON.stringify(compression)) {
    throw new Error("Unexpected compression configuration");
  }
  if (run.results?.length !== Object.keys(profiles).length) throw new Error("Incomplete results");
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
    const profile = profiles[shortMetric];
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
      if (
        sampleCount !== 1 ||
        operations !== 1 ||
        warmup !== 0 ||
        !Number.isSafeInteger(value) ||
        value !== run.artifact.sizes[shortMetric]
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
          "benchmark.artifact.path": run.artifact.path,
          "benchmark.artifact.format": run.artifact.format,
          "benchmark.artifact.sha256": run.artifact.sha256,
          "benchmark.build.config.sha256": text(
            run.provenance?.rollupConfigSha256,
            "build config hash",
          ),
          "benchmark.minifier.name": "terser",
          "benchmark.minifier.version": text(run.provenance?.terser, "minifier version"),
          ...(environment === "node"
            ? {
                "benchmark.compression.method": shortMetric.includes(".gzip.")
                  ? "gzip"
                  : shortMetric.includes(".brotli.")
                    ? "brotli"
                    : "none",
                ...(shortMetric.includes(".gzip.")
                  ? { "benchmark.compression.level": compression.gzipLevel }
                  : shortMetric.includes(".brotli.")
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
    eventName !== "pull_request" ||
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
      "In Power BI, open **MOT for Browser**, then select this exact UUID in **Explicit run**.",
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
      "**Generated measurements; see the publish step for collector acceptance.**",
      "Collector acceptance does not confirm downstream ingestion or report refresh.",
      "",
    ].join("\n"),
    "utf8",
  );
}
