// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, isSpanContextValid, trace } from "@opentelemetry/api";
import type { LogRecord, Logger, LoggerProvider } from "@opentelemetry/api-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyValueStorage } from "../../../src/storage/keyValueStorage.js";
import { logToEnvelope } from "../../../src/exporter/logUtils.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";
import { createReadableLogRecord } from "../../fixtures/telemetry.js";
import {
  PageViewInstrumentation,
  type InternalPageViewInstrumentationConfig,
} from "../../../src/instrumentation/pageView/index.js";
import {
  ATTR_PAGE_VIEW_DURATION,
  ATTR_PAGE_VIEW_DURATION_SOURCE,
  ATTR_PAGE_VIEW_ID,
  ATTR_PAGE_VIEW_NAME,
  ATTR_URL_FULL,
  EVENT_BROWSER_PAGE_VIEW,
} from "../../../src/instrumentation/pageView/semconv.js";

/** Collects every log record the instrumentation emits. */
class RecordingLoggerProvider implements LoggerProvider {
  public readonly records: LogRecord[] = [];

  public getLogger(): Logger {
    return {
      enabled: () => true,
      emit: (record: LogRecord): void => {
        this.records.push(record);
      },
    };
  }
}

const originalUrl = location.href;
const originalTitle = document.title;
let active: PageViewInstrumentation | undefined;

function createInstrumentation(config: InternalPageViewInstrumentationConfig = {}): {
  instrumentation: PageViewInstrumentation;
  provider: RecordingLoggerProvider;
} {
  const provider = new RecordingLoggerProvider();
  const instrumentation = new PageViewInstrumentation({ enabled: false, ...config });
  instrumentation.setLoggerProvider(provider);
  active = instrumentation;
  return { instrumentation, provider };
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

function attributesOf(record: LogRecord): Record<string, unknown> {
  return (record.attributes ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  if (location.href !== originalUrl) {
    history.replaceState(null, "", originalUrl);
  }
  document.title = originalTitle;
});

afterEach(() => {
  active?.disable();
  active = undefined;
  if (location.href !== originalUrl) {
    history.replaceState(null, "", originalUrl);
  }
  document.title = originalTitle;
});

describe("PageViewInstrumentation", () => {
  describe("page visit time", () => {
    let now: number;
    let origin: number;

    function storageInMemory(): KeyValueStorage {
      const values = new Map<string, string>();
      return {
        getItem: vi.fn((key: string) => ({
          success: true as const,
          value: values.get(key) ?? null,
        })),
        setItem: vi.fn((key: string, value: string) => {
          values.set(key, value);
          return true;
        }),
        removeItem: vi.fn((key: string) => {
          values.delete(key);
          return true;
        }),
      };
    }

    function visits(provider: RecordingLoggerProvider): LogRecord[] {
      return provider.records.filter((record) => record.eventName === "browser.page_visit");
    }

    beforeEach(() => {
      origin = performance.timeOrigin;
      now = origin + 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([
        {
          startTime: 0,
          connectEnd: 20,
          requestStart: 30,
          responseStart: 80,
          responseEnd: 110,
          loadEventEnd: 170,
          type: "navigate",
        } as PerformanceNavigationTiming,
      ]);
    });

    afterEach(() => {
      active?.disable();
      vi.restoreAllMocks();
    });

    it("reports the previous name and URL at the next route start, not after load or settle", async () => {
      document.title = "Initial page";
      const { instrumentation, provider } = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: storageInMemory(),
        visitStorageKey: "visit.timing",
      });
      instrumentation.enable();
      const initial = instrumentation.pageViews.getCurrentPageView()!;
      await settle();
      expect(visits(provider)).toHaveLength(0);
      expect(attributesOf(provider.records[0] as LogRecord)[ATTR_PAGE_VIEW_DURATION]).toBe(170);

      now = origin + 5_000;
      history.pushState(null, "", "/visit-next");
      const next = instrumentation.pageViews.getCurrentPageView()!;
      // The visit is emitted synchronously before the successor has settled.
      expect(visits(provider)).toHaveLength(1);
      const firstVisit = visits(provider)[0] as LogRecord;
      expect(attributesOf(firstVisit)).toMatchObject({
        [ATTR_PAGE_VIEW_ID]: initial.id,
        [ATTR_PAGE_VIEW_NAME]: "Initial page",
        [ATTR_URL_FULL]: initial.url,
        "browser.page_visit.duration": 5_000,
      });
      expect(trace.getSpanContext(firstVisit.context ?? ROOT_CONTEXT)?.traceId).toBe(initial.id);

      document.title = "Final next page";
      now = origin + 7_000;
      await settle();
      expect(visits(provider)).toHaveLength(1);
      now = origin + 9_000;
      history.pushState(null, "", "/visit-third");

      expect(visits(provider)).toHaveLength(2);
      expect(attributesOf(visits(provider)[1] as LogRecord)).toMatchObject({
        [ATTR_PAGE_VIEW_ID]: next.id,
        [ATTR_PAGE_VIEW_NAME]: "Final next page",
        [ATTR_URL_FULL]: next.url,
        "browser.page_visit.duration": 4_000,
      });
    });

    it.each([undefined, false])(
      "does not touch visit storage or emit extra events when the option is %s",
      (autoTrackPageVisitTime) => {
        const storage = storageInMemory();
        const { instrumentation, provider } = createInstrumentation({
          ...(autoTrackPageVisitTime === undefined ? {} : { autoTrackPageVisitTime }),
          visitStorage: storage,
          visitStorageKey: "visit.disabled",
        });
        instrumentation.enable();
        history.pushState(null, "", "/visit-disabled");
        instrumentation.settleForUnload();
        window.dispatchEvent(new PageTransitionEvent("pagehide"));
        instrumentation.disable();

        expect(provider.records).toHaveLength(2);
        expect(
          provider.records.every((record) => record.eventName === EVENT_BROWSER_PAGE_VIEW),
        ).toBe(true);
        expect(storage.getItem).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();
      },
    );

    it("does not report a visit on settleForUnload, repeated pagehide, or disable", () => {
      const storage = storageInMemory();
      const { instrumentation, provider } = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: storage,
        visitStorageKey: "visit.unload",
      });
      instrumentation.enable();
      now = origin + 20_000;
      instrumentation.settleForUnload();
      instrumentation.settleForUnload();
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      instrumentation.disable();

      expect(visits(provider)).toHaveLength(0);
      expect(provider.records).toHaveLength(1);
      expect(attributesOf(provider.records[0] as LogRecord)[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe(
        "page_hide",
      );
      expect(storage.getItem("visit.unload")).toMatchObject({
        success: true,
        value: expect.any(String),
      });
    });

    it("ignores duplicate navigation signals and reports each rapid route exactly once", () => {
      const { instrumentation, provider } = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: null,
      });
      instrumentation.enable();
      const initial = instrumentation.pageViews.getCurrentPageView()!;
      now = origin + 2_000;
      history.pushState(null, "", "/visit-rapid-one");
      const first = instrumentation.pageViews.getCurrentPageView()!;
      history.replaceState({}, "", "/visit-rapid-one");
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      expect(visits(provider)).toHaveLength(1);

      now = origin + 2_001;
      history.pushState(null, "", "/visit-rapid-two");
      const second = instrumentation.pageViews.getCurrentPageView()!;
      history.pushState(null, "", "/visit-rapid-three");
      instrumentation.settleForUnload();
      expect(
        visits(provider).map((record) => [
          attributesOf(record)[ATTR_PAGE_VIEW_ID],
          attributesOf(record)["browser.page_visit.duration"],
        ]),
      ).toEqual([
        [initial.id, 2_000],
        [first.id, 1],
        [second.id, 0],
      ]);
    });

    it("uses explicit finalized names without resetting visit start time", () => {
      const { instrumentation, provider } = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: null,
      });
      instrumentation.enable();
      now = origin + 3_000;
      instrumentation.setPageName("Final checkout name");
      instrumentation.settleForUnload();
      now = origin + 8_000;
      history.pushState(null, "", "/after-checkout");

      expect(visits(provider)).toHaveLength(1);
      expect(attributesOf(visits(provider)[0] as LogRecord)).toMatchObject({
        [ATTR_PAGE_VIEW_NAME]: "Final checkout name",
        "browser.page_visit.duration": 8_000,
      });
    });

    it("keeps pathname-only sanitized URLs identical on page views and in-memory visits", async () => {
      history.replaceState(null, "", "/secure?token=private-token&visible=true");
      const storage = storageInMemory();
      const sanitizeUrl = vi.fn((url: string) => new URL(url).pathname);
      const { instrumentation, provider } = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: storage,
        visitStorageKey: "visit.pathname",
        sanitizeUrl,
      });
      instrumentation.enable();
      await settle();

      const previous = provider.records.find(
        (record) => record.eventName === EVENT_BROWSER_PAGE_VIEW,
      )!;
      expect(attributesOf(previous)[ATTR_URL_FULL]).toBe("/secure");
      expect(sanitizeUrl).toHaveBeenCalledWith(
        `${location.origin}/secure?token=REDACTED&visible=true`,
      );
      expect(storage.getItem("visit.pathname")).toEqual({
        success: true,
        value: JSON.stringify({
          id: attributesOf(previous)[ATTR_PAGE_VIEW_ID],
          name: attributesOf(previous)[ATTR_PAGE_VIEW_NAME],
          url: "/secure",
          startTimeUnixMs: origin,
        }),
      });

      now = origin + 5_000;
      history.pushState(null, "", "/after-secure");

      expect(visits(provider)).toHaveLength(1);
      expect(attributesOf(visits(provider)[0] as LogRecord)).toMatchObject({
        [ATTR_PAGE_VIEW_ID]: attributesOf(previous)[ATTR_PAGE_VIEW_ID],
        [ATTR_URL_FULL]: "/secure",
      });
      expect(JSON.stringify(provider.records.map(attributesOf))).not.toContain("private-token");
    });

    it.each([false, true])(
      "does not rerun a non-idempotent URL hook for in-memory visits or disable (persistence=%s)",
      async (persist) => {
        history.replaceState(null, "", "/secure");
        const sanitizeUrl = vi.fn((url: string) => {
          const parsed = new URL(url);
          parsed.pathname += "/sanitized";
          return parsed.href;
        });
        const sanitizerCallsAtVisit: number[] = [];
        const { instrumentation, provider } = createInstrumentation({
          autoTrackPageVisitTime: true,
          visitStorage: persist ? storageInMemory() : null,
          visitStorageKey: "visit.non-idempotent",
          sanitizeUrl,
          applyCustomLogRecordData: (record) => {
            if (record.eventName === "browser.page_visit") {
              sanitizerCallsAtVisit.push(sanitizeUrl.mock.calls.length);
            }
          },
        });
        instrumentation.enable();
        await settle();
        const previous = provider.records.find(
          (record) => record.eventName === EVENT_BROWSER_PAGE_VIEW,
        )!;
        const previousUrl = attributesOf(previous)[ATTR_URL_FULL];
        expect(previousUrl).toBe(`${location.origin}/secure/sanitized`);
        sanitizeUrl.mockClear();

        now = origin + 5_000;
        history.pushState(null, "", "/after-secure");

        expect(visits(provider)).toHaveLength(1);
        expect(attributesOf(visits(provider)[0] as LogRecord)[ATTR_URL_FULL]).toBe(previousUrl);
        // Only the successor URL and its raw referrer need sanitizing, not the previous visit.
        expect(sanitizerCallsAtVisit).toEqual([2]);
        expect(sanitizeUrl).toHaveBeenCalledTimes(2);

        instrumentation.disable();
        expect(sanitizeUrl).toHaveBeenCalledTimes(2);
        expect(visits(provider)).toHaveLength(1);
      },
    );

    it("retains a persisted pathname-only previous URL with an absolute-URL sanitizer", () => {
      const storage = storageInMemory();
      storage.setItem(
        "visit.restored-pathname",
        JSON.stringify({
          id: "1".repeat(32),
          name: "Previous secure page",
          url: "/secure",
          startTimeUnixMs: origin - 4_000,
        }),
      );
      const sanitizeUrl = vi.fn((url: string) => new URL(url).pathname);
      const { instrumentation, provider } = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: storage,
        visitStorageKey: "visit.restored-pathname",
        sanitizeUrl,
      });

      instrumentation.enable();

      expect(visits(provider)).toHaveLength(1);
      expect(attributesOf(visits(provider)[0] as LogRecord)).toMatchObject({
        [ATTR_PAGE_VIEW_ID]: "1".repeat(32),
        [ATTR_PAGE_VIEW_NAME]: "Previous secure page",
        [ATTR_URL_FULL]: "/secure",
        "browser.page_visit.duration": 4_000,
      });
      expect(sanitizeUrl).toHaveBeenCalledWith(`${location.origin}/secure`);
    });

    it.each([false, true])(
      "reports a restored document sharing the current trace ID (managed startup=%s)",
      (managed) => {
        const storage = storageInMemory();
        const id = "1".repeat(32);
        storage.setItem(
          "visit.same-trace",
          JSON.stringify({
            id,
            name: "Previous document",
            url: "https://example.test/previous",
            startTimeUnixMs: origin - 4_000,
          }),
        );
        const { instrumentation, provider } = createInstrumentation({
          autoTrackPageVisitTime: true,
          generatePageViewId: () => id,
          visitStorage: storage,
          visitStorageKey: "visit.same-trace",
        });
        if (managed) instrumentation.beginStartup();

        instrumentation.enable();

        expect(instrumentation.pageViews.getCurrentPageView()?.id).toBe(id);
        expect(visits(provider)).toHaveLength(managed ? 0 : 1);
        instrumentation.commitStartup();
        instrumentation.commitStartup();
        instrumentation.rollbackStartup();
        expect(visits(provider)).toHaveLength(1);
        expect(attributesOf(visits(provider)[0] as LogRecord)).toMatchObject({
          [ATTR_PAGE_VIEW_ID]: id,
          [ATTR_PAGE_VIEW_NAME]: "Previous document",
          "browser.page_visit.duration": 4_000,
        });
        instrumentation.disable();
        expect(storage.getItem("visit.same-trace")).toEqual({ success: true, value: null });
      },
    );

    it.each(["rollbackStartup", "disable"] as const)(
      "%s restores an unreported predecessor for a managed startup retry",
      (cleanup) => {
        const storage = storageInMemory();
        const key = "visit.startup-retry";
        const previous = {
          id: "1".repeat(32),
          name: "Previous document",
          url: "https://example.test/previous",
          startTimeUnixMs: origin - 4_000,
        };
        const saved = JSON.stringify(previous);
        storage.setItem(key, saved);
        const config = {
          autoTrackPageVisitTime: true,
          visitStorage: storage,
          visitStorageKey: key,
        };
        const first = createInstrumentation(config);
        first.instrumentation.beginStartup();
        first.instrumentation.enable();
        expect(visits(first.provider)).toEqual([]);

        first.instrumentation[cleanup]();
        first.instrumentation.disable();
        first.instrumentation.commitStartup();

        expect(visits(first.provider)).toEqual([]);
        expect(storage.getItem(key)).toEqual({ success: true, value: saved });
        const retry = createInstrumentation(config);
        retry.instrumentation.beginStartup();
        retry.instrumentation.enable();
        expect(visits(retry.provider)).toEqual([]);
        retry.instrumentation.commitStartup();
        expect(visits(retry.provider)).toHaveLength(1);
        expect(attributesOf(visits(retry.provider)[0] as LogRecord)).toMatchObject({
          [ATTR_PAGE_VIEW_ID]: previous.id,
          "browser.page_visit.duration": 4_000,
        });
      },
    );

    it.each([false, true])(
      "resolves and redacts untrusted relative stored URLs before custom sanitization (custom=%s)",
      (custom) => {
        history.replaceState(null, "", "/restore-current");
        const storage = storageInMemory();
        storage.setItem(
          "visit.relative-redaction",
          JSON.stringify({
            id: "1".repeat(32),
            name: "Previous relative page",
            url: "?token=private-token&visible=true#access_token=private-fragment",
            startTimeUnixMs: origin - 4_000,
          }),
        );
        const sanitizeUrl = vi.fn((url: string) => new URL(url).pathname);
        const { instrumentation, provider } = createInstrumentation({
          autoTrackPageVisitTime: true,
          visitStorage: storage,
          visitStorageKey: "visit.relative-redaction",
          ...(custom ? { sanitizeUrl } : {}),
        });

        instrumentation.enable();

        const redactedUrl =
          `${location.origin}/restore-current?token=REDACTED&visible=true` +
          "#access_token=REDACTED";
        expect(visits(provider)).toHaveLength(1);
        expect(attributesOf(visits(provider)[0] as LogRecord)).toMatchObject({
          [ATTR_PAGE_VIEW_NAME]: "Previous relative page",
          [ATTR_URL_FULL]: custom ? "/restore-current" : redactedUrl,
          "browser.page_visit.duration": 4_000,
        });
        if (custom) expect(sanitizeUrl).toHaveBeenCalledWith(redactedUrl);
        expect(JSON.stringify(visits(provider).map(attributesOf))).not.toContain("private-");
      },
    );

    it.each([false, true])(
      "maps automatic visits to the previous operation without a synthetic parent (restored=%s)",
      (restored) => {
        const storage = storageInMemory();
        let previousId = "1".repeat(32);
        if (restored) {
          storage.setItem(
            "visit.synthetic-context",
            JSON.stringify({
              id: previousId,
              name: "Previous document",
              url: "https://example.test/previous",
              startTimeUnixMs: origin - 4_000,
            }),
          );
        }
        const { instrumentation, provider } = createInstrumentation({
          autoTrackPageVisitTime: true,
          visitStorage: storage,
          visitStorageKey: "visit.synthetic-context",
        });
        instrumentation.enable();
        if (!restored) {
          previousId = instrumentation.pageViews.getCurrentPageView()!.id;
          now = origin + 5_000;
          history.pushState(null, "", "/visit-next-operation");
        }

        expect(visits(provider)).toHaveLength(1);
        const record = visits(provider)[0] as LogRecord;
        const spanContext = trace.getSpanContext(record.context ?? ROOT_CONTEXT);
        expect(isSpanContextValid(spanContext!)).toBe(true);
        expect(spanContext?.traceId).toBe(previousId);
        expect(instrumentation.pageViews.getCurrentPageView()?.id).not.toBe(previousId);
        // Preserve the emitted context object: only the instrumentation can mark it synthetic.
        const envelope = logToEnvelope(
          createReadableLogRecord({
            eventName: record.eventName,
            attributes: record.attributes ?? {},
            spanContext,
          }),
          TEST_INSTRUMENTATION_KEY,
        );

        expect(envelope.data).toMatchObject({
          baseType: "MetricData",
          baseData: { metrics: [{ name: "PageVisitTime" }] },
        });
        expect(envelope.tags["ai.operation.id"]).toBe(previousId);
        expect(envelope.tags).not.toHaveProperty("ai.operation.parentId");
      },
    );

    it.each([false, true])("sanitizes persisted previous URLs (custom sanitizer=%s)", (custom) => {
      const storage = storageInMemory();
      storage.setItem(
        "visit.redaction",
        JSON.stringify({
          id: "1".repeat(32),
          name: "Previous document",
          url: "https://private-user:private-password@example.test/previous?token=private-token#access_token=private-fragment",
          startTimeUnixMs: origin - 4_000,
        }),
      );
      const { instrumentation, provider } = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: storage,
        visitStorageKey: "visit.redaction",
        ...(custom
          ? {
              sanitizeUrl: (url: string) => {
                const parsed = new URL(url);
                return `${parsed.origin}${parsed.pathname}`;
              },
            }
          : {}),
      });
      instrumentation.enable();

      expect(visits(provider)).toHaveLength(1);
      const attributes = attributesOf(visits(provider)[0] as LogRecord);
      expect(attributes).toMatchObject({
        [ATTR_PAGE_VIEW_NAME]: "Previous document",
        "browser.page_visit.duration": 4_000,
      });
      expect(attributes[ATTR_URL_FULL]).toBe(
        custom
          ? "https://example.test/previous"
          : "https://REDACTED:REDACTED@example.test/previous?token=REDACTED#access_token=REDACTED",
      );
      expect(JSON.stringify(attributes)).not.toContain("private-");
    });

    it("drops persisted previous URLs when the sanitizer fails", () => {
      const storage = storageInMemory();
      storage.setItem(
        "visit.redaction-failed",
        JSON.stringify({
          id: "1".repeat(32),
          name: "Previous document",
          url: "https://example.test/secret?token=private-token",
          startTimeUnixMs: origin - 4_000,
        }),
      );
      const { instrumentation, provider } = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: storage,
        visitStorageKey: "visit.redaction-failed",
        sanitizeUrl: () => {
          throw new Error("Sanitizer unavailable");
        },
      });
      instrumentation.enable();

      expect(visits(provider)).toHaveLength(1);
      expect(attributesOf(visits(provider)[0] as LogRecord)).not.toHaveProperty(ATTR_URL_FULL);
      expect(JSON.stringify(visits(provider).map(attributesOf))).not.toContain("private-token");
    });

    it("does not replay an in-memory ghost visit after BFCache when storage is null", () => {
      const { instrumentation, provider } = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: null,
      });
      instrumentation.enable();
      const initial = instrumentation.pageViews.getCurrentPageView()!;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      now = origin + 10_000;
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      const restored = instrumentation.pageViews.getCurrentPageView()!;
      expect(restored.id).not.toBe(initial.id);
      expect(visits(provider)).toHaveLength(0);
      now = origin + 12_000;
      history.pushState(null, "", "/after-visit-restore");

      expect(visits(provider)).toHaveLength(1);
      expect(attributesOf(visits(provider)[0] as LogRecord)).toMatchObject({
        [ATTR_PAGE_VIEW_ID]: restored.id,
        "browser.page_visit.duration": 2_000,
      });
    });

    it("isolates multiple instrumentations using separate injected storage keys", () => {
      const storage = storageInMemory();
      const first = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: storage,
        visitStorageKey: "visit.first",
        routeResolver: () => "First instance",
      });
      const second = createInstrumentation({
        autoTrackPageVisitTime: true,
        visitStorage: storage,
        visitStorageKey: "visit.second",
        routeResolver: () => "Second instance",
      });
      try {
        first.instrumentation.enable();
        second.instrumentation.enable();
        const firstPage = first.instrumentation.pageViews.getCurrentPageView()!;
        const secondPage = second.instrumentation.pageViews.getCurrentPageView()!;
        now = origin + 5_000;
        history.pushState(null, "", "/visit-both");
        expect(visits(first.provider)).toHaveLength(1);
        expect(visits(second.provider)).toHaveLength(1);
        expect(attributesOf(visits(first.provider)[0] as LogRecord)).toMatchObject({
          [ATTR_PAGE_VIEW_ID]: firstPage.id,
          [ATTR_PAGE_VIEW_NAME]: "First instance",
          "browser.page_visit.duration": 5_000,
        });
        expect(attributesOf(visits(second.provider)[0] as LogRecord)).toMatchObject({
          [ATTR_PAGE_VIEW_ID]: secondPage.id,
          [ATTR_PAGE_VIEW_NAME]: "Second instance",
          "browser.page_visit.duration": 5_000,
        });
        second.instrumentation.disable();
        expect(storage.getItem("visit.second")).toEqual({ success: true, value: null });
        expect(storage.getItem("visit.first")).toMatchObject({
          success: true,
          value: expect.any(String),
        });
        now = origin + 8_000;
        history.pushState(null, "", "/visit-first-only");
        expect(visits(first.provider)).toHaveLength(2);
        expect(visits(second.provider)).toHaveLength(1);
        expect(
          attributesOf(visits(first.provider)[1] as LogRecord)["browser.page_visit.duration"],
        ).toBe(3_000);
      } finally {
        // Disable in reverse wrapping order, including when an assertion fails.
        second.instrumentation.disable();
        first.instrumentation.disable();
      }
    });
  });
});
