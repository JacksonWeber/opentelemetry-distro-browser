# Browser package output

The [M0 planning document](../planning/M0_PLANNING.md) started with ES2022 ESM output.
`npm run build` now also emits CommonJS for npm bundlers and self-contained UMD and IIFE artifacts
for the browser:

| Artifact                             | Purpose                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `dist/esm/index.js`                  | ESM package entry point                                                       |
| `dist/commonjs/index.cjs`            | CommonJS package entry point                                                  |
| `dist/esm/instrumentations.js`       | Tree-shakeable ESM instrumentation loader                                     |
| `dist/commonjs/instrumentations.cjs` | CommonJS instrumentation loader                                               |
| `dist/esm/index.min.js`              | Minified ESM bundle for browser size checks                                   |
| `dist/browser/*umd*.js`              | UMD SDK and instrumentation bundles for CommonJS, AMD, RequireJS, and globals |
| `dist/browser/*iife*.js`             | IIFE SDK and instrumentation bundles for direct classic-script loading        |
| `dist/esm/*.d.ts`                    | Public TypeScript declarations for ESM consumers                              |
| `dist/commonjs/*.d.cts`              | Public TypeScript declarations for CommonJS consumers                         |
| `dist/**/*.map`                      | Source maps with embedded source content                                      |
| `dist/esm/snippet.js`                | Configurable SDK loader snippet generator                                     |
| `dist/esm/snippet.d.ts`              | Loader snippet TypeScript declarations                                        |

Import the package through its `exports` map. The `main` and `module` fields support older bundlers
and point to the same files selected by the explicit `require` and `import` conditions. The
`package.json` metadata subpath remains available. The CommonJS entries `require()` ESM-only
OpenTelemetry packages, so they target bundlers and Node.js versions with `require(esm)` support;
CommonJS test runners such as Jest must transform those dependencies.

The `opentelemetry-browser.*` SDK bundles are self-contained and expose `Microsoft.OpenTelemetry`.
They also expose the standard OpenTelemetry APIs used by the bundled SDK, so direct-script
consumers can emit manual telemetry without loading a second API copy. The
`opentelemetry-browser-instrumentations.*` bundles expose `Microsoft.OpenTelemetryInstrumentations`
and include their own API copy, which shares state with the SDK bundle through the OpenTelemetry
global registry. Use IIFE when RequireJS may already be present; UMD deliberately registers with
AMD loaders.

`npm run test:build` checks the output inventory, ESM and CommonJS package resolution, declaration
consumption with TypeScript Node16, NodeNext, and Bundler resolution, source maps, minification,
and tree shaking. `npm run test:integration` imports the ESM bundles and loads every minified and
unminified UMD and IIFE artifact in Chromium, Firefox, and WebKit. It exercises both global and AMD
loading.
The `sideEffects: false` contract remains in place; importing the package does not initialize
telemetry.

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

Every executable published entry point has absolute minified, gzip and Brotli budgets:

| Entry point          | Minified |  Gzip | Brotli |
| -------------------- | -------: | ----: | -----: |
| `.`                  |   115 kB | 34 kB |  30 kB |
| `./instrumentations` |    64 kB | 24 kB |  22 kB |
| `./snippet`          |     2 kB |  1 kB |   1 kB |

The generated JSON and Markdown reports show the measured values, ceilings and result for each
entry point. During alpha releases, violations are report-only so the baselines can stabilize.
Starting with beta, `npm run size` exits unsuccessfully when any absolute budget is exceeded; the
same gate therefore blocks CI for beta, release-candidate and stable versions. The separate PR-base
comparison remains informational and does not replace the absolute gate.

`npm run size` also measures the minified self-contained browser bundles exactly as `npm run build`
emits them, so it must run after a production build. Their budgets block in every release channel,
including alpha:

| Artifact                                                   | Minified |  Gzip | Brotli |
| ---------------------------------------------------------- | -------: | ----: | -----: |
| `opentelemetry-browser.{iife,umd}.min.js`                  |   135 kB | 41 kB |  36 kB |
| `opentelemetry-browser-instrumentations.{iife,umd}.min.js` |    63 kB | 19 kB |  17 kB |

The browser bundles contain only ES2022 syntax. `npm run test:build` parses every emitted UMD and
IIFE file as an ES2022 script and requires a budget for every minified browser bundle. The package
`browserslist` declares Chrome 94, Edge 94, Firefox 93, and Safari 15.4 as the minimum supported
versions. `npm run test:browser-support` loads every SDK and instrumentation UMD and IIFE artifact
and every browser-bundled ESM and CommonJS npm entry in those exact releases through BrowserStack.
It exercises SDK initialization, flushing, and shutdown and default instrumentation selection. Set
`BROWSER_FAMILY` to one declared family and provide `BROWSERSTACK_USERNAME` and
`BROWSERSTACK_ACCESS_KEY`; the PR validation workflow runs one browser family per matrix job.

## CDN and loader snippet

Each release publishes the UMD and IIFE bundles to an immutable versioned CDN location, following
the Application Insights JavaScript SDK release layout:

```text
https://js.monitor.azure.com/scripts/otel/<channel>/<module>.<version>.<format>
```

The channel is `b` for stable releases and the prerelease identifier (`alpha`, `beta` or `rc`)
otherwise. Each module (`opentelemetry-browser` and `opentelemetry-browser-instrumentations`) is
published as `min.js` and `js` (IIFE), and `umd.min.js` and `umd.js` (UMD), each with its source
map, plus `<module>.<version>.integrity.json`. The integrity file lists every file's CDN URL and
its SHA-256, SHA-384 and SHA-512 Subresource Integrity values.

`npm run build` prepares these files in `cdn/` from the same `dist/browser` bundles, renaming only
the source map references. `npm run cdn:publish -- --account <storage-account>` uploads them with
the Azure CLI, using Entra ID login unless `AZURE_STORAGE_SAS_TOKEN` is set, with
`public, max-age=31536000, immutable, no-transform` caching. It uploads the integrity files last,
never overwrites a published file, skips files that are already published with identical content,
and fails if a published file differs. Use `--dry-run` to list the URLs without uploading.

The `./snippet` helper generates the copy/paste loader. Without `src`, it loads the `min.js` IIFE
bundle for the package version, so the snippet and the bundle versions always match. The loader
reads the `Microsoft.OpenTelemetry` global, which a UMD bundle does not set when an AMD loader is
present. Add the generated script to the page `<head>` and replace `CHANNEL`, `VERSION`,
`YOUR_CONNECTION_STRING` and `YOUR_INTEGRITY` in the configuration object at its end:

<!-- prettier-ignore -->
```html
<script>
!(function(w,d,c){var s=d.createElement("script");w.microsoftOpenTelemetry=new Promise(function(resolve,reject){s.src=c.src;s.crossOrigin=c.crossOrigin;if(c.integrity)s.integrity=c.integrity;s.onload=function(){var sdk=w.Microsoft&&w.Microsoft.OpenTelemetry;if(!sdk||typeof sdk.useMicrosoftOpenTelemetry!=="function"){reject(new Error("OpenTelemetry browser bundle did not expose Microsoft.OpenTelemetry"));return}Promise.resolve().then(function(){return sdk.useMicrosoftOpenTelemetry({azureMonitor:{connectionString:c.connectionString}})}).then(resolve,reject)};s.onerror=function(){reject(new Error("OpenTelemetry browser bundle failed to load: "+c.src))};d.head.appendChild(s)})})(window,document,{"src":"https://js.monitor.azure.com/scripts/otel/CHANNEL/opentelemetry-browser.VERSION.min.js","connectionString":"YOUR_CONNECTION_STRING","crossOrigin":"anonymous","integrity":"YOUR_INTEGRITY"});
</script>
```

`YOUR_INTEGRITY` is the `@min.js` `integrity` value from the release's `integrity.json`.
Initialization is asynchronous: `window.microsoftOpenTelemetry` resolves to the lifecycle handle,
or rejects when the bundle fails to load, fails its integrity check or fails to initialize. Under a
Content Security Policy, allow the snippet's hash or nonce and the CDN origin in `script-src`, and
the Azure Monitor ingestion origin in `connect-src`.

`npm run test:integration` loads the prepared CDN bundle cross-origin into a plain HTML page
through the built snippet, under such a policy, in Chromium, Firefox, and WebKit. It verifies that
page-view and span telemetry reaches an Azure Monitor ingestion endpoint, and that integrity
mismatches and missing bundles reject initialization.

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
