# Milestone M2 - Planning

Reach feature parity with the Application Insights Web SDK: CDN and snippet distribution, SDK
stats, and the remaining Application Insights item types. A customer should be able to replace the
Application Insights snippet with this distribution and keep their existing dashboards working.

Status: not started. SDK stats is hard-blocked by the M0 self-telemetry loop guard.

ES5 is a CDN-bundle-only concern owned by this milestone, because upstream dependencies ship
ES2015+; the npm package stays ES2022.

## Work items

| Item | Description | Status |
| --- | --- | --- |
| CDN bundle | ES5 bundle with dependencies transpiled | Not started |
| Artifact set | Versioned URLs, an integrity/SRI manifest, and multi-domain fallback | Not started |
| Script-tag contract | Asynchronous initialization reported through callbacks or promises, and specified snippet queue behaviour | Not started |
| Loader policy | Whether a capability-detecting loader or a pre-ES2015 no-op package ships, each separately packaged and budgeted | Not started |
| CDN size and tests | Size tracked separately from npm, plus CSP, integrity, caching, cross-origin and load-failure tests | Not started |
| SDK stats | Counters for export attempts, successes, failures by response class, retries, throttles and payload sizes, plus round-trip latency | Not started |
| Stats transport | Its own bounded queue and failure handling, never consuming the customer's export budget, never recursively emitting telemetry | Not started |
| Semantic conventions mapping layer | Route every browser event name and attribute key through one table instead of hard-coding at call sites | Not started |
| Part A tags | Decide per tag whether device, location, user, session, operation name and synthetic source are populated, derived at ingestion, or out of scope | Not started |
| `customMetrics` | `trackMetric` envelopes, not an OpenTelemetry metrics signal; not emitted today | Not started |
| Click content model | Reconcile upstream `data-otel-*` capture with Application Insights `data-*`, ancestor walk and content-name extraction | Not started |
| Anonymous identity | `enduser.pseudo.id`, generated and persisted by the distribution | Not started |
| Authenticated identity | `enduser.id`, set by the application and clearable on sign-out | Not started |
| Cookie manager | Shared storage, expiry, domain and path handling with a documented opt-out, shared with session management | Not started |
| Identity mapping | Map both identities onto the Application Insights user tags; opt-in and privacy-reviewed | Not started |
| Sampling | Fixed-percentage sampling equivalent to `samplingPercentage`, and how the decision is represented on the envelope | Not started |
| Offline persistence | Buffering across page loads with bounded storage and an explicit eviction policy, equivalent to the offline channel | Not started |
| Dynamic configuration | An explicit mutable field set with atomic update and rollback, plus a transform/filter contract, equivalent to the config-sync extension | Not started |
| Framework integrations | React, Angular and React Native wrappers, separately packaged | Not started |

## Beyond M2

- An OpenTelemetry metrics signal, if upstream ever decides browsers need one. Page telemetry is
  emitted as logs, so this is not on the parity path.
- Session and page view as resource entities, once upstream resolves the entity model.
- Optional backend exporters in separate packages.
- Legacy Application Insights API bridges, kept out of core.
- A narrow bridge interface for integrations that cannot consume standard OpenTelemetry contracts.
- Dynamic instrumentation load and unload, once patch-arbitration ownership is stable.
- Whether property mangling is revisited, and on what threshold.
