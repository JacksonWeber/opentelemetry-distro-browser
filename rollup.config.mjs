import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { dts } from "rollup-plugin-dts";
import { visualizer } from "rollup-plugin-visualizer";

const esmOutput = {
  format: "es",
  sourcemap: true,
};

export default [
  {
    input: "src/index.ts",
    // Share APIs with npm consumers and let their bundler select the SDK platform.
    external: (id) => id.startsWith("@opentelemetry/"),
    plugins: [typescript({ tsconfig: "./tsconfig.src.json" })],
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
    external: (id) => id.startsWith("@opentelemetry/"),
    plugins: [typescript({ tsconfig: "./tsconfig.src.json" })],
    output: {
      ...esmOutput,
      file: "dist/esm/instrumentations.js",
    },
  },
  {
    input: "src/index.ts",
    // Retain the application's API singletons, including pre-initialization handles.
    external: ["@opentelemetry/api", "@opentelemetry/api-logs"],
    plugins: [
      nodeResolve({ browser: true }),
      commonjs(),
      typescript({ tsconfig: "./tsconfig.src.json" }),
    ],
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
  {
    input: "src/index.ts",
    plugins: [dts({ tsconfig: "./tsconfig.src.json" })],
    output: {
      file: "dist/esm/index.d.ts",
      format: "es",
    },
  },
  {
    input: "src/instrumentation/browserInstrumentation/index.ts",
    plugins: [dts({ tsconfig: "./tsconfig.src.json" })],
    output: {
      file: "dist/esm/instrumentations.d.ts",
      format: "es",
    },
  },
];
