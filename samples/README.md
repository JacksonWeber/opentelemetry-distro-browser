# Browser samples

These applications consume the package from this repository, following the same self-contained
sample pattern as the Microsoft OpenTelemetry Node.js distribution.

| Sample                                | Purpose                                                                          | Command                        |
| ------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| [Azure Monitor](azure-monitor/)       | Export browser spans and logs to an Application Insights resource                | `npm run dev:azure-monitor`    |
| [Console](console/)                   | Start locally without a telemetry backend and inspect spans and logs in DevTools | `npm run dev:console`          |
| [OTLP](otlp/)                         | Export browser spans and logs to an OTLP/HTTP collector                          | `npm run dev:otlp`             |
| [Telemetry viewer](telemetry-viewer/) | Exercise a realistic SPA and inspect exported spans and logs in the page         | `npm run dev:telemetry-viewer` |
| [Debugger](debug/)                    | Test the optional `/debug` entry with two SDK instances and a local OTLP sink    | `npm run dev:debug`            |

Install the package build dependencies from the repository root, then install the sample
dependencies:

```bash
npm install
cd samples
npm install
```

Every public sample build, development, and typecheck command rebuilds the local package before
consuming it.

Each sample initializes telemetry before dynamically importing application code. This ordering is
important because browser instrumentations must patch APIs such as `fetch` before the application
uses them.

## Telemetry viewer

Run `npm run dev:telemetry-viewer` from `samples` and use the storefront navigation and scenario controls. The
sample registers local in-memory span and log exporters, so it requires no credentials or telemetry
backend. The viewer can filter signals, search exported content, pause or clear capture, inspect the
complete normalized payload, and save a recording as JSON. Its dev and production-build commands
first rebuild the package from the repository, ensuring that the site exercises the current source
rather than a published version. The overview also displays the raw, minified, gzip, and Brotli
sizes of equivalent "everything" and "defaults only" consumer bundles generated from that local
package build. The viewer retains the 500 most recent telemetry items; the UI and JSON export report
how many older items were dropped.

## In-page debugger

Run `npm run dev:debug` from `samples`. Unlike the sample-only telemetry viewer above, this uses
the public `@microsoft/opentelemetry-browser/debug` entry. It implements the in-page tooling outcome
in [`planning/M3_PLANNING.md`](../planning/M3_PLANNING.md) and follows the opt-in, bounded-memory
and lifecycle requirements in [`planning/REQUIREMENTS.md`](../planning/REQUIREMENTS.md).
The debug entry is separate from the SDK and instrumentation bundles. No new runtime dependency
or Application Insights plugin interface is required.

Wrap the processors and their exporters before calling `useMicrosoftOpenTelemetry`. For example:

```ts
import { createTelemetryDebugger } from "@microsoft/opentelemetry-browser/debug";
import { AzureMonitorSpanExporter } from "@microsoft/opentelemetry-browser";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

const debug = createTelemetryDebugger({ container, performance: true });
const processor = debug.wrapSpanProcessor(
  new BatchSpanProcessor(
    debug.wrapSpanExporter(new AzureMonitorSpanExporter({ connectionString })),
  ),
);
// Pass processor in spanProcessors. Use the corresponding log wrappers for logs.
// After SDK shutdown, call debug.dispose() to remove the view and retained data.
```

Keep the normal exporter configuration. Adding a local viewer exporter on a parallel pipeline
would not report whether the real exporter succeeded. `emitted` means the wrapped processor
received the record, `exporting` means the wrapped exporter was called, and `exported` or `failed`
comes from that exporter's result. Success is not proof of backend ingestion, especially for
beacon delivery. Sampling before processors, records dropped by batching, serialized envelopes,
internal retries, and per-item partial acceptance are not observable through these contracts.

The sample's development server accepts OTLP requests locally, waits 400 ms, and discards the data.
Its rejection checkbox returns HTTP 400 to exercise failures without a retry delay. This sink is a
test harness, not a collector. It is not part of the production sample assets.

Browser checklist:

1. Emit on A, then flush A. Both signals should appear as emitted, then exporting, then exported.
   Compare the OTLP requests in DevTools Network. B must not show A's named records.
2. Select a record. Inspect attributes, resource, scope, and matching trace IDs. The HTML-looking
   log body must be displayed as text, never executed. Exercise search and both filters.
3. Enable rejection, emit, and flush. Both export observations should say failed. Disable rejection
   and send new records to confirm recovery.
4. Pause capture, emit, and flush. Network export must continue without new rows. Resume and repeat.
5. Burst 250 records. Each panel keeps at most 50 observations and reports evictions. Clear while
   an export is pending. Its completion must not bring cleared payloads back.
6. Record DevTools Performance during emit/flush. Look for `otel.debug.*` marks and measures.
   Reload with `?timing=off` and confirm new debug timings are absent. Clearing or disposing one
   panel must remove only its own retained User Timing entries.
7. Shut down A, then try emitting on A. It must not produce new observations or requests. B must
   remain usable. Dispose B's panel, then emit/flush B. Export must continue without the panel.
8. Repeat in Chromium, Firefox, and Safari/WebKit. Reload to restart both SDK instances.

This is development-only tooling. Payloads may contain sensitive application data and are visible
to scripts in the page. It makes no extra telemetry requests, persists nothing, and retains bounded
snapshots only. Defaults are 200 observations and 16000 characters per snapshot, with depth and
node limits. The sample lowers retention to 50. User Timing is off by default and optional. It
measures wrapped SDK operations, not internal SDK phases. Use `debug.measure` around asynchronous
initialization or lifecycle calls when those timings are needed.

## Azure Monitor configuration

Copy `azure-monitor/.env.example` to `azure-monitor/.env.local`, set
`VITE_APPLICATIONINSIGHTS_CONNECTION_STRING` to the connection string from an Application Insights
resource, and run `npm run dev:azure-monitor`. Application Insights connection strings do not grant
read access to the resource, but they are included in public browser JavaScript and should still be
treated as application configuration.

## OTLP configuration

Copy `otlp/.env.example` to `otlp/.env.local`, set `VITE_OTLP_ENDPOINT` to the collector's
OTLP/HTTP base URL, and run `npm run dev:otlp`. The sample appends `/v1/traces` and `/v1/logs`.

The collector must allow the sample origin through CORS. `VITE_` values are public browser
configuration; never put API keys, bearer tokens, or other secrets in them. Use a collector or
gateway to authenticate browser traffic.
