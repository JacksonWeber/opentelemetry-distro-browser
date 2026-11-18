// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, DiagLogLevel, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import {
  BatchLogRecordProcessor,
  SimpleLogRecordProcessor,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { isTracingSuppressed } from "@opentelemetry/core";
import { afterEach, expect, it, vi } from "vitest";
import { createCustomerSdkStats } from "../../../src/exporter/customerSdkStats.js";
import { createInternalSdkStats, reportFailure } from "../../../src/exporter/sdkStats.js";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowserDiagnosticsOptions,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { claimInstrumentations } from "../../../src/instrumentation/sharedBrowserPatches.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";
import {
  getRegisteredGlobal,
  getSharedRegistry,
  isReportingSdkStats,
  reportWithoutTelemetry,
} from "../../../src/shared/globalOwnership.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";
import { installFakeClock } from "../../fixtures/clock.js";
import { createConsolePipeline, createInMemoryPipeline } from "../../fixtures/telemetry.js";

const owners: Array<{ shutdown(): Promise<void> }> = [];
const instrumentations: ConsoleInstrumentation[] = [];

afterEach(async () => {
  for (const instrumentation of instrumentations.splice(0)) instrumentation.disable();
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  Reflect.deleteProperty(globalThis, Symbol.for("@microsoft/opentelemetry-browser"));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { name: "simple", Processor: SimpleLogRecordProcessor },
  { name: "batch", Processor: BatchLogRecordProcessor },
])(
  "keeps reporter failure diagnostics out of standalone $name processors without a context manager",
  async ({ Processor }) => {
    context.disable();
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", transport);
    const { exporter, provider, instrumentation } = createConsolePipeline(Processor);
    owners.push(provider);
    instrumentations.push(instrumentation);
    const wrappedWarn = console.warn;
    vi.spyOn(diag, "warn").mockImplementation((...args) => console.warn(...args));
    const customerStats = createCustomerSdkStats(
      { enabled: true },
      TEST_INSTRUMENTATION_KEY,
      "https://customer.example.test",
    )!;
    const internalStats = createInternalSdkStats(
      {
        instrumentationKey: TEST_INSTRUMENTATION_KEY,
        endpoint: "https://stats.example.test/v2/track",
      },
      TEST_INSTRUMENTATION_KEY,
      "https://customer.example.test",
    );
    owners.push(customerStats, internalStats);
    customerStats.count("Success", "TRACE");
    internalStats.countResponse(200, 10);
    await Promise.all([customerStats.forceFlush(), internalStats.forceFlush()]);
    await provider.forceFlush();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(diag.warn).toHaveBeenCalledTimes(2);
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    expect(console.warn).toBe(wrappedWarn);
    console.warn("application warning");
    await provider.forceFlush();
    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
  },
);

it.each([false, true])(
  "guards direct diagnostic log emission through a logs-only distribution: %s",
  async (logsOnly) => {
    const pipeline = createInMemoryPipeline();
    const instance = await startTelemetryInstance({
      resourceAttributes: {},
      spanProcessors: logsOnly ? [] : pipeline.options.spanProcessors,
      logRecordProcessors: pipeline.options.logRecordProcessors,
    });
    owners.push(instance, pipeline);
    instance.commit();
    const logger = instance.loggerProvider.getLogger("diagnostic");
    vi.spyOn(diag, "warn").mockImplementation(() => logger.emit({ body: "stats failed" }));
    reportFailure(new Error("stats failed"));
    logger.emit({ body: "application" });
    await pipeline.forceFlush();
    expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
      "application",
    ]);
    expect(isReportingSdkStats()).toBe(false);
  },
);

it.each(["normal", "throwing", "nested"] as const)(
  "bypasses standalone console instrumentation beneath a shared patch for %s diagnostics",
  async (mode) => {
    context.disable();
    const original = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { exporter, provider, instrumentation: standalone } = createConsolePipeline();
    owners.push(provider);
    instrumentations.push(standalone);
    const standaloneWarn = console.warn;
    const pipeline = createInMemoryPipeline();
    const handle = await useMicrosoftOpenTelemetry({
      spanProcessors: [],
      logRecordProcessors: pipeline.options.logRecordProcessors,
      pageView: { enabled: false },
      session: { enabled: false },
      storage: { enabled: false },
      instrumentations: [new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] })],
    });
    owners.push(handle, pipeline);
    const sharedWarn = console.warn;
    try {
      expect(sharedWarn).not.toBe(standaloneWarn);
      expect(getRegisteredGlobal("context")).toBeUndefined();
      let nested = false;
      let nestedGuard: boolean | undefined;
      vi.spyOn(diag, "warn").mockImplementation(() => {
        console.warn("stats failure");
        if (mode === "nested" && !nested) {
          nested = true;
          reportFailure(new Error("nested stats failure"));
          nestedGuard = isReportingSdkStats();
        }
        if (mode !== "normal") throw new Error("diagnostic logger failed");
      });
      console.warn("before diagnostic");
      expect(() => reportFailure(new Error("stats failure"))).not.toThrow();
      expect(console.warn).toBe(sharedWarn);
      expect(isReportingSdkStats()).toBe(false);
      if (mode === "nested") expect(nestedGuard).toBe(true);
      console.warn("after diagnostic");
      await Promise.all([provider.forceFlush(), handle.forceFlush()]);
      expect(exporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
        "before diagnostic",
        "after diagnostic",
      ]);
      expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
        "before diagnostic",
        "after diagnostic",
      ]);
      expect(original).toHaveBeenCalledTimes(2);
      expect(diag.warn).toHaveBeenCalledTimes(mode === "nested" ? 2 : 1);
      await handle.shutdown();
      expect(console.warn).toBe(standaloneWarn);
      console.warn("standalone after shutdown");
      await provider.forceFlush();
      expect(exporter.getFinishedLogRecords()).toHaveLength(3);
    } finally {
      await handle.shutdown();
      standalone.disable();
    }
    expect(console.warn).toBe(standaloneWarn);
  },
);

it.each(
  ["normal", "throwing", "nested"].flatMap((mode) =>
    [false, true].map((restartDuringReport) => ({ mode, restartDuringReport })),
  ),
)(
  "preserves console wrappers for $mode diagnostics with in-callback restart $restartDuringReport",
  async ({ mode, restartDuringReport }) => {
    context.disable();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { exporter, provider, instrumentation: standalone } = createConsolePipeline();
    owners.push(provider);
    instrumentations.push(standalone);
    const standaloneWarn = console.warn;
    const pipeline = createInMemoryPipeline();
    const shared = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
    const handle = await useMicrosoftOpenTelemetry({
      spanProcessors: [],
      logRecordProcessors: pipeline.options.logRecordProcessors,
      pageView: { enabled: false },
      session: { enabled: false },
      storage: { enabled: false },
      instrumentations: [shared],
    });
    owners.push(handle, pipeline);
    const patch = getSharedRegistry().browserPatches?.targets.get(console)?.get("warn");
    expect(patch?.wrapper).toBe(console.warn);
    vi.spyOn(diag, "warn").mockImplementationOnce(() => {
      console.warn("stats failure before teardown");
      shared.disable();
      if (restartDuringReport) shared.enable();
      if (mode === "nested") {
        reportWithoutTelemetry(() => console.warn("nested stats failure"));
      }
      if (mode === "throwing") throw new Error("diagnostic logger failed");
    });
    expect(() => reportFailure(new Error("stats failed"))).not.toThrow();
    if (restartDuringReport) {
      const replacement = getSharedRegistry().browserPatches?.targets.get(console)?.get("warn");
      expect(replacement).not.toBe(patch);
      expect(replacement?.original).toBe(standaloneWarn);
      expect(replacement?.descriptor).toEqual(patch?.descriptor);
      expect(console.warn).toBe(replacement?.wrapper);
    } else {
      expect(getSharedRegistry().browserPatches?.targets.get(console)?.has("warn")).toBe(false);
      expect(console.warn).toBe(standaloneWarn);
      console.warn("standalone after teardown");
      shared.enable();
    }
    expect(isReportingSdkStats()).toBe(false);
    expect(console.warn).not.toBe(patch?.wrapper);
    console.warn("application after restart");
    vi.mocked(diag.warn).mockImplementation((...args) => console.warn(...args));
    reportFailure(new Error("stats failed after restart"));
    await Promise.all([provider.forceFlush(), handle.forceFlush()]);
    const standaloneMessages = [
      ...(restartDuringReport ? [] : ["standalone after teardown"]),
      "application after restart",
    ];
    expect(exporter.getFinishedLogRecords().map((record) => record.body)).toEqual(
      standaloneMessages,
    );
    expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
      "application after restart",
    ]);
    await handle.shutdown();
    expect(console.warn).toBe(standaloneWarn);
    expect(Object.getOwnPropertyDescriptor(console, "warn")).toEqual(patch?.descriptor);
    console.warn("standalone after shutdown");
    await provider.forceFlush();
    expect(exporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
      ...standaloneMessages,
      "standalone after shutdown",
    ]);
  },
);

it.each(["normal", "throwing", "nested"] as const)(
  "bypasses retired shared wrappers between standalone console pipelines for %s diagnostics",
  async (mode) => {
    context.disable();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = createConsolePipeline();
    owners.push(first.provider);
    instrumentations.push(first.instrumentation);
    const pipeline = createInMemoryPipeline();
    const shared = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
    const handle = await useMicrosoftOpenTelemetry({
      spanProcessors: [],
      logRecordProcessors: pipeline.options.logRecordProcessors,
      pageView: { enabled: false },
      session: { enabled: false },
      storage: { enabled: false },
      instrumentations: [shared],
    });
    owners.push(handle, pipeline);
    const second = createConsolePipeline();
    owners.push(second.provider);
    instrumentations.unshift(second.instrumentation);
    const outerWarn = console.warn;
    vi.spyOn(diag, "warn")
      .mockImplementation((...args) => console.warn(...args))
      .mockImplementationOnce(() => {
        shared.disable();
        shared.enable();
        console.warn("stats failure during restart");
        if (mode === "nested") reportFailure(new Error("nested stats failure"));
        if (mode === "throwing") throw new Error("diagnostic logger failed");
      });
    console.warn("before diagnostic");
    reportFailure(new Error("stats failure during restart"));
    reportFailure(new Error("stats failure after restart"));
    console.warn("after diagnostic");
    await Promise.all([
      first.provider.forceFlush(),
      second.provider.forceFlush(),
      handle.forceFlush(),
    ]);
    for (const exporter of [first.exporter, second.exporter, pipeline.logExporter]) {
      expect(exporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
        "before diagnostic",
        "after diagnostic",
      ]);
    }
    await handle.shutdown();
    expect(console.warn).toBe(outerWarn);
    reportFailure(new Error("stats failure after shutdown"));
    console.warn("standalone after shutdown");
    await Promise.all([first.provider.forceFlush(), second.provider.forceFlush()]);
    for (const exporter of [first.exporter, second.exporter]) {
      expect(exporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
        "before diagnostic",
        "after diagnostic",
        "standalone after shutdown",
      ]);
    }
  },
);

it("preserves an explicit console replacement installed during a diagnostic restart", () => {
  const { provider, instrumentation: standalone } = createConsolePipeline();
  owners.push(provider);
  instrumentations.push(standalone);
  const standaloneWarn = console.warn;
  const shared = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
  const release = claimInstrumentations([shared]);
  owners.push({ shutdown: async () => release() });
  const replacement = vi.fn();
  shared.enable();
  try {
    reportWithoutTelemetry(() => {
      shared.disable();
      console.warn = replacement;
      shared.enable();
    });
    expect(getSharedRegistry().browserPatches?.targets.get(console)?.get("warn")?.original).toBe(
      replacement,
    );
    console.warn("application warning");
    expect(replacement).toHaveBeenCalledExactlyOnceWith("application warning");
    shared.disable();
    expect(console.warn).toBe(replacement);
  } finally {
    shared.disable();
    console.warn = standaloneWarn;
  }
});

it("preserves a shared console patch still owned by another instrumentation after diagnostics", () => {
  const { provider, instrumentation: standalone } = createConsolePipeline();
  owners.push(provider);
  instrumentations.push(standalone);
  const standaloneWarn = console.warn;
  const first = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
  const second = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
  const release = claimInstrumentations([first, second]);
  owners.push({ shutdown: async () => release() });
  first.enable();
  second.enable();
  const sharedWarn = console.warn;
  reportWithoutTelemetry(() => first.disable());
  expect(console.warn).toBe(sharedWarn);
  expect(
    getSharedRegistry().browserPatches?.targets.get(console)?.get("warn")?.subscribers.size,
  ).toBe(1);
  second.disable();
  expect(console.warn).toBe(standaloneWarn);
});

it("restores console instrumentation when a stats diagnostic logger throws", () => {
  const instrumentation = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
  instrumentation.enable();
  instrumentations.push(instrumentation);
  const wrappedWarn = console.warn;
  vi.spyOn(diag, "warn").mockImplementation(() => {
    throw new Error("logger failed");
  });
  expect(() => reportFailure(new Error("stats failed"))).not.toThrow();
  expect(console.warn).toBe(wrappedWarn);
});

it.each([1, 2, 3].flatMap((version) => [false, true].map((previous) => ({ version, previous }))))(
  "restores version $version diagnostic guards after nested errors with previous value $previous",
  ({ version, previous }) => {
    const registry = { version, reportingSdkStats: previous };
    Reflect.set(globalThis, Symbol.for("@microsoft/opentelemetry-browser"), registry);
    const compatible = version === 1 || version === 2;
    expect(isReportingSdkStats()).toBe(compatible && previous);
    expect(() =>
      reportWithoutTelemetry(() => {
        // Legacy application providers read this flag directly, including custom diag loggers.
        expect(registry.reportingSdkStats).toBe(compatible ? true : previous);
        expect(isReportingSdkStats()).toBe(compatible);
        expect(() =>
          reportWithoutTelemetry(() => {
            expect(registry.reportingSdkStats).toBe(compatible ? true : previous);
            throw new Error("nested diagnostic");
          }),
        ).toThrow("nested diagnostic");
        expect(registry.reportingSdkStats).toBe(compatible ? true : previous);
        expect(isReportingSdkStats()).toBe(compatible);
        throw new Error("outer diagnostic");
      }),
    ).toThrow("outer diagnostic");
    expect(registry.reportingSdkStats).toBe(previous);
    expect(isReportingSdkStats()).toBe(compatible && previous);
  },
);

const diagnosticDefaults = {
  spanProcessors: [],
  logRecordProcessors: [],
  pageView: { enabled: false },
  session: { enabled: false },
  userContext: { enabled: false },
  cookieCfg: { enabled: false, disableCookieDefer: true },
  storage: { enabled: false },
} satisfies MicrosoftOpenTelemetryBrowserOptions;

function diagnosticProcessor() {
  return {
    onEmit: vi.fn<LogRecordProcessor["onEmit"]>(),
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

it.each([
  [DiagLogLevel.NONE, 0],
  [DiagLogLevel.ERROR, 1],
  [DiagLogLevel.WARN, 2],
  [DiagLogLevel.INFO, 3],
  [DiagLogLevel.DEBUG, 4],
  [DiagLogLevel.VERBOSE, 5],
  [DiagLogLevel.ALL, 5],
  [undefined, 3],
] as const)("filters console diagnostics at level %s", async (consoleLogLevel, count) => {
  const methods = ["error", "warn", "info", "debug", "verbose"] as const;
  const output = methods.map(() => vi.fn());
  const setLogger = diag.setLogger.bind(diag);
  vi.spyOn(diag, "setLogger").mockImplementationOnce((logger, options) => {
    methods.forEach((method, index) => {
      const observe = output[index]!;
      observe.mockImplementation(logger[method]);
      logger[method] = observe;
    });
    return typeof options === "number" ? setLogger(logger, options) : setLogger(logger, options);
  });
  const handle = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: { consoleLogLevel },
  });
  owners.push(handle);
  for (const spy of output) spy.mockClear();
  for (const method of methods) diag[method](method);
  expect(output.map((spy) => spy.mock.calls.length)).toEqual(
    methods.map((_, index) => (index < count ? 1 : 0)),
  );
});

it("keeps independent diagnostic thresholds and excludes application context and diagnostic arguments", async () => {
  const processor = diagnosticProcessor();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const pipeline = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    ...pipeline.options,
    resource: resourceFromAttributes({ "service.name": "customer", "user.id": "customer-user" }),
    diagnostics: {
      consoleLogLevel: DiagLogLevel.ERROR,
      telemetryLogLevel: DiagLogLevel.WARN,
      logRecordProcessors: [processor],
    },
    instrumentations: [
      new ConsoleInstrumentation({ enabled: false, logMethods: ["warn", "error"] }),
    ],
  });
  owners.push(handle);
  const originalWarnCount = warn.mock.calls.length;
  const span = trace.getTracer("customer").startSpan("customer-operation");
  context.with(trace.setSpan(context.active(), span), () => {
    diag.warn("SDK warning", { secret: "not exported" });
    diag.error("SDK error");
    diag.info("SDK info");
  });
  console.warn("application warning");
  span.end();
  await handle.forceFlush();
  expect(warn.mock.calls.length).toBe(originalWarnCount + 1);
  const records = processor.onEmit.mock.calls.map(([record]) => record);
  expect(records.map((record) => record.body)).toEqual(["SDK warning", "SDK error"]);
  for (const record of records) {
    expect(record.spanContext).toBeUndefined();
    expect(record.resource.attributes).toEqual({});
    expect(record.attributes).toEqual({});
    expect(record.instrumentationScope.name).toBe("@microsoft/opentelemetry-browser/diagnostics");
  }
  expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
    "application warning",
  ]);
  expect(processor.forceFlush).toHaveBeenCalled();
});

it("leaves diagnostic telemetry off by default even when processors are supplied", async () => {
  const processor = diagnosticProcessor();
  const handle = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: { consoleLogLevel: DiagLogLevel.NONE, logRecordProcessors: [processor] },
  });
  owners.push(handle);
  diag.error("not exported");
  await handle.forceFlush();
  expect(processor.onEmit).not.toHaveBeenCalled();
  await handle.shutdown();
  expect(processor.shutdown).toHaveBeenCalledOnce();
});

it("shares the first settings, retains diagnostics until the last shutdown and preserves application overrides", async () => {
  const firstProcessor = diagnosticProcessor();
  const ignoredProcessor = diagnosticProcessor();
  const first = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ERROR,
      logRecordProcessors: [firstProcessor],
    },
  });
  const second = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ALL,
      logRecordProcessors: [ignoredProcessor],
    },
  });
  owners.push(first, second);
  await first.shutdown();
  expect(firstProcessor.shutdown).not.toHaveBeenCalled();
  diag.error("second still active");
  diag.warn("below first threshold");
  expect(firstProcessor.onEmit).toHaveBeenCalledOnce();
  expect(ignoredProcessor.onEmit).not.toHaveBeenCalled();
  const application = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  };
  diag.setLogger(application);
  await second.shutdown();
  expect(firstProcessor.shutdown).toHaveBeenCalledOnce();
  expect(ignoredProcessor.shutdown).not.toHaveBeenCalled();
  application.error.mockClear();
  const later = await useMicrosoftOpenTelemetry({ ...diagnosticDefaults });
  owners.push(later);
  diag.error("application override retained");
  expect(application.error).toHaveBeenCalledWith("application override retained");
});

it("suppresses nested, repeated and SDK stats diagnostics and bounds diagnostic telemetry", async () => {
  const processor = diagnosticProcessor();
  processor.onEmit.mockImplementation(() => {
    diag.error("nested diagnostic");
    throw new Error("processor failure");
  });
  const handle = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ERROR,
      logRecordProcessors: [processor],
    },
  });
  owners.push(handle);
  reportWithoutTelemetry(() => diag.error("stats failure"));
  expect(processor.onEmit).not.toHaveBeenCalled();
  expect(() => diag.error("original")).not.toThrow();
  diag.error("original");
  expect(processor.onEmit).toHaveBeenCalledOnce();
  const longMessage = "x".repeat(5000);
  diag.error(longMessage);
  expect(processor.onEmit.mock.calls[1]![0].body).toHaveLength(4096);
  for (let index = 0; index < 110; index++) diag.error(`failure ${index}`);
  expect(processor.onEmit).toHaveBeenCalledTimes(100);
});

it("bounds asynchronous export failure feedback without collecting its own errors indefinitely", async () => {
  let exports = 0;
  const processor = new SimpleLogRecordProcessor({
    exporter: {
      export(_records, callback) {
        exports++;
        queueMicrotask(() => callback({ code: 1, error: new Error("diagnostic export failed") }));
      },
      async forceFlush() {},
      async shutdown() {},
    },
  });
  const handle = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ERROR,
      logRecordProcessors: [processor],
    },
  });
  owners.push(handle);
  diag.error("trigger");
  await handle.forceFlush();
  await handle.forceFlush();
  expect(exports).toBeGreaterThan(0);
  expect(exports).toBeLessThanOrEqual(3);
});

it("cleans up diagnostics after a failed startup without masking its error", async () => {
  const processor = diagnosticProcessor();
  processor.shutdown.mockRejectedValue(new Error("diagnostic cleanup failed"));
  await expect(
    useMicrosoftOpenTelemetry({
      ...diagnosticDefaults,
      diagnostics: { consoleLogLevel: DiagLogLevel.NONE, logRecordProcessors: [processor] },
      instrumentations: [
        {
          setTracerProvider() {
            throw new Error("startup failed");
          },
          getConfig: () => ({ enabled: false }),
          enable() {},
          disable() {},
        },
      ],
    }),
  ).rejects.toThrow("startup failed");
  expect(processor.shutdown).toHaveBeenCalledOnce();
});

it.each([
  null,
  [],
  "debug",
  { consoleLogLevel: 2 },
  { consoleLogLevel: Number.NaN },
  { telemetryLogLevel: Infinity },
  { telemetryLogLevel: "ERROR" },
  { enableDebug: true },
  { logRecordProcessors: {} },
  { logRecordProcessors: [null] },
  { logRecordProcessors: new Array<LogRecordProcessor>(1) },
])("rejects malformed diagnostics before changing global state: %j", async (diagnostics) => {
  const setLogger = vi.spyOn(diag, "setLogger");
  await expect(
    useMicrosoftOpenTelemetry({
      ...diagnosticDefaults,
      diagnostics: diagnostics as MicrosoftOpenTelemetryBrowserDiagnosticsOptions,
    }),
  ).rejects.toThrow(TypeError);
  expect(setLogger).not.toHaveBeenCalled();
});

it("rejects reused diagnostic processors before taking ownership", async () => {
  const processor = diagnosticProcessor();
  await expect(
    useMicrosoftOpenTelemetry({
      ...diagnosticDefaults,
      diagnostics: { logRecordProcessors: [processor, processor] },
    }),
  ).rejects.toThrow(TypeError);
  await expect(
    useMicrosoftOpenTelemetry({
      ...diagnosticDefaults,
      logRecordProcessors: [processor],
      diagnostics: { logRecordProcessors: [processor] },
    }),
  ).rejects.toThrow("must not be shared");
  expect(processor.shutdown).not.toHaveBeenCalled();
});

it("keeps distinct OpenTelemetry component messages while omitting structured arguments", async () => {
  const processor = diagnosticProcessor();
  const handle = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.WARN,
      logRecordProcessors: [processor],
    },
  });
  owners.push(handle);
  const component = diag.createComponentLogger({ namespace: "component" });
  component.warn("first failure", { secret: "excluded" });
  component.warn("second failure", { secret: "excluded" });
  expect(processor.onEmit.mock.calls.map(([record]) => record.body)).toEqual([
    "component first failure",
    "component second failure",
  ]);
});

it("suppresses trace activity inside diagnostic processors with an active context manager", async () => {
  const processor = diagnosticProcessor();
  let suppressed = false;
  processor.onEmit.mockImplementation(() => {
    suppressed = isTracingSuppressed(context.active());
  });
  const pipeline = createInMemoryPipeline();
  const handle = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    ...pipeline.options,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ERROR,
      logRecordProcessors: [processor],
    },
  });
  owners.push(handle);
  diag.error("isolated");
  expect(processor.onEmit).toHaveBeenCalledOnce();
  expect(suppressed).toBe(true);
  await handle.forceFlush();
});

it("reserves first diagnostic settings before asynchronous resource resolution", async () => {
  let resolve!: () => void;
  const resource = resourceFromAttributes({});
  vi.spyOn(resource, "waitForAsyncAttributes").mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const firstProcessor = diagnosticProcessor();
  const ignored = diagnosticProcessor();
  const first = useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    resource,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ERROR,
      logRecordProcessors: [firstProcessor],
    },
  });
  const second = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ERROR,
      logRecordProcessors: [ignored],
    },
  });
  owners.push(second);
  resolve();
  owners.push(await first);
  diag.error("first owns settings");
  expect(firstProcessor.onEmit).toHaveBeenCalledOnce();
  expect(ignored.onEmit).not.toHaveBeenCalled();
});

it("flushes and shuts down sibling processors even when one throws synchronously", async () => {
  const first = diagnosticProcessor();
  const second = diagnosticProcessor();
  first.forceFlush.mockImplementation(() => {
    throw new Error("flush failed");
  });
  first.shutdown.mockImplementation(() => {
    throw new Error("shutdown failed");
  });
  const handle = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: { consoleLogLevel: DiagLogLevel.NONE, logRecordProcessors: [first, second] },
  });
  await expect(handle.forceFlush()).rejects.toThrow("flush failed");
  expect(second.forceFlush).toHaveBeenCalledOnce();
  await expect(handle.shutdown()).rejects.toThrow("shutdown failed");
  expect(second.shutdown).toHaveBeenCalledOnce();
});

it("serializes shared flushes so a later handle flush includes intervening diagnostics", async () => {
  const processor = diagnosticProcessor();
  let complete!: () => void;
  const entered = new Promise<void>((resolve) => {
    processor.forceFlush.mockImplementationOnce(() => {
      resolve();
      return new Promise<void>((done) => {
        complete = done;
      });
    });
  });
  const first = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ERROR,
      logRecordProcessors: [processor],
    },
  });
  const second = await useMicrosoftOpenTelemetry(diagnosticDefaults);
  owners.push(first, second);
  diag.error("before first flush");
  const flushing = first.forceFlush();
  await entered;
  diag.error("before second flush");
  const later = second.forceFlush();
  complete();
  await Promise.all([flushing, later]);
  expect(processor.forceFlush).toHaveBeenCalledTimes(2);
});

it("skips queued diagnostic flushes that outlive the shutdown deadline", async () => {
  const clock = installFakeClock();
  const processor = diagnosticProcessor();
  processor.forceFlush.mockImplementation(
    () => new Promise<void>((resolve) => setTimeout(resolve, 25_000)),
  );
  let completeShutdown!: () => void;
  processor.shutdown.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        completeShutdown = resolve;
      }),
  );
  const handles = await Promise.all(
    Array.from({ length: 4 }, () =>
      useMicrosoftOpenTelemetry({
        ...diagnosticDefaults,
        diagnostics: { consoleLogLevel: DiagLogLevel.NONE, logRecordProcessors: [processor] },
      }),
    ),
  );
  const flushes = Promise.allSettled(handles.map((handle) => handle.forceFlush()));
  let stops: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    await clock.advance(30_000);
    expect(await flushes).toMatchObject([
      { status: "fulfilled" },
      { status: "rejected" },
      { status: "rejected" },
      { status: "rejected" },
    ]);
    expect(processor.forceFlush).toHaveBeenCalledTimes(2);
    stops = Promise.allSettled(handles.map((handle) => handle.shutdown()));
    // The old queue starts its fourth flush at 75s, after shutdown's 60s wait deadline.
    await clock.advance(45_000);
    expect(processor.shutdown).toHaveBeenCalledOnce();
    expect(processor.forceFlush).toHaveBeenCalledTimes(2);
  } finally {
    completeShutdown?.();
    stops ??= Promise.allSettled(handles.map((handle) => handle.shutdown()));
    await clock.advance(60_000);
    await stops;
  }
  expect(processor.forceFlush).toHaveBeenCalledTimes(2);
  expect(processor.shutdown).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps first diagnostic ownership when a previous logger re-enters initialization", async () => {
  const firstProcessor = diagnosticProcessor();
  const ignored = diagnosticProcessor();
  let nested: ReturnType<typeof useMicrosoftOpenTelemetry> | undefined;
  const previous = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  };
  diag.setLogger(previous);
  previous.warn.mockImplementationOnce(() => {
    nested = useMicrosoftOpenTelemetry({
      ...diagnosticDefaults,
      diagnostics: { logRecordProcessors: [ignored] },
    });
  });
  const first = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ERROR,
      logRecordProcessors: [firstProcessor],
    },
  });
  owners.push(first);
  expect(nested).toBeDefined();
  const second = await nested!;
  owners.push(second);
  await first.shutdown();
  diag.error("reentrant shared owner");
  expect(firstProcessor.onEmit).toHaveBeenCalledOnce();
  expect(ignored.onEmit).not.toHaveBeenCalled();
  expect(firstProcessor.shutdown).not.toHaveBeenCalled();
  await second.shutdown();
  expect(firstProcessor.shutdown).toHaveBeenCalledOnce();
});

it("does not let a throwing enabled callback suppress healthy diagnostic siblings", async () => {
  const failed = {
    ...diagnosticProcessor(),
    enabled: vi.fn(() => {
      throw new Error("enabled failed");
    }),
  };
  const healthy = diagnosticProcessor();
  const handle = await useMicrosoftOpenTelemetry({
    ...diagnosticDefaults,
    diagnostics: {
      consoleLogLevel: DiagLogLevel.NONE,
      telemetryLogLevel: DiagLogLevel.ERROR,
      logRecordProcessors: [failed, healthy],
    },
  });
  owners.push(handle);
  diag.error("healthy sibling");
  expect(healthy.onEmit).toHaveBeenCalledOnce();
});

it("rejects dependent reentrant startup when diagnostic registration fails", async () => {
  const processor = diagnosticProcessor();
  let nested: ReturnType<typeof useMicrosoftOpenTelemetry> | undefined;
  const failure = new Error("previous diagnostic logger failed");
  diag.setLogger({
    error() {},
    info() {},
    debug() {},
    verbose() {},
    warn() {
      nested = useMicrosoftOpenTelemetry(diagnosticDefaults);
      void nested.catch(() => {});
      throw failure;
    },
  });
  await expect(
    useMicrosoftOpenTelemetry({
      ...diagnosticDefaults,
      diagnostics: { logRecordProcessors: [processor] },
    }),
  ).rejects.toBe(failure);
  expect(nested).toBeDefined();
  await expect(nested!).rejects.toBe(failure);
  expect(processor.shutdown).toHaveBeenCalledOnce();
  expect(getSharedRegistry().diagInitialized).toBe(false);
});
