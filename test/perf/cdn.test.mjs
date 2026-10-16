// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { getCdnRequests, measureCdn } from "../../scripts/perf/cdn.mjs";
import { sha256 } from "../../scripts/perf/results.mjs";

const version = "0.1.0-beta.1";
const requests = getCdnRequests(version);
const bodyFor = (path) =>
  Buffer.from(`globalThis.syntheticCdnFixture = ${JSON.stringify(path)};\n`.repeat(60));
// Different levels from build-size metrics expose accidental local recompression.
const encode = (body, encoding) =>
  encoding === "gzip"
    ? gzipSync(body, { level: 1 })
    : encoding === "br"
      ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 2 } })
      : body;

async function probe(t, override = () => ({}), options = {}) {
  const captured = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    captured.push(request.url);
    const encoding = request.headers["accept-encoding"];
    const spec = override(request);
    if (spec.noHeaders) return;
    response.writeHead(spec.status ?? 200, {
      "Content-Type": "text/javascript",
      ...(encoding !== "identity" ? { "Content-Encoding": encoding } : {}),
      ...spec.headers,
    });
    const bytes = spec.body ?? encode(bodyFor(request.url), encoding);
    response.write(bytes.subarray(0, 7));
    if (spec.truncate) response.socket.destroy();
    else if (!spec.stall) response.end(bytes.subarray(7));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    report: await measureCdn(version, {
      testOrigin: `http://127.0.0.1:${server.address().port}`,
      ...options,
    }),
    captured,
  };
}

test("counts actual chunked identity/gzip/Brotli bodies for publisher URLs without executing them", async (t) => {
  const { report, captured } = await probe(t);
  assert.deepEqual(
    captured,
    requests.map(({ path }) => path),
  );
  for (const result of report.observations) {
    const body = bodyFor(result.path);
    const wire = encode(body, result.encoding);
    assert.equal(result.status, "ok");
    assert.equal(result.bytes, wire.length);
    assert.equal(result.sha256, sha256(body));
    assert.equal(result.wireSha256, sha256(wire));
    assert.equal(result.contentEncoding, result.encoding);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.fetchedAt, new Date(result.fetchedAt).toISOString());
    assert.ok(
      result.url.startsWith(
        "https://js.monitor.azure.com/scripts/otel/beta/opentelemetry-browser.0.1.0-beta.1.",
      ),
    );
  }
  assert.deepEqual([...new Set(report.observations.map(({ format }) => format))], ["iife", "umd"]);
  assert.equal(globalThis.syntheticCdnFixture, undefined);
});

test("unavailable encodings never become sizes and do not discard identity or the other format", async (t) => {
  for (const fallback of [{ headers: { "Content-Encoding": "identity" } }, { status: 406 }]) {
    await t.test(JSON.stringify(fallback), async (t) => {
      const { report } = await probe(t, (request) =>
        request.url === requests[0].path && request.headers["accept-encoding"] !== "identity"
          ? fallback
          : {},
      );
      for (const [index, result] of report.observations.entries()) {
        assert.equal(result.status, [1, 2].includes(index) ? "unavailable" : "ok");
        if (result.status !== "ok") {
          assert.equal(result.bytes, undefined);
          assert.equal(result.stage, "encoding");
        }
      }
    });
  }
});

test("failed identity requests preserve response metadata, skip compression, and never follow redirects", async (t) => {
  for (const [name, spec] of [
    ["404", { status: 404, headers: { "Content-Type": "application/xml" } }],
    ["redirect", { status: 302, headers: { Location: requests[3].url } }],
    ["server error", { status: 500 }],
    ["HTML MIME", { headers: { "Content-Type": "text/html" } }],
    ["HTML body", { body: Buffer.from("<html>error</html>") }],
    ["invalid UTF-8", { body: Buffer.from([0xff]) }],
    ["empty", { body: Buffer.alloc(0) }],
    ["oversized body", { body: Buffer.alloc(8 * 1024 * 1024 + 1, 32) }],
    ["truncated body", { headers: { "Content-Length": 50000 }, truncate: true }],
  ]) {
    await t.test(name, async (t) => {
      const { report, captured } = await probe(t, (request) =>
        request.url === requests[0].path ? spec : {},
      );
      const [identity, gzip, br, ...otherFormat] = report.observations;
      assert.equal(identity.status, spec.status === 404 ? "unavailable" : "error");
      if (!spec.truncate) {
        assert.equal(identity.httpStatus, spec.status ?? 200);
        assert.equal(identity.contentType, spec.headers?.["Content-Type"] ?? "text/javascript");
        assert.equal(identity.contentEncoding, "identity");
      }
      for (const failed of [identity, gzip, br]) {
        assert.equal(failed.bytes, undefined);
        assert.equal(failed.sha256, undefined);
        assert.ok(failed.message);
      }
      assert.equal(gzip.reason, "identity_unavailable");
      assert.equal(br.reason, "identity_unavailable");
      assert.ok(otherFormat.every(({ status }) => status === "ok"));
      assert.equal(captured.length, 4);
    });
  }
});

test("rejects mismatched, corrupt and oversized decoded bodies independently for gzip and Brotli", async (t) => {
  for (const encoding of ["gzip", "br"]) {
    for (const [name, spec] of [
      ["changed bytes", { body: encode(Buffer.from("const changed = true;"), encoding) }],
      ["corrupt", { body: Buffer.from("not compressed") }],
      ["truncated", { body: encode(bodyFor(requests[0].path), encoding).subarray(0, 7) }],
      ["decompression limit", { body: encode(Buffer.alloc(8 * 1024 * 1024 + 1, 32), encoding) }],
      ["wrong encoding", { headers: { "Content-Encoding": "deflate" } }],
    ]) {
      await t.test(`${encoding}: ${name}`, async (t) => {
        const { report } = await probe(t, (request) =>
          request.headers["accept-encoding"] === encoding ? spec : {},
        );
        for (const result of report.observations) {
          assert.equal(result.status, result.encoding === encoding ? "error" : "ok");
          if (result.status !== "ok") assert.equal(result.bytes, undefined);
        }
      });
    }
  }
});

test(
  "protocol upgrades and stalled responses settle within the deadline",
  { timeout: 3000 },
  async (t) => {
    for (const spec of [
      { status: 101, headers: { Connection: "Upgrade", Upgrade: "test" } },
      { stall: true },
      { noHeaders: true },
    ]) {
      const { report } = await probe(t, () => spec, { timeoutMs: 50 });
      for (const result of report.observations.filter(({ encoding }) => encoding === "identity")) {
        assert.equal(result.status, "error");
        assert.match(result.message, spec.status === 101 ? /HTTP 101/ : /deadline/);
        assert.equal(result.httpStatus, spec.noHeaders ? undefined : (spec.status ?? 200));
        assert.equal(result.bytes, undefined);
      }
    }
  },
);
