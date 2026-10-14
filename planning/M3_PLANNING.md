# Milestone M3 - Planning

Deliver advanced parity with capabilities that already exist in
`microsoft/ApplicationInsights-JS`, implemented through standard OpenTelemetry APIs and contracts
where applicable.

Status: started. The M2 CDN and snippet path have shipped; the advanced loader is the first M3 item
in progress.

## Work items

| Item | M3 outcome | ApplicationInsights-JS reference |
| --- | --- | --- |
| SDK health statistics | Opt-in pipeline counters for sent, dropped, retried and throttled telemetry, reported through a path that cannot collect itself. | `sdkStats` |
| Diagnostics settings | Counterparts of the console and telemetry logging levels and debug mode, built on OpenTelemetry `diag` and isolated from customer telemetry. | `loggingLevelConsole`, `loggingLevelTelemetry`, `enableDebug` |
| Dynamic configuration | Runtime configuration updates and remote configuration sync, including instrumentation replacement, limited to options that can be updated atomically. | `updateCfg`, `applicationinsights-cfgsync-js` |
| Telemetry initializers and plugins | OpenTelemetry-native enrichment and filtering that can be registered after startup, plus extension lookup and replacement. | `addTelemetryInitializer`, `getPlugin` |
| Cookie and storage management | Cookie domain, path and name prefix, a switch that disables all browser storage, and consent-safe defaults. | `cookieCfg`, `cookieDomain`, `cookiePath`, `namePrefix`, `isStorageUseDisabled` |
| Transport tuning | Batch interval and size, in-memory limits, retry and unload switches, and transport selection, preserving the current defaults. | `maxBatchInterval`, `maxBatchSizeInBytes`, `eventsLimitInMem`, `transports` |
| Offline persistence | An optional package that persists unsent telemetry with consent gating, bounds and expiry, and recovers it after reload. | `offline-channel-js` |
| Framework integrations | Separate React and Angular packages for routing and lifecycle, with no framework code in core bundles. | `applicationinsights-react-js`, `applicationinsights-angularplugin-js` |
| Click Analytics | An optional package with automatic click capture and `data-*` content extraction, emitted as OpenTelemetry events. | `applicationinsights-clickanalytics-js` |
| Advanced loader | Snippet queueing, alternate CDN domains, load delay and load-failure reporting on top of the M2 snippet. In progress. | Web SDK loader |
| Envelope context tags | The Azure Monitor exporter sets the remaining context tags that Application Insights experiences group on: `ai.operation.name` from the page name, `ai.device.id` and `ai.device.type` for browsers, and `ai.application.ver` from `service.version`. | `TelemetryContext`, `Device` and `Application` in `applicationinsights-properties-js`. Device tags are in review (#108). |
| Dependency enrichment | Opt-in request and response header capture with a header deny list, error status text on failed calls, a per-page-view dependency limit, and resource-timing breakdown on dependencies. | `enableRequestHeaderTracking`, `enableResponseHeaderTracking`, `ignoreHeaders`, `enableAjaxErrorStatusText`, `maxAjaxCallsPerView`, `enableAjaxPerfTracking` |
| Default URL redaction | Redact URL credentials and the `sig`, `Signature`, `AWSAccessKeyId` and `X-Goog-Signature` query parameters by default on dependency, page view and exception URLs, with a configurable list of additional parameters. | `redactUrls`, `redactQueryParams`. Page view URLs and referrers are redacted (#82); dependency and exception URLs remain. |
| Exception enrichment | Optionally attach the loaded scripts and a bounded set of recent application log entries to exception telemetry. | `expCfg.inclScripts`, `expCfg.expLog`, `expCfg.maxLogs` |
| Deferred connection string | Accept the connection string as a promise and buffer telemetry in memory, bounded by size and time, until it resolves. Telemetry is dropped with a diagnostic if it never resolves. | `initTimeOut`, `initInMemoMaxSize` |
| Ingestion request customization | Custom ingestion request headers, a Cross-Origin Resource Policy setting, and a pluggable HTTP transport. | `customHeaders`, `corsPolicy`, `httpXHROverride` |
| High-entropy OS version | Use `navigator.userAgentData.getHighEntropyValues` for the platform version, cached, so OS versions such as Windows 11 are reported correctly. | `applicationinsights-osplugin-js` |
| Legacy correlation headers | Opt-in `Request-Id` and `Request-Context` headers for backends on classic Application Insights SDKs that do not read W3C Trace Context. W3C Trace Context remains the default. | `distributedTracingMode`, `appId`, `enableCorsCorrelation` |
| Metrics export | Export the OpenTelemetry Metrics API to Azure Monitor `MetricData`, gated on the upstream browser metrics decision. | `trackMetric` |
| Application Insights JavaScript coexistence and migration | Run alongside ApplicationInsights-JS on the same page without duplicate `fetch`/`xhr` collection or broken correlation, and publish a configuration mapping from ApplicationInsights-JS options to distribution options, including intentionally unsupported ones. | `IConfig` and `IConfiguration` |
| In-page debug tooling | An optional package that shows emitted and sent telemetry in the page during development. | `applicationinsights-debugplugin-js`, `chrome-debug-extension` |

React Native, the 1DS channel and the Application Insights Light SKU are out of scope. Legacy
Application Insights `track*` APIs remain out of scope.
