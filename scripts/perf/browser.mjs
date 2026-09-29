// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { rollup } from "rollup";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import { chromium } from "playwright";

async function bundleApi(input, external = []) {
  const build = await rollup({
    input,
    external,
    plugins: [nodeResolve({ browser: true }), commonjs()],
  });
  try {
    const { output } = await build.generate({ format: "es" });
    if (output.length !== 1 || output[0].type !== "chunk") throw new Error("Unexpected API bundle");
    return output[0].code;
  } finally {
    await build.close();
  }
}

export async function measureBrowser() {
  const origin = "http://127.0.0.1";
  const files = new Map([
    ["/sdk.js", await readFile(new URL("../../dist/esm/index.min.js", import.meta.url), "utf8")],
    ["/api.js", await bundleApi("@opentelemetry/api")],
    ["/logs.js", await bundleApi("@opentelemetry/api-logs", ["@opentelemetry/api"])],
    [
      "/",
      `<script type="importmap">{"imports":{"@opentelemetry/api":"/api.js","@opentelemetry/api-logs":"/logs.js"}}</script>`,
    ],
  ]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ serviceWorkers: "block" });
    const unexpectedRequests = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || request.method() !== "GET" || !files.has(url.pathname)) {
        unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: url.pathname === "/" ? "text/html" : "text/javascript",
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        },
        body: files.get(url.pathname),
      });
    });
    await page.goto(origin);
    const measured = await page.evaluate(async () => {
      const { useMicrosoftOpenTelemetry, OPENTELEMETRY_BROWSER_VERSION } = await import("/sdk.js");
      const { trace, context, propagation } = await import("@opentelemetry/api");
      const { logs } = await import("@opentelemetry/api-logs");
      const samples = 15;
      const warmup = 5;
      const batch = 10_000;
      const init = [];
      const durations = [];
      let started = 0;
      let ended = 0;
      const processor = {
        onStart() {
          started++;
        },
        onEnd() {
          ended++;
        },
        async forceFlush() {},
        async shutdown() {},
      };
      const options = {
        spanProcessors: [processor],
        logRecordProcessors: [],
        pageView: { enabled: false },
        session: { enabled: false },
      };
      const timestamp = () => String(BigInt(Date.now()) * 1_000_000n);
      const reset = () => {
        trace.disable();
        logs.disable();
        context.disable();
        propagation.disable();
      };
      for (let i = 0; i < warmup + samples; i++) {
        const start = performance.now();
        const sdk = await useMicrosoftOpenTelemetry(options);
        const elapsed = performance.now() - start;
        if (i >= warmup) init.push(elapsed);
        await sdk.shutdown();
        reset();
      }
      const initTime = timestamp();
      const sdk = await useMicrosoftOpenTelemetry(options);
      try {
        const tracer = trace.getTracer("mot-browser-performance");
        const probe = tracer.startSpan("recording-check");
        if (!probe.isRecording()) throw new Error("Benchmark tracer is not recording");
        probe.end();
        if (started !== 1 || ended !== 1)
          throw new Error("Recording probe did not reach processor");
        for (let i = 0; i < warmup + samples; i++) {
          const start = performance.now();
          for (let j = 0; j < batch; j++) tracer.startSpan("benchmark.span").end();
          const elapsed = performance.now() - start;
          if (i >= warmup) durations.push(elapsed);
        }
        if (started !== 1 + (warmup + samples) * batch || ended !== started) {
          throw new Error("Not all benchmark spans reached the processor");
        }
        const spanTime = timestamp();
        return {
          packageVersion: OPENTELEMETRY_BROWSER_VERSION,
          started,
          ended,
          results: [
            {
              metric: "sdk.init.duration",
              samples: init,
              operationsPerSample: 1,
              warmupCount: warmup,
              timeUnixNano: initTime,
            },
            {
              metric: "span.record.duration",
              samples: durations,
              operationsPerSample: batch,
              warmupCount: warmup,
              timeUnixNano: spanTime,
            },
            {
              metric: "span.record.throughput",
              samples: durations.map((ms) => (batch * 1000) / ms),
              operationsPerSample: batch,
              warmupCount: warmup,
              timeUnixNano: spanTime,
            },
          ],
        };
      } finally {
        await sdk.shutdown();
        reset();
      }
    });
    if (unexpectedRequests.length) {
      throw new Error(
        `Workload attempted unexpected network requests: ${unexpectedRequests.join(", ")}`,
      );
    }
    return { ...measured, environment: { name: "Chromium", version: browser.version() } };
  } finally {
    await browser.close();
  }
}
