# Changelog

All notable changes to this package are documented in this file.

## 0.1.0-alpha.2 - Unreleased

### Added

- Add shared deterministic test fixtures and informational PR coverage comparisons.
- Promote the size harness into a repository tool
- Map page view ID and referrer to Azure Monitor envelopes

### Changed

- Fixed post-merge performance publishing for fork contributions by using the upstream
  workflow context while retaining merged-commit-only checkout and export safeguards.
- Added offline browser performance measurements and explicit result publishing after upstream
  pull requests merge into `main`, including minified, gzip, and Brotli bundle sizes.
- Replaced proposal-era README content with installation, initialization, configuration,
  instrumentation, OTLP, resource detection, bundle size, and published-alpha guidance.
- Cover page view and custom event e2e integration
- Enforce exporter payload limits and test unload delivery.
- Coalesce concurrent `forceFlush()` calls across trace and log processors.
- Report bundle size changes against PR base
- Populate empty Azure Monitor message bodies with `n/a` before ingestion.
- Publish minified, gzip, and Brotli measurements for every bundle-size scenario after merged
  pull requests so scenario regressions can be tracked over time.

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
