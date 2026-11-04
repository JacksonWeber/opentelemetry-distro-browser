# Migrating from ApplicationInsights-JS

`@microsoft/opentelemetry-browser` is an OpenTelemetry-native browser distribution, not a drop-in
replacement for the Application Insights JavaScript SDK. It can send telemetry to the same Azure
Monitor resource, but applications must migrate their APIs and configuration and review differences
in collection, correlation and stored identity.

This guide describes the repository's beta implementation (`0.1.0-beta.2`) and the migration scope
compared with ApplicationInsights-JS 3.4.5. Check the declarations of the exact package version you
deploy. **Intentional exclusions are not planned features.** A separate section
lists current gaps that remain roadmap work, not commitments to ship in a particular release.
Use the [configuration reference](docs/configuration-reference.md) and
[event catalogue](docs/event-catalogue.md) for the available behavior.

## What will not be supported

| ApplicationInsights-JS capability                                      | Decision and migration path                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy `Request-Id` and `Request-Context` correlation headers          | No built-in legacy-header propagation or `distributedTracingMode` / `appId` compatibility options. Use W3C Trace Context and update backends that depend on the legacy headers before cutover.                                                                       |
| `track*` APIs or a compatibility package exposing them                 | Use the OpenTelemetry Trace and Logs APIs. The distribution will not add `trackEvent`, `trackTrace`, `trackException`, `trackDependencyData`, `trackPageView`, `trackPageViewPerformance` or `trackMetric` wrappers, in core or a separate compatibility package.    |
| `addTelemetryInitializer` and the Application Insights plugin pipeline | Use OpenTelemetry processors, resources and instrumentation hooks. Returning `false` from an Application Insights initializer has no drop-in equivalent on a processor. Filter at the source or implement filtering in the exporter branch you own.                  |
| `getPlugin` and direct reuse of Application Insights plugins/channels  | Existing plugin objects do not implement this distribution's contracts. Use the handle's supported instrumentation controls and standard OpenTelemetry processors/exporters. Sending to multiple destinations uses multiple processors rather than `tee-channel-js`. |
| React Native, the 1DS channel and the Application Insights Light SKU   | These are outside this browser distribution's scope. Browser React and Angular integrations are separate planned work, not React Native support.                                                                                                                     |
| Internet Explorer and an ES5-compatible SDK build                      | Target current supported browsers. See the [browser support policy](README.md#browser-support) rather than assuming the ApplicationInsights-JS browser matrix applies.                                                                                               |

### W3C correlation instead of legacy headers

The default propagators send `traceparent`, `tracestate` when present, and W3C Baggage. They do not
generate `Request-Id` or `Request-Context`. This is a deliberate scope decision, not a temporary
missing opt-in. It also means there is no built-in `Request-Context` application-ID exchange.
W3C trace context is not a replacement for every Application Insights app-ID feature.

For a backend that only understands the classic headers, browser and server telemetry may still
arrive independently, but their request chain will not be correlated through those headers.
Upgrade or reconfigure that backend to accept W3C Trace Context before relying on end-to-end
correlation after migration.

Do not copy `distributedTracingMode`, `appId` or `enableCorsCorrelation` into the distribution's
configuration. For cross-origin requests, configure `fetch.propagateTraceHeaderCorsUrls` and
`xhr.propagateTraceHeaderCorsUrls` through `getInstrumentations()` and allow the corresponding
headers in the server's CORS policy. There is no blanket cross-origin correlation switch.
Same-origin propagation does not require an allow-list entry.

`traces.propagators` remains the standard OpenTelemetry extension point. Caller-supplied propagators
are caller-owned integrations, not a built-in legacy compatibility layer. Global propagation is a
page-lifetime registration, so later instances cannot independently change its policy.

## Available API replacements

Await `useMicrosoftOpenTelemetry()` before emitting telemetry. Configure `azureMonitor` to use
Azure Monitor, or supply OpenTelemetry processors/exporters for another destination. There is no
default export destination when neither is configured.

| Existing API or behavior                                        | Migration                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trackEvent`                                                    | Emit a log record with a top-level `eventName` and `attributes`. Ordinary named application logs map to Azure Monitor custom events.                                                                                                                              |
| `trackTrace`                                                    | Emit a log record with `body`, `severityNumber` and optional `attributes`, without an `eventName` when a trace message is intended.                                                                                                                               |
| `trackException`                                                | Emit an `exception` log with `exception.type`, `exception.message` and `exception.stacktrace` attributes. Enable the `errors` instrumentation separately for automatic errors and unhandled rejections.                                                           |
| `trackDependencyData`                                           | Use automatic fetch/XHR spans or create an OpenTelemetry CLIENT span with appropriate HTTP attributes and status.                                                                                                                                                 |
| `startTrackEvent` / `stopTrackEvent`                            | Use a span for an operation with duration. This changes the telemetry model from a timed custom event, so update queries accordingly.                                                                                                                             |
| `trackPageView` / `trackPageViewPerformance`                    | Prefer built-in page-view collection. For manually emitted page-view logs, follow the event catalogue's schema rather than passing an Application Insights telemetry object. There is no manual page timing API equivalent to `startTrackPage` / `stopTrackPage`. |
| `setAuthenticatedUserContext` / `clearAuthenticatedUserContext` | Use `telemetry.userContext` on the returned handle. Review persistence differences before moving existing calls.                                                                                                                                                  |
| `flush` / `unload`                                              | Await `telemetry.forceFlush()` / `telemetry.shutdown()`. Both return promises and can reject. Shutdown is not a restart or a configuration update.                                                                                                                |
| `addTelemetryInitializer`                                       | Use `resource` for fixed application attributes and span/log processors or instrumentation hooks for per-record enrichment. Processors are fixed at startup and cannot veto delivery to sibling processor branches.                                               |
| `getPlugin`                                                     | Inspect an owned instrumentation with `telemetry.instrumentations.get(id)`. Use the supported `setEnabled`, `add`, `remove` and `replace` controls rather than calling its lifecycle or `setConfig` directly.                                                     |
| `trackMetric`                                                   | No general-purpose metrics replacement is available yet. Metrics export remains planned work, but the `trackMetric` API itself will not be introduced.                                                                                                            |

For example, after initialization:

```typescript
import { trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

logs.getLogger("checkout").emit({
  eventName: "checkout.started",
  attributes: { "cart.item_count": 3 },
});

logs.getLogger("checkout").emit({
  body: "Checkout started",
  severityNumber: SeverityNumber.INFO,
});

const span = trace.getTracer("checkout").startSpan("checkout");
span.setAttribute("cart.item_count", 3);
span.end();
```

Log `eventName` is not a span event or an `event.name` attribute. Use application event names rather
than reserved browser event names unless deliberately following their schema. Avoid sending
credentials or personal data in names, messages, attributes or exception stacks.

## Configuration and behavior to review at cutover

The configuration object is not a copy of ApplicationInsights-JS `IConfig` or `IConfiguration`.
Map the settings the application actually uses rather than spreading its old configuration into
the new initializer.

| Area                          | Current behavior and migration impact                                                                                                                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency collection         | npm initialization does not install fetch/XHR automatically. Pass `await getInstrumentations()` to opt in. The CDN loader enables fetch/XHR by default.                                                                                                                                               |
| Exceptions and console        | `errors` and `console` are opt-in. Enable `errors` if the application expects automatic exception collection, including unhandled promise rejections. Errors raised before the loader initializes are not recovered.                                                                                  |
| Page views                    | Built-in page views are enabled by default for initial navigation and SPA routes. Do not also enable raw `navigation` collection unless needed, because Azure Monitor maps both to page views.                                                                                                        |
| User and session storage      | Sessions and managed identity use Web Storage, not Application Insights cookies. Existing `ai_user` and `ai_session` values are not automatically imported. Authenticated user/account IDs set through the handle persist by default, unlike ApplicationInsights-JS's default `storeInCookie: false`. |
| Consent                       | `storage.enabled: false` prevents SDK-managed storage access but does not disable telemetry collection or export. It also disables managed anonymous identity enrichment. Review consent before initialization and use the identity/session controls deliberately.                                    |
| Session timeouts              | Native `session.inactivityTimeout` and `session.maxDuration` use seconds, with zero disabling expiry. The supported `sessionRenewalMs` and `sessionExpirationMs` aliases use milliseconds, with zero restoring their defaults.                                                                        |
| Runtime configuration         | `updateCfg` supports a defined subset, not every ApplicationInsights-JS setting. Unsupported updates reject. Destinations, resources, propagators and processor lists remain startup-only.                                                                                                            |
| Configuration synchronization | Opt-in `extensionConfig.AppInsightsCfgSyncPlugin` synchronizes only sampling and fetch/XHR gates within the same JavaScript realm. It does not load an Application Insights plugin object, fetch remote configuration, or synchronize across tabs or frames.                                          |
| Async context                 | The default context manager is synchronous. Pass explicit OpenTelemetry context across asynchronous boundaries instead of assuming automatic async parenting.                                                                                                                                         |
| Snippet and globals           | Use the distribution's loader and await `window.microsoftOpenTelemetry`. There is no `window.appInsights` compatibility object or `track*` call queue.                                                                                                                                                |
| Data shape                    | Review the event catalogue and Azure Monitor output. Page IDs, timings, event names and enrichment are not guaranteed to match existing queries field for field.                                                                                                                                      |

See [session and identity](docs/configuration-reference.md#session-and-identity),
[runtime updates](docs/configuration-reference.md#runtime-configuration-updates), and
[loader configuration](docs/configuration-reference.md#cdn-loader-configuration) for details.

## Current gaps that are not permanent exclusions

These items are distinct from the decisions above. Do not describe them as supported today or as
features the project has decided never to support. Milestone documents own their scope and timing.

| Gap                                                       | Current boundary                                                                                                                                                                                                                                | Planning                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| General OpenTelemetry metrics export                      | The distribution initializes traces and logs, not a meter provider. The specific `PageVisitTime` metric exported from `browser.page_visit` does not provide a general metrics pipeline.                                                         | [M3](planning/M3_PLANNING.md)                                |
| Cookie persistence and continuity of old user/session IDs | State currently lives in Web Storage. Cookie domain/path behavior and importing existing Application Insights identities are not available.                                                                                                     | [M3](planning/M3_PLANNING.md), [M4](planning/M4_PLANNING.md) |
| Automatic server-rooted page traces                       | Reading initial document trace headers and defining the corresponding SPA parenting policy remain planned. This is W3C work, not legacy-header support.                                                                                         | [M1](planning/M1_PLANNING.md)                                |
| Side-by-side operation with ApplicationInsights-JS        | Shared patches coordinate instances of this distribution, not a guaranteed zero-duplication migration alongside ApplicationInsights-JS. Coexistence and field-by-field data comparisons remain migration work.                                  | [M4](planning/M4_PLANNING.md)                                |
| React/Angular and Click Analytics migration               | The Application Insights plugins cannot be reused as-is. Optional integrations and their migration paths remain planned. User-action click logs are not full Click Analytics parity.                                                            | [M3](planning/M3_PLANNING.md), [M4](planning/M4_PLANNING.md) |
| Advanced transport, enrichment and offline behavior       | Full transport tuning, dependency header capture, exception enrichment and a durable offline package are not yet available. The existing bounded same-tab `sessionStorage` buffer is not a durable offline channel.                             | [M3](planning/M3_PLANNING.md)                                |
| Remaining loader and configuration parity                 | Automatic SRI, nonce/Trusted Types controls, early error capture, CDN version aliases and HTTP-based remote configuration sync remain planned work. Current manual SRI, selected runtime updates and same-realm sync do not cover all of these. | [M3](planning/M3_PLANNING.md), [M4](planning/M4_PLANNING.md) |

## Migration checks

1. Inventory the application's APIs, plugins, configuration and backend propagation support. Treat
   an intentional exclusion as a migration decision, not a setting that can be copied across.
2. Configure the destination and selected instrumentations, then await initialization.
3. Verify a page view, fetch/XHR dependency, application event and exception at the destination.
   Confirm W3C correlation with the backend and account for sampling.
4. Review identity continuity, consent, storage, dashboards and telemetry queries before cutover.
5. Remove or explicitly coordinate the old SDK's automatic collectors. Running both SDKs without
   a tested plan can double-count telemetry and overwrite outgoing correlation headers.

The [M4 migration plan](planning/M4_PLANNING.md#migration-from-applicationinsights-js) tracks the
remaining migration validation and documentation. This guide does not announce retirement of
ApplicationInsights-JS or a general-availability support commitment for this beta.
