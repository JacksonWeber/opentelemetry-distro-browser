# Milestone M1 - Planning

Deliver the customer-visible browser capabilities needed for useful Application Insights telemetry
in Azure Monitor while keeping the distribution OpenTelemetry-native.

Applications create custom telemetry through standard OpenTelemetry APIs. Application
Insights-style convenience and manual tracking APIs such as `trackEvent`, `trackPageView`,
`trackException`, `trackDependencyData` and `trackMetric` are out of scope.

Status: in progress. M1 preserves the `useMicrosoftOpenTelemetry(options)` initializer and adds
a `userContext` property to the lifecycle handle for identity lifecycle and persistence, plus
options for identity persistence and configurable sessions. The handle remains free of `track*`
and manual telemetry methods.

## Customer capabilities

| Capability | M1 outcome | Status |
| --- | --- | --- |
| Users, identity and consent | The distribution generates standard OpenTelemetry `enduser.pseudo.id` and keeps it in memory by default. `userContext.enabled` and `userContext.setEnabled` opt into or out of identity persistence through the shared browser storage seam; session persistence is configured separately. Applications may supply authenticated identity directly as `user.id` or `enduser.id`, or update the returned `userContext`; sign-out clears in-memory and persisted authenticated identity. The Azure Monitor exporter maps these standard attributes to `ai.user.*` tags. | Done (#54) |
| Sessions | Configurable session lifetimes, a persistence opt-out, and exporter-owned `session.id` to `ai.session.id` mapping. | Implemented |
| Page performance | Add Azure Monitor exporter support for `PageViewPerformanceData`: define its telemetry model and base type, map navigation timing phases to `perfTotal`, `networkConnect`, `sentRequest`, `receivedResponse` and `domProcessing`, correlate each record to its owning page view, and validate the customer-visible Azure Monitor fields. | Done (#58) |
| Fixed-percentage sampling | Add fixed-percentage sampling equivalent in effect to Application Insights `samplingPercentage` without a proprietary tracking API. Compose the upstream sampler for spans; define the corresponding log-record policy and have the Azure Monitor exporter set envelope `sampleRate` to the effective percentage instead of hard-coded `100`. | Done (#57), through the `samplingPercentage` option |
| Server-rooted page trace | Read a server-issued `traceparent` and `tracestate` from the initial document load, through a `<meta>` tag or the `Server-Timing` header, and parent the first page operation on the server request that rendered the page. SPA route changes start their own traces, malformed or missing values fall back to a new trace, and the behavior can be disabled. Application Insights JavaScript does this by default through `traceHdrMode`. | Not started |

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
| Shared browser instrumentation | Patch each browser global once and fan out to instance-owned subscribers, preventing duplicate collection while preserving per-instance configuration and context. | Implemented for pinned upstream fetch, XHR, console and navigation, plus distribution-owned page-view History patches (`39942040`). |
| Lifecycle and cleanup | Transactional startup and rollback, per-instance flush and idempotent shutdown, coordinated distribution shutdown, and leak tests for hooks, observers, listeners, timers and subscriptions. | Done (#77). Shared patch subscribers now detach independently during rollback and shutdown (`39942040`). |
| Coexistence | Diagnose foreign global providers rather than overwriting them, and test duplicate API copies, module federation, iframes, workers and multiple distribution copies. | Done (#61). Compatible copies share realm-local routers and page context, while foreign globals remain untouched and instance instrumentations stay isolated. Re-entrant registration conflicts reject startup without disturbing other instances. |
| Browser support | Declare the npm target and exact supported Chrome, Edge, Firefox and Safari versions, with real-browser acceptance tests. The npm package remains ES2022. | Done. `package.json` and the README declare the ES2022-compatible minimum versions, Playwright covers current engines, and BrowserStack gates the built bundle in each minimum supported browser. |
| Bundle constraints | Work item `39720153` owns size reporting and gating. #46 provides report-only base comparison. Absolute minified, gzip and Brotli budgets are report-only during alpha and become blocking starting with beta (#52); tree-shaking completion and isolation of optional instrumentations and exporters remain under `39720153`. | In progress. The root entry point currently exceeds its budget. |
