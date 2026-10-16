// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { hash } from "node:crypto";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { getCdnArtifacts, getCdnUrl } from "../cdn.mjs";

export const cdnEncodings = {
  identity: { method: "none", metric: "bundle.minified.size" },
  gzip: { method: "gzip", metric: "bundle.gzip.size" },
  br: { method: "brotli", metric: "bundle.brotli.size" },
};
const maxBytes = 8 * 1024 * 1024;

export function getCdnRequests(version) {
  return getCdnArtifacts(version)
    .filter(
      ({ module, format }) =>
        module === "opentelemetry-browser" && ["min.js", "umd.min.js"].includes(format),
    )
    .flatMap(({ file, format }) => {
      const url = getCdnUrl(version, file);
      return Object.keys(cdnEncodings).map((encoding) => ({
        url,
        path: new URL(url).pathname,
        format: format === "min.js" ? "iife" : "umd",
        encoding,
      }));
    });
}

// Native HTTP keeps Content-Encoding intact. Count bodies, not HTTP framing or local compression.
async function download(result, { testOrigin, timeoutMs }) {
  const url = testOrigin ? new URL(result.path, testOrigin) : new URL(result.url);
  const signal = AbortSignal.timeout(timeoutMs);
  const metadata = (response) =>
    Object.assign(result, {
      httpStatus: response.statusCode,
      contentType: (response.headers["content-type"] ?? "").slice(0, 1024),
      contentEncoding: (response.headers["content-encoding"] ?? "identity")
        .trim()
        .toLowerCase()
        .slice(0, 1024),
    });
  let request;
  try {
    const response = await new Promise((resolve, reject) => {
      request = (url.protocol === "http:" ? httpGet : httpsGet)(
        url,
        {
          headers: { "Accept-Encoding": result.encoding, Accept: "text/javascript" },
          signal,
          agent: false,
        },
        resolve,
      );
      request.on("error", reject);
      request.on("upgrade", (response, socket) => {
        metadata(response);
        socket.destroy();
        reject(new Error(`HTTP ${response.statusCode}: protocol upgrades are not supported`));
      });
    });
    metadata(response);
    if (response.statusCode !== 200) {
      result.status = [404, 406, 410].includes(response.statusCode) ? "unavailable" : "error";
      result.reason = "http_status";
      throw new Error(`HTTP ${response.statusCode}`);
    }
    if (result.contentEncoding !== result.encoding) {
      result.status = result.contentEncoding === "identity" ? "unavailable" : "error";
      result.reason = "encoding_unavailable";
      throw new Error(`Requested ${result.encoding}, received ${result.contentEncoding}`);
    }
    if (!/^(text|application)\/javascript(?:;|$)/i.test(result.contentType)) {
      throw new Error("Unexpected JavaScript content type");
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response) {
      length += chunk.length;
      if (length > maxBytes) throw new Error("Response exceeds 8 MiB");
      chunks.push(chunk);
    }
    if (!length) throw new Error("Empty response body");
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (signal.aborted) throw new Error("Request deadline exceeded", { cause: error });
    throw error;
  } finally {
    request?.destroy();
  }
}

/** Measures exact versioned responses. Missing or invalid responses have a status, never a size. */
export async function measureCdn(version, { testOrigin, timeoutMs = 15_000 } = {}) {
  if (testOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(testOrigin)) {
    throw new Error("CDN test origin must be HTTP loopback");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15_000) {
    throw new Error("Invalid CDN timeout");
  }
  const observations = [];
  let identity;
  for (const target of getCdnRequests(version)) {
    const result = { ...target, stage: target.encoding === "identity" ? "identity" : "encoding" };
    if (target.encoding === "identity") identity = undefined;
    try {
      if (target.encoding !== "identity" && !identity) {
        result.status = "unavailable";
        result.reason = "identity_unavailable";
        result.stage = "identity";
        throw new Error("Cannot compare encoded response without an identity artifact");
      }
      const wire = await download(result, { testOrigin, timeoutMs });
      const decoded =
        target.encoding === "gzip"
          ? gunzipSync(wire, { maxOutputLength: maxBytes })
          : target.encoding === "br"
            ? brotliDecompressSync(wire, { maxOutputLength: maxBytes })
            : wire;
      if (target.encoding === "identity") {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(decoded).trim();
        if (!source || source.startsWith("<")) throw new Error("Response is not JavaScript");
        identity = decoded;
      } else if (!decoded.equals(identity)) {
        throw new Error("Decoded response differs from the identity artifact");
      }
      Object.assign(result, {
        status: "ok",
        bytes: wire.length,
        sha256: hash("sha256", decoded),
        wireSha256: hash("sha256", wire),
      });
    } catch (error) {
      result.status ??= "error";
      result.reason ??= "measurement_failed";
      result.message = error.message.slice(0, 1024);
    }
    result.fetchedAt = new Date().toISOString();
    observations.push(result);
  }
  return { version, observations };
}
