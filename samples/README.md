# Browser samples

These applications consume the published
`@microsoft/opentelemetry-browser@0.1.0-alpha.1` package, following the same
self-contained sample pattern as the Microsoft OpenTelemetry Node.js distribution.

| Sample                          | Purpose                                                                          | Command                     |
| ------------------------------- | -------------------------------------------------------------------------------- | --------------------------- |
| [Azure Monitor](azure-monitor/) | Export browser spans and logs to an Application Insights resource                | `npm run dev:azure-monitor` |
| [Console](console/)             | Start locally without a telemetry backend and inspect spans and logs in DevTools | `npm run dev:console`       |
| [OTLP](otlp/)                   | Export browser spans and logs to an OTLP/HTTP collector                          | `npm run dev:otlp`          |

Install dependencies once from this directory:

```bash
npm install
```

Each sample initializes telemetry before dynamically importing application code. This ordering is
important because browser instrumentations must patch APIs such as `fetch` before the application
uses them.

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
