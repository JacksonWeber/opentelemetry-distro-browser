// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createGunzip } from "node:zlib";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    ingestionEndpoint: string;
    redirectEndpoint: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const ingestedEnvelopes = new Map<string, unknown[]>();
  let redirectRequests = 0;
  let finalRequests = 0;

  const finalServer = createServer((request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && request.url === "/v2.1/track") {
      finalRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ itemsAccepted: 1, itemsReceived: 1, errors: [] }));
      return;
    }
    response.writeHead(404).end();
  });
  const finalOrigin = await listen(finalServer);

  const ingestionServer = createServer(async (request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const ingestionMatch = request.url?.match(/^\/ingest\/([^/]+)\/v2\/track$/);
    if (request.method === "POST" && ingestionMatch) {
      try {
        const runId = decodeURIComponent(ingestionMatch[1]);
        const envelopes = JSON.parse(await readRequestBody(request)) as unknown[];
        ingestedEnvelopes.set(runId, [...(ingestedEnvelopes.get(runId) ?? []), ...envelopes]);
        if (
          envelopes.some(
            (envelope) =>
              (envelope as { data?: { baseData?: { message?: string } } }).data?.baseData
                ?.message === "pending-before-navigation",
          )
        ) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            itemsAccepted: envelopes.length,
            itemsReceived: envelopes.length,
            errors: [],
          }),
        );
      } catch (error) {
        response.writeHead(400).end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/captured")) {
      const runId = new URL(request.url, "http://localhost").searchParams.get("runId") ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(ingestedEnvelopes.get(runId) ?? []));
      return;
    }
    response.writeHead(404).end();
  });
  const ingestionOrigin = await listen(ingestionServer);
  project.provide("ingestionEndpoint", `${ingestionOrigin}/ingest/`);

  const redirectServer = createServer((request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && request.url === "/v2.1/track") {
      redirectRequests++;
      response.writeHead(307, { location: `${finalOrigin}/v2.1/track` }).end();
      return;
    }
    if (request.method === "GET" && request.url === "/counts") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ redirectRequests, finalRequests }));
      return;
    }
    if (request.method === "GET" && request.url === "/headers") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          baggage: request.headers.baggage,
          custom: request.headers["x-test-context"],
          traceparent: request.headers.traceparent,
          tracestate: request.headers.tracestate,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const redirectOrigin = await listen(redirectServer);
  project.provide("redirectEndpoint", `${redirectOrigin}/v2.1/track`);

  return async () => {
    await Promise.all([close(redirectServer), close(finalServer), close(ingestionServer)]);
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const stream =
    request.headers["content-encoding"] === "gzip" ? request.pipe(createGunzip()) : request;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "baggage, content-type, content-encoding, traceparent, tracestate, x-test-context",
  );
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Redirect test server did not bind to a TCP port."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // Browsers can keep requests or keep-alive sockets open after tests finish; without this,
    // close() waits for them indefinitely and the test run never exits.
    server.closeAllConnections();
  });
}
