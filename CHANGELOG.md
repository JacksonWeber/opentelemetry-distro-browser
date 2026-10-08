# Changelog

All notable changes to this package are documented in this file.

## 0.1.0-alpha.2 - Unreleased

### Added

- Add shared deterministic test fixtures and informational PR coverage comparisons.
- Promote the size harness into a repository tool
- Add a configurable SDK loader snippet generator that requires an explicit browser bundle URL.
- Map page view ID and referrer to Azure Monitor envelopes
- Add parsed JavaScript stack frames to Azure Monitor browser exception telemetry while
  preserving the original stack trace.
- Add browser user context with anonymous and authenticated identities, opt-in persistence,
  sign-out controls, OpenTelemetry enrichment, and Azure Monitor `ai.user.*` mapping.
- Add an interactive storefront sample with local span and log exporters and a built-in telemetry
  viewer.
- Add CommonJS npm entries and self-contained UMD and IIFE browser bundles; the UMD bundles also
  register with AMD loaders such as RequireJS.
- Add Azure Monitor page-view performance telemetry

### Changed

- Limit Azure Monitor retry waits to a 30-second budget per send so long `Retry-After` values
  fail exports promptly instead of stalling `forceFlush()` and `shutdown()`, while preserving
  the server's throttle deadline.
- Require HTTPS for Azure Monitor endpoints, except HTTP on localhost and loopback IP addresses.
  Invalid endpoints now emit a diagnostic warning and use the existing fallback endpoints.
- Share routing and page-context state across compatible distribution copies while preserving
  foreign OpenTelemetry globals and isolated instance pipelines.
- Cover shared and duplicate APIs using emitted bundles, with independent iframe and worker
  initialization. Defer API version compatibility to the loaded API's registration.
- Reject re-entrant context-manager and propagator conflicts, and roll back only registrations
  still owned by the failed initialization.
- Clean up processors after early diagnostic, resource, or provider startup failures, and allow
  diagnostic initialization to be retried when registration fails.
- Keep cleanup running and preserve the startup error when diagnostic reporting throws.
- Remove newly installed routers when startup fails, without replacing existing owners.
- Keep global registrations provisional through instrumentation setup and finish context
  unregistration even when manager cleanup throws.
- Ignore empty connection-string fields so trailing semicolons and surrounding whitespace do not
  discard otherwise valid exporter configuration.
- Isolate telemetry pipelines per initialization: each instance owns its tracer and logger
  providers, instrumentations bind to their own instance, and global tracers and loggers bind to
  the earliest running instance that collects that signal when acquired.
- The prerelease browser lifecycle handle now includes the required `userContext` identity and
  persistence controls.
- Spans and logs without an application or resource `enduser.pseudo.id` now receive an anonymous
  one. Managed authenticated identity is applied only when neither the record nor its resource
  supplies `user.id`, `enduser.id`, or `user.account.id`. Azure Monitor envelopes map
  `enduser.pseudo.id`, `user.id`, `enduser.id`, and `user.account.id` to `ai.user.*` tags instead
  of custom dimensions.
- Empty application `session.id` attributes are now replaced with the managed session ID.
- Default OTLP span and log batch processors are created by the distribution so `forceFlush()`
  and page-hide flushing cover them.
- Suppress tracing of Azure Monitor export requests to prevent fetch instrumentation feedback loops.
- Correlate page views, spans, and logs through shared operation IDs while preserving explicit
  application span contexts.
- Fixed post-merge performance publishing for fork contributions by using the upstream
  workflow context while retaining merged-commit-only checkout and export safeguards.
- Added offline browser performance measurements and explicit result publishing after upstream
  pull requests merge into `main`, including minified, gzip, and Brotli bundle sizes.
- Run the complete unit and emitted-bundle integration suites across Chromium, Firefox, and WebKit,
  including the ESM, UMD, AMD, and IIFE browser bundles, and publish the supported-browser matrix.
- Replaced proposal-era README content with installation, initialization, configuration,
  instrumentation, OTLP, resource detection, bundle size, and published-alpha guidance.
- Cover page view and custom event e2e integration
- Enforce exporter payload limits and test unload delivery.
- Coalesce concurrent `forceFlush()` calls across trace and log processors.
- Report bundle size changes against PR base
- Populate empty Azure Monitor message bodies with `n/a` before ingestion.
- Publish minified, gzip, and Brotli measurements for every bundle-size scenario after merged
  pull requests so scenario regressions can be tracked over time.
- Add absolute size budgets for each published entry point, reported during alpha and
  enforced starting with beta.

## 0.1.0-alpha.1 - 2026-09-28

### Added

- Initial alpha release of the Microsoft OpenTelemetry distribution for browsers.
- Browser SDK initialization for tracing and logging with configurable processors, resources,
  context management, and propagation.
- Azure Monitor span and log exporters with connection-string configuration and unload flushing.
- Browser and user-agent resource detection.
- Page-view instrumentation and default browser instrumentations.
- Browser session management.
- Runnable Azure Monitor, console, and OTLP browser sample applications.
