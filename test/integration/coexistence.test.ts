// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, expect, inject, it } from "vitest";
import type { AzureMonitorEnvelope } from "../../src/exporter/telemetryModels.js";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type BrowserInstrumentation,
} from "../../src/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";
import { loadBrowserScript } from "../fixtures/browserBundle.js";
import realmSource from "../fixtures/coexistenceRealm.js?raw";

interface Installation {
  trace: typeof trace;
  logs: Pick<typeof logs, "getLogger" | "getLoggerProvider" | "disable">;
  context: typeof context;
  propagation: typeof propagation;
  diag: typeof diag;
  useMicrosoftOpenTelemetry: typeof useMicrosoftOpenTelemetry;
}

const handles: MicrosoftOpenTelemetryBrowser[] = [];
const installations: Installation[] = [];
const scripts: HTMLScriptElement[] = [];

afterEach(async () => {
  try {
    for (const handle of handles.splice(0)) await handle.shutdown();
  } finally {
    for (const api of [...installations.splice(0), { trace, logs, context, propagation, diag }]) {
      api.trace.disable();
      api.logs.disable();
      api.context.disable();
      api.propagation.disable();
      api.diag.disable();
    }
    Reflect.deleteProperty(globalThis, Symbol.for("opentelemetry.js.api.1"));
    Reflect.deleteProperty(globalThis, Symbol.for("@microsoft/opentelemetry-browser"));
    for (const script of scripts.splice(0)) script.remove();
    delete window.Microsoft;
  }
});

async function loadCopies(mode = "isolated"): Promise<[Installation, Installation]> {
  const copies: Installation[] = [];
  for (const suffix of ["js", "min.js"]) {
    let copy: Installation;
    if (mode === "shared") {
      const path = `../../dist/esm/index.${suffix}`;
      const url = new URL(path, import.meta.url);
      const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
      copy = { ...distro, trace, logs, context, propagation, diag };
    } else {
      scripts.push(await loadBrowserScript(`opentelemetry-browser.iife.${suffix}`));
      const bundle = window.Microsoft?.OpenTelemetry;
      if (!bundle) throw new Error("The IIFE bundle did not initialize");
      copy = bundle;
    }
    copies.push(copy);
    installations.push(copy);
  }
  return [copies[0], copies[1]];
}

function createPipeline() {
  const { spanExporter: spans, logExporter: records, options } = createInMemoryPipeline();
  return { spans, records, options: { ...options, pageView: { enabled: false } } };
}

function probe() {
  let tracerProvider: ReturnType<typeof trace.getTracerProvider> | undefined;
  let loggerProvider: ReturnType<typeof logs.getLoggerProvider> | undefined;
  return {
    setTracerProvider(provider) {
      tracerProvider = provider;
    },
    setLoggerProvider(provider) {
      loggerProvider = provider;
    },
    getConfig: () => ({ enabled: false }),
    enable() {},
    disable() {},
    emit(name: string) {
      tracerProvider?.getTracer("same-scope").startSpan(name).end();
      loggerProvider?.getLogger("same-scope").emit({ eventName: name });
    },
  } satisfies BrowserInstrumentation & { emit(name: string): void };
}

it.each(["shared", "isolated"])(
  "shares routers while isolating separately loaded distributions with %s APIs",
  async (mode) => {
    const [host, remote] = await loadCopies(mode);
    expect(host.trace === remote.trace).toBe(mode === "shared");
    expect(host.logs === remote.logs).toBe(mode === "shared");
    expect(host.useMicrosoftOpenTelemetry).not.toBe(remote.useMicrosoftOpenTelemetry);
    // Upstream pre-start proxies are local to each API copy, unlike post-start acquisitions.
    const earlyTracer = remote.trace.getTracer("same-scope");
    const earlyLogger = remote.logs.getLogger("same-scope");
    const pipeline = createPipeline();
    const remotePipeline = createPipeline();
    const hostProbe = probe();
    const remoteProbe = probe();
    const handle = await host.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      instrumentations: [hostProbe],
    });
    handles.push(handle);
    const globals = [host.trace.getTracerProvider(), host.logs.getLoggerProvider()];
    const remoteHandle = await remote.useMicrosoftOpenTelemetry({
      ...remotePipeline.options,
      instrumentations: [remoteProbe],
    });
    handles.push(remoteHandle);
    expect([remote.trace.getTracerProvider(), remote.logs.getLoggerProvider()]).toEqual(globals);
    const earlySpan = earlyTracer.startSpan("early-span");
    expect(earlySpan.isRecording()).toBe(mode === "shared");
    expect(earlyLogger.enabled()).toBe(mode === "shared");
    earlySpan.end();
    earlyLogger.emit({ eventName: "early-log" });
    remote.trace.getTracer("same-scope").startSpan("remote-span").end();
    remote.logs.getLogger("same-scope").emit({ eventName: "remote-log" });
    host.trace.getTracer("same-scope").startSpan("host-span").end();
    host.logs.getLogger("same-scope").emit({ eventName: "host-log" });
    await handle.forceFlush();
    expect(pipeline.spans.getFinishedSpans().map((span) => span.name)).toEqual([
      ...(mode === "shared" ? ["early-span"] : []),
      "remote-span",
      "host-span",
    ]);
    expect(pipeline.records.getFinishedLogRecords().map((record) => record.eventName)).toEqual([
      ...(mode === "shared" ? ["early-log"] : []),
      "remote-log",
      "host-log",
    ]);
    remoteProbe.emit("isolated-remote");
    hostProbe.emit("isolated-host");
    await Promise.all([handle.forceFlush(), remoteHandle.forceFlush()]);
    expect(remotePipeline.spans.getFinishedSpans().map((span) => span.name)).toEqual([
      "isolated-remote",
    ]);
    expect(
      remotePipeline.records.getFinishedLogRecords().map((record) => record.eventName),
    ).toEqual(["isolated-remote"]);
    expect(pipeline.spans.getFinishedSpans().at(-1)?.name).toBe("isolated-host");
    const boundToHost = remote.trace.getTracer("bound-before-shutdown");
    await handle.shutdown();
    boundToHost.startSpan("stale").end();
    host.trace.getTracer("same-scope").startSpan("next-instance").end();
    host.logs.getLogger("same-scope").emit({ eventName: "next-instance" });
    await remoteHandle.forceFlush();
    expect(remotePipeline.spans.getFinishedSpans().map((span) => span.name)).toEqual([
      "isolated-remote",
      "next-instance",
    ]);
    expect(
      remotePipeline.records.getFinishedLogRecords().map((record) => record.eventName),
    ).toEqual(["isolated-remote", "next-instance"]);
    expect([host.trace.getTracerProvider(), host.logs.getLoggerProvider()]).toEqual(globals);
  },
);

it("supports concurrent startup across separately bundled distribution and API copies", async () => {
  const [host, remote] = await loadCopies();
  const first = createPipeline();
  const second = createPipeline();
  const a = probe();
  const b = probe();
  const started = await Promise.all([
    host.useMicrosoftOpenTelemetry({ ...first.options, instrumentations: [a] }),
    remote.useMicrosoftOpenTelemetry({ ...second.options, instrumentations: [b] }),
  ]);
  handles.push(...started);
  a.emit("a");
  b.emit("b");
  await Promise.all(started.map((handle) => handle.forceFlush()));
  expect(first.spans.getFinishedSpans().map((span) => span.name)).toEqual(["a"]);
  expect(second.spans.getFinishedSpans().map((span) => span.name)).toEqual(["b"]);
});

it("hands page correlation to a surviving distribution copy", async () => {
  const [host, remote] = await loadCopies();
  const first = createPipeline();
  const second = createPipeline();
  const a = await host.useMicrosoftOpenTelemetry({ ...first.options, pageView: {} });
  handles.push(a);
  const b = await remote.useMicrosoftOpenTelemetry({ ...second.options, pageView: {} });
  handles.push(b);
  const operation = host.trace.getSpanContext(host.context.active());
  expect(operation?.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(remote.trace.getSpanContext(remote.context.active())).toEqual(operation);
  await a.shutdown();
  expect(remote.trace.getSpanContext(remote.context.active())).toEqual(operation);
  remote.trace.getTracer("survivor").startSpan("survivor").end();
  await b.forceFlush();
  expect(second.spans.getFinishedSpans()[0]?.spanContext().traceId).toBe(operation?.traceId);
  const originalUrl = location.href;
  try {
    history.pushState(null, "", `${location.pathname}?coexistence=${crypto.randomUUID()}`);
    const latest = remote.context.active();
    expect(remote.trace.getSpanContext(latest)?.traceId).not.toBe(operation?.traceId);
    await b.shutdown();
    host.context.with(latest, () => {
      expect(host.trace.getSpanContext(host.context.active())).toBeUndefined();
    });
  } finally {
    history.replaceState(null, "", originalUrl);
  }
});

it("recognizes another copy's page context when exporting to Azure Monitor", async () => {
  const [host, remote] = await loadCopies();
  const first = createPipeline();
  const a = await host.useMicrosoftOpenTelemetry({ ...first.options, pageView: {} });
  handles.push(a);
  const operation = host.trace.getSpanContext(host.context.active());
  const runId = crypto.randomUUID();
  const endpoint = `${inject("ingestionEndpoint")}${runId}`;
  const instrumentation = probe();
  const b = await remote.useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString: `InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=${endpoint}`,
    },
    pageView: { enabled: false },
    instrumentations: [instrumentation],
  });
  handles.push(b);
  instrumentation.emit("cross-copy");
  await b.forceFlush();
  const captured: AzureMonitorEnvelope[] = await fetch(
    `${new URL(endpoint).origin}/captured?runId=${encodeURIComponent(runId)}`,
  ).then((response) => response.json());
  expect(captured).toHaveLength(2);
  for (const envelope of captured) {
    expect(envelope.tags["ai.operation.id"]).toBe(operation?.traceId);
    expect(envelope.tags).not.toHaveProperty("ai.operation.parentId");
  }
});

it.each(["iframe", "worker"])(
  "initializes an independent %s without replacing or exporting to the parent pipeline",
  async (kind) => {
    const pipeline = createInMemoryPipeline();
    const handle = await useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
    });
    handles.push(handle);
    const globals = [trace.getTracerProvider(), logs.getLoggerProvider()];
    const bundleUrl = new URL(
      "../../dist/browser/opentelemetry-browser.iife.min.js",
      import.meta.url,
    ).href;
    const workerUrl =
      kind === "worker"
        ? URL.createObjectURL(
            new Blob([`importScripts(${JSON.stringify(bundleUrl)});\n${realmSource}`], {
              type: "text/javascript",
            }),
          )
        : undefined;
    const worker = workerUrl ? new Worker(workerUrl) : undefined;
    const frame = kind === "iframe" ? document.createElement("iframe") : undefined;
    const target = worker ?? window;
    let receive: ((event: MessageEvent) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const nextMessage = () =>
      new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${kind} did not respond`)), 10_000);
        receive = (event: MessageEvent) => {
          if (frame && event.source !== frame.contentWindow) return;
          clearTimeout(timer);
          target.removeEventListener("message", receive as EventListener);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data);
        };
        target.addEventListener("message", receive as EventListener);
      });
    try {
      const initialized = nextMessage();
      if (frame) {
        frame.srcdoc = `<script src="${bundleUrl}"></script><script>${realmSource}</script>`;
        document.body.append(frame);
      }
      expect(await initialized).toEqual({ spans: ["realm-span"], logs: ["realm-log"] });
      expect([trace.getTracerProvider(), logs.getLoggerProvider()]).toEqual(globals);
      trace.getTracer("parent").startSpan("parent-span").end();
      logs.getLogger("parent").emit({ eventName: "parent-log" });
      await handle.forceFlush();
      expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
        "parent-span",
      ]);
      expect(
        pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName),
      ).toEqual(["parent-log"]);
      const stopped = nextMessage();
      if (worker) worker.postMessage("shutdown");
      else frame?.contentWindow?.postMessage("shutdown", location.origin);
      expect(await stopped).toEqual({ stopped: true });
      expect([trace.getTracerProvider(), logs.getLoggerProvider()]).toEqual(globals);
    } finally {
      clearTimeout(timer);
      if (receive) target.removeEventListener("message", receive as EventListener);
      worker?.terminate();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      frame?.remove();
    }
  },
);
