# Architecture

**Status:** Proposed. Part of the [implementation plan](IMPLEMENTATION_PLAN.md).

This is the original design proposal, not the current package or public API reference.
The provisional packages and interfaces below are not published APIs. See the
[configuration reference](../docs/configuration-reference.md) and
[public declarations](../src/types.ts) for the implemented contract.

How the distribution is put together: the global bridge, the instance model, the
routing provider, the instrumentation bridge, context, export, the package
layout, and the public API direction.

The signal model this architecture serves - logs-first for browser occurrences,
spans for fetch/XHR - is in
[section 4 of the plan](IMPLEMENTATION_PLAN.md#4-upstream-browser-alignment).

---
## 1. Shape of the system

```text
Applications and upstream instrumentations
                    |
      @opentelemetry/api + @opentelemetry/api-logs
                    |
      one global RoutingTracerProvider + RoutingLoggerProvider
                    |
     instance selected at getTracer() / getLogger()
              /                     \
             v                       v
   instance-bound tracer/logger A  instance-bound tracer/logger B
             |                       |
             v                       v
     upstream providers A     upstream providers B
     sampler/processors       sampler/processors
     resource/exporters       resource/exporters
             |                       |
             v                       v
       any OTel exporter       any OTel exporter
```

Both signals are routed by the same instance-selection mechanism and share one
instance registry, lifecycle, and diagnostics surface. An instance owns a tracer
provider, a logger provider, or both.

### 1.1 Global bridge

The global bridge owns the single registration with `@opentelemetry/api`
and `@opentelemetry/api-logs`. It contains:

- the routing `TracerProvider`;
- the routing `LoggerProvider`;
- an instance registry;
- the instance-selection context key;
- global ownership and conflict diagnostics;
- instrumentation initialization boundaries;
- coordinated bridge shutdown.

The bridge does not own backend configuration or implement span recording.

### 1.2 Instance

Each instance owns an independent upstream SDK pipeline:

- stable instance ID;
- resource;
- sampler;
- tracer provider;
- logger provider;
- span processors;
- log record processors;
- exporters;
- instrumentation registrations;
- propagator and context policy;
- session and document context providers;
- lifecycle state and diagnostics.

An instance must never read configuration or pipeline state from another
instance.

### 1.3 Routing provider and bound tracer or logger

`RoutingTracerProvider.getTracer()` resolves the current instance and delegates
to that instance's upstream provider. It returns a tracer permanently associated
with the selected instance/provider. `RoutingLoggerProvider.getLogger()` behaves
identically and returns an instance-bound logger. Binding rules, caching, and
failure behavior must match across both signals; a divergence between them is a
defect.

Production behavior must define:

- unknown or missing instance selection;
- tracer or logger acquisition before instance start;
- tracer or logger use after instance shutdown;
- instance replacement and ID reuse;
- instrumentation scope caching;
- provider and bridge shutdown races;
- an instance that enables only one of the two signals.

The default for missing selection should be explicit and observable. Whether it
throws, returns a non-recording tracer or logger, or routes to a configured
default instance is an API decision to settle before implementation, and it must
resolve the same way for both signals.

### 1.4 Instrumentation bridge

Many upstream instrumentations cache a tracer or logger at initialization and
patch realm-wide browser APIs. The bridge must distinguish two concerns:

1. **Provider binding:** initialize the instrumentation inside an instance
   selection boundary and provide that instance's routed tracer and logger
   providers.
2. **Patch ownership:** prevent unsafe duplicate wrapping of shared APIs such as
   `fetch`, XHR, History, and event listeners.

Event-based instrumentations that observe rather than patch - navigation timing,
resource timing, web vitals, user actions, global error handlers - use
`PerformanceObserver` and global listeners instead of monkey patching. They
still need explicit ownership and cleanup, and multiple instances observing the
same browser-global source must not duplicate or cross-route emitted records.

The bridge should accept upstream `InstrumentationOption` values. It must not
invent a second general-purpose instrumentation interface.

Potential shared-patch models to evaluate:

- one instrumentation owner routes produced spans according to active instance;
- one patch fans out to explicitly selected instance pipelines;
- only one instance may own a given patch type;
- unsupported multi-owner combinations fail during initialization.

Do not choose a universal model before the fetch/XHR spike establishes its
correctness and context behavior.

### 1.5 Context

The design has two separate context needs:

- selecting an instance while a tracer or instrumentation is initialized;
- carrying active span context during application work.

Both use upstream `Context`; neither should introduce a proprietary context
object. Because browser async context propagation is incomplete, support must
be stated precisely:

- synchronous `context.with()` behavior;
- explicit context passed across `await`;
- callbacks bound through an enabled context manager;
- instrumentation-specific propagation behavior;
- future platform mechanisms only after browser support is sufficient.

### 1.6 Export

Instance pipelines accept standard OTel `SpanProcessor`, `LogRecordProcessor`,
and exporter contracts. OTLP is the initial end-to-end reference exporter for
both traces and logs because it keeps the distribution backend-neutral.

Log export defaults differ from traces upstream (a shorter batch delay), and
browser events must survive page hide and unload. Batch configuration, flush on
`visibilitychange`, and unload behavior are per-signal decisions, not one shared
default.

Azure Monitor/Application Insights, Zipkin, Jaeger-compatible gateways, vendor
agents, and custom collectors are integrations, not core architecture.

## 2. Proposed packages

Names are provisional.

| Package | Responsibility |
|---|---|
| `@microsoft/otel-browser` | Public distribution factory, defaults, instance lifecycle, and convenience composition. |
| `@microsoft/otel-browser-router` | Global providers, instance registry, bound tracers and loggers, and routing lifecycle. |
| `@microsoft/otel-browser-instrumentation` | Upstream instrumentation initialization and shared-patch ownership. |
| `@microsoft/otel-browser-semconv` | Internal mapping layer for browser event names and attribute keys, isolating unstable upstream semantic conventions. |
| `@microsoft/otel-browser-testing` | Test exporters, fixtures, browser harnesses, and conformance helpers. |
| `@microsoft/otel-browser-loader` | Deferred CDN loading and unsupported-browser policy. |

Backend exporters should remain their existing upstream/vendor packages whenever
possible. A backend-specific bridge belongs in a separate package and must
depend on the distribution, never the reverse.

## 3. Public API direction

The distribution API manages instances while exposing upstream types:

```ts
import type {
  ContextManager,
  TextMapPropagator,
} from "@opentelemetry/api";
import type { InstrumentationOption } from "@opentelemetry/instrumentation";
import type {
  Sampler,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type {
  LogRecordExporter,
  LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { Resource } from "@opentelemetry/resources";

export interface BrowserTelemetryInstanceConfig {
  id: string;
  resource?: Resource;
  sampler?: Sampler;
  spanProcessors?: SpanProcessor[];
  exporters?: SpanExporter[];
  logRecordProcessors?: LogRecordProcessor[];
  logRecordExporters?: LogRecordExporter[];
  propagator?: TextMapPropagator;
  contextManager?: ContextManager;
  instrumentations?: InstrumentationOption[];
}

export interface ResolvedBrowserTelemetryInstanceConfig {
  readonly id: string;
  readonly resource: Resource;
  readonly sampler: Sampler;
  readonly spanProcessors: readonly SpanProcessor[];
  readonly logRecordProcessors: readonly LogRecordProcessor[];
  readonly propagator: TextMapPropagator;
  readonly contextManager: ContextManager;
  readonly instrumentations: readonly InstrumentationOption[];
}

export interface BrowserTelemetryInstanceStats {
  readonly state: "created" | "starting" | "running" | "stopping" | "stopped";
  readonly activeInstrumentationCount: number;
  readonly droppedSpanCount: number;
  readonly droppedLogRecordCount: number;
  readonly lastFlushResult?: "success" | "failure" | "timeout";
}

export interface BrowserTelemetryDistributionInfo {
  readonly version: string;
  readonly apiVersion: string;
  readonly loadMethod: "npm" | "cdn" | "dynamic";
}

export interface BrowserTelemetryInstance {
  readonly id: string;
  start(): Promise<void>;
  run<T>(callback: () => T): T;
  getConfigSnapshot(): Readonly<ResolvedBrowserTelemetryInstanceConfig>;
  getStats(): Readonly<BrowserTelemetryInstanceStats>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BrowserTelemetryDistribution {
  readonly info: BrowserTelemetryDistributionInfo;
  createInstance(
    config: BrowserTelemetryInstanceConfig,
  ): BrowserTelemetryInstance;
  getInstance(id: string): BrowserTelemetryInstance | undefined;
  hasInstance(id: string): boolean;
  listInstanceIds(): readonly string[];
  getInstanceCount(): number;
  shutdown(): Promise<void>;
}

export function createBrowserTelemetryDistribution():
  BrowserTelemetryDistribution;
```

This is a design sketch, not a committed API. M1 must align exact contracts
with the selected upstream package versions and decide whether exporters are
wrapped into processors automatically or processors remain the only pipeline
input.

Later management APIs must retain upstream instrumentation types while exposing
owned lifecycle operations:

```ts
export interface BrowserInstrumentationManager {
  load(
    id: string,
    instrumentation: InstrumentationOption,
  ): Promise<InstrumentationLoadResult>;
  get(id: string): InstrumentationOption | undefined;
  list(): readonly InstrumentationRegistration[];
  isLoaded(id: string): boolean;
  unload(id: string): Promise<void>;
}

export interface TelemetryTransformRegistration {
  remove(): void;
}
```

The transform/filter contract must define signal type, synchronous execution,
ordering, rejection, mutation versus replacement, exception behavior, and cost
budget before it becomes public.
