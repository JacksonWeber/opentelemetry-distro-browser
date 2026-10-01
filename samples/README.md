# Browser samples

These applications consume the package from this repository, following the same self-contained
sample pattern as the Microsoft OpenTelemetry Node.js distribution.

| Sample                                | Purpose                                                                          | Command                        |
| ------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| [Azure Monitor](azure-monitor/)       | Export browser spans and logs to an Application Insights resource                | `npm run dev:azure-monitor`    |
| [Console](console/)                   | Start locally without a telemetry backend and inspect spans and logs in DevTools | `npm run dev:console`          |
| [OTLP](otlp/)                         | Export browser spans and logs to an OTLP/HTTP collector                          | `npm run dev:otlp`             |
| [Telemetry viewer](telemetry-viewer/) | Exercise a realistic SPA and inspect exported spans and logs in the page         | `npm run dev:telemetry-viewer` |

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
