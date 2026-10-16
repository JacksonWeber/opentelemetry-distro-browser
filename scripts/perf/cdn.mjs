// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { parse } from "acorn";
import { getCdnArtifacts, getCdnUrl } from "../cdn.mjs";

export const cdnEncodings = {
  identity: { method: "none", metric: "bundle.minified.size" },
  gzip: { method: "gzip", metric: "bundle.gzip.size" },
  br: { method: "brotli", metric: "bundle.brotli.size" },
};
const maxBytes = 8 * 1024 * 1024;
const maxManifestBytes = 256 * 1024;
const timeoutMs = 15_000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const javascriptTypes = new Set(["text/javascript", "application/javascript"]);
const mime = (value) => (typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "");
const reasons = new Set([
  "http_status",
  "encoding_unavailable",
  "invalid_encoding",
  "invalid_content_type",
  "empty_body",
  "body_too_large",
  "timeout",
  "transport",
  "invalid_manifest",
  "integrity_mismatch",
  "invalid_javascript",
  "identity_unavailable",
]);

export function getCdnTargets(version) {
  return getCdnArtifacts(version)
    .filter(
      ({ module, format }) =>
        module === "opentelemetry-browser" && ["min.js", "umd.min.js"].includes(format),
    )
    .map((artifact) => {
      const url = getCdnUrl(version, artifact.file);
      return {
        ...artifact,
        url,
        path: new URL(url).pathname,
        bundleFormat: artifact.format === "min.js" ? "iife" : "umd",
      };
    });
}

class CdnFailure extends Error {
  constructor(reason, message, status = "error", metadata = {}) {
    super(message);
    Object.assign(this, { reason, status, metadata });
  }
}

// Node HTTP returns encoded bodies unchanged, unlike fetch's transparent decompression.
async function download(url, encoding, type, limit, options) {
  const transportUrl = options.testOrigin
    ? new URL(new URL(url).pathname, options.testOrigin)
    : new URL(url);
  let metadata = {};
  try {
    return await new Promise((resolve, reject) => {
      const request = (transportUrl.protocol === "http:" ? httpGet : httpsGet)(
        transportUrl,
        {
          headers: { "Accept-Encoding": encoding, Accept: type },
          signal: AbortSignal.timeout(options.timeoutMs),
          agent: false,
        },
        (response) => {
          metadata = {
            httpStatus: response.statusCode,
            contentType: (response.headers["content-type"] ?? "").slice(0, 1024),
            contentEncoding: (response.headers["content-encoding"] ?? "identity")
              .trim()
              .toLowerCase()
              .slice(0, 1024),
          };
          const fail = (error) => {
            reject(error);
            response.destroy();
          };
          response.on("error", reject);
          if (response.statusCode !== 200) {
            fail(
              new CdnFailure(
                "http_status",
                `HTTP ${response.statusCode}`,
                [404, 406, 410].includes(response.statusCode) ? "unavailable" : "error",
                metadata,
              ),
            );
            return;
          }
          if (metadata.contentEncoding !== encoding) {
            const unavailable = encoding !== "identity" && metadata.contentEncoding === "identity";
            fail(
              new CdnFailure(
                unavailable ? "encoding_unavailable" : "invalid_encoding",
                `Requested ${encoding}, received ${metadata.contentEncoding}`,
                unavailable ? "unavailable" : "error",
                metadata,
              ),
            );
            return;
          }
          if (
            type === "application/json"
              ? mime(metadata.contentType) !== type
              : !javascriptTypes.has(mime(metadata.contentType))
          ) {
            fail(
              new CdnFailure("invalid_content_type", "Unexpected content type", "error", metadata),
            );
            return;
          }
          const declaredLength = response.headers["content-length"];
          if (declaredLength !== undefined && Number(declaredLength) > limit) {
            fail(
              new CdnFailure("body_too_large", "Response exceeds byte limit", "error", metadata),
            );
            return;
          }
          const chunks = [];
          let length = 0;
          response.on("data", (chunk) => {
            length += chunk.length;
            if (length > limit) {
              fail(
                new CdnFailure("body_too_large", "Response exceeds byte limit", "error", metadata),
              );
            } else {
              chunks.push(chunk);
            }
          });
          response.on("end", () => {
            if (!length) {
              reject(new CdnFailure("empty_body", "Empty response body", "error", metadata));
            } else {
              resolve({ bytes: Buffer.concat(chunks, length), ...metadata });
            }
          });
        },
      );
      request.on("error", reject);
    });
  } catch (error) {
    if (error instanceof CdnFailure) throw error;
    throw new CdnFailure(
      error.name === "AbortError" ? "timeout" : "transport",
      error.name === "AbortError" ? "Request deadline exceeded" : "Response transport failed",
      "error",
      metadata,
    );
  }
}

function manifestHashes(manifest, version, targets) {
  if (manifest?.name !== "opentelemetry-browser" || manifest.version !== version) {
    throw new CdnFailure("invalid_manifest", "Integrity manifest identity mismatch");
  }
  return new Map(
    targets.map((target) => {
      const entry = manifest.ext?.[`@${target.format}`];
      const sha256 = entry?.hashes?.sha256;
      if (
        entry?.url !== target.url ||
        entry.file !== target.file ||
        !javascriptTypes.has(mime(entry.type)) ||
        typeof sha256 !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(sha256) ||
        Buffer.from(sha256, "base64").toString("base64") !== sha256 ||
        typeof entry.integrity !== "string" ||
        !entry.integrity.split(/\s+/).includes(`sha256-${sha256}`)
      ) {
        throw new CdnFailure("invalid_manifest", "Invalid integrity manifest entry");
      }
      return [target.url, Buffer.from(sha256, "base64").toString("hex")];
    }),
  );
}

function decode(bytes, encoding) {
  try {
    return encoding === "gzip"
      ? gunzipSync(bytes, { maxOutputLength: maxBytes })
      : encoding === "br"
        ? brotliDecompressSync(bytes, { maxOutputLength: maxBytes })
        : bytes;
  } catch (error) {
    throw new CdnFailure(
      error.code === "ERR_BUFFER_TOO_LARGE" ? "body_too_large" : "invalid_encoding",
      "Cannot decode response within byte limit",
    );
  }
}

function javascript(bytes) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!parse(source, { ecmaVersion: 2022, sourceType: "script" }).body.length) {
      throw new Error("Empty script");
    }
  } catch {
    throw new CdnFailure("invalid_javascript", "Response is not a nonempty ES2022 script");
  }
}

function observation(target, encoding, stage, values) {
  return {
    url: target.url,
    path: target.path,
    format: target.bundleFormat,
    encoding,
    fetchedAt: new Date().toISOString(),
    stage,
    ...values,
  };
}

function failed(target, encoding, stage, error) {
  if (!(error instanceof CdnFailure)) throw error;
  return observation(target, encoding, stage, {
    ...error.metadata,
    status: error.status,
    reason: error.reason,
    message: error.message.slice(0, 1024),
  });
}

/**
 * Measures the exact package version's primary IIFE and UMD responses. Failures are data,
 * never zero-byte measurements. testOrigin is restricted to loopback and is not a CLI option.
 */
export async function measureCdn(version, options = {}) {
  const settings = { timeoutMs, ...options };
  if (
    !Number.isSafeInteger(settings.timeoutMs) ||
    settings.timeoutMs <= 0 ||
    settings.timeoutMs > timeoutMs
  ) {
    throw new Error("Invalid CDN timeout");
  }
  if (settings.testOrigin) {
    const origin = new URL(settings.testOrigin);
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(origin.hostname) ||
      origin.origin !== settings.testOrigin
    ) {
      throw new Error("CDN test origin must be an HTTP loopback origin");
    }
  }
  const targets = getCdnTargets(version);
  const manifestUrl = getCdnUrl(version, `opentelemetry-browser.${version}.integrity.json`);
  const report = { schemaVersion: 1, version, manifestUrl, observations: [] };
  let expectedHashes;
  let manifestSha256;
  try {
    const response = await download(
      manifestUrl,
      "identity",
      "application/json",
      maxManifestBytes,
      settings,
    );
    let manifest;
    try {
      manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes));
    } catch {
      throw new CdnFailure("invalid_manifest", "Cannot parse integrity manifest");
    }
    expectedHashes = manifestHashes(manifest, version, targets);
    manifestSha256 = hash(response.bytes);
  } catch (error) {
    report.observations = targets.flatMap((target) =>
      Object.keys(cdnEncodings).map((encoding) => failed(target, encoding, "manifest", error)),
    );
    return report;
  }
  report.observations = (
    await Promise.all(
      targets.map(async (target) => {
        const measure = async (encoding) => {
          const stage = encoding === "identity" ? "identity" : "encoding";
          let response;
          try {
            response = await download(target.url, encoding, "text/javascript", maxBytes, settings);
            const decoded = decode(response.bytes, encoding);
            const sha256 = hash(decoded);
            if (sha256 !== expectedHashes.get(target.url)) {
              throw new CdnFailure("integrity_mismatch", "Decoded SHA-256 does not match manifest");
            }
            if (encoding === "identity") javascript(decoded);
            return observation(target, encoding, stage, {
              status: "ok",
              httpStatus: response.httpStatus,
              contentType: response.contentType,
              contentEncoding: response.contentEncoding,
              bytes: response.bytes.length,
              decodedBytes: decoded.length,
              sha256,
              wireSha256: hash(response.bytes),
              manifestSha256,
            });
          } catch (error) {
            if (error instanceof CdnFailure && response) {
              error.metadata = {
                httpStatus: response.httpStatus,
                contentType: response.contentType,
                contentEncoding: response.contentEncoding,
                ...error.metadata,
              };
            }
            return failed(target, encoding, stage, error);
          }
        };
        const identity = await measure("identity");
        const encoded =
          identity.status === "ok"
            ? await Promise.all(["gzip", "br"].map(measure))
            : ["gzip", "br"].map((encoding) =>
                failed(
                  target,
                  encoding,
                  "identity",
                  new CdnFailure(
                    "identity_unavailable",
                    "Cannot verify encoded response without a valid identity artifact",
                    "unavailable",
                  ),
                ),
              );
        return [identity, ...encoded];
      }),
    )
  ).flat();
  return report;
}

/** Revalidates persisted CDN observations independently of the strict legacy result schema. */
export function validateCdnReport(report, version) {
  const targets = getCdnTargets(version);
  if (
    report?.schemaVersion !== 1 ||
    report.version !== version ||
    report.manifestUrl !== getCdnUrl(version, `opentelemetry-browser.${version}.integrity.json`) ||
    !Array.isArray(report.observations) ||
    report.observations.length !== targets.length * Object.keys(cdnEncodings).length
  ) {
    throw new Error("Invalid CDN report");
  }
  const seen = new Set();
  const validHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const positiveBytes = (value) => Number.isSafeInteger(value) && value > 0 && value <= maxBytes;
  for (const result of report.observations) {
    const target = targets.find(({ url }) => url === result?.url);
    const key = `${result?.url}:${result?.encoding}`;
    if (
      !target ||
      result.path !== target.path ||
      result.format !== target.bundleFormat ||
      !Object.hasOwn(cdnEncodings, result.encoding) ||
      seen.has(key) ||
      typeof result.fetchedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.fetchedAt) ||
      !Number.isFinite(Date.parse(result.fetchedAt)) ||
      new Date(result.fetchedAt).toISOString() !== result.fetchedAt ||
      Date.parse(result.fetchedAt) <= 0 ||
      BigInt(Date.parse(result.fetchedAt)) * 1_000_000n > 18446744073709551615n ||
      !["manifest", "identity", "encoding"].includes(result.stage) ||
      !["ok", "unavailable", "error"].includes(result.status) ||
      (result.httpStatus !== undefined &&
        (!Number.isInteger(result.httpStatus) ||
          result.httpStatus < 100 ||
          result.httpStatus > 599)) ||
      ["contentType", "contentEncoding"].some(
        (field) =>
          result[field] !== undefined &&
          (typeof result[field] !== "string" || result[field].length > 1024),
      )
    ) {
      throw new Error("Invalid or duplicate CDN observation");
    }
    seen.add(key);
    if (result.status === "ok") {
      if (
        result.stage !== (result.encoding === "identity" ? "identity" : "encoding") ||
        result.httpStatus !== 200 ||
        !javascriptTypes.has(mime(result.contentType)) ||
        result.contentEncoding !== result.encoding ||
        !positiveBytes(result.bytes) ||
        !positiveBytes(result.decodedBytes) ||
        !validHash(result.sha256) ||
        !validHash(result.wireSha256) ||
        !validHash(result.manifestSha256) ||
        result.reason !== undefined ||
        result.message !== undefined
      ) {
        throw new Error("Invalid successful CDN measurement");
      }
      const identity = report.observations.find(
        (value) => value.url === result.url && value.encoding === "identity",
      );
      if (
        identity?.status !== "ok" ||
        result.sha256 !== identity.sha256 ||
        result.manifestSha256 !== identity.manifestSha256 ||
        result.decodedBytes !== identity.bytes ||
        (result.encoding === "identity" && result.wireSha256 !== result.sha256)
      ) {
        throw new Error("CDN encoding does not match the identity artifact");
      }
    } else if (
      !reasons.has(result.reason) ||
      typeof result.message !== "string" ||
      !result.message.trim() ||
      result.message.length > 1024 ||
      ["bytes", "decodedBytes", "sha256", "wireSha256", "manifestSha256"].some(
        (field) => result[field] !== undefined,
      )
    ) {
      throw new Error("Invalid CDN failure outcome");
    }
  }
  return report.observations;
}
