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
| M1 and M2 complete | Exact supported browser versions declared and tested, the server-rooted page trace, and the M2 release-notes and dist-tag fixes. | Not started |
| GA scope of M3 | Decide which [M3](M3_PLANNING.md) items block GA and which ship after it. Candidates are the exception collection default, item-level SDK health counters, diagnostics settings and cookie persistence. | Not started |
| Security, privacy and compliance | Threat model and security review; privacy review of collected fields, identifiers and browser storage; naming and export approvals. | Not started |
| CDN file names and version aliases | Decide the CDN file names before `1.0.0`, because renaming them afterwards breaks every page that loads them. Today the IIFE bundle is `<module>.<version>.min.js` and the UMD bundle is `<module>.<version>.umd.min.js`; ApplicationInsights-JS uses the opposite convention, `.gbl.min.js` for the global bundle and `.min.js` for UMD. Also publish major and minor aliases, such as `ai.3.gbl.min.js` and `ai.3.4.gbl.min.js` in ApplicationInsights-JS, and point the snippet at the major alias so customers receive patches without editing their pages. Alias contents change with each release, so a fixed SRI hash cannot be used with them; the snippet resolves an alias through its `integrity.json` to an immutable versioned file and hash (see Automatic snippet integrity in [M3](M3_PLANNING.md)). Only exact versions are published today. | Not started |
| Release | Publish `1.0.0` through the release pipeline to the npm `latest` dist-tag and the stable CDN channel, with SBOM and integrity metadata, and document the versioning, deprecation and servicing policy. | Not started |
| Performance and reliability | Publish performance results from the SDK performance runs, run long-session soak tests for memory, listener and timer leaks, and set the `1.0.0` size budgets. | Not started |
| Production validation | At least one first-party application in production, at scale, with its integration signed off. | Not started |
| Portal experiences | Verify the Application Insights experiences customers use with browser data: Users, Sessions, Funnels, Failures, Performance, end-to-end transactions, transaction search and browser timings. | Not started |
| Documentation and support | Microsoft Learn documentation, configuration reference, troubleshooting guide, support routing and issue triage. | Not started |

## Migration from ApplicationInsights-JS

GA means existing Application Insights JavaScript customers can move to the distribution without
losing data or experiences. Compared against ApplicationInsights-JS 3.4.5. The distribution does not
provide `track*` APIs or a `track*` compatibility package, the same as the other Microsoft
OpenTelemetry distributions; applications move to the OpenTelemetry APIs.

| Item | M4 outcome | Status |
| --- | --- | --- |
| Configuration mapping | Document the distribution option, or the OpenTelemetry way to get the same result, for the ApplicationInsights-JS settings most customers use. This is not a one-to-one mapping of every option: start small and add settings only when customers need them. | Not started |
| API migration guide | Show the OpenTelemetry replacement for each `track*` call, `setAuthenticatedUserContext`, `flush`, `unload`, `addTelemetryInitializer` and `getPlugin`. `trackMetric` has no replacement until metrics export ships, and there is no manual page-view timing API equivalent to `startTrackPage` and `stopTrackPage`. | Not started |
| User and session continuity | Reuse the existing `ai_user` and `ai_session` values on first load so returning visitors keep their user and session IDs and the Users and Sessions counts do not reset at cutover. | Not started |
| Coexistence on one page | Run alongside ApplicationInsights-JS 2.x and 3.x, loaded through the snippet or npm, without duplicate `fetch` and XHR collection, double `traceparent` injection, duplicate page views or broken correlation. | Not started |
| Snippet conversion | Convert an ApplicationInsights-JS snippet configuration to the distribution loader's JSON settings. | Not started |
| Side-by-side data comparison | Send both SDKs from one application to one resource, compare `pageViews`, `dependencies`, `exceptions`, `customEvents` and `browserTimings` field by field, and publish the known differences. | Not started |
| Frameworks and Click Analytics | Migration paths for the React and Angular plugins and Click Analytics, keeping Click Analytics event names and fields. Depends on the M3 packages. | Not started |
| Migration documentation | A migration guide on Microsoft Learn and a support statement for ApplicationInsights-JS. | Not started |
