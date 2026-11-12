# Milestone M4 - Planning

Release `@microsoft/opentelemetry-browser` `1.0.0` as a generally available, supported SDK by
February 2027, and make it the recommended replacement for ApplicationInsights-JS.

GA does not wait for upstream. `@opentelemetry/browser-instrumentation`, `@opentelemetry/browser-sdk`,
the logs SDK and the browser semantic conventions are still `0.x` or development stability. The
distribution owns its own stability contract: its public API, emitted telemetry and Azure Monitor
output stay stable across upstream upgrades, and upstream changes are absorbed inside the package.

Status: not started.

## GA exit criteria

| Area | GA requirement | Status |
| --- | --- | --- |
| Public API independent of upstream experimental types | The `./instrumentations` API re-exports nine option types directly from `@opentelemetry/browser-instrumentation/experimental/*` (console, errors, fetch, navigation, navigation timing, resource timing, user action, web vitals, XHR), so an upstream change to any of them breaks the distribution's API. Replace them with distribution-owned option types that expose only supported options, review the API Extractor reports for every entry point, and freeze them for `1.0.0` under semantic versioning. | Not started |
| Stable telemetry contract | Document and version the event names, attributes and Azure Monitor envelope fields the distribution emits, and add contract tests on exporter output so an upstream upgrade cannot change what lands in Azure Monitor without a deliberate decision. Distribution-owned instrumentation already passes through the internal semantic-conventions map; telemetry from the upstream instrumentations does not. | Not started |
| Upstream dependency strategy | Extend the [dependency policy](../docs/dependency-policy.md) for GA: the contract tests gate every upgrade, a servicing branch receives security fixes, and an approved architecture decision defines when an upstream module is vendored or patched if upstream breaks or stalls before February 2027. | Partial. Exact pins and the upgrade policy exist. |
| M1 and M2 complete | Exact supported browser versions declared and tested, the server-rooted page trace, and the remaining M2 registry dist-tag verification. | Not started |
| GA scope of M3 | Decide which [M3](M3_PLANNING.md) items block GA and which ship after it. Candidates are the exception collection default, item-level SDK health counters, diagnostics settings and cookie persistence. | Not started |
| Security, privacy and compliance | Threat model and security review; privacy review of collected fields, identifiers and browser storage; naming and export approvals. | Not started |
| CDN file names and version aliases | Finalize CDN names and update policy before `1.0.0`. IIFE uses `<module>.<version>.min.js`; UMD uses `<module>.<version>.umd.min.js`. Preserve existing URLs. Decide whether to add minor aliases and make the snippet auto-update with automatic integrity resolution (see [M3](M3_PLANNING.md)). | Partial. Major aliases, 30-minute caching and explicit public promotion are implemented for the next/public destinations. The default snippet still selects an immutable full version on the legacy channel; it does not resolve alias manifests automatically. See [packaging](../docs/packaging.md#major-version-aliases-and-promotion). |
| Release | Publish `1.0.0` through the release pipeline to the npm `latest` dist-tag and the stable CDN channel, with SBOM and integrity metadata, and document the versioning, deprecation and servicing policy. | Not started |
| Performance and reliability | Publish performance results from the SDK performance runs, run long-session soak tests for memory, listener and timer leaks, and set the `1.0.0` size budgets. | Not started |
| Production validation | At least one first-party application in production, at scale, with its integration signed off. | Not started |
| Portal experiences | Verify the Application Insights experiences customers use with browser data: Users, Sessions, Funnels, Failures, Performance, end-to-end transactions, transaction search and browser timings. | Not started |
| Documentation and support | Microsoft Learn documentation, configuration reference, troubleshooting guide, support routing and issue triage. | Not started |

## Migration from ApplicationInsights-JS

GA requires validated migration paths, with exclusions and data differences documented before
cutover. ApplicationInsights-JS 3.4.5 is the planning reference. Applications move to OpenTelemetry
APIs and W3C-compatible backends. `track*` compatibility and built-in legacy correlation are out of
scope. The [migration guide](../APPINSIGHTS_MIGRATION.md) separates exclusions from current gaps.

| Item | M4 outcome | Status |
| --- | --- | --- |
| Configuration mapping | Document the distribution option, or the OpenTelemetry way to get the same result, for the ApplicationInsights-JS settings most customers use. This is not a one-to-one mapping of every option: start small and add settings only when customers need them. | Partial. The guide covers common differences and exclusions. Customer-driven mapping remains. |
| API migration guide | Show OpenTelemetry replacements for supported `track*` use cases, identity, lifecycle and plugin APIs. General metrics export and manual `startTrackPage` / `stopTrackPage` equivalents are unavailable. | Partial. Initial mappings are documented. End-to-end migration validation remains. |
| User and session continuity | Reuse the existing `ai_user` and `ai_session` values on first load so returning visitors keep their user and session IDs and the Users and Sessions counts do not reset at cutover. | Not started |
| Coexistence on one page | Run alongside ApplicationInsights-JS 2.x and 3.x, loaded through the snippet or npm, without duplicate `fetch` and XHR collection, double `traceparent` injection, duplicate page views or broken correlation. | Not started |
| Snippet conversion | Convert an ApplicationInsights-JS snippet configuration to the distribution loader's JSON settings. | Not started |
| Side-by-side data comparison | Send both SDKs from one application to one resource, compare `pageViews`, `dependencies`, `exceptions`, `customEvents` and `browserTimings` field by field, and publish the known differences. | Not started |
| Frameworks and Click Analytics | Migration paths for the React and Angular plugins and Click Analytics, keeping Click Analytics event names and fields. Depends on the M3 packages. | Not started |
| Migration documentation | A migration guide on Microsoft Learn and a support statement for ApplicationInsights-JS. | Not started |
