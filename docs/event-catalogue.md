# Beta event catalogue

This catalogue describes customer telemetry from `@microsoft/opentelemetry-browser`
**0.1.0-beta.1**, including its pinned `@opentelemetry/browser-instrumentation` **0.8.1** dependency.
It describes the records before exporter-specific mapping. Application hooks and processors can
modify them. Browser conventions are experimental/development-stability; the distribution-owned
page-view schema is not an upstream stable convention. Pin versions and review schema changes.

See [getting started](../README.md#getting-started) and the
[configuration reference](configuration-reference.md) for setup. Timing support varies by browser,
so an enabled instrumentation does not guarantee every event or attribute appears.

## Collection inventory and sources

All event names below are the log record's top-level `eventName`, not a span event or an
`event.name` attribute. HTTP operations are spans, not named log events. Unless noted otherwise,
automatic log events use INFO severity (`9`) and have no required body.

| Telemetry          | Signal/name                         | Default               | Source module                                                                                       |
| ------------------ | ----------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| Page view          | Log `browser.page_view`             | On                    | [Distribution page-view implementation](../src/instrumentation/pageView/pageViewInstrumentation.ts) |
| Fetch              | CLIENT span, normalized HTTP method | On when helper called | `@opentelemetry/browser-instrumentation/experimental/fetch`                                         |
| XHR                | CLIENT span, normalized HTTP method | On when helper called | `@opentelemetry/browser-instrumentation/experimental/xhr`                                           |
| Console            | Log `browser.console`               | Opt-in                | `@opentelemetry/browser-instrumentation/experimental/console`                                       |
| Unhandled errors   | Log `exception`                     | Opt-in                | `@opentelemetry/browser-instrumentation/experimental/errors`                                        |
| Navigation         | Log `browser.navigation`            | Opt-in                | `@opentelemetry/browser-instrumentation/experimental/navigation`                                    |
| Document timing    | Log `browser.navigation_timing`     | Opt-in                | `@opentelemetry/browser-instrumentation/experimental/navigation-timing`                             |
| Subresource timing | Log `browser.resource_timing`       | Opt-in                | `@opentelemetry/browser-instrumentation/experimental/resource-timing`                               |
| Clicks             | Log `browser.user_action.click`     | Opt-in                | `@opentelemetry/browser-instrumentation/experimental/user-action`                                   |
| Web Vitals         | Log `browser.web_vital`             | Opt-in                | `@opentelemetry/browser-instrumentation/experimental/web-vitals`                                    |

The [instrumentation helper](../src/instrumentation/browserInstrumentation/getInstrumentations.ts)
loads only selected modules in npm applications. The CDN SDK includes all modules but enables only
fetch/XHR unless configured otherwise. Merely importing the distribution installs none of these;
initialization must include an exporting pipeline for the relevant signal.

## Common enrichment and correlation

- All exported spans/logs carry the configured resource, including `service.name` and optional
  `service.version`.
- Managed `session.id` and `enduser.pseudo.id` are added by default. Identity set through the handle
  adds `user.id` and optional `user.account.id`. Explicit record/resource attributes take precedence;
  see [session and identity](configuration-reference.md#session-and-identity).
- Built-in page views establish a shared operation trace ID for otherwise unparented telemetry.
  A page-view ID is an OpenTelemetry trace ID, not a session ID or UUID. Explicit span context is
  preserved. Page URL, title and descriptive fields are not copied to every record.
- Percentage sampling and browser/API availability can suppress records. Unload flushing is best
  effort; no durable offline queue exists.

## Page view: `browser.page_view`

Emitted once per observed navigation: initial document load, SPA route changes and back/forward
cache restores. Soft navigation emits after a paint/idle settling heuristic or the configured cap.
Pending records finalize before a page-hide flush, including hidden visibility. Becoming visible
again does not by itself create another page view. The built-in record has no body; the resolved
page name is in `browser.page_view.name`.

Schema source: [page-view conventions](../src/instrumentation/pageView/semconv.ts).

| Attribute                                         | Type/unit            | Meaning                                                                                                                                                                 |
| ------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url.full`                                        | string, optional     | Page URL after built-in redaction and optional sanitizer; omitted if sanitization drops it.                                                                             |
| `browser.page_view.id`                            | string               | Operation trace ID for this navigation.                                                                                                                                 |
| `browser.page_view.name`                          | string               | Resolved page name.                                                                                                                                                     |
| `browser.page_view.name_source`                   | string               | `explicit`, `route`, `document_title` or `url_path`. The public initialization option exposes `routeResolver`; the lifecycle handle does not expose a page-name setter. |
| `browser.page_view.duration`                      | number, ms           | Duration interpreted with its source below, not time spent on the page.                                                                                                 |
| `browser.page_view.duration_source`               | string               | Measurement/heuristic source below.                                                                                                                                     |
| `browser.page_view.referrer`                      | string, optional     | Sanitized referring URL; omitted when unknown, on a back/forward cache restore, or when sanitization drops it.                                                          |
| `browser.page_view.type`                          | string               | `navigate`, `reload`, `back_forward`, `prerender`, `push`, `replace` or `traverse`.                                                                                     |
| `browser.page_view.same_document`                 | boolean              | Whether this is an in-document route change.                                                                                                                            |
| `browser.page_view.index`                         | number               | Zero-based ordinal within the document.                                                                                                                                 |
| `browser.page_view.performance.total`             | number, ms, optional | Browser-reported total document navigation time.                                                                                                                        |
| `browser.page_view.performance.network_connect`   | number, ms, optional | Navigation through connection establishment.                                                                                                                            |
| `browser.page_view.performance.sent_request`      | number, ms, optional | Request send and server wait.                                                                                                                                           |
| `browser.page_view.performance.received_response` | number, ms, optional | Response download.                                                                                                                                                      |
| `browser.page_view.performance.dom_processing`    | number, ms, optional | DOM processing after response completion.                                                                                                                               |

The five performance fields are added when a valid document navigation timing breakdown is
available, not for ordinary SPA route changes. Names based on concrete paths or document titles can
have high cardinality; prefer `routeResolver` patterns. URL redaction applies to page URL/referrer,
not every field or every other instrumentation.

### Page-view duration sources

| Value                         | Interpretation                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `navigation_timing`           | Browser-reported document navigation duration.                                       |
| `document_load`               | Fallback elapsed document-load time when navigation timing is unavailable.           |
| `soft_navigation_settled`     | Observed soft-navigation settle heuristic.                                           |
| `soft_navigation_capped`      | Soft navigation did not settle before the timeout.                                   |
| `soft_navigation_interrupted` | Superseded by another navigation before settlement.                                  |
| `page_hide`                   | Finalized because the page became hidden before settlement.                          |
| `bfcache_restore_settled`     | Observed settlement after a back/forward cache restore, without a new document load. |
| `bfcache_restore_capped`      | Cache restore did not settle before the timeout.                                     |

Do not combine document-load and soft-navigation populations when computing percentiles. Capped,
interrupted and hidden-page durations are truncated/lower-bound observations, not completed loads.

## HTTP operations: fetch and XHR

Create CLIENT spans named after the normalized HTTP method, such as `GET` or `POST`. Completion,
failure, abort and timeout determine the final status/attributes. URL filters can skip collection.

| Attribute                      | Type/unit     | Presence                                                                                           |
| ------------------------------ | ------------- | -------------------------------------------------------------------------------------------------- |
| `http.request.method`          | string        | Normalized method.                                                                                 |
| `http.request.method_original` | string        | When the original differs from normalization.                                                      |
| `url.full`                     | string        | Request URL, optionally transformed by this instrumentation's `sanitizeUrl`.                       |
| `server.address`               | string        | Request hostname.                                                                                  |
| `server.port`                  | number        | Non-default port when applicable.                                                                  |
| `http.response.status_code`    | number        | When a response status is available.                                                               |
| `error.type`                   | string        | On failure, such as an HTTP status or request error.                                               |
| `http.request.body.size`       | number, bytes | Optional request-body measurement when `measureRequestSize` is enabled and size can be determined. |

Request/attribute hooks can add fields. Automatic request/response body capture is not provided.
Cross-origin trace headers require explicit URL allowance and server CORS support. Page-view
redaction settings do not sanitize dependency URLs. Distribution-owned Azure Monitor export
requests suppress tracing to avoid self-collection loops.

## Console: `browser.console`

One log per captured console call. The body is the serialized console arguments; the string
attribute `browser.console.method` identifies the method.

| Method        | Severity number |
| ------------- | --------------- |
| `debug`       | DEBUG (`5`)     |
| `log`, `info` | INFO (`9`)      |
| `warn`        | WARN (`13`)     |
| `error`       | ERROR (`17`)    |

Use `logMethods` and `messageSerializer` to limit collection. Console messages can contain personal
data or credentials. `console.error()` alone is not automatically an exception record.

## Unhandled errors: `exception`

ERROR (`17`) logs from uncaught `error` events and `unhandledrejection` events. Available error
details are represented by string attributes `exception.type`, `exception.message` and
`exception.stacktrace`. Non-Error rejection reasons may have less detail. `applyCustomAttributes`
can add fields. Error messages and stacks may contain URLs and application data; review them before
exporting. These are log records, not automatically created error spans.

## Navigation: `browser.navigation`

Reports initial load and in-document navigation through History APIs, or the Navigation API when
explicitly enabled and available.

| Attribute                          | Type             | Meaning                                                                       |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `url.full`                         | string           | Destination URL, optionally sanitized.                                        |
| `browser.navigation.same_document` | boolean          | Whether the navigation stays in the document.                                 |
| `browser.navigation.hash_change`   | boolean          | Whether the hash changed.                                                     |
| `browser.navigation.type`          | string, optional | `push`, `replace`, `traverse` or `reload` when supplied by the observed path. |

Prefer built-in page-view collection unless the raw navigation event is specifically needed.
Enabling both emits separate records; **Azure Monitor maps both to page views**, so counts can
double. Navigation has no built-in page name, duration, referrer or page-view ID attributes.

## Timing events

Performance timing fields below are numbers. Time points are milliseconds relative to the
performance time origin, not epoch timestamps or individual phase durations. Durations are
milliseconds; size fields are bytes. Cross-origin timing restrictions, caches and unsupported
browser properties may yield zeros or missing fields.

### Document: `browser.navigation_timing`

Emitted for `PerformanceNavigationTiming` after load completion, with bounded retries if timing
has not finalized. Lifecycle finalization can emit an incomplete entry. It is not the source of
the distribution's page-view performance projection.

| Attribute(s)                                                                                                         | Type/unit                        |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `url.full`                                                                                                           | string, document URL             |
| `browser.navigation_timing.type`                                                                                     | string, document navigation type |
| `browser.navigation_timing.dom_complete`                                                                             | number, ms                       |
| `browser.navigation_timing.dom_content_loaded_event_start`, `browser.navigation_timing.dom_content_loaded_event_end` | number, ms                       |
| `browser.navigation_timing.dom_interactive`                                                                          | number, ms                       |
| `browser.navigation_timing.load_event_start`, `browser.navigation_timing.load_event_end`                             | number, ms                       |
| `browser.navigation_timing.unload_event_start`, `browser.navigation_timing.unload_event_end`                         | number, ms                       |
| `browser.navigation_timing.redirect_count`                                                                           | number, count                    |

This event also emits the shared resource-timing fields in the next table. In particular, its
duration key is **`browser.resource_timing.duration`**, not `browser.navigation_timing.duration`.

### Resources: `browser.resource_timing`

One log per selected `PerformanceResourceTiming` entry, collected through a buffered
`PerformanceObserver` and a bounded queue. By default, the distribution selects only `script`,
`link` and `css` initiators with a queue of 256. Override those helper settings to collect others.

| Attribute(s)                                                                                                                      | Type/unit         | Emitted by                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------ |
| `url.full`                                                                                                                        | string            | Both timing events             |
| `browser.resource_timing.duration`                                                                                                | number, ms        | Both                           |
| `browser.resource_timing.fetch_start`                                                                                             | number, ms        | Both                           |
| `browser.resource_timing.domain_lookup_start`, `browser.resource_timing.domain_lookup_end`                                        | number, ms        | Both                           |
| `browser.resource_timing.connect_start`, `browser.resource_timing.connect_end`                                                    | number, ms        | Both                           |
| `browser.resource_timing.secure_connection_start`                                                                                 | number, ms        | Both                           |
| `browser.resource_timing.request_start`                                                                                           | number, ms        | Both                           |
| `browser.resource_timing.response_start`, `browser.resource_timing.response_end`                                                  | number, ms        | Both                           |
| `browser.resource_timing.transfer_size`, `browser.resource_timing.encoded_body_size`, `browser.resource_timing.decoded_body_size` | number, bytes     | Both                           |
| `browser.resource_timing.initiator_type`                                                                                          | string            | Resources only                 |
| `browser.resource_timing.redirect_start`, `browser.resource_timing.redirect_end`                                                  | number, ms        | Resources only                 |
| `browser.resource_timing.worker_start`                                                                                            | number, ms        | Resources only                 |
| `browser.resource_timing.next_hop_protocol`                                                                                       | string, e.g. `h2` | Resources only                 |
| `browser.resource_timing.render_blocking_status`                                                                                  | string            | Resources only, when available |

Timing URLs are not covered by the page-view sanitizer. Consider URL filtering and custom log
processors when timing sources include sensitive query strings.

## User action: `browser.user_action.click`

Emitted for captured document clicks. Currently click is the supported automatic action.

| Attribute                          | Type/unit               | Meaning                                                     |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `browser.page.x`, `browser.page.y` | number, CSS pixels      | Click coordinates.                                          |
| `browser.tag_name`                 | string                  | Element tag, such as `BUTTON`.                              |
| `browser.mouse_event.button`       | string                  | Button name, such as `left`, `middle` or `right`.           |
| `browser.css_selector`             | string                  | Selector for the clicked element.                           |
| `browser.element.attributes`       | object of string values | Element's `data-otel-*` attributes with the prefix removed. |

This is basic click capture, not the full Application Insights Click Analytics feature. Selectors
can contain element IDs; custom element attributes can contain application data. Use a log hook to
sanitize before emission. Structured attributes are subject to downstream SDK/exporter handling.

## Web Vitals: `browser.web_vital`

Logs from the upstream Web Vitals callbacks, not OpenTelemetry Metrics API instruments. Events
depend on performance API support, user interaction and page lifecycle; not every metric emits
immediately or in every browser.

| Attribute                           | Type/unit | Meaning                                                    |
| ----------------------------------- | --------- | ---------------------------------------------------------- |
| `browser.web_vital.name`            | string    | `cls`, `inp`, `lcp`, `fcp` or `ttfb`.                      |
| `browser.web_vital.value`           | number    | Milliseconds for INP/LCP/FCP/TTFB; unitless score for CLS. |
| `browser.web_vital.delta`           | number    | Change in the same unit as the value.                      |
| `browser.web_vital.rating`          | string    | `good`, `needs-improvement` or `poor`.                     |
| `browser.web_vital.id`              | string    | Metric observation ID.                                     |
| `browser.web_vital.navigation_type` | string    | Navigation classification from the Web Vitals library.     |

`includeRawAttribution: true` adds attribution JSON as the log body; it is off by default. Review
attribution content for sensitive data. Some underlying listeners cannot be removed; disabling
instrumentation stops emission rather than promising removal of all Web Vitals listeners.

## Manual telemetry and loader failures

Applications choose their own span names and named log events using standard OpenTelemetry APIs.
See the [manual example](../README.md#manual-telemetry). Prefer stable event names and attribute
keys, with changing values in attributes. Avoid unnecessary personal data and high-cardinality
labels. Azure Monitor named custom events preserve attributes, not a separate message body; use
attributes for event data that must be queryable there.

When the generated loader enables `reportLoadFailure`, a bundle load failure after fallback attempts
sends an `SDKLoadFailed` exception directly to the configured ingestion endpoint. It is not an OTel
log from the SDK, since initialization may never occur. Its reported URL omits credentials, query
and fragment. Source: [loader implementation](../src/snippet.ts).

Internal exporter network SDK Stats are a separate SDK-owned delivery path, not customer
events or a public Metrics API. They are not included in the event schemas above. See the
[SDK Stats implementation](../src/exporter/sdkStats.ts).

## Azure Monitor mapping

Source: [log mapping](../src/exporter/logUtils.ts) and [span mapping](../src/exporter/spanUtils.ts).
These projections apply to the Azure Monitor exporter; OTLP/custom exporters receive OTel records.
Table names follow the [Azure Monitor telemetry data model](https://learn.microsoft.com/azure/azure-monitor/app/data-model-complete#types-of-telemetry).

| OTel telemetry                                                  | Azure Monitor base type                       | Application Insights table / workspace table |
| --------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `browser.page_view`                                             | `PageViewData`                                | `pageViews` / `AppPageViews`                 |
| Page view with all five valid performance fields                | Additional `PageviewPerformanceData` envelope | `browserTimings` / `AppBrowserTimings`       |
| `browser.navigation`                                            | `PageViewData`                                | `pageViews` / `AppPageViews`                 |
| Fetch/XHR CLIENT span                                           | `RemoteDependencyData`, HTTP dependency       | `dependencies` / `AppDependencies`           |
| `exception`, or a log with `exception.type`                     | `ExceptionData`                               | `exceptions` / `AppExceptions`               |
| `browser.console`, or an unnamed ordinary log                   | `MessageData`                                 | `traces` / `AppTraces`                       |
| Other named logs, including timing, click and Web Vitals events | `EventData`                                   | `customEvents` / `AppEvents`                 |

Exception classification takes precedence over other log classifications. Named events are custom
events regardless of severity; console remains a trace message. Span events named `exception`
export as correlated `ExceptionData`; other span events export as `MessageData` trace messages,
with the event name as the message. They are not `EventData` custom events. Span kind controls other manual span
projections; do not assume every manual span becomes a request.

Page-view name, URL, ID and duration become dedicated fields. Referrer also appears as `refUri` in
custom properties. Built-in page-view diagnostic/ordinal fields are omitted from custom dimensions
and measurements; custom application attributes remain. Numeric attributes generally map to custom
measurements and other values to custom dimensions, subject to Azure Monitor field limits. Session,
identity and operation context map to their dedicated tags/columns rather than duplicate properties.

For example, to inspect Web Vitals from the Application Insights Logs view:

```kusto
customEvents
| where timestamp > ago(30m)
| where name == "browser.web_vital"
| project timestamp,
    vital = tostring(customDimensions["browser.web_vital.name"]),
    value = todouble(customMeasurements["browser.web_vital.value"]),
    operation_Id
```

Use `AppEvents` and workspace column names when querying directly from a Log Analytics workspace.
