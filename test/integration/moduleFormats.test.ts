// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ContextAPI, DiagAPI, PropagationAPI, TraceAPI } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";
import { expect, it } from "vitest";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../src/index.js";
import type {
  BrowserInstrumentation,
  InstrumentationOptions,
} from "../../src/instrumentation/browserInstrumentation/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

interface BrowserBundle {
  readonly context: ContextAPI;
  readonly diag: DiagAPI;
  readonly logs: LoggerProvider & { disable(): void };
  readonly propagation: PropagationAPI;
  readonly trace: TraceAPI;
  readonly OPENTELEMETRY_BROWSER_VERSION: string;
  useMicrosoftOpenTelemetry(
    options?: MicrosoftOpenTelemetryBrowserOptions,
  ): Promise<MicrosoftOpenTelemetryBrowser>;
}

interface InstrumentationBundle {
  getInstrumentations(options?: InstrumentationOptions): Promise<BrowserInstrumentation[]>;
}

interface AmdDefine {
  (dependencies: string[], factory: (exports: Record<string, unknown>) => void): void;
  amd?: object;
}

declare global {
  interface Window {
    Microsoft?: {
      OpenTelemetry?: BrowserBundle;
      OpenTelemetryInstrumentations?: InstrumentationBundle;
    };
    define?: AmdDefine;
  }
}

async function loadScript(file: string): Promise<HTMLScriptElement> {
  const script = document.createElement("script");
  const path = `../../dist/browser/${file}`;
  script.src = new URL(path, import.meta.url).href;
  const loaded = new Promise<void>((resolve, reject) => {
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${file}`)), {
      once: true,
    });
  });
  document.head.append(script);
  try {
    await loaded;
  } catch (error) {
    script.remove();
    throw error;
  }
  return script;
}

function getBrowserBundle(): BrowserBundle | undefined {
  return window.Microsoft?.OpenTelemetry;
}

function getInstrumentationBundle(): InstrumentationBundle | undefined {
  return window.Microsoft?.OpenTelemetryInstrumentations;
}

function preserveAmdDefine(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "define");
  return () => {
    if (descriptor) {
      Object.defineProperty(window, "define", descriptor);
    } else {
      delete window.define;
    }
  };
}

function captureAmdDefine<T>(): { define: AmdDefine; getRegistration: (file: string) => T } {
  let registration: { dependencies: string[]; exports: Record<string, unknown> } | undefined;
  const define: AmdDefine = (dependencies, factory) => {
    const exports = {};
    factory(exports);
    registration = { dependencies, exports };
  };
  define.amd = {};
  return {
    define,
    // The UMD wrapper calls `define` while the script executes, so it has run before `load` fires.
    getRegistration: (file) => {
      if (!registration) throw new Error(`${file} did not call AMD define`);
      expect(registration.dependencies).toEqual(["exports"]);
      return registration.exports as unknown as T;
    },
  };
}

async function exercise(bundle: BrowserBundle): Promise<void> {
  const pipeline = createInMemoryPipeline();
  const telemetry = await bundle.useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: false },
  });
  try {
    bundle.trace.getTracer("module-format-test").startSpan("module-format").end();
    bundle.logs.getLogger("module-format-test").emit({ eventName: "module-format" });
    await telemetry.forceFlush();

    expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "module-format",
    ]);
    expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual([
      "module-format",
    ]);
  } finally {
    try {
      await telemetry.shutdown();
    } finally {
      bundle.trace.disable();
      bundle.logs.disable();
      bundle.propagation.disable();
      bundle.context.disable();
      bundle.diag.disable();
    }
  }
}

it.each([
  "opentelemetry-browser.umd.js",
  "opentelemetry-browser.umd.min.js",
  "opentelemetry-browser.iife.js",
  "opentelemetry-browser.iife.min.js",
])("loads and initializes the %s global bundle", async (file) => {
  const restoreDefine = preserveAmdDefine();
  delete window.define;
  delete window.Microsoft;
  let script: HTMLScriptElement | undefined;
  try {
    script = await loadScript(file);
    const bundle = getBrowserBundle();
    if (!bundle) throw new Error(`${file} did not define Microsoft.OpenTelemetry`);
    expect(bundle.OPENTELEMETRY_BROWSER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    await exercise(bundle);
  } finally {
    script?.remove();
    delete window.Microsoft;
    restoreDefine();
  }
});

it.each(["opentelemetry-browser.umd.js", "opentelemetry-browser.umd.min.js"])(
  "loads and initializes the %s bundle through AMD/RequireJS",
  async (file) => {
    const restoreDefine = preserveAmdDefine();
    const { define, getRegistration } = captureAmdDefine<BrowserBundle>();
    window.define = define;

    let script: HTMLScriptElement | undefined;
    try {
      script = await loadScript(file);
      await exercise(getRegistration(file));
    } finally {
      script?.remove();
      restoreDefine();
    }
  },
);

it.each([
  "opentelemetry-browser-instrumentations.umd.js",
  "opentelemetry-browser-instrumentations.umd.min.js",
  "opentelemetry-browser-instrumentations.iife.js",
  "opentelemetry-browser-instrumentations.iife.min.js",
])("loads the %s global instrumentation bundle", async (file) => {
  const restoreDefine = preserveAmdDefine();
  delete window.define;
  delete window.Microsoft;
  let script: HTMLScriptElement | undefined;
  try {
    script = await loadScript(file);
    const bundle = getInstrumentationBundle();
    expect(typeof bundle?.getInstrumentations).toBe("function");
    expect(
      await bundle?.getInstrumentations({
        fetch: { enabled: false },
        xhr: { enabled: false },
      }),
    ).toEqual([]);
  } finally {
    script?.remove();
    delete window.Microsoft;
    restoreDefine();
  }
});

it.each([
  "opentelemetry-browser-instrumentations.umd.js",
  "opentelemetry-browser-instrumentations.umd.min.js",
])("loads the %s instrumentation bundle through AMD/RequireJS", async (file) => {
  const restoreDefine = preserveAmdDefine();
  const { define, getRegistration } = captureAmdDefine<InstrumentationBundle>();
  window.define = define;

  let script: HTMLScriptElement | undefined;
  try {
    script = await loadScript(file);
    expect(
      await getRegistration(file).getInstrumentations({
        fetch: { enabled: false },
        xhr: { enabled: false },
      }),
    ).toEqual([]);
  } finally {
    script?.remove();
    restoreDefine();
  }
});
