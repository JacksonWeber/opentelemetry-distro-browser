# Beta configuration reference

This reference describes `@microsoft/opentelemetry-browser` **0.1.0-beta.1**. Start with the
[getting-started guide](../README.md#getting-started), and consult the
[event catalogue](event-catalogue.md) for emitted data. The public TypeScript contracts are in
[distribution types](../src/types.ts), [page-view options](../src/instrumentation/pageView/types.ts)
and [loader options](../src/snippet.ts).

## Initialization options

Pass these options to `await useMicrosoftOpenTelemetry(options)`. Options are captured at startup;
there is no general runtime configuration-update API. Importing the package has no initialization
side effects. Initialize only in client-side code, before importing application code to instrument.

| Option                | Type                                          | Default and behavior                                                                                                                                                                                  |
| --------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `azureMonitor`        | `AzureMonitorOptions`                         | Omitted: no default Azure Monitor exporters. See [destination](#azure-monitor-destination).                                                                                                           |
| `resource`            | OpenTelemetry `Resource`                      | SDK defaults. Supplied attributes merge over defaults; use `service.name` and `service.version` to identify the application. Attributes resolve once; the resource schema URL is not carried through. |
| `samplingPercentage`  | `number`                                      | Omitted: parent-based always-on trace sampling and no percentage sampling of Azure Monitor logs. See [sampling](#sampling).                                                                           |
| `session`             | `MicrosoftOpenTelemetryBrowserSessionOptions` | Enabled and persisted, with 30-minute inactivity expiry and 24-hour maximum lifetime.                                                                                                                 |
| `userContext`         | `{ enabled?: boolean }`                       | Enabled: managed anonymous identity and authenticated identity set through the handle persist in same-origin storage.                                                                                 |
| `traces`              | `MicrosoftOpenTelemetryBrowserTraceOptions`   | Synchronous context tracking, W3C Trace Context and Baggage propagation.                                                                                                                              |
| `spanProcessors`      | `SpanProcessor[]`                             | Additional trace processors. Azure Monitor prepends its default when configured, unless `[]` disables traces. Without Azure Monitor, only supplied processors export.                                 |
| `logRecordProcessors` | `LogRecordProcessor[]`                        | Additional log processors. Azure Monitor prepends its default when configured, unless `[]` disables logs. Without Azure Monitor, only supplied processors export.                                     |
| `instrumentations`    | `readonly BrowserInstrumentation[]`           | Empty. Pass instances returned by `getInstrumentations()` or compatible upstream instances. Built-in page views are configured separately.                                                            |
| `pageView`            | `PageViewInstrumentationConfig`               | Collection and page-operation correlation enabled. Requires a log pipeline to export page-view records.                                                                                               |

### Azure Monitor destination

| Option                          | Type               | Default and behavior                                                                                                                                          |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `azureMonitor.connectionString` | `string`, required | Application Insights connection string with a valid UUID `InstrumentationKey`. Supports explicit ingestion endpoints and cloud suffixes.                      |
| `azureMonitor.disableBeacon`    | `boolean`          | `false`. Set to `true` to disable the `sendBeacon` fallback when an unload keepalive request cannot be queued. This may reduce delivery when the page closes. |

Endpoints require HTTPS except for localhost or loopback IPs. Invalid endpoints warn and fall back
to suffix-derived or public-cloud endpoints; an invalid/missing instrumentation key fails startup.
Connection strings identify a destination and do not grant read access to the resource. They are
public browser configuration, not secrets. Built-in Entra ID token authentication is not supported.

When Azure Monitor is configured, its processor is added before non-empty custom processor lists
for each signal. They are independent processor branches, not a chain: filtering within the Azure
Monitor processor does not filter records received by custom processors. An explicit empty array
disables the entire signal, including Azure Monitor. Without Azure Monitor or custom processors,
no telemetry exports. See the [OTLP example](../README.md#otlp-and-custom-exporters)
and [OTLP sample](../samples/README.md#otlp-configuration); allow the browser origin through CORS and
never embed secrets in exporter headers.

Each handle owns its processors and instrumentations. Do not reuse those objects across handles.
Processor ownership transfers when provider startup begins, including failed startup. Construct
upstream fetch, XHR, console and navigation instances with `enabled: false`; the distribution binds
providers before enabling them. The helper already does this.

### Sampling

`samplingPercentage` must be finite and between `0` and `100`, inclusive. `0` drops sampled traces
and default Azure Monitor logs; `100` retains all eligible records. Omission preserves parent-based
trace decisions for explicit application parents. The default sampler treats the synthetic page
operation as a root for sampling, so another instance's page sampling decision does not control it.
With an explicit percentage, the decision is based on the trace ID, not the parent's sampled flag.

Explicit percentage sampling is deterministic by trace ID for spans and correlated Azure Monitor
logs. Uncorrelated Azure Monitor logs use random percentage sampling. Azure Monitor exports the
effective sample rate for retained records. Built-in page-view logs carry the page operation's
trace ID and are filtered by that ID in the default Azure Monitor percentage-sampling processor.

Custom trace processors receive the distribution's sampled spans. Custom log processors do **not**
automatically inherit Azure Monitor's log percentage filtering; supply any required log filtering
yourself. This includes built-in page-view logs: their operation's sampled flag does not itself
prevent emission to custom log processors. There is no `traces.sampler` option.

## Session and identity

### Session options

| Option                      | Type              | Default | Behavior                                                                              |
| --------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------- |
| `session.enabled`           | `boolean`         | `true`  | `false` disables managed sessions without accessing session storage.                  |
| `session.persist`           | `boolean`         | `true`  | `false` uses memory only, without reading or clearing stored sessions.                |
| `session.inactivityTimeout` | `number`, seconds | `1800`  | Time without managed-session telemetry before expiry. `0` disables inactivity expiry. |
| `session.maxDuration`       | `number`, seconds | `86400` | Maximum lifetime, including reloads. `0` means unlimited.                             |

Lifetimes must be finite and nonnegative. Managed `session.id` fills only an absent value: a
non-empty string supplied on the record or resource takes precedence. Azure Monitor prefers a
valid record-level ID over the resource ID. Inaccessible session storage falls back to memory.

### User identity options and controls

`userContext.enabled` defaults to `true`. Managed `enduser.pseudo.id` persists across page loads;
authenticated user and account IDs set through the returned handle also persist by default.
Explicit record/resource identity takes precedence over managed defaults. Spans are enriched when
they start and logs when emitted; later identity changes are not retroactive.

| Handle method                                                 | Behavior                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `userContext.setAuthenticatedUserContext(userId, accountId?)` | Sets `user.id` and optional `user.account.id`. Omitting the account clears the previous account. IDs must be non-empty strings.                              |
| `userContext.clearAuthenticatedUserContext()`                 | Clears this handle's authenticated identity and stored authentication. Anonymous identity may remain.                                                        |
| `userContext.setEnabled(enabled)`                             | Changes identity persistence and anonymous-ID enrichment, without clearing current in-memory authenticated identity. Disabling also removes stored identity. |

Storage is shared within the origin, but each active handle keeps its own state. Update every
active handle on sign-out. Scripts in the origin can read stored identity; do not use raw personal
information, tokens or secrets as IDs. Persistence writes/removals can throw: handle failures when
setting identity, changing persistence or signing out. These controls remain usable after shutdown.

For no managed session or identity storage access at initialization:

```typescript
const telemetry = await useMicrosoftOpenTelemetry({
  azureMonitor: { connectionString },
  session: { enabled: false },
  userContext: { enabled: false },
});
```

For memory-only session correlation, use `session: { persist: false }` instead. The two storage
controls are independent and do not disable telemetry collection. If consent must precede any
collection or network activity, defer initialization itself until consent is granted. Disabling
storage at startup does not erase previously stored values; identity removal is an explicit
`userContext.setEnabled(false)` operation.

## Page-view options

| Option                                   | Type                             | Default and behavior                                                                                                                          |
| ---------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pageView.enabled`                       | `boolean`                        | `true`. `false` disables both built-in collection and its operation-correlation fallback; it does not remove code from bundles.               |
| `pageView.routeResolver`                 | `() => string \| undefined`      | Unset. Return a route pattern such as `/orders/:id`, not a concrete customer URL. Called when navigation is observed and again at settlement. |
| `pageView.redactedQueryParams`           | `readonly string[]`              | Built-in list below. A supplied list **replaces**, not extends, that list. Names are case-sensitive.                                          |
| `pageView.sanitizeUrl`                   | `(url: string) => string`        | Unset. Sanitizes the page URL and referrer after built-in redaction.                                                                          |
| `pageView.applyCustomLogRecordData`      | `(logRecord: LogRecord) => void` | Unset. Mutates the page-view log immediately before emission.                                                                                 |
| `pageView.softNavigationSettleTimeoutMs` | `number`, milliseconds           | `10000`. Upper bound for settling soft navigations before emitting a capped duration.                                                         |
| `pageView.useNavigationApiIfAvailable`   | `boolean`                        | `false`. Prefer the experimental Navigation API when present, otherwise use History-based observation.                                        |

Default sensitive parameter names are `sig`, `Signature`, `AWSAccessKeyId`, `X-Goog-Signature`,
`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, `code`, `token`, `access_token`,
`id_token`, `refresh_token`, `client_secret` and `password`. Matching query and fragment parameter
values become `REDACTED`. URL username/password credentials are always redacted.

To extend protection without replacing the defaults, leave `redactedQueryParams` unset and add
application-specific redaction in `sanitizeUrl`. Page-view redaction does not automatically sanitize
fetch/XHR, navigation, timing or exception URLs. Configure each instrumentation appropriately and
review the payload before enabling it.

The default name falls back from the route resolver to `document.title`, then `location.pathname`.
Use route patterns for aggregation. Soft-navigation duration is a heuristic, not a document-load
measurement. Pending page views are finalized when hidden, including tab switches; returning to a
visible tab does not itself start another page view. See [duration sources](event-catalogue.md#page-view-duration-sources).

## Browser instrumentation options

Import `getInstrumentations` from `@microsoft/opentelemetry-browser/instrumentations`, await it, and
pass the returned array as `instrumentations`. Calling the helper is opt-in: without it, fetch and
XHR are not installed automatically. Its options use the upstream configuration types from
`@opentelemetry/browser-instrumentation` **0.8.1**; do not confuse them with the initialization
object or loader configuration.

| Helper key         | Constructed by default | Settings beyond `enabled`                                                                                                       |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`            | Yes                    | `ignoreUrls`, `propagateTraceHeaderCorsUrls`, `measureRequestSize`, `sanitizeUrl`, `requestHook`, `applyCustomAttributesOnSpan` |
| `xhr`              | Yes                    | `ignoreUrls`, `propagateTraceHeaderCorsUrls`, `measureRequestSize`, `sanitizeUrl`, `applyCustomAttributesOnSpan`                |
| `console`          | No                     | `logMethods`, `messageSerializer`                                                                                               |
| `errors`           | No                     | `applyCustomAttributes`                                                                                                         |
| `navigation`       | No                     | `useNavigationApiIfAvailable`, `sanitizeUrl`, `applyCustomLogRecordData`                                                        |
| `navigationTiming` | No                     | None                                                                                                                            |
| `resourceTiming`   | No                     | `initiatorTypes`, `ignoreUrls`, `batchSize`, `maxQueueSize`, `forceProcessingAfter`, `maxProcessingTime`                        |
| `userAction`       | No                     | `autoCapturedActions`, `applyCustomLogRecordData`                                                                               |
| `webVitals`        | No                     | `includeRawAttribution`, `applyCustomLogRecordData`                                                                             |

- `enabled` is a boolean. Fetch/XHR are constructed unless `false`; other modules require `true`.
  All returned instances are initially inert; registration enables them after provider binding.
- URL filters and cross-origin propagation lists accept arrays of strings or `RegExp` objects.
  `sanitizeUrl` maps a URL string to a string. Request-size measurement is off unless enabled.
  Same-origin trace propagation is supported; cross-origin propagation requires an allowed URL
  and server CORS permission for the propagation headers. Fetch/XHR require a trace pipeline.
- Fetch's `requestHook(span, request)` runs before sending; its attribute hook receives
  `(span, request, result)`. XHR's attribute hook receives `(span, xhr)`. Errors'
  `applyCustomAttributes(error)` returns additional attributes. Log-record hooks mutate a record.
- Console captures `log`, `warn`, `error`, `info` and `debug` unless `logMethods` narrows the list.
  `messageSerializer(args)` controls the message body. Avoid collecting sensitive console output.
- Navigation's `useNavigationApiIfAvailable` defaults to `false`. Prefer built-in page views:
  enabling both produces separate records that Azure Monitor maps to page views.
- The distribution limits resource timing to `initiatorTypes: ["script", "link", "css"]` and
  `maxQueueSize: 256`, unless overridden. Other upstream defaults are `batchSize: 50`,
  `forceProcessingAfter: 1000` ms and `maxProcessingTime: 50` ms.
- User actions currently capture `click` by default; `autoCapturedActions` selects actions.
  Review CSS selectors and `data-otel-*` element attributes for sensitive content.
- Web Vitals `includeRawAttribution` defaults to `false`; enabling it includes attribution JSON in
  the log body. Availability depends on browser performance APIs and user activity.

## Context, propagation and lifecycle

`traces.contextManager` accepts an OpenTelemetry `ContextManager`. The default synchronous manager
does not preserve active context across unbound async continuations. See the
[explicit-context example](../README.md#known-beta-limitations).

`traces.propagators` accepts a readonly array of `TextMapPropagator`. Omit it for W3C Trace Context
and Baggage, or supply `[]` to disable propagation when this distribution owns the registration.
Global context and propagation are page-lifetime registrations, not per-handle isolation. The first
active trace instance supplies the owned context delegate; later propagator options are unused.
Application-registered context managers are not disabled by shutdown. Page-view instances share one
operation per navigation, while explicit application span contexts take precedence.

Global tracer/logger acquisition binds to the selected instance; shutdown does not reroute already
acquired objects into another instance. Newly acquired objects use the earliest remaining instance
that collects that signal. Share OpenTelemetry API packages as singletons in module-federated apps,
or acquire tracers/loggers after initialization. Iframes and workers have independent realm state.

| Handle method  | Behavior                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `forceFlush()` | Flushes this instance. Concurrent calls share a promise; once shutdown starts, returns its promise. Each processor gets 30 seconds; timeout does not cancel an in-flight export.                                               |
| `shutdown()`   | Rejects new telemetry, stops collection, waits for active flushes and shuts down this instance's providers. Repeated calls return the same promise. Each processor shutdown gets 30 seconds; cleanup continues after failures. |

Both methods return `Promise<void>` and can reject; multiple failures are reported with
`AggregateError`. Other instances keep running after one handle shuts down. Automatic flushing on
page hide/hidden visibility is best effort, not offline persistence or guaranteed delivery.

## CDN loader configuration

`getSdkLoaderScript()` is exported from the ESM-only `@microsoft/opentelemetry-browser/snippet` entry.
It generates a script; it does not itself initialize telemetry in the current page.

| Option                                                                       | Default and behavior                                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `connectionString`                                                           | Required non-empty string; becomes `cfg.azureMonitor.connectionString`.                                                      |
| `src`                                                                        | This package version's immutable CDN IIFE URL. Custom URLs must expose `Microsoft.OpenTelemetry` as a classic script global. |
| `crossOrigin`                                                                | `"anonymous"`. Applied to the injected script.                                                                               |
| `integrity`                                                                  | Unset. Supply integrity metadata for the exact version and artifact.                                                         |
| `loadDelay`                                                                  | Immediate injection. A nonnegative delay in milliseconds adds nonblocking delayed loading.                                   |
| `cdnFallback`                                                                | `false`. Retry backup Azure Monitor CDN hosts; requires a recognized CDN source URL.                                         |
| `reportLoadFailure`                                                          | `false`. Report an `SDKLoadFailed` exception after bundle load attempts fail.                                                |
| `samplingPercentage`, `azureMonitor.disableBeacon`, `session`, `userContext` | Same meanings as initialization options above.                                                                               |
| `pageView`                                                                   | Data-only settings: `enabled`, `redactedQueryParams`, `softNavigationSettleTimeoutMs`, `useNavigationApiIfAvailable`.        |
| `instrumentationOptions`                                                     | JSON-only helper settings. Omitted: fetch/XHR defaults.                                                                      |
| `resourceAttributes`                                                         | String, number or boolean attributes converted into a resource by the bundle.                                                |

The generator accepts JSON-serializable settings, not functions or regular expressions. Processors,
exporters, context managers, propagators and resource detectors require npm-based initialization.
The generated configuration's `cfg` holds initialization options; `instrumentationOptions` and
`resourceAttributes` are siblings of `cfg`. See [Packaging](packaging.md#cdn-and-loader-snippet) for
the snippet, CSP, fallback hosts, integrity manifests and failure handling.
