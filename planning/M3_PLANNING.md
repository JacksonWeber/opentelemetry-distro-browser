# Milestone M3 - Planning

Deliver advanced parity with capabilities that already exist in
`microsoft/ApplicationInsights-JS`, implemented through standard OpenTelemetry APIs and contracts
where applicable.

Status: not started. M3 begins after the M2 CDN and snippet path is stable.

## Outcomes

- Advanced configuration and diagnostics parity.
- Optional Web SDK extensions and framework integrations.
- Advanced loader and delivery behavior.
- Remaining Application Insights JavaScript feature gaps, listed below.

The Azure Boards M3 items track the outcomes above. The following gaps have no Azure Boards item
yet:

| Item | M3 outcome | ApplicationInsights-JS reference |
| --- | --- | --- |
| Envelope context tags | The Azure Monitor exporter sets the remaining context tags that Application Insights experiences group on: `ai.operation.name` from the page name, `ai.device.id` and `ai.device.type` for browsers, and `ai.application.ver` from `service.version`. | `TelemetryContext`, `Device` and `Application` in `applicationinsights-properties-js` |
| Dependency enrichment | Opt-in request and response header capture with a header deny list, error status text on failed calls, a per-page-view dependency limit, and resource-timing breakdown on dependencies. | `enableRequestHeaderTracking`, `enableResponseHeaderTracking`, `ignoreHeaders`, `enableAjaxErrorStatusText`, `maxAjaxCallsPerView`, `enableAjaxPerfTracking` |
| Default URL redaction | Redact URL credentials and the `sig`, `Signature`, `AWSAccessKeyId` and `X-Goog-Signature` query parameters by default on dependency, page view and exception URLs, with a configurable list of additional parameters. | `redactUrls`, `redactQueryParams` |
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
