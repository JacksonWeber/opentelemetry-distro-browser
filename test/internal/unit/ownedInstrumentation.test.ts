// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { logs } from "@opentelemetry/api-logs";
import { context, diag, propagation, trace } from "@opentelemetry/api";
import {
  BatchLogRecordProcessor,
  type BatchLogRecordProcessorBrowserOptions,
  type LogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import {
  ATTR_PAGE_VIEW_DURATION_SOURCE,
  EVENT_BROWSER_PAGE_VIEW,
} from "../../../src/instrumentation/pageView/semconv.js";
import { isUnloading } from "../../../src/exporter/common.js";
import type { MicrosoftOpenTelemetryBrowser } from "../../../src/types.js";
import { BROWSER_ASYNC_TIMEOUT_MS } from "../../fixtures/timeouts.js";
import { createSession } from "../../../src/session/createSession.js";

vi.mock("../../../src/session/createSession.js", { spy: true });

/** Captures every log record the distribution emits through the real pipeline. */
class RecordingProcessor implements LogRecordProcessor {
  public readonly eventNames: string[] = [];

  public onEmit(record: { eventName?: string }): void {
    if (record.eventName) this.eventNames.push(record.eventName);
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const originalUrl = location.href;
const storageKey = "opentelemetry-session";
let previousSession: string | null;
let sdk: MicrosoftOpenTelemetryBrowser | undefined;

function clearIdentityCookies(): void {
  for (const name of ["ai_session", "ai_user", "ai_authUser"]) {
    document.cookie = `${name}=; max-age=0; path=/`;
  }
}

/** Resolves after the browser has painted and the main thread has gone idle. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 50);
      });
    });
  });
}

function pageViewCount(processor: RecordingProcessor): number {
  return processor.eventNames.filter((name) => name === EVENT_BROWSER_PAGE_VIEW).length;
}

beforeEach(() => {
  clearIdentityCookies();
  if (location.href !== originalUrl) {
    history.replaceState(null, "", originalUrl);
  }
  previousSession = localStorage.getItem(storageKey);
});

afterEach(async () => {
  await sdk?.shutdown();
  sdk = undefined;
  logs.disable();
  trace.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  clearIdentityCookies();
  if (location.href !== originalUrl) {
    history.replaceState(null, "", originalUrl);
  }
  if (previousSession === null) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, previousSession);
});

describe("distribution-owned instrumentation", () => {
  it("restores the session before enabling page views and snapshots settings while awaiting", async () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ id: "restored-page-view-session", startTimestamp: Date.now() }),
    );
    const records: { eventName?: string; attributes: Record<string, unknown> }[] = [];
    const processors: LogRecordProcessor[] = [
      {
        onEmit: (record) => {
          records.push(record);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ];
    const pageView = { routeResolver: () => "/original-route" };
    const pushState = history.pushState;
    const pending = useMicrosoftOpenTelemetry({
      session: { enabled: true },
      userContext: { enabled: false },
      spanProcessors: [],
      logRecordProcessors: processors,
      pageView,
    });
    expect(records).toEqual([]);
    expect(history.pushState).toBe(pushState);
    processors.length = 0;
    pageView.routeResolver = () => "/changed-route";
    sdk = await pending;
    await settle();
    expect(records).toEqual([
      expect.objectContaining({
        eventName: EVENT_BROWSER_PAGE_VIEW,
        attributes: expect.objectContaining({
          "session.id": "restored-page-view-session",
          "browser.page_view.name": "/original-route",
        }),
      }),
    ]);
  });

  it("collects page views without the application importing anything", async () => {
    const processor = new RecordingProcessor();
    sdk = await useMicrosoftOpenTelemetry({ logRecordProcessors: [processor] });

    await settle();
    history.pushState(null, "", "/settings-driven");
    await vi.waitFor(() => expect(pageViewCount(processor)).toBe(2), {
      timeout: BROWSER_ASYNC_TIMEOUT_MS,
    });
  });

  it("honours page-view configuration supplied as settings", async () => {
    const processor = new RecordingProcessor();
    sdk = await useMicrosoftOpenTelemetry({
      logRecordProcessors: [processor],
      pageView: { routeResolver: () => "/orders/:id" },
    });

    await settle();

    const record = processor.eventNames.at(-1);
    expect(record).toBe(EVENT_BROWSER_PAGE_VIEW);
  });

  it("collects nothing when page view is switched off", async () => {
    const processor = new RecordingProcessor();
    sdk = await useMicrosoftOpenTelemetry({
      logRecordProcessors: [processor],
      pageView: { enabled: false },
    });

    await settle();
    history.pushState(null, "", "/switched-off");
    await settle();

    expect(pageViewCount(processor)).toBe(0);
  });

  it.each([
    ["document load", "pagehide"],
    ["document load", "visibilitychange"],
    ["soft navigation", "pagehide"],
    ["soft navigation", "visibilitychange"],
  ])("exports a pending %s when %s arrives first", async (navigation, firstEvent) => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const exported: ReadableLogRecord[] = [];
    const finishExports: Array<() => void> = [];
    const exporter = {
      export: vi.fn((records: ReadableLogRecord[], callback: (result: ExportResult) => void) => {
        exported.push(...records);
        finishExports.push(() => callback({ code: ExportResultCode.SUCCESS }));
      }),
      forceFlush: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const processorOptions = {
      exporter,
      disableAutoFlushOnDocumentHide: true,
      scheduledDelayMillis: 60_000,
    } satisfies BatchLogRecordProcessorBrowserOptions;
    const processor = new BatchLogRecordProcessor(processorOptions);
    const flush = vi.spyOn(processor, "forceFlush");
    const emit = vi.spyOn(processor, "onEmit");
    sdk = await useMicrosoftOpenTelemetry({
      spanProcessors: [],
      logRecordProcessors: [processor],
      pageView: { softNavigationSettleTimeoutMs: 60_000 },
    });
    if (navigation === "soft navigation") history.pushState(null, "", "/unsettled");
    logs.getLogger("unload-test").emit({ body: "queued before unload" });

    const dispatch = (event: string): void => {
      if (event === "pagehide") window.dispatchEvent(new Event(event));
      else document.dispatchEvent(new Event(event));
    };
    try {
      dispatch(firstEvent);
      await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledOnce());
      dispatch(firstEvent === "pagehide" ? "visibilitychange" : "pagehide");
      await Promise.resolve();

      const pageViews = exported.filter(
        (record) => record.attributes[ATTR_PAGE_VIEW_DURATION_SOURCE] === "page_hide",
      );
      expect(pageViews).toHaveLength(1);
      expect(pageViews[0].eventName).toBe(EVENT_BROWSER_PAGE_VIEW);
      expect(
        emit.mock.calls.filter(
          ([record]) => record.attributes[ATTR_PAGE_VIEW_DURATION_SOURCE] === "page_hide",
        ),
      ).toHaveLength(1);
      expect(isUnloading()).toBe(true);
      expect(flush).toHaveBeenCalledOnce();
    } finally {
      exporter.export.mockImplementation((_, callback) =>
        callback({ code: ExportResultCode.SUCCESS }),
      );
      finishExports.forEach((finish) => finish());
    }
  });

  it.each(["inactivityTimeout", "maxDuration"] as const)(
    "backs up the session renewed by a pending page view at the %s boundary",
    async (expiry) => {
      vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const previousId = "before-unload-session";
      localStorage.setItem(
        storageKey,
        JSON.stringify({ id: previousId, startTimestamp: now, lastActivityTimestamp: now }),
      );
      const exported: ReadableLogRecord[] = [];
      const exporter = {
        export: vi.fn((records: ReadableLogRecord[], callback: (result: ExportResult) => void) => {
          exported.push(...records);
          callback({ code: ExportResultCode.SUCCESS });
        }),
        async forceFlush() {},
        async shutdown() {},
      };
      const options = {
        cookieCfg: { enabled: false, disableCookieDefer: true },
        storage: { enabled: true },
        userContext: { enabled: false },
        session: { [expiry]: 1 },
        spanProcessors: [],
      };
      const processorOptions = {
        exporter,
        disableAutoFlushOnDocumentHide: true,
        scheduledDelayMillis: 60_000,
      } satisfies BatchLogRecordProcessorBrowserOptions;
      sdk = await useMicrosoftOpenTelemetry({
        ...options,
        logRecordProcessors: [new BatchLogRecordProcessor(processorOptions)],
      });
      expect(exported).toEqual([]);
      clock.mockReturnValue(now + 1000);
      window.dispatchEvent(new Event("pagehide"));
      await vi.waitFor(() => {
        expect(exporter.export).toHaveBeenCalledOnce();
        expect(isUnloading()).toBe(false);
      });

      expect(exported).toHaveLength(1);
      expect(exported[0].eventName).toBe(EVENT_BROWSER_PAGE_VIEW);
      expect(exported[0].attributes[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe("page_hide");
      const renewedId = exported[0].attributes["session.id"];
      expect(renewedId).toMatch(/^[0-9a-f]{32}$/);
      expect(renewedId).not.toBe(previousId);
      const backup = localStorage.getItem(storageKey)!;
      expect(JSON.parse(backup)).toEqual({
        id: renewedId,
        startTimestamp: now + 1000,
        lastActivityTimestamp: now + 1000,
      });

      await sdk.shutdown();
      sdk = undefined;
      // Reload from the unload snapshot, not a backup repaired by shutdown.
      localStorage.setItem(storageKey, backup);
      const processor = new RecordingProcessor();
      const emit = vi.spyOn(processor, "onEmit");
      sdk = await useMicrosoftOpenTelemetry({
        ...options,
        pageView: { enabled: false },
        logRecordProcessors: [processor],
      });
      logs.getLogger("reloaded-session").emit({ body: "after reload" });
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0][0]).toMatchObject({ attributes: { "session.id": renewedId } });
    },
  );

  it("exports the pending page view even when the session backup throws", async () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const exported: ReadableLogRecord[] = [];
    const exporter = {
      export: vi.fn((records: ReadableLogRecord[], callback: (result: ExportResult) => void) => {
        exported.push(...records);
        callback({ code: ExportResultCode.SUCCESS });
      }),
      async forceFlush() {},
      async shutdown() {},
    };
    const processorOptions = {
      exporter,
      disableAutoFlushOnDocumentHide: true,
      scheduledDelayMillis: 60_000,
    } satisfies BatchLogRecordProcessorBrowserOptions;
    sdk = await useMicrosoftOpenTelemetry({
      userContext: { enabled: false },
      spanProcessors: [],
      logRecordProcessors: [new BatchLogRecordProcessor(processorOptions)],
    });
    const failure = new Error("session backup failed");
    const error = vi.spyOn(diag, "error").mockImplementation(() => {});
    const session = vi.mocked(createSession).mock.results.at(-1)!.value;
    const backup = vi.spyOn(session, "backup").mockImplementation(() => {
      throw failure;
    });
    try {
      window.dispatchEvent(new Event("pagehide"));
      expect(backup).toHaveBeenCalledOnce();
    } finally {
      backup.mockRestore();
    }
    await vi.waitFor(() => {
      expect(exporter.export).toHaveBeenCalledOnce();
      expect(isUnloading()).toBe(false);
    });
    expect(exported).toHaveLength(1);
    expect(exported[0].eventName).toBe(EVENT_BROWSER_PAGE_VIEW);
    expect(exported[0].attributes[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe("page_hide");
    expect(error).toHaveBeenCalledWith("Session backup failed", failure);
  });

  it("settles on hidden visibility without creating a page view when the tab returns", async () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const processor = new RecordingProcessor();
    const flush = vi.spyOn(processor, "forceFlush");
    sdk = await useMicrosoftOpenTelemetry({
      spanProcessors: [],
      logRecordProcessors: [processor],
    });

    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(pageViewCount(processor)).toBe(0);
    expect(flush).not.toHaveBeenCalled();

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(isUnloading()).toBe(false));
    expect(pageViewCount(processor)).toBe(1);
    expect(flush).toHaveBeenCalledOnce();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("load"));
    await settle();
    expect(pageViewCount(processor)).toBe(1);
    expect(flush).toHaveBeenCalledOnce();

    await sdk.shutdown();
    sdk = undefined;
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(pageViewCount(processor)).toBe(1);
    expect(flush).toHaveBeenCalledOnce();
  });

  it("stops collecting after shutdown", async () => {
    const processor = new RecordingProcessor();
    sdk = await useMicrosoftOpenTelemetry({ logRecordProcessors: [processor] });

    await settle();
    await sdk.shutdown();
    sdk = undefined;
    const afterShutdown = pageViewCount(processor);

    history.pushState(null, "", "/after-shutdown");
    await settle();

    expect(pageViewCount(processor)).toBe(afterShutdown);
  });
});
