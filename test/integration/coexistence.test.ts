// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, expect, it } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../src/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

interface Installation {
  trace: typeof trace;
  logs: typeof logs;
  context: typeof context;
  propagation: typeof propagation;
  diag: typeof diag;
  useMicrosoftOpenTelemetry: typeof useMicrosoftOpenTelemetry;
  createPipeline(): {
    spans: InMemorySpanExporter;
    records: InMemoryLogRecordExporter;
    options: MicrosoftOpenTelemetryBrowserOptions;
  };
  loadRemote(): Promise<Installation>;
}

const handles: MicrosoftOpenTelemetryBrowser[] = [];
const installations: Installation[] = [];

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
  }
});

async function loadHost(mode: string): Promise<Installation> {
  const url = new URL(`/${mode}/host.mjs`, location.href);
  const host: Installation = await import(/* @vite-ignore */ url.href);
  installations.push(host);
  return host;
}

it("accepts the API actually loaded when its patch metadata differs from the development pin", async () => {
  const host = await loadHost("runtime-patch");
  host.diag.setLogger({
    error() {},
    warn() {},
    info() {},
    debug() {},
    verbose() {},
  });
  expect(Reflect.get(globalThis, Symbol.for("opentelemetry.js.api.1"))).toMatchObject({
    version: "1.9.2",
  });
  const pipeline = host.createPipeline();
  const handle = await host.useMicrosoftOpenTelemetry(pipeline.options);
  handles.push(handle);
  host.trace.getTracer("runtime-patch").startSpan("runtime-patch").end();
  host.logs.getLogger("runtime-patch").emit({ eventName: "runtime-patch" });
  await handle.forceFlush();
  expect(pipeline.spans.getFinishedSpans()).toHaveLength(1);
  expect(pipeline.records.getFinishedLogRecords()).toHaveLength(1);
});

it.each(["shared", "isolated"])(
  "uses one pipeline across a real module federation host and remote with %s APIs",
  async (mode) => {
    const host = await loadHost(mode);
    const remote = await host.loadRemote();
    installations.push(remote);
    expect(host.trace === remote.trace).toBe(mode === "shared");
    expect(host.logs === remote.logs).toBe(mode === "shared");
    expect(host.useMicrosoftOpenTelemetry).not.toBe(remote.useMicrosoftOpenTelemetry);
    // Upstream pre-start proxies are local to each API copy, unlike post-start acquisitions.
    const earlyTracer = remote.trace.getTracer("same-scope");
    const earlyLogger = remote.logs.getLogger("same-scope");
    const pipeline = host.createPipeline();
    const handle = await host.useMicrosoftOpenTelemetry(pipeline.options);
    handles.push(handle);
    await expect(remote.useMicrosoftOpenTelemetry()).rejects.toMatchObject({
      code: "tracer-provider-conflict",
    });
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
    await handle.shutdown();
    await expect(remote.useMicrosoftOpenTelemetry()).rejects.toMatchObject({
      code: "tracer-provider-conflict",
    });
  },
);

it("reserves startup across separately bundled distribution and API copies", async () => {
  const host = await loadHost("isolated");
  const remote = await host.loadRemote();
  installations.push(remote);
  const pipeline = host.createPipeline();
  const first = host.useMicrosoftOpenTelemetry(pipeline.options);
  try {
    await expect(remote.useMicrosoftOpenTelemetry()).rejects.toMatchObject({
      code: "initialization-in-progress",
    });
  } finally {
    handles.push(await first);
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
    const fixtureUrl = new URL("/realm.mjs", location.href).href;
    const worker = kind === "worker" ? new Worker(fixtureUrl, { type: "module" }) : undefined;
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
        frame.srcdoc = `<script type="module" src="${fixtureUrl}"></script>`;
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
      frame?.remove();
    }
  },
);
