// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, beforeEach, expect, inject, it, vi } from "vitest";
import { commands, server } from "vitest/browser";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { version } from "../../package.json";
import type { AzureMonitorEnvelope, PageViewData } from "../../src/exporter/telemetryModels.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";
import { withoutSdkStats } from "../fixtures/sdkStats.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../src/index.js";

const cookieKeys = ["ai_user", "ai_authUser", "ai_session"];
const storageKeys = ["opentelemetry-user", "opentelemetry-session"];
const prefixes = ["", "browser-a-", "browser-b-"];
const savedStorage = new Map<string, string | null>();
const cookieHandles = new Set<MicrosoftOpenTelemetryBrowser>();

// Chromium rejects SameSite-default deletion in a cross-site iframe. Firefox currently accepts
// it, while WebKit's default third-party policy blocks the initial write in this fixture.
it
  .runIf(server.browser === "chromium")
  .each(
    [false, true].flatMap((minified) =>
      (["del", "purge", "clear", "deferred-clear", "disable", "shutdown-del"] as const).map(
        (cleanup) => ({ minified, cleanup }),
      ),
    ),
  )(
  "removes cross-site HTTPS identity cookies with $cleanup (minified=$minified)",
  async ({ minified, cleanup }) => {
    const { before, after, reloaded } = await commands.inspectCrossSiteCookieCleanup(
      minified,
      cleanup,
    );
    // Prove third-party writes succeeded before asserting deletion, rather than passing vacuously.
    expect(before).toContain("ai_authUser=iframe-user%7Ciframe-account");
    const anonymousCookie = before.split("; ").find((part) => part.startsWith("ai_user="));
    expect(anonymousCookie).toMatch(/^ai_user=.+/);
    expect(after).toBe(cleanup === "disable" ? "" : anonymousCookie);
    expect(reloaded).toBe(after);
  },
);

function clearCookies() {
  for (const prefix of prefixes) {
    for (const key of cookieKeys) document.cookie = `${prefix}${key}=; max-age=0; path=/`;
  }
}

function readCookie(name: string) {
  const value = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
  if (!value) return null;
  const raw = value.slice(name.length + 1);
  const parts = (name.endsWith("ai_authUser") ? decodeURI(raw) : raw).split("|");
  if (name.endsWith("ai_user")) {
    return { anonymousId: parts[0], acquisitionTimestamp: Date.parse(parts[1]!) };
  }
  if (name.endsWith("ai_session")) {
    return {
      id: parts[0],
      startTimestamp: Number(parts[1]),
      lastActivityTimestamp: Number(parts[2]),
    };
  }
  return { authenticatedUserId: parts[0], ...(parts.length > 1 && { accountId: parts[1] }) };
}

beforeEach(() => {
  clearCookies();
  for (const prefix of prefixes) {
    for (const key of storageKeys) {
      savedStorage.set(prefix + key, localStorage.getItem(prefix + key));
      localStorage.removeItem(prefix + key);
    }
  }
  const fetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation(withoutSdkStats(fetch));
});

afterEach(async () => {
  try {
    await Promise.all([...cookieHandles].map((handle) => handle.shutdown()));
  } finally {
    cookieHandles.clear();
  }
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  clearCookies();
  for (const [key, value] of savedStorage) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  savedStorage.clear();
});

it.each(["index.js", "index.min.js"])(
  "releases async destination telemetry from %s to ingestion",
  async (file) => {
    const artifact =
      file === "index.js"
        ? new URL("../../dist/esm/index.js", import.meta.url).href
        : new URL("../../dist/esm/index.min.js", import.meta.url).href;
    const sdk = await import(/* @vite-ignore */ artifact);
    const runId = crypto.randomUUID();
    const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
    const captureUrl = `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`;
    let resolve!: (value: string) => void;
    const connectionString = new Promise<string>((done) => {
      resolve = done;
    });
    const telemetry = await sdk.useMicrosoftOpenTelemetry({
      azureMonitor: { connectionString },
      pageView: { enabled: false },
      session: { enabled: false },
      userContext: { enabled: false },
    });
    try {
      trace.getTracer("async-destination").startSpan("buffered span").end();
      logs.getLogger("async-destination").emit({ body: "buffered log" });
      await telemetry.forceFlush();
      expect(await fetch(captureUrl).then((response) => response.json())).toEqual([]);
      resolve(
        `InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=${ingestionEndpoint}`,
      );
      await Promise.resolve();
      await telemetry.forceFlush();
      const captured: AzureMonitorEnvelope[] = await fetch(captureUrl).then((response) =>
        response.json(),
      );
      expect(captured).toHaveLength(2);
      expect(captured).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              baseData: expect.objectContaining({ name: "buffered span" }),
            }),
          }),
          expect.objectContaining({
            data: expect.objectContaining({
              baseData: expect.objectContaining({ message: "buffered log" }),
            }),
          }),
        ]),
      );
    } finally {
      await telemetry.shutdown();
    }
  },
);

async function initializeCookieConsumer(
  file: string,
  options: MicrosoftOpenTelemetryBrowserOptions,
) {
  const path = `../../dist/esm/${file}`;
  const url = new URL(path, import.meta.url);
  const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
  const pipeline = createInMemoryPipeline();
  const handle = await distro.useMicrosoftOpenTelemetry({
    ...pipeline.options,
    ...options,
    pageView: { enabled: false },
  });
  cookieHandles.add(handle);
  return {
    handle,
    pipeline,
    async emit() {
      trace.getTracer("cookie-consumer").startSpan("cookie-operation").end();
      logs.getLogger("cookie-consumer").emit({ eventName: "cookie-event" });
      await handle.forceFlush();
      const span = pipeline.spanExporter.getFinishedSpans().at(-1)!;
      const log = pipeline.logExporter.getFinishedLogRecords().at(-1)!;
      for (const key of ["session.id", "enduser.pseudo.id", "user.id", "user.account.id"]) {
        expect(log.attributes[key]).toEqual(span.attributes[key]);
      }
      return span.attributes;
    },
  };
}

it.each(["index.js", "index.min.js"])(
  "persists prefixed cookies independently of Web Storage and requires auth opt-in through %s",
  async (file) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const options = { storage: { enabled: false, namePrefix: "browser-a-" } };
    const first = await initializeCookieConsumer(file, options);
    first.handle.userContext.setAuthenticatedUserContext("memory-user", "memory-account");
    const attributes = await first.emit();
    expect(attributes["session.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(attributes["user.id"]).toBe("memory-user");
    expect(readCookie("browser-a-ai_authUser")).toBeNull();
    expect(readCookie("browser-a-ai_user")).toEqual({
      anonymousId: attributes["enduser.pseudo.id"],
      acquisitionTimestamp: expect.any(Number),
    });
    expect(readCookie("browser-a-ai_session")!.id).toBe(attributes["session.id"]);
    await first.handle.shutdown();

    const restored = await initializeCookieConsumer(file, options);
    const restoredAttributes = await restored.emit();
    expect(restoredAttributes["session.id"]).toBe(attributes["session.id"]);
    expect(restoredAttributes["enduser.pseudo.id"]).toBe(attributes["enduser.pseudo.id"]);
    expect(restoredAttributes["user.id"]).toBeUndefined();
    expect(restoredAttributes["user.account.id"]).toBeUndefined();
    restored.handle.userContext.setAuthenticatedUserContext("user 雪%2F", "account=42", true);
    expect((await restored.emit())["user.id"]).toBe("user 雪%2F");
    expect(readCookie("browser-a-ai_authUser")).toEqual({
      authenticatedUserId: "user 雪%2F",
      accountId: "account=42",
    });
    await restored.handle.shutdown();

    const other = await initializeCookieConsumer(file, {
      storage: { enabled: false, namePrefix: "browser-b-" },
    });
    const otherAttributes = await other.emit();
    expect(otherAttributes["session.id"]).not.toBe(attributes["session.id"]);
    expect(otherAttributes["enduser.pseudo.id"]).not.toBe(attributes["enduser.pseudo.id"]);
    expect(otherAttributes["user.id"]).toBeUndefined();
    await other.handle.shutdown();

    const authenticated = await initializeCookieConsumer(file, options);
    expect(await authenticated.emit()).toMatchObject({
      "session.id": attributes["session.id"],
      "enduser.pseudo.id": attributes["enduser.pseudo.id"],
      "user.id": "user 雪%2F",
      "user.account.id": "account=42",
    });
    authenticated.handle.userContext.setAuthenticatedUserContext(
      "memory-replacement",
      undefined,
      false,
    );
    const memoryAttributes = await authenticated.emit();
    expect(memoryAttributes["user.id"]).toBe("memory-replacement");
    expect(memoryAttributes["user.account.id"]).toBeUndefined();
    // Observe browser storage independently of SDK flush; retry reads, never the delete.
    await vi.waitFor(() => expect(readCookie("browser-a-ai_authUser")).toBeNull(), {
      timeout: 5000,
    });
    authenticated.handle.userContext.setEnabled(false);
    expect(readCookie("browser-a-ai_user")).toBeNull();
    expect(readCookie("browser-b-ai_user")!.anonymousId).toBe(otherAttributes["enduser.pseudo.id"]);
    await authenticated.handle.shutdown();
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(readCookie("ai_user")).toBeNull();
    expect(readCookie("ai_session")).toBeNull();
  },
);

it.each(
  ["index.js", "index.min.js"].flatMap((file) =>
    ["", "browser-a-"].map((namePrefix) => ({ file, namePrefix })),
  ),
)(
  "continues Application Insights cookies and roundtrips canonical identities through $file (prefix=$namePrefix)",
  async ({ file, namePrefix }) => {
    const now = Date.now();
    const anonymousId = "AI+anonymous/id";
    const sessionId = "AI+session/id";
    const acquired = new Date(now - 86_400_000).toISOString();
    const start = now - 2000;
    const userId = "用户 雪%2F%7C%";
    const accountId = "tenant/雪%25#?";
    const anonymousName = `${namePrefix}ai_user`;
    const sessionName = `${namePrefix}ai_session`;
    const authName = `${namePrefix}ai_authUser`;
    document.cookie = `${anonymousName}=${anonymousId}|${acquired}; path=/`;
    document.cookie = `${sessionName}=${sessionId}|${start}|${now - 1000}; path=/`;
    document.cookie = `${authName}=${encodeURI(`${userId}|${accountId}`)}; path=/`;
    const legacyUser = JSON.stringify({ anonymousId: "old-storage-user" });
    localStorage.setItem(`${namePrefix}opentelemetry-user`, legacyUser);
    localStorage.setItem(
      `${namePrefix}opentelemetry-session`,
      JSON.stringify({ id: "superseded-backup", startTimestamp: start }),
    );
    const options = { storage: { namePrefix } };
    const first = await initializeCookieConsumer(file, options);
    const expected = {
      "enduser.pseudo.id": anonymousId,
      "session.id": sessionId,
      "user.id": userId,
      "user.account.id": accountId,
    };
    expect(await first.emit()).toMatchObject(expected);
    const manager = first.handle.getCookieMgr();
    expect(manager.get(anonymousName)).toBe(`${anonymousId}|${acquired}`);
    expect(manager.get(sessionName)).toMatch(new RegExp(`^AI\\+session/id\\|${start}\\|\\d+$`));
    expect(manager.get(authName)).toBe(encodeURI(`${userId}|${accountId}`));
    expect(localStorage.getItem(`${namePrefix}opentelemetry-user`)).toBe(legacyUser);

    const replacement = "replacement 雪%2F%7C%";
    first.handle.userContext.setAuthenticatedUserContext(replacement, accountId, true);
    expect(manager.get(authName)).toBe(encodeURI(`${replacement}|${accountId}`));
    await first.handle.shutdown();
    expect(JSON.parse(localStorage.getItem(`${namePrefix}opentelemetry-session`)!)).toMatchObject({
      id: sessionId,
      startTimestamp: start,
      lastActivityTimestamp: expect.any(Number),
    });
    const restored = await initializeCookieConsumer(file, options);
    expect(await restored.emit()).toMatchObject({ ...expected, "user.id": replacement });
    restored.handle.userContext.setAuthenticatedUserContext("memory|identity", "account|id", true);
    expect(await restored.emit()).toMatchObject({
      "user.id": "memory|identity",
      "user.account.id": "account|id",
    });
    expect(restored.handle.getCookieMgr().get(authName)).toBe("");
    await restored.handle.shutdown();
    const afterFailedPersistence = await initializeCookieConsumer(file, options);
    const attributes = await afterFailedPersistence.emit();
    expect(attributes["user.id"]).toBeUndefined();
    expect(attributes["session.id"]).toBe(sessionId);
    expect(attributes["enduser.pseudo.id"]).toBe(anonymousId);
  },
);

it.each(["index.js", "index.min.js"])(
  "honors disabled cookies, deferred enable and shutdown cancellation through %s",
  async (file) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const read = vi.spyOn(document, "cookie", "get");
    const write = vi.spyOn(document, "cookie", "set");
    const disabled = await initializeCookieConsumer(file, {
      storage: { enabled: false },
      cookieCfg: { enabled: false, disableCookieDefer: true },
    });
    disabled.handle.userContext.setAuthenticatedUserContext("memory-user", undefined, true);
    const memory = await disabled.emit();
    expect(memory["session.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(memory["enduser.pseudo.id"]).toBeUndefined();
    expect(memory["user.id"]).toBe("memory-user");
    disabled.handle.userContext.clearAuthenticatedUserContext();
    expect((await disabled.emit())["user.id"]).toBeUndefined();
    await disabled.handle.shutdown();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    const deferred = await initializeCookieConsumer(file, {
      storage: { enabled: false },
      cookieCfg: { enabled: false },
    });
    deferred.handle.userContext.setAuthenticatedUserContext("deferred-user", undefined, true);
    const before = await deferred.emit();
    expect(before["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(before["user.id"]).toBe("deferred-user");
    expect(deferred.pipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
    expect(deferred.pipeline.logExporter.getFinishedLogRecords()).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    deferred.handle.getCookieMgr().setEnabled(true);
    expect(readCookie("ai_session")!.id).toBe(before["session.id"]);
    expect(readCookie("ai_user")!.anonymousId).toBe(before["enduser.pseudo.id"]);
    expect(readCookie("ai_authUser")).toEqual({ authenticatedUserId: "deferred-user" });
    expect(await deferred.emit()).toMatchObject(before);
    expect(deferred.pipeline.spanExporter.getFinishedSpans()).toHaveLength(2);
    expect(deferred.pipeline.logExporter.getFinishedLogRecords()).toHaveLength(2);
    await deferred.handle.shutdown();

    const cancelled = await initializeCookieConsumer(file, {
      storage: { enabled: false, namePrefix: "browser-b-" },
      cookieCfg: { enabled: false },
    });
    cancelled.handle.userContext.setAuthenticatedUserContext("cancelled-user", undefined, true);
    await cancelled.emit();
    const manager = cancelled.handle.getCookieMgr();
    expect(manager.get("browser-b-ai_authUser")).not.toBe("");
    await cancelled.handle.shutdown();
    write.mockClear();
    manager.setEnabled(true);
    cancelled.handle.userContext.setEnabled(true);
    cancelled.handle.userContext.setAuthenticatedUserContext("stale-user", undefined, true);
    expect(manager.isEnabled()).toBe(false);
    expect(manager.get("browser-b-ai_authUser")).toBe("");
    expect(write).not.toHaveBeenCalled();
    for (const key of cookieKeys) expect(readCookie(`browser-b-${key}`)).toBeNull();
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  },
);

it.each(["index.js", "index.min.js"])(
  "exports exception attachments from %s for logs and span events",
  async (file) => {
    const artifact =
      file === "index.js"
        ? new URL("../../dist/esm/index.js", import.meta.url).href
        : new URL("../../dist/esm/index.min.js", import.meta.url).href;
    const sdk = await import(/* @vite-ignore */ artifact);
    const runId = crypto.randomUUID();
    const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
    const expLog = vi.fn(() => ({
      logs: ["checkout failed", "checkout started", "outside limit"],
    }));
    const telemetry = await sdk.useMicrosoftOpenTelemetry({
      azureMonitor: {
        connectionString: `InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=${ingestionEndpoint}`,
      },
      expCfg: { inclScripts: true, expLog, maxLogs: 2 },
      pageView: { enabled: false },
      session: { enabled: false },
      userContext: { enabled: false },
    });
    const script = document.createElement("script");
    // A data block exposes native script attributes without fetching or executing test code.
    script.type = "application/json";
    script.src = new URL("/exception-context.js?token=private", location.href).href;
    script.crossOrigin = "anonymous";
    script.setAttribute("async", "false");
    script.defer = true;
    script.referrerPolicy = "no-referrer";
    try {
      document.head.append(script);
      logs.getLogger("exception-context").emit({
        eventName: "exception",
        attributes: { "exception.type": "TypeError", "exception.message": "log failure" },
      });
      const span = trace.getTracer("exception-context").startSpan("checkout");
      span.recordException(new Error("span failure"));
      span.end();
      await telemetry.forceFlush();
      const captured: AzureMonitorEnvelope[] = await fetch(
        `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`,
      ).then((response) => response.json());
      const exceptions = captured.filter((envelope) => envelope.data.baseType === "ExceptionData");
      expect(exceptions).toHaveLength(2);
      for (const exception of exceptions) {
        expect(exception.data.baseData.properties).toMatchObject({
          exceptionLog: "checkout failed\ncheckout started",
          exceptionScripts: expect.any(String),
        });
        const serializedScripts = String(exception.data.baseData.properties!.exceptionScripts);
        const scripts = JSON.parse(serializedScripts);
        expect(Array.isArray(scripts)).toBe(true);
        expect(scripts).toContainEqual({
          url: new URL("/exception-context.js?token=REDACTED", location.href).href,
          crossOrigin: "anonymous",
          async: true,
          defer: true,
          referrerPolicy: "no-referrer",
        });
        expect(new TextEncoder().encode(serializedScripts).byteLength).toBeLessThanOrEqual(8192);
      }
      expect(expLog).toHaveBeenCalledTimes(2);
    } finally {
      script.remove();
      await telemetry.shutdown();
    }
  },
);

it("sends telemetry from a browser interaction to Azure Monitor ingestion", async () => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
  const pipeline = createInMemoryPipeline();
  let pageReady!: () => void;
  const pageEmitted = new Promise<void>((resolve) => {
    pageReady = resolve;
  });
  const telemetry = await (
    await import(/* @vite-ignore */ new URL("../../dist/esm/index.js", import.meta.url).href)
  ).useMicrosoftOpenTelemetry({
    ...pipeline.options,
    azureMonitor: {
      connectionString:
        `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
        `IngestionEndpoint=${ingestionEndpoint}`,
    },
    resource: resourceFromAttributes({
      "service.version": "synthetic-release-42",
    }),
    pageView: {
      routeResolver: () => "Browser integration",
      applyCustomLogRecordData: () => pageReady(),
    },
    session: { enabled: true, persist: false, inactivityTimeout: 60, maxDuration: 3600 },
  });
  const button = document.createElement("button");
  let applicationSpanId: string | undefined;
  button.addEventListener("click", () => {
    const logger = logs.getLogger("browser-ingestion-test");
    const span = trace.getTracer("browser-ingestion-test").startSpan("checkout.click");
    applicationSpanId = span.spanContext().spanId;
    const applicationContext = trace.setSpan(ROOT_CONTEXT, span);
    logger.emit({
      eventName: "checkout.context",
      context: applicationContext,
      attributes: { "test.run_id": runId },
    });
    trace
      .getTracer("browser-ingestion-test")
      .startSpan("checkout.child", {}, applicationContext)
      .end();
    span.end();
    logger.emit({
      eventName: "checkout.clicked",
      body: runId,
      attributes: { "test.run_id": runId },
    });
    logger.emit({
      eventName: "browser.page_view",
      attributes: {
        "browser.page_view.name": "Checkout",
        "browser.page_view.duration": 425.25,
        "browser.page_view.performance.total": 425.25,
        "browser.page_view.performance.network_connect": 25,
        "browser.page_view.performance.sent_request": 100.5,
        "browser.page_view.performance.received_response": 50.25,
        "browser.page_view.performance.dom_processing": 249.5,
        "browser.page_view.index": 1,
        "browser.page_view.duration_source": "navigation_timing",
        "browser.page_view.name_source": "explicit",
        "browser.page_view.same_document": false,
        "browser.page_view.type": "navigate",
        "url.full": `${location.origin}/checkout`,
        "test.run_id": runId,
        itemCount: 2,
      },
    });
    logger.emit({
      eventName: "checkout.custom",
      attributes: { "test.run_id": runId, itemCount: 2 },
    });
  });
  document.body.append(button);

  try {
    await pageEmitted;
    const operationId = trace.getSpanContext(context.active())!.traceId;
    button.click();
    await telemetry.forceFlush();

    const captured: AzureMonitorEnvelope[] = await fetch(
      `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`,
    ).then((response) => response.json());
    const sessionId = captured[0].tags["ai.session.id"];
    const pageViews = captured.filter(
      (envelope): envelope is AzureMonitorEnvelope<PageViewData> =>
        envelope.data.baseType === "PageViewData",
    );
    const automaticPageView = pageViews.find(
      (envelope) => envelope.data.baseData.name !== "Checkout",
    );
    const operationName = automaticPageView?.data.baseData.name;
    expect(operationName).toEqual(expect.any(String));
    expect(automaticPageView?.tags["ai.operation.name"]).toBe(operationName);
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
    for (const envelope of captured) {
      expect(envelope.tags["ai.session.id"]).toBe(sessionId);
      expect(envelope.tags).toMatchObject({
        "ai.device.type": "Browser",
        "ai.device.id": "browser",
        "ai.application.ver": "synthetic-release-42",
      });
      expect(envelope).not.toHaveProperty("ver");
      expect(envelope).not.toHaveProperty("sampleRate");
      expect(envelope.data.baseData.properties?.["session.id"]).toBeUndefined();
      if (["PageViewData", "PageviewPerformanceData"].includes(envelope.data.baseType)) {
        for (const key of [
          "browser.page_view.index",
          "browser.page_view.duration_source",
          "browser.page_view.name_source",
          "browser.page_view.same_document",
          "browser.page_view.type",
        ]) {
          expect(envelope.data.baseData.properties ?? {}).not.toHaveProperty(key);
          expect(envelope.data.baseData.measurements ?? {}).not.toHaveProperty(key);
        }
      }
    }
    const originalPage = pipeline.logExporter
      .getFinishedLogRecords()
      .find(
        (record) =>
          record.eventName === "browser.page_view" &&
          record.attributes["browser.page_view.index"] === 0,
      );
    expect(originalPage?.attributes).toMatchObject({
      "browser.page_view.index": 0,
      "browser.page_view.duration_source": expect.any(String),
      "browser.page_view.name_source": expect.any(String),
      "browser.page_view.same_document": false,
      "browser.page_view.type": expect.any(String),
    });
    expect(captured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tags: expect.objectContaining({ "ai.operation.id": operationId }),
          data: expect.objectContaining({
            baseType: "PageViewData",
            baseData: expect.objectContaining({ id: operationId }),
          }),
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.RemoteDependency",
          tags: expect.objectContaining({
            "ai.operation.id": operationId,
            "ai.operation.name": operationName,
          }),
          data: expect.objectContaining({
            baseType: "RemoteDependencyData",
            baseData: expect.objectContaining({ name: "checkout.click" }),
          }),
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.Event",
          tags: expect.objectContaining({
            "ai.operation.id": operationId,
            "ai.operation.name": operationName,
          }),
          data: expect.objectContaining({
            baseType: "EventData",
            baseData: expect.objectContaining({
              name: "checkout.clicked",
              properties: expect.objectContaining({ "test.run_id": runId }),
            }),
          }),
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.PageView",
          tags: expect.objectContaining({
            "ai.operation.id": operationId,
            "ai.operation.name": "Checkout",
          }),
          data: {
            baseType: "PageViewData",
            baseData: expect.objectContaining({
              id: operationId,
              name: "Checkout",
              url: `${location.origin}/checkout`,
              duration: "00:00:00.4252500",
              properties: expect.objectContaining({ "test.run_id": runId }),
              measurements: { itemCount: 2 },
            }),
          },
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.PageviewPerformance",
          tags: expect.objectContaining({
            "ai.operation.id": operationId,
            "ai.operation.name": "Checkout",
          }),
          data: {
            baseType: "PageviewPerformanceData",
            baseData: expect.objectContaining({
              name: "Checkout",
              url: `${location.origin}/checkout`,
              duration: "00:00:00.4252500",
              perfTotal: "00:00:00.4252500",
              networkConnect: "00:00:00.0250000",
              sentRequest: "00:00:00.1005000",
              receivedResponse: "00:00:00.0502500",
              domProcessing: "00:00:00.2495000",
              properties: expect.objectContaining({ "test.run_id": runId }),
              measurements: { itemCount: 2 },
            }),
          },
        }),
        expect.objectContaining({
          name: "Microsoft.ApplicationInsights.Event",
          tags: expect.objectContaining({
            "ai.operation.id": operationId,
            "ai.operation.name": operationName,
          }),
          data: {
            baseType: "EventData",
            baseData: expect.objectContaining({
              name: "checkout.custom",
              properties: expect.objectContaining({ "test.run_id": runId }),
              measurements: expect.objectContaining({ itemCount: 2 }),
            }),
          },
        }),
      ]),
    );
    const parented = captured.filter((envelope) =>
      Object.hasOwn(envelope.tags, "ai.operation.parentId"),
    );
    expect(parented).toHaveLength(2);
    expect(parented).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tags: expect.objectContaining({ "ai.operation.parentId": applicationSpanId }),
          data: expect.objectContaining({
            baseType: "EventData",
            baseData: expect.objectContaining({ name: "checkout.context" }),
          }),
        }),
        expect.objectContaining({
          tags: expect.objectContaining({ "ai.operation.parentId": applicationSpanId }),
          data: expect.objectContaining({
            baseType: "RemoteDependencyData",
            baseData: expect.objectContaining({ name: "checkout.child" }),
          }),
        }),
      ]),
    );
  } finally {
    button.remove();
    await telemetry.shutdown();
  }
});

it.each([true, false])(
  "exports application session precedence to Azure Monitor (managed sessions=%s)",
  async (enabled) => {
    const runId = crypto.randomUUID();
    const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
    const telemetry = await (
      await import(/* @vite-ignore */ new URL("../../dist/esm/index.js", import.meta.url).href)
    ).useMicrosoftOpenTelemetry({
      azureMonitor: {
        connectionString:
          `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
          `IngestionEndpoint=${ingestionEndpoint}`,
      },
      resource: resourceFromAttributes({ "session.id": "application-resource" }),
      session: { enabled, persist: false },
      pageView: { enabled: false },
    });

    try {
      const cases = [
        { name: "resource-only", attributes: {}, expected: "application-resource" },
        {
          name: "empty-record",
          attributes: { "session.id": "" },
          expected: "application-resource",
        },
        {
          name: "record-override",
          attributes: { "session.id": "application-record" },
          expected: "application-record",
        },
      ];
      for (const { name, attributes } of cases) {
        trace.getTracer("session-precedence").startSpan(name, { attributes }).end();
        logs.getLogger("session-precedence").emit({ eventName: name, attributes });
      }
      await telemetry.forceFlush();

      const captured: AzureMonitorEnvelope[] = await fetch(
        `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`,
      ).then((response) => response.json());
      expect(captured).toHaveLength(cases.length * 2);
      for (const { name, expected } of cases) {
        for (const baseType of ["RemoteDependencyData", "EventData"]) {
          expect(captured).toContainEqual(
            expect.objectContaining({
              tags: expect.objectContaining({ "ai.session.id": expected }),
              data: expect.objectContaining({
                baseType,
                baseData: expect.objectContaining({ name }),
              }),
            }),
          );
        }
      }
    } finally {
      await telemetry.shutdown();
    }
  },
);

it("redacts the default page URL in the Azure Monitor ingestion payload", async () => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
  const originalUrl = `${location.pathname}${location.search}${location.hash}`;
  history.replaceState(
    null,
    "",
    "/callback?code=query-secret#access_token=access-secret&id_token=id-secret&state=public",
  );
  let pageReady!: () => void;
  const pageEmitted = new Promise<void>((resolve) => {
    pageReady = resolve;
  });
  const telemetry = await (
    await import(/* @vite-ignore */ new URL("../../dist/esm/index.js", import.meta.url).href)
  ).useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString:
        `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
        `IngestionEndpoint=${ingestionEndpoint}`,
    },
    pageView: { applyCustomLogRecordData: () => pageReady() },
  });

  try {
    await pageEmitted;
    await telemetry.forceFlush();

    const captured: AzureMonitorEnvelope[] = await fetch(
      `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`,
    ).then((response) => response.json());
    const pageView = captured.find((envelope) => envelope.data.baseType === "PageViewData");
    expect(pageView).toMatchObject({
      data: {
        baseType: "PageViewData",
        baseData: {
          url: `${location.origin}/callback?code=REDACTED#access_token=REDACTED&id_token=REDACTED&state=public`,
        },
      },
    });
    expect(JSON.stringify(captured)).not.toMatch(/query-secret|access-secret|id-secret/);
  } finally {
    await telemetry.shutdown();
    history.replaceState(null, "", originalUrl);
  }
});

it.each(["index.js", "index.min.js"])(
  "exports manual telemetry from application APIs through %s",
  async (file) => {
    // Type-check from a clean checkout; load the built artifact only at runtime.
    const path = `../../dist/esm/${file}`;
    const url = new URL(path, import.meta.url);
    const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
    expect(Object.keys(distro).sort()).toEqual([
      "AzureMonitorLogRecordExporter",
      "AzureMonitorSpanExporter",
      "BrowserDetector",
      "OPENTELEMETRY_BROWSER_VERSION",
      "UserAgentDetector",
      "browserDetector",
      "useMicrosoftOpenTelemetry",
      "userAgentDetector",
    ]);
    expect(distro.OPENTELEMETRY_BROWSER_VERSION).toBe(version);
    expect(window).not.toHaveProperty("OpenTelemetryBrowser");
    const pipeline = createInMemoryPipeline();
    const tracer = trace.getTracer("browser-consumer");
    const logger = logs.getLogger("browser-consumer");
    const telemetry = await distro.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      session: { enabled: true },
    });
    try {
      const span = tracer.startSpan("before-init");
      logger.emit({
        eventName: "before-init",
        context: trace.setSpan(ROOT_CONTEXT, span),
      });
      span.end();
      trace.getTracer("after-init").startSpan("after-init").end();
      logs.getLogger("after-init").emit({ eventName: "after-init" });
      await pipeline.forceFlush();
      const spans = pipeline.spanExporter.getFinishedSpans();
      const records = pipeline.logExporter.getFinishedLogRecords();
      expect(spans.map((record) => record.name)).toEqual(["before-init", "after-init"]);
      expect(records.map((record) => record.eventName)).toEqual(["before-init", "after-init"]);
      expect(records[0].spanContext).toEqual(spans[0].spanContext());
      const sessionId = spans[0].attributes["session.id"];
      expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
      for (const record of [...spans, ...records]) {
        expect(record.attributes["session.id"]).toBe(sessionId);
        expect(record.attributes["enduser.pseudo.id"]).toBe(readCookie("ai_user")!.anonymousId);
      }
      expect(readCookie("ai_session")!.id).toBe(sessionId);
      expect(localStorage.getItem("opentelemetry-session")).toBeNull();
      tracer
        .startSpan("application-session", {
          attributes: { "session.id": "application-span" },
        })
        .end();
      logger.emit({
        eventName: "application-session",
        attributes: { "session.id": "application-log" },
      });
      await pipeline.forceFlush();
      expect(pipeline.spanExporter.getFinishedSpans().at(-1)?.attributes["session.id"]).toBe(
        "application-span",
      );
      expect(pipeline.logExporter.getFinishedLogRecords().at(-1)?.attributes["session.id"]).toBe(
        "application-log",
      );
    } finally {
      await telemetry.shutdown();
    }
  },
);
