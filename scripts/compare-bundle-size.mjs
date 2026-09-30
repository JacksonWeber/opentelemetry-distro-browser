// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const formatKilobytes = (bytes) => `${(bytes / 1024).toFixed(2)} kB`;
const formatDelta = (bytes) => `${bytes >= 0 ? "+" : "-"}${formatKilobytes(Math.abs(bytes))}`;
const formatPercent = (current, base) => {
  if (base === 0) return current === 0 ? "0.00%" : "n/a";
  const percent = ((current - base) / base) * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
};

function validateReport(report, name) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.scenarios)) {
    throw new Error(`${name} is not a supported bundle-size report`);
  }
  const ids = new Set();
  for (const scenario of report.scenarios) {
    if (
      typeof scenario?.id !== "string" ||
      typeof scenario.label !== "string" ||
      !Number.isFinite(scenario.rawBytes) ||
      !Number.isFinite(scenario.gzipBytes) ||
      !Number.isFinite(scenario.brotliBytes)
    ) {
      throw new Error(`${name} contains an invalid scenario`);
    }
    if (ids.has(scenario.id)) throw new Error(`${name} contains duplicate scenario ${scenario.id}`);
    ids.add(scenario.id);
  }
}

export function compareBundleSizeReports(base, current) {
  validateReport(base, "Base report");
  validateReport(current, "Current report");

  const baseById = new Map(base.scenarios.map((scenario) => [scenario.id, scenario]));
  const currentById = new Map(current.scenarios.map((scenario) => [scenario.id, scenario]));
  const ids = [
    ...current.scenarios.map(({ id }) => id),
    ...base.scenarios.map(({ id }) => id).filter((id) => !currentById.has(id)),
  ];

  return ids.map((id) => {
    const before = baseById.get(id);
    const after = currentById.get(id);
    if (!before) return { id, status: "added", label: after.label, current: after };
    if (!after) return { id, status: "removed", label: before.label, base: before };
    return {
      id,
      status: "compared",
      label: after.label,
      base: before,
      current: after,
      rawDeltaBytes: after.rawBytes - before.rawBytes,
      gzipDeltaBytes: after.gzipBytes - before.gzipBytes,
      brotliDeltaBytes: after.brotliBytes - before.brotliBytes,
    };
  });
}

export function createBundleSizeComparisonMarkdown(base, current) {
  const comparisons = compareBundleSizeReports(base, current);
  const lines = [
    "# Bundle size comparison",
    "",
    "Report-only comparison against the pull request base revision. Positive deltas are growth;",
    "no size threshold is enforced by this report.",
    "",
    "| Scenario | Base gzip | Current gzip | Gzip change | Base Brotli | Current Brotli | Brotli change | Minified change |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];

  for (const comparison of comparisons) {
    if (comparison.status === "added") {
      lines.push(
        `| ${comparison.label} | new | ${formatKilobytes(comparison.current.gzipBytes)} | new | new | ${formatKilobytes(comparison.current.brotliBytes)} | new | new |`,
      );
    } else if (comparison.status === "removed") {
      lines.push(
        `| ${comparison.label} | ${formatKilobytes(comparison.base.gzipBytes)} | removed | removed | ${formatKilobytes(comparison.base.brotliBytes)} | removed | removed | removed |`,
      );
    } else {
      lines.push(
        `| ${comparison.label} | ${formatKilobytes(comparison.base.gzipBytes)} | ${formatKilobytes(comparison.current.gzipBytes)} | ${formatDelta(comparison.gzipDeltaBytes)} (${formatPercent(comparison.current.gzipBytes, comparison.base.gzipBytes)}) | ${formatKilobytes(comparison.base.brotliBytes)} | ${formatKilobytes(comparison.current.brotliBytes)} | ${formatDelta(comparison.brotliDeltaBytes)} (${formatPercent(comparison.current.brotliBytes, comparison.base.brotliBytes)}) | ${formatDelta(comparison.rawDeltaBytes)} (${formatPercent(comparison.current.rawBytes, comparison.base.rawBytes)}) |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const { positionals, values } = parseArgs({
    options: {
      base: { type: "string" },
      current: { type: "string" },
      output: { type: "string" },
    },
    allowPositionals: true,
  });
  const [basePath, currentPath, outputPath] = positionals;
  const baseInput = values.base ?? basePath;
  const currentInput = values.current ?? currentPath;
  const output = values.output ?? outputPath;
  if (!baseInput || !currentInput || !output) {
    throw new Error("base report, current report, and output path are required");
  }
  const [base, current] = await Promise.all([
    readFile(resolve(baseInput), "utf8").then(JSON.parse),
    readFile(resolve(currentInput), "utf8").then(JSON.parse),
  ]);
  const markdown = createBundleSizeComparisonMarkdown(base, current);
  await writeFile(resolve(output), markdown, "utf8");
  process.stdout.write(markdown);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
