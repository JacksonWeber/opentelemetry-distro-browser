// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cdnOrigin = "https://js.monitor.azure.com";
export const cdnDirectory = resolve(root, "cdn");
export const cacheControl = "public, max-age=31536000, immutable, no-transform";

const modules = ["opentelemetry-browser", "opentelemetry-browser-instrumentations"];
// Source format in dist/browser -> CDN format. The IIFE is the default because the loader snippet
// requires the `Microsoft.OpenTelemetry` global, which UMD skips when an AMD loader is present.
const formats = [
  ["iife.min.js", "min.js"],
  ["iife.js", "js"],
  ["umd.min.js", "umd.min.js"],
  ["umd.js", "umd.js"],
];

/** Returns the CDN release folder: `b` for stable releases, else the prerelease identifier. */
export function getCdnChannel(version) {
  const match = /^\d+\.\d+\.\d+(?:-([a-z]+)(?:\.\d+)?)?$/.exec(version);
  if (!match) throw new Error(`Unsupported CDN release version ${version}.`);
  const channel = match[1] ?? "b";
  if (!["b", "alpha", "beta", "rc"].includes(channel)) {
    throw new Error(`Unsupported CDN release channel ${channel} for version ${version}.`);
  }
  return channel;
}

export const getCdnPath = (version) => `scripts/otel/${getCdnChannel(version)}`;

export const getCdnUrl = (version, file) => `${cdnOrigin}/${getCdnPath(version)}/${file}`;

/** Lists each browser bundle in dist/browser with its versioned CDN file name. */
export function getCdnArtifacts(version) {
  return modules.flatMap((module) =>
    formats.map(([source, format]) => ({
      module,
      format,
      source: `${module}.${source}`,
      file: `${module}.${version}.${format}`,
    })),
  );
}

export const getContentType = (file) =>
  file.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/json; charset=utf-8";

const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("base64");

export function getIntegrity(bytes) {
  const hashes = {
    sha256: hash("sha256", bytes),
    sha384: hash("sha384", bytes),
    sha512: hash("sha512", bytes),
  };
  return {
    integrity: Object.entries(hashes)
      .map(([algorithm, value]) => `${algorithm}-${value}`)
      .join(" "),
    hashes,
  };
}

function renameSourceMapReference(code, source, file) {
  const reference = `//# sourceMappingURL=${source}.map`;
  const index = code.lastIndexOf(reference);
  if (index === -1 || code.slice(index + reference.length).trim() !== "") {
    throw new Error(`${source} does not end with its source map reference.`);
  }
  return `${code.slice(0, index)}//# sourceMappingURL=${file}.map${code.slice(index + reference.length)}`;
}

/**
 * Copies the built browser bundles to `cdn/` under immutable versioned names, with source maps
 * and an `<module>.<version>.integrity.json` file per module.
 */
export async function prepareCdn({ version, sourceDirectory, outputDirectory = cdnDirectory }) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const integrityFiles = new Map();
  for (const artifact of getCdnArtifacts(version)) {
    let code;
    let map;
    try {
      code = await readFile(resolve(sourceDirectory, artifact.source), "utf8");
      map = JSON.parse(await readFile(resolve(sourceDirectory, `${artifact.source}.map`), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Missing ${artifact.source}; run \`npm run build\` first.`, {
          cause: error,
        });
      }
      throw error;
    }
    const bytes = Buffer.from(renameSourceMapReference(code, artifact.source, artifact.file));
    await writeFile(resolve(outputDirectory, artifact.file), bytes);
    await writeFile(
      resolve(outputDirectory, `${artifact.file}.map`),
      JSON.stringify({ ...map, file: artifact.file }),
    );

    const integrityFile = `${artifact.module}.${version}.integrity.json`;
    const integrityJson = integrityFiles.get(integrityFile) ?? {
      name: artifact.module,
      version,
      ext: {},
    };
    integrityJson.ext[`@${artifact.format}`] = {
      file: artifact.file,
      url: getCdnUrl(version, artifact.file),
      type: getContentType(artifact.file),
      ...getIntegrity(bytes),
    };
    integrityFiles.set(integrityFile, integrityJson);
  }

  for (const [file, json] of integrityFiles) {
    await writeFile(resolve(outputDirectory, file), `${JSON.stringify(json, null, 2)}\n`);
  }
  return [...integrityFiles.keys()];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const written = await prepareCdn({
    version,
    sourceDirectory: resolve(root, "dist", "browser"),
  });
  process.stdout.write(
    `Prepared CDN files for ${getCdnUrl(version, "")} (${written.join(", ")})\n`,
  );
}
