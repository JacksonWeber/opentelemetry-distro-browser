// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { getCdnUrl, getIntegrity } from "../../scripts/cdn.mjs";
import { getCdnTargets, measureCdn, validateCdnReport } from "../../scripts/perf/cdn.mjs";
import { sha256 } from "../../scripts/perf/results.mjs";

const version = "0.1.0-beta.1";
const targets = getCdnTargets(version);

function fixture() {
  const bodies = new Map(
    targets.map((target) => [
      target.path,
      Buffer.from(
        `globalThis.syntheticCdnFixture = ${JSON.stringify(target.bundleFormat)};\n`.repeat(60),
      ),
    ]),
  );
  const manifest = {
    name: "opentelemetry-browser",
    version,
    ext: Object.fromEntries(
      targets.map((target) => [
        `@${target.format}`,
        {
          url: target.url,
          file: target.file,
          type: "text/javascript; charset=utf-8",
          ...getIntegrity(bodies.get(target.path)),
        },
      ]),
    ),
  };
  // Deliberately use levels different from the build metrics to detect local recompression.
  const encode = (body, encoding) =>
    encoding === "gzip"
      ? gzipSync(body, { level: 1 })
      : encoding === "br"
        ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 2 } })
        : body;
  return { bodies, manifest, encode };
}

async function withCdn(callback, override = () => false, data = fixture()) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, encoding: request.headers["accept-encoding"] });
    if (override(request, response, data)) return;
    const json = request.url.endsWith(".integrity.json");
    const encoding = request.headers["accept-encoding"];
    const body = json ? Buffer.from(JSON.stringify(data.manifest)) : data.bodies.get(request.url);
    assert.ok(body, `Unexpected fixture request ${request.url}`);
    response.writeHead(200, {
      "Content-Type": json ? "application/json" : "text/javascript; charset=utf-8",
      ...(encoding !== "identity" ? { "Content-Encoding": encoding } : {}),
    });
    const encoded = data.encode(body, encoding);
    // Chunked delivery proves the code counts body chunks rather than Content-Length.
    response.write(encoded.subarray(0, 7));
    response.end(encoded.subarray(7));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback({
      options: { testOrigin: `http://127.0.0.1:${server.address().port}` },
      requests,
      data,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("CDN targets use immutable publisher URLs for the primary SDK and release channel", () => {
  for (const [release, channel] of [
    ["1.2.3", "b"],
    ["0.1.0-alpha.3", "alpha"],
    [version, "beta"],
    ["1.0.0-rc.1", "rc"],
  ]) {
    const artifacts = getCdnTargets(release);
    assert.equal(artifacts.length, 2);
    assert.deepEqual(
      artifacts.map(({ bundleFormat }) => bundleFormat),
      ["iife", "umd"],
    );
    for (const artifact of artifacts) {
      assert.equal(artifact.url, getCdnUrl(release, artifact.file));
      assert.ok(artifact.url.startsWith(`https://js.monitor.azure.com/scripts/otel/${channel}/`));
      assert.ok(artifact.url.includes(`opentelemetry-browser.${release}.`));
      assert.doesNotMatch(artifact.url, /instrumentations|latest/);
    }
  }
  assert.throws(() => getCdnTargets("latest"));
});

test("measures actual encoded bodies, validates integrity, and never executes CDN JavaScript", async () => {
  await withCdn(async ({ options, requests, data }) => {
    const report = await measureCdn(version, options);
    validateCdnReport(report, version);
    assert.equal(requests.length, 7);
    assert.equal(requests[0].encoding, "identity");
    assert.equal(report.observations.length, 6);
    for (const result of report.observations) {
      const body = data.bodies.get(result.path);
      const wire = data.encode(body, result.encoding);
      assert.equal(result.status, "ok");
      assert.equal(result.bytes, wire.length);
      assert.equal(result.decodedBytes, body.length);
      assert.equal(result.sha256, sha256(body));
      assert.equal(result.wireSha256, sha256(wire));
      assert.equal(result.manifestSha256, sha256(JSON.stringify(data.manifest)));
      assert.equal(result.contentEncoding, result.encoding);
      assert.equal(result.httpStatus, 200);
      assert.equal(result.fetchedAt, new Date(result.fetchedAt).toISOString());
    }
    assert.equal(globalThis.syntheticCdnFixture, undefined);
  });
});

test("identity returned to compressed requests is unavailable, not a compressed size", async () => {
  await withCdn(
    async ({ options }) => {
      const report = await measureCdn(version, options);
      validateCdnReport(report, version);
      for (const result of report.observations) {
        assert.equal(result.status, result.encoding === "identity" ? "ok" : "unavailable");
        if (result.encoding !== "identity") {
          assert.equal(result.reason, "encoding_unavailable");
          assert.equal(result.contentEncoding, "identity");
          assert.equal(result.bytes, undefined);
        }
      }
    },
    (request, response, data) => {
      if (request.url.endsWith(".json")) return false;
      response.writeHead(200, { "Content-Type": "application/javascript" });
      response.end(data.bodies.get(request.url));
      return true;
    },
  );
});

test("unpublished manifest returns six durable unavailable outcomes with no sizes or retry", async () => {
  await withCdn(
    async ({ options, requests }) => {
      const report = await measureCdn(version, options);
      validateCdnReport(report, version);
      assert.equal(requests.length, 1);
      for (const result of report.observations) {
        assert.equal(result.status, "unavailable");
        assert.equal(result.reason, "http_status");
        assert.equal(result.httpStatus, 404);
        assert.equal(result.stage, "manifest");
        assert.equal(result.bytes, undefined);
      }
    },
    (_request, response) => {
      response.writeHead(404, { "Content-Type": "application/xml" });
      response.end("<Error><Code>BlobNotFound</Code></Error>");
      return true;
    },
  );
});

test("one missing or changed identity artifact does not discard the other format", async () => {
  for (const missing of [true, false]) {
    await withCdn(
      async ({ options, requests }) => {
        const report = await measureCdn(version, options);
        validateCdnReport(report, version);
        const [identity, gzip, br, ...otherFormat] = report.observations;
        assert.equal(identity.reason, missing ? "http_status" : "integrity_mismatch");
        assert.equal(identity.status, missing ? "unavailable" : "error");
        assert.equal(gzip.reason, "identity_unavailable");
        assert.equal(br.reason, "identity_unavailable");
        assert.ok(otherFormat.every(({ status }) => status === "ok"));
        assert.equal(requests.filter(({ path }) => path === targets[0].path).length, 1);
      },
      (request, response) => {
        if (request.url !== targets[0].path) return false;
        response.writeHead(missing ? 404 : 200, { "Content-Type": "text/javascript" });
        response.end("globalThis.notThePublishedArtifact = true;");
        return true;
      },
    );
  }
});

test("unsupported gzip and Brotli HTTP responses leave valid identity sizes intact", async () => {
  await withCdn(
    async ({ options }) => {
      const report = await measureCdn(version, options);
      validateCdnReport(report, version);
      for (const result of report.observations) {
        if (result.encoding === "identity") {
          assert.equal(result.status, "ok");
        } else {
          assert.equal(result.status, "unavailable");
          assert.equal(result.reason, "http_status");
          assert.equal(result.httpStatus, 406);
          assert.equal(result.bytes, undefined);
        }
      }
    },
    (request, response) => {
      if (request.headers["accept-encoding"] === "identity") return false;
      response.writeHead(406);
      response.end();
      return true;
    },
  );
});

test("rejects malformed or mismatched manifests before requesting artifacts", async () => {
  for (const mutate of [
    (data) => (data.manifest.version = "0.0.0"),
    (data) => (data.manifest.name = "another-module"),
    (data) => (data.manifest.ext["@min.js"].url = "https://example.com/wrong.js"),
    (data) => (data.manifest.ext["@min.js"].file = "wrong.js"),
    (data) => (data.manifest.ext["@min.js"].type = "text/html"),
    (data) => (data.manifest.ext["@min.js"].type = {}),
    (data) => (data.manifest.ext["@min.js"].hashes.sha256 = "not-base64"),
    (data) => (data.manifest.ext["@min.js"].integrity = "sha256-wrong"),
    (data) => delete data.manifest.ext["@umd.min.js"],
  ]) {
    const data = fixture();
    mutate(data);
    await withCdn(
      async ({ options, requests }) => {
        const report = await measureCdn(version, options);
        validateCdnReport(report, version);
        assert.equal(requests.length, 1);
        assert.ok(report.observations.every(({ reason }) => reason === "invalid_manifest"));
      },
      undefined,
      data,
    );
  }
  await withCdn(
    async ({ options }) => {
      const report = await measureCdn(version, options);
      validateCdnReport(report, version);
      assert.ok(report.observations.every(({ reason }) => reason === "invalid_manifest"));
    },
    (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{invalid");
      return true;
    },
  );
});

test("rejects HTTP errors, redirects, bad MIME, empty, truncated, and oversized bodies", async () => {
  for (const [reason, respond] of [
    [
      "http_status",
      (res) => {
        res.writeHead(302, { Location: targets[0].url });
        res.end();
      },
    ],
    [
      "http_status",
      (res) => {
        res.writeHead(500);
        res.end();
      },
    ],
    [
      "invalid_content_type",
      (res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>error</html>");
      },
    ],
    [
      "invalid_content_type",
      (res) => {
        res.writeHead(200);
        res.end("error");
      },
    ],
    [
      "empty_body",
      (res) => {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end();
      },
    ],
    [
      "body_too_large",
      (res) => {
        res.writeHead(200, {
          "Content-Type": "text/javascript",
          "Content-Length": 9 * 1024 * 1024,
        });
        res.flushHeaders();
      },
    ],
    [
      "body_too_large",
      (res) => {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(Buffer.alloc(8 * 1024 * 1024 + 1, 32));
      },
    ],
    [
      "transport",
      (res) => {
        res.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": 500 });
        res.write("short");
        res.socket.destroy();
      },
    ],
  ]) {
    await withCdn(
      async ({ options, requests }) => {
        const report = await measureCdn(version, options);
        validateCdnReport(report, version);
        assert.equal(requests.length, 3);
        for (const result of report.observations) {
          assert.equal(result.bytes, undefined);
          assert.equal(
            result.reason,
            result.encoding === "identity" ? reason : "identity_unavailable",
          );
        }
      },
      (request, response) => {
        if (request.url.endsWith(".json")) return false;
        respond(response);
        return true;
      },
    );
  }
});

test("rejects invalid JavaScript even when its hash matches the manifest", async () => {
  for (const body of [
    Buffer.from("<Error>BlobNotFound</Error>"),
    Buffer.from("// empty script"),
    Buffer.from([0xff]),
  ]) {
    const data = fixture();
    for (const target of targets) {
      data.bodies.set(target.path, body);
      Object.assign(data.manifest.ext[`@${target.format}`], getIntegrity(body));
    }
    await withCdn(
      async ({ options }) => {
        const report = await measureCdn(version, options);
        validateCdnReport(report, version);
        assert.ok(
          report.observations
            .filter(({ encoding }) => encoding === "identity")
            .every(({ reason }) => reason === "invalid_javascript"),
        );
      },
      undefined,
      data,
    );
  }
});

test("rejects wrong encoded content, headers, truncated compression, and decompression bombs independently", async () => {
  for (const [reason, header, bytes] of [
    ["integrity_mismatch", "gzip", gzipSync(Buffer.from("globalThis.wrongArtifact = true;"))],
    ["invalid_encoding", "gzip, br", gzipSync(Buffer.from("ignored"))],
    ["invalid_encoding", "br", gzipSync(Buffer.from("ignored"))],
    ["invalid_encoding", "gzip", Buffer.from("not gzip")],
    ["invalid_encoding", "gzip", gzipSync(Buffer.from("truncated")).subarray(0, 12)],
    ["body_too_large", "gzip", gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1, 32))],
  ]) {
    await withCdn(
      async ({ options }) => {
        const report = await measureCdn(version, options);
        validateCdnReport(report, version);
        for (const result of report.observations) {
          assert.equal(result.status, result.encoding === "gzip" ? "error" : "ok");
          if (result.encoding === "gzip") {
            assert.equal(result.reason, reason);
            assert.equal(result.bytes, undefined);
          }
        }
      },
      (request, response) => {
        if (request.headers["accept-encoding"] !== "gzip") return false;
        response.writeHead(200, { "Content-Type": "text/javascript", "Content-Encoding": header });
        response.end(bytes);
        return true;
      },
    );
  }
});

test("request deadline covers response headers and stalled bodies", async () => {
  for (const sendHeaders of [false, true]) {
    await withCdn(
      async ({ options }) => {
        const report = await measureCdn(version, { ...options, timeoutMs: 100 });
        validateCdnReport(report, version);
        assert.ok(report.observations.every(({ reason }) => reason === "timeout"));
      },
      (_request, response) => {
        if (sendHeaders) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write("{");
        }
        return true;
      },
    );
  }
});

test("Brotli decoding rejects corrupt and oversized content without affecting gzip", async () => {
  for (const [reason, bytes] of [
    ["invalid_encoding", Buffer.from("not brotli")],
    [
      "body_too_large",
      brotliCompressSync(Buffer.alloc(8 * 1024 * 1024 + 1, 32), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 1 },
      }),
    ],
  ]) {
    await withCdn(
      async ({ options }) => {
        const report = await measureCdn(version, options);
        validateCdnReport(report, version);
        for (const result of report.observations) {
          assert.equal(result.status, result.encoding === "br" ? "error" : "ok");
          if (result.encoding === "br") assert.equal(result.reason, reason);
        }
      },
      (request, response) => {
        if (request.headers["accept-encoding"] !== "br") return false;
        response.writeHead(200, {
          "Content-Type": "text/javascript",
          "Content-Encoding": "br",
        });
        response.end(bytes);
        return true;
      },
    );
  }
});

test("manifest response byte ceiling and remote test origins are rejected", async () => {
  await withCdn(
    async ({ options }) => {
      const report = await measureCdn(version, options);
      validateCdnReport(report, version);
      assert.ok(report.observations.every(({ reason }) => reason === "body_too_large"));
    },
    (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(" ".repeat(256 * 1024 + 1));
      return true;
    },
  );
  for (const testOrigin of ["http://example.com", "https://127.0.0.1", "http://127.0.0.1/path"]) {
    await assert.rejects(measureCdn(version, { testOrigin }), /loopback/);
  }
  await assert.rejects(measureCdn(version, { timeoutMs: 0 }), /timeout/);
});
