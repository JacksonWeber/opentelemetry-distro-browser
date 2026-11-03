// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { ErrorsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/errors";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { NavigationTimingInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation-timing";
import { ResourceTimingInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/resource-timing";
import { UserActionInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/user-action";
import { WebVitalsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/web-vitals";
import { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { afterEach, expect, it, vi } from "vitest";
import {
  onCLS,
  onFCP,
  onINP,
  onLCP,
  onTTFB,
  type FCPMetricWithAttribution,
} from "web-vitals/attribution";
import {
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { PageViewInstrumentation } from "../../../src/instrumentation/pageView/index.js";
import { claimInstrumentationOwnership } from "../../../src/instrumentation/sharedBrowserPatches.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";

vi.mock("../../../src/routing/telemetryInstance.js", () => ({ startTelemetryInstance: vi.fn() }));
vi.mock("web-vitals/attribution", () => ({
  onCLS: vi.fn(),
  onFCP: vi.fn(),
  onINP: vi.fn(),
  onLCP: vi.fn(),
  onTTFB: vi.fn(),
}));

function fakeInstance() {
  return {
    tracerProvider: { getTracer: vi.fn() },
    loggerProvider: { getLogger: vi.fn(() => ({ emit: vi.fn(), enabled: () => true })) },
    commit: vi.fn(),
    abort: vi.fn(),
    detach: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
}

const handles = new Set<MicrosoftOpenTelemetryBrowser>();

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  vi.restoreAllMocks();
  vi.mocked(startTelemetryInstance).mockReset();
  for (const register of [onCLS, onFCP, onINP, onLCP, onTTFB]) vi.mocked(register).mockClear();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

function createInstrumentation(enabled: boolean | undefined = false) {
  const config = Object.freeze({ enabled });
  return {
    setTracerProvider: vi.fn<BrowserInstrumentation["setTracerProvider"]>(),
    setLoggerProvider: vi.fn<NonNullable<BrowserInstrumentation["setLoggerProvider"]>>(),
    getConfig: vi.fn<BrowserInstrumentation["getConfig"]>(() => config),
    enable: vi.fn(),
    disable: vi.fn(),
  };
}

async function initialize(
  instrumentations: readonly BrowserInstrumentation[],
  options: Partial<MicrosoftOpenTelemetryBrowserOptions> = {},
) {
  const sdk = fakeInstance();
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(sdk);
  // Page view is owned by the distribution and on by default. These tests cover the registration
  // mechanics for caller-supplied instances, so it is switched off to keep the list exact.
  const handle = await useMicrosoftOpenTelemetry({
    instrumentations,
    pageView: { enabled: false },
    ...options,
  });
  handles.add(handle);
  return { handle, sdk };
}

it("binds the instance's own providers before enabling deferred instrumentation", async () => {
  const instrumentation = createInstrumentation();
  const { handle, sdk } = await initialize(Object.freeze([instrumentation]));
  expect(instrumentation.setTracerProvider).toHaveBeenCalledExactlyOnceWith(sdk.tracerProvider);
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledExactlyOnceWith(sdk.loggerProvider);
  expect(startTelemetryInstance).toHaveBeenCalledBefore(instrumentation.setTracerProvider);
  expect(instrumentation.setTracerProvider).toHaveBeenCalledBefore(instrumentation.enable);
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledBefore(instrumentation.enable);
  expect(instrumentation.enable).toHaveBeenCalledOnce();
  expect(instrumentation.getConfig()).toEqual({ enabled: false });
  await handle.shutdown();
  expect(instrumentation.disable).toHaveBeenCalledBefore(sdk.shutdown);
});

it("rebinds already-enabled instrumentation without enabling it twice", async () => {
  const instrumentation = createInstrumentation(true);
  await initialize([instrumentation]);
  expect(instrumentation.setTracerProvider).toHaveBeenCalledOnce();
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledOnce();
  expect(instrumentation.enable).not.toHaveBeenCalled();
});

it("supports trace-only instrumentation and an unspecified enabled state", async () => {
  const instrumentation = createInstrumentation();
  const { setLoggerProvider: _setLoggerProvider, ...traceOnly } = instrumentation;
  traceOnly.getConfig.mockReturnValueOnce({});
  await initialize([traceOnly]);
  expect(traceOnly.setTracerProvider).toHaveBeenCalledOnce();
  expect(traceOnly.enable).toHaveBeenCalledOnce();
});

it("does not register instances omitted by the caller", async () => {
  const selected = createInstrumentation();
  const omitted = createInstrumentation();
  await initialize([selected]);
  expect(omitted.setTracerProvider).not.toHaveBeenCalled();
  expect(omitted.setLoggerProvider).not.toHaveBeenCalled();
  expect(omitted.enable).not.toHaveBeenCalled();
  expect(omitted.disable).not.toHaveBeenCalled();
});

it("uses inherited data names without invoking optional metadata accessors", async () => {
  const instrumentation = createInstrumentation();
  Object.setPrototypeOf(instrumentation, { instrumentationName: "custom-name" });
  const getter = vi.fn(() => "0.8.1");
  const accessor = createInstrumentation();
  Object.defineProperty(accessor, "instrumentationVersion", { get: getter });
  const { handle } = await initialize([instrumentation, accessor]);
  expect(handle.instrumentations.get("custom-name")).toBe(instrumentation);
  expect(handle.instrumentations.get("instrumentation")).toBe(accessor);
  expect(getter).not.toHaveBeenCalled();
});

it("does not require introspection of optional metadata for startup", async () => {
  const instrumentation = new Proxy(createInstrumentation(), {
    getOwnPropertyDescriptor() {
      throw new Error("metadata unavailable");
    },
  });
  const { handle } = await initialize([instrumentation]);
  expect(handle.instrumentations.get("instrumentation")).toBe(instrumentation);
});

it("owns shutdown even when no instrumentation is selected", async () => {
  const { handle, sdk } = await initialize([]);
  await handle.shutdown();
  await handle.shutdown();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it("wraps the upstream handle to provide distro lifecycle when nothing is registered", async () => {
  const { handle, sdk } = await initialize([]);
  expect(handle).not.toBe(sdk);
  expect(handle.forceFlush).toBeTypeOf("function");
});

it("wraps the upstream handle for the instrumentation the distribution owns", async () => {
  const { handle, sdk } = await initialize([], { pageView: undefined });
  expect(handle).not.toBe(sdk);
});

it("registers runtime-supported optional upstream instrumentations by stable IDs", async () => {
  const console = new ConsoleInstrumentation({ enabled: false });
  const errors = new ErrorsInstrumentation({ enabled: false });
  const userAction = new UserActionInstrumentation({ enabled: false });
  const webVitals = new WebVitalsInstrumentation({ enabled: false });
  const { handle } = await initialize([console, errors, userAction, webVitals]);

  expect(handle.instrumentations.get("console")).toBe(console);
  expect(handle.instrumentations.get("errors")).toBe(errors);
  expect(handle.instrumentations.get("user-action")).toBe(userAction);
  expect(handle.instrumentations.get("web-vitals")).toBe(webVitals);

  const disable = vi.spyOn(webVitals, "disable");
  const enable = vi.spyOn(webVitals, "enable");
  await handle.instrumentations.setEnabled("web-vitals", false);
  await handle.instrumentations.setEnabled("web-vitals", true);
  expect(disable).toHaveBeenCalledOnce();
  expect(enable).toHaveBeenCalledOnce();
});

it("pauses Web Vitals emission and resumes the same object without registering callbacks again", async () => {
  const firstInstrumentation = new WebVitalsInstrumentation({ enabled: false });
  const secondInstrumentation = new WebVitalsInstrumentation({ enabled: false });
  const first = await initialize([firstInstrumentation]);
  const second = await initialize([secondInstrumentation]);
  const firstEmit = first.sdk.loggerProvider.getLogger.mock.results[0].value.emit;
  const secondEmit = second.sdk.loggerProvider.getLogger.mock.results[0].value.emit;
  const metric: FCPMetricWithAttribution = {
    name: "FCP",
    value: 100,
    delta: 100,
    rating: "good",
    id: "pause-resume-fcp",
    navigationId: 1,
    navigationType: "navigate",
    entries: [],
    attribution: { timeToFirstByte: 25, firstByteToFCP: 75, loadState: "complete" },
  };
  // Drive the callbacks registered by the real upstream instrumentation, not its private methods.
  const report = () => {
    for (const [callback] of vi.mocked(onFCP).mock.calls) callback(metric);
  };
  for (const register of [onCLS, onFCP, onINP, onLCP, onTTFB]) {
    expect(register).toHaveBeenCalledTimes(2);
  }

  report();
  expect(firstEmit).toHaveBeenCalledOnce();
  expect(secondEmit).toHaveBeenCalledOnce();
  expect(firstEmit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      eventName: "browser.web_vital",
      attributes: expect.objectContaining({
        "browser.web_vital.name": "fcp",
        "browser.web_vital.id": metric.id,
      }),
    }),
  );

  await first.handle.instrumentations.setEnabled("web-vitals", false);
  report();
  expect(firstEmit).toHaveBeenCalledOnce();
  expect(secondEmit).toHaveBeenCalledTimes(2);

  await first.handle.instrumentations.setEnabled("web-vitals", true);
  expect(first.handle.instrumentations.get("web-vitals")).toBe(firstInstrumentation);
  report();
  expect(firstEmit).toHaveBeenCalledTimes(2);
  expect(secondEmit).toHaveBeenCalledTimes(3);
  for (const register of [onCLS, onFCP, onINP, onLCP, onTTFB]) {
    expect(register).toHaveBeenCalledTimes(2);
  }
});

it("rejects one Web Vitals object registered twice before it can enable twice", async () => {
  const webVitals = new WebVitalsInstrumentation({ enabled: false });
  const enable = vi.spyOn(webVitals, "enable");
  await expect(initialize([webVitals, webVitals])).rejects.toThrow("browser-instrumentation-owned");
  expect(enable).not.toHaveBeenCalled();
});

it.each([
  ["fetch", () => new FetchInstrumentation({ enabled: false })],
  ["xhr", () => new XhrInstrumentation({ enabled: false })],
  ["console", () => new ConsoleInstrumentation({ enabled: false })],
  ["errors", () => new ErrorsInstrumentation({ enabled: false })],
  ["user-action", () => new UserActionInstrumentation({ enabled: false })],
] as const)("adds and removes %s, releasing it to another instance", async (_kind, create) => {
  const instrumentation = create();
  const first = await initialize([], { spanProcessors: [{} as never] });
  const second = await initialize([], { spanProcessors: [{} as never] });

  await first.handle.instrumentations.add("dynamic", instrumentation);
  expect(first.handle.instrumentations.get("dynamic")).toBe(instrumentation);
  const disable = vi.spyOn(instrumentation, "disable");
  await first.handle.instrumentations.remove("dynamic");
  expect(disable).toHaveBeenCalledOnce();
  expect(first.handle.instrumentations.get("dynamic")).toBeUndefined();

  await second.handle.instrumentations.add("other", instrumentation);
  const beforeShutdown = disable.mock.calls.length;
  await first.handle.shutdown();
  expect(disable).toHaveBeenCalledTimes(beforeShutdown);
  expect(second.handle.instrumentations.get("other")).toBe(instrumentation);
  await second.handle.shutdown();
  expect(disable).toHaveBeenCalledTimes(beforeShutdown + 1);
});

it.each([
  ["custom", "instrumentation", () => createInstrumentation()],
  ["navigation", "navigation", () => new NavigationInstrumentation({ enabled: false })],
  [
    "navigation timing",
    "navigation-timing",
    () => new NavigationTimingInstrumentation({ enabled: false }),
  ],
  [
    "page view",
    "@microsoft/opentelemetry-browser/page-view",
    () => new PageViewInstrumentation({ enabled: false }),
  ],
  ["web vitals", "web-vitals", () => new WebVitalsInstrumentation({ enabled: false })],
] as const)(
  "rejects mutations of %s without changing startup registration",
  async (_name, id, create) => {
    const original = create();
    const candidate = create();
    const { handle } = await initialize([original]);
    const replacement = new ErrorsInstrumentation({ enabled: false });

    await expect(handle.instrumentations.add("unsupported", candidate)).rejects.toThrow();
    await expect(handle.instrumentations.remove(id)).rejects.toThrow();
    await expect(handle.instrumentations.replace(id, replacement)).rejects.toThrow();
    expect(handle.instrumentations.get(id)).toBe(original);
    expect(handle.instrumentations.get("unsupported")).toBeUndefined();

    await handle.instrumentations.add("supported", replacement);
    await expect(handle.instrumentations.replace("supported", candidate)).rejects.toThrow();
    expect(handle.instrumentations.get("supported")).toBe(replacement);
    await handle.instrumentations.remove("supported");
  },
);

it("keeps startup IDs stable and rejects invalid or duplicate IDs without poisoning the handle", async () => {
  const first = new ErrorsInstrumentation({ enabled: false });
  const second = new ErrorsInstrumentation({ enabled: false });
  const { handle } = await initialize([first, second]);
  const candidate = new ErrorsInstrumentation({ enabled: false });
  const bind = vi.spyOn(candidate, "setTracerProvider");
  const disable = vi.spyOn(candidate, "disable");

  for (const id of ["", "   ", "errors#2"]) {
    await expect(handle.instrumentations.add(id, candidate)).rejects.toThrow();
  }
  await expect(handle.instrumentations.remove("missing")).rejects.toThrow();
  await expect(handle.instrumentations.replace("missing", candidate)).rejects.toThrow();
  expect(bind).not.toHaveBeenCalled();
  expect(disable).not.toHaveBeenCalled();
  await handle.instrumentations.remove("errors");
  expect(handle.instrumentations.get("errors#2")).toBe(second);
  await handle.instrumentations.add("errors", candidate);
  expect(handle.instrumentations.get("errors")).toBe(candidate);
  expect(handle.instrumentations.get("errors#2")).toBe(second);
});

it("reserves ownership before binding and rejects duplicate or foreign objects without touching them", async () => {
  const instrumentation = new ErrorsInstrumentation({ enabled: false });
  const first = await initialize([]);
  const second = await initialize([]);
  const bind = vi.spyOn(instrumentation, "setTracerProvider");
  const disable = vi.spyOn(instrumentation, "disable");
  bind.mockImplementationOnce(() => {
    expect(() => claimInstrumentationOwnership([instrumentation])).toThrow(
      "browser-instrumentation-owned",
    );
  });

  await first.handle.instrumentations.add("first", instrumentation);
  await expect(first.handle.instrumentations.add("duplicate", instrumentation)).rejects.toThrow(
    "browser-instrumentation-owned",
  );
  await expect(second.handle.instrumentations.add("foreign", instrumentation)).rejects.toThrow(
    "browser-instrumentation-owned",
  );
  expect(bind).toHaveBeenCalledOnce();
  expect(disable).not.toHaveBeenCalled();
  const other = new ErrorsInstrumentation({ enabled: false });
  await second.handle.instrumentations.add("available", other);
  await expect(
    second.handle.instrumentations.replace("available", instrumentation),
  ).rejects.toThrow("browser-instrumentation-owned");
  expect(second.handle.instrumentations.get("available")).toBe(other);
  expect(bind).toHaveBeenCalledOnce();
  expect(disable).not.toHaveBeenCalled();
  await first.handle.instrumentations.remove("first");
  await second.handle.instrumentations.add("foreign", instrumentation);
});

it("keeps ownership through removal cleanup and releases it only after cleanup returns", async () => {
  const instrumentation = new ErrorsInstrumentation({ enabled: false });
  const { handle } = await initialize([instrumentation]);
  const disable = instrumentation.disable.bind(instrumentation);
  vi.spyOn(instrumentation, "disable").mockImplementationOnce(() => {
    expect(handle.instrumentations.get("errors")).toBe(instrumentation);
    expect(() => claimInstrumentationOwnership([instrumentation])).toThrow(
      "browser-instrumentation-owned",
    );
    disable();
  });

  await handle.instrumentations.remove("errors");
  const claims = claimInstrumentationOwnership([instrumentation]);
  claims.get(instrumentation)!();
});

it("rejects candidates that were not constructed disabled without claiming or disabling them", async () => {
  const candidate = new ErrorsInstrumentation({ enabled: false });
  const config = vi.spyOn(candidate, "getConfig").mockReturnValue({ enabled: true });
  const bind = vi.spyOn(candidate, "setTracerProvider");
  const disable = vi.spyOn(candidate, "disable");
  const { handle } = await initialize([]);

  await expect(handle.instrumentations.add("invalid", candidate)).rejects.toThrow();
  expect(bind).not.toHaveBeenCalled();
  expect(disable).not.toHaveBeenCalled();
  config.mockRestore();
  const claims = claimInstrumentationOwnership([candidate]);
  claims.get(candidate)!();
  await handle.instrumentations.add("valid", candidate);
});

it.each([
  [
    "malformed",
    () => {
      const candidate = createInstrumentation();
      Object.defineProperties(candidate, {
        instrumentationName: { value: "@opentelemetry/browser-instrumentation/errors" },
        instrumentationVersion: { value: "0.8.1" },
        getConfig: { value: undefined },
      });
      return candidate;
    },
    "Instrumentation getConfig must be a function.",
  ],
  [
    "unsupported version",
    () => {
      const candidate = new ErrorsInstrumentation({ enabled: false });
      Object.defineProperty(candidate, "instrumentationVersion", { value: "0.0.0" });
      return candidate;
    },
    "Runtime add/remove/replace is unsupported for this instrumentation.",
  ],
  [
    "resource timing",
    () => new ResourceTimingInstrumentation({ enabled: false }),
    "Runtime add/remove/replace is unsupported for this instrumentation.",
  ],
] as const)(
  "rejects a %s candidate without touching it or poisoning the handle",
  async (_name, create, error) => {
    const old = new ErrorsInstrumentation({ enabled: false });
    const candidate = create();
    const { handle } = await initialize([old]);
    const bind = vi.spyOn(candidate, "setTracerProvider");
    const bindLogger = vi.spyOn(candidate, "setLoggerProvider");
    const disable = vi.spyOn(candidate, "disable");
    const oldDisable = vi.spyOn(old, "disable");

    await expect(handle.instrumentations.add("invalid", candidate)).rejects.toThrow(error);
    await expect(handle.instrumentations.replace("errors", candidate)).rejects.toThrow(error);
    expect(bind).not.toHaveBeenCalled();
    expect(bindLogger).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    expect(oldDisable).not.toHaveBeenCalled();
    expect(handle.instrumentations.get("errors")).toBe(old);
    const claims = claimInstrumentationOwnership([candidate]);
    claims.get(candidate)!();

    const valid = new ErrorsInstrumentation({ enabled: false });
    await handle.instrumentations.add("valid", valid);
    await handle.instrumentations.remove("valid");
  },
);

it.each([
  ["fetch", () => new FetchInstrumentation({ enabled: false }), "disableFetchTracking"],
  ["xhr", () => new XhrInstrumentation({ enabled: false }), "disableAjaxTracking"],
] as const)(
  "rejects runtime %s without traces even when its gate is closed",
  async (_kind, create, gate) => {
    const { handle } = await initialize([]);
    await handle.updateCfg({ [gate]: true });
    const candidate = create();
    const bind = vi.spyOn(candidate, "setTracerProvider");
    const disable = vi.spyOn(candidate, "disable");
    await expect(handle.instrumentations.add("network", candidate)).rejects.toThrow();
    expect(bind).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    const replacement = new ErrorsInstrumentation({ enabled: false });
    await handle.instrumentations.add("existing", replacement);
    await expect(handle.instrumentations.replace("existing", candidate)).rejects.toThrow();
    expect(handle.instrumentations.get("existing")).toBe(replacement);
    await handle.instrumentations.remove("existing");
  },
);

it("serializes mutations with configuration and applies the replacement's own gate", async () => {
  const old = new ErrorsInstrumentation({ enabled: false });
  const fetch = new FetchInstrumentation({ enabled: false });
  const { handle } = await initialize([old], { spanProcessors: [{} as never] });
  const oldDisable = vi.spyOn(old, "disable");

  const gate = handle.updateCfg({ disableFetchTracking: true });
  const replacement = handle.instrumentations.replace("errors", fetch);
  await Promise.all([gate, replacement]);
  expect(oldDisable).toHaveBeenCalledOnce();
  expect(handle.instrumentations.get("errors")).toBe(fetch);
  const fetchEnable = vi.spyOn(fetch, "enable");
  const paused = handle.instrumentations.setEnabled("errors", false);
  const openGate = handle.updateCfg({ disableFetchTracking: false });
  await Promise.all([paused, openGate]);
  expect(fetchEnable).not.toHaveBeenCalled();
  await handle.instrumentations.setEnabled("errors", true);
  expect(fetchEnable).toHaveBeenCalledOnce();
});

it("adds a requested network instrumentation behind a closed gate and enables it when reopened", async () => {
  const fetch = new FetchInstrumentation({ enabled: false });
  // Adapt before spying because the shared patch adapter installs its own lifecycle wrapper.
  const claims = claimInstrumentationOwnership([fetch]);
  claims.get(fetch)!();
  const enable = vi.spyOn(fetch, "enable");
  const { handle } = await initialize([], { spanProcessors: [{} as never] });

  const gate = handle.updateCfg({ disableFetchTracking: true });
  const add = handle.instrumentations.add("network", fetch);
  await Promise.all([gate, add]);
  expect(enable).not.toHaveBeenCalled();
  expect(handle.instrumentations.get("network")).toBe(fetch);
  await handle.updateCfg({ disableFetchTracking: false });
  expect(enable).toHaveBeenCalledOnce();
});

it("preserves a paused request across a cross-kind replacement without enabling the candidate", async () => {
  const old = new ErrorsInstrumentation({ enabled: false });
  const replacement = new UserActionInstrumentation({ enabled: false });
  const { handle } = await initialize([old]);
  await handle.instrumentations.setEnabled("errors", false);
  const enable = vi.spyOn(replacement, "enable");

  await handle.instrumentations.replace("errors", replacement);
  expect(handle.instrumentations.get("errors")).toBe(replacement);
  expect(enable).not.toHaveBeenCalled();
  await handle.instrumentations.setEnabled("errors", true);
  expect(enable).toHaveBeenCalledOnce();
});

it("keeps a manually enabled user-action candidate paused after replacement", async () => {
  const old = new ErrorsInstrumentation({ enabled: false });
  const { handle, sdk } = await initialize([old]);
  await handle.instrumentations.setEnabled("errors", false);
  const candidate = new UserActionInstrumentation({ enabled: false });
  candidate.enable();
  const button = document.createElement("button");
  document.body.append(button);
  try {
    await handle.instrumentations.replace("errors", candidate);
    const emit = sdk.loggerProvider.getLogger.mock.results.at(-1)!.value.emit;
    button.click();
    expect(emit).not.toHaveBeenCalled();
    await handle.instrumentations.setEnabled("errors", true);
    button.click();
    expect(emit).toHaveBeenCalledOnce();
  } finally {
    button.remove();
    candidate.disable();
  }
});

it("keeps the old entry visible until replacement lifecycle callbacks complete", async () => {
  const old = new ErrorsInstrumentation({ enabled: false });
  const candidate = new UserActionInstrumentation({ enabled: false });
  const { handle } = await initialize([old]);
  const bindProvider = candidate.setTracerProvider.bind(candidate);
  const disableOld = old.disable.bind(old);
  const enableCandidate = candidate.enable.bind(candidate);
  const bind = vi.spyOn(candidate, "setTracerProvider");
  const disable = vi.spyOn(old, "disable");
  const enable = vi.spyOn(candidate, "enable");
  bind.mockImplementationOnce((provider) => {
    expect(handle.instrumentations.get("errors")).toBe(old);
    bindProvider(provider);
  });
  disable.mockImplementationOnce(() => {
    expect(handle.instrumentations.get("errors")).toBe(old);
    disableOld();
  });
  enable.mockImplementationOnce(() => {
    expect(handle.instrumentations.get("errors")).toBe(old);
    enableCandidate();
  });

  await handle.instrumentations.replace("errors", candidate);
  expect(handle.instrumentations.get("errors")).toBe(candidate);
});

it.each(["setTracerProvider", "setLoggerProvider", "enable"] as const)(
  "cleans up a replacement after %s fails and poisons later mutations",
  async (method) => {
    const old = new ErrorsInstrumentation({ enabled: false });
    const candidate = new UserActionInstrumentation({ enabled: false });
    const { handle } = await initialize([old]);
    const oldDisable = vi.spyOn(old, "disable");
    const oldEnable = vi.spyOn(old, "enable");
    const cleanup = vi.spyOn(candidate, "disable");
    const failure = new Error(`${method} failed`);
    vi.spyOn(candidate, method).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(handle.instrumentations.replace("errors", candidate)).rejects.toBe(failure);
    expect(handle.instrumentations.get("errors")).toBe(old);
    expect(cleanup).toHaveBeenCalled();
    if (method === "enable") {
      expect(oldDisable).toHaveBeenCalledOnce();
      expect(oldEnable).toHaveBeenCalledOnce();
      expect(oldDisable).toHaveBeenCalledBefore(oldEnable);
    } else {
      expect(oldDisable).not.toHaveBeenCalled();
      expect(oldEnable).not.toHaveBeenCalled();
    }
    await expect(handle.instrumentations.remove("errors")).rejects.toThrow(
      "Instrumentation rollback failed; shutdown is required.",
    );
    await expect(handle.updateCfg({ samplingPercentage: 50 })).rejects.toThrow(
      "Instrumentation rollback failed; shutdown is required.",
    );
  },
);

it("retains a candidate whose rollback cleanup fails until shutdown cleans it successfully", async () => {
  const candidate = new ErrorsInstrumentation({ enabled: false });
  const first = await initialize([]);
  const second = await initialize([]);
  const failure = new Error("binding failed");
  const cleanupFailure = new Error("candidate cleanup failed");
  const bind = vi.spyOn(candidate, "setTracerProvider").mockImplementationOnce(() => {
    throw failure;
  });
  const cleanup = vi.spyOn(candidate, "disable").mockImplementationOnce(() => {
    throw cleanupFailure;
  });

  await expect(first.handle.instrumentations.add("candidate", candidate)).rejects.toMatchObject({
    name: "AggregateError",
    cause: failure,
    errors: [failure, cleanupFailure],
  });
  expect(first.handle.instrumentations.get("candidate")).toBeUndefined();
  await expect(second.handle.instrumentations.add("foreign", candidate)).rejects.toThrow(
    "browser-instrumentation-owned",
  );
  expect(bind).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  await first.handle.shutdown();
  expect(cleanup).toHaveBeenCalledTimes(2);
  await second.handle.instrumentations.add("foreign", candidate);
});

it("retains ownership after a failed removal until shutdown succeeds", async () => {
  const old = new ErrorsInstrumentation({ enabled: false });
  const first = await initialize([old]);
  const second = await initialize([]);
  const failure = new Error("remove failed");
  const disable = vi.spyOn(old, "disable").mockImplementationOnce(() => {
    throw failure;
  });
  const enable = vi.spyOn(old, "enable");

  await expect(first.handle.instrumentations.remove("errors")).rejects.toBe(failure);
  expect(first.handle.instrumentations.get("errors")).toBe(old);
  expect(enable).toHaveBeenCalledOnce();
  await expect(second.handle.instrumentations.add("foreign", old)).rejects.toThrow(
    "browser-instrumentation-owned",
  );
  expect(disable).toHaveBeenCalledOnce();
  await expect(first.handle.updateCfg({ samplingPercentage: 50 })).rejects.toThrow(
    "Instrumentation rollback failed; shutdown is required.",
  );

  await first.handle.shutdown();
  expect(disable).toHaveBeenCalledTimes(2);
  await second.handle.instrumentations.add("foreign", old);
  expect(second.handle.instrumentations.get("foreign")).toBe(old);
});

it("retains the old entry and aggregates disable and inverse failures", async () => {
  const old = new ErrorsInstrumentation({ enabled: false });
  const candidate = new UserActionInstrumentation({ enabled: false });
  const { handle } = await initialize([old]);
  const failure = new Error("old disable failed");
  const rollbackFailure = new Error("old inverse failed");
  vi.spyOn(old, "disable").mockImplementationOnce(() => {
    throw failure;
  });
  vi.spyOn(old, "enable").mockImplementationOnce(() => {
    throw rollbackFailure;
  });
  const cleanup = vi.spyOn(candidate, "disable");

  await expect(handle.instrumentations.replace("errors", candidate)).rejects.toMatchObject({
    name: "AggregateError",
    cause: failure,
    errors: [failure, rollbackFailure],
  });
  expect(cleanup).toHaveBeenCalled();
  expect(handle.instrumentations.get("errors")).toBe(old);
  await expect(handle.instrumentations.add("another", candidate)).rejects.toThrow(
    "Instrumentation rollback failed; shutdown is required.",
  );
});

it.each(["bind", "enable"] as const)(
  "does not release or revive a candidate when shutdown reenters during %s",
  async (stage) => {
    const candidate = new ErrorsInstrumentation({ enabled: false });
    const { handle } = await initialize([]);
    let shutdown: Promise<void> | undefined;
    const realEnable = candidate.enable.bind(candidate);
    const bindProvider = candidate.setTracerProvider.bind(candidate);
    const enable = vi.spyOn(candidate, "enable");
    const disable = vi.spyOn(candidate, "disable");
    const reenter = () => {
      shutdown = handle.shutdown();
      expect(() => claimInstrumentationOwnership([candidate])).toThrow(
        "browser-instrumentation-owned",
      );
    };
    if (stage === "bind") {
      vi.spyOn(candidate, "setTracerProvider").mockImplementationOnce((provider) => {
        reenter();
        bindProvider(provider);
      });
    } else {
      enable.mockImplementationOnce(() => {
        reenter();
        realEnable();
      });
    }

    await expect(handle.instrumentations.add("candidate", candidate)).rejects.toThrow(
      "Telemetry instance is stopped.",
    );
    await shutdown;
    expect(handle.instrumentations.get("candidate")).toBeUndefined();
    expect(enable).toHaveBeenCalledTimes(stage === "enable" ? 1 : 0);
    expect(disable).toHaveBeenCalled();
    if (stage === "enable") {
      expect(
        (candidate as unknown as { _onErrorHandler?: EventListener })._onErrorHandler,
      ).toBeUndefined();
    }
    const claims = claimInstrumentationOwnership([candidate]);
    claims.get(candidate)!();
  },
);

it("retains both replacement claims when shutdown reenters the old disable callback", async () => {
  const old = new ErrorsInstrumentation({ enabled: false });
  const candidate = new ErrorsInstrumentation({ enabled: false });
  const { handle } = await initialize([old]);
  const disableOld = old.disable.bind(old);
  const oldEnable = vi.spyOn(old, "enable");
  const candidateEnable = vi.spyOn(candidate, "enable");
  let shutdown: Promise<void> | undefined;
  vi.spyOn(old, "disable").mockImplementationOnce(() => {
    shutdown = handle.shutdown();
    expect(() => claimInstrumentationOwnership([old])).toThrow("browser-instrumentation-owned");
    expect(() => claimInstrumentationOwnership([candidate])).toThrow(
      "browser-instrumentation-owned",
    );
    disableOld();
  });

  await expect(handle.instrumentations.replace("errors", candidate)).rejects.toThrow(
    "Telemetry instance is stopped.",
  );
  await shutdown;
  expect(candidateEnable).not.toHaveBeenCalled();
  expect(oldEnable).not.toHaveBeenCalled();
  expect((old as unknown as { _onErrorHandler?: EventListener })._onErrorHandler).toBeUndefined();
  expect(
    (candidate as unknown as { _onErrorHandler?: EventListener })._onErrorHandler,
  ).toBeUndefined();
  const claims = claimInstrumentationOwnership([old, candidate]);
  claims.get(old)!();
  claims.get(candidate)!();
});

it.each([
  ["instrumentation", createInstrumentation()],
  ["navigation", new NavigationInstrumentation({ enabled: false })],
  ["@microsoft/opentelemetry-browser/page-view", new PageViewInstrumentation({ enabled: false })],
] as const)(
  "rejects runtime lifecycle for unsupported %s instrumentation",
  async (id, instrumentation) => {
    const { handle } = await initialize([instrumentation]);
    await expect(handle.instrumentations.setEnabled(id, false)).rejects.toThrow(
      `Runtime lifecycle is unsupported for instrumentation: ${id}`,
    );
  },
);

it("snapshots the supplied list and cleans up once in reverse registration order", async () => {
  const first = createInstrumentation();
  const second = createInstrumentation();
  const list = [first, second];
  const { handle, sdk } = await initialize(list);
  list.length = 0;
  const shutdown = handle.shutdown();
  expect(handle.shutdown()).toBe(shutdown);
  await shutdown;
  await handle.shutdown();
  expect(second.disable).toHaveBeenCalledBefore(first.disable);
  expect(first.disable).toHaveBeenCalledBefore(sdk.shutdown);
  expect(first.disable).toHaveBeenCalledOnce();
  expect(second.disable).toHaveBeenCalledOnce();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it("keeps the initial list when the caller mutates it during asynchronous resource startup", async () => {
  let resolve!: (name: string) => void;
  const resource = resourceFromAttributes({
    "service.name": new Promise<string>((done) => {
      resolve = done;
    }),
  });
  const first = createInstrumentation();
  const second = createInstrumentation();
  const replacement = createInstrumentation();
  const list = [first, second];
  const pending = initialize(list, { resource });
  list.splice(0, list.length, replacement);
  expect(first.setTracerProvider).not.toHaveBeenCalled();
  resolve("registry-snapshot-test");
  const { handle } = await pending;

  expect(first.setTracerProvider).toHaveBeenCalledOnce();
  expect(second.enable).toHaveBeenCalledOnce();
  expect(replacement.setTracerProvider).not.toHaveBeenCalled();
  expect(replacement.enable).not.toHaveBeenCalled();
  await handle.shutdown();
  expect(second.disable).toHaveBeenCalledBefore(first.disable);
  expect(replacement.disable).not.toHaveBeenCalled();
});

it("releases every claim if unload subscription fails before provider binding", async () => {
  const first = createInstrumentation();
  const last = createInstrumentation();
  const failure = new Error("unload subscription failed");
  const addEventListener = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((...args) => {
    if (args[0] === "visibilitychange") throw failure;
    addEventListener(...args);
  });
  const sdk = fakeInstance();
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(sdk);
  await expect(
    useMicrosoftOpenTelemetry({
      instrumentations: [first, last],
      pageView: { enabled: false },
      session: { enabled: false },
      userContext: { enabled: false },
    }),
  ).rejects.toBe(failure);
  expect(first.setTracerProvider).not.toHaveBeenCalled();
  expect(last.setLoggerProvider).not.toHaveBeenCalled();
  expect(first.enable).not.toHaveBeenCalled();
  expect(last.disable).toHaveBeenCalledBefore(first.disable);
  expect(first.disable).toHaveBeenCalledBefore(sdk.abort);
  expect(sdk.shutdown).toHaveBeenCalledOnce();

  vi.restoreAllMocks();
  const { handle } = await initialize([first, last]);
  await handle.shutdown();
  expect(first.disable).toHaveBeenCalledTimes(2);
  expect(last.disable).toHaveBeenCalledTimes(2);
});

it("does not rebind or disable another instance's instrumentation after a claim conflict", async () => {
  const instrumentation = createInstrumentation();
  const first = await initialize([instrumentation]);
  const rejected = fakeInstance();
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(rejected);
  await expect(
    useMicrosoftOpenTelemetry({
      instrumentations: [instrumentation],
      pageView: { enabled: false },
      session: { enabled: false },
      userContext: { enabled: false },
    }),
  ).rejects.toThrow("browser-instrumentation-owned");
  expect(instrumentation.setTracerProvider).toHaveBeenCalledExactlyOnceWith(
    first.sdk.tracerProvider,
  );
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledExactlyOnceWith(
    first.sdk.loggerProvider,
  );
  expect(instrumentation.disable).not.toHaveBeenCalled();
  expect(rejected.abort).toHaveBeenCalledOnce();
  expect(rejected.shutdown).toHaveBeenCalledOnce();
  await first.handle.shutdown();
  expect(instrumentation.disable).toHaveBeenCalledOnce();
});

it("continues cleanup and preserves a single instrumentation failure", async () => {
  const first = createInstrumentation();
  const second = createInstrumentation();
  const failure = new Error("disable failed");
  second.disable.mockImplementation(() => {
    throw failure;
  });
  const { handle, sdk } = await initialize([first, second]);
  handles.delete(handle);
  await expect(handle.shutdown()).rejects.toBe(failure);
  await expect(handle.shutdown()).rejects.toBe(failure);
  expect(first.disable).toHaveBeenCalledOnce();
  expect(second.disable).toHaveBeenCalledOnce();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it("releases ownership after a bounded shutdown cleanup retry succeeds", async () => {
  const instrumentation = new ErrorsInstrumentation({ enabled: false });
  const first = await initialize([instrumentation]);
  const second = await initialize([]);
  const failure = new Error("transient shutdown removal failed");
  const nativeRemove = window.removeEventListener.bind(window);
  let failed = false;
  const removed: string[] = [];
  vi.spyOn(window, "removeEventListener").mockImplementation((...args) => {
    if (!failed && args[0] === "error") {
      failed = true;
      throw failure;
    }
    nativeRemove(...args);
    removed.push(args[0]);
  });
  const disable = vi.spyOn(instrumentation, "disable");
  handles.delete(first.handle);

  await expect(first.handle.shutdown()).rejects.toBe(failure);
  expect(disable).toHaveBeenCalledTimes(2);
  expect(removed).toContain("error");
  expect(removed).toContain("unhandledrejection");
  await second.handle.instrumentations.add("recovered", instrumentation);
  expect(second.handle.instrumentations.get("recovered")).toBe(instrumentation);
});

it("keeps ownership quarantined when both terminal cleanup attempts fail", async () => {
  const instrumentation = new ErrorsInstrumentation({ enabled: false });
  const first = await initialize([instrumentation]);
  const second = await initialize([]);
  const failure = new Error("persistent removal failed");
  const disable = vi.spyOn(instrumentation, "disable").mockImplementation(() => {
    throw failure;
  });
  handles.delete(first.handle);
  await expect(first.handle.shutdown()).rejects.toBe(failure);
  expect(disable).toHaveBeenCalledTimes(2);
  await expect(second.handle.instrumentations.add("unsafe", instrumentation)).rejects.toThrow(
    "browser-instrumentation-owned",
  );
  disable.mockRestore();
  // The terminal handle cannot prove cleanup succeeded; clean its real listener for test isolation.
  instrumentation.disable();
});

it("does not release startup-only navigation after a flag-clearing partial cleanup failure", async () => {
  const instrumentation = new NavigationInstrumentation({ enabled: false });
  const add = vi.spyOn(window, "addEventListener");
  const { handle } = await initialize([instrumentation]);
  const listener = add.mock.calls.find(([name]) => name === "popstate")?.[1];
  expect(listener).toBeTypeOf("function");
  const failure = new Error("navigation removal failed");
  const nativeRemove = window.removeEventListener.bind(window);
  let failed = false;
  vi.spyOn(window, "removeEventListener").mockImplementation((...args) => {
    if (!failed && args[0] === "popstate") {
      failed = true;
      throw failure;
    }
    nativeRemove(...args);
  });
  handles.delete(handle);
  try {
    await expect(handle.shutdown()).rejects.toBe(failure);
    expect(() => claimInstrumentationOwnership([instrumentation])).toThrow(
      "browser-instrumentation-owned",
    );
  } finally {
    if (listener) nativeRemove("popstate", listener);
  }
});

it("retains and explicitly removes errors handlers after a partial upstream removal failure", async () => {
  const errors = new ErrorsInstrumentation({ enabled: false });
  const { handle } = await initialize([errors]);
  const handler = (errors as unknown as { _onErrorHandler?: EventListener })._onErrorHandler;
  expect(handler).toBeTypeOf("function");
  const remove = vi.spyOn(window, "removeEventListener");
  remove.mockImplementationOnce(() => {
    throw new Error("partial errors removal failed");
  });

  await expect(handle.instrumentations.setEnabled("errors", false)).rejects.toThrow(
    "partial errors removal failed",
  );
  expect(remove).toHaveBeenCalledWith("unhandledrejection", handler);
  await expect(handle.instrumentations.setEnabled("errors", true)).rejects.toThrow(
    "Instrumentation rollback failed; shutdown is required.",
  );

  await handle.shutdown();
  expect(remove).toHaveBeenCalledWith("error", handler);
  expect(remove).toHaveBeenCalledWith("unhandledrejection", handler);
});

it("does not re-enable errors when shutdown reenters through listener registration", async () => {
  const errors = new ErrorsInstrumentation({ enabled: false });
  const { handle } = await initialize([errors]);
  await handle.instrumentations.setEnabled("errors", false);
  const enable = vi.spyOn(errors, "enable");
  let shutdown: Promise<void> | undefined;
  const nativeAdd = window.addEventListener.bind(window);
  const nativeRemove = window.removeEventListener.bind(window);
  const removed: { name: string; listener: EventListenerOrEventListenerObject | null }[] = [];
  vi.spyOn(window, "removeEventListener").mockImplementation((...args) => {
    nativeRemove(...args);
    removed.push({ name: args[0], listener: args[1] });
  });
  const add = vi.spyOn(window, "addEventListener").mockImplementation((...args) => {
    if (args[0] === "error") shutdown ??= handle.shutdown();
    nativeAdd(...args);
  });

  await expect(handle.instrumentations.setEnabled("errors", true)).rejects.toThrow(
    "Telemetry instance is stopped.",
  );
  await shutdown;
  expect(add).toHaveBeenCalledWith("error", expect.any(Function));
  for (const [name, listener] of add.mock.calls) {
    // Reentrant disable clears upstream's handler before its second add; undefined is a no-op.
    if (listener && (name === "error" || name === "unhandledrejection")) {
      expect(removed).toContainEqual({ name, listener });
    }
  }
  expect(enable).toHaveBeenCalledOnce();
  await expect(handle.instrumentations.setEnabled("errors", true)).rejects.toThrow(
    "Telemetry instance is stopped.",
  );
});

it("rolls back successful peers in reverse order and blocks queued operations after a lifecycle failure", async () => {
  const first = new FetchInstrumentation({ enabled: false });
  const failing = new FetchInstrumentation({ enabled: false });
  const last = new FetchInstrumentation({ enabled: false });
  const { handle } = await initialize([first, failing, last], {
    spanProcessors: [{} as never],
  });
  const firstDisable = vi.spyOn(first, "disable");
  const firstEnable = vi.spyOn(first, "enable");
  const failingEnable = vi.spyOn(failing, "enable");
  const lastDisable = vi.spyOn(last, "disable");
  const failure = new Error("fetch removal failed");
  const failingDisable = vi.spyOn(failing, "disable").mockImplementationOnce(() => {
    throw failure;
  });

  const rejected = handle.updateCfg({ disableFetchTracking: true });
  const queued = handle.updateCfg({ samplingPercentage: 50 });
  await expect(rejected).rejects.toThrow(failure);
  await expect(queued).rejects.toThrow("Instrumentation rollback failed; shutdown is required.");
  expect(firstDisable).toHaveBeenCalledOnce();
  expect(firstEnable).toHaveBeenCalledOnce();
  expect(firstDisable).toHaveBeenCalledBefore(firstEnable);
  expect(failingEnable).toHaveBeenCalledOnce();
  expect(failingDisable).toHaveBeenCalledBefore(failingEnable);
  expect(failingEnable).toHaveBeenCalledBefore(firstEnable);
  expect(lastDisable).not.toHaveBeenCalled();
  expect(failingDisable).toHaveBeenCalledOnce();
  await expect(handle.instrumentations.setEnabled("fetch", false)).rejects.toThrow(
    "Instrumentation rollback failed; shutdown is required.",
  );
});

it("preserves lifecycle and rollback failures while attempting every inverse in reverse order", async () => {
  const first = new FetchInstrumentation({ enabled: false });
  const failing = new FetchInstrumentation({ enabled: false });
  const { handle } = await initialize([first, failing], { spanProcessors: [{} as never] });
  const failure = new Error("fetch removal failed");
  const rollbackFailure = new Error("fetch rollback failed");
  const firstEnable = vi.spyOn(first, "enable");
  const failingEnable = vi.spyOn(failing, "enable").mockImplementationOnce(() => {
    throw rollbackFailure;
  });
  vi.spyOn(failing, "disable").mockImplementationOnce(() => {
    throw failure;
  });

  await expect(handle.updateCfg({ disableFetchTracking: true })).rejects.toMatchObject({
    name: "AggregateError",
    cause: failure,
    errors: [failure, rollbackFailure],
  });
  expect(failingEnable).toHaveBeenCalledBefore(firstEnable);
  expect(firstEnable).toHaveBeenCalledOnce();
  await expect(handle.updateCfg({ samplingPercentage: 50 })).rejects.toThrow(
    "Instrumentation rollback failed; shutdown is required.",
  );
});

it("rejects runtime changes after shutdown without reviving an instrumentation", async () => {
  const console = new ConsoleInstrumentation({ enabled: false });
  const { handle } = await initialize([console]);
  await handle.shutdown();
  const enable = vi.spyOn(console, "enable");

  await expect(handle.updateCfg({ samplingPercentage: 50 })).rejects.toThrow(
    "Telemetry instance is stopped.",
  );
  await expect(handle.instrumentations.setEnabled("console", true)).rejects.toThrow(
    "Telemetry instance is stopped.",
  );
  expect(enable).not.toHaveBeenCalled();
});

it("rejects queued add, remove, and replace after shutdown without touching candidates", async () => {
  const old = new ErrorsInstrumentation({ enabled: false });
  const added = new ErrorsInstrumentation({ enabled: false });
  const replacement = new ErrorsInstrumentation({ enabled: false });
  const { handle } = await initialize([old]);
  const oldDisable = vi.spyOn(old, "disable");
  const addedBind = vi.spyOn(added, "setTracerProvider");
  const addedLogger = vi.spyOn(added, "setLoggerProvider");
  const addedEnable = vi.spyOn(added, "enable");
  const addedDisable = vi.spyOn(added, "disable");
  const replacementBind = vi.spyOn(replacement, "setTracerProvider");
  const replacementLogger = vi.spyOn(replacement, "setLoggerProvider");
  const replacementEnable = vi.spyOn(replacement, "enable");
  const replacementDisable = vi.spyOn(replacement, "disable");

  const operations = [
    handle.instrumentations.add("added", added),
    handle.instrumentations.remove("errors"),
    handle.instrumentations.replace("errors", replacement),
  ];
  const rejected = operations.map((operation) =>
    expect(operation).rejects.toThrow("Telemetry instance is stopped."),
  );
  await handle.shutdown();
  await Promise.all(rejected);
  expect(oldDisable).toHaveBeenCalledOnce();
  for (const callback of [
    addedBind,
    addedLogger,
    addedEnable,
    addedDisable,
    replacementBind,
    replacementLogger,
    replacementEnable,
    replacementDisable,
  ]) {
    expect(callback).not.toHaveBeenCalled();
  }
  const claims = claimInstrumentationOwnership([added, replacement]);
  claims.get(added)!();
  claims.get(replacement)!();
});

it("reports all instrumentation and SDK shutdown failures", async () => {
  const instrumentation = createInstrumentation();
  const disableFailure = new Error("disable failed");
  const sdkFailure = new Error("SDK shutdown failed");
  instrumentation.disable.mockImplementation(() => {
    throw disableFailure;
  });
  const { handle, sdk } = await initialize([instrumentation]);
  sdk.shutdown.mockRejectedValueOnce(sdkFailure);
  handles.delete(handle);
  await expect(handle.shutdown()).rejects.toMatchObject({
    name: "AggregateError",
    errors: [disableFailure, sdkFailure],
  });
});

it("propagates an SDK shutdown failure after disabling instrumentation", async () => {
  const instrumentation = createInstrumentation();
  const failure = new Error("SDK shutdown failed");
  const { handle, sdk } = await initialize([instrumentation]);
  sdk.shutdown.mockRejectedValueOnce(failure);
  handles.delete(handle);
  await expect(handle.shutdown()).rejects.toBe(failure);
  expect(instrumentation.disable).toHaveBeenCalledBefore(sdk.shutdown);
});

it.each(["setTracerProvider", "setLoggerProvider", "getConfig", "enable"] as const)(
  "rolls back all supplied instances and the SDK if %s fails",
  async (method) => {
    const first = createInstrumentation();
    const failing = createInstrumentation();
    const last = createInstrumentation(true);
    const failure = new Error("registration failed");
    failing[method].mockImplementation(() => {
      throw failure;
    });
    const sdk = fakeInstance();
    vi.mocked(startTelemetryInstance).mockResolvedValueOnce(sdk);
    await expect(
      useMicrosoftOpenTelemetry({ instrumentations: [first, failing, last] }),
    ).rejects.toThrow(failure);
    expect(last.disable).toHaveBeenCalledBefore(failing.disable);
    expect(failing.disable).toHaveBeenCalledBefore(first.disable);
    expect(first.disable).toHaveBeenCalledBefore(sdk.shutdown);
    expect(last.setTracerProvider).not.toHaveBeenCalled();
    await sdk.shutdown.mock.results[0].value;
  },
);

it.each([false, true])(
  "preserves initialization errors when cleanup fails and diagnostics throw=%s",
  async (diagnosticsThrow) => {
    const instrumentation = createInstrumentation();
    const failure = new Error("registration failed");
    const cleanupFailure = new Error("SDK shutdown failed");
    instrumentation.enable.mockImplementation(() => {
      throw failure;
    });
    const report = vi.spyOn(diag, "error").mockImplementation(() => {
      if (diagnosticsThrow) throw new Error("diagnostic logger failed");
    });
    vi.mocked(startTelemetryInstance).mockResolvedValueOnce({
      ...fakeInstance(),
      shutdown: vi.fn().mockRejectedValue(cleanupFailure),
    });
    await expect(useMicrosoftOpenTelemetry({ instrumentations: [instrumentation] })).rejects.toBe(
      failure,
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(
      "Telemetry initialization cleanup failed",
      cleanupFailure,
    );
  },
);
