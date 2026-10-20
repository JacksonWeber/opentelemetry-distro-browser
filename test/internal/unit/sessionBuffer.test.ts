// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "../../../src/exporter/base.js";
import { beginUnloading, endUnloading } from "../../../src/exporter/common.js";
import { MAX_BEACON_BODY_SIZE } from "../../../src/exporter/constants.js";
import {
  MAX_SESSION_BUFFER_AGE_MS,
  MAX_SESSION_BUFFER_LENGTH,
  SESSION_BUFFER_KEY_PREFIX,
  SessionBuffer,
  sessionBufferStorage,
} from "../../../src/exporter/sessionBuffer.js";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import type { AzureMonitorEnvelope } from "../../../src/exporter/telemetryModels.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";
import {
  MemoryStorage,
  setSessionStorage,
  testSessionStorage,
} from "../../fixtures/sessionStorageSetup.js";
import { createReadableSpan } from "../../fixtures/telemetry.js";

const OTHER_INSTRUMENTATION_KEY = "00000000-0000-4000-8000-000000000002";
const endpoint = "https://example.test";
const connectionString = (key = TEST_INSTRUMENTATION_KEY): string =>
  `InstrumentationKey=${key};IngestionEndpoint=${endpoint}`;

let page = 0;
const clients: AzureMonitorExportClient[] = [];
const hanging: Array<(response: Response) => void> = [];

/** A response that stays pending until settled, like a request cut off by navigation. */
const hang = (): Promise<Response> => new Promise((resolve) => hanging.push(resolve));

function settleHanging(status: number): void {
  for (const resolve of hanging.splice(0)) resolve(new Response("", { status }));
}

/** Simulates a new document in the same tab, which has its own `performance.timeOrigin`. */
function loadPage(): void {
  page++;
  Object.defineProperty(performance, "timeOrigin", {
    configurable: true,
    value: 1_700_000_000_000 + page,
  });
}

/** Simulates `pagehide`, which releases buffered telemetry to the next document. */
function hidePage(): void {
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
}

/** Simulates a back/forward cache restore of the hidden document. */
function restorePage(): void {
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
}

function breezeResponse(errors: Array<{ index: number; statusCode: number }>, headers = {}) {
  return new Response(
    JSON.stringify({
      itemsReceived: 3,
      itemsAccepted: 3 - errors.length,
      errors: errors.map((error) => ({ ...error, message: "error" })),
    }),
    { status: 206, headers },
  );
}

function createClient(options: Partial<AzureMonitorOptions> = {}): AzureMonitorExportClient {
  const client = new AzureMonitorExportClient({ connectionString: connectionString(), ...options });
  clients.push(client);
  return client;
}

function envelope(name = "span"): AzureMonitorEnvelope {
  return spanToEnvelope(createReadableSpan({ name }), TEST_INSTRUMENTATION_KEY);
}

function exportAsync(
  client: AzureMonitorExportClient,
  envelopes: readonly AzureMonitorEnvelope[],
): Promise<ExportResult> {
  return new Promise((resolve) => client.export(envelopes, resolve));
}

function stubFetch(
  respond: () => Promise<Response> | Response = () => new Response("", { status: 200 }),
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => respond());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Names of the envelopes in each request body, in send order. */
function sentNames(fetch: ReturnType<typeof stubFetch>): string[][] {
  return fetch.mock.calls.map(([, init]) =>
    (JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as AzureMonitorEnvelope[]).map(
      (item) => (item.data.baseData as { name?: string }).name ?? "",
    ),
  );
}

function bufferKeys(): string[] {
  return Array.from({ length: testSessionStorage.length }, (_, index) =>
    testSessionStorage.key(index),
  ).filter((key): key is string => key?.startsWith(SESSION_BUFFER_KEY_PREFIX) === true);
}

beforeEach(() => {
  loadPage();
});

afterEach(async () => {
  settleHanging(200);
  await Promise.allSettled(clients.splice(0).map((client) => client.shutdown()));
  delete (performance as { timeOrigin?: number }).timeOrigin;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Azure Monitor sessionStorage buffer", () => {
  it("sends telemetry left unsent by the previous page first, exactly once", async () => {
    stubFetch(hang);
    void exportAsync(createClient(), [envelope("left behind")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    const secondPage = createClient();
    await exportAsync(secondPage, [envelope("new")]);
    await secondPage.forceFlush();

    expect(sentNames(fetch)).toEqual([["left behind"], ["new"]]);
    expect(bufferKeys()).toEqual([]);

    loadPage();
    const thirdFetch = stubFetch();
    await createClient().forceFlush();
    expect(thirdFetch).not.toHaveBeenCalled();
  });

  it("removes telemetry once ingestion accepts or permanently rejects it", async () => {
    let status = 200;
    stubFetch(() => new Response("", { status }));
    const client = createClient();

    await expect(exportAsync(client, [envelope("accepted")])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    status = 400;
    await expect(exportAsync(client, [envelope("rejected")])).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
    });
    hidePage();
    expect(bufferKeys()).toEqual([]);

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps telemetry that failed with a retriable error for the next page", async () => {
    // Retry-After beyond the retry-wait budget fails the export without waiting.
    stubFetch(() => new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    await expect(exportAsync(createClient(), [envelope("throttled")])).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
    });
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["throttled"]]);
  });

  it("does not resend unload requests the browser accepted", async () => {
    const fetch = stubFetch(hang);
    const client = createClient();
    beginUnloading();
    try {
      client.export([envelope("unload")], () => {});
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    } finally {
      endUnloading();
    }
    expect(bufferKeys()).toEqual([]);

    loadPage();
    const nextFetch = stubFetch();
    await createClient().forceFlush();
    expect(nextFetch).not.toHaveBeenCalled();
  });

  it("buffers envelopes that do not fit the unload beacon for the next page", async () => {
    stubFetch(hang);
    const client = createClient();
    const large = (name: string): AzureMonitorEnvelope => ({
      ...envelope(name),
      tags: { large: "x".repeat(MAX_BEACON_BODY_SIZE * 0.6) },
    });
    let result: ExportResult | undefined;
    hidePage();
    beginUnloading();
    try {
      client.export([large("sent"), large("dropped")], (value) => (result = value));
    } finally {
      endUnloading();
    }
    settleHanging(200);
    await vi.waitFor(() => expect(result).toBeDefined());
    expect(result?.error?.message).toBe("Unload beacon limit exceeded; sent 1 of 2 envelopes.");

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["dropped"]]);
  });

  it("buffers an unload payload that cannot fit any beacon", async () => {
    const fetch = stubFetch();
    const client = createClient();
    const oversized = {
      ...envelope("oversized"),
      tags: { large: "x".repeat(MAX_BEACON_BODY_SIZE) },
    };
    let result: ExportResult | undefined;
    hidePage();
    beginUnloading();
    try {
      client.export([oversized], (value) => (result = value));
    } finally {
      endUnloading();
    }
    expect(result?.error).toBeInstanceOf(RangeError);
    expect(fetch).not.toHaveBeenCalled();

    loadPage();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["oversized"]]);
  });

  it("does not adopt telemetry from live documents or the same document", async () => {
    stubFetch(hang);
    void exportAsync(createClient(), [envelope("live")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));

    const fetch = stubFetch();
    await createClient().forceFlush();
    loadPage();
    await createClient().forceFlush();
    expect(fetch).not.toHaveBeenCalled();
    expect(bufferKeys()).toHaveLength(1);
  });

  it("does not release a hidden but live page's telemetry", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    stubFetch(hang);
    const client = createClient();
    void exportAsync(client, [envelope("live")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    // Visibility flushes run as unloads, but the document stays alive.
    beginUnloading();
    endUnloading();
    expect(testSessionStorage.getItem(bufferKeys()[0])).toMatch(/^\[0,/);

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops telemetry another document adopted when restored from the back/forward cache", async () => {
    stubFetch(hang);
    const original = exportAsync(createClient(), [envelope("handed off")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["handed off"]]);

    restorePage();
    // The original request now fails retriably, but the adopting document already delivered it.
    for (const resolve of hanging.splice(0)) {
      resolve(new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    }
    await expect(original).resolves.toMatchObject({ code: ExportResultCode.FAILED });
    expect(bufferKeys()).toEqual([]);
  });

  it("stops retrying telemetry another document adopted", async () => {
    const firstFetch = stubFetch(
      () => new Response("", { status: 503, headers: { "retry-after": "1" } }),
    );
    const original = exportAsync(createClient(), [envelope("handed off")]);
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledOnce());
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["handed off"]]);

    restorePage();
    await expect(original).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
      error: { message: "Telemetry was handed off to another page." },
    });
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(bufferKeys()).toEqual([]);
  });

  it("keeps only new telemetry exported on restore before the buffer reconciles", async () => {
    let client: AzureMonitorExportClient | undefined;
    // Registered before the buffer's own listener, so it runs first.
    const onShow = (): void => client?.export([envelope("restored")], () => {});
    window.addEventListener("pageshow", onShow);
    try {
      stubFetch(hang);
      client = createClient();
      void exportAsync(client, [envelope("handed off")]);
      await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
      hidePage();

      loadPage();
      const fetch = stubFetch();
      await createClient().forceFlush();
      expect(sentNames(fetch)).toEqual([["handed off"]]);

      restorePage();
    } finally {
      window.removeEventListener("pageshow", onShow);
    }
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["restored"]]);
  });

  it("buffers retriable envelopes from a partial unload response", async () => {
    stubFetch(() =>
      breezeResponse([
        { index: 1, statusCode: 503 },
        { index: 2, statusCode: 400 },
      ]),
    );
    const client = createClient();
    let result: Promise<ExportResult>;
    beginUnloading();
    try {
      result = exportAsync(client, [envelope("accepted"), envelope("retriable"), envelope("bad")]);
    } finally {
      endUnloading();
    }
    await expect(result).resolves.toMatchObject({ code: ExportResultCode.FAILED });
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["retriable"]]);
  });

  it("keeps a dispatched batch while its partial response body is read", async () => {
    let body!: ReadableStreamDefaultController;
    const firstFetch = stubFetch(
      () =>
        new Response(new ReadableStream({ start: (controller) => void (body = controller) }), {
          status: 206,
        }),
    );
    const client = createClient();
    beginUnloading();
    try {
      void exportAsync(client, [envelope("first"), envelope("second")]);
    } finally {
      endUnloading();
    }
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledOnce());
    // The dispatched batch left the record; the 206 headers bring it back.
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["first", "second"]]);
    body.close();
  });

  it.each([false, true])(
    "keeps the whole batch after an unreadable partial response (unloading: %s)",
    async (unloading) => {
      stubFetch(() => new Response("not json", { status: 206 }));
      const client = createClient();
      let result: Promise<ExportResult>;
      if (unloading) beginUnloading();
      try {
        result = exportAsync(client, [envelope("first"), envelope("second")]);
      } finally {
        if (unloading) endUnloading();
      }
      await expect(result).resolves.toMatchObject({ code: ExportResultCode.FAILED });
      hidePage();

      loadPage();
      const fetch = stubFetch();
      await createClient().forceFlush();
      expect(sentNames(fetch)).toEqual([["first", "second"]]);
    },
  );

  it.each([200, 400])(
    "does not resend telemetry after HTTP %i when its body cannot be read",
    async (status) => {
      stubFetch(
        () =>
          new Response(
            new ReadableStream({ start: (controller) => controller.error(new TypeError("reset")) }),
            { status },
          ),
      );
      await expect(exportAsync(createClient(), [envelope("settled")])).resolves.toMatchObject({
        code: ExportResultCode.FAILED,
      });
      hidePage();
      expect(bufferKeys()).toEqual([]);

      loadPage();
      const fetch = stubFetch();
      await createClient().forceFlush();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to a beacon for telemetry another document adopted", async () => {
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    let failBody: (() => void) | undefined;
    const firstFetch = stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start: (controller) => (failBody = () => controller.error(new TypeError("reset"))),
          }),
          { status: 503 },
        ),
    );
    const client = createClient();
    let original: Promise<ExportResult>;
    // A hidden-visibility flush whose response body is still being read when the page freezes.
    beginUnloading();
    try {
      original = exportAsync(client, [envelope("handed off")]);
    } finally {
      endUnloading();
    }
    await vi.waitFor(() => expect(failBody).toBeDefined());
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["handed off"]]);

    restorePage();
    failBody?.();
    await expect(original).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
      error: { message: "Telemetry was handed off to another page." },
    });
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("keeps dispatched telemetry owned when its record was handed off", async () => {
    const firstFetch = stubFetch(hang);
    const client = createClient();
    void exportAsync(client, [envelope("buffered")]);
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledOnce());
    let dispatched: Promise<ExportResult>;
    beginUnloading();
    try {
      dispatched = exportAsync(client, [envelope("dispatched")]);
    } finally {
      endUnloading();
    }
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledTimes(2));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["buffered"]]);

    restorePage();
    const [buffered, unload] = hanging.splice(0);
    buffered(new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    unload(new Response("", { status: 503 }));
    await expect(dispatched).resolves.toMatchObject({ code: ExportResultCode.FAILED });
    hidePage();

    loadPage();
    const nextFetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(nextFetch)).toEqual([["dispatched"]]);
  });

  it("reclaims its telemetry when restored before another document adopts it", () => {
    const buffer = new SessionBuffer("destination");
    buffer.add('[{"name":"kept"}]');
    hidePage();
    expect(testSessionStorage.getItem(bufferKeys()[0])).toMatch(/^\[1,/);

    restorePage();
    expect(testSessionStorage.getItem(bufferKeys()[0])).toMatch(/^\[0,/);
    buffer.dispose();
  });

  it("buffers only outstanding retriable envelopes after a partial response", async () => {
    // Retry-After beyond the retry-wait budget fails the retry without waiting.
    stubFetch(() =>
      breezeResponse(
        [
          { index: 1, statusCode: 503 },
          { index: 2, statusCode: 400 },
        ],
        { "retry-after": "86400" },
      ),
    );
    await expect(
      exportAsync(createClient(), [envelope("accepted"), envelope("retriable"), envelope("bad")]),
    ).resolves.toMatchObject({ code: ExportResultCode.FAILED });
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["retriable"]]);
  });

  it("removes a partially accepted batch once its retry succeeds", async () => {
    const fetch = stubFetch();
    fetch.mockResolvedValueOnce(
      breezeResponse([{ index: 1, statusCode: 503 }], { "retry-after": "0" }),
    );
    await expect(
      exportAsync(createClient(), [envelope("accepted"), envelope("retried")]),
    ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
    expect(sentNames(fetch)).toEqual([["accepted", "retried"], ["retried"]]);
    expect(bufferKeys()).toEqual([]);
  });

  it("does not access sessionStorage when storage is disabled", async () => {
    const options = { connectionString: connectionString() };
    sessionBufferStorage.set(options, null);
    const getter = vi.fn(() => testSessionStorage);
    Object.defineProperty(window, "sessionStorage", { configurable: true, get: getter });
    stubFetch(() => new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    const client = new AzureMonitorExportClient(options);
    clients.push(client);
    await exportAsync(client, [envelope()]);
    hidePage();
    await client.shutdown();
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps telemetry for different connection strings apart and adopts it once", async () => {
    const other = { connectionString: connectionString(OTHER_INSTRUMENTATION_KEY) };
    stubFetch(hang);
    void exportAsync(createClient(), [envelope("first")]);
    void exportAsync(createClient(other), [envelope("second")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(2));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["first"]]);

    await createClient(other).forceFlush();
    expect(sentNames(fetch)).toEqual([["first"], ["second"]]);
  });

  it("exports without throwing when sessionStorage is unavailable", async () => {
    setSessionStorage(undefined);
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    const fetch = stubFetch();
    const client = createClient();

    await expect(exportAsync(client, [envelope()])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    await expect(exportAsync(client, [envelope()])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.filter(([message]) => message.includes("sessionStorage"))).toHaveLength(
      1,
    );
  });

  it("removes its record without throwing when sessionStorage is full", () => {
    const storage = new MemoryStorage();
    setSessionStorage(storage);
    vi.spyOn(diag, "warn").mockImplementation(() => {});
    const buffer = new SessionBuffer("destination");
    const first = buffer.add('[{"name":"first"}]');
    expect(storage.length).toBe(1);

    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const setItem = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    expect(() => buffer.add('[{"name":"second"}]')).not.toThrow();
    expect(storage.length).toBe(0);
    expect(() => buffer.settle(first, "", false)).not.toThrow();
    // Later batches back off instead of retrying the failing write each time.
    buffer.add('[{"name":"third"}]');
    buffer.add('[{"name":"fourth"}]');
    buffer.add('[{"name":"fifth"}]');
    expect(setItem).toHaveBeenCalledTimes(2);
    buffer.dispose();
  });

  it("bounds buffered telemetry by length, evicting the oldest first", () => {
    const buffer = new SessionBuffer("destination");
    const body = (name: string): string =>
      `[{"name":"${name}","pad":"${"x".repeat(MAX_SESSION_BUFFER_LENGTH / 3)}"}]`;
    buffer.add(body("oldest"));
    buffer.add(body("middle"));
    buffer.add(body("newest"));

    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored.length).toBeLessThanOrEqual(MAX_SESSION_BUFFER_LENGTH + 4);
    expect(stored).not.toContain("oldest");
    expect(stored).toContain("middle");
    expect(stored).toContain("newest");
    buffer.dispose();
  });

  it("evicts the oldest batches by timestamp, not insertion order", () => {
    const buffer = new SessionBuffer("destination");
    const now = Date.now();
    const body = (name: string, length: number): string =>
      `[{"name":"${name}","pad":"${"x".repeat(length)}"}]`;
    // Adopted records can interleave timestamps and have unequal sizes.
    buffer.add(body("newest", (MAX_SESSION_BUFFER_LENGTH * 3) / 5), now);
    buffer.add(body("oldest", MAX_SESSION_BUFFER_LENGTH / 5), now - 2000);
    buffer.add(body("middle", MAX_SESSION_BUFFER_LENGTH * 0.3), now - 1000);

    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored).not.toContain("oldest");
    expect(stored.indexOf("middle")).toBeGreaterThan(-1);
    expect(stored.indexOf("middle")).toBeLessThan(stored.indexOf("newest"));
    buffer.dispose();
  });

  it("evicts every batch older than one that overflows the buffer", () => {
    const buffer = new SessionBuffer("destination");
    const now = Date.now();
    const body = (name: string, length: number): string =>
      `[{"name":"${name}","pad":"${"x".repeat(length)}"}]`;
    buffer.add(body("oldest", 50 * 1024), now - 7000);
    buffer.add(body("middle", 90 * 1024), now - 6000);
    for (let index = 0; index < 5; index++) {
      buffer.add(body(`newer${index}`, 90 * 1024), now - 5000 + index);
    }

    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored).not.toContain("oldest");
    expect(stored).not.toContain("middle");
    expect(stored).toContain("newer0");
    expect(stored).toContain("newer4");
    buffer.dispose();
  });

  it("drops a batch that cannot fit alone without evicting older ones", () => {
    const buffer = new SessionBuffer("destination");
    buffer.add('[{"name":"older"}]');
    buffer.add(`[{"name":"huge","pad":"${"x".repeat(MAX_SESSION_BUFFER_LENGTH)}"}]`);

    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored).toContain("older");
    expect(stored).not.toContain("huge");
    buffer.dispose();
  });

  it("keeps endpoints whose keys could overlap apart", () => {
    const destination = `${TEST_INSTRUMENTATION_KEY}|https://example.test/ingest`;
    const other = new SessionBuffer(`${destination}|tenant-b`);
    other.add('[{"name":"tenant-b"}]');
    hidePage();

    loadPage();
    const buffer = new SessionBuffer(destination);
    expect(buffer.adopt()).toEqual([]);
    const tenantB = new SessionBuffer(`${destination}|tenant-b`);
    expect(tenantB.adopt().map(([, body]) => body)).toEqual(['[{"name":"tenant-b"}]']);
    for (const item of [other, buffer, tenantB]) item.dispose();
  });

  it("keeps evicted batches out when their requests later fail", () => {
    const buffer = new SessionBuffer("destination");
    const body = (name: string): string =>
      `[{"name":"${name}","pad":"${"x".repeat(MAX_SESSION_BUFFER_LENGTH / 3)}"}]`;
    const oldest = buffer.add(body("oldest"));
    buffer.begin(oldest);
    buffer.add(body("middle"));
    buffer.add(body("newest"));

    buffer.settle(oldest, body("oldest"), true);
    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored).not.toContain("oldest");
    expect(stored).toContain("newest");
    buffer.dispose();
  });

  it("discards expired and malformed records", () => {
    const destination = `${TEST_INSTRUMENTATION_KEY}|${endpoint}`;
    const prefix = `${SESSION_BUFFER_KEY_PREFIX}${encodeURIComponent(destination)}|old-page|`;
    const now = Date.now();
    const expired = now - MAX_SESSION_BUFFER_AGE_MS - 1;
    testSessionStorage.setItem(
      `${prefix}a`,
      JSON.stringify([1, [expired, [{ name: "expired" }]], [now, [{ name: "fresh" }]]]),
    );
    testSessionStorage.setItem(`${prefix}b`, "{");
    testSessionStorage.setItem(`${prefix}c`, JSON.stringify([0, [expired, [{ name: "stale" }]]]));

    const buffer = new SessionBuffer(destination);
    expect(buffer.adopt().map(([, body]) => body)).toEqual(['[{"name":"fresh"}]']);
    expect(bufferKeys()).toHaveLength(1);
    buffer.dispose();
    expect(bufferKeys()).toEqual([]);
  });

  it("removes its record on shutdown", async () => {
    stubFetch(() => new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    const client = createClient();
    await exportAsync(client, [envelope()]);
    expect(bufferKeys()).toHaveLength(1);

    await client.shutdown();
    expect(bufferKeys()).toEqual([]);
  });

  it("does not recreate its record when a request settles after disposal", () => {
    const buffer = new SessionBuffer("destination");
    const id = buffer.add('[{"name":"late"}]');
    buffer.dispose();
    buffer.settle(id, '[{"name":"late"}]', true);
    expect(bufferKeys()).toEqual([]);
  });
});
