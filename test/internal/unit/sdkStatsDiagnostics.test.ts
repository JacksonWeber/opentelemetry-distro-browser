// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { BatchLogRecordProcessor, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { afterEach, expect, it, vi } from "vitest";
import { createCustomerSdkStats } from "../../../src/exporter/customerSdkStats.js";
import { createInternalSdkStats, reportFailure } from "../../../src/exporter/sdkStats.js";
import { useMicrosoftOpenTelemetry } from "../../../src/index.js";
import { claimInstrumentations } from "../../../src/instrumentation/sharedBrowserPatches.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";
import {
  getRegisteredGlobal,
  getSharedRegistry,
  isReportingSdkStats,
  reportWithoutTelemetry,
} from "../../../src/shared/globalOwnership.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";
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

it("preserves an outer diagnostic guard when a nested diagnostic throws", () => {
  getSharedRegistry();
  expect(isReportingSdkStats()).toBe(false);
  reportWithoutTelemetry(() => {
    expect(isReportingSdkStats()).toBe(true);
    expect(() =>
      reportWithoutTelemetry(() => {
        throw new Error("nested diagnostic");
      }),
    ).toThrow("nested diagnostic");
    expect(isReportingSdkStats()).toBe(true);
  });
  expect(isReportingSdkStats()).toBe(false);
});
