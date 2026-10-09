// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  cacheControl,
  cdnDirectory,
  getCdnArtifacts,
  getCdnChannel,
  getCdnUrl,
  root,
} from "../../scripts/cdn.mjs";
import { getCdnUploads, publishCdn } from "../../scripts/publish-cdn.mjs";

const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("base64");

test("maps release versions to CDN channels", () => {
  assert.equal(getCdnChannel("1.2.3"), "b");
  assert.equal(getCdnChannel("0.1.0-alpha.2"), "alpha");
  assert.equal(getCdnChannel("1.0.0-beta.1"), "beta");
  assert.equal(getCdnChannel("1.0.0-rc.1"), "rc");
  assert.throws(() => getCdnChannel("1.0.0-nightly.20261008"), /Unsupported CDN release channel/);
  assert.throws(() => getCdnChannel("latest"), /Unsupported CDN release version/);
  assert.equal(
    getCdnUrl("1.2.3", "opentelemetry-browser.1.2.3.min.js"),
    "https://js.monitor.azure.com/scripts/otel/b/opentelemetry-browser.1.2.3.min.js",
  );
});

test("the snippet loads this version's CDN bundle by default", async () => {
  const { getSdkLoaderScript } = await import("../../dist/esm/snippet.js");
  const script = getSdkLoaderScript({ connectionString: "InstrumentationKey=test" });
  const src = /"src":"([^"]+)"/.exec(script)?.[1];
  assert.equal(src, getCdnUrl(version, `opentelemetry-browser.${version}.min.js`));
});

test("the documented snippet matches the generated loader", async () => {
  const { getSdkLoaderScript } = await import("../../dist/esm/snippet.js");
  const docs = await readFile(resolve(root, "docs/packaging.md"), "utf8");
  const script = getSdkLoaderScript({
    src: "https://js.monitor.azure.com/scripts/otel/CHANNEL/opentelemetry-browser.VERSION.min.js",
    connectionString: "YOUR_CONNECTION_STRING",
    integrity: "YOUR_INTEGRITY",
  });
  assert.ok(docs.replaceAll("\r\n", "\n").includes(`<script>\n${script}\n</script>`));
});

test("the build prepares versioned CDN files with source maps and integrity", async () => {
  const artifacts = getCdnArtifacts(version);
  const integrityFiles = [
    `opentelemetry-browser-instrumentations.${version}.integrity.json`,
    `opentelemetry-browser.${version}.integrity.json`,
  ];
  assert.deepEqual(
    (await readdir(cdnDirectory)).sort(),
    [...artifacts.flatMap(({ file }) => [file, `${file}.map`]), ...integrityFiles].sort(),
  );

  for (const integrityFile of integrityFiles) {
    const integrity = JSON.parse(await readFile(resolve(cdnDirectory, integrityFile), "utf8"));
    const moduleArtifacts = artifacts.filter(({ module }) => module === integrity.name);
    assert.equal(integrity.version, version);
    assert.deepEqual(
      Object.keys(integrity.ext).sort(),
      moduleArtifacts.map(({ format }) => `@${format}`).sort(),
    );

    for (const artifact of moduleArtifacts) {
      const bytes = await readFile(resolve(cdnDirectory, artifact.file));
      const source = await readFile(resolve(root, "dist", "browser", artifact.source), "utf8");
      const entry = integrity.ext[`@${artifact.format}`];
      assert.equal(entry.file, artifact.file);
      assert.equal(entry.url, getCdnUrl(version, artifact.file));
      assert.equal(entry.type, "text/javascript; charset=utf-8");
      assert.deepEqual(entry.hashes, {
        sha256: sha("sha256", bytes),
        sha384: sha("sha384", bytes),
        sha512: sha("sha512", bytes),
      });
      assert.equal(
        entry.integrity,
        `sha256-${entry.hashes.sha256} sha384-${entry.hashes.sha384} sha512-${entry.hashes.sha512}`,
      );
      assert.equal(
        bytes.toString("utf8"),
        source.replace(
          `//# sourceMappingURL=${artifact.source}.map`,
          `//# sourceMappingURL=${artifact.file}.map`,
        ),
      );
      const map = JSON.parse(await readFile(resolve(cdnDirectory, `${artifact.file}.map`), "utf8"));
      assert.equal(map.file, artifact.file);
      assert.ok(map.sourcesContent?.length > 0);
    }
  }
});

test("publishes immutable files without overwriting and uploads integrity files last", async () => {
  const uploads = getCdnUploads(version);
  assert.equal(uploads.length, getCdnArtifacts(version).length * 2 + 2);
  assert.match(uploads.at(-1).file, /\.integrity\.json$/);
  assert.match(uploads.at(-2).file, /\.integrity\.json$/);
  assert.ok(
    uploads.every(({ blob }) => blob.startsWith(`scripts/otel/${getCdnChannel(version)}/`)),
  );

  const calls = [];
  const existingMd5 = sha("md5", await readFile(resolve(cdnDirectory, uploads[1].file)));
  const run = (args) => {
    calls.push(args);
    const name = args[args.indexOf("--name") + 1];
    if (args[2] === "show") {
      if (name === uploads[1].blob) return { status: 0, stdout: `${existingMd5}\n`, stderr: "" };
      return { status: 3, stdout: "", stderr: "ErrorCode:BlobNotFound" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const saved = process.env.AZURE_STORAGE_SAS_TOKEN;
  delete process.env.AZURE_STORAGE_SAS_TOKEN;
  try {
    await publishCdn({ version, account: "store", container: "cdn", run, log: () => {} });
  } finally {
    if (saved !== undefined) process.env.AZURE_STORAGE_SAS_TOKEN = saved;
  }

  const uploadCalls = calls.filter((args) => args[2] === "upload");
  assert.equal(uploadCalls.length, uploads.length - 1);
  assert.ok(!uploadCalls.some((args) => args.includes(uploads[1].blob)));
  const first = uploadCalls[0];
  const option = (name) => first[first.indexOf(name) + 1];
  assert.equal(option("--account-name"), "store");
  assert.equal(option("--container-name"), "cdn");
  assert.equal(option("--auth-mode"), "login");
  assert.equal(option("--name"), uploads[0].blob);
  assert.equal(option("--content-type"), "text/javascript; charset=utf-8");
  assert.equal(option("--content-cache-control"), cacheControl);
  assert.equal(
    option("--content-md5"),
    sha("md5", await readFile(resolve(cdnDirectory, uploads[0].file))),
  );
  assert.equal(option("--overwrite"), "false");
  assert.equal(cacheControl, "public, max-age=31536000, immutable, no-transform");

  await assert.rejects(
    publishCdn({
      version,
      account: "store",
      container: "cdn",
      run: () => ({ status: 0, stdout: "different\n", stderr: "" }),
    }),
    /already exists with different content/,
  );
  await assert.rejects(
    publishCdn({
      version,
      account: "store",
      container: "cdn",
      run: () => ({ status: 1, stdout: "", stderr: "AuthorizationPermissionMismatch" }),
    }),
    /Unable to check .*AuthorizationPermissionMismatch/,
  );
});
