// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliDecompressSync, constants, gzipSync, brotliCompressSync } from "node:zlib";
import { exportResults } from "../../scripts/perf/export.mjs";
import {
  createPayload,
  measureBundle,
  median,
  mergedRevision,
  metricPrefix,
  sha256,
  writeJobSummary,
} from "../../scripts/perf/results.mjs";

// Synthetic measurements are confined to unit tests and are never sent off loopback.
function fixture() {
  const artifact = measureBundle(Buffer.from("export const syntheticTestFixture = true;\n"));
  const timeUnixNano = "1790640000123000000";
  const results = Object.entries(artifact.sizes).map(([metric, value]) => ({
    metric: metricPrefix + metric,
    samples: [value],
    operationsPerSample: 1,
    warmupCount: 0,
    timeUnixNano,
  }));
  const runtime = { operationsPerSample: 10000, warmupCount: 5, timeUnixNano };
  results.push(
    {
      ...runtime,
      metric: metricPrefix + "sdk.init.duration",
      samples: [1, 3, 2],
      operationsPerSample: 1,
    },
    { ...runtime, metric: metricPrefix + "span.record.duration", samples: [20, 30, 10] },
    {
      ...runtime,
      metric: metricPrefix + "span.record.throughput",
      samples: [20, 30, 10].map((ms) => 10000000 / ms),
    },
  );
  return {
    package: { name: "@microsoft/opentelemetry-browser", version: "0.1.0-test" },
    runId: randomUUID(),
    revision: "a".repeat(40),
    dirty: false,
    artifact,
    provenance: { rollupConfigSha256: "b".repeat(64), terser: "5.0.0-test" },
    environments: {
      node: { name: "Node.js", version: "24.0.0-test" },
      browser: { name: "Chromium", version: "145.0.0-test" },
    },
    os: "linux",
    arch: "amd64",
    workload: { startedSpans: 80001, endedSpans: 80001 },
    results,
  };
}

const attrs = (list) => Object.fromEntries(list.map(({ key, value }) => [key, value]));

test("job summary identifies the exact report run before publishing, including on export failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-perf-summary-"));
  try {
    const run = fixture();
    const path = join(directory, "summary.md");
    await writeFile(path, "Existing summary\n");
    await writeJobSummary(run, path);
    const summary = await readFile(path, "utf8");
    assert.ok(summary.startsWith("Existing summary\n"));
    assert.ok(summary.includes(`**Explicit run:** <code>${run.runId}</code>`));
    assert.ok(summary.includes(`commit/${run.revision}`));
    assert.ok(summary.includes(`<code>${run.package.version}</code>`));
    assert.match(summary, /After publishing, open \*\*MOT for Browser\*\*.*\*\*Explicit run\*\*/);
    assert.match(summary, /Generated measurements only; this command does not upload results/);
    assert.match(summary, /does not confirm downstream ingestion/);
    for (const size of Object.values(run.artifact.sizes)) {
      assert.ok(summary.includes(`| ${size} |`));
    }
    await assert.rejects(exportResults(run, "not-an-endpoint"));
    assert.equal(await readFile(path, "utf8"), summary);
    const runner = await readFile(new URL("../../scripts/perf/run.mjs", import.meta.url), "utf8");
    assert.ok(
      runner.indexOf('writeJson("payload.json"') < runner.indexOf("await writeJobSummary(run)"),
    );
    assert.doesNotMatch(runner, /exportResults|perf:export/);
    const workflow = await readFile(
      new URL("../../.github/workflows/performance.yml", import.meta.url),
      "utf8",
    );
    assert.ok(
      workflow.indexOf("run: npm run perf\n") < workflow.indexOf("run: npm run perf:export"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("job summary escapes freeform metadata and does nothing without a summary path", async () => {
  await writeJobSummary(null, "");
  const directory = await mkdtemp(join(tmpdir(), "browser-perf-summary-"));
  try {
    const run = fixture();
    run.package.version =
      'test</code><script>alert("x")</script>\n| [link](https://example.com) ` &';
    const path = join(directory, "summary.md");
    await writeJobSummary(run, path);
    const summary = await readFile(path, "utf8");
    assert.doesNotMatch(summary, /<script>|<\/code><script>|https:\/\/example.com|alert\("x"\)/);
    assert.match(summary, /&#60;\/code&#62;/);
    assert.match(summary, /&#10;&#124; &#91;link&#93;/);
    assert.match(summary, /&#96; &#38;/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("measures exact file bytes without source maps and deterministic compression", () => {
  const bytes = Buffer.from("const measurement = 'not a source-file byte proxy';\n".repeat(100));
  const measurement = measureBundle(bytes);
  const gzip = gzipSync(bytes, { level: 9 });
  const brotli = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  assert.deepEqual(measurement, measureBundle(bytes));
  assert.equal(measurement.sizes["bundle.minified.size"], bytes.length);
  assert.equal(measurement.sizes["bundle.gzip.size"], gzip.length);
  assert.equal(measurement.sizes["bundle.brotli.size"], brotli.length);
  assert.deepEqual(brotliDecompressSync(brotli), bytes);
  assert.equal(measurement.sha256, sha256(bytes));
  assert.equal(measurement.path, "dist/esm/index.min.js");
  assert.throws(() => measureBundle(Buffer.alloc(0)));
});

test("emits named native OTLP events with exact identity, timestamp, units and typed counts", () => {
  const run = fixture();
  const payload = createPayload(run);
  assert.equal(payload.resourceLogs.length, 2);
  for (const group of payload.resourceLogs) {
    const resource = attrs(group.resource.attributes);
    assert.deepEqual(resource["package.name"], { stringValue: run.package.name });
    assert.deepEqual(resource["package.version"], { stringValue: run.package.version });
    assert.deepEqual(resource["benchmark.run_id"], { stringValue: run.runId });
    assert.deepEqual(resource["vcs.ref.head.revision"], { stringValue: run.revision });
    assert.deepEqual(resource["vcs.dirty"], { boolValue: false });
    assert.equal(resource["telemetry.sdk.version"], undefined);
    for (const event of group.scopeLogs[0].logRecords) {
      assert.equal(event.eventName, "microsoft.opentelemetry.benchmark.result");
      assert.equal(event.timeUnixNano, "1790640000123000000");
      assert.equal(event.body, undefined);
      const fields = attrs(event.attributes);
      assert.deepEqual(fields["test.suite.name"], { stringValue: "mot-browser" });
      assert.deepEqual(fields["benchmark.artifact.sha256"], { stringValue: run.artifact.sha256 });
      assert.deepEqual(fields["benchmark.artifact.format"], { stringValue: "esm" });
      assert.ok(Number.isFinite(fields["benchmark.value"].doubleValue));
      assert.match(fields["benchmark.sample_count"].intValue, /^[1-9]\d*$/);
      assert.match(fields["benchmark.operation_count"].intValue, /^[1-9]\d*$/);
      assert.equal(fields["benchmark.value"].stringValue, undefined);
    }
  }
  const sizes = payload.resourceLogs[0];
  assert.deepEqual(attrs(sizes.resource.attributes)["benchmark.environment"], {
    stringValue: "node-build",
  });
  const sizeFields = attrs(sizes.scopeLogs[0].logRecords[0].attributes);
  assert.deepEqual(sizeFields["benchmark.unit"], { stringValue: "By" });
  assert.deepEqual(sizeFields["benchmark.statistic"], { stringValue: "value" });
  assert.deepEqual(sizeFields["benchmark.compression.method"], { stringValue: "none" });
  assert.equal(sizeFields["benchmark.compression.level"], undefined);
  const runtime = payload.resourceLogs[1];
  assert.deepEqual(attrs(runtime.resource.attributes)["benchmark.environment"], {
    stringValue: "headless-browser",
  });
  const [init, span, throughput] = runtime.scopeLogs[0].logRecords.map((r) => attrs(r.attributes));
  assert.deepEqual(init["test.case.name"], { stringValue: "sdk_init" });
  assert.deepEqual(init["benchmark.value"], { doubleValue: 2 });
  assert.deepEqual(span["test.case.name"], { stringValue: "recording_span" });
  assert.deepEqual(span["benchmark.value"], { doubleValue: 20 });
  assert.deepEqual(span["benchmark.unit"], { stringValue: "ms" });
  assert.deepEqual(span["benchmark.operations_per_sample"], { intValue: "10000" });
  assert.deepEqual(span["benchmark.operation_count"], { intValue: "30000" });
  assert.deepEqual(throughput["benchmark.unit"], { stringValue: "operations/s" });
  assert.deepEqual(throughput["benchmark.value"], { doubleValue: 500000 });
  assert.equal(median([1, 4, 2, 3]), 2.5);
});

test("uses the schema dirty attribute for clean and modified checkouts", () => {
  for (const dirty of [false, true]) {
    const run = { ...fixture(), dirty };
    for (const group of createPayload(run).resourceLogs) {
      const resource = attrs(group.resource.attributes);
      assert.deepEqual(resource["vcs.dirty"], { boolValue: dirty });
      assert.equal(resource["benchmark.source.dirty"], undefined);
    }
  }
});

test("rejects invalid or invented measurements rather than exporting zeros", () => {
  const mutations = [
    (r) => (r.results[0].samples[0] = NaN),
    (r) => (r.results[0].samples[0] = Infinity),
    (r) => (r.results[0].samples[0] = 0),
    (r) => (r.results[0].samples[0] = -1),
    (r) => (r.results[0].samples[0] = "10"),
    (r) => (r.results[0].samples = []),
    (r) => (r.results[0].samples[0] += 1),
    (r) => (r.results[1].metric = r.results[0].metric),
    (r) => (r.results[0].timeUnixNano = 1790640000123000000),
    (r) => (r.results[0].timeUnixNano = "99999999999999999999"),
    (r) => (r.results[3].operationsPerSample = 1.5),
    (r) => (r.results[3].warmupCount = -1),
    (r) => (r.results[5].samples[0] = 1),
    (r) => (r.workload.endedSpans = 0),
    (r) => (r.package.name = "reporting-harness"),
    (r) => (r.package.version = ""),
    (r) => (r.runId = "ci-job-123"),
    (r) => (r.revision = "main"),
    (r) => (r.dirty = undefined),
    (r) => (r.artifact.path = "src/index.ts"),
    (r) => (r.artifact.sha256 = ""),
    (r) => (r.artifact.compression = {}),
    (r) => (r.environments.browser.name = "Node.js"),
  ];
  for (const mutate of mutations) {
    const run = fixture();
    mutate(run);
    assert.throws(() => createPayload(run), undefined, String(mutate));
  }
});

function mergeEvent() {
  return {
    repository: { full_name: "microsoft/opentelemetry-distro-browser" },
    action: "closed",
    pull_request: {
      merged: true,
      merge_commit_sha: "a".repeat(40),
      base: { ref: "main", repo: { full_name: "microsoft/opentelemetry-distro-browser" } },
      head: { repo: { full_name: "contributor/fork" }, sha: "b".repeat(40) },
    },
  };
}

test("only exact upstream merged revisions qualify, including reviewed fork, squash and rebase merges", () => {
  const repository = "microsoft/opentelemetry-distro-browser";
  for (const sha of ["a", "c", "d"]) {
    const event = mergeEvent();
    event.pull_request.merge_commit_sha = sha.repeat(40);
    assert.equal(mergedRevision(event, repository, "pull_request"), sha.repeat(40));
  }
  for (const change of [
    (e) => (e.action = "opened"),
    (e) => (e.pull_request.merged = false),
    (e) => (e.pull_request.merged = "true"),
    (e) => (e.pull_request.base.ref = "feature"),
    (e) => (e.repository.full_name = "contributor/fork"),
    (e) => (e.pull_request.base.repo.full_name = "contributor/fork"),
    (e) => (e.pull_request.merge_commit_sha = ""),
    (e) => (e.pull_request.merge_commit_sha = "main"),
  ]) {
    const event = mergeEvent();
    change(event);
    assert.throws(() => mergedRevision(event, repository, "pull_request"));
  }
  for (const name of ["push", "workflow_dispatch", "pull_request_target"]) {
    assert.throws(() => mergedRevision(mergeEvent(), repository, name));
  }
  assert.throws(() => mergedRevision(mergeEvent(), "contributor/fork", "pull_request"));
});

test("workflow binds exact merged commit and explicit variable, without extra uploads or broad triggers", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/performance.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /types: \[closed\]/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /github\.event\.pull_request\.merged == true/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /vars.SDK_PERF_COLLECTOR_ENDPOINT/);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|workflow_dispatch|upload-artifact|secrets\.|push:/,
  );
  assert.equal([...workflow.matchAll(/uses: .*@[0-9a-f]{40}/g)].length, 2);
});

test("PR validation runs the offline benchmark after Chromium installation and build", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/pr-validation.yml", import.meta.url),
    "utf8",
  );
  const tests = workflow.slice(workflow.indexOf("\n  tests:"));
  const install = tests.indexOf("run: npm run test:install-browsers -- --with-deps");
  const build = tests.indexOf("run: npm run build\n");
  const measure = tests.indexOf("run: npm run perf\n");
  assert.ok(install >= 0 && install < build && build < measure);
  assert.match(tests, /node-version: \["22", "24"\]/);
  assert.doesNotMatch(tests, /perf:export|SDK_PERF_COLLECTOR_ENDPOINT|continue-on-error/);
});

async function withCollector(callback, status = 200, body = "{}") {
  const captured = [];
  const server = createServer(async (request, response) => {
    let data = "";
    for await (const chunk of request) data += chunk;
    captured.push({ method: request.method, path: request.url, data });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}/otlp/v1/logs`, captured);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("explicit export sends the exact validated envelope once to loopback", async () => {
  await withCollector(async (endpoint, captured) => {
    const run = fixture();
    const receipt = await exportResults(run, endpoint);
    assert.equal(receipt.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].path, "/otlp/v1/logs");
    assert.deepEqual(JSON.parse(captured[0].data), createPayload(run));
  });
});

test("partial, malformed, redirect and error responses fail without retries", async () => {
  for (const [status, body] of [
    [200, '{"partialSuccess":{"rejectedLogRecords":"1","errorMessage":"rejected"}}'],
    [200, '{"partialSuccess":{}}'],
    [200, "invalid"],
    [200, "[]"],
    [200, "null"],
    [302, "{}"],
    [500, "{}"],
  ]) {
    await withCollector(
      async (endpoint, captured) => {
        await assert.rejects(exportResults(fixture(), endpoint));
        assert.equal(captured.length, 1);
      },
      status,
      body,
    );
  }
});

test("invalid endpoint or raw data causes no outbound request", async () => {
  for (const endpoint of [
    undefined,
    "",
    "http://collector.example/otlp/v1/logs",
    "https://collector.example/v1/logs",
    "https://user:password@collector.example/otlp/v1/logs",
    "https://collector.example/otlp/v1/logs?key=secret",
  ]) {
    await assert.rejects(exportResults(fixture(), endpoint));
  }
  await withCollector(async (endpoint, captured) => {
    const run = fixture();
    run.results[0].samples[0] = NaN;
    await assert.rejects(exportResults(run, endpoint));
    assert.equal(captured.length, 0);
  });
});

test("CLI preflight failures leave saved runs exportable after correction", async () => {
  await withCollector(async (endpoint, captured) => {
    for (const failure of [
      { endpoint: "not-an-endpoint", error: /Invalid URL/ },
      { endpoint: endpoint.replace("/otlp", ""), error: /Explicit HTTPS/ },
      { endpoint, error: /Payload exceeds 4 MiB/, oversized: true },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "browser-perf-preflight-"));
      try {
        const run = fixture();
        const version = run.package.version;
        if (failure.oversized) run.package.version = "x".repeat(2 * 1024 * 1024);
        const save = async () => {
          await writeFile(join(directory, "raw.json"), JSON.stringify(run));
          await writeFile(join(directory, "payload.json"), JSON.stringify(createPayload(run)));
        };
        const command = fileURLToPath(new URL("../../scripts/perf/export.mjs", import.meta.url));
        const invoke = (url) =>
          promisify(execFile)(
            process.execPath,
            [command, "--input", directory, "--endpoint", url],
            { env: { ...process.env, GITHUB_ACTIONS: "false" } },
          );
        await save();
        const previousRequests = captured.length;
        await assert.rejects(invoke(failure.endpoint), failure.error);
        assert.equal(captured.length, previousRequests);
        assert.deepEqual((await readdir(directory)).sort(), ["payload.json", "raw.json"]);
        run.package.version = version;
        await save();
        await invoke(endpoint);
        assert.equal(captured.length, previousRequests + 1);
        assert.deepEqual(JSON.parse(captured.at(-1).data), createPayload(run));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});

test("CLI retains replay protection after an ambiguous collector response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-perf-replay-"));
  try {
    const run = fixture();
    await writeFile(join(directory, "raw.json"), JSON.stringify(run));
    await writeFile(join(directory, "payload.json"), JSON.stringify(createPayload(run)));
    await withCollector(
      async (endpoint, captured) => {
        const command = fileURLToPath(new URL("../../scripts/perf/export.mjs", import.meta.url));
        const args = [command, "--input", directory, "--endpoint", endpoint];
        const env = { ...process.env, GITHUB_ACTIONS: "false" };
        await assert.rejects(
          promisify(execFile)(process.execPath, args, { env }),
          /Malformed collector response/,
        );
        await assert.rejects(promisify(execFile)(process.execPath, args, { env }), /EEXIST/);
        assert.equal(captured.length, 1);
        const receipt = JSON.parse(await readFile(join(directory, "export-result.json"), "utf8"));
        assert.equal(receipt.responseBody, "invalid");
      },
      200,
      "invalid",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI never exports by default and rejects unmerged CI before touching network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-perf-"));
  try {
    const run = fixture();
    await writeFile(join(directory, "raw.json"), JSON.stringify(run));
    await writeFile(join(directory, "payload.json"), JSON.stringify(createPayload(run)));
    const event = mergeEvent();
    event.pull_request.merged = false;
    const eventFile = join(directory, "event.json");
    await writeFile(eventFile, JSON.stringify(event));
    const cli = new URL("../../scripts/perf/export.mjs", import.meta.url);
    assert.throws(
      () =>
        execFileSync(process.execPath, [fileURLToPath(cli), "--input", directory], {
          stdio: "pipe",
        }),
      /--input and --endpoint are required/,
    );
    await withCollector(async (endpoint, captured) => {
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [fileURLToPath(cli), "--input", directory, "--endpoint", endpoint],
            {
              stdio: "pipe",
              env: {
                ...process.env,
                GITHUB_ACTIONS: "true",
                GITHUB_EVENT_NAME: "pull_request",
                GITHUB_REPOSITORY: "microsoft/opentelemetry-distro-browser",
                GITHUB_EVENT_PATH: eventFile,
              },
            },
          ),
        /actual upstream PR merge/,
      );
      assert.equal(captured.length, 0);
    });

    test("CLI preserves exact request bytes and receipt, and prevents a second submission", async () => {
      const directory = await mkdtemp(join(tmpdir(), "browser-perf-"));
      try {
        const run = fixture();
        await writeFile(join(directory, "raw.json"), JSON.stringify(run));
        await writeFile(join(directory, "payload.json"), JSON.stringify(createPayload(run)));
        await withCollector(async (endpoint, captured) => {
          const command = fileURLToPath(new URL("../../scripts/perf/export.mjs", import.meta.url));
          const args = [command, "--input", directory, "--endpoint", endpoint];
          const env = { ...process.env, GITHUB_ACTIONS: "false" };
          await promisify(execFile)(process.execPath, args, { env });
          assert.equal(captured.length, 1);
          const body = await readFile(join(directory, "request.json"), "utf8");
          const attempt = JSON.parse(
            await readFile(join(directory, "export-attempt.json"), "utf8"),
          );
          const receipt = JSON.parse(await readFile(join(directory, "export-result.json"), "utf8"));
          assert.equal(body, captured[0].data);
          assert.equal(attempt.requestBytes, Buffer.byteLength(body));
          assert.equal(attempt.requestSha256, sha256(body));
          assert.equal(receipt.status, 200);
          assert.equal(receipt.responseBody, "{}");
          await assert.rejects(promisify(execFile)(process.execPath, args, { env }), /EEXIST/);
          assert.equal(captured.length, 1);
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
