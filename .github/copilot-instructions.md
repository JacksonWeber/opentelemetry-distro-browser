# Copilot review instructions

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
