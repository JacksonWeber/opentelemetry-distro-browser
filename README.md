# @microsoft/opentelemetry-browser

[![npm version](https://img.shields.io/npm/v/@microsoft/opentelemetry-browser?label=npm&color=cb3837)](https://www.npmjs.com/package/@microsoft/opentelemetry-browser)
[![Build](https://github.com/microsoft/opentelemetry-distro-browser/actions/workflows/pr-validation.yml/badge.svg)](https://github.com/microsoft/opentelemetry-distro-browser/actions/workflows/pr-validation.yml)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Microsoft's OpenTelemetry distribution for browser applications. It provides one initialization
path for traces and logs, built-in page-view collection, optional browser instrumentations, browser
session correlation, and direct export to Azure Monitor. Standard OpenTelemetry processors can send
the same telemetry to OTLP or other backends.

This package is the browser sibling of the Microsoft OpenTelemetry distributions for
[Node.js](https://github.com/microsoft/opentelemetry-distro-javascript) and
[Python](https://github.com/microsoft/opentelemetry-distro-python).

> [!IMPORTANT]
> The package is currently an alpha release. APIs may change before the first stable release.

## Getting started

### Prerequisites

- A modern browser with ES modules. See [Supported environments](#supported-environments).
- An [Application Insights resource](https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview)
  (optional, for Azure Monitor), or any OTLP-compatible endpoint.

### Install the package

```bash
npm install @microsoft/opentelemetry-browser@alpha
```

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

`useMicrosoftOpenTelemetry()` is asynchronous and should normally run once per page. Page-view
collection is enabled by default. `getInstrumentations()` loads fetch and XHR instrumentation by
default; its other instrumentations are opt-in.

See the runnable [Azure Monitor, console, and OTLP samples](samples/) for complete applications.

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

### Flush and shutdown

Telemetry is batched and flushed automatically on `pagehide` and `visibilitychange`. The handle
returned by `useMicrosoftOpenTelemetry()` lets you do it explicitly:

```typescript
await telemetry.forceFlush();
await telemetry.shutdown();
```

## Configuration

### `MicrosoftOpenTelemetryBrowserOptions`

| Option                | Type                                   | Default                            | Description                                                                 |
| --------------------- | -------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `azureMonitor`        | `AzureMonitorOptions`                  | —                                  | Enables Azure Monitor trace and log export                                  |
| `resource`            | `Resource`                             | OpenTelemetry default resource     | Resource attributes attached to every span and log record                   |
| `session`             | `{ enabled?: boolean }`                | Disabled                           | Adds a persisted `session.id` with a 30-minute inactivity timeout           |
| `traces`              | `MicrosoftOpenTelemetryBrowserTraceOptions` | Browser SDK defaults          | Replaces the browser context manager or trace propagators                    |
| `spanProcessors`      | `SpanProcessor[]`                      | Upstream default when applicable   | Registers custom trace processors; `[]` skips trace initialization          |
| `logRecordProcessors` | `LogRecordProcessor[]`                 | Upstream default when applicable   | Registers custom log processors; `[]` skips log initialization              |
| `instrumentations`    | `BrowserInstrumentation[]`             | `[]`                               | Instrumentation instances owned and registered by this SDK                  |
| `pageView`            | `PageViewInstrumentationConfig`        | Enabled                            | Configures built-in `browser.page_view` log collection                      |

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

Use standard OpenTelemetry processors to export to OTLP or another backend. For OTLP/HTTP:

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

## Bundle size

The production bundle is built and measured in CI. For `0.1.0-alpha.1`:

| Artifact                   | Size     |
| -------------------------- | -------: |
| Minified ESM               | 99.57 kB |
| Minified ESM + gzip        | 28.94 kB |
| Minified ESM + Brotli      | 25.55 kB |

Run `npm run build && npm run size` to reproduce these measurements. Optional browser
instrumentations are loaded through dynamic imports and remain outside the root bundle unless used.

## Supported environments

| Environment                                      | Support                                      |
| ------------------------------------------------ | -------------------------------------------- |
| Current Chrome, Edge, Firefox, and Safari         | Supported                                    |
| ES modules and modern browser APIs                | Required                                     |
| CommonJS-only applications                        | Not supported                                |
| Legacy browsers requiring ES5                     | Not supported                                |

The package is ESM-only and publishes an `exports` map. Server-rendered builds can import the
package, but browser telemetry should be initialized in client-side code.

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
