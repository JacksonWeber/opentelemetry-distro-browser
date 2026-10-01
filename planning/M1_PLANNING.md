# Milestone M1 - Planning

Deliver the customer-visible browser capabilities needed for useful Application Insights telemetry
in Azure Monitor while keeping the distribution OpenTelemetry-native.

Applications create custom telemetry through standard OpenTelemetry APIs. Application
Insights-style convenience and manual tracking APIs such as `trackEvent`, `trackPageView`,
`trackException`, `trackDependencyData` and `trackMetric` are out of scope.

Status: in progress. M1 preserves the `useMicrosoftOpenTelemetry(options)` initializer and
lifecycle-handle shape, but may add options for identity consent and persistence and configurable
sessions. The handle remains lifecycle-only, with no `track*`, manual telemetry, or identity
mutation methods.

## Customer capabilities

| Capability | M1 outcome | Status |
| --- | --- | --- |
| Users, identity and consent | The distribution generates standard OpenTelemetry `enduser.pseudo.id` and persists it only when consent configuration permits. Authenticated identity is application-supplied `enduser.id` directly on standard OpenTelemetry telemetry; the distribution does not persist it, and sign-out means the application stops adding it. The Azure Monitor exporter maps these standard attributes to `ai.user.*` tags. | Not started |
| Sessions | Add configurable inactivity and maximum session lifetimes and consent-aware persistence instead of fixed `localStorage`. The Azure Monitor exporter maps the standard `session.id` attribute to `ai.session.*` tags. | Not started |
| Page performance | Add Azure Monitor exporter support for `PageViewPerformanceData`: define its telemetry model and base type, map navigation timing phases to `perfTotal`, `networkConnect`, `sentRequest`, `receivedResponse` and `domProcessing`, correlate each record to its owning page view, and validate the customer-visible Azure Monitor fields. | Not started |
| Fixed-percentage sampling | Add fixed-percentage sampling equivalent in effect to Application Insights `samplingPercentage` without a proprietary tracking API. Compose the upstream sampler for spans; define the corresponding log-record policy and have the Azure Monitor exporter set envelope `sampleRate` to the effective percentage instead of hard-coded `100`. | Not started |

Distribution-owned browser instrumentation event names and attribute keys pass through one internal
semantic-conventions map. Application-supplied standard OpenTelemetry telemetry passes through
without this remapping, and Azure Monitor envelope mapping remains exporter-owned.

## Required platform work

Customer capabilities must remain correct when the distribution is used more than once on a page.
This platform work supports that requirement without becoming the organizing principle of the
milestone.

| Area | Required outcome | Status |
| --- | --- | --- |
| Multi-instance isolation | One global routing layer binds each acquired tracer and logger to its owning instance. Unknown instances, replacement, shutdown races and single-signal configurations never cross-route telemetry. | Not started |
| Shared browser instrumentation | Patch each browser global once and fan out to instance-owned subscribers, preventing duplicate collection while preserving per-instance configuration and context. | Not started |
| Lifecycle and cleanup | Transactional startup and rollback, per-instance flush and idempotent shutdown, coordinated distribution shutdown, and leak tests for hooks, observers, listeners, timers and subscriptions. | Not started |
| Coexistence | Diagnose foreign global providers rather than overwriting them, and test duplicate API copies, module federation, iframes, workers and multiple distribution copies. | Not started |
| Browser support | Declare the npm target and exact supported Chrome, Edge, Firefox and Safari versions, with real-browser acceptance tests. The npm package remains ES2022. | Not started |
| Bundle constraints | Work item `39720153` owns size reporting and gating. #46 provides report-only base comparison without enforcing thresholds; blocking minified, gzip and Brotli budgets, enforcement, tree-shaking completion, and isolation of optional instrumentations and exporters remain under `39720153`. | In progress |

Open question: whether a server-issued `traceparent` may root the page trace.
