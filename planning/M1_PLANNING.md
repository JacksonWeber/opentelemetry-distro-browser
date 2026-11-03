# Milestone M1 - Planning

Deliver the customer-visible browser capabilities needed for useful Application Insights telemetry
in Azure Monitor while keeping the distribution OpenTelemetry-native.

Applications create custom telemetry through standard OpenTelemetry APIs. Application
Insights-style convenience and manual tracking APIs such as `trackEvent`, `trackPageView`,
`trackException`, `trackDependencyData` and `trackMetric` are out of scope.

Status: in progress. The server-rooted page trace and exact supported browser versions remain. M1
preserves the `useMicrosoftOpenTelemetry(options)` initializer and adds
a `userContext` property to the lifecycle handle for identity lifecycle and persistence, plus
options for identity persistence and configurable sessions. The handle remains free of `track*`
and manual telemetry methods.

## Customer capabilities

| Capability | M1 outcome | Status |
| --- | --- | --- |
| Users, identity and consent | The distribution generates standard OpenTelemetry `enduser.pseudo.id` and persists it through the shared browser storage seam so user metrics remain stable across page loads and SDK instances. Authenticated user and account IDs set through the handle also persist by default; `userContext.enabled: false` or `userContext.setEnabled(false)` keeps them in memory and disables managed identity persistence and anonymous-ID enrichment. Session persistence is configured separately. Applications may supply authenticated identity directly as `user.id` or `enduser.id`, or update the returned `userContext`; sign-out clears in-memory and persisted authenticated identity. The Azure Monitor exporter maps these standard attributes to `ai.user.*` tags. | Done (#54, #99, #124) |
| Sessions | Configurable session lifetimes, a persistence opt-out, and exporter-owned `session.id` to `ai.session.id` mapping. Sessions are on by default with a 30-minute inactivity timeout and a 24-hour maximum lifetime. | Done (#85, #106, #124) |
| Page performance | Add Azure Monitor exporter support for `PageViewPerformanceData`: define its telemetry model and base type, map navigation timing phases to `perfTotal`, `networkConnect`, `sentRequest`, `receivedResponse` and `domProcessing`, correlate each record to its owning page view, and validate the customer-visible Azure Monitor fields. | Done (#58) |
| Fixed-percentage sampling | Add fixed-percentage sampling equivalent in effect to Application Insights `samplingPercentage` without a proprietary tracking API. Compose the upstream sampler for spans; define the corresponding log-record policy and have the Azure Monitor exporter set envelope `sampleRate` to the effective percentage instead of hard-coded `100`. | Done (#57), through the `samplingPercentage` option |
| Server-rooted page trace | Read a server-issued `traceparent` and `tracestate` from the initial document load, through a `<meta>` tag or the `Server-Timing` header, and parent the first page operation on the server request that rendered the page. Malformed or missing values fall back to a new trace, and the behavior can be disabled. Application Insights JavaScript does this by default through `traceHdrMode`; since 3.4 its `routeTraceStrategy` also parents SPA route page views on the server trace by default, with an option to chain page views instead. The distribution must choose and document its SPA route behavior. | Not started |

Distribution-owned browser instrumentation event names and attribute keys pass through one internal
semantic-conventions map. Application-supplied standard OpenTelemetry telemetry passes through
without this remapping, and Azure Monitor envelope mapping remains exporter-owned.

## Required platform work

Customer capabilities must remain correct when the distribution is used more than once on a page.
This platform work supports that requirement without becoming the organizing principle of the
milestone.

| Area | Required outcome | Status |
| --- | --- | --- |
| Multi-instance isolation | One global routing layer binds each acquired tracer and logger to its owning instance. Unknown instances, replacement, shutdown races and single-signal configurations never cross-route telemetry. | Done (#60) |
| Shared browser instrumentation | Patch each browser global once and fan out to instance-owned subscribers, preventing duplicate collection while preserving per-instance configuration and context. | Done (#94) for pinned upstream fetch, XHR, console and navigation, plus distribution-owned page-view History patches. |
| Lifecycle and cleanup | Transactional startup and rollback, per-instance flush and idempotent shutdown, coordinated distribution shutdown, and leak tests for hooks, observers, listeners, timers and subscriptions. | Done (#77). Shared patch subscribers detach independently during rollback and shutdown. |
| Coexistence | Diagnose foreign global providers rather than overwriting them, and test duplicate API copies, module federation, iframes, workers and multiple distribution copies. | Done (#61). Compatible copies share realm-local routers and page context, while foreign globals remain untouched and instance instrumentations stay isolated. Re-entrant registration conflicts reject startup without disturbing other instances. |
| Browser support | Declare the npm target and exact supported Chrome, Edge, Firefox and Safari versions, with real-browser acceptance tests. The npm package remains ES2022. | In progress. The README publishes a latest-stable policy for Chrome, Edge, Firefox, Opera and Safari, and CI runs the unit and bundle suites in Chromium, Firefox and WebKit (#56). Exact supported versions are not yet declared. #93 added a matrix and was reverted (#102) until the browser-support test tooling is chosen; the `0.1.0-beta.1` release notes still describe it. The published `0.1.0-beta.1` bundle uses ES2022 (private class members, `Object.hasOwn`, `Array.prototype.at`, `Error` `cause`), which sets the floor at about Chrome and Edge 93, Firefox 92 and Safari 15.4; the upstream Web Vitals LCP attribution also calls ES2023 `Array.prototype.findLast` (Chrome and Edge 97, Firefox 104). Internet Explorer and ES5 are not supported. |
| Bundle constraints | Absolute minified, gzip and Brotli budgets for every entry point and browser bundle, report-only during alpha and blocking from beta (#52, #84), with report-only base comparison (#46). Optional exporters and instrumentations stay out of unrelated entry points. | Budgets are blocking and pass. #117 removed the default OTLP exporters and the CDN-only resource detectors. Current budgets (minified / gzip / Brotli) are 130.5 / 41.25 / 36.5 KiB for the root entry and 171.5 / 53 / 46.25 KiB for the CDN bundle. #136 minifies the CDN bundles with SWC and trims exporter code: the CDN bundle measured 150.5 kB minified, 48.2 kB gzip and 42.3 kB Brotli, with budgets left unchanged. |
