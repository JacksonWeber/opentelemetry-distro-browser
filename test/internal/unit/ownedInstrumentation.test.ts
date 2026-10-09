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
  history.replaceState(null, "", originalUrl);
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
  history.replaceState(null, "", originalUrl);
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
