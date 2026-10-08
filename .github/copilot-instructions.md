# Copilot review instructions

## Repository purpose

- This repository publishes `@microsoft/opentelemetry-browser`, a browser-focused OpenTelemetry
  distribution for traces and logs with Azure Monitor exporters, browser instrumentations,
  resource detection, session and user context, page-view telemetry, and lifecycle controls.
- The distribution supports independent telemetry instances. Each instance owns its providers,
  processors, exporters, instrumentations, resources, identity, session, and lifecycle state. Page
  context, propagation, and page-operation correlation are realm-wide and coordinated across
  instances. Global routing providers select an instance and return tracers and loggers bound to it.
- Public package entry points are `.`, `./instrumentations`, `./snippet`, and `./package.json`. The root
  and instrumentations entry points emit ESM and CommonJS artifacts; `./snippet` is ESM-only. Builds
  also emit self-contained UMD and IIFE browser bundles. Preserve the `sideEffects: false` contract
  and do not initialize telemetry merely by importing the package.
- Use `microsoft/opentelemetry-distro-javascript` as a design reference for public APIs,
  configuration, naming, and lifecycle behavior when compatible with browser constraints. Do not
  pursue parity when it would materially increase browser bundle size or violate browser behavior.

## Architectural invariants

- Trace and log routing must follow the same instance-selection, binding, caching, and shutdown
  rules. Treat unexplained signal-specific behavior as suspicious.
- Keep instance-owned pipelines, configuration, identity, session, and lifecycle state isolated. Page
  context, propagation, and page-operation correlation are realm-wide; preserve their ownership and
  handoff rules across instances.
- Browser APIs such as `fetch`, XHR, History, event listeners, `PerformanceObserver`, and global
  error handlers are realm-wide. Review initialization and cleanup for duplicate patching,
  duplicate telemetry, cross-instance routing, and leaks after shutdown.
- Preserve explicit application-provided OpenTelemetry context and attributes. Managed defaults
  should fill absent values, not silently replace valid application values.
- Export, `forceFlush()`, page-hide, unload, and shutdown paths must be bounded and deterministic.
  Check concurrent calls, partial failures, retries, keepalive/beacon limits, and post-shutdown use.
- Treat endpoint handling, connection strings, instrumentation keys, user/session identifiers,
  telemetry payloads, and URL redaction as security- and privacy-sensitive surfaces.
- Prefer type-only imports and tree-shakeable modules. Keep optional exporters and
  instrumentations out of unrelated entry points and avoid runtime wrappers or dependencies for
  type-only concepts.

## Review process

- Complete the full review before posting any finding. Inspect every changed file and all relevant
  owning implementations, call sites, tests, generated artifacts, package formats, and signal or
  lifecycle counterparts first. Do not stop after finding the first defect.
- Report all independent actionable findings discovered in that pass together. Before finishing,
  make one final sweep across the entire diff for interactions between changed files, missed edge
  cases, and analogous trace/log or initialization/shutdown paths. Do not intentionally defer a
  finding that the initial complete review could establish.
- Review the diff in the context of the owning implementation, call sites, neighboring tests,
  generated artifacts when applicable, and the public API report under `etc/`.
- Trace each claimed defect through a concrete browser or package-consumer path. State the input,
  controlling code, observable result, and why existing validation does not catch it.
- Check tests for the behavior being changed, including negative cases, lifecycle boundaries,
  multi-instance behavior, and all affected signals or package formats. Do not demand duplicate
  tests when an existing parameterized or integration suite already covers the path.
- For public API changes, inspect ESM and CommonJS declarations, package exports, and API Extractor
  output. Flag accidental breaking changes, missing exports, or runtime/type mismatches.
- For build and packaging changes, inspect actual emitted wrappers and package resolution. Account
  for ESM, CommonJS, UMD, IIFE, AMD, minified, and unminified variants without reporting the same
  root cause multiple times.
- For runtime or dependency changes, assess emitted production size with `npm run build` followed
  by `npm run size`. Consider minified, gzip, and Brotli measurements for each affected entry point;
  source-code length and raw dependency size are not substitutes.
- Keep findings actionable and limited to defects introduced or exposed by the reviewed change.
  Put findings first, ordered by severity, with precise file and line references. If no defect is
  found, say so and identify any remaining validation gap.

## Finding format and confidence

- Every review comment must include a final line in the exact format `Confidence: NN%`, where
  `NN` is an integer from 0 through 100 representing confidence that the reported behavior is a
  real defect introduced or exposed by the change.
- Calibrate confidence from concrete evidence: reproducible or test-demonstrated failures should
  score highest; findings established by a complete code path should score high; findings that
  depend on an unresolved assumption should score lower and state that assumption explicitly.
- Only post actionable findings with confidence of at least 80%. Investigate lower-confidence
  concerns before commenting; if they cannot be established, omit them from inline findings and
  mention the unresolved validation gap only in the review summary when it materially affects risk.
- Each finding must contain the severity, affected file and lines, triggering input or state,
  controlling code path, observable impact, and a concise correction. Confidence is not a
  substitute for this evidence.
- Confidence measures certainty that the issue exists, not its severity. A highly certain minor
  defect may have higher confidence than a potentially severe but weakly supported concern.

## Findings and severity

- Inspect the current implementation, generated artifacts, and relevant tests before reporting a
  finding. Do not report a hypothetical failure when the emitted code or an existing test directly
  disproves it.
- Reserve high severity for a demonstrated correctness, security, compatibility, data-loss, or
  release-blocking failure. A high-severity finding must identify the concrete failing path and
  explain why existing validation does not cover it.
- Report one root-cause finding rather than duplicating the same concern for minified, unminified,
  SDK, instrumentation, UMD, or IIFE output variants.
- Do not repeat a finding from an earlier review unless the current revision still contains the
  problem and the review provides new evidence that an attempted fix is insufficient.
- Treat a deliberate implementation choice as actionable only when there is evidence of incorrect
  behavior. Suggestions about maintainability or possible future drift are not high-severity
  defects.

## Browser bundle globals

- The Rollup `output.name` values `Microsoft.OpenTelemetry` and
  `Microsoft.OpenTelemetryInstrumentations` are intentional. The generated wrappers initialize the
  `Microsoft` namespace before assigning either nested global.
- Before flagging these dotted names, build the bundles and inspect the generated UMD and IIFE
  wrappers. Report a finding only if a generated bundle fails to initialize the expected nested
  global or a relevant execution test fails.
- The global and AMD tests in `test/integration/moduleFormats.test.ts` validate minified and
  unminified SDK and instrumentation bundles in Chromium, Firefox, and WebKit. Do not claim that a
  standalone or AMD bundle is untested without accounting for this suite.

## Browser test configuration

- `vitest.config.ts` is intentionally the Chromium-only unit coverage configuration.
  `vitest.unit.config.ts` and `vitest.integration.config.ts` replace its browser instances with the
  shared Chromium, Firefox, and WebKit list for behavioral testing.
- Before reporting a mismatch between workflow labels and browser coverage, follow the selected npm
  script to its exact Vitest configuration and inspect its `include` and `browser.instances`
  values.

## Validation commands

- Use `npm run check` for the complete repository validation pipeline: formatting, linting,
  TypeScript checks, report and performance tests, cross-browser unit tests, Chromium coverage,
  production builds, package tests, cross-browser integration tests, API Extractor, and bundle
  size measurement.
- Use the narrowest relevant command while iterating: `npm run typecheck`, `npm run lint`,
  `npm run test:unit`, `npm run test:integration`, `npm run test:build`, `npm run api:check`, or
  `npm run size`.
- Unit and integration behavior runs in Chromium, Firefox, and WebKit. Coverage is intentionally
  Chromium-only. Do not infer browser coverage from `vitest.config.ts` alone.
- `npm run test:build` validates output inventory, package resolution, declarations, source maps,
  minification, and tree shaking. `npm run test:integration` executes emitted ESM, UMD, and IIFE
  artifacts in browsers, including loading the UMD bundles through AMD/RequireJS.
- Do not claim a check passed unless it was run successfully. Distinguish assertion failures from
  environment failures such as unavailable browsers, occupied ports, or missing platform tools.
