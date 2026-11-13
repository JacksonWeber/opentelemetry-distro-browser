# Migrating from ApplicationInsights-JS

`@microsoft/opentelemetry-browser` can send telemetry to the same Azure Monitor resource, but it is
not a drop-in replacement. Applications must migrate their APIs, configuration and queries.

This guide covers the repository's `0.1.0-beta.2` implementation, using ApplicationInsights-JS 3.4.5
as the planning reference. Check your deployed version's declarations and the
[configuration reference](docs/configuration-reference.md).

## Intentional exclusions

These features are outside the migration scope, not deferred work.

| ApplicationInsights-JS capability          | Migration path                                                                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Request-Id` and `Request-Context` headers | Use W3C Trace Context. No built-in legacy propagation, `distributedTracingMode` or `appId` compatibility options are planned.                                                                                                             |
| `track*` APIs                              | Use OpenTelemetry Trace and Logs APIs. No `track*` compatibility package is planned.                                                                                                                                                      |
| `addTelemetryInitializer`                  | Use resources, processors and instrumentation hooks. Filter at the source or in your exporter branch. A processor cannot veto delivery to sibling branches.                                                                               |
| `getPlugin` and existing plugins/channels  | Use the handle's supported instrumentation controls and OpenTelemetry processors/exporters. Existing Application Insights plugin objects are not interchangeable. Multiple processors replace `tee-channel-js` for multiple destinations. |
| React Native, 1DS and the Light SKU        | Outside this browser distribution's scope. Browser React/Angular integrations remain planned.                                                                                                                                             |
| Internet Explorer and ES5 builds           | Target the [supported browsers](README.md#browser-support).                                                                                                                                                                               |

### Correlation

Default propagation uses W3C Trace Context and Baggage. Automatic fetch/XHR headers require
available context and an allowed URL. Backends that read only legacy headers need W3C support
before end-to-end correlation will work. W3C does not reproduce `Request-Context` app-ID exchange.

For cross-origin requests, configure `fetch.propagateTraceHeaderCorsUrls` and
`xhr.propagateTraceHeaderCorsUrls` through `getInstrumentations()`, and allow the headers in the
server's CORS policy. Same-origin requests need no allow-list entry. There is no
`enableCorsCorrelation` switch.

Custom `traces.propagators` remain supported, but are not a built-in legacy compatibility layer.
Propagation is registered for the page lifetime, not independently per instance.

## API replacements

Configure `azureMonitor` or custom processors/exporters and await `useMicrosoftOpenTelemetry()`.
Without a destination, nothing exports. These mappings are not field-for-field equivalents.
Azure Monitor mappings apply only when using its exporters.

| Existing API                                                    | Replacement                                                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `trackEvent`                                                    | Emit a log with top-level `eventName` and `attributes`. Ordinary named application logs become custom events.         |
| `trackTrace`                                                    | Emit a log with `body`, `severityNumber` and optional attributes, without `eventName`.                                |
| `trackException`                                                | Emit an `exception` log with `exception.type`, `exception.message` and `exception.stacktrace` attributes.             |
| `trackDependencyData`                                           | Use automatic fetch/XHR spans or a CLIENT span with appropriate HTTP attributes and status.                           |
| `startTrackEvent` / `stopTrackEvent`                            | Use a span for duration. This is operation telemetry, not a timed custom event.                                       |
| `trackPageView` / `trackPageViewPerformance`                    | Prefer automatic page views. Manual `browser.page_view` logs must follow the [event schema](docs/event-catalogue.md). |
| `setAuthenticatedUserContext` / `clearAuthenticatedUserContext` | Use `telemetry.userContext`. Review the persistence differences below.                                                |
| `flush` / `unload`                                              | Await `telemetry.forceFlush()` / `telemetry.shutdown()`. Both can reject.                                             |
| `trackMetric`                                                   | No general metrics pipeline yet. Metrics export remains planned, but the `trackMetric` API does not.                  |

Manual page-view logs do not start a page operation or drive page-visit tracking, and can duplicate
automatic collection. The additional page-view performance record requires all five performance
duration attributes to be finite numbers. No public `startTrackPage` / `stopTrackPage` helper exists.

Log `eventName` is not a span event or an `event.name` attribute. Avoid reserved browser event names
unless following their schema, and exclude credentials and personal data from telemetry.

## Configuration differences

Do not pass the old ApplicationInsights-JS configuration object to the new initializer.

| Area                | What to review                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection defaults | npm requires `instrumentations: await getInstrumentations()` for fetch/XHR. The CDN loader enables them by default. `errors` and `console` are opt-in. Application errors before instrumentation starts are not buffered.                                                                                                                                                 |
| Page views          | Initial and SPA page views are on by default. Enabling raw `navigation` too can duplicate Azure Monitor page views.                                                                                                                                                                                                                                                       |
| Identity            | State uses Web Storage. Existing `ai_user` and `ai_session` values are not automatically imported. Authenticated IDs persist by default, unlike ApplicationInsights-JS's default `storeInCookie: false`.                                                                                                                                                                  |
| Consent             | `storage.enabled: false` blocks SDK storage and managed anonymous enrichment for that handle. It does not stop export, erase existing data or control custom processors.                                                                                                                                                                                                  |
| Session lifetimes   | Native timeouts use seconds, with zero disabling expiry. `sessionRenewalMs` and `sessionExpirationMs` use milliseconds, with zero restoring defaults.                                                                                                                                                                                                                     |
| Runtime updates     | `updateCfg` accepts only supported fields. Destinations, resources, propagators and processors remain startup-only. Use supported handle controls for instrumentation changes.                                                                                                                                                                                            |
| Configuration sync  | In `0.1.0-beta.2`, `extensionConfig.AppInsightsCfgSyncPlugin` supports broadcast-only or receive-only modes for sampling and fetch/XHR gates in one realm. Publishing requires `configSync.sync()`. HTTP downloads are an unreleased addition. Neither mode provides automatic broadcast or cross-tab/frame sync, and the generated loader does not accept these options. |
| Async context       | The default manager is synchronous. Pass explicit context across asynchronous boundaries.                                                                                                                                                                                                                                                                                 |
| Exception context   | Opt-in `expCfg.inclScripts`, `expCfg.expLog` and `expCfg.maxLogs` attach script info and application callback logs to exception logs and span events. Each attachment is capped at 8 KiB UTF-8. Script URLs are redacted; log text is not. See [exception attachments](docs/configuration-reference.md#exception-attachments).                                            |
| Loader              | Await `window.microsoftOpenTelemetry`. There is no `window.appInsights` object or `track*` queue.                                                                                                                                                                                                                                                                         |

Script info uses the ApplicationInsights-JS object shape (`url`, optional `crossOrigin`, `async`,
`defer` and `referrerPolicy`). Unlike the legacy SDK, `expCfg` is startup-only, existing application
attributes win, and script URLs are resolved, filtered to HTTP(S) and redacted.

See the configuration reference for [identity](docs/configuration-reference.md#session-and-identity),
[runtime updates](docs/configuration-reference.md#runtime-configuration-updates),
[instrumentation controls](docs/configuration-reference.md#runtime-instrumentation-controls) and
[configuration sync](docs/configuration-reference.md#optional-configuration-synchronization).

## Planned gaps, not permanent exclusions

These remain roadmap work, with no release commitment:

| Gap                                       | Current limitation                                                                                                                                                                                                                                                                                                                                                  | Plan                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Metrics                                   | No meter provider. The specific `PageVisitTime` metric is not a general metrics pipeline.                                                                                                                                                                                                                                                                           | [M3](planning/M3_PLANNING.md)                                |
| Cookies and identity continuity           | No built-in cookie domain/path controls or automatic import of Application Insights IDs.                                                                                                                                                                                                                                                                            | [M3](planning/M3_PLANNING.md), [M4](planning/M4_PLANNING.md) |
| Server-rooted page traces                 | No automatic W3C extraction from document meta tags or `Server-Timing`. Application-supplied context is honored.                                                                                                                                                                                                                                                    | [M1](planning/M1_PLANNING.md)                                |
| Coexistence                               | Shared patches coordinate this distribution's instances, not guaranteed duplicate-free operation with ApplicationInsights-JS. Data comparisons remain outstanding.                                                                                                                                                                                                  | [M4](planning/M4_PLANNING.md)                                |
| React/Angular and Click Analytics         | Integrations and migration paths remain planned. User-action click logs are not full Click Analytics parity.                                                                                                                                                                                                                                                        | [M3](planning/M3_PLANNING.md), [M4](planning/M4_PLANNING.md) |
| Transport, enrichment and offline storage | Full transport tuning, built-in header capture and durable offline storage remain planned. Hooks support custom enrichment. The same-tab `sessionStorage` buffer is not durable offline storage.                                                                                                                                                                    | [M3](planning/M3_PLANNING.md)                                |
| Loader and remote configuration           | Automatic SRI and nonce/Trusted Types controls and early error capture remain planned. Major CDN aliases are implemented; HTTP configuration sync is available in unreleased source, not `0.1.0-beta.2`. See [CDN aliases](docs/packaging.md#major-version-aliases-and-promotion) and [HTTP sync](docs/configuration-reference.md#http-synchronization-unreleased). | [M3](planning/M3_PLANNING.md), [M4](planning/M4_PLANNING.md) |

Before cutover, verify page views, dependencies, events, exceptions and backend correlation at the
destination. Review identity continuity, consent and queries. Remove or explicitly coordinate the
old SDK's collectors to avoid duplicate telemetry and conflicting headers.

This guide does not announce ApplicationInsights-JS retirement or GA support for this beta.
