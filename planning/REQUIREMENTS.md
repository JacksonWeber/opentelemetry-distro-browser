# Cross-Cutting Requirements

**Status:** Proposed. Part of the [implementation plan](IMPLEMENTATION_PLAN.md).

Requirements that apply across every phase rather than to one of them: upstream
compatibility, vendor neutrality, lifecycle, correctness, configuration,
performance, packaging, browser and loader policy, security and privacy,
diagnostics, testing, and documentation. This is the working requirement set —
every implementation item should trace to something here.

Bundle size numbers are generated, not written down: see
[`../poc/SIZE_REPORT.md`](../poc/SIZE_REPORT.md) and the size harness that
produces it.

---

### Upstream compatibility

- Inspect current upstream contracts before every implementation phase.
- Track `open-telemetry/opentelemetry-browser` as the upstream source of truth
  for browser instrumentation and SDK direction, and re-verify the upstream alignment in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md#4-upstream-browser-alignment) at the
  start of each phase.
- Pin supported versions and test the full declared range.
- Avoid imports from upstream internal paths.
- Prefer contributing required fixes upstream over maintaining local forks.
- Any upstream divergence needs an ADR, tests, benchmark, and maintenance owner.
- Emit events through the Logs API with a top-level `eventName`. Do not target an
  Events API; `@opentelemetry/api-events` and `@opentelemetry/sdk-events` were
  removed upstream.
- Build on `BasicTracerProvider`; `WebTracerProvider` is deprecated.
- Do not use Zone.js or any equivalent global async-context patch. Async parenting
  is explicit.
- Route distribution-owned browser instrumentation event names and attribute
  keys through an internal semantic-conventions mapping layer rather than
  hard-coding them at call sites. Application-supplied standard OpenTelemetry
  telemetry is not remapped by this layer.

### Vendor neutrality and layering

- Core packages carry no backend schema, connection string, envelope type or
  destination assumption. OTLP is the reference export path; Azure Monitor is one
  optional exporter integration.
- Core routing must not know about backend envelopes. Transform and filter hooks
  operate on OTel-native signal data; any backend envelope mutation belongs to
  that exporter package.
- Keep no Application Insights configuration or tracking-API compatibility
  mapping in core. Legacy Application Insights tracking APIs are out of scope.
- Import supported public upstream packages directly and expose upstream types.
  Do not reimplement parallel OTel-shaped interfaces, and do not wrap
  `getTracer`, `getLogger` or `getMeter` in proprietary getters — applications
  call the upstream API.
- Expose the minimum standard upstream objects needed for composition; keep
  distribution internals encapsulated. Distribution-specific interfaces exist only
  for routing, ownership, lifecycle and diagnostics and, if selected by M3,
  loader behavior.
- Compose upstream samplers, processors, propagators, resources, baggage and ID
  generators rather than reimplementing them.
- Register exactly one minimal distribution-owned global for routing and context.
  All other pipeline, instance and backend state stays behind its owned registry.

### Lifecycle

- Startup is transactional and rolls back partial work.
- Every distribution-created resource is owned by the distribution or one
  instance. Ownership of application-supplied resources is explicit.
- Instance shutdown does not affect unrelated instances.
- Distribution shutdown disables owned instrumentations before providers.
- `forceFlush()` and `shutdown()` have explicit timeout and error contracts.
- No spans or log records are accepted after the owning instance reaches
  shutdown.

### Correctness

- Instance selection cannot be inferred from mutable process-global variables.
- A tracer never changes its owning instance.
- A logger never changes its owning instance.
- Instrumentation scope name/version/schema URL remain intact.
- A log record's `eventName`, severity, body, attributes, and observed and
  recorded timestamps pass through routing without semantic changes.
- Parent trace identity, trace flags, trace state, links, events, attributes, and
  status pass through routing without semantic changes.
- No error path silently reroutes telemetry to another instance.

### Configuration

- Validate all required dependencies before registering globals, patching browser
  APIs, starting timers, or creating exporters.
- Treat caller configuration as input, not shared mutable state. Normalize it
  into an instance-owned immutable snapshot.
- Inject resources, samplers, processors, exporters, propagators, context
  policy, diagnostics, clocks, and platform capabilities.
- Publish defaults and distinguish omitted values from invalid values.
- M3 defines any runtime-mutable field set explicitly; all other changes require
  instance replacement or a documented provider restart.
- M3 runtime updates apply atomically: validate, prepare, commit, then dispose
  replaced resources. They roll back on failure.
- Every M3 configuration subscription returns a removal/disposal handle that is
  released during instance shutdown.
- Never expose mutable processor, exporter, instrumentation, or resource arrays
  through configuration snapshots.
- M3 tests concurrent update, update-during-flush, update-during-shutdown, failed
  update rollback, and subscription cleanup.

### Performance

The browser frame-budget guideline remains 5 ms. Initial p95 targets, subject to
M1 baselines:

| Measure | Target |
|---|---|
| Routing overhead on `getTracer()` p95 | Under 0.05 ms beyond upstream provider cost |
| Routing overhead on `getLogger()` p95 | Under 0.05 ms beyond upstream provider cost |
| Bound-tracer span start overhead p95 | Under 0.02 ms beyond upstream tracer cost |
| Bound-logger `emit()` overhead p95 | Under 0.02 ms beyond upstream logger cost |
| Distribution initialization p95 | Under 5 ms excluding instrumentation patching and network |
| End-to-end span creation p95 | Under 0.1 ms |
| Attribute addition p95 | Under 0.05 ms |
| Context propagation p95 | Under 0.1 ms |
| Span completion/processor handoff p95 | Under 0.2 ms |
| Idle work | No continuous distribution-owned timers |
| Bundle size | Separate budgets for router, distribution core, and instrumentation presets |

- Establish minified, gzip, and Brotli byte baselines in M1 for the router alone,
  minimum manual-tracing distribution, default tracing preset, and each
  instrumentation preset.
- If M3 selects advanced loader or no-op artifacts, establish separate minified,
  gzip, and Brotli baselines and budgets for them before implementation.
- Each milestone sets blocking absolute budgets and permitted percentage growth
  before declaring its owned artifacts complete. After those budgets are
  established, releases of the owned artifacts report minified, gzip, and
  Brotli sizes and identify dependency contributors.
- Test tree shaking with representative Vite, webpack, Rollup, and esbuild
  applications. Importing the router must not pull instrumentations, exporters,
  loaders, or backend bridges into the bundle. Traces and logs must be
  independently importable so an events-only consumer never pays for the tracing
  SDK, and a tracing-only consumer never pays for the logs SDK.
- Mark package side effects precisely; do not rely on import-time global
  registration.
- Keep instrumentation and exporter presets opt-in and independently importable.
- Start timers only for pending work, coalesce timers per owner when possible,
  and stop them immediately when queues empty or shutdown begins. Continuous
  interval timers are prohibited.
- Use lazy maps, provider creation, and caches only where measurements justify
  them.
- Prefer upstream batching. Any custom queue must be bounded and benchmarked.
- Treat object pooling as an experiment requiring allocation-profile evidence,
  semantic conformance tests, memory-retention tests, and a measurable win.
- Optional performance hooks use injected clocks/observers, remain disabled by
  default, and cannot emit recursive telemetry.

### Packaging and bundle size

- Publish ESM-first packages with explicit `exports`, type declarations, source
  maps, license data, and verified side-effect metadata.
- Keep router, distribution core, instrumentation presets, testing utilities,
  and backend integrations in separate entry points or packages. If M3 selects
  loader or no-op artifacts, package them separately from the full distribution.
- Do not duplicate upstream API or SDK implementations to avoid version and byte
  cost.
- Run dependency duplication checks, especially for `@opentelemetry/api`.
- Reject dependencies that introduce unowned globals, unnecessary Node
  polyfills, unsafe dynamic evaluation, or disproportionate browser cost.
- Track minimum and preset bundles independently; a large optional integration
  must not consume the core budget.
- Generate a machine-readable size report and compare it against the base branch
  in CI.

### Browser and loader policy

The previous browser targets remain provisional requirements until
[M1](M1_PLANNING.md) declares the npm target and publishes the browser matrix.
[M2](M2_PLANNING.md) owns the supported browser bundle, immutable versioned CDN
publication, and asynchronous initialization snippet. [M3](M3_PLANNING.md) owns
any capability-detecting loader, no-op or unsupported-browser package,
alternate-domain fallback, and other advanced loader behavior.

| Runtime | Planned treatment |
|---|---|
| Browsers in the M1 support matrix | npm distribution and M2 browser bundle |
| Browsers outside the M1 support matrix | Unsupported by default; an optional M3 loader or no-op package only if selected |

- M1 publishes an exact Chrome, Edge, Firefox, and Safari version matrix; each
  subsequent release publishes its applicable matrix.
- The full distribution contains no legacy no-op branches.
- If M3 selects a capability-detecting loader, detection happens before
  downloading the full distribution.
- If M3 selects a no-op or unsupported-browser package, it is API-compatible
  only with the distribution lifecycle surface and makes its disabled state
  observable.
- The M2 snippet initializes asynchronously and reports success or failure;
  consumers do not rely on a synchronous return while the browser bundle loads.
- M1 validates npm and current bundles against their declared browser and
  packaging contracts. M2 validates the supported CDN and snippet path for CSP,
  integrity, caching, cross-origin loading, and load failures. M3 validates any
  advanced loader, no-op, unsupported-browser, or fallback paths it selects.

### Security and privacy

- Core routing must not inspect or transform telemetry payloads.
- Instrumentation presets document every automatically collected field.
- Cross-origin propagation is opt-in through explicit allow lists.
- Never collect request/response bodies, credentials, or auth headers by default.
- Bound attributes, events, links, queues, retries, and payloads through upstream
  or integration configuration.
- Threat-model global registration, monkey patching, prototype interaction,
  supply-chain dependencies, and untrusted instance identifiers.
- Diagnostics never include secrets or raw telemetry payloads.

### Diagnostics

- Define stable codes for global conflicts, routing, lifecycle,
  instrumentation ownership, context limitations, and extension failures.
- Support an injected diagnostic sink and interoperability with upstream `diag`;
  do not require an Application Insights diagnostics implementation.
- Diagnostics must identify the responsible instance when safe.
- Diagnostic output must not recursively emit telemetry.
- Library code does not silently fall back to `console`; any development console
  sink is explicitly configured.
- Unsupported combinations fail early rather than degrading into cross-routing.

### Testing

- Track all distributions, instances, global registrations, instrumentations,
  patches, listeners, timers, config subscriptions, processors, exporters, and
  queues created by a test.
- Fail the test automatically when any tracked resource remains owned after
  cleanup, and report its type, owner instance, and allocation site when
  available.
- Collect and publish code coverage for every production package.
- Unit tests for routing, startup state transitions and rollback, caching, and
  conflicts.
- Contract tests against supported upstream OTel versions.
- Real-browser tests for supported Chrome, Edge, Firefox, and Safari versions.
- Two-instance overlapping-operation tests derived from the PoC.
- Multi-instance tests using identical instrumentation scope names.
- Multi-instance tests asserting log records with identical `eventName` values
  stay in their own pipelines.
- Shared-source tests for observer-based event instrumentation, asserting a
  single `PerformanceObserver` or global listener does not duplicate or
  cross-route records across instances.
- Shared-patch tests for fetch, XHR, history, timers, and DOM events.
- Repeated startup/shutdown and fake-timer leak tests.
- Duplicate-package, module-federation, iframe, and worker tests.
- OTLP collector integration tests.
- Performance and bundle-size regression gates.
- M3 dynamic configuration success, validation and invalid updates,
  failed-update rollback, concurrency, and cleanup tests for every
  runtime-mutable field.
- Failure tests for invalid configuration, prior global registration, exporter
  rejection, partial startup, unload during export, and stale tracer use.

### Documentation and API governance

- Generate API reports and complete TypeDoc for every public distribution-owned
  type, method, option, lifecycle transition, error, and example.
- Publish package/version compatibility, browser support, instrumentation
  ownership, context support, topology, and optional integration matrices.
- Include npm, bundler, collector, multi-instance, explicit async-context, flush,
  shutdown, and CDN examples where applicable.
- Public API changes require review; experimental APIs are labeled and isolated
  from stable entry points.
- Document unsupported behavior directly rather than relying on no-op fallbacks.
