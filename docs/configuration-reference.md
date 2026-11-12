# Beta configuration reference

This reference describes `@microsoft/opentelemetry-browser` **0.1.0-beta.2**, plus explicitly marked
unreleased additions. Start with the [getting-started guide](../README.md#getting-started), and consult the
[event catalogue](event-catalogue.md) for emitted data. The public TypeScript contracts are in
[distribution types](../src/types.ts), [page-view options](../src/instrumentation/pageView/types.ts)
and [loader options](../src/snippet.ts).

For ApplicationInsights-JS applications, see the [migration guide](../APPINSIGHTS_MIGRATION.md)
for API replacements, intentional exclusions and current gaps.

## Initialization options

Pass these options to `await useMicrosoftOpenTelemetry(options)`. Options are captured at startup;
the [runtime update API](#runtime-configuration-updates) can change sampling, session lifetimes,
Azure Monitor beacon fallback policy and registered fetch/XHR collection gates. The handle also
supports [pause/resume for supported instrumentations](#runtime-instrumentation-controls). Other
options remain startup-only. Importing the package has no initialization side effects. Initialize
only in client-side code, before importing application code to instrument.

| Option                | Type                                            | Default and behavior                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `azureMonitor`        | `AzureMonitorOptions`                           | Omitted: no default Azure Monitor exporters. See [destination](#azure-monitor-destination).                                                                                                                               |
| `resource`            | OpenTelemetry `Resource`                        | SDK defaults. Supplied attributes merge over defaults; use `service.name` and `service.version` to identify the application. Attributes resolve once; the resource schema URL is not carried through.                     |
| `samplingPercentage`  | `number`                                        | Omitted: parent-based always-on trace sampling and no percentage sampling of Azure Monitor logs. See [sampling](#sampling).                                                                                               |
| `session`             | `MicrosoftOpenTelemetryBrowserSessionOptions`   | Enabled and persisted, with 30-minute inactivity expiry and 24-hour maximum lifetime.                                                                                                                                     |
| `sessionRenewalMs`    | `number`, milliseconds                          | Application Insights alias for `session.inactivityTimeout`. Default: `1800000` (30 minutes); `0` restores this default. See [session options](#session-options).                                                          |
| `sessionExpirationMs` | `number`, milliseconds                          | Application Insights alias for `session.maxDuration`. Default: `86400000` (24 hours); `0` restores this default. See [session options](#session-options).                                                                 |
| `storage`             | `{ enabled?: boolean; namePrefix?: string }`    | Enabled, with unprefixed keys. See [browser storage](#browser-storage).                                                                                                                                                   |
| `cookieCfg`           | `MicrosoftOpenTelemetryBrowserCookieConfig`     | Enabled independently of Web Storage. See [cookie configuration](#cookie-configuration-and-controls).                                                                                                                     |
| `userContext`         | `{ enabled?: boolean }`                         | Enabled: managed anonymous identity persists in a cookie; authenticated identity is memory-only unless explicitly opted into a cookie.                                                                                    |
| `traces`              | `MicrosoftOpenTelemetryBrowserTraceOptions`     | Synchronous context tracking, W3C Trace Context and Baggage propagation.                                                                                                                                                  |
| `spanProcessors`      | `SpanProcessor[]`                               | Additional trace processors. They run before the Azure Monitor default when configured, unless `[]` disables traces. Without Azure Monitor, only supplied processors export. See [enrichment](#enrichment-and-filtering). |
| `logRecordProcessors` | `LogRecordProcessor[]`                          | Additional log processors. They run before the Azure Monitor default when configured, unless `[]` disables logs. Without Azure Monitor, only supplied processors export. See [enrichment](#enrichment-and-filtering).     |
| `instrumentations`    | `readonly BrowserInstrumentation[]`             | Empty. Pass instances returned by `getInstrumentations()` or compatible upstream instances. Built-in page views are configured separately.                                                                                |
| `pageView`            | `PageViewInstrumentationConfig`                 | Collection and page-operation correlation enabled. Requires a log pipeline to export page-view records.                                                                                                                   |
| `expCfg`              | `MicrosoftOpenTelemetryBrowserExceptionOptions` | Omitted: no exception attachments. Opt in to script URLs and application-supplied recent logs. See [exception attachments](#exception-attachments).                                                                       |
| `redactQueryParams`   | `readonly string[]`                             | Additional sensitive parameter names for fetch/XHR and page-view URLs/referrers. Extends built-in protection. See [URL redaction](#url-redaction).                                                                        |

### Exception attachments

`expCfg` is startup-only and follows the ApplicationInsights-JS names:

| Option               | Default and behavior                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `expCfg.inclScripts` | `false`. Attach `exceptionScripts`, a JSON array of external HTTP(S) script data currently in the document. Inspect at most the first 100 script elements. Inline code, data/blob URLs and URLs longer than 8192 characters are excluded. This is a document snapshot, not proof that each script finished loading; removed scripts and module imports without script elements are not included. |
| `expCfg.expLog`      | Omitted. Synchronous callback returning `{ logs: readonly string[] }`, most recent first. The first `maxLogs` entries become the newline-separated `exceptionLog` attribute. The SDK does not intercept console calls or keep a log history.                                                                                                                                                     |
| `expCfg.maxLogs`     | `50`. Nonnegative safe integer; `0` disables log attachment without calling `expLog`.                                                                                                                                                                                                                                                                                                            |

Script entries follow the ApplicationInsights-JS object shape: `url`, plus `crossOrigin` and
`referrerPolicy` when their attributes are nonempty, and `async: true` and `defer: true` when those
boolean attributes are present. Absent or empty optional fields are omitted. Unlike the legacy
collector, URLs are resolved to absolute HTTP(S) URLs and redacted before export; script metadata
also counts toward the 8 KiB attachment limit. Entries with optional metadata values longer than
8192 characters are excluded.

Attachments are added before application log processors' `onEmit` and span processors' `onEnd`
to exception logs (`eventName: "exception"` or a truthy `exception.type`) and to `exception` span
events when the span ends. Each event gets a fresh snapshot at span end, not at `recordException()`
time. Both attributes are portable to OTLP and map to Azure Monitor exception custom properties.
Existing application attributes win;
application processors can remove or replace managed attachments. Enrichment never enables a
disabled signal or error instrumentation.

Each attachment is capped at **8 KiB UTF-8**. Script collection stops before exceeding its JSON
budget; the array remains valid JSON. Logs may be truncated within the last retained entry without
splitting a Unicode character. Azure Monitor's existing unload fitting may discard these optional
custom properties to preserve core exception data. The SDK's attribute count limits still apply;
attachments that do not fit are dropped, preserving application attributes.

Script URLs use built-in credential/signing/OAuth redaction and additional `redactQueryParams`.
Script paths and other parameters may still contain sensitive data. **Log text is not redacted**:
provide only entries safe to export, without secrets or personal data. The callback owns its log
history and should keep it bounded. Throwing callbacks, malformed snapshots and inaccessible DOM
data do not prevent exception export. Asynchronous snapshots are ignored and their rejections
consumed. Reentrant exceptions skip attachments; callbacks stop when the owning instance shuts down.
Disabled browser storage does not disable these in-memory
attachments. The generated CDN loader does not accept `expCfg`; npm and direct bundle
initialization do.

### Azure Monitor destination

| Option                           | Type                                  | Default and behavior                                                                                                                                                                |
| -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `azureMonitor.connectionString`  | `string \| Promise<string>`, required | Application Insights connection string with a valid UUID `InstrumentationKey`. Supports explicit ingestion endpoints and cloud suffixes.                                            |
| `azureMonitor.initTimeOut`       | `number`                              | `50000` ms. Maximum promise wait. Must be finite, nonnegative, and at most `2147483647`. Zero expires immediately.                                                                  |
| `azureMonitor.initInMemoMaxSize` | `number`                              | `100` items. Maximum completed spans and emitted logs buffered together while waiting. Must be a nonnegative safe integer. Zero disables startup buffering.                         |
| `azureMonitor.disableBeacon`     | `boolean`                             | `false`. Set to `true` to disable only the unload `sendBeacon` fallback. Keepalive fetch remains first; regular fetch is unaffected. This may reduce delivery when the page closes. |

At initialization, configure beacon fallback through `azureMonitor.disableBeacon`. The root
`onunloadDisableBeacon` alias is supported only through `updateCfg`, not as an initialization or
loader option. Both runtime spellings accept booleans or explicit `undefined`, restoring `false`;
the startup native option remains an optional `boolean` for strict TypeScript consumers. Values
are not coerced to booleans. Supplying both native and alias values in one runtime update is accepted
only when their normalized values match. An explicitly supplied own `undefined` normalizes to
`false` for this comparison. Conflicts reject the whole runtime update without partial changes.

Endpoints require HTTPS except for localhost or loopback IPs. Invalid endpoints warn and fall back
to suffix-derived or public-cloud endpoints; an invalid/missing instrumentation key in a synchronous
string fails startup.
Connection strings identify a destination and do not grant read access to the resource. They are
public browser configuration, not secrets. Built-in Entra ID token authentication is not supported.

Unsent Azure Monitor telemetry is buffered in `sessionStorage` and sent first by the next page load
in the same tab. The buffer covers telemetry that is in flight when the page goes away, does not
fit the unload beacon, or fails with a retriable error; after a partial response only the
outstanding retriable envelopes stay buffered. Records are keyed by connection string and
exporter, kept until ingestion accepts or permanently rejects them or the browser takes an unload
request, and adopted only once after the page that wrote them fires `pagehide`, so hidden but
live pages and same-origin frames never send each other's telemetry. Each exporter keeps at most
512 KiB of characters and drops items older than one hour; unavailable or full storage only logs
a diagnostic warning. `storage.enabled: false` disables the buffer and `storage.namePrefix`
prefixes its keys. Requests interrupted after ingestion received them can be sent again. Custom
span and log processors are not buffered, and the buffer does not survive closing the tab.

#### Asynchronous connection strings

Pass a `Promise<string>` when the destination is loaded asynchronously:

```typescript
const telemetry = await useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString: fetch("/telemetry-config").then((response) => {
      if (!response.ok) throw new Error("Telemetry configuration unavailable");
      return response.text();
    }),
    initTimeOut: 50000,
    initInMemoMaxSize: 100,
  },
});
```

Awaiting `useMicrosoftOpenTelemetry()` means collection is ready; it does not wait for the
connection string. Only the Azure Monitor branches buffer while the destination is pending.
Custom processors continue receiving telemetry immediately. The queue belongs to the handle and
counts items, not bytes, across both signals before normal batching. It is not persisted.
Overflow drops new items and emits one diagnostic. A valid resolution releases retained items
in arrival order into the normal batch processors; normal batching and sampling still apply.

Timeout, rejection, or an invalid resolved string clears the queue, emits a diagnostic without
including the connection string or rejection reason, and stops Azure Monitor delivery for that
handle. Late resolution is ignored. Other handles and custom destinations are unaffected.
The two initialization limits apply only when the connection string is asynchronous.

While pending, `forceFlush()` and page-hide flushes do not wait for the promise and do not discard
the startup queue. They cannot send its contents until the destination is known. Call `forceFlush()`
again after resolution if immediate delivery is needed. Shutdown cancels pending startup and
discards buffered items; it does not wait for the connection-string promise.

Standalone `AzureMonitorSpanExporter` and `AzureMonitorLogRecordExporter` still require an
already-resolved string. Startup buffering is owned by the distribution, not the exporters.

When Azure Monitor is configured, its processor is added after non-empty custom processor lists
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

### Customer SDK Stats (npm only)

Set `azureMonitor.sdkStats: { enabled: true }` to opt into customer item delivery counters.
`collectionIntervalMillis` defaults to `900000` (15 minutes) and must be an integer from `1` through
`2147483647`. These startup-only settings also work on standalone Azure Monitor exporters.
Reports bypass application pipelines and are best effort; they are not a durable delivery ledger.
Client-side sampling and queue overflow are not counted. Retryable report counts remain in memory
for the next attempt, not across page loads.

Customer reporting is disabled by default and excluded from CDN bundles, which reject the option.
It is separate from internal exporter network health statistics.

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

### Runtime configuration updates

The returned handle exposes `updateCfg(patch, mergeExisting = true)`, accepting
`MicrosoftOpenTelemetryBrowserConfigurationUpdate` and returning
`Promise<MicrosoftOpenTelemetryBrowserConfigurationUpdateResult>`. Supported paths are
`samplingPercentage`, `session.inactivityTimeout`, `session.maxDuration` and
`azureMonitor.disableBeacon`, plus the exact root aliases `sessionRenewalMs`, `sessionExpirationMs`
and `onunloadDisableBeacon`, followed by the root collection gates `disableFetchTracking` and
`disableAjaxTracking`. Only the session aliases also work at npm initialization; see
[session options](#session-options) and [destination](#azure-monitor-destination) for defaults and
conflict handling. The runtime Azure Monitor patch is limited to
`azureMonitor?: { disableBeacon?: boolean | undefined } | undefined`.

- Merge mode (the default) preserves omitted fields, including nested session and Azure Monitor
  fields. `{ session: {} }` and `{ azureMonitor: {} }` are no-ops.
- Explicit `samplingPercentage: undefined` restores parent-based trace sampling and removes Azure
  Monitor log percentage filtering, not the startup percentage or numeric `100`.
- An explicit `undefined` native lifetime or alias resets that lifetime to its native default:
  30 minutes for inactivity, 24 hours for maximum duration. `session: undefined` resets both
  lifetimes without changing sampling.
- Explicit `azureMonitor.disableBeacon: undefined`, `azureMonitor: undefined` or
  `onunloadDisableBeacon: undefined` resets beacon policy to `false`, not to the startup value.
  These resets participate in native/alias conflict checks; they do not disable the destination.
- `disableFetchTracking` and `disableAjaxTracking` accept only booleans or explicit `undefined`.
  Both default to `false`; explicit `undefined` resets the corresponding gate to `false`.
  They are runtime-only root options, not initialization or CDN loader flags.
- Passing `false` as the second argument replaces **only the supported runtime subset**. All
  omitted sampling, lifetime, beacon and collection-gate fields reset to their defaults, including
  omitted nested fields; destinations and other startup-only options are unchanged.

The frozen result contains readonly `revision` and `changedPaths`. A commit changing any supported
value increments the per-instance revision once. Changed paths use canonical names in this order:
`samplingPercentage`, `session.inactivityTimeout`, `session.maxDuration`, `azureMonitor.disableBeacon`,
`disableFetchTracking`, `disableAjaxTracking`, even when aliases are used. No-op updates retain the
revision and return `[]` for `changedPaths`.

Sampling changes affect subsequent span starts, default Azure Monitor log emissions and new page
operations. Existing span/page decisions and queued logs are not resampled. A later correlated log
can use a newer policy than its span; custom log processors still need their own filtering.

Session policy changes do not immediately rotate the ID, send telemetry or network requests,
access or reset storage, replace providers, or refresh the session's start or last-activity timestamp.
The next span start or log emission needing a managed session ID checks the new policy against
those timestamps. Shortening a lifetime rotates the ID on that next managed activity if expiry is
already due; extending or disabling a check can keep the current ID. Persisted session expiry is
checked against the configured startup lifetime policy during restore. Application-supplied
record/resource session attributes still take precedence.

Azure Monitor senders read the committed per-instance beacon policy at each fallback attempt,
including for already queued telemetry and when a keepalive request pending during an update
later fails. Updates do not cancel or switch an already dispatched request. Keepalive fetch stays
first, regular fetch is unaffected, and shared keepalive capacity, payload limits, retries and SDK
stats behavior are unchanged. A policy update sends no network request, recreates no destination
or provider, and cannot create an Azure Monitor destination if none was configured. Custom
exporters and standalone exporter options are unaffected.

Setting `disableFetchTracking: true` or `disableAjaxTracking: true` pauses collection for **all**
registered matching fetch or XHR entries in this instance, including repeated entries. Setting a
gate to `false` permits collection only for entries whose requested enabled state is still `true`;
it does not undo a manual `instrumentations.setEnabled(id, false)` pause. These gates do not import,
construct or register missing modules, enable a disabled trace pipeline, or change another
instance's collection. They do not cancel requests or undo injected headers. Already-sent fetch/XHR
requests can still finish; an XHR opened before a pause must be opened again after resume before
its send can be collected. See [runtime instrumentation controls](#runtime-instrumentation-controls).

Providers and acquired tracers/loggers remain bound to the same instance. Updates serialize per
instance with `instrumentations.setEnabled()`, and configuration input is validated and captured
before queueing. Invalid values, accessors, non-plain objects, unsupported paths and conflicting
native/alias values reject without changing configuration or revision. Gate transitions apply
before the new configuration and revision are published. Lifecycle failures reject the operation
and attempt best-effort rollback; if cleanup or rollback leaves instrumentation state uncertain,
further runtime mutations reject until shutdown. This is not universal atomicity for browser events
or in-flight work: observed events and injected headers cannot be undone. Queued and new mutations
reject once shutdown starts.

```typescript
const result = await telemetry.updateCfg({ sessionRenewalMs: 60000 });
// If changed, result.changedPaths is ["session.inactivityTimeout"].
await telemetry.updateCfg({ session: { maxDuration: 0 } }); // Keep inactivity; disable maximum expiry.
await telemetry.updateCfg({ sessionRenewalMs: undefined }); // Reset inactivity to 30 minutes.
await telemetry.updateCfg({ session: undefined }); // Reset both lifetimes; keep sampling.
await telemetry.updateCfg({ azureMonitor: { disableBeacon: true } }); // Disable only beacon fallback.
await telemetry.updateCfg({ onunloadDisableBeacon: false }); // Re-enable fallback.
await telemetry.updateCfg({ azureMonitor: { disableBeacon: undefined } }); // Reset beacon to false.
await telemetry.updateCfg({ azureMonitor: undefined }); // Reset beacon, not the destination.
await telemetry.updateCfg({ disableFetchTracking: true, disableAjaxTracking: true });
await telemetry.updateCfg({ disableFetchTracking: undefined }); // Reset only the fetch gate to false.
await telemetry.updateCfg({}, false); // Reset runtime policies, including both gates; keep destinations.
```

`session.enabled`, `session.persist` and browser storage flags are not runtime-updateable. Lifetime
updates cannot enable a disabled session or change persistence; `storage.enabled` and
`storage.namePrefix` remain unchanged. Only sampling, session lifetimes and Azure Monitor beacon
fallback policy, plus the two fetch/XHR collection gates, are supported by `updateCfg`.
Instrumentation pause/resume and supported add/remove/replace operations use the separate handle
controls below. The runtime `azureMonitor` subset does not accept `connectionString`, `initTimeOut`
or `initInMemoMaxSize`, and cannot replace or disable a destination. There is no root
`connectionString` alias.

### Optional configuration synchronization

`extensionConfig.AppInsightsCfgSyncPlugin` is a startup-only option for synchronizing a narrow
runtime subset between SDK instances in the **same JavaScript realm**, or for downloading that
subset from one explicitly configured trusted HTTP(S) endpoint. It is not accepted by the CDN
loader. Event synchronization uses `CustomEvent` on `globalThis`, not storage, tabs, iframes or
workers; those contexts have independent realm state.

The HTTP-specific options below (`cfgUrl`, `blkCdnCfg`, `scheduleFetchTimeout`, `requestTimeoutMs`)
are **unreleased**. They are not available in `0.1.0-beta.2`; see
[HTTP synchronization](#http-synchronization-unreleased).

| Option                 | Default and behavior                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin options object  | Omitted: synchronization is not configured. When configured, the handle exposes `configSync` with `sync(): Promise<void>`, `pause()`, `resume()`, and `shutdown()`.                                                                               |
| `syncMode`             | `2` (receive only). `0` disables event and HTTP work, `1` broadcasts event snapshots and forwards downloaded fields through the event channel without local application, and `2` applies event or downloaded fields locally without echoing them. |
| `customEvtName`        | `"ai_cfgsync"`. This event name is the channel; use a different name to isolate participants.                                                                                                                                                     |
| `cfgUrl`               | Empty or omitted: no HTTP request and no Microsoft feed. Otherwise, a URL is resolved once at startup and must be credential-free HTTP(S). Its fragment is discarded.                                                                             |
| `blkCdnCfg`            | `false`. `true` blocks HTTP downloads even when `cfgUrl` is set; event reception and existing local synchronization state remain available.                                                                                                       |
| `scheduleFetchTimeout` | `1800000` milliseconds. Positive values schedule the next download after the prior request completes. `0` permits only the initial automatic attempt and manual `sync()` calls. Values must be finite numbers from `0` through `2147483647`.      |
| `requestTimeoutMs`     | `10000` milliseconds. Covers the complete fetch and body read. Must be finite and greater than `0`, up to `2147483647`.                                                                                                                           |
| `nonOverrideConfigs`   | Optional map for `samplingPercentage`, `disableFetchTracking`, and `disableAjaxTracking`. `true` excludes a field from publishing and receiving; `false` cannot widen the allowlist. Unknown keys reject startup.                                 |
| `onError`              | Optional `(error: unknown) => void` callback for asynchronous download and receive failures. Thrown errors and rejected returns are isolated.                                                                                                     |

Synchronization starts only after an explicit `AppInsightsCfgSyncPlugin` object is supplied, including `{}`.
Startup configuration establishes local precedence: an actual startup sampling value, including an
own `undefined` or inherited numeric value, protects sampling from received updates. A successful
local `updateCfg` permanently protects each field it supplies, including no-op updates and explicit
resets; `updateCfg(patch, false)` protects all three synchronizable fields. Failed local updates
do not create a protection. There is no API to release a protection.

Only `samplingPercentage` (a finite value from `0` through `100`, or an explicit `undefined` reset
in JavaScript events), `disableFetchTracking`, and
`disableAjaxTracking` may cross the channel or download boundary. The latter two accept only
booleans. The SDK rejects unknown fields and session, beacon, identity, destination,
instrumentation, state, and HTTP-related settings. It validates the whole received payload before
applying local-precedence locks or allow-list filtering. This intentionally strict subset is not
compatible with a full Application Insights configuration object or full plugin configuration.

An explicit local `updateCfg` remains local: it does not automatically publish, echo a received
update, replay a value on startup, or retain history. A broadcaster publishes a snapshot of every
allowed, non-excluded field, including an own `undefined` sampling reset, through:

```typescript
globalThis.dispatchEvent(new CustomEvent(channel, { detail: { cfg: patch } }));
```

For example, configure separate publisher and receiver instances on the same page:

```typescript
const publisher = await useMicrosoftOpenTelemetry({
  extensionConfig: { AppInsightsCfgSyncPlugin: { syncMode: 1, customEvtName: "checkout-config" } },
});
const receiver = await useMicrosoftOpenTelemetry({
  extensionConfig: { AppInsightsCfgSyncPlugin: { customEvtName: "checkout-config" } },
});

await publisher.updateCfg({ samplingPercentage: 25 }); // Local only.
await publisher.configSync!.sync(); // Dispatch completion, not receiver acknowledgement.
await receiver.updateCfg({}); // Barrier for previously queued delivery on this receiver.
```

Receivers merge queued messages through the same `updateCfg` and instrumentation-mutation queue,
but each handle has an independent revision; there is no atomic cross-handle commit. `sync()`
resolves when dispatch is complete, not when recipients acknowledge or apply it. Receiver failures
call `onError`, do not roll back the publisher, and do not log payload contents.

### HTTP synchronization (unreleased)

HTTP synchronization is available in the repository source, but not in the published
`0.1.0-beta.2` package. That release supports same-realm event synchronization only.
For HTTP synchronization in a build containing this addition, provide one explicit endpoint:

```typescript
const telemetry = await useMicrosoftOpenTelemetry({
  extensionConfig: {
    AppInsightsCfgSyncPlugin: {
      cfgUrl: "https://config.example.com/telemetry.json",
      requestTimeoutMs: 10000,
      scheduleFetchTimeout: 1800000,
    },
  },
});
```

The endpoint returns this JSON envelope. `enabled` accepts a boolean, a finite number, or a string;
its JavaScript truthiness controls whether the validated `config` is applied. `version`, when
present, is a string or finite number and is otherwise ignored. A disabled envelope is still
validated when it contains `config`.

```json
{
  "enabled": true,
  "config": {
    "samplingPercentage": 25,
    "disableFetchTracking": false,
    "disableAjaxTracking": false
  },
  "version": "2026-11-03"
}
```

The response body is limited to 65536 bytes, must be valid JSON, and must be structurally flat:
only the envelope and allowlisted scalar config fields are supported. Nested objects and arrays are
rejected. The deadline covers both fetch and reading the body. Requests use `credentials: "omit"`,
`redirect: "error"`, `referrerPolicy: "no-referrer"`, and `cache: "no-store"`. Downloads bypass
the SDK-managed fetch observers; resource-timing records for exact configuration URLs are also
excluded from distribution pipelines. Active URLs and at most 256 recent destinations are retained
realm-wide for delayed resource timings. Earlier SDK versions and independently managed
instrumentations do not consult this resource-timing exclusion; configure their `ignoreUrls` if
they run alongside this adapter. Application transport wrappers remain the application's responsibility.

The initial download runs automatically only when HTTP is configured. Concurrent manual `sync()`
downloads coalesce and reject their callers on failure; automatic failures call `onError`. Polling
stops after three consecutive failures and `resume()` restarts it. `pause()` aborts an active
download, clears polling, and invalidates queued delivery without reverting committed values.
`resume()` starts a fresh request after a pause, even with a zero polling interval.
`shutdown()` performs the same cancellation terminally and removes the event listener. Initialization
stages the listener and removes it if startup fails before commit; telemetry shutdown also removes it.
If removal throws, shutdown attempts one bounded retry and still reports the original error.

Configuration synchronization does not block telemetry startup or `forceFlush()`. A same-realm
event channel is not an authentication boundary, and `cfgUrl` trust, CORS, and CSP are application
responsibilities. Do not treat either transport as confidential or use it for secrets.

## Session and identity

### Browser storage

| Option               | Type      | Default | Behavior                                                                                                                                                                                                                                                                    |
| -------------------- | --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.enabled`    | `boolean` | `true`  | `false` blocks SDK-managed Web Storage access for this handle, including the localStorage session backup, legacy identity cleanup, unsent telemetry buffer and page-visit persistence, not cookies. SPA visit timing then uses memory.                                      |
| `storage.namePrefix` | `string`  | `""`    | Literal prefix for cookie names `ai_user`, `ai_authUser` and `ai_session`, and session, legacy identity, unsent telemetry buffer and page-visit Web Storage keys. For example, `"shop-"` produces the `shop-ai_session` cookie and `shop-opentelemetry-session` backup key. |

Settings are captured at initialization and apply independently to each handle. A prefix namespaces
stored sessions and identities; it does not provide origin isolation or a security boundary. No data
is read, migrated or removed from other prefixes.
Prefixes must contain only cookie-name token characters; invalid prefixes are rejected before
browser persistence is accessed.

Like Application Insights JavaScript, persistence is cookie-first and enabled by default. There
are no legacy cookie configuration aliases (`cookieDomain`, `cookiePath`, `disableCookiesUsage`
or `isCookieUseDisabled`) or global storage switch (`isStorageUseDisabled`); use the per-instance
`cookieCfg` and `storage` options. Disabling either backend does not erase existing data, disable
telemetry collection or stop network requests. Custom processors/exporters must enforce their own
storage policy.

Anonymous identity and managed sessions use cookies by default; authenticated identity is
memory-only unless explicitly stored in a separate session cookie. localStorage provides session
backup/restoration and explicit cleanup of legacy identity records, not identity restoration.
Unsent Azure Monitor telemetry and opt-in page-visit state use sessionStorage.
`storage.enabled: false` blocks only Web Storage; `cookieCfg.enabled: false` independently disables
cookies. Also set `cookieCfg.disableCookieDefer: true` to discard disabled cookie operations instead
of queuing them. Unlike Web Storage, cookies are sent in HTTP headers to matching domains and
paths, subject to browser rules. Application Insights' `enableSessionStorageBuffer` corresponds to
the unsent telemetry buffer described under Azure Monitor, enabled here unless `storage.enabled`
is false.

Implementation references: Application Insights JavaScript's
[cookie manager](https://github.com/microsoft/ApplicationInsights-JS/blob/main/shared/AppInsightsCore/src/core/CookieMgr.ts),
[Web Storage helpers](https://github.com/microsoft/ApplicationInsights-JS/blob/main/shared/AppInsightsCore/src/utils/StorageHelperFuncs.ts)
and [send buffer](https://github.com/microsoft/ApplicationInsights-JS/blob/main/channels/applicationinsights-channel-js/src/SendBuffer.ts).

### Cookie configuration and controls

| Option                         | Type                                    | Default          | Behavior                                                                                                               |
| ------------------------------ | --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cookieCfg.enabled`            | `boolean`                               | `true`           | Allows cookie reads and writes independently of `storage.enabled`. When `false`, operations may be deferred in memory. |
| `cookieCfg.domain`             | `string`                                | Unset            | Host-only cookies when omitted. Set a domain to share cookies with matching subdomains, subject to browser rules.      |
| `cookieCfg.path`               | `string`                                | `"/"`            | Cookie scope path. Not a security boundary.                                                                            |
| `cookieCfg.ignoreCookies`      | `readonly string[]`                     | `[]`             | Exact cookie names never read or written; explicit deletion and purge remain allowed. Include any configured prefix.   |
| `cookieCfg.blockedCookies`     | `readonly string[]`                     | `[]`             | Exact cookie names never written; reads and explicit deletion remain allowed. Include any configured prefix.           |
| `cookieCfg.disableCookieDefer` | `boolean`                               | `false`          | `true` discards ordinary writes/deletes while disabled instead of queuing them.                                        |
| `cookieCfg.getCookie`          | `(name: string) => string`              | Browser read     | Override reads; return the already encoded value or `""` when absent. npm initialization only.                         |
| `cookieCfg.setCookie`          | `(name: string, value: string) => void` | Browser write    | Override writes; `value` includes the formatted cookie attributes. npm initialization only.                            |
| `cookieCfg.delCookie`          | `(name: string, value: string) => void` | Browser deletion | Override deletion; `value` includes expiry and scope attributes. npm initialization only.                              |

Call `telemetry.getCookieMgr()` to obtain this handle's cookie manager:

| Cookie manager method                          | Behavior                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isEnabled()`                                  | Returns whether this instance permits cookie access and cookies or hooks are available; not proof a write will persist.                                                                                                                                 |
| `setEnabled(enabled)`                          | Enables or disables cookie access. Enabling flushes deferred operations; disabling does not delete existing cookies.                                                                                                                                    |
| `get(name)`                                    | Returns the encoded value or `""`. While disabled, returns a pending value without reading browser cookies.                                                                                                                                             |
| `set(name, value, maxAgeSec?, domain?, path?)` | Accepts an already encoded value and optional lifetime in seconds; omit the lifetime for a session cookie. Scope defaults to `cookieCfg.domain` and `cookieCfg.path`. Returns `true` if accepted, including deferral, not verified browser persistence. |
| `del(name, path?)`                             | Deletes one named cookie using the configured domain and default or supplied path. Respects disablement and deferral.                                                                                                                                   |
| `purge(name, path?)`                           | Deletes one named cookie even while disabled and cancels its pending operation. Bypasses ignored/blocked lists; not a delete-all operation.                                                                                                             |

Deferral is enabled by default: while disabled, the manager retains only the latest operation per
cookie name, including its formatted attributes. `expires` is calculated when queued, not when
re-enabled; an already expired absolute deadline remains expired in the replayed operation. The
formatted operation, including `max-age` when present, is replayed unchanged and interpreted by the
browser. This queues cookie operations, not telemetry. Use `disableCookieDefer: true` when disabled
operations must be discarded rather than replayed. Shutdown discards pending operations.

Unlike Application Insights' raw-value attribute suffix convention, `set()` rejects semicolons and
control characters in values. Encode values first and pass domain/path as arguments, not suffixes.
On HTTPS, writes include `Secure` and `SameSite=None` for modern browsers; HTTP writes omit both.
Browser privacy policies can still prevent persistence. Hook/browser failures are caught so they do
not interrupt telemetry, and a successful return does not verify that the browser stored a cookie.

Deletion must match the cookie's domain and path. `del()` and `purge()` use the configured domain;
if `set()` overrides it, delete with a manager configured for that same domain and the matching path.
Changing configuration does not remove cookies in previous scopes. Cookie paths and name prefixes
are not security boundaries. Unlike localStorage, cookies are sent in HTTP headers to matching
endpoints and may be visible to servers and intermediaries as well as page scripts. A shared domain
broadens this exposure beyond a single origin. Do not store raw personal information, tokens or
secrets in identity values.

### Session options

| Option                      | Type              | Default | Behavior                                                                              |
| --------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------- |
| `session.enabled`           | `boolean`         | `true`  | `false` disables managed sessions without accessing session cookies or Web Storage.   |
| `session.persist`           | `boolean`         | `true`  | `false` uses memory only, without reading or clearing either persistence backend.     |
| `session.inactivityTimeout` | `number`, seconds | `1800`  | Time without managed-session telemetry before expiry. `0` disables inactivity expiry. |
| `session.maxDuration`       | `number`, seconds | `86400` | Maximum lifetime, including reloads. `0` means unlimited.                             |

Lifetimes must be finite and nonnegative. At initialization and in `updateCfg`, the root Application
Insights aliases `sessionRenewalMs` and `sessionExpirationMs` accept **milliseconds**, normalized to
`session.inactivityTimeout` and `session.maxDuration` in **seconds**. Native `0` disables the
corresponding expiry check; alias `0` or explicit `undefined` restores the corresponding default
(30 minutes or 24 hours), rather than disabling expiry.

Supplying a native lifetime and its alias in the same call is accepted only when their normalized
values are equal. For example, `session: { inactivityTimeout: 60 }` with `sessionRenewalMs: 60000`
is valid; `session: { inactivityTimeout: 0 }` with `sessionRenewalMs: 0` conflicts. A conflict fails
initialization or rejects the whole runtime update without partial changes. Separate updates may
replace a lifetime through either spelling.

Managed `session.id` fills only an absent value: a non-empty string supplied on the record or
resource takes precedence. Azure Monitor prefers a valid record-level ID over the resource ID.
Sessions use the prefixed `ai_session` cookie as the primary store, with Application Insights' raw
`id|startTimestampMs|lastActivityTimestampMs` format. Activity refreshes the cookie at most once
every 60 seconds, except a positive inactivity window of 60 seconds or less persists each
distinct activity timestamp. New sessions force a write, and rejected writes do not delay a later
retry. Cookie lifetime is bounded by the remaining maximum duration and inactivity window;
`maxDuration: 0` uses a browser-session cookie while managed inactivity expiry still applies.
Runtime lifetime updates do not access persistence; the next activity refreshes the cookie using
the new policy without waiting for the previous write throttle.

When Web Storage is enabled, the latest session is backed up as JSON under the unchanged prefixed
`opentelemetry-session` localStorage key on unload and
shutdown, not on each activity update. A missing cookie can restore a valid, unexpired backup,
including when cookies are disabled. A present malformed cookie does not fall back to the backup.
If neither backend is available, session correlation stays in memory.
During a transient cookie-read failure, a provisional in-memory session follows normal inactivity
and maximum expiry without writing cookies or backups. Recovery restores the authoritative cookie,
falls back to a valid backup when absent, or creates a fresh session when invalid.
When user context and anonymous-cookie reads are enabled, a missing or invalid anonymous-user cookie
invalidates the old session backup before restoration. Clearing user cookies therefore starts a
new managed session instead of reconnecting it to the previous identity's backup.

### User identity options and controls

`userContext.enabled` defaults to `true`. Managed `enduser.pseudo.id` persists across page loads in
the prefixed `ai_user` cookie with a one-year lifetime (31,536,000 seconds), using Application
Insights' raw `id|ISO-acquisition-timestamp` format. Authenticated
user and account IDs set through the returned handle are memory-only by default. Pass `true` as the
third setter argument to opt into the separate prefixed `ai_authUser` session cookie:
`telemetry.userContext.setAuthenticatedUserContext(userId, accountId, true)`. When enabled, user
context restores a valid authenticated cookie on initialization. User identity does not use Web Storage.

Authenticated cookies use `encodeURI(userId + optional '|' + accountId)` and are read with
`decodeURI()` before splitting. With `storage.namePrefix` omitted, valid default Application Insights
cookies retain identity and session continuity when switching SDKs within the same domain/path.
For customized names, match the complete cookie names: Application Insights appends
`userCookiePostfix` to `ai_user` and `sessionCookiePostfix` (or `namePrefix`) to `ai_session`, and
leaves `ai_authUser` unprefixed. This distribution instead prepends `storage.namePrefix` to all
three names, so setting the same prefix in both SDKs does not produce matching names.
Cookie values use the Application Insights formats, not URI-encoded JSON records.
Legacy anonymous Web Storage cleanup keeps the unchanged
prefixed `opentelemetry-user` key. Old `opentelemetry-*` cookie names are not restored. Auth cookies
are interpreted only as canonical strings, so JSON-shaped IDs remain literal IDs, not legacy records.
Concurrent SDKs sharing cookie names can update each other's persistence; use distinct
prefixes when continuity is not intended.

The public setter still accepts all non-empty user/account strings for memory identity. Cookie
persistence cannot roundtrip IDs containing `|`, and URI encoding can fail for unpaired UTF-16
surrogates. Semicolons left raw by `encodeURI()` are rejected by the cookie manager's header-safety
policy. These failures keep the new identity in memory and attempt to delete any superseded auth
cookie, just like a failed write. Use persistence-safe opaque IDs rather than personal information.
Unsafe session IDs can be restored from a JSON Web Storage backup, but are not written as raw cookie values.

Explicit record/resource identity takes precedence over managed defaults. Spans are enriched when
they start and logs when emitted; later identity changes are not retroactive.

| Handle method                                                                 | Behavior                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userContext.setAuthenticatedUserContext(userId, accountId?, storeInCookie?)` | Sets `user.id` and optional `user.account.id`. Omitting the account clears the previous account. IDs must be non-empty strings or a `TypeError` is thrown. `storeInCookie` defaults to `false`, removing any previous auth cookie while user context is enabled; `true` opts into a session cookie and may defer the write while cookie access is disabled. |
| `userContext.clearAuthenticatedUserContext()`                                 | Clears this handle's authenticated identity and deletes its auth cookie, honoring cookie disablement/deferral. Does not change anonymous identity.                                                                                                                                                                                                          |
| `userContext.setEnabled(enabled)`                                             | Changes identity persistence and anonymous-ID enrichment independently of `storage.enabled`, retaining in-memory authenticated identity. Disabling purges both identity cookies and pending writes even while cookie access is disabled. Re-enabling does not implicitly opt memory-only authentication into persistence.                                   |

Cookies are shared within their configured prefix, domain and path, but each active handle keeps
its own identity state. Update every active handle on sign-out. Starting with `userContext.enabled:
false` avoids identity persistence access without erasing existing cookies; an explicit
`userContext.setEnabled(false)` purges identity cookies. Identity controls remain callable after
shutdown for cleanup. Reads and writes stop at shutdown; deletion remains available for managers
that previously enabled cookie access, and explicit purge is always available.

For no SDK-managed browser persistence, disable both backends and discard deferred cookie operations:

```typescript
const telemetry = await useMicrosoftOpenTelemetry({
  azureMonitor: { connectionString },
  storage: { enabled: false },
  cookieCfg: { enabled: false, disableCookieDefer: true },
});
```

This retains memory-only session correlation and authenticated identity. For stronger feature-level
opt-outs, also set `session: { persist: false }` and `userContext: { enabled: false }` to avoid managed
session persistence and anonymous-ID enrichment even if cookie access is later enabled. To disable
managed sessions entirely, use `session: { enabled: false }`. For only memory-only sessions while
preserving user cookies, use `session: { persist: false }` alone.

Neither switch deletes existing values or stops collection or network requests. If consent must
precede any collection or network activity, defer initialization itself until consent is granted.
Cookie access can later be enabled with `telemetry.getCookieMgr().setEnabled(true)`; when deferral is
disabled, discarded operations are not replayed. Web Storage settings have no runtime toggle: shut
down and initialize a new handle to change `storage.enabled`.

## Page-view options

| Option                                   | Type                             | Default and behavior                                                                                                                                               |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pageView.enabled`                       | `boolean`                        | `true`. `false` disables both built-in collection and its operation-correlation fallback; it does not remove code from bundles.                                    |
| `pageView.autoTrackPageVisitTime`        | `boolean`                        | `false`. Emit a separate `browser.page_visit` log for the previous page when the next page view starts. Requires built-in page views and a log pipeline to export. |
| `pageView.routeResolver`                 | `() => string \| undefined`      | Unset. Return a route pattern such as `/orders/:id`, not a concrete customer URL. Called when navigation is observed and again at settlement.                      |
| `pageView.redactedQueryParams`           | `readonly string[]`              | Built-in list below. A supplied list **replaces**, not extends, that list. Names are case-sensitive.                                                               |
| `pageView.sanitizeUrl`                   | `(url: string) => string`        | Unset. Sanitizes the page URL and referrer after built-in redaction.                                                                                               |
| `pageView.applyCustomLogRecordData`      | `(logRecord: LogRecord) => void` | Unset. Mutates the page-view log immediately before emission.                                                                                                      |
| `pageView.softNavigationSettleTimeoutMs` | `number`, milliseconds           | `10000`. Upper bound for settling soft navigations before emitting a capped duration.                                                                              |
| `pageView.useNavigationApiIfAvailable`   | `boolean`                        | `false`. Prefer the experimental Navigation API when present, otherwise use History-based observation.                                                             |

Default sensitive parameter names are `sig`, `Signature`, `AWSAccessKeyId`, `X-Goog-Signature`,
`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, `code`, `token`, `access_token`,
`id_token`, `refresh_token`, `client_secret` and `password`. Matching query and fragment parameter
values become `REDACTED`. URL username/password credentials are always redacted.

The default name falls back from the route resolver to `document.title`, then `location.pathname`.
Use route patterns for aggregation. Soft-navigation duration is a heuristic, not a document-load
measurement. Pending page views are finalized when hidden, including tab switches; returning to a
visible tab does not itself start another page view. See [duration sources](event-catalogue.md#page-view-duration-sources).

### URL redaction

Use the root `redactQueryParams` option to extend the built-in parameter list for both fetch/XHR
dependency URLs and page-view URLs/referrers:

```typescript
await useMicrosoftOpenTelemetry({
  azureMonitor: { connectionString },
  redactQueryParams: ["customer_token"],
});
```

Fetch/XHR URLs have built-in redaction even when this option is omitted; it does not change the
outgoing request. `pageView.redactedQueryParams` affects only page views and replaces their defaults
when the root option is omitted. When the root option is supplied, the built-in, root and page-view
lists are combined for page views. `pageView.sanitizeUrl` can apply further page-specific redaction.
Navigation, timing and exception URLs, log bodies and arbitrary attributes are not covered by this
protection. Configure hooks or processors for those fields and review payloads before enabling them.

### Page visit time

Enable `pageView.autoTrackPageVisitTime` to measure elapsed milliseconds from the previous page-view
start to the next page-view start. This includes hidden time, not just active engagement, and is
separate from the page-view load/settle duration. The option defaults to `false`, so existing
applications emit no extra telemetry. The portable `browser.page_visit` log carries the previous
page's name, sanitized URL, page-view ID and elapsed duration; Azure Monitor maps it to the separate
`PageVisitTime` custom metric. See the [event schema](event-catalogue.md#page-visit-browserpage_visit).

SPA transitions use in-memory state. Full navigations on the same origin in the same tab use
`sessionStorage` to hand the previous visit to the next instrumented page, respecting
`storage.enabled` and `storage.namePrefix`. With no nonempty prefix, a string connection string
automatically isolates state by destination. A nonempty `storage.namePrefix` is the entire
destination identity for page-visit state, for both string and deferred connection strings. Dedicate
each explicit prefix to one destination and keep it consistent across pages; changing the connection
string's form does not change the visit namespace. Reusing a prefix for different destinations can
mix their visits.

Each namespace has instance slots. Multiple instances sharing a namespace must initialize in a
consistent order across pages so their slots match; use distinct `storage.namePrefix` values to
isolate them.
When storage is disabled or unavailable, timing falls back to in-memory SPA transitions only.
For a deferred Azure Monitor connection string, supply an explicit, destination-specific
`storage.namePrefix` to enable cross-document persistence before resolution. Without it, timing
stays in memory so an unknown destination cannot consume another destination's visit.

Child frames always keep page-visit timing in memory, even with an explicit prefix. Same-origin
frames share their parent's `sessionStorage`, but have independent instance slots; a prefix alone
cannot establish browsing-context ownership. Child frames therefore neither consume nor overwrite
the parent's visit state, and do not bridge full-document navigations. Their SPA visits still work.
This restriction applies to page-visit persistence, not other SDK-managed storage.

New tabs opened with `window.open()` can receive a copy of the opener's `sessionStorage`. Before
restoring visits, the SDK compares a stable storage-owner marker with the accessible same-origin
opener's marker. A matching copy loses only its page-visit entries and receives a new owner marker;
it does not report the opener's still-active visit. Later same-tab navigations and reloads in the
popup retain persistence, even if its opener has navigated. Application storage and `window.name`
are not changed. If the opener is already closed or cross-origin before the popup first initializes
tracking, the SDK cannot compare their markers and identify the copied state.

No visit log or metric is emitted on `pagehide`, hidden visibility or unload. A final visit with no
next instrumented page is skipped. On back/forward cache (BFCache) restore, the tracker reads the
persistent successor visit rather than reusing the restored page's old in-memory visit, avoiding
duplicate reporting. Without storage, the tracker drops its visit on `pagehide` and cannot bridge
BFCache away time.

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

### Runtime instrumentation controls

Normal automatic startup is unchanged: the distribution binds providers and enables eligible
registered instrumentations without an extra handle call. The returned handle exposes
`instrumentations` for instance-local lookup, pause/resume and supported registration changes:

- `instrumentations.get(id: string): BrowserInstrumentation | undefined` returns the registered
  object, or `undefined` for an unknown ID. Inspection only: do not call its lifecycle methods or
  `setConfig` directly.
- `instrumentations.setEnabled(id: string, enabled: boolean): Promise<void>` sets the entry's
  requested enabled state. It rejects unknown IDs, unsupported runtime lifecycle operations and
  invalid arguments. Calls serialize with this handle's `updateCfg` and are subject to the
  collection-gate, rollback and shutdown rules above.
- `instrumentations.add(id: string, instrumentation: BrowserInstrumentation): Promise<void>`
  registers a supported object under an explicit, non-empty, unused ID.
- `instrumentations.remove(id: string): Promise<void>` disables and removes a supported entry,
  releasing ownership only after cleanup succeeds.
- `instrumentations.replace(id: string, instrumentation: BrowserInstrumentation): Promise<void>`
  replaces a supported entry while preserving its ID, registration position and requested enabled
  state. The candidate's own kind determines which network gate applies.

IDs use the upstream module suffix: `fetch`, `xhr`, `console`, `errors`, `user-action` and
`web-vitals` for supported modules. Other upstream modules also use their suffix. Custom modules
use their full instrumentation name, or `instrumentation` if unnamed. Repeated IDs receive `#2`,
`#3`, and so on in registration order, for example `fetch#2`. The built-in page-view entry uses
`@microsoft/opentelemetry-browser/page-view`, not `page-view`.

Runtime pause/resume supports only the pinned `@opentelemetry/browser-instrumentation` **0.8.1**
fetch, XHR, console, errors and user-action modules, plus the **same Web Vitals object** registered
at startup. Web Vitals pause gates emission while its underlying observers remain registered;
resume does not replace the object or register a new set of observers. Page views, navigation,
navigation timing, resource timing, other versions and custom modules remain startup/shutdown-only:
`get()` can return them, but `setEnabled()` rejects their runtime lifecycle changes.

Requested enablement is separate from effective collection. `setEnabled(id, true)` neither opens a
closed fetch/XHR gate nor revives a disabled trace pipeline. Reopening a gate preserves manual
pauses, including when a replacement `updateCfg` resets the gates. The object's `getConfig().enabled`
is not a runtime collection-status API. Controls affect only this handle, even when browser patches
are shared with other instances.

Runtime add/remove/replace supports only pinned **0.8.1** fetch, XHR, console, errors and user-action
objects. Construct candidates with `enabled: false`; they must be inactive and not owned by any
handle. Fetch/XHR candidates require an enabled trace pipeline, even when a collection gate is
closed. No modules are imported or constructed by these methods. Added entries request collection
immediately, subject to the gate; replacements preserve a manual pause. A replacement can use a
different supported kind. Existing IDs are never renumbered after removal or replacement.

Web Vitals remains startup registration and same-object pause/resume only: its observer callbacks
cannot be unregistered, so runtime add/remove/replace rejects it. Page views, navigation, timing,
custom modules and other versions also reject registration changes.

All mutation methods serialize with `updateCfg`. Candidates are claimed before provider binding;
the new object becomes visible through `get` only after successful activation. The old object stays
visible during replacement, and is released only after the new registration succeeds. Failed
mutations attempt candidate cleanup and restoration of the previous registration. Objects whose
cleanup fails remain privately owned and are included in shutdown cleanup; subsequent mutations
reject when lifecycle state is uncertain. This cannot undo observed events, sent requests or injected
headers. A removed object may be registered on another handle after successful cleanup. Shutdown
attempts every remaining object, including unpublished candidates, in reverse ownership order.
Errors-instrumentation cleanup failures receive one bounded retry using the retained listener
references. The shutdown promise still reports the original error. Other failed cleanup, or a failed
errors retry, retains ownership: upstream enabled flags can hide incomplete removal, so those
objects cannot be reused on another handle. Calling `shutdown` again returns the same promise
rather than retrying indefinitely.

```typescript
const fetchInstrumentation = telemetry.instrumentations.get("fetch"); // Inspect only.
await telemetry.instrumentations.setEnabled("fetch", false);
await telemetry.updateCfg({ disableFetchTracking: true });
await telemetry.updateCfg({ disableFetchTracking: false }); // Manual pause remains.
await telemetry.instrumentations.setEnabled("fetch", true); // Resume the registered entry.

// Construct explicitly; the root package never imports optional instrumentation modules.
const { ErrorsInstrumentation } =
  await import("@opentelemetry/browser-instrumentation/experimental/errors");
await telemetry.instrumentations.add(
  "application-errors",
  new ErrorsInstrumentation({ enabled: false }),
);
await telemetry.instrumentations.replace(
  "application-errors",
  new ErrorsInstrumentation({ enabled: false }),
);
await telemetry.instrumentations.remove("application-errors");
```

## Enrichment and filtering

There is no `addTelemetryInitializer` or `getPlugin`, the same as in the other Microsoft
OpenTelemetry distributions. Use OpenTelemetry concepts instead:

| Application Insights JavaScript              | OpenTelemetry replacement                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telemetry initializer that adds properties   | `resource` for values fixed for the page; a span processor (`onStart` or `onEnding`) or log record processor (`onEmit`) for per-record attributes.                                         |
| Telemetry initializer that drops telemetry   | Filter at the source: instrumentation `ignoreUrls`, `samplingPercentage`, or not emitting the record. A processor cannot remove a record from other processors.                            |
| Per-request or per-page-view customization   | Instrumentation hooks such as `applyCustomAttributesOnSpan` and `pageView.applyCustomLogRecordData`.                                                                                       |
| `getPlugin` to configure or replace a plugin | Inspect registered objects with `instrumentations.get(id)`; use `instrumentations.setEnabled(id, enabled)` for supported pause/resume. Configure page views through `pageView` at startup. |

Supplied processors run before the Azure Monitor exporter, so their attributes are exported,
including when `samplingPercentage` is set. Processors are registered at startup and cannot be added
later; to change enrichment at runtime, have the processor read application state:

```ts
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

let tenant = "unknown";
export const setTenant = (value: string): void => {
  tenant = value;
};

const tenantSpans: SpanProcessor = {
  onStart: (span) => span.setAttribute("app.tenant", tenant),
  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};
const tenantLogs: LogRecordProcessor = {
  onEmit: (record) => record.setAttribute("app.tenant", tenant),
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

await useMicrosoftOpenTelemetry({
  azureMonitor: { connectionString },
  spanProcessors: [tenantSpans],
  logRecordProcessors: [tenantLogs],
});
```

Azure Monitor maps custom attributes to `customDimensions`.

## Context, propagation and lifecycle

`traces.contextManager` accepts an OpenTelemetry `ContextManager`. The default synchronous manager
does not preserve active context across unbound async continuations. See the
[explicit-context example](../README.md#known-beta-limitations).

`traces.propagators` accepts a readonly array of `TextMapPropagator`. Omit it for W3C Trace Context
and Baggage, or supply `[]` to disable propagation when this distribution owns the registration.
Built-in legacy `Request-Id` / `Request-Context` headers and `distributedTracingMode` / `appId`
compatibility options are out of scope. Custom propagators remain supported.
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
page hide/hidden visibility is best effort, not guaranteed delivery; Azure Monitor telemetry left
unsent is retried by the next page load in the same tab through the `sessionStorage` buffer.

## CDN loader configuration

`getSdkLoaderScript()` is exported from the ESM-only `@microsoft/opentelemetry-browser/snippet` entry.
It generates a script; it does not itself initialize telemetry in the current page.

| Option                                                                       | Default and behavior                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectionString`                                                           | Required non-empty string; becomes `cfg.azureMonitor.connectionString`.                                                                                           |
| `src`                                                                        | This package version's immutable CDN IIFE URL. Custom URLs must expose `Microsoft.OpenTelemetry` as a classic script global.                                      |
| `crossOrigin`                                                                | `"anonymous"`. Applied to the injected script.                                                                                                                    |
| `integrity`                                                                  | Unset. Supply integrity metadata for the exact version and artifact.                                                                                              |
| `loadDelay`                                                                  | Immediate injection. A nonnegative delay in milliseconds adds nonblocking delayed loading.                                                                        |
| `cdnFallback`                                                                | `false`. Retry backup Azure Monitor CDN hosts; requires a recognized CDN source URL.                                                                              |
| `reportLoadFailure`                                                          | `false`. Report an `SDKLoadFailed` exception after bundle load attempts fail.                                                                                     |
| `samplingPercentage`, `azureMonitor.disableBeacon`, `session`, `userContext` | Same meanings as initialization options above.                                                                                                                    |
| `storage`                                                                    | Same `enabled` and `namePrefix` settings as initialization options above.                                                                                         |
| `redactQueryParams`                                                          | Same additional sensitive parameter names as initialization options above.                                                                                        |
| `cookieCfg`                                                                  | Data-only settings: `enabled`, `domain`, `path`, `ignoreCookies`, `blockedCookies`, `disableCookieDefer`. Cookie hooks are not supported by the snippet.          |
| `pageView`                                                                   | Data-only settings: `enabled`, `autoTrackPageVisitTime` (default `false`), `redactedQueryParams`, `softNavigationSettleTimeoutMs`, `useNavigationApiIfAvailable`. |
| `instrumentationOptions`                                                     | JSON-only helper settings. Omitted: fetch/XHR defaults.                                                                                                           |
| `resourceAttributes`                                                         | String, number or boolean attributes converted into a resource by the bundle.                                                                                     |

The generator accepts JSON-serializable settings, not functions or regular expressions. Processors,
exporters, context managers, propagators and resource detectors require npm-based initialization.
Loader options are unchanged: use `azureMonitor.disableBeacon`, not the root `onunloadDisableBeacon`
alias supported only by runtime updates. `disableFetchTracking` and `disableAjaxTracking` are also
runtime-only and are not accepted by the loader or its generated initialization `cfg`.
`extensionConfig.AppInsightsCfgSyncPlugin` is also npm startup-only and is not accepted by the
loader or generated configuration.
The generated configuration's `cfg` holds initialization options; `instrumentationOptions` and
`resourceAttributes` are siblings of `cfg`. See [Packaging](packaging.md#cdn-and-loader-snippet) for
the snippet, CSP, fallback hosts, integrity manifests and failure handling.
