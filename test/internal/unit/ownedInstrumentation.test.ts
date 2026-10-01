// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { logs } from "@opentelemetry/api-logs";
import { context, diag, propagation, trace } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import { EVENT_BROWSER_PAGE_VIEW } from "../../../src/instrumentation/pageView/semconv.js";
import type { MicrosoftOpenTelemetryBrowser } from "../../../src/types.js";

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
    await settle();

    expect(pageViewCount(processor)).toBe(2);
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
