import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { minify } from "@swc/core";
import MagicString from "magic-string";
import { dts } from "rollup-plugin-dts";
import { visualizer } from "rollup-plugin-visualizer";

const esmOutput = {
  format: "es",
  sourcemap: true,
};

const externalOpenTelemetry = (id) => id.startsWith("@opentelemetry/");
const compile = () => typescript({ tsconfig: "./tsconfig.src.json" });

const unsafeIdleCallbackCheck = 'typeof window.requestIdleCallback === "function"';
// Upstream resource timing reads `window` when its module is evaluated, which throws in a worker.
// The global bundles inline every instrumentation, so guard the check until upstream does.
const workerSafeIdleCallback = {
  name: "worker-safe-idle-callback",
  transform(code, id) {
    if (!/[\\/]@opentelemetry[\\/]browser-instrumentation[\\/].*idle-callback-shim\.js$/.test(id)) {
      return null;
    }
    const index = code.indexOf(unsafeIdleCallbackCheck);
    if (index === -1) {
      this.error(`${id} no longer contains the guarded requestIdleCallback check.`);
    }
    const source = new MagicString(code).appendLeft(index, 'typeof window !== "undefined" && ');
    return { code: source.toString(), map: source.generateMap({ hires: true }) };
  },
};
const bundleForBrowser = () => [
  nodeResolve({ browser: true }),
  workerSafeIdleCallback,
  commonjs(),
  compile(),
];

/**
 * Instrumentation members that `sharedBrowserPatches.ts` reads or replaces by name on
 * instrumentations that may come from another bundle or the application, so they keep their names.
 */
const crossBundleProperties = [
  "_active",
  "_isEnabled",
  "_isFetchPatched",
  "_isHistoryPatched",
  "_isPatched",
  "_isXhrPatched",
  "_unwrap",
  "_wrap",
];

/**
 * Minifies a self-contained global bundle with SWC. It also shortens `_`-prefixed properties, the
 * TypeScript `private` convention used by OpenTelemetry, since nothing outside the bundle can
 * reach them except `crossBundleProperties`.
 */
const swcMinify = () => ({
  name: "swc-minify",
  async renderChunk(code) {
    const { code: minified, map } = await minify(code, {
      ecma: 2022,
      compress: { passes: 2 },
      mangle: { props: { regex: "^_[a-zA-Z]", reserved: crossBundleProperties } },
      sourceMap: true,
    });
    return { code: minified, map };
  },
});

/** Self-contained UMD and IIFE bundles, unminified and minified, exposing `name` as a global. */
const globalBundle = (input, module, name) => ({
  input,
  plugins: bundleForBrowser(),
  output: ["umd", "iife"].flatMap((format) =>
    [false, true].map((minify) => ({
      file: `dist/browser/${module}.${format}${minify ? ".min" : ""}.js`,
      format,
      name,
      exports: "named",
      inlineDynamicImports: true,
      sourcemap: true,
      ...(minify ? { plugins: [swcMinify()] } : {}),
    })),
  ),
});
// The CommonJS runtime loads its ESM-only dependencies with `import()`, so its declarations must
// resolve them as ESM too; otherwise TypeScript rejects them under Node16 module resolution.
const commonJsDeclarationImports = {
  name: "commonjs-declaration-imports",
  renderChunk: (code) =>
    code.replace(
      /^import (?!type )(.+) from '([^']+)';$/gm,
      "import type $1 from '$2' with { 'resolution-mode': 'import' };",
    ),
};

export default [
  {
    input: "src/index.ts",
    // Share APIs with npm consumers and let their bundler select the SDK platform.
    external: externalOpenTelemetry,
    plugins: [compile()],
    output: {
      ...esmOutput,
      file: "dist/esm/index.js",
    },
  },
  {
    // A separate entry point, so an application that never configures instrumentations does not
    // pay for them. Its on-demand imports stay external here, leaving the consumer's bundler to
    // split out the instrumentations they enable.
    input: "src/instrumentation/browserInstrumentation/index.ts",
    external: externalOpenTelemetry,
    plugins: [compile()],
    output: {
      ...esmOutput,
      file: "dist/esm/instrumentations.js",
    },
  },
  {
    input: "src/index.ts",
    external: externalOpenTelemetry,
    plugins: [compile()],
    output: {
      file: "dist/commonjs/index.cjs",
      format: "cjs",
      exports: "named",
      sourcemap: true,
    },
  },
  {
    input: "src/instrumentation/browserInstrumentation/index.ts",
    external: externalOpenTelemetry,
    plugins: [compile()],
    output: {
      file: "dist/commonjs/instrumentations.cjs",
      format: "cjs",
      exports: "named",
      sourcemap: true,
    },
  },
  {
    input: "src/index.ts",
    // Retain the application's API singletons, including pre-initialization handles.
    external: ["@opentelemetry/api", "@opentelemetry/api-logs"],
    plugins: bundleForBrowser(),
    output: {
      ...esmOutput,
      file: "dist/esm/index.min.js",
      plugins: [
        terser(),
        visualizer({
          filename: "reports/bundle-stats.html",
          title: "OpenTelemetry browser ESM bundle",
          template: "treemap",
          sourcemap: true,
          gzipSize: true,
          brotliSize: true,
        }),
      ],
    },
  },
  globalBundle("src/browser.ts", "opentelemetry-browser", "Microsoft.OpenTelemetry"),
  globalBundle(
    "src/instrumentation/browserInstrumentation/index.ts",
    "opentelemetry-browser-instrumentations",
    "Microsoft.OpenTelemetryInstrumentations",
  ),
  {
    input: "src/index.ts",
    plugins: [dts({ tsconfig: "./tsconfig.src.json" })],
    // `.d.cts` copies keep TypeScript from treating the `require` entry points as ESM.
    output: [
      { file: "dist/esm/index.d.ts", format: "es" },
      { file: "dist/commonjs/index.d.cts", format: "es", plugins: [commonJsDeclarationImports] },
    ],
  },
  {
    input: "src/instrumentation/browserInstrumentation/index.ts",
    plugins: [dts({ tsconfig: "./tsconfig.src.json" })],
    output: [
      { file: "dist/esm/instrumentations.d.ts", format: "es" },
      {
        file: "dist/commonjs/instrumentations.d.cts",
        format: "es",
        plugins: [commonJsDeclarationImports],
      },
    ],
  },
  {
    input: "src/snippet.ts",
    plugins: [typescript({ tsconfig: "./tsconfig.src.json" })],
    output: {
      ...esmOutput,
      file: "dist/esm/snippet.js",
    },
  },
  {
    input: "src/snippet.ts",
    plugins: [dts({ tsconfig: "./tsconfig.src.json" })],
    output: {
      file: "dist/esm/snippet.d.ts",
      format: "es",
    },
  },
];
