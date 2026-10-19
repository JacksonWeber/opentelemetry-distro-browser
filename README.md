# @microsoft/opentelemetry-browser

[![npm version](https://img.shields.io/npm/v/@microsoft/opentelemetry-browser?label=npm&color=cb3837)](https://www.npmjs.com/package/@microsoft/opentelemetry-browser)
[![Build](https://github.com/microsoft/opentelemetry-distro-browser/actions/workflows/pr-validation.yml/badge.svg)](https://github.com/microsoft/opentelemetry-distro-browser/actions/workflows/pr-validation.yml)
[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Microsoft's OpenTelemetry distribution for browser applications. It provides one initialization
path for traces and logs, built-in page-view collection, optional browser instrumentations, browser
session correlation, and direct export to Azure Monitor. Standard OpenTelemetry processors can send
the same telemetry to OTLP or other backends.

This package is the browser sibling of the Microsoft OpenTelemetry distributions for
[Node.js](https://github.com/microsoft/opentelemetry-distro-javascript) and
[Python](https://github.com/microsoft/opentelemetry-distro-python).

> [!IMPORTANT]
> The package is currently a beta release. APIs may change before the first stable release.

See the [configuration reference](docs/configuration-reference.md),
[event catalogue](docs/event-catalogue.md), and [known beta limitations](#known-beta-limitations).

## Getting started

### Prerequisites

- A current supported browser. See [Browser support](#browser-support).
- An [Application Insights resource](https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview)
  (optional, for Azure Monitor), or any OTLP-compatible endpoint.

### Install the package

```bash
npm install @microsoft/opentelemetry-browser@beta @opentelemetry/api@1.9.1 @opentelemetry/api-logs@0.222.0 @opentelemetry/resources@2.11.0
```

The OpenTelemetry versions above match `0.1.0-beta.1` and the imports in this guide. Keep them
aligned with the distribution when upgrading. Use a browser bundler for the npm package, or follow
[Snippet setup](#snippet-setup) for classic script loading.

### Quick start

Initialize and await telemetry before loading the application code that should be instrumented.
This example exports to Azure Monitor, enables session correlation, collects page views, and turns
on fetch, XHR, unhandled-error, user-action, and web-vitals instrumentation.

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
import { resourceFromAttributes } from "@opentelemetry/resources";

const telemetry = await useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString: "InstrumentationKey=...;IngestionEndpoint=...",
  },
  resource: resourceFromAttributes({
    "service.name": "shop-web",
    "service.version": "1.0.0",
  }),
  session: { enabled: true },
  instrumentations: await getInstrumentations({
    errors: { enabled: true },
    userAction: { enabled: true },
    webVitals: { enabled: true },
  }),
});

await import("./app.js");
```

`useMicrosoftOpenTelemetry()` is asynchronous and is normally called once per page. Multiple calls
are supported: each returns a handle with independent telemetry pipelines and lifecycle, while
page context and propagation are shared within the browser realm. Page-view collection is enabled
by default. `getInstrumentations()` loads fetch and XHR instrumentation by default; its other
instrumentations are opt-in.

See the runnable [Azure Monitor, console, OTLP, and telemetry viewer samples](samples/) for
complete applications.

### Manual telemetry

After initialization, use the standard OpenTelemetry APIs. Instrumented application code stays
portable and does not depend on a proprietary telemetry API.

```typescript
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const tracer = trace.getTracer("my-app", "1.0.0");
const span = tracer.startSpan("checkout");
span.setAttribute("cart.item_count", 3);
span.end();

logs.getLogger("my-app", "1.0.0").emit({
  eventName: "app.checkout_started",
  attributes: { "cart.item_count": 3 },
});
```

Use log records with a top-level `eventName` for browser occurrences and spans for operations with
duration or distributed-trace correlation.

### Verify the first telemetry

1. Initialize telemetry with a real connection string, await completion, then run the manual
   telemetry example above. Call `await telemetry.forceFlush()` to send the current batches.
2. In browser DevTools, check for requests to the configured ingestion endpoint's `/v2/track`
   path. A successful request confirms transport, not that every item was accepted; inspect the
   response for partial-ingestion errors. Allow ingestion time before querying Azure Monitor.
3. In the Application Insights resource's Logs view, look for the manual event:

   ```kusto
   customEvents
   | where timestamp > ago(30m)
   | where name == "app.checkout_started"
   | project timestamp, name, operation_Id, session_Id, customDimensions, customMeasurements
   ```

   In a Log Analytics workspace context, use `AppEvents` with its workspace column names instead.
   See the [event catalogue](docs/event-catalogue.md#azure-monitor-mapping) for the other tables.

For a backend-free check, run the [console or telemetry viewer sample](samples/README.md).
For a CDN setup, wait for `window.microsoftOpenTelemetry` before emitting manual telemetry through
`Microsoft.OpenTelemetry.trace` and `Microsoft.OpenTelemetry.logs`.

If telemetry is missing:

- Check initialization errors and console diagnostics. The first initialization installs an INFO
  diagnostic logger; call OpenTelemetry `diag.setLogger()` afterward to change its level or sink.
- Ensure a destination is configured. Without `azureMonitor` or custom processors, nothing exports.
  `spanProcessors: []` or `logRecordProcessors: []` disables that signal.
- Confirm instrumentations were passed to initialization, and initialize before application code.
  Importing the package alone does not collect telemetry. For smoke tests, omit percentage sampling.
- Check CSP, CORS, network blockers, connection-string validity and ingestion responses. The CDN
  loader also needs the correct version-matched integrity hash; see [Packaging](docs/packaging.md#cdn-and-loader-snippet).
- Do not rely on unload delivery to verify setup. It is best effort and browser payload limits apply.

### Flush and shutdown

Telemetry is batched and flushed automatically on `pagehide` and `visibilitychange`. The handle
returned by `useMicrosoftOpenTelemetry()` lets you do it explicitly:

```typescript
await telemetry.forceFlush();
await telemetry.shutdown();
```

### Snippet setup

If the application does not use npm or a bundler, paste this snippet as the first script in each
page's `<head>`, replacing `CHANNEL`, `VERSION`, `YOUR_CONNECTION_STRING`, and `YOUR_INTEGRITY`:

<!-- prettier-ignore -->
```html
<script>
!(function(w,d,c){w.microsoftOpenTelemetry=new Promise(function(resolve,reject){function l(u){var s=d.createElement("script");s.src=u;s.crossOrigin=c.crossOrigin;if(c.integrity)s.integrity=c.integrity;s.onload=function(){var sdk=w.Microsoft&&w.Microsoft.OpenTelemetry;if(!sdk||typeof sdk.useMicrosoftOpenTelemetry!=="function"){reject(new Error("OpenTelemetry browser bundle did not expose Microsoft.OpenTelemetry"));return}Promise.resolve().then(function(){return typeof sdk.getInstrumentations==="function"?sdk.getInstrumentations(c.instrumentationOptions):[]}).then(function(i){var o=c.cfg;o.instrumentations=i;if(c.resourceAttributes)o.resource=sdk.resourceFromAttributes(c.resourceAttributes);return sdk.useMicrosoftOpenTelemetry(o)}).then(resolve,reject)};s.onerror=function(){reject(new Error("OpenTelemetry browser bundle failed to load: "+u))};d.head.appendChild(s)}l(c.src)})})(window,document,{"src":"https://js.monitor.azure.com/scripts/otel/CHANNEL/opentelemetry-browser.VERSION.min.js","crossOrigin":"anonymous","integrity":"YOUR_INTEGRITY","cfg":{"azureMonitor":{"connectionString":"YOUR_CONNECTION_STRING"}}});
</script>
```

For example, `0.1.0-beta.1` uses channel `beta`, and its `YOUR_INTEGRITY` is the
`ext["@min.js"].integrity` value in
[`opentelemetry-browser.0.1.0-beta.1.integrity.json`](https://js.monitor.azure.com/scripts/otel/beta/opentelemetry-browser.0.1.0-beta.1.integrity.json).
The snippet enables Azure Monitor export, page views, and `fetch` and XHR dependency collection.
To change that, add JSON settings to the configuration object at the end of the snippet. Settings in
`cfg` use the same names as the npm options and are passed to `useMicrosoftOpenTelemetry` as is;
`instrumentationOptions` is passed to `getInstrumentations()`, and `resourceAttributes` becomes the
resource:

```json
{
  "src": "...",
  "crossOrigin": "anonymous",
  "integrity": "YOUR_INTEGRITY",
  "cfg": {
    "azureMonitor": { "connectionString": "YOUR_CONNECTION_STRING", "disableBeacon": false },
    "samplingPercentage": 50,
    "session": { "enabled": true },
    "userContext": { "enabled": true },
    "pageView": { "redactedQueryParams": ["token"] }
  },
  "instrumentationOptions": { "errors": { "enabled": true }, "webVitals": { "enabled": true } },
  "resourceAttributes": { "service.name": "my-web-app", "service.version": "1.2.3" }
}
```

Options that take functions, such as page-view hooks, processors, and context managers, require the
npm package.

Like the Application Insights loader, `getSdkLoaderScript()` can also delay loading the bundle
(`loadDelay`, Application Insights `ld`), retry it from backup Azure Monitor CDN hosts
(`cdnFallback`, `cr`), and report a bundle that fails to load to Azure Monitor as an
`SDKLoadFailed` exception (`reportLoadFailure`). These add code to the snippet only when enabled, so
generate the snippet with them rather than editing the configuration object.

`window.microsoftOpenTelemetry` is a promise that resolves to the telemetry handle, or rejects when
the bundle fails to load, fails its integrity check, or fails to initialize:

```javascript
window.microsoftOpenTelemetry.catch(function (error) {
  console.error(error);
});
```

See [Packaging](docs/packaging.md#cdn-and-loader-snippet) for CDN endpoints, Content Security
Policy requirements, and generating the snippet with `getSdkLoaderScript()`.

## Configuration

### `MicrosoftOpenTelemetryBrowserOptions`

The tables below are an overview. See the [full configuration reference](docs/configuration-reference.md)
for nested settings, defaults, sampling, identity and context behavior.

| Option                | Type                                   | Default                            | Description                                                                 |
| --------------------- | -------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `azureMonitor`        | `AzureMonitorOptions`                  | —                                  | Enables Azure Monitor trace and log export                                  |
| `resource`            | `Resource`                             | OpenTelemetry default resource     | Resource attributes attached to every span and log record                   |
| `samplingPercentage`  | `number`                               | Parent-based traces; no Azure Monitor log percentage sampling | Fixed percentage from 0 through 100 for traces and default Azure Monitor log export |
| `session`             | `MicrosoftOpenTelemetryBrowserSessionOptions` | Enabled, persisted          | Adds `session.id` with a 30-minute inactivity timeout and a 24-hour maximum lifetime |
| `userContext`         | `{ enabled?: boolean }`                | Enabled                            | Persists managed anonymous identity and authenticated user and account IDs set through the handle |
| `traces`              | `MicrosoftOpenTelemetryBrowserTraceOptions` | Browser SDK defaults          | Replaces the browser context manager or trace propagators                    |
| `spanProcessors`      | `SpanProcessor[]`                      | Azure Monitor only, if configured  | Registers custom trace processors; `[]` skips trace initialization          |
| `logRecordProcessors` | `LogRecordProcessor[]`                 | Azure Monitor only, if configured  | Registers custom log processors; `[]` skips log initialization              |
| `instrumentations`    | `BrowserInstrumentation[]`             | `[]`                               | Instrumentation instances owned and registered by this SDK                  |
| `pageView`            | `PageViewInstrumentationConfig`        | Enabled                            | Configures built-in `browser.page_view` log collection                      |

Session and user identity use same-origin `localStorage` by default. Set `session.enabled: false`
to disable managed sessions without accessing session storage, or `session.persist: false` to keep
sessions in memory. Set `userContext.enabled: false` to disable managed identity persistence and
anonymous-ID enrichment without accessing user storage; application-supplied authenticated identity
remains available in memory.

### `azureMonitor` options

| Option            | Type      | Default | Description                                                                   |
| ----------------- | --------- | ------- | ----------------------------------------------------------------------------- |
| `connectionString` | `string` | —       | Application Insights connection string, including sovereign-cloud endpoints  |
| `disableBeacon`   | `boolean` | `false` | Disables the `sendBeacon` fallback used when a page unloads                    |

### Browser instrumentations

Import `getInstrumentations()` from the dedicated subpath so its dynamic imports remain
tree-shakeable and code-splittable. Fetch and XHR are on by default when this helper is called. The
console, errors, navigation, navigation timing, resource timing, user action, and web vitals
instrumentations are opt-in.

```typescript
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";

const instrumentations = await getInstrumentations({
  fetch: { enabled: true },
  xhr: { enabled: false },
  errors: { enabled: true },
  navigation: { enabled: true },
  resourceTiming: {
    enabled: true,
    initiatorTypes: ["script", "link", "css", "img"],
  },
});
```

Pass the result to `useMicrosoftOpenTelemetry({ instrumentations })`. You can also construct
compatible upstream instrumentation instances yourself and pass them directly.

### OTLP and custom exporters

The distribution exports to Azure Monitor when `azureMonitor` is set. It does not bundle an OTLP
exporter: without `azureMonitor`, `spanProcessors` or `logRecordProcessors`, no telemetry is
exported. Use standard OpenTelemetry processors to export to OTLP or another backend. For OTLP/HTTP:

```typescript
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

await useMicrosoftOpenTelemetry({
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: "https://collector.example.com/v1/traces" }),
    ),
  ],
  logRecordProcessors: [
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({
        url: "https://collector.example.com/v1/logs",
      }),
    }),
  ],
});
```

The collector must allow the application origin through CORS. Do not embed API keys, bearer tokens,
or other secrets in browser configuration; authenticate browser traffic at a collector or gateway.

### Browser resource attributes

Browser and user-agent resource detectors are opt-in to avoid repeating information that many
backends derive from request headers:

```typescript
import {
  browserDetector,
  useMicrosoftOpenTelemetry,
  userAgentDetector,
} from "@microsoft/opentelemetry-browser";
import { detectResources } from "@opentelemetry/resources";

await useMicrosoftOpenTelemetry({
  resource: detectResources({
    detectors: [browserDetector, userAgentDetector],
  }),
});
```

The detectors are available from the npm package only. The CDN bundles and the loader snippet do
not include them, so pages that load the SDK from the CDN do not download code they cannot use.

## Bundle size

The size depends on how the package is loaded. Sizes in KiB, measured from the current source:

| Loaded from | Includes                                          | Minified |  gzip | Brotli |
| ----------- | ------------------------------------------------- | -------: | ----: | -----: |
| npm         | Distribution, page views and Azure Monitor export |    115.2 |  36.0 |   31.8 |
| CDN         | Everything except the npm-only resource detectors |    156.4 |  47.6 |   41.6 |

**npm.** The application's bundler removes code the application does not use. Instrumentations are
loaded through dynamic imports only when enabled, so each one adds only its own code. Gzip added
by each instrumentation, measured on its own:

| Instrumentation | gzip | Instrumentation    | gzip |
| --------------- | ---: | ------------------ | ---: |
| `fetch`         |  2.3 | `navigationTiming` |  0.9 |
| `xhr`           |  1.8 | `resourceTiming`   |  1.5 |
| `console`       |  0.3 | `userAction`       |  0.8 |
| `errors`        |  0.3 | `webVitals`        |  5.3 |
| `navigation`    |  0.8 |                    |      |

**CDN.** A page that loads a script file cannot remove unused code, and the file cannot know which
features the page will enable, so `opentelemetry-browser.<version>.min.js` includes every
instrumentation. The loader snippet enables `fetch` and `xhr`; the others are included but stay off
unless enabled through the snippet's `instrumentationOptions`. The browser and user-agent resource
detectors are npm-only; see [Browser resource attributes](#browser-resource-attributes).

Run `npm run build && npm run size` to reproduce these measurements.

## Package formats

Choose the format that matches how the application loads JavaScript:

| Application setup | Use |
| --- | --- |
| ESM bundler | `import` from `@microsoft/opentelemetry-browser` |
| CommonJS bundler | `require("@microsoft/opentelemetry-browser")` |
| AMD or RequireJS | `dist/browser/opentelemetry-browser.umd.min.js` |
| Direct `<script>` loading | `dist/browser/opentelemetry-browser.iife.min.js` |

The IIFE bundle exposes `Microsoft.OpenTelemetry`. Use it instead of UMD when RequireJS might already
be present but the SDK should load as a global. The SDK bundles include every instrumentation and
expose `Microsoft.OpenTelemetry.getInstrumentations`; pass its result as `instrumentations`.

```html
<script src="/vendor/opentelemetry-browser.iife.min.js"></script>
<script>
  Microsoft.OpenTelemetry.getInstrumentations().then(function (instrumentations) {
    return Microsoft.OpenTelemetry.useMicrosoftOpenTelemetry({
      azureMonitor: { connectionString: "InstrumentationKey=...;IngestionEndpoint=..." },
      instrumentations: instrumentations,
    });
  });
</script>
```

All browser bundles include source maps. The global SDK bundle also exposes the standard
OpenTelemetry APIs used by the distribution, including `trace` and `logs`.

## Browser support

Like the Application Insights JavaScript SDK, support tracks the latest stable releases of the
major browser families:

| Chrome   | Firefox  | Edge     | Opera    | Safari   |
| -------- | -------- | -------- | -------- | -------- |
| Latest ✔ | Latest ✔ | Latest ✔ | Latest ✔ | Latest ✔ |

Internet Explorer and other browsers requiring ES5 are not supported. The ESM and CommonJS npm
entries require a browser bundler; UMD and IIFE artifacts support classic script loading.

CI runs the complete unit and emitted-bundle integration suites in current Playwright Chromium,
Firefox, and WebKit. Chromium provides engine coverage for Chrome, Edge, and Opera; WebKit provides
engine coverage for Safari.

The package publishes ESM and CommonJS entries through its `exports` map. Server-rendered builds can
import the package, but browser telemetry should be initialized in client-side code.

## Known beta limitations

- **Modern browsers only.** Internet Explorer and pre-ES2015 browsers are unsupported. The package
  targets ES2022, so ES2015 support alone is not sufficient. Support follows the
  [latest-stable policy](#browser-support); exact minimum browser versions are not declared.
- **Evolving semantic conventions.** Browser events use experimental/development-stability upstream
  conventions and distribution-owned page-view conventions, not a stable browser event schema.
  Event names and attributes can change during beta; pin versions and review the
  [event catalogue](docs/event-catalogue.md) when upgrading. This does not make all OpenTelemetry
  semantic conventions experimental.
- **No offline telemetry persistence.** Batching and bounded retries are in memory; unsent telemetry
  is not durably queued for replay after reload. Session and identity persistence are separate.
  Page-hide delivery uses browser-limited keepalive/Beacon transport and is not guaranteed.
- **No built-in Microsoft Entra ID (AAD) authentication for Azure Monitor ingestion.** Export uses
  a connection string with an instrumentation key, not a token credential. Parsing an audience
  field does not enable authentication. Do not embed credentials or bearer tokens in browser code;
  use a collector or gateway for authenticated ingestion architectures.
- **Async context is not automatic across every boundary.** The default context manager is
  synchronous. Unbound promises and `await` continuations do not retain the active span. Pass
  explicit context when starting spans or emitting logs, or bind callbacks with `context.bind()`.
  Page-operation correlation is a fallback, not a replacement for explicit parent context.
- **Optional does not mean unavailable.** Fetch and XHR are defaults only when `getInstrumentations()`
  is called; console, errors, navigation, timing, user actions and Web Vitals are available but opt-in.
  Framework-specific integrations and richer Click Analytics are not included. Web Vitals are log
  events; this distribution does not initialize the OpenTelemetry Metrics API.
- **Multiple instances share realm-wide facilities.** Pipelines and lifecycle are independent, but
  page context, propagation and page-operation correlation are coordinated. Later propagator options
  do not replace the page-lifetime registration. Fetch uses the last writer's trace headers; XHR
  preserves existing headers. Do not share processor or instrumentation objects between handles.

For example, retain a parent context explicitly after an asynchronous operation:

```typescript
import { context, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const tracer = trace.getTracer("my-app");
const parent = tracer.startSpan("checkout");
const parentContext = trace.setSpan(context.active(), parent);
try {
  await Promise.resolve(); // Represents application work; implicit parent context is not retained.
  const child = tracer.startSpan("confirm", {}, parentContext);
  child.end();
  logs.getLogger("my-app").emit({
    eventName: "app.checkout_confirmed",
    context: parentContext,
  });
} finally {
  parent.end();
}
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and pull request guidance.

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit
[Contributor License Agreements](https://cla.opensource.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a
CLA and decorate the pull request appropriately. You only need to do this once across repositories
using this CLA.

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more
information, see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com).

## Data Collection

As this SDK is designed to enable applications to perform data collection which is sent to
Microsoft collection endpoints, the following notice identifies our privacy statement.

The software may collect information about you and your use of the software and send it to
Microsoft. Microsoft may use this information to provide services and improve our products and
services. You may turn off the telemetry as described in the repository. There are also some
features in the software that may enable you and Microsoft to collect data from users of your
applications. If you use these features, you must comply with applicable law, including providing
appropriate notices to users of your applications together with a copy of Microsoft's privacy
statement. Our privacy statement is located at
<https://go.microsoft.com/fwlink/?LinkID=824704>. You can learn more about data collection and use
in the help documentation and our privacy statement. Your use of the software operates as your
consent to these practices.

Telemetry collection starts only when an application initializes the SDK and configures an
exporter. Omit optional entries from `instrumentations` to disable them, and set
`pageView.enabled` to `false` to disable automatic page-view collection. Call `shutdown()` on the
returned handle to stop collection and export. See [PRIVACY.md](PRIVACY.md) for additional guidance
for applications that use this SDK.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of
Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion
or imply Microsoft sponsorship. Any use of third-party trademarks or logos is subject to those third
parties' policies.

## Reporting Security Issues

See [SECURITY.md](SECURITY.md) for information on reporting vulnerabilities.

## License

[MIT](LICENSE)
