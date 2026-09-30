# Milestone M0 - Planning

Ship a thin distribution: configure the upstream `@opentelemetry/browser-sdk`, add a browser-native
Azure Monitor exporter, adopt the upstream browser instrumentations, and publish. M0 is
single-instance and ES2022 ESM-only, and does not build its own SDK.

Status: published as `@microsoft/opentelemetry-browser`. Three engineering items remain.

## Remaining

| Item | Description |
| --- | --- |
| `parsedStack` | Produce parsed exception frames in the exporter; Application Insights groups exceptions on them |
| Self-telemetry loop guard | Exclude the configured ingestion endpoint from `fetch`/`xhr` instrumentation so exports do not instrument themselves |
| Semconv barrel lint | ESLint `no-restricted-imports` banning barrel imports from `@opentelemetry/semantic-conventions`, permitting the individual `ATTR_*`/`METRIC_*` constants |

## In flight

| Pull request | Work |
| --- | --- |
| #29 | Page view and browser telemetry correlation through operation IDs |
| #38 | Browser performance telemetry collection |

## Shipped

| Item | Description |
| --- | --- |
| Initialization surface | One `useMicrosoftOpenTelemetry(options)` call returning a per-call handle |
| Handle lifecycle | `forceFlush()` and idempotent `shutdown()` across both pipelines |
| Page-lifecycle flush | Distribution-owned flush on `pagehide` and `visibilitychange` |
| Resource customization | `resource?: Resource` option (#30) |
| Context and propagation config | `traces.{contextManager, propagators}` (#27) |
| Resource detectors | Browser and user-agent detectors, opt-in (#8) |
| Session management | Opt-in through `session.enabled` (#23) |
| Azure Monitor exporters | Span and log record exporters wired through `azureMonitor.connectionString` (#28) |
| SDK version tag | `ai.internal.sdkVersion` emitted as `mot<version>` (#26) |
| Breeze transport | Retry, backoff and throttle handling (#24) |
| Trusted redirects | Redirect handling (#22) |
| Compression | gzip request compression (#20) |
| Unload delivery | `sendBeacon` fallback (#16), payload limits and tests (#34) |
| Page views | Page view instrumentation, on by default (#17) |
| Instrumentation entry point | `getInstrumentations()` on `./instrumentations`, each module dynamically imported (#21) |
| Size harness | `scripts/measure-bundle-size.mjs` (#37) |
| Changelog check | CI changelog gate (#35) |
| Test coverage | End-to-end page view and custom event (#32), context handling (#33) |
| Release | First alpha published, package renamed (#31, #36) |
| Public-release paperwork | `LICENSE`, `NOTICE.md`, `SECURITY.md`, `SUPPORT.md`, `PRIVACY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md` |

## Deferred

- Remaining upstream instrumentation modules (`navigation-timing`, `resource-timing`, `web-vitals`,
  `user-action`, `console`) stay constructible but opt-in.
- Offline persistence and sampling go to [M2](M2_PLANNING.md).
- Tree-shaking verification and size tuning, gated on the blocking budgets in
  [M1](M1_PLANNING.md).
- Package provenance and signing, and a release runbook covering rollback, deprecation and hotfix.
- Flake policy and CI retry/quarantine behaviour for browser tests.
- End-to-end validation in the partner application against their own Application Insights resource
  and browser matrix, plus a telemetry volume and cost review. Owned outside this repository.

Open question: whether page view performance telemetry is built on the upstream `navigation-timing`
module or emitted from the page view instrumentation (#38 is the in-flight attempt).
