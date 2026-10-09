// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  cacheControl,
  cdnDirectory,
  getCdnArtifacts,
  getCdnPath,
  getCdnUrl,
  getContentType,
  root,
} from "./cdn.mjs";

const usage = `Usage: npm run cdn:publish -- --account <storage-account> [--container cdn] [--dry-run]

Uploads the files prepared in cdn/ by \`npm run build\` to
<container>/scripts/otel/<channel>/ with immutable caching. Existing files are never overwritten;
an identical existing file is skipped and a different one fails the publish.

Authentication uses Azure CLI Entra ID login (--auth-mode login) unless
AZURE_STORAGE_SAS_TOKEN is set.`;

/** Lists the uploads for a version: bundles and source maps first, integrity files last. */
export function getCdnUploads(version) {
  const files = getCdnArtifacts(version).flatMap(({ file }) => [file, `${file}.map`]);
  const integrityFiles = [
    ...new Set(getCdnArtifacts(version).map(({ module }) => `${module}.${version}.integrity.json`)),
  ];
  return [...files, ...integrityFiles].map((file) => ({
    file,
    blob: `${getCdnPath(version)}/${file}`,
    url: getCdnUrl(version, file),
    contentType: getContentType(file),
    cacheControl,
  }));
}

const quote = (value) => (/^[\w./:=@-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`);

function az(args) {
  // `az` is a batch file on Windows, which Node only starts through a shell.
  const windows = process.platform === "win32";
  const result = spawnSync("az", windows ? args.map(quote) : args, {
    encoding: "utf8",
    shell: windows,
  });
  if (result.error) throw result.error;
  return result;
}

export async function publishCdn({
  version,
  account,
  container,
  directory = cdnDirectory,
  dryRun = false,
  run = az,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const uploads = getCdnUploads(version);
  const present = new Set(await readdir(directory).catch(() => []));
  const missing = uploads.filter(({ file }) => !present.has(file));
  if (missing.length > 0) {
    throw new Error(
      `Missing CDN files (${missing.map(({ file }) => file).join(", ")}); run \`npm run build\` first.`,
    );
  }

  const target = ["--account-name", account, "--container-name", container];
  if (!process.env.AZURE_STORAGE_SAS_TOKEN) target.push("--auth-mode", "login");

  for (const upload of uploads) {
    const path = resolve(directory, upload.file);
    if (dryRun) {
      log(`Would upload ${upload.file} -> ${upload.url}`);
      continue;
    }
    const md5 = createHash("md5")
      .update(await readFile(path))
      .digest("base64");
    const existing = run([
      "storage",
      "blob",
      "show",
      ...target,
      "--name",
      upload.blob,
      "--query",
      "properties.contentSettings.contentMd5",
      "--output",
      "tsv",
    ]);
    if (existing.status === 0) {
      if (existing.stdout.trim() !== md5) {
        throw new Error(`${upload.url} already exists with different content.`);
      }
      log(`Skipped ${upload.url} (already published)`);
      continue;
    }
    if (!/BlobNotFound|ResourceNotFound|does not exist/i.test(existing.stderr)) {
      throw new Error(`Unable to check ${upload.url}: ${existing.stderr.trim()}`);
    }

    const uploaded = run([
      "storage",
      "blob",
      "upload",
      ...target,
      "--name",
      upload.blob,
      "--file",
      path,
      "--content-type",
      upload.contentType,
      "--content-cache-control",
      upload.cacheControl,
      "--content-md5",
      md5,
      "--overwrite",
      "false",
      "--only-show-errors",
    ]);
    if (uploaded.status !== 0) {
      throw new Error(`Failed to upload ${upload.url}: ${uploaded.stderr.trim()}`);
    }
    log(`Uploaded ${upload.url}`);
  }
  return uploads;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      container: { type: "string", default: "cdn" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.account) {
    process.stdout.write(`${usage}\n`);
    process.exit(values.help ? 0 : 1);
  }
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  await publishCdn({
    version,
    account: values.account,
    container: values.container,
    dryRun: values["dry-run"],
  });
}
