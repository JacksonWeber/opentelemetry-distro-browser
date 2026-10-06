# OpenTelemetry Browser Distribution Implementation Plan

**Status:** Active
**Approach:** Greenfield browser distribution built on upstream OpenTelemetry APIs
**Shipped:** Milestone M0, published as `@microsoft/opentelemetry-browser@0.1.0-alpha.1`
**Prior evidence:** Multi-instance browser PoC in [`../poc/`](../poc/)
**Upstream alignment verified:** 2026-09-10 against
[`open-telemetry/opentelemetry-browser`](https://github.com/open-telemetry/opentelemetry-browser)
`main` @ `c0df3d6`

This document holds the *why*. Everything else has its own document.

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Global bridge, instance model, routing provider, instrumentation bridge, context, export, package layout, public API |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | The requirement set: lifecycle, correctness, configuration, performance, packaging, security, diagnostics, testing |
| [`M0_PLANNING.md`](M0_PLANNING.md) | The shipped alpha: what landed, what remains, and the M0 decisions |
| [`M1_PLANNING.md`](M1_PLANNING.md) | Customer-visible browser telemetry, reliability, privacy, multi-instance isolation and browser support |
| [`M2_PLANNING.md`](M2_PLANNING.md) | Supported browser bundle, CDN publishing and initialization snippet |
| [`M3_PLANNING.md`](M3_PLANNING.md) | Advanced configuration, optional integrations, and loader and delivery parity |
| [`../poc/SIZE_REPORT.md`](../poc/SIZE_REPORT.md) | Generated bundle size measurements |

## 1. Goal

A vendor-neutral OpenTelemetry distribution for browser applications, built on
upstream `@opentelemetry/api` and SDK contracts, solving the browser-specific
problems: composition, multi-instance isolation, instrumentation ownership,
lifecycle, performance and packaging.

Azure Monitor, OTLP and other destinations are exporters on the standard pipeline,
with Azure Monitor first-class.

Applications keep using normal OpenTelemetry APIs. Upstream instrumentations,
processors, exporters, samplers and propagators connect directly where the
contracts permit, and through narrow adapters only where a browser or
multi-instance boundary requires one.

## 2. Product Principles

| Principle | Decision |
|---|---|
| Upstream API first | `@opentelemetry/api` is the canonical API. No parallel tracing API, no duplicated OTel interfaces. |
| Signal choice follows upstream | Browser occurrences are **log records carrying a top-level `eventName`**. Spans are reserved for operations with real duration and backend correlation, primarily fetch/XHR. |
| Logs are a phase-1 signal | The Logs API and a routed `LoggerProvider` are core architecture, not a deferred signal. |
| No client-side aggregation | Emit high-fidelity events; let the backend derive metrics. No browser Metrics SDK ahead of an upstream decision. |
| Vendor neutral | Core packages carry no backend schema, connection strings or destination assumptions. |
| Multi-instance, one global router | One global routing provider routes acquisition to isolated instance providers; a tracer or logger stays bound to the instance chosen at `getTracer()` / `getLogger()` time. |
| Standard extensions, narrow bridges | Adapters only for lifecycle, routing, shared browser patches, or incompatible third-party contracts. |
| Explicit ownership, no silent fallback | Every patch, listener, processor and provider has an owner and a cleanup path. Routing, duplicate-global and lifecycle failures are diagnosed clearly. |
| Greenfield | Build on upstream packages and on the lessons of `ApplicationInsights-JS`, not on an SDK architecture designed for different constraints. |

## 3. PoC Findings

The multi-instance PoC is the evidence base. Full assertion list in
[`poc/README.md`](../poc/README.md).

**Settled.** One provider per signal can be registered with the real
`@opentelemetry/api` and `@opentelemetry/api-logs` and route to multiple logical
SDK instances. Instance selection happens during `getTracer()` / `getLogger()`
via an upstream `Context` value, and the returned tracer or logger keeps that
instance permanently - including when two consumers share a scope and when
upstream instrumentations are initialized inside an instance boundary.
Parent-child survives `await` with an explicit `Context`. Per-instance
`forceFlush()` and idempotent `shutdown()` work, with telemetry-after-shutdown
rejected with a diagnostic rather than silently dropped. W3C Trace Context and
Baggage round-trip across an instance boundary, and a pre-existing global OTel
SDK is detected, not overwritten.

**Constraint, not solved.** Instrumentations that patch a browser global cannot
run in more than one instance - two instances both enabling fetch report one
request twice - so a shared patch needs a designated owner until
[M1](M1_PLANNING.md). In
`@opentelemetry/browser-instrumentation` the shared-patch modules are
`navigation`, `console`, `fetch` and `xhr`; the rest attach isolated listeners or
observers and route cleanly.

**The PoC did not cover.** Automatic async context propagation; production export
over a real transport; duplicate `@opentelemetry/api` packages, iframes, workers,
and module federation. Milestone documents record the current ownership and
status of this work.

## 4. Upstream Browser Alignment

Verified 2026-09-10 against `open-telemetry/opentelemetry-browser` `main` @
`c0df3d6`. Re-verify before each phase; much of this is still moving.

1. **There is no browser-specific OTel API package**, and none is planned.
   `@opentelemetry/api` stays a peer dependency of both browser packages, so
   upstream-API-first is unchanged.
2. **Browser occurrences are events on the Logs API.**
   `@opentelemetry/browser-instrumentation` depends only on
   `@opentelemetry/api-logs`, and every occurrence instrumentation calls
   `logger.emit({ eventName, severityNumber, attributes })`.
3. **Spans are reduced, not removed.** fetch and XHR still produce
   `SpanKind.CLIENT` spans with `traceparent` injection. A logs-only
   distribution would diverge from upstream. Metrics are the signal actually
   displaced, and that choice is still contested upstream.
4. **Correlation is attribute-based**: `session.id` and
   `browser.document.url.full` stamped on every log and span, with timestamp
   proximity replacing click-to-request parenting. Browser events carry no trace
   context in practice.
5. **The foundations are unstable.** The logs packages are `0.x`, five of the
   seven browser event definitions are unmerged, and **page view has no semantic
   convention at all**. Mitigation: keep event names and attribute keys behind an
   internal mapping layer for distribution-owned browser instrumentation, so a
   convention change is a table edit rather than an instrumentation rewrite.

Several upstream facts invalidate earlier assumptions: the Events API was
removed and `event.name` is a top-level LogRecord field; Zone.js is abandoned, so
async parenting must be explicit; `WebTracerProvider` is deprecated in favor of
`BasicTracerProvider`; span-based user-interaction and document-load
instrumentation are being deprecated; and fetch/XHR instrumentation is moving out
of `opentelemetry-js` into `opentelemetry-browser`, which is the repository to
track.

## 5. Scope

M0 ([`M0_PLANNING.md`](M0_PLANNING.md)) is a single-instance subset of the initial
release, and it has shipped.

**Initial release.** A global multi-instance routing layer over
`@opentelemetry/api`, with isolated per-instance tracing **and logging**
pipelines behind the existing `useMicrosoftOpenTelemetry(options)` initializer
and `forceFlush()`/`shutdown()` lifecycle handle (plus M1 `userContext` controls). Manual tracing through the
OTel API and manual events through the Logs API with a top-level `eventName`.
Routed event-based instrumentation covering the upstream occurrence set, plus
span-based fetch/XHR with W3C Trace Context and Baggage propagation. Supported
ways to attach upstream processors and exporters for both signals and to
initialize upstream instrumentations, with safe ownership rules for shared
patches. `session.id` and page context on both signals. OTLP trace and log export
as the vendor-neutral reference path. ESM-first packages and bundles from one
source, with browser integration, compatibility, lifecycle, performance and
bundle tests.

**Later.** Browser metrics remain deferred until upstream settles its browser metrics decision and
aggregation, cardinality and export semantics. Advanced ApplicationInsights-JS parity is owned by
[M3](M3_PLANNING.md).

**Non-goals.** Reimplementing the OTel API or SDK. Building an Application
Insights SDK, or making a legacy AI API the primary surface. Coupling core
routing to a backend or wire format. Transparently supporting every browser
instrumentation in the first release, or claiming arbitrary multi-instance
auto-instrumentation is safe before shared patch behavior is proven. Hiding
unavoidable global OTel constraints from users.

## 6. Open Decisions

Milestone-scoped decisions live in the milestone that owns them:
[`M0_PLANNING.md`](M0_PLANNING.md),
[`M1_PLANNING.md`](M1_PLANNING.md),
[`M2_PLANNING.md`](M2_PLANNING.md) and
[`M3_PLANNING.md`](M3_PLANNING.md). What remains here is owned by no single milestone.

- **Whether property mangling is revisited, and on what threshold.** The current answer is no:
  readable source and safe property access outrank the bytes. It is reopened only against a measured
  threshold, and it would affect every published artifact at once, including the
  [M2 CDN bundle](M2_PLANNING.md).
