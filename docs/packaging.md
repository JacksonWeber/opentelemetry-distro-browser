# Browser package output

The [M0 build requirements](../planning/M0_WORK_BREAKDOWN.md#repository-build-and-tooling)
require ES2022 ESM-only output. `npm run build` cleans previous artifacts and emits:

| Artifact                 | Purpose                                     |
| ------------------------ | ------------------------------------------- |
| `dist/esm/index.js`      | Package entry point, resolved by `exports`  |
| `dist/esm/index.min.js`  | Minified ESM bundle for browser size checks |
| `dist/esm/index.d.ts`    | Public TypeScript declarations              |
| `dist/esm/index*.js.map` | Source maps with embedded source content    |

Import the package through its `exports` map. The manifest intentionally has no `main` or
`module` field and no CommonJS `require` condition. CommonJS consumers must use asynchronous
`import()`; synchronous `require()` of the package is not supported. The `package.json`
metadata subpath remains available.

There is no CommonJS build, `.d.cts` declaration, IIFE bundle, or `OpenTelemetryBrowser` global.
The former `dist/commonjs/` and `dist/browser/` outputs are removed. Browser consumers use an
ESM-aware bundler or native module imports, not a classic script tag expecting a global.
CDN publication and loader policy remain deferred in the implementation plan.

`npm run test:build` checks the output inventory, package resolution, declaration consumption
with TypeScript NodeNext and Bundler resolution, source maps, minification, and tree shaking.
`npm run test:integration` imports both emitted bundles natively in Chromium without a bundler
transforming their contents. The `sideEffects: false` contract remains in place; importing the
package does not initialize telemetry.

`npm run size` reports minified, gzip, and Brotli sizes for `dist/esm/index.min.js`.
`npm run size:report` writes the machine-readable report, and the production build generates
`reports/bundle-stats.html` for dependency analysis.

## Performance measurements

`npm run build && npm run size && npm run perf` measures the actual production
`dist/esm/index.min.js` bytes and runs the built SDK in headless Chromium using the existing
Playwright installation (`npm run test:install-browsers`). Neither this command nor normal
package usage uploads benchmark results. The workload has no network exporters: page views,
sessions, and logs are disabled, and a counting span processor verifies that every span records
and ends. Browser requests other than the harness's intercepted local modules are blocked and
fail the measurement.

PR validation runs `npm run perf` after building the bundles in the Node.js 22 and 24
Chromium jobs. This exercises the full runner, browser measurements, and payload generation
before merge, without publishing telemetry or requiring collector configuration.

This is an **ESM size-check bundle**, also included in the package, not complete application
bytes: `@opentelemetry/api` and `@opentelemetry/api-logs` remain external. The package export
resolves to `dist/esm/index.js`. Unminified entry points, source maps, and declaration files are
not added to the minified byte count.

Results use the following application-defined metric names under the
`microsoft.opentelemetry.benchmark.` prefix and the `mot-browser` suite:

| Metric suffix            | Test case        | Unit         | Measurement                                                  |
| ------------------------ | ---------------- | ------------ | ------------------------------------------------------------ |
| `bundle.minified.size`   | `bundle_esm`     | By           | Exact file bytes                                             |
| `bundle.gzip.size`       | `bundle_esm`     | By           | Node zlib gzip, level 9                                      |
| `bundle.brotli.size`     | `bundle_esm`     | By           | Node Brotli, quality 11                                      |
| `sdk.init.duration`      | `sdk_init`       | ms           | Median awaited initialization call, after module loading     |
| `span.record.duration`   | `recording_span` | ms           | Median time for a batch of 10,000 start/end operations       |
| `span.record.throughput` | `recording_span` | operations/s | Median of each batch's operations divided by elapsed seconds |

Runtime measurements use 15 samples after 5 warmup samples. Initialization excludes SDK module
loading and shutdown; each iteration shuts down and resets global providers outside the timed
region. Span measurements include the counting processor but no exporter, attributes, or
application work. They are not end-to-end ingestion throughput. The page uses cross-origin
isolation for a higher-resolution browser timer. The harness rejects nonpositive/nonfinite
timings rather than replacing them with fabricated values. No memory metrics are measured.
These workload settings and browser/host differences matter when comparing results.

Each run creates `artifacts/performance/<generated-UUID>/` (outside build-cleaned `reports/`) with:

- `raw.json`: measured package/version, source SHA and dirty flag, raw samples, completion
  timestamps, verified span counts, artifact hash, and runtime environments.
- `payload.json`: native OTLP named log events (`microsoft.opentelemetry.benchmark.result`).
- `index.min.js`: the exact measured bundle bytes, preserved for independent verification.
- `bundle.json` and `provenance.json`: byte counts, SHA-256, deterministic compression
  parameters, Node/zlib/Brotli and build-tool versions, Rollup configuration and its hash,
  lockfile hash, preparation commands, and the actual measurement invocation.
- `source.diff` and `source-files.json`: dirty source patch and changed/untracked file contents
  for local reproducibility. Review these local-only files before sharing them.

Resources identify the measured `package.name` and `package.version`, independently of the
harness (`service.name`). `benchmark.run_id` is a newly generated execution UUID;
`vcs.ref.head.revision` and `vcs.dirty` describe the checkout. Size resources
use `benchmark.environment=node-build`; runtime resources use `headless-browser` and the
actual Chromium version. No reporting OpenTelemetry SDK identity is invented for the direct
JSON serializer.

Log attributes include `test.case.name`, `test.suite.name`, `benchmark.metric`,
`benchmark.value` (finite `doubleValue`), `benchmark.unit`, and `benchmark.statistic`
(`value` for sizes, `median` for runtime). `benchmark.sample_count`,
`benchmark.operations_per_sample`, `benchmark.operation_count`, and `benchmark.warmup_count`
are OTLP `intValue` strings. Operation count excludes warmups; span duration is **per batch,
not per operation**. Timestamp strings represent measurement completion, not export time.
Every observation carries `benchmark.artifact.path`, `.format`, and `.sha256`,
`benchmark.build.config.sha256`, and `benchmark.minifier.name`/`.version`.
Size observations include `benchmark.compression.method` (`none`, `gzip`, or `brotli`);
compressed observations include `benchmark.compression.level` (9 or 11).

### Publishing merged-PR measurements

The measurement step writes a GitHub job summary when `GITHUB_STEP_SUMMARY` is available.
Copy its **Explicit run** UUID into the **MOT for Browser** page's **Explicit run** selector
to find the matching measurements. The summary also links the measured commit and shows the
SDK version and bundle sizes. It is written before publishing, so it remains available if the
publish step fails; generated results are not a claim of collector acceptance or report refresh.

The `Merged PR performance` workflow runs only on an actual closed-and-merged PR targeting
`main` in `microsoft/opentelemetry-distro-browser`. It checks out the immutable
`merge_commit_sha`, including the final squash/rebase commit where applicable. Merged fork
contributions are supported; unmerged PRs, fork repositories, direct pushes, and manual
workflow dispatches do not publish. It uses read-only repository permissions and no
`pull_request_target` execution. Offline result creation is allowed in any CI context;
export validates the merge event and rejects dirty or mismatched source revisions.

A repository administrator must configure the Actions variable
`SDK_PERF_COLLECTOR_ENDPOINT` with the approved HTTPS collector URL ending in
`/otlp/v1/logs`. The endpoint is intentionally not hardcoded in source. Missing configuration,
measurement failures, and export failures fail this post-merge job explicitly; they cannot
block a PR that has already merged. The workflow does not add remote artifact uploads.

For an explicitly authorized manual integration test, retain the offline run directory and use:

```sh
npm run perf:export -- --input artifacts/performance/<run-UUID> --endpoint <approved-HTTPS-OTLP-logs-URL>
```

Manual results keep their original timestamp, source revision, and dirty status; they do not
pretend to be merged-PR executions. The exporter checks the saved payload against validated raw
data before sending, requires an explicit endpoint, disables redirects, enforces bounded
request/response sizes and timeout, and never retries. Loopback HTTP is permitted only for
local transport tests. Endpoint and payload-size validation happen before creating
`export-attempt.json`, so preflight errors can be corrected without locking the saved run.
The marker is created exclusively before transmission, so
rerunning export on that directory fails rather than duplicating an ambiguous submission.
`request.json` preserves the exact transmitted bytes, whose hash and length are recorded in
`export-attempt.json`. `export-result.json` preserves the HTTP status and response, including
partial failures. A partial-success response fails explicitly;
HTTP acceptance alone does not prove downstream ingestion. Verify the actual run ID and
values in the collector's destination before claiming end-to-end success.

`npm run test:perf` tests byte measurements, native event typing and identity, invalid-data
rejection, merge gating, and local-only HTTP export behavior. It is part of `npm run check`
and PR validation.
