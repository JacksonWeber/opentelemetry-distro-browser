// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { VERSION as rollupVersion } from "rollup";
import {
  compareBundleSizeReports,
  createBundleSizeComparisonMarkdown,
} from "../../scripts/compare-bundle-size.mjs";
import {
  addDeltas,
  addBudgetResults,
  createMarkdownReport,
  createReport,
  entryPointBudgets,
  enforceBundleSizeBudgets,
  executablePublishedEntryPoints,
  getBudgetPolicy,
  getBudgetViolations,
  scenarios,
} from "../../scripts/measure-bundle-size.mjs";

const instrumentationIds = [
  "console",
  "errors",
  "fetch",
  "navigation",
  "navigation-timing",
  "resource-timing",
  "user-action",
  "web-vitals",
  "xhr",
];

test("covers every published JavaScript entry point and browser instrumentation", () => {
  assert.deepEqual(executablePublishedEntryPoints.sort(), [".", "./instrumentations"]);
  assert.deepEqual(Object.keys(entryPointBudgets).sort(), executablePublishedEntryPoints.sort());
  assert.deepEqual(
    scenarios
      .filter(({ group }) => group === "entry-point")
      .map(({ entryPoint }) => entryPoint)
      .sort(),
    executablePublishedEntryPoints.sort(),
  );
  assert.deepEqual(
    scenarios
      .filter(({ group }) => group === "instrumentation")
      .map(({ id }) => id.replace("instrumentation-", ""))
      .sort(),
    instrumentationIds,
  );
});

test("evaluates absolute minified, gzip, and Brotli budgets per published entry point", () => {
  const measurements = [
    {
      id: "published-root",
      label: "Published root",
      group: "entry-point",
      entryPoint: ".",
      rawBytes: 1_000,
      gzipBytes: 600,
      brotliBytes: 500,
      chunks: [],
    },
    {
      id: "published-instrumentations",
      label: "Published instrumentations",
      group: "entry-point",
      entryPoint: "./instrumentations",
      rawBytes: 2_001,
      gzipBytes: 1_001,
      brotliBytes: 901,
      chunks: [],
    },
  ];
  const budgets = {
    ".": { rawBytes: 1_000, gzipBytes: 600, brotliBytes: 500 },
    "./instrumentations": { rawBytes: 2_000, gzipBytes: 1_000, brotliBytes: 900 },
  };

  const evaluated = addBudgetResults(measurements, budgets);
  assert.equal(evaluated[0].budgetStatus, "pass");
  assert.deepEqual(evaluated[0].exceededMetrics, []);
  assert.equal(evaluated[1].budgetStatus, "exceeded");
  assert.deepEqual(evaluated[1].exceededMetrics, ["rawBytes", "gzipBytes", "brotliBytes"]);
  assert.deepEqual(
    getBudgetViolations({ scenarios: evaluated }).map(({ entryPoint }) => entryPoint),
    ["./instrumentations"],
  );
});

test("reports budgets for alpha and makes them blocking starting with beta", () => {
  assert.deepEqual(getBudgetPolicy("0.1.0-alpha.2"), {
    mode: "report-only",
    blockingFrom: "beta",
  });
  for (const version of ["0.1.0-beta.1", "0.1.0-rc.1", "0.1.0"]) {
    assert.deepEqual(getBudgetPolicy(version), { mode: "blocking", blockingFrom: "beta" });
  }

  const scenarios = [{ entryPoint: ".", budgetStatus: "exceeded" }];
  assert.doesNotThrow(() =>
    enforceBundleSizeBudgets({
      budgetPolicy: { mode: "report-only", blockingFrom: "beta" },
      scenarios,
    }),
  );
  assert.throws(
    () =>
      enforceBundleSizeBudgets({
        budgetPolicy: { mode: "blocking", blockingFrom: "beta" },
        scenarios,
      }),
    /Bundle size budgets exceeded: \./,
  );
});

test("uses measured baselines and a directly measured combined scenario", () => {
  const ids = new Set(scenarios.map(({ id }) => id));
  for (const scenario of scenarios) {
    if (scenario.baseline) assert.ok(ids.has(scenario.baseline));
  }
  assert.equal(scenarios.find(({ id }) => id === "sdk")?.baseline, "api");
  assert.equal(scenarios.find(({ id }) => id === "distribution")?.baseline, "sdk");
  assert.equal(scenarios.find(({ id }) => id === "azure-monitor-exporters")?.baseline, "api");
  const everything = scenarios.find(({ id }) => id === "everything");
  assert.equal(everything?.baseline, undefined);
  assert.match(everything?.code ?? "", /getInstrumentations/);
  assert.doesNotMatch(everything?.code ?? "", /browser-instrumentation\/experimental/);
});

test("reports measured totals alongside baseline-relative deltas", () => {
  const measured = addDeltas([
    {
      id: "api",
      label: "API",
      group: "layer",
      entryPoint: "api",
      rawBytes: 200,
      gzipBytes: 100,
      brotliBytes: 80,
      chunks: [
        {
          fileName: "entry.js",
          type: "entry",
          rawBytes: 200,
          gzipBytes: 100,
          brotliBytes: 80,
        },
      ],
    },
    {
      id: "sdk",
      label: "SDK",
      group: "layer",
      entryPoint: "sdk",
      baseline: "api",
      rawBytes: 500,
      gzipBytes: 250,
      brotliBytes: 200,
      chunks: [
        {
          fileName: "entry.js",
          type: "entry",
          rawBytes: 500,
          gzipBytes: 250,
          brotliBytes: 200,
        },
      ],
    },
    {
      id: "everything",
      label: "Everything",
      group: "total",
      entryPoint: ".",
      rawBytes: 900,
      gzipBytes: 400,
      brotliBytes: 320,
      chunks: [
        {
          fileName: "entry.js",
          type: "entry",
          rawBytes: 900,
          gzipBytes: 400,
          brotliBytes: 320,
        },
      ],
    },
  ]);
  assert.equal(measured[1].baselineGzipBytes, 100);
  assert.equal(measured[1].gzipDeltaBytes, 150);
  assert.equal(measured[1].baselineBrotliBytes, 80);
  assert.equal(measured[1].brotliDeltaBytes, 120);
  assert.equal(measured[2].gzipDeltaBytes, undefined);
  assert.equal(measured[2].brotliDeltaBytes, undefined);

  const markdown = createMarkdownReport({
    package: { name: "test-package", version: "1.0.0" },
    budgetPolicy: { mode: "report-only", blockingFrom: "beta" },
    scenarios: measured,
  });
  assert.match(markdown, /Do not sum deltas/);
  assert.match(
    markdown,
    /SDK \| api \| 0\.49 kB \| 0\.24 kB \| \+0\.15 kB \| 0\.20 kB \| \+0\.12 kB/,
  );
  assert.match(markdown, /Everything \| 0\.88 kB \| 0\.39 kB \| 0\.31 kB/);
});

test("publishes absolute entry-point budgets and their policy in Markdown", () => {
  const scenarios = addBudgetResults(
    [
      {
        id: "published-root",
        label: "Published root",
        group: "entry-point",
        entryPoint: ".",
        rawBytes: 900,
        gzipBytes: 550,
        brotliBytes: 450,
        chunks: [],
      },
    ],
    { ".": { rawBytes: 1_000, gzipBytes: 600, brotliBytes: 500 } },
  );
  const markdown = createMarkdownReport({
    package: { name: "test-package", version: "1.0.0-alpha.1" },
    budgetPolicy: { mode: "report-only", blockingFrom: "beta" },
    scenarios,
  });

  assert.match(markdown, /Budget policy: \*\*report-only\*\*/);
  assert.match(markdown, /Alpha releases report violations/);
  assert.match(markdown, /\| \. \| 0\.88 kB \| 0\.98 kB/);
  assert.match(markdown, /\| Pass \|/);
});

test("publishes generated size diagnostics when budget enforcement fails", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/pr-validation.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /Publish bundle sizes to the check summary\s+if: \$\{\{ !cancelled\(\) && hashFiles\('reports\/bundle-size\.md'\) != '' \}\}/,
  );
  assert.match(
    workflow,
    /Upload bundle-size reports\s+if: \$\{\{ !cancelled\(\) && hashFiles\('reports\/bundle-size\.json'\) != '' \}\}/,
  );
});

test("records the resolved Rollup runtime version", () => {
  const report = createReport([]);
  assert.equal(report.bundler.version, rollupVersion);
  assert.doesNotMatch(report.bundler.version, /^[~^<>=]/);
});

test("compares bundle reports by scenario without enforcing a threshold", () => {
  const scenario = (id, label, rawBytes, gzipBytes, brotliBytes) => ({
    id,
    label,
    rawBytes,
    gzipBytes,
    brotliBytes,
  });
  const base = {
    schemaVersion: 1,
    scenarios: [
      scenario("root", "Root", 2_000, 1_000, 800),
      scenario("removed", "Removed", 4, 3, 2),
    ],
  };
  const current = {
    schemaVersion: 1,
    scenarios: [scenario("root", "Root", 2_200, 1_100, 760), scenario("added", "Added", 5, 4, 3)],
  };

  assert.deepEqual(
    compareBundleSizeReports(base, current).map(({ id, status }) => ({ id, status })),
    [
      { id: "root", status: "compared" },
      { id: "added", status: "added" },
      { id: "removed", status: "removed" },
    ],
  );
  const markdown = createBundleSizeComparisonMarkdown(base, current);
  assert.match(markdown, /Report-only comparison/);
  assert.match(markdown, /Root .* \+0\.10 kB \(\+10\.00%\).* -0\.04 kB \(-5\.00%\)/);
  assert.match(markdown, /Added .* new/);
  assert.match(markdown, /Removed .* removed/);
});
