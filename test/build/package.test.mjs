import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { parse as parseScript } from "acorn";
import { rollup } from "rollup";
import ts from "typescript";
import { browserBundleBudgets } from "../../scripts/measure-bundle-size.mjs";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const require = createRequire(import.meta.url);
const esmBundle = "dist/esm/index";
const sharedApiPackages = ["@opentelemetry/api", "@opentelemetry/api-logs"];

function findUndeclaredRequireCalls(code) {
  const source = ts.createSourceFile("bundle.js", code, ts.ScriptTarget.Latest, true);
  const scopes = new Map([[source, new Set()]]);
  const calls = [];
  const enclosingScope = (node) => {
    let current = node.parent;
    while (current && !scopes.has(current)) current = current.parent;
    return current ?? source;
  };
  const declare = (node, name) => {
    if (name && ts.isIdentifier(name)) scopes.get(enclosingScope(node)).add(name.text);
  };
  const visit = (node) => {
    if (ts.isFunctionLike(node)) {
      // A function declaration's name belongs to the surrounding scope; everything else is local.
      if (ts.isFunctionDeclaration(node)) declare(node, node.name);
      scopes.set(node, new Set());
      if (ts.isFunctionExpression(node) && node.name) scopes.get(node).add(node.name.text);
    } else if (
      ts.isParameter(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isClassDeclaration(node)
    ) {
      declare(node, node.name);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^require(?:$|[$A-Z_])/.test(node.expression.text)
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const undeclared = new Set();
  for (const call of calls) {
    const name = call.expression.text;
    let scope = enclosingScope(call);
    while (scope && !scopes.get(scope).has(name)) {
      scope = scope === source ? undefined : enclosingScope(scope);
    }
    if (!scope) undeclared.add(name);
  }
  return [...undeclared].sort();
}

test("the package is configured for a public alpha release", () => {
  assert.equal(pkg.name, "@microsoft/opentelemetry-browser");
  assert.equal(pkg.version, "0.1.0-alpha.2");
  assert.equal(Object.hasOwn(pkg, "private"), false);
  assert.deepEqual(pkg.publishConfig, {
    access: "public",
    tag: "alpha",
  });
});

async function bundleConsumer(source, external = []) {
  const input = "\0consumer";
  const bundle = await rollup({
    input,
    external,
    plugins: [
      {
        name: "package-consumer",
        resolveId(id) {
          if (id === input) return input;
          if (id === "distro") return fileURLToPath(new URL(pkg.exports["."].import.default, root));
        },
        load(id) {
          if (id === input) return source;
        },
      },
      nodeResolve({ browser: true }),
      commonjs(),
    ],
    onwarn(warning, defaultHandler) {
      if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
      if (warning.code !== "EMPTY_BUNDLE") defaultHandler(warning);
    },
  });
  try {
    const { output } = await bundle.generate({ format: "es" });
    assert.equal(output.length, 1);
    assert.equal(output[0].type, "chunk");
    assert.deepEqual(output[0].imports.sort(), [...external].sort());
    return output[0];
  } finally {
    await bundle.close();
  }
}

test("the package exposes ESM and CommonJS entry points", () => {
  assert.equal(pkg.type, "module");
  assert.equal(pkg.sideEffects, false);
  assert.equal(pkg.main, "./dist/commonjs/index.cjs");
  assert.equal(pkg.module, "./dist/esm/index.js");
  assert.deepEqual(pkg.exports, {
    ".": {
      import: {
        types: "./dist/esm/index.d.ts",
        default: "./dist/esm/index.js",
      },
      require: {
        types: "./dist/commonjs/index.d.cts",
        default: "./dist/commonjs/index.cjs",
      },
    },
    "./instrumentations": {
      import: {
        types: "./dist/esm/instrumentations.d.ts",
        default: "./dist/esm/instrumentations.js",
      },
      require: {
        types: "./dist/commonjs/instrumentations.d.cts",
        default: "./dist/commonjs/instrumentations.cjs",
      },
    },
    "./snippet": {
      import: {
        types: "./dist/esm/snippet.d.ts",
        default: "./dist/esm/snippet.js",
      },
    },
    "./package.json": "./package.json",
  });
  assert.equal(pkg.types, pkg.exports["."].import.types);
});

test("the build produces ESM, CommonJS, UMD, and IIFE artifacts", async () => {
  assert.deepEqual((await readdir(new URL("dist/", root))).sort(), ["browser", "commonjs", "esm"]);
  assert.deepEqual((await readdir(new URL("dist/esm/", root))).sort(), [
    "index.d.ts",
    "index.js",
    "index.js.map",
    "index.min.js",
    "index.min.js.map",
    "instrumentations.d.ts",
    "instrumentations.js",
    "instrumentations.js.map",
    "snippet.d.ts",
    "snippet.js",
    "snippet.js.map",
  ]);
  assert.deepEqual((await readdir(new URL("dist/commonjs/", root))).sort(), [
    "index.cjs",
    "index.cjs.map",
    "index.d.cts",
    "instrumentations.cjs",
    "instrumentations.cjs.map",
    "instrumentations.d.cts",
  ]);
  assert.deepEqual((await readdir(new URL("dist/browser/", root))).sort(), [
    "opentelemetry-browser-instrumentations.iife.js",
    "opentelemetry-browser-instrumentations.iife.js.map",
    "opentelemetry-browser-instrumentations.iife.min.js",
    "opentelemetry-browser-instrumentations.iife.min.js.map",
    "opentelemetry-browser-instrumentations.umd.js",
    "opentelemetry-browser-instrumentations.umd.js.map",
    "opentelemetry-browser-instrumentations.umd.min.js",
    "opentelemetry-browser-instrumentations.umd.min.js.map",
    "opentelemetry-browser.iife.js",
    "opentelemetry-browser.iife.js.map",
    "opentelemetry-browser.iife.min.js",
    "opentelemetry-browser.iife.min.js.map",
    "opentelemetry-browser.umd.js",
    "opentelemetry-browser.umd.js.map",
    "opentelemetry-browser.umd.min.js",
    "opentelemetry-browser.umd.min.js.map",
  ]);
});

test("browser bundles contain only ES2022 syntax and have size budgets", async () => {
  const files = (await readdir(new URL("dist/browser/", root)))
    .filter((file) => file.endsWith(".js"))
    .sort();
  for (const file of files) {
    const code = await readFile(new URL(`dist/browser/${file}`, root), "utf8");
    assert.doesNotThrow(
      () => parseScript(code, { ecmaVersion: 2022, sourceType: "script" }),
      `${file} must contain only ES2022 syntax`,
    );
  }
  assert.deepEqual(
    Object.keys(browserBundleBudgets).sort(),
    files.filter((file) => file.endsWith(".min.js")).map((file) => `dist/browser/${file}`),
  );
});

async function exerciseNpmPackage(distro) {
  const spans = new InMemorySpanExporter();
  const records = new InMemoryLogRecordExporter();
  const tracer = trace.getTracer("package-consumer");
  const logger = logs.getLogger("package-consumer");
  const options = {
    spanProcessors: [new SimpleSpanProcessor(spans)],
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: records })],
  };
  const telemetry = await distro.useMicrosoftOpenTelemetry(options);
  try {
    tracer.startSpan("manual").end();
    logger.emit({ eventName: "manual" });
    await telemetry.forceFlush();
    assert.equal(spans.getFinishedSpans()[0]?.name, "manual");
    assert.equal(records.getFinishedLogRecords()[0]?.eventName, "manual");
    assert.equal("forceFlush" in telemetry, true);
  } finally {
    try {
      await telemetry.shutdown();
    } finally {
      trace.disable();
      logs.disable();
      propagation.disable();
      context.disable();
      diag.disable();
    }
  }
}

test("the only initializer is a distro-owned wrapper", async () => {
  const distro = await import(pkg.name);
  assert.notEqual(distro.useMicrosoftOpenTelemetry, startBrowserSdk);
  assert.deepEqual(Object.keys(distro).sort(), [
    "AzureMonitorLogRecordExporter",
    "AzureMonitorSpanExporter",
    "BrowserDetector",
    "OPENTELEMETRY_BROWSER_VERSION",
    "UserAgentDetector",
    "browserDetector",
    "useMicrosoftOpenTelemetry",
    "userAgentDetector",
  ]);
});

test("the root ESM initializer configures both traces and logs", async () => {
  const distro = await import(pkg.name);
  assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
  await exerciseNpmPackage(distro);
});

test("standard OTLP processors export alongside other processors", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  t.after(() => {
    trace.disable();
    logs.disable();
    propagation.disable();
    context.disable();
    diag.disable();
  });

  const distro = await import(pkg.name);
  const spans = new InMemorySpanExporter();
  const records = new InMemoryLogRecordExporter();
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const headers = Object.freeze({ "x-tenant": "checkout" });
  const spanProcessors = Object.freeze([
    new SimpleSpanProcessor(spans),
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers })),
  ]);
  const logRecordProcessors = Object.freeze([
    new SimpleLogRecordProcessor({ exporter: records }),
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }),
    }),
  ]);
  const telemetry = await distro.useMicrosoftOpenTelemetry({
    spanProcessors,
    logRecordProcessors,
  });
  try {
    trace.getTracer("additive-export").startSpan("checkout").end();
    logs.getLogger("additive-export").emit({ eventName: "checkout.started" });
    await Promise.all([...spanProcessors, ...logRecordProcessors].map((p) => p.forceFlush()));
    assert.equal(spans.getFinishedSpans()[0]?.name, "checkout");
    assert.equal(records.getFinishedLogRecords()[0]?.eventName, "checkout.started");
  } finally {
    await telemetry.shutdown();
  }

  assert.deepEqual(requests.map((request) => request.path).sort(), ["/v1/logs", "/v1/traces"]);
  for (const request of requests) assert.equal(request.headers["x-tenant"], "checkout");
  const traceRequest = requests.find((request) => request.path === "/v1/traces");
  const logRequest = requests.find((request) => request.path === "/v1/logs");
  assert.equal(traceRequest.body.resourceSpans[0].scopeSpans[0].spans[0].name, "checkout");
  assert.equal(
    logRequest.body.resourceLogs[0].scopeLogs[0].logRecords[0].eventName,
    "checkout.started",
  );
});

test("using the initializer includes both SDKs and their default exporters", async () => {
  const chunk = await bundleConsumer('export { useMicrosoftOpenTelemetry } from "distro";');
  assert.doesNotMatch(chunk.code, /BrowserDetector|UserAgentDetector/);
  const modules = Object.entries(chunk.modules)
    .filter(([, module]) => module.renderedLength > 0)
    .map(([id]) => id.replaceAll("\\", "/"));
  // The initializer deliberately pulls in the instrumentations this distribution owns and turns
  // on by itself. They are selected by configuration, not by import, so they are part of the
  // initializer's cost by design rather than an accidental dependency.
  for (const name of [
    "sdk-trace",
    "sdk-logs",
    "exporter-trace-otlp-http",
    "exporter-logs-otlp-http",
  ]) {
    assert.ok(
      modules.some((id) => id.includes(`/@opentelemetry/${name}/`)),
      `${name} must be included by the combined initializer`,
    );
  }
});

test("individual upstream instrumentation imports do not retain other instrumentations", async () => {
  for (const [name, className] of [
    ["navigation", "NavigationInstrumentation"],
    ["fetch", "FetchInstrumentation"],
  ]) {
    const chunk = await bundleConsumer(`
      import { useMicrosoftOpenTelemetry } from "distro";
      import { ${className} } from "@opentelemetry/browser-instrumentation/experimental/${name}";
      export const telemetry = useMicrosoftOpenTelemetry({
        instrumentations: [new ${className}({ enabled: false })],
      });
    `);
    const modules = Object.entries(chunk.modules)
      .filter(([, module]) => module.renderedLength > 0)
      .map(([id]) => id.replaceAll("\\", "/"));
    assert.ok(
      modules.some((id) => id.includes(`/browser-instrumentation/dist/${name}/`)),
      `the selected ${name} instrumentation must remain in the consumer bundle`,
    );
    for (const omitted of [
      "console",
      "errors",
      "navigation",
      "navigation-timing",
      "resource-timing",
      "user-action",
      "web-vitals",
      "fetch",
      "xhr",
    ].filter((candidate) => candidate !== name)) {
      assert.ok(
        modules.every((id) => !id.includes(`/browser-instrumentation/dist/${omitted}/`)),
        `selecting ${name} must not include ${omitted}`,
      );
    }
    assert.ok(modules.every((id) => !id.includes("/web-vitals/")));
  }
});

test("detector-only imports do not retain telemetry SDKs or exporters", async () => {
  const chunk = await bundleConsumer(
    'export { browserDetector, userAgentDetector } from "distro";',
  );
  assert.doesNotMatch(
    chunk.code,
    /SessionManager|SessionSpanProcessor|SessionLogRecordProcessor|opentelemetry-session/,
  );
  for (const [id, module] of Object.entries(chunk.modules)) {
    if (module.renderedLength > 0) {
      assert.doesNotMatch(id.replaceAll("\\", "/"), /\/@opentelemetry\/(?:sdk-|exporter-)/);
    }
  }
});

test("the minified artifact keeps both API packages external", async () => {
  const bundle = await rollup({
    input: fileURLToPath(new URL(`${esmBundle}.min.js`, root)),
    external: sharedApiPackages,
    onwarn(warning) {
      throw new Error(warning.message);
    },
  });
  try {
    const { output } = await bundle.generate({ format: "es" });
    assert.deepEqual(output[0].imports.sort(), sharedApiPackages);
    const map = JSON.parse(await readFile(new URL(`${esmBundle}.min.js.map`, root), "utf8"));
    assert.ok(
      map.sources.every(
        (source) => !/\/@opentelemetry\/api(?:-logs)?\//.test(source.replaceAll("\\", "/")),
      ),
      "API implementations must not be embedded in the minified SDK bundle",
    );
  } finally {
    await bundle.close();
  }
});

test("the CommonJS initializer configures both traces and logs", async () => {
  const distro = require(pkg.name);
  assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
  await exerciseNpmPackage(distro);
});

test("the CommonJS instrumentations subpath constructs selected instrumentations", async () => {
  const { getInstrumentations } = require(`${pkg.name}/instrumentations`);
  const instrumentations = await getInstrumentations({
    fetch: { enabled: false },
    xhr: { enabled: false },
    console: { enabled: true },
  });
  assert.equal(instrumentations.length, 1);
  assert.equal(instrumentations[0].constructor.name, "ConsoleInstrumentation");
});

test("version-only and bare imports can tree-shake all SDKs", async () => {
  for (const source of [
    'export { OPENTELEMETRY_BROWSER_VERSION } from "distro";',
    'import "distro";',
  ]) {
    const chunk = await bundleConsumer(source);
    assert.ok(
      Object.entries(chunk.modules)
        .filter(([, module]) => module.renderedLength > 0)
        .every(([id]) => !id.includes("node_modules")),
    );
    if (source.startsWith("import")) assert.equal(chunk.code.trim(), "");
    else assert.match(chunk.code, /OPENTELEMETRY_BROWSER_VERSION/);
  }
});

test("the root entry ships the combined initializer's declarations", async () => {
  const declaration = await readFile(new URL(pkg.exports["."].import.types, root), "utf8");
  for (const name of ["OPENTELEMETRY_BROWSER_VERSION", "useMicrosoftOpenTelemetry"])
    assert.match(declaration, new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`));
});

test("the package metadata remains exported", () => {
  assert.deepEqual(require(`${pkg.name}/package.json`), pkg);
});

for (const suffix of [".js", ".min.js"]) {
  test(`the ${suffix} bundle exposes the same ESM API`, async () => {
    const distro = await import(new URL(`${esmBundle}${suffix}`, root));
    const entry = await import(pkg.name);
    assert.deepEqual(Object.keys(distro).sort(), Object.keys(entry).sort());
    assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
    await exerciseNpmPackage(distro);
  });
}

test("Terser produces a smaller ESM bundle", async () => {
  const [standard, minified] = await Promise.all([
    bundleConsumer('export * from "distro";', sharedApiPackages),
    readFile(new URL(`${esmBundle}.min.js`, root)),
  ]);
  assert.ok(minified.byteLength < Buffer.byteLength(standard.code));
});

for (const [name, module, moduleResolution] of [
  ["NodeNext", ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
  ["Bundler", ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
]) {
  test(`ESM consumers resolve declarations with ${name}`, () => {
    const program = ts.createProgram(
      [fileURLToPath(new URL("fixtures/consumer.mts", import.meta.url))],
      {
        target: ts.ScriptTarget.ES2022,
        module,
        moduleResolution,
        strict: true,
        noEmit: true,
        types: [],
      },
    );
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => "\n",
      }),
    );
  });
}

for (const [name, module, moduleResolution] of [
  ["Node16", ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16],
  ["NodeNext", ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
]) {
  test(`CommonJS consumers resolve CommonJS declarations with ${name}`, () => {
    const program = ts.createProgram(
      [fileURLToPath(new URL("fixtures/consumer.cts", import.meta.url))],
      {
        target: ts.ScriptTarget.ES2022,
        module,
        moduleResolution,
        strict: true,
        noEmit: true,
        types: ["node"],
      },
    );
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => "\n",
      }),
    );
    const packageDist = fileURLToPath(new URL("dist/", root)).replaceAll("\\", "/");
    const resolved = program
      .getSourceFiles()
      .map((file) => file.fileName.replaceAll("\\", "/"))
      .filter((file) => file.toLowerCase().startsWith(packageDist.toLowerCase()));
    assert.ok(resolved.length > 0);
    assert.ok(
      resolved.every((file) => file.endsWith(".d.cts")),
      resolved.join("\n"),
    );
  });
}

test("browser bundlers resolve the CommonJS entry without Node runtime imports", async () => {
  const bundle = await rollup({
    input: fileURLToPath(new URL("fixtures/browser-consumer.cjs", import.meta.url)),
    plugins: [nodeResolve({ browser: true }), commonjs()],
    onwarn(warning, defaultHandler) {
      if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
      defaultHandler(warning);
    },
  });
  try {
    const { output } = await bundle.generate({ format: "es" });
    assert.equal(output.length, 1);
    assert.deepEqual(output[0].imports, []);
    assert.deepEqual(output[0].dynamicImports, []);
    const moduleIds = Object.keys(output[0].modules).map((id) => id.replaceAll("\\", "/"));
    assert.ok(moduleIds.some((id) => id.includes("/dist/commonjs/index.cjs")));
    assert.ok(moduleIds.every((id) => !id.includes("/dist/esm/index.js")));
    assert.deepEqual(findUndeclaredRequireCalls(output[0].code), []);
    assert.doesNotMatch(output[0].code, /Could not dynamically require/);
    assert.match(output[0].code, /useMicrosoftOpenTelemetry/);
  } finally {
    await bundle.close();
  }
});

test("unused exports and side-effect-only imports remain tree-shakeable", async () => {
  const bundle = await rollup({
    input: fileURLToPath(new URL("fixtures/tree-shaking.mjs", import.meta.url)),
    plugins: [nodeResolve({ browser: true }), commonjs()],
  });
  try {
    const { output } = await bundle.generate({ format: "es" });
    assert.equal(output.length, 1);
    assert.equal(output[0].code.trim(), "const retained = true;\n\nexport { retained };");
  } finally {
    await bundle.close();
  }
});

test("every JavaScript bundle ships a source map", async () => {
  for (const directory of ["esm", "commonjs", "browser"]) {
    const files = await readdir(new URL(`dist/${directory}/`, root));
    for (const file of files.filter((path) => path.endsWith(".js") || path.endsWith(".cjs"))) {
      const url = new URL(`dist/${directory}/${file.replaceAll("\\", "/")}`, root);
      const code = await readFile(url, "utf8");
      assert.ok(code.includes(`//# sourceMappingURL=${url.pathname.split("/").at(-1)}.map`));
      const sourceMap = JSON.parse(await readFile(new URL(`${url}.map`), "utf8"));
      assert.equal(sourceMap.version, 3);
      assert.ok(sourceMap.sources.length > 0);
      assert.ok(sourceMap.sourcesContent.some((source) => typeof source === "string" && source));
    }
  }
});

test("the instrumentations subpath stays out of the root bundle", async () => {
  for (const file of ["index.js", "index.min.js"]) {
    const bundle = await readFile(new URL(`dist/esm/${file}`, root), "utf8");
    // Matches import specifiers rather than any occurrence of the name: the unminified bundle
    // keeps doc comments, and documentation that names the upstream package is not a dependency
    // on it.
    const specifier = /(?:^|[^\w$])(?:import|from)\s*\(?\s*["'][^"']*browser-instrumentation/m;
    assert.equal(
      specifier.test(bundle),
      false,
      `${file} must not import @opentelemetry/browser-instrumentation`,
    );
  }
});

test("the instrumentations subpath imports each instrumentation on demand", async () => {
  const bundle = await readFile(
    new URL(pkg.exports["./instrumentations"].import.default, root),
    "utf8",
  );
  // Static imports would make every instrumentation part of a consumer's bundle even when their
  // configuration leaves it off, and would evaluate resource-timing's top-level `window` access
  // outside a browser.
  assert.equal(/^import\s/m.test(bundle), false);
  for (const name of [
    "fetch",
    "xhr",
    "console",
    "errors",
    "navigation",
    "navigation-timing",
    "resource-timing",
    "user-action",
    "web-vitals",
  ])
    assert.match(
      bundle,
      new RegExp(`import\\(['"]@opentelemetry/browser-instrumentation/experimental/${name}['"]\\)`),
    );
});

test("the instrumentations subpath ships its declarations", async () => {
  const declaration = await readFile(
    new URL(pkg.exports["./instrumentations"].import.types, root),
    "utf8",
  );
  for (const name of ["getInstrumentations", "InstrumentationOptions"])
    assert.match(declaration, new RegExp(`\\b${name}\\b`));
});
