// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPayload, mergedRevision, sha256 } from "./results.mjs";

export async function exportResults(run, endpoint) {
  const url = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.pathname !== "/otlp/v1/logs" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Explicit HTTPS /otlp/v1/logs endpoint required (HTTP only for loopback tests)",
    );
  }
  const body = JSON.stringify(createPayload(run));
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error("Payload exceeds 4 MiB");
  let response;
  let responseBody = "";
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (response.body) {
      for await (const chunk of response.body) {
        responseBody += Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(responseBody) > 64 * 1024) throw new Error("Oversized response");
      }
    }
  } catch (cause) {
    throw new Error("Export transport failed; delivery may be unknown. No retry attempted.", {
      cause,
    });
  }
  const failure = (message) =>
    Object.assign(new Error(message), { status: response.status, responseBody });
  if (!response.ok) throw failure(`Export HTTP ${response.status}; no retry attempted.`);
  let reply;
  try {
    reply = JSON.parse(responseBody);
  } catch {
    throw failure("Malformed collector response; delivery may be unknown. No retry attempted.");
  }
  if (!reply || Array.isArray(reply) || typeof reply !== "object" || Object.keys(reply).length) {
    throw failure("Collector partialSuccess or unexpected response; no retry attempted.");
  }
  return { status: response.status, responseBody, completedAt: new Date().toISOString() };
}

async function main() {
  const { values } = parseArgs({
    options: { input: { type: "string" }, endpoint: { type: "string" } },
  });
  if (!values.input || !values.endpoint) throw new Error("--input and --endpoint are required");
  const directory = resolve(values.input);
  const run = JSON.parse(await readFile(join(directory, "raw.json"), "utf8"));
  if (process.env.GITHUB_ACTIONS === "true") {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    const revision = mergedRevision(
      event,
      process.env.GITHUB_REPOSITORY,
      process.env.GITHUB_EVENT_NAME,
    );
    if (run.revision !== revision || run.dirty) {
      throw new Error("CI publishing requires clean results from the exact merged revision");
    }
  }
  const payload = createPayload(run);
  const saved = JSON.parse(await readFile(join(directory, "payload.json"), "utf8"));
  if (JSON.stringify(payload) !== JSON.stringify(saved)) {
    throw new Error("Saved payload differs from validated raw results");
  }
  const body = JSON.stringify(payload);
  // A durable exclusive marker prevents accidental replay, including after ambiguous failures.
  await writeFile(
    join(directory, "export-attempt.json"),
    JSON.stringify({
      runId: run.runId,
      startedAt: new Date().toISOString(),
      requestBytes: Buffer.byteLength(body),
      requestSha256: sha256(body),
    }),
    { flag: "wx" },
  );
  await writeFile(join(directory, "request.json"), body, { flag: "wx" });
  try {
    const receipt = await exportResults(run, values.endpoint);
    await writeFile(join(directory, "export-result.json"), JSON.stringify(receipt), { flag: "wx" });
    console.log(
      `Collector accepted run ${run.runId}; downstream ingestion must be verified separately.`,
    );
  } catch (error) {
    await writeFile(
      join(directory, "export-result.json"),
      JSON.stringify({
        error: error.message,
        status: error.status,
        responseBody: error.responseBody,
        completedAt: new Date().toISOString(),
      }),
      { flag: "wx" },
    );
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
