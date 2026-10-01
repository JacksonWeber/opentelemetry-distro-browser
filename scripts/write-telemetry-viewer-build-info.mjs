import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { rollup } from "rollup";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = "\0telemetry-viewer-size";
const packageEntries = new Map([
  ["@microsoft/opentelemetry-browser", resolve(root, "dist", "esm", "index.js")],
  [
    "@microsoft/opentelemetry-browser/instrumentations",
    resolve(root, "dist", "esm", "instrumentations.js"),
  ],
]);
const outputPath = resolve(root, "samples", "telemetry-viewer", "public", "build-info.json");

const scenarios = [
  {
    id: "everything",
    label: "Everything",
    description: "Every runtime export and every available instrumentation chunk.",
    source: `
      import * as distro from "@microsoft/opentelemetry-browser";
      import * as instrumentations from "@microsoft/opentelemetry-browser/instrumentations";
      globalThis.__bundleSizeSink = [distro, instrumentations];
    `,
  },
  {
    id: "defaults",
    label: "Defaults only",
    description: "Distribution defaults plus the fetch and XHR instrumentations loaded by default.",
    source: `
      import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry-browser";
      import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
      globalThis.__bundleSizeSink = [useMicrosoftOpenTelemetry, getInstrumentations];
    `,
    dynamicChunkNames: new Set(["fetch", "xhr"]),
  },
];

function selectChunks(output, dynamicChunkNames) {
  if (!dynamicChunkNames) return output.filter((item) => item.type === "chunk");

  const chunks = new Map(
    output.filter((item) => item.type === "chunk").map((chunk) => [chunk.fileName, chunk]),
  );
  const selected = new Set(
    [...chunks.values()]
      .filter(
        (chunk) =>
          chunk.isEntry ||
          (chunk.isDynamicEntry &&
            chunk.facadeModuleId &&
            [...dynamicChunkNames].some((name) =>
              chunk.facadeModuleId.replaceAll("\\", "/").includes(`/dist/${name}/index.js`),
            )),
      )
      .map((chunk) => chunk.fileName),
  );

  const pending = [...selected];
  while (pending.length > 0) {
    const chunk = chunks.get(pending.pop());
    if (!chunk) continue;
    for (const imported of chunk.imports) {
      if (chunks.has(imported) && !selected.has(imported)) {
        selected.add(imported);
        pending.push(imported);
      }
    }
  }
  return [...selected].map((fileName) => chunks.get(fileName));
}

function measure(output, dynamicChunkNames) {
  const chunks = selectChunks(output, dynamicChunkNames);
  return {
    rawBytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0),
    gzipBytes: chunks.reduce(
      (total, chunk) => total + gzipSync(chunk.code, { level: 9 }).byteLength,
      0,
    ),
    brotliBytes: chunks.reduce(
      (total, chunk) =>
        total +
        brotliCompressSync(chunk.code, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
        }).byteLength,
      0,
    ),
    chunks: chunks.length,
  };
}

async function measureScenario(scenario) {
  const bundle = await rollup({
    input,
    plugins: [
      {
        name: "telemetry-viewer-size-entry",
        resolveId(id) {
          if (id === input) return input;
          return packageEntries.get(id);
        },
        load(id) {
          if (id === input) return scenario.source;
        },
      },
      nodeResolve({ browser: true }),
      commonjs(),
    ],
    onwarn(warning, defaultHandler) {
      if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
      defaultHandler(warning);
    },
  });

  try {
    const unminified = await bundle.generate({
      format: "es",
      entryFileNames: "entry.js",
      chunkFileNames: "chunks/[name].js",
    });
    const minified = await bundle.generate({
      format: "es",
      entryFileNames: "entry.js",
      chunkFileNames: "chunks/[name].js",
      plugins: [terser()],
    });
    return {
      id: scenario.id,
      label: scenario.label,
      description: scenario.description,
      unminified: measure(unminified.output, scenario.dynamicChunkNames),
      minified: measure(minified.output, scenario.dynamicChunkNames),
    };
  } finally {
    await bundle.close();
  }
}

const buildInfo = {
  scenarios: await Promise.all(scenarios.map(measureScenario)),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
