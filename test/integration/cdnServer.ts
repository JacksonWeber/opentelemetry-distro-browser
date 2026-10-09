// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    cdnPageOrigin: string;
  }
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const cdnDirectory = resolve(root, "cdn");

/**
 * Serves the prepared `cdn/` files from one origin and plain HTML pages that load them through the
 * built snippet from another, under a strict Content Security Policy.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cdnServer = createServer(async (request, response) => {
    const file = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
    if (request.method !== "GET" || !/^[\w.-]+$/.test(file)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(resolve(cdnDirectory, file));
      response.writeHead(200, {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=31536000, immutable, no-transform",
        "content-type": file.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "application/json; charset=utf-8",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const cdnOrigin = await listen(cdnServer);

  const pageServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" || url.pathname !== "/snippet.html") {
        response.writeHead(404).end();
        return;
      }
      await writeSnippetPage(response, cdnOrigin, url.searchParams);
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.stack : String(error));
    }
  });
  project.provide("cdnPageOrigin", await listen(pageServer));

  return async () => {
    await Promise.all([close(cdnServer), close(pageServer)]);
  };
}

async function writeSnippetPage(
  response: ServerResponse,
  cdnOrigin: string,
  parameters: URLSearchParams,
): Promise<void> {
  const ingestionEndpoint = required(parameters, "ingestionEndpoint");
  const runId = required(parameters, "runId");
  const scenario = parameters.get("scenario") ?? "valid";

  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    version: string;
  };
  const integrityJson = JSON.parse(
    await readFile(
      resolve(cdnDirectory, `opentelemetry-browser.${version}.integrity.json`),
      "utf8",
    ),
  ) as { ext: Record<string, { file: string; hashes: { sha384: string } }> };
  const bundle = integrityJson.ext["@min.js"];
  // Exercise the built package artifact, not the TypeScript source.
  const { getSdkLoaderScript } = (await import(
    pathToFileURL(resolve(root, "dist/esm/snippet.js")).href
  )) as typeof import("../../src/snippet.js");

  const snippet = getSdkLoaderScript({
    src: `${cdnOrigin}/${scenario === "missing" ? `missing-${bundle.file}` : bundle.file}`,
    connectionString:
      "InstrumentationKey=00000000-0000-0000-0000-000000000000;" +
      `IngestionEndpoint=${ingestionEndpoint}`,
    integrity:
      scenario === "tampered" ? `sha384-${"A".repeat(64)}` : `sha384-${bundle.hashes.sha384}`,
  });
  const application = `window.microsoftOpenTelemetry.then(function (handle) {
  window.Microsoft.OpenTelemetry.trace
    .getTracer("cdn-snippet-test")
    .startSpan("cdn-snippet-span", { attributes: { "test.run_id": ${JSON.stringify(runId)} } })
    .end();
  // The page view ends in a macrotask after load, so flush only after that task has run.
  return new Promise(function (resolve) {
    function settle() { setTimeout(resolve, 0); }
    if (document.readyState === "complete") settle();
    else window.addEventListener("load", settle, { once: true });
  }).then(function () {
    return handle.forceFlush();
  });
}).then(function () {
  document.body.dataset.state = "ready";
}, function (error) {
  document.body.dataset.state = "failed: " + error.message;
});`;

  const hash = (script: string): string =>
    `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": [
      "default-src 'none'",
      `script-src ${hash(snippet)} ${hash(application)} ${cdnOrigin}`,
      `connect-src ${new URL(ingestionEndpoint).origin}`,
    ].join("; "),
  });
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>CDN snippet test</title>
    <script>${snippet}</script>
  </head>
  <body>
    <script>${application}</script>
  </body>
</html>
`);
}

function required(parameters: URLSearchParams, name: string): string {
  const value = parameters.get(name);
  if (!value) throw new Error(`Missing ${name} parameter.`);
  return value;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("CDN test server did not bind to a TCP port."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
