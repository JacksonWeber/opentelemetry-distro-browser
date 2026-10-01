# Browser package output

The [M0 planning document](../planning/M0_PLANNING.md) requires ES2022 ESM-only output, and
[M1](../planning/M1_PLANNING.md) owns declaring that target explicitly.
`npm run build` cleans previous artifacts and emits:

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

`npm run size` bundles real consumers of every published JavaScript entry point with Rollup,
tree-shakes and minifies each scenario, and reports gzip and Brotli transfer sizes. It measures the
API, SDK, distribution, Azure Monitor exporters, instrumentation loader, each selectable
instrumentation, and the complete combined configuration. Marginal deltas are always shown beside
independently measured totals. Do not add deltas because combined bundles count shared dependencies
once.

Every run regenerates `reports/bundle-size.json` and `reports/bundle-size.md`. The production build
also generates `reports/bundle-stats.html` for dependency analysis. CI renders the Markdown report
in each Node job's check summary and uploads all three files as build artifacts.
`npm run size:report` remains an alias for `npm run size`.

## Performance measurements

`npm run build && npm run size && npm run perf` measures the actual production
`dist/esm/index.min.js` bytes and runs the built SDK in headless Chromium using the existing
Playwright installation (`npm run test:install-browsers`). Neither this command nor normal
package usage uploads benchmark results. The workload has no network exporters: page views,
sessions, and logs are disabled, and a counting span processor verifies that every span records
and ends. Browser requests other than the harness's intercepted local modules are blocked and
fail the measurement.

This is an **ESM size-check bundle**, also included in the package, not complete application
bytes: `@opentelemetry/api` and `@opentelemetry/api-logs` remain external. The package export
resolves to `dist/esm/index.js`. Unminified entry points, source maps, and declaration files are
not added to the minified byte count.

Results use the following application-defined metric names under the
`microsoft.opentelemetry.benchmark.` prefix and the `mot-browser` suite:

| Metric suffix                                        | Test case        | Unit         | Measurement                                                  |
| ---------------------------------------------------- | ---------------- | ------------ | ------------------------------------------------------------ |
| `bundle.minified.size`                               | `bundle_esm`     | By           | Exact file bytes                                             |
| `bundle.gzip.size`                                   | `bundle_esm`     | By           | Node zlib gzip, level 9                                      |
| `bundle.brotli.size`                                 | `bundle_esm`     | By           | Node Brotli, quality 11                                      |
| `bundle.scenario.<id>.<minified\|gzip\|brotli>.size` | `bundle_<id>`    | By           | Independent scenario bytes from `reports/bundle-size.json`   |
| `sdk.init.duration`                                  | `sdk_init`       | ms           | Median awaited initialization call, after module loading     |
| `span.record.duration`                               | `recording_span` | ms           | Median time for a batch of 10,000 start/end operations       |
| `span.record.throughput`                             | `recording_span` | operations/s | Median of each batch's operations divided by elapsed seconds |

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
Scenario observations also carry `benchmark.bundle.scenario.id`, `.label`, and `.group`, plus
`benchmark.bundle.entry_point`. Their artifact is `reports/bundle-size.json` with format
`rollup-esm-scenario`; `benchmark.artifact.sha256` identifies that report and
`benchmark.build.config.sha256` identifies `scripts/measure-bundle-size.mjs`.

### Publishing measurements

For an explicitly authorized manual integration test, retain the offline run directory and use:

```sh
npm run perf:export -- --input artifacts/performance/<run-UUID> --endpoint <approved-HTTPS-OTLP-logs-URL>
```

Manual results keep their original timestamp, source revision, and dirty status.
The exporter checks the saved payload against validated raw data before sending, requires an
explicit endpoint, disables redirects, enforces bounded
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
rejection, and local-only HTTP export behavior. It is part of `npm run check`.
