// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, context, diag, propagation, trace } from "@opentelemetry/api";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import { afterEach, expect, it, vi } from "vitest";
import type { MicrosoftOpenTelemetryBrowser } from "../../src/index.js";
import type { ClickAnalyticsInstrumentation } from "../../src/instrumentation/browserInstrumentation/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

const originalUrl = location.href;
const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;
const handles = new Set<MicrosoftOpenTelemetryBrowser>();
const fixtures: Element[] = [];

function mountClickTarget(markup: string): HTMLButtonElement {
  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.append(root);
  fixtures.push(root);
  const target = root.querySelector("button");
  if (!target) throw new Error("Missing click analytics fixture button");
  return target;
}

async function loadInstrumentations() {
  const url = new URL("../../dist/esm/instrumentations.js", import.meta.url);
  const instrumentations: typeof import("../../src/instrumentation/browserInstrumentation/index.js") =
    await import(/* @vite-ignore */ url.href);
  return instrumentations;
}

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  for (const fixture of fixtures.splice(0)) fixture.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.pushState = originalPushState;
  history.replaceState = originalReplaceState;
  history.replaceState(null, "", originalUrl);
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

for (const file of ["index.js", "index.min.js"]) {
  async function loadDistro() {
    const path = `../../dist/esm/${file}`;
    const url = new URL(path, import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
    return distro;
  }

  it(`registers independently imported navigation and fetch instances through ${file}`, async () => {
    const distro = await loadDistro();
    const pipeline = createInMemoryPipeline();
    const onLog = vi.spyOn(pipeline.logProcessor, "onEmit");
    const onSpan = vi.spyOn(pipeline.spanProcessor, "onStart");
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchRequest);
    const navigation = new NavigationInstrumentation({
      enabled: false,
      sanitizeUrl: (url) => new URL(url).pathname,
      applyCustomLogRecordData: (record) => {
        record.attributes = { ...record.attributes, "test.registration": true };
      },
    });
    const http = new FetchInstrumentation({
      enabled: false,
      sanitizeUrl: (url) => new URL(url).pathname,
      ignoreUrls: [/\/excluded$/],
    });
    const navigationDisable = vi.spyOn(navigation, "disable");
    const httpDisable = vi.spyOn(http, "disable");
    const handle = await distro.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      instrumentations: Object.freeze([navigation, http]),
    });
    handles.add(handle);

    history.pushState(null, "", "/registration-page?secret=redact#private");
    await fetch(new URL("/registration-request?secret=redact", location.origin));
    await fetch(new URL("/excluded", location.origin));
    await pipeline.forceFlush();

    const records = pipeline.logExporter.getFinishedLogRecords();
    const record = records.find((entry) => entry.attributes["url.full"] === "/registration-page");
    expect(record).toMatchObject({
      eventName: "browser.navigation",
      severityNumber: SeverityNumber.INFO,
      instrumentationScope: { name: "@opentelemetry/browser-instrumentation/navigation" },
      attributes: {
        "url.full": "/registration-page",
        "browser.navigation.same_document": true,
        "browser.navigation.hash_change": false,
        "browser.navigation.type": "push",
        "test.registration": true,
      },
    });
    const spans = pipeline.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "GET",
      kind: SpanKind.CLIENT,
      instrumentationScope: { name: "@opentelemetry/browser-instrumentation/fetch" },
      attributes: {
        "url.full": new URL("/registration-request", document.baseURI).href,
        "http.request.method": "GET",
        "http.response.status_code": 204,
        "server.address": location.hostname,
      },
    });
    expect(fetchRequest).toHaveBeenCalledTimes(2);

    await handle.shutdown();
    handles.delete(handle);
    const logCount = onLog.mock.calls.length;
    const spanCount = onSpan.mock.calls.length;
    history.pushState(null, "", "/after-shutdown");
    await fetch(new URL("/after-shutdown", location.origin));
    expect(onLog).toHaveBeenCalledTimes(logCount);
    expect(onSpan).toHaveBeenCalledTimes(spanCount);
    await handle.shutdown();
    expect(navigationDisable).toHaveBeenCalledOnce();
    expect(httpDisable).toHaveBeenCalledOnce();
  });

  it(`registers the emitted click analytics factory instance and stops capture after shutdown through ${file}`, async () => {
    const distro = await loadDistro();
    const { createClickAnalyticsInstrumentation } = await loadInstrumentations();
    const pipeline = createInMemoryPipeline();
    const onLog = vi.spyOn(pipeline.logProcessor, "onEmit");
    const applyCustomLogRecordData = vi.fn();
    const click = await createClickAnalyticsInstrumentation({
      enabled: true,
      dataTags: { parentDataTag: "boundary" },
      pageTags: { owner: "factory" },
      applyCustomLogRecordData,
    });
    expect(click.getConfig().enabled).toBe(false);
    const disable = vi.spyOn(click, "disable");
    const target = mountClickTarget(
      '<section data-id="parent" data-boundary="stop"><button data-id="purchase" data-category="checkout"><span>Buy</span></button></section>',
    );
    const nested = target.querySelector("span");
    if (!nested) throw new Error("Missing nested click target");
    nested.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    click.capturePageAction(target);
    click.trackPageAction({ name: "before-registration" });
    expect(applyCustomLogRecordData).not.toHaveBeenCalled();

    const handle = await distro.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      instrumentations: Object.freeze([click]),
    });
    handles.add(handle);

    nested.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    click.capturePageAction(target, { actionType: "custom" });
    click.trackPageAction({ name: "manual", properties: { source: "application" } });
    await handle.forceFlush();
    const records = pipeline.logExporter.getFinishedLogRecords();
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      eventName: "browser.click",
      severityNumber: SeverityNumber.INFO,
      instrumentationScope: { name: "@microsoft/opentelemetry-browser/click-analytics" },
      attributes: {
        "browser.click.name": "purchase",
        "browser.click.parent_id": "parent",
        "browser.click.action_type": "CL",
        "browser.click.content": '[{"category":"checkout"}]',
      },
    });
    expect(JSON.parse(records[0].attributes["browser.click.properties"] as string)).toMatchObject({
      pageTags: { owner: "factory" },
    });
    expect(records[1].attributes["browser.click.action_type"]).toBe("custom");
    expect(records[2].attributes).toMatchObject({
      "browser.click.name": "manual",
      "browser.click.properties": '{"source":"application"}',
    });
    expect(onLog).toHaveBeenCalledTimes(3);
    expect(applyCustomLogRecordData).toHaveBeenCalledTimes(3);

    await handle.shutdown();
    handles.delete(handle);
    nested.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    click.capturePageAction(target);
    click.trackPageAction({ name: "after-shutdown" });
    expect(onLog).toHaveBeenCalledTimes(3);
    expect(applyCustomLogRecordData).toHaveBeenCalledTimes(3);
    await handle.shutdown();
    expect(disable).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    `retries click listener cleanup during shutdown through ${file} (persistent: %s)`,
    async (persistent) => {
      const distro = await loadDistro();
      const { createClickAnalyticsInstrumentation } = await loadInstrumentations();
      const pipeline = createInMemoryPipeline();
      const onLog = vi.spyOn(pipeline.logProcessor, "onEmit");
      const click = await createClickAnalyticsInstrumentation();
      const add = vi.spyOn(window, "addEventListener");
      const handle = await distro.useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: false },
        instrumentations: [click],
      });
      handles.add(handle);
      const listener = add.mock.calls.find(([type]) => type === "mousedown")?.[1];
      expect(listener).toBeTypeOf("function");
      const originalRemove = window.removeEventListener.bind(window);
      const attempts = new Map<string, number>();
      const warn = vi.spyOn(diag, "warn");
      const remove = vi
        .spyOn(window, "removeEventListener")
        .mockImplementation((type, callback, options) => {
          if (callback === listener) {
            attempts.set(type, (attempts.get(type) ?? 0) + 1);
            if (persistent || attempts.get(type) === 1) throw new Error("cleanup failed");
          }
          originalRemove(type, callback, options);
        });
      try {
        await handle.shutdown();
        handles.delete(handle);
        expect(attempts).toEqual(
          new Map([
            ["mousedown", 2],
            ["keyup", 2],
          ]),
        );
        if (persistent) expect(warn).toHaveBeenCalledWith("Click cleanup failed after retry.");
        else expect(warn).not.toHaveBeenCalledWith("Click cleanup failed after retry.");
        const target = mountClickTarget('<button data-id="shutdown">Click</button>');
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
        click.trackPageAction({ name: "after-shutdown" });
        expect(onLog).not.toHaveBeenCalled();
      } finally {
        remove.mockRestore();
        click.disable();
      }
    },
  );

  it(`preserves a newer registered click activation when an older restart throws through ${file}`, async () => {
    const distro = await loadDistro();
    const { createClickAnalyticsInstrumentation } = await loadInstrumentations();
    const pipeline = createInMemoryPipeline();
    const onLog = vi.spyOn(pipeline.logProcessor, "onEmit");
    const click = await createClickAnalyticsInstrumentation();
    const handle = await distro.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      instrumentations: [click],
    });
    handles.add(handle);
    const originalAdd = window.addEventListener.bind(window);
    const failure = new Error("old registration failed");
    let reentered = false;
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      if (!reentered && type === "mousedown") {
        reentered = true;
        click.disable();
        click.enable();
        originalAdd(type, listener, options);
        throw failure;
      }
      originalAdd(type, listener, options);
    });
    expect(() => click.setConfig({ enabled: true })).toThrow(failure);
    const target = mountClickTarget('<button data-id="restart">Click</button>');
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    await handle.forceFlush();
    expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(2);
    expect(onLog).toHaveBeenCalledTimes(2);
    await handle.shutdown();
    handles.delete(handle);
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    click.trackPageAction({ name: "after-shutdown" });
    expect(onLog).toHaveBeenCalledTimes(2);
  });

  it(`isolates emitted click analytics helper configurations and shutdown across instances through ${file}`, async () => {
    const distro = await loadDistro();
    const { getInstrumentations, BehaviorMapValidator } = await loadInstrumentations();
    const owners = ["first", "second"] as const;
    const pipelines = owners.map(() => createInMemoryPipeline());
    const onLog = pipelines.map((pipeline) => vi.spyOn(pipeline.logProcessor, "onEmit"));
    const clicks = await Promise.all(
      owners.map(async (owner, index) => {
        const instrumentations = await getInstrumentations({
          fetch: { enabled: false },
          xhr: { enabled: false },
          clickAnalytics: {
            enabled: true,
            dataTags: { customDataPrefix: `data-${owner}-` },
            behaviorValidator: BehaviorMapValidator({ purchase: index + 1 }),
            pageTags: { owner },
            callback: { pageName: () => `${owner} page` },
          },
        });
        expect(instrumentations).toHaveLength(1);
        const click = instrumentations[0] as ClickAnalyticsInstrumentation;
        expect(click).toMatchObject({
          instrumentationName: "@microsoft/opentelemetry-browser/click-analytics",
          capturePageAction: expect.any(Function),
          trackPageAction: expect.any(Function),
        });
        expect(click.getConfig().enabled).toBe(false);
        return click;
      }),
    );
    const registrations: MicrosoftOpenTelemetryBrowser[] = [];
    for (const [index, pipeline] of pipelines.entries()) {
      const handle = await distro.useMicrosoftOpenTelemetry({
        ...pipeline.options,
        pageView: { enabled: false },
        instrumentations: [clicks[index]],
      });
      handles.add(handle);
      registrations.push(handle);
    }
    const target = mountClickTarget(
      '<button data-first-id="first action" data-first-bhvr="purchase" data-second-id="second action" data-second-bhvr="purchase"></button>',
    );
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    for (const [index, pipeline] of pipelines.entries()) {
      await pipeline.forceFlush();
      const records = pipeline.logExporter.getFinishedLogRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        eventName: "browser.click",
        attributes: {
          "browser.click.name": `${owners[index]} action`,
          "browser.page_view.name": `${owners[index]} page`,
          "browser.click.behavior": index + 1,
          "browser.click.content": "[{}]",
        },
      });
      expect(JSON.parse(records[0].attributes["browser.click.properties"] as string)).toMatchObject(
        {
          pageTags: { owner: owners[index] },
        },
      );
    }

    await registrations[0].shutdown();
    handles.delete(registrations[0]);
    target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    clicks[0].capturePageAction(target);
    clicks[0].trackPageAction({ name: "stopped" });
    await pipelines[1].forceFlush();
    expect(onLog[0]).toHaveBeenCalledTimes(1);
    expect(onLog[1]).toHaveBeenCalledTimes(2);
    expect(pipelines[1].logExporter.getFinishedLogRecords()[1].attributes).toMatchObject({
      "browser.click.name": "second action",
      "browser.click.action_type": "KE",
      "browser.click.behavior": 2,
    });
    await registrations[1].shutdown();
    handles.delete(registrations[1]);
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    clicks[1].capturePageAction(target);
    clicks[1].trackPageAction({ name: "also stopped" });
    expect(onLog[0]).toHaveBeenCalledTimes(1);
    expect(onLog[1]).toHaveBeenCalledTimes(2);
  });

  it(`rejects manually enabled click analytics with disabled config before provider binding through ${file}`, async () => {
    const distro = await loadDistro();
    const { createClickAnalyticsInstrumentation } = await loadInstrumentations();
    const pipeline = createInMemoryPipeline();
    const click = await createClickAnalyticsInstrumentation({ enabled: false });
    const setLoggerProvider = vi.spyOn(click, "setLoggerProvider");
    const setTracerProvider = vi.spyOn(click, "setTracerProvider");
    const enable = vi.spyOn(click, "enable");
    click.enable();
    expect(click.getConfig().enabled).toBe(false);
    enable.mockClear();
    try {
      await expect(
        distro.useMicrosoftOpenTelemetry({
          ...pipeline.options,
          pageView: { enabled: false },
          instrumentations: [click],
        }),
      ).rejects.toThrow("browser-instrumentation-active");
      expect(setLoggerProvider).not.toHaveBeenCalled();
      expect(setTracerProvider).not.toHaveBeenCalled();
      expect(enable).not.toHaveBeenCalled();
    } finally {
      click.disable();
      await pipeline.shutdown();
    }
  });

  it.each([
    [false, true],
    [true, true],
    [true, false],
  ])(
    `redacts concurrent fetch/XHR URLs per instance without changing requests through ${file} (relative sanitizer: %s, configured parameters: %s)`,
    async (relative, configured) => {
      const distro = await loadDistro();
      const pipelines = [createInMemoryPipeline(), createInMemoryPipeline()];
      const sanitizeUrl = relative
        ? (url: string): string => {
            const parsed = new URL(url);
            return parsed.pathname + parsed.search + "#access_token=private&alpha=one&beta=two";
          }
        : undefined;
      for (const [index, pipeline] of pipelines.entries()) {
        const handle = await distro.useMicrosoftOpenTelemetry({
          ...pipeline.options,
          session: { enabled: false },
          userContext: { enabled: false },
          pageView: { enabled: false },
          redactQueryParams: configured ? [index === 0 ? "alpha" : "beta"] : undefined,
          // Independently constructed upstream instances must receive the same protection.
          instrumentations: [
            new FetchInstrumentation({ enabled: false, sanitizeUrl }),
            new XhrInstrumentation({ enabled: false, sanitizeUrl }),
          ],
        });
        handles.add(handle);
      }
      const urls = ["fetch-one", "fetch-two", "xhr-one", "xhr-two"].map(
        (request) =>
          new URL(`/?request=${request}&token=private&alpha=one&beta=two`, location.origin).href,
      );
      const responses = await Promise.all([
        ...urls.slice(0, 2).map(async (url) => {
          const response = await fetch(url);
          await response.text();
          return response.url;
        }),
        ...urls.slice(2).map(
          (url) =>
            new Promise<string>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open("GET", url);
              xhr.onload = () => resolve(xhr.responseURL);
              xhr.onerror = () => reject(new Error("XHR failed"));
              xhr.send();
            }),
        ),
      ]);
      expect(responses).toEqual(urls);
      for (const [index, pipeline] of pipelines.entries()) {
        // Fetch instrumentation finishes after its response-body reader settles.
        await vi.waitFor(async () => {
          await pipeline.forceFlush();
          expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(4);
        });
        const spans = pipeline.spanExporter.getFinishedSpans();
        expect(spans).toHaveLength(4);
        expect(spans.map((span) => span.attributes["url.full"]).sort()).toEqual(
          urls
            .map((url) => {
              const output = relative ? `${url}#access_token=private&alpha=one&beta=two` : url;
              const redacted = output.replaceAll("token=private", "token=REDACTED");
              return configured
                ? redacted.replaceAll(
                    index === 0 ? "alpha=one" : "beta=two",
                    index === 0 ? "alpha=REDACTED" : "beta=REDACTED",
                  )
                : redacted;
            })
            .sort(),
        );
        expect(new Set(spans.map((span) => span.instrumentationScope.name))).toEqual(
          new Set([
            "@opentelemetry/browser-instrumentation/fetch",
            "@opentelemetry/browser-instrumentation/xhr",
          ]),
        );
      }
    },
  );

  it(`rejects already-enabled navigation before binding providers through ${file}`, async () => {
    const distro = await loadDistro();
    const pipeline = createInMemoryPipeline();
    const navigation = new NavigationInstrumentation();
    const enable = vi.spyOn(navigation, "enable");
    try {
      await expect(
        distro.useMicrosoftOpenTelemetry({
          ...pipeline.options,
          instrumentations: [navigation],
          pageView: { enabled: false },
        }),
      ).rejects.toThrow("browser-instrumentation-active");
      expect(enable).not.toHaveBeenCalled();
    } finally {
      navigation.disable();
    }
  });

  it(`leaves browser APIs untouched when everything is switched off through ${file}`, async () => {
    const distro = await loadDistro();
    const pipeline = createInMemoryPipeline();
    const fetchBefore = globalThis.fetch;
    const pushBefore = history.pushState;
    // Page view is owned by the distribution and on by default, so switching it off is what
    // leaves the page untouched.
    const handle = await distro.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
    });
    handles.add(handle);
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(history.pushState).toBe(pushBefore);
    history.pushState(null, "", "/unobserved");
    await pipeline.logProcessor.forceFlush();
    expect(pipeline.logExporter.getFinishedLogRecords()).toEqual([]);
  });

  it(`collects page views with no instrumentation supplied through ${file}`, async () => {
    const distro = await loadDistro();
    const pipeline = createInMemoryPipeline();
    const handle = await distro.useMicrosoftOpenTelemetry(pipeline.options);
    handles.add(handle);
    history.pushState(null, "", "/owned-by-the-distro");
    await pipeline.logProcessor.forceFlush();
    expect(
      pipeline.logExporter
        .getFinishedLogRecords()
        .some((record) => record.eventName === "browser.page_view"),
    ).toBe(true);
  });
}
