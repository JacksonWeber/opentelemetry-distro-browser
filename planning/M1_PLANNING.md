# Milestone M1 - Planning

Make the distribution safe to run more than once on a page, and declare the browsers the npm
package supports. M1 also covers the main scenarios already described in
[`REQUIREMENTS.md`](REQUIREMENTS.md).

Status: not started. The M0 public surface does not change.

## Foundation

Multi-instance support is the foundation for everything else in this milestone.

- The upstream SDK calls `setGlobalLoggerProvider`, `setGlobalTracerProvider`,
  `setGlobalPropagator` and `setGlobalContextManager`, which are once-only in the OpenTelemetry API,
  so a second instance silently joins the first one's pipeline.
- `fetch`, `xhr`, `navigation` and `console` patch globals, so enabling them twice wraps the wrapper
  and duplicates telemetry. The fix is one patch, many subscribers.
- The npm package targets ES2022. ES5 is a CDN-bundle-only concern owned by
  [M2](M2_PLANNING.md), because upstream dependencies ship ES2015+.

## Work items

| Item | Description | Status |
| --- | --- | --- |
| Graduate the PoC | Port the overlapping two-instance scenario into the package layout with real pipelines, and turn its browser checks into acceptance tests | Not started |
| Routing providers | One routing tracer provider and one routing logger provider owning the global registration, selecting the instance at `getTracer()`/`getLogger()` through an upstream `Context` value | Not started |
| Routing edge cases | Unknown or missing instance, acquisition before start, instance replacement and ID reuse, scope caching, shutdown races, single-signal instances | Not started |
| Global conflict diagnostics | Report a foreign provider rather than overwriting it | Not started |
| Patch arbitration | One patch per global with many subscribers, each receiving its own routed telemetry | Not started |
| Instrumentation binding | Bind instrumentations to the routed providers at enable time, for both signals | Not started |
| Per-instance context processors | `session.id` and document/page context stamped per instance on both signals | Not started |
| Instance lifecycle | Bridge state machine, instance registry, transactional startup with reverse-order rollback | Not started |
| Shutdown semantics | Per-instance flush and idempotent shutdown, coordinated distribution shutdown, no telemetry accepted afterwards | Not started |
| Leak stress tests | Repeated create/start/use/flush/shutdown loops failing on any hook, timer or subscription left behind | Not started |
| Context and propagation | Explicit context across async boundaries, W3C Trace Context and Baggage with cross-origin allow lists, published support matrix | Not started |
| Coexistence | Foreign providers, duplicate `@opentelemetry/api` copies, module federation, iframes and workers, multiple copies of this distribution | Not started |
| Browser support | `browserslist` in `package.json`, a published Chrome/Edge/Firefox/Safari matrix, and CI gating against real browsers | Not started |
| Bundle budgets | Blocking per-entry-point gzip and Brotli budgets and per-layer baselines on top of the M0 size harness | Not started |
| Per-instance pipelines | Simple and batch processors, OTLP/HTTP export through a Collector, custom processors, exporters, samplers and ID generators without wrappers | Not started |
| Export edge cases | Bounded queues, page hide, unload, offline transitions and failed exports, per instance | Not started |

Open question: whether a server-issued `traceparent` may root the page trace.
