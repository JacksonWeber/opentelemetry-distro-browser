# Milestone M3 - Planning

Deliver advanced parity with capabilities that already exist in
`microsoft/ApplicationInsights-JS`, implemented through standard OpenTelemetry APIs and contracts
where applicable.

Status: in progress. The advanced loader, high-entropy OS version, envelope context tags, URL
redaction, the unsent telemetry buffer and the deferred connection string have shipped; SDK health
statistics and storage configuration are partly done. Gaps were last compared against
ApplicationInsights-JS 3.4.5. Migration from ApplicationInsights-JS and the general availability
release are owned by [M4](M4_PLANNING.md).

## Work items

| Item | M3 outcome | ApplicationInsights-JS reference | Status |
| --- | --- | --- | --- |
| SDK health statistics | Pipeline counters for sent, dropped, retried and throttled telemetry, reported through a path that cannot collect itself. | `sdkStats`, `stats` | Partial. Request-level success, failure, retry, throttle, exception and duration counters are sent hourly to the internal stats endpoint, with no public option (#121). Item-level `Item_Success_Count`, `Item_Dropped_Count` and `Item_Retry_Count`, including drops from queue limits and sampling, remain. |
| Diagnostics settings | Counterparts of the console and telemetry logging levels and debug mode, built on OpenTelemetry `diag` and isolated from customer telemetry. | `loggingLevelConsole`, `loggingLevelTelemetry`, `enableDebug` | Not started |
| Dynamic configuration | Runtime configuration updates and remote configuration sync, including instrumentation replacement and a telemetry kill switch, limited to options that can be updated atomically. | `updateCfg`, `disableTelemetry`, `applicationinsights-cfgsync-js` | Not started |
| Telemetry initializers and plugins | OpenTelemetry-native enrichment and filtering that can be registered after startup, plus extension lookup and replacement. | `addTelemetryInitializer`, `getPlugin` | Not started |
| Cookie and storage management | Cookie domain, path and name prefix, a switch that disables all browser storage, and consent-safe defaults. | `cookieCfg`, `cookieDomain`, `cookiePath`, `namePrefix`, `isStorageUseDisabled` | Partial. `storage.enabled: false` turns off browser storage for an instance and `storage.namePrefix` scopes its keys (#133). Session and anonymous user defaults match Application Insights JavaScript (#124). Authenticated user and account IDs persist by default, unlike Application Insights JavaScript, where `storeInCookie` defaults to false. Cookie persistence, cookie domain and cookie path remain; the distribution stores state in Web Storage only and sets no cookies. |
| Transport tuning | Batch interval and size, in-memory limits, retry and unload switches, and transport selection, preserving the current defaults. | `maxBatchInterval`, `maxBatchSizeInBytes`, `eventsLimitInMem`, `isRetryDisabled`, `retryCodes`, `maxRetryCnt`, `disablePageUnloadEvents`, `disablePageShowEvents`, `transports`, `unloadTransports` | Not started |
| Unsent telemetry buffer | Keep queued, unsent telemetry in `sessionStorage` and send it on the next page load in the same tab, bounded and consent-gated. | `enableSessionStorageBuffer` | Done (#134). Always on, capped at 512 KiB per exporter with a one-hour expiry, and turned off with `storage.enabled: false`. |
| Offline persistence | An optional package that persists unsent telemetry with consent gating, bounds and expiry, and recovers it after reload. | `offline-channel-js` | Not started |
| Exception collection default | Decide whether unhandled errors and promise rejections are collected by default, at least through the CDN loader. Application Insights JavaScript tracks unhandled errors by default; the distribution's `errors` instrumentation, which also covers rejections, is opt-in. | `disableExceptionTracking`, `enableUnhandledPromiseRejectionTracking` | Not started |
| Page visit time | Optionally report how long the user stayed on the previous page when the next page view starts. | `autoTrackPageVisitTime` | Not started |
| Framework integrations | Separate React and Angular packages for routing and lifecycle, with no framework code in core bundles. | `applicationinsights-react-js`, `applicationinsights-angularplugin-js` | Not started |
| Click Analytics | An optional package with automatic click capture and `data-*` content extraction, emitted as OpenTelemetry events. | `applicationinsights-clickanalytics-js` | Not started |
| Advanced loader | Snippet queueing, load delay, alternate CDN domains and load-failure reporting on top of the M2 snippet. | Web SDK loader | Done (#115). No call queue is needed: there are no `track*` calls to queue, and `window.microsoftOpenTelemetry` resolves to the handle once loaded. |
| Snippet CSP nonce and Trusted Types | Optional settings that apply a CSP nonce to the injected script and create its URL through a Trusted Types policy limited to `js.monitor.azure.com`, or through a caller-supplied policy, for pages that enforce nonce-based CSP or `require-trusted-types-for 'script'`. | Web SDK loader `nt`, `pl`, `pn`, `ttp` | Not started |
| Automatic snippet integrity | Apply SRI without the user pasting the hash, and keep it compatible with the CDN version aliases planned in [M4](M4_PLANNING.md). Publish an `integrity.json` for each alias that names the exact versioned file and its hash; with integrity on, the snippet fetches it and loads that immutable file with its hash, so it receives patches and integrity checking together. A snippet pinned to an exact version can embed the hash when it is generated instead. A manual `integrity` setting exists today. | Web SDK loader `sri` | Not started |
| Early error capture | When exception collection is on, the snippet records `window.onerror` errors and unhandled rejections raised before the bundle loads and reports them after initialization. Today errors before load are lost. Depends on the exception collection default. | Web SDK loader global `onerror` hook | Not started |
| Nightly builds | Publish builds from `main` to an npm `nightly` dist-tag and a separate CDN path for pre-release validation, kept apart from release channels. | npm `nightly` tag, CDN `/nightly/ai.3-nightly.*` | Not started |
| Size badges | Separate minified and gzip size badges for each CDN bundle in place of the combined badge (#112). | `<version>.min.js.svg`, `<version>.min.js.gzip.svg` | Not started |
| Envelope context tags | The Azure Monitor exporter sets the remaining context tags that Application Insights experiences group on: `ai.operation.name` from the page name, `ai.device.id` and `ai.device.type` for browsers, and `ai.application.ver` from `service.version`. | `TelemetryContext`, `Device` and `Application` in `applicationinsights-properties-js` | Done (#108, #114, #120) |
| Dependency enrichment | Opt-in request and response header capture with a header deny list, error status text on failed calls, a per-page-view dependency limit, and resource-timing breakdown on dependencies. | `enableRequestHeaderTracking`, `enableResponseHeaderTracking`, `ignoreHeaders`, `enableAjaxErrorStatusText`, `maxAjaxCallsPerView`, `enableAjaxPerfTracking` | Not started |
| Default URL redaction | Redact URL credentials and the `sig`, `Signature`, `AWSAccessKeyId` and `X-Goog-Signature` query parameters by default on dependency and page view URLs, with a configurable list of additional parameters. | `redactUrls`, `redactQueryParams` | Done. Page view URLs and referrers (#82) and fetch and XHR span URLs (#130). Exception stack URLs are not redacted, which matches Application Insights JavaScript. |
| Exception enrichment | Optionally attach the loaded scripts and a bounded set of recent application log entries to exception telemetry. | `expCfg.inclScripts`, `expCfg.expLog`, `expCfg.maxLogs` | Not started |
| Deferred connection string | Accept the connection string as a promise and buffer telemetry in memory, bounded by size and time, until it resolves. Telemetry is dropped with a diagnostic if it never resolves. | `initTimeOut`, `initInMemoMaxSize` | Done (#135) |
| Ingestion request customization | Custom ingestion request headers, a Cross-Origin Resource Policy setting, and a pluggable HTTP transport. | `customHeaders`, `corsPolicy`, `httpXHROverride` | Not started |
| High-entropy OS version | Use `navigator.userAgentData.getHighEntropyValues` for the platform version, cached, so OS versions such as Windows 11 are reported correctly. | `applicationinsights-osplugin-js` | Done (#122) |
| Legacy correlation headers | Opt-in `Request-Id` and `Request-Context` headers for backends on classic Application Insights SDKs that do not read W3C Trace Context. W3C Trace Context remains the default. | `distributedTracingMode`, `appId`, `enableCorsCorrelation` | Not started |
| Metrics export | Export the OpenTelemetry Metrics API to Azure Monitor `MetricData`, gated on the upstream browser metrics decision. | `trackMetric` | Not started |
| In-page debug tooling | An optional package that shows emitted and sent telemetry in the page during development, and optionally records SDK timings as `performance` marks and measures. | `applicationinsights-debugplugin-js`, `chrome-debug-extension`, `applicationinsights-perfmarkmeasure-js` | Not started |

React Native, the 1DS channel and the Application Insights Light SKU are out of scope. Legacy
Application Insights `track*` APIs are not supported, in the core package or a separate package,
the same as the other Microsoft OpenTelemetry distributions; [M4](M4_PLANNING.md) owns
coexistence with and migration from ApplicationInsights-JS. Sending to several destinations, which
ApplicationInsights-JS does with `tee-channel-js`, is already covered by configuring more than one
span or log record processor.
