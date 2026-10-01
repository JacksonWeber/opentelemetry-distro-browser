// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  SeverityNumber,
  type LogRecord,
  type Logger,
  type LoggerProvider,
} from "@opentelemetry/api-logs";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { BrowserInstrumentation } from "../../../src/types.js";
import {
  createPageViewContext,
  generatePageViewId,
  PAGE_VIEW_INSTRUMENTATION_NAME,
  PageViewInstrumentation,
  type PageView,
  type InternalPageViewInstrumentationConfig,
} from "../../../src/instrumentation/pageView/index.js";
import {
  ATTR_PAGE_VIEW_DURATION,
  ATTR_PAGE_VIEW_DURATION_SOURCE,
  ATTR_PAGE_VIEW_ID,
  ATTR_PAGE_VIEW_INDEX,
  ATTR_PAGE_VIEW_NAME,
  ATTR_PAGE_VIEW_NAME_SOURCE,
  ATTR_PAGE_VIEW_REFERRER,
  ATTR_PAGE_VIEW_SAME_DOCUMENT,
  ATTR_PAGE_VIEW_TYPE,
  ATTR_URL_FULL,
  EVENT_BROWSER_PAGE_VIEW,
} from "../../../src/instrumentation/pageView/semconv.js";

/** Collects every log record the instrumentation emits. */
class RecordingLoggerProvider implements LoggerProvider {
  public readonly records: LogRecord[] = [];
  public readonly scopes: string[] = [];

  public getLogger(name: string): Logger {
    this.scopes.push(name);
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
  history.replaceState(null, "", originalUrl);
  document.title = originalTitle;
});

afterEach(() => {
  active?.disable();
  active = undefined;
  history.replaceState(null, "", originalUrl);
  document.title = originalTitle;
});

describe("PageViewInstrumentation", () => {
  describe("instrumentation contract", () => {
    it("satisfies the distribution's registration contract", () => {
      const { instrumentation } = createInstrumentation();

      // `useMicrosoftOpenTelemetry` accepts instrumentations through this structural contract, so
      // a consumer must be able to hand this class straight to it.
      expectTypeOf(instrumentation).toExtend<BrowserInstrumentation>();
      const registered: BrowserInstrumentation = instrumentation;
      expect(registered.getConfig().enabled).toBe(false);
    });

    it("reports a distribution-owned scope and does not patch on construction", () => {
      const pushStateBefore = history.pushState;
      const { instrumentation } = createInstrumentation();

      expect(instrumentation.instrumentationName).toBe(PAGE_VIEW_INSTRUMENTATION_NAME);
      expect(instrumentation.instrumentationName).not.toContain("applicationinsights");
      expect(history.pushState).toBe(pushStateBefore);
    });

    it("patches history on enable and restores it on disable", () => {
      const pushStateBefore = history.pushState;
      const replaceStateBefore = history.replaceState;
      const { instrumentation } = createInstrumentation();

      instrumentation.enable();
      expect(history.pushState).not.toBe(pushStateBefore);
      expect(history.replaceState).not.toBe(replaceStateBefore);

      instrumentation.disable();
      expect(history.pushState).toBe(pushStateBefore);
      expect(history.replaceState).toBe(replaceStateBefore);
    });

    it("is idempotent across repeated enable and disable calls", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      instrumentation.enable();
      await settle();
      const afterEnable = provider.records.length;

      instrumentation.disable();
      instrumentation.disable();

      expect(afterEnable).toBe(1);
      expect(() => {
        instrumentation.enable();
      }).not.toThrow();
    });
  });

  describe("document load", () => {
    it("emits one record with a browser-reported duration", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();

      expect(provider.records).toHaveLength(1);
      const [record] = provider.records;
      const attributes = attributesOf(record as LogRecord);

      expect(record?.eventName).toBe(EVENT_BROWSER_PAGE_VIEW);
      expect(record?.severityNumber).toBe(SeverityNumber.INFO);
      expect(attributes[ATTR_PAGE_VIEW_SAME_DOCUMENT]).toBe(false);
      expect(attributes[ATTR_PAGE_VIEW_INDEX]).toBe(0);
      expect(attributes[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe("navigation_timing");
      expect(attributes[ATTR_PAGE_VIEW_DURATION]).toBeGreaterThan(0);
      expect(attributes[ATTR_URL_FULL]).toBe(location.href);
    });

    it("always sets a navigation type, unlike upstream browser.navigation", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();

      const attributes = attributesOf(provider.records[0] as LogRecord);
      expect(attributes[ATTR_PAGE_VIEW_TYPE]).toBeDefined();
      expect(["navigate", "reload", "back_forward", "prerender"]).toContain(
        attributes[ATTR_PAGE_VIEW_TYPE],
      );
    });

    it("timestamps the record at navigation start, not at emit time", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();

      const timestamp = provider.records[0]?.timestamp as number;
      expect(timestamp).toBeGreaterThan(0);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
      // Within a second of the browser's own reported navigation start.
      expect(Math.abs(timestamp - performance.timeOrigin)).toBeLessThan(1000);
    });
  });

  describe("name resolution", () => {
    it("prefers an explicit name over every other source", async () => {
      const { instrumentation, provider } = createInstrumentation({
        routeResolver: () => "/orders/:id",
      });

      instrumentation.setPageName("Checkout");
      instrumentation.enable();
      await settle();

      const attributes = attributesOf(provider.records[0] as LogRecord);
      expect(attributes[ATTR_PAGE_VIEW_NAME]).toBe("Checkout");
      expect(attributes[ATTR_PAGE_VIEW_NAME_SOURCE]).toBe("explicit");
    });

    it("prefers a route pattern over the document title", async () => {
      document.title = "Some Title";
      const { instrumentation, provider } = createInstrumentation({
        routeResolver: () => "/orders/:id",
      });

      instrumentation.enable();
      await settle();

      const attributes = attributesOf(provider.records[0] as LogRecord);
      expect(attributes[ATTR_PAGE_VIEW_NAME]).toBe("/orders/:id");
      expect(attributes[ATTR_PAGE_VIEW_NAME_SOURCE]).toBe("route");
    });

    it("falls through to the document title when the route resolver returns undefined", async () => {
      document.title = "Dashboard";
      const { instrumentation, provider } = createInstrumentation({
        routeResolver: () => undefined,
      });

      instrumentation.enable();
      await settle();

      const attributes = attributesOf(provider.records[0] as LogRecord);
      expect(attributes[ATTR_PAGE_VIEW_NAME]).toBe("Dashboard");
      expect(attributes[ATTR_PAGE_VIEW_NAME_SOURCE]).toBe("document_title");
    });

    it("falls through to the pathname when there is no title", async () => {
      document.title = "";
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();

      const attributes = attributesOf(provider.records[0] as LogRecord);
      expect(attributes[ATTR_PAGE_VIEW_NAME]).toBe(location.pathname);
      expect(attributes[ATTR_PAGE_VIEW_NAME_SOURCE]).toBe("url_path");
    });

    it("does not let a throwing route resolver break the page view", async () => {
      document.title = "Fallback Title";
      const { instrumentation, provider } = createInstrumentation({
        routeResolver: () => {
          throw new Error("router exploded");
        },
      });

      expect(() => {
        instrumentation.enable();
      }).not.toThrow();
      await settle();

      const attributes = attributesOf(provider.records[0] as LogRecord);
      expect(attributes[ATTR_PAGE_VIEW_NAME]).toBe("Fallback Title");
      expect(attributes[ATTR_PAGE_VIEW_NAME_SOURCE]).toBe("document_title");
    });

    it("always emits a name source alongside the name", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      history.pushState(null, "", "/first");
      await settle();

      expect(provider.records.length).toBeGreaterThan(0);
      for (const record of provider.records) {
        const attributes = attributesOf(record);
        expect(attributes[ATTR_PAGE_VIEW_NAME]).toBeDefined();
        expect(attributes[ATTR_PAGE_VIEW_NAME_SOURCE]).toBeDefined();
      }
    });
  });

  describe("soft navigation", () => {
    it("emits a record per pushState route change", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      history.pushState(null, "", "/orders/42");
      await settle();

      expect(provider.records).toHaveLength(1);
      const attributes = attributesOf(provider.records[0] as LogRecord);
      expect(attributes[ATTR_PAGE_VIEW_SAME_DOCUMENT]).toBe(true);
      expect(attributes[ATTR_PAGE_VIEW_TYPE]).toBe("push");
      expect(attributes[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe("soft_navigation_settled");
      expect(String(attributes[ATTR_URL_FULL])).toContain("/orders/42");
    });

    it("distinguishes replaceState from pushState", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      history.replaceState(null, "", "/replaced");
      await settle();

      expect(attributesOf(provider.records[0] as LogRecord)[ATTR_PAGE_VIEW_TYPE]).toBe("replace");
    });

    it("ignores a history call that does not change the URL", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      history.pushState(null, "", location.href);
      await settle();

      expect(provider.records).toHaveLength(0);
    });

    it("increments the page-view index across a journey", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      history.pushState(null, "", "/step-1");
      await settle();
      history.pushState(null, "", "/step-2");
      await settle();

      expect(provider.records.map((record) => attributesOf(record)[ATTR_PAGE_VIEW_INDEX])).toEqual([
        0, 1, 2,
      ]);
    });

    it("records the previous in-document URL as the referrer", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      const firstUrl = location.href;
      provider.records.length = 0;

      history.pushState(null, "", "/next");
      await settle();

      expect(attributesOf(provider.records[0] as LogRecord)[ATTR_PAGE_VIEW_REFERRER]).toBe(
        firstUrl,
      );
    });

    it("emits exactly one truncated record when a navigation is superseded", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      // Two route changes in the same task: the first never gets to settle.
      history.pushState(null, "", "/a");
      history.pushState(null, "", "/b");
      await settle();

      expect(provider.records).toHaveLength(2);
      const [first, second] = provider.records;
      expect(attributesOf(first as LogRecord)[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe(
        "soft_navigation_interrupted",
      );
      expect(attributesOf(second as LogRecord)[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe(
        "soft_navigation_settled",
      );
      expect(String(attributesOf(second as LogRecord)[ATTR_URL_FULL])).toContain("/b");
    });

    it("never emits more than one record for one navigation", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      history.pushState(null, "", "/single");
      await settle();
      await settle();
      await settle();

      expect(provider.records).toHaveLength(1);
    });

    it("treats a new hash navigation as a push, matching the Navigation API", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      location.hash = "#section-2";
      await settle();

      expect(provider.records).toHaveLength(1);
      expect(attributesOf(provider.records[0] as LogRecord)[ATTR_PAGE_VIEW_TYPE]).toBe("push");
    });

    it("treats a traversal back to a hash entry as a traversal", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      // Traversing fires popstate first and hashchange second; the first starts the page view and
      // the second is discarded as a duplicate, so the classification comes from popstate.
      history.pushState(null, "", "#hash-a");
      await settle();
      provider.records.length = 0;
      history.back();
      await settle();

      expect(attributesOf(provider.records[0] as LogRecord)[ATTR_PAGE_VIEW_TYPE]).toBe("traverse");
    });
  });

  describe("duration", () => {
    it("caps a soft navigation that never settles", async () => {
      const { instrumentation, provider } = createInstrumentation({
        softNavigationSettleTimeoutMs: 40,
      });

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      // Block the main thread past the cap so the idle callback cannot run first.
      history.pushState(null, "", "/slow");
      const blockUntil = performance.now() + 150;
      while (performance.now() < blockUntil) {
        // Intentionally busy-wait to starve the settle path.
      }
      await settle();

      expect(provider.records).toHaveLength(1);
      const attributes = attributesOf(provider.records[0] as LogRecord);
      expect(attributes[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe("soft_navigation_capped");
      expect(attributes[ATTR_PAGE_VIEW_DURATION]).toBe(40);
    });

    it("never emits a negative duration", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      history.pushState(null, "", "/a");
      await settle();

      for (const record of provider.records) {
        expect(attributesOf(record)[ATTR_PAGE_VIEW_DURATION]).toBeGreaterThanOrEqual(0);
      }
    });

    it("labels every duration with its source", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      history.pushState(null, "", "/a");
      await settle();

      for (const record of provider.records) {
        expect(attributesOf(record)[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBeDefined();
      }
    });
  });

  describe("page-view id seam", () => {
    it("mints a distinct id per navigation", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      history.pushState(null, "", "/second");
      await settle();

      const ids = provider.records.map((record) => attributesOf(record)[ATTR_PAGE_VIEW_ID]);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-f]{32}$/);
      }
    });

    it("publishes the id before the record is emitted", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();

      // Still in flight: nothing emitted yet, but the id is already readable.
      const inFlight = instrumentation.pageViews.getCurrentPageView();
      expect(provider.records).toHaveLength(0);
      expect(inFlight?.id).toMatch(/^[0-9a-f]{32}$/);

      await settle();

      expect(attributesOf(provider.records[0] as LogRecord)[ATTR_PAGE_VIEW_ID]).toBe(inFlight?.id);
    });

    it("notifies subscribers and honours the unsubscribe handle", async () => {
      const { instrumentation } = createInstrumentation();
      const seen: PageView[] = [];

      const unsubscribe = instrumentation.pageViews.onPageViewChanged((pageView) => {
        seen.push(pageView);
      });

      instrumentation.enable();
      await settle();
      expect(seen).toHaveLength(1);

      history.pushState(null, "", "/watched");
      await settle();
      expect(seen).toHaveLength(2);

      unsubscribe();
      history.pushState(null, "", "/unwatched");
      await settle();
      expect(seen).toHaveLength(2);
    });

    it("shares one context with an externally constructed consumer", async () => {
      const pageViewContext = createPageViewContext();
      const { instrumentation, provider } = createInstrumentation({ pageViewContext });

      instrumentation.enable();
      await settle();

      expect(pageViewContext.getCurrentPageView()?.id).toBe(
        attributesOf(provider.records[0] as LogRecord)[ATTR_PAGE_VIEW_ID],
      );
    });

    it("keeps two instances isolated rather than sharing a module global", async () => {
      const first = createInstrumentation();
      const second = createInstrumentation();

      first.instrumentation.enable();
      second.instrumentation.enable();
      await settle();

      const firstId = first.instrumentation.pageViews.getCurrentPageView()?.id;
      const secondId = second.instrumentation.pageViews.getCurrentPageView()?.id;
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();
      expect(firstId).not.toBe(secondId);

      // Unwrap in reverse order of wrapping, or the outer patch is left installed.
      second.instrumentation.disable();
      first.instrumentation.disable();
      active = undefined;
    });

    it("uses an injected id generator", async () => {
      const generatePageViewIdMock = vi.fn(() => "deterministic-id");
      const { instrumentation, provider } = createInstrumentation({
        generatePageViewId: generatePageViewIdMock,
      });

      instrumentation.enable();
      await settle();

      expect(attributesOf(provider.records[0] as LogRecord)[ATTR_PAGE_VIEW_ID]).toBe(
        "deterministic-id",
      );
      expect(generatePageViewIdMock).toHaveBeenCalled();
    });

    it("generates unique ids of the expected shape", () => {
      const ids = new Set(Array.from({ length: 500 }, () => generatePageViewId()));
      expect(ids.size).toBe(500);
      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-f]{32}$/);
      }
    });
  });

  describe("configuration hooks", () => {
    it("sanitizes the URL and the referrer", async () => {
      const { instrumentation, provider } = createInstrumentation({
        sanitizeUrl: (url) => url.replace(/token=[^&]*/g, "token=REDACTED"),
      });

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      history.pushState(null, "", "/secure?token=supersecret");
      await settle();
      history.pushState(null, "", "/after");
      await settle();

      const secureRecord = attributesOf(provider.records[0] as LogRecord);
      expect(String(secureRecord[ATTR_URL_FULL])).toContain("token=REDACTED");
      expect(String(secureRecord[ATTR_URL_FULL])).not.toContain("supersecret");

      const afterRecord = attributesOf(provider.records[1] as LogRecord);
      expect(String(afterRecord[ATTR_PAGE_VIEW_REFERRER])).toContain("token=REDACTED");
      expect(String(afterRecord[ATTR_PAGE_VIEW_REFERRER])).not.toContain("supersecret");
    });

    it("applies the custom log record hook", async () => {
      const { instrumentation, provider } = createInstrumentation({
        applyCustomLogRecordData: (logRecord) => {
          logRecord.attributes = { ...logRecord.attributes, "app.tenant": "contoso" };
        },
      });

      instrumentation.enable();
      await settle();

      expect(attributesOf(provider.records[0] as LogRecord)["app.tenant"]).toBe("contoso");
    });

    it("does not let a throwing log record hook drop the record", async () => {
      const { instrumentation, provider } = createInstrumentation({
        applyCustomLogRecordData: () => {
          throw new Error("hook exploded");
        },
      });

      instrumentation.enable();
      await settle();

      expect(provider.records).toHaveLength(1);
    });
  });

  describe("shutdown", () => {
    it("drops an in-flight page view instead of emitting a truncated record", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      history.pushState(null, "", "/abandoned");
      instrumentation.disable();
      await settle();

      expect(provider.records).toHaveLength(0);
    });

    it("stops emitting after disable", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      instrumentation.disable();
      provider.records.length = 0;

      history.pushState(null, "", "/after-shutdown");
      await settle();

      expect(provider.records).toHaveLength(0);
    });

    it("leaves no pending cap timer that emits after disable", async () => {
      const { instrumentation, provider } = createInstrumentation({
        softNavigationSettleTimeoutMs: 20,
      });

      instrumentation.enable();
      await settle();
      provider.records.length = 0;

      history.pushState(null, "", "/pending");
      instrumentation.disable();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(provider.records).toHaveLength(0);
    });
  });

  describe("vendor neutrality", () => {
    it("emits no Application Insights field names", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      history.pushState(null, "", "/neutral");
      await settle();

      const serialized = JSON.stringify(provider.records);
      expect(serialized).not.toContain("operation_Id");
      expect(serialized).not.toContain("operation_ParentId");
      expect(serialized).not.toMatch(/"ai\./);
      for (const record of provider.records) {
        for (const key of Object.keys(attributesOf(record))) {
          expect(key).toMatch(/^(browser\.page_view\.|url\.full$)/);
        }
      }
    });

    it("emits events through the Logs API with a top-level eventName", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();

      for (const record of provider.records) {
        expect(record.eventName).toBe(EVENT_BROWSER_PAGE_VIEW);
        expect(attributesOf(record)["event.name"]).toBeUndefined();
      }
    });
  });

  describe("review regressions", () => {
    it("names a route change from the title the router sets after it", async () => {
      const { instrumentation, provider } = createInstrumentation();
      instrumentation.enable();
      await settle();
      const before = provider.records.length;

      // A router commits its route and title after the URL changes, so a name captured at the
      // start of the navigation would describe the previous page.
      history.pushState(null, "", "/probe-title");
      document.title = "Probe New Title";
      await settle();

      expect(attributesOf(provider.records.at(-1) as LogRecord)[ATTR_PAGE_VIEW_NAME]).toBe(
        "Probe New Title",
      );
      expect(provider.records.length).toBe(before + 1);
    });

    it("keeps page-view subscriptions across a disable and enable cycle", async () => {
      const { instrumentation } = createInstrumentation();
      const seen: string[] = [];
      instrumentation.pageViews.onPageViewChanged((pv) => seen.push(pv.id));

      instrumentation.enable();
      await settle();
      instrumentation.disable();
      instrumentation.enable();
      history.pushState(null, "", "/after-reenable");
      await settle();

      expect(seen.length).toBe(2);
    });

    it("does not report the document load twice when re-enabled", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      instrumentation.disable();
      instrumentation.enable();
      await settle();

      const documentRecords = provider.records.filter(
        (record) => attributesOf(record)[ATTR_PAGE_VIEW_SAME_DOCUMENT] === false,
      );
      expect(documentRecords.length).toBe(1);

      history.pushState(null, "", "/index-after-reenable");
      await settle();
      const indices = provider.records.map((record) => attributesOf(record)[ATTR_PAGE_VIEW_INDEX]);
      expect(new Set(indices).size).toBe(indices.length);
    });

    it("gives an interrupted page view its own name, not its successor's", async () => {
      const { instrumentation, provider } = createInstrumentation({
        routeResolver: () => location.pathname,
      });

      instrumentation.enable();
      await settle();
      history.pushState(null, "", "/first");
      // Interrupts before /first can settle, so /first is emitted from the /second handler.
      history.pushState(null, "", "/second");
      await settle();

      const interrupted = provider.records.find(
        (record) =>
          attributesOf(record)[ATTR_PAGE_VIEW_DURATION_SOURCE] === "soft_navigation_interrupted",
      );
      expect(attributesOf(interrupted as LogRecord)[ATTR_PAGE_VIEW_NAME]).toBe("/first");
    });

    it("keeps the title its router set on a page view interrupted before it settled", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      const before = provider.records.length;

      history.pushState(null, "", "/orders");
      // The router renders and titles /orders, then the user leaves before it can settle.
      document.title = "Orders";
      history.pushState(null, "", "/checkout");
      await settle();

      const interrupted = provider.records
        .slice(before)
        .find(
          (record) =>
            attributesOf(record)[ATTR_PAGE_VIEW_DURATION_SOURCE] === "soft_navigation_interrupted",
        );
      expect(attributesOf(interrupted as LogRecord)[ATTR_PAGE_VIEW_NAME]).toBe("Orders");
    });

    it("never lets a throwing hook escape into the application's pushState", async () => {
      const { instrumentation, provider } = createInstrumentation({
        sanitizeUrl: () => {
          throw new Error("sanitize exploded");
        },
        generatePageViewId: () => {
          throw new Error("id exploded");
        },
      });

      instrumentation.enable();
      await settle();

      expect(() => history.pushState(null, "", "/throwing-hooks")).not.toThrow();
      await settle();

      const record = provider.records.at(-1) as LogRecord;
      // The URL is dropped, not reported raw: see the sanitizer-failure test below.
      expect(attributesOf(record)).not.toHaveProperty(ATTR_URL_FULL);
      expect(attributesOf(record)[ATTR_PAGE_VIEW_ID]).toMatch(/^[0-9a-f]{32}$/);
    });

    it("survives a throwing log pipeline without breaking navigation", async () => {
      const instrumentation = new PageViewInstrumentation({ enabled: false });
      active = instrumentation;
      instrumentation.setLoggerProvider({
        getLogger: () => ({
          enabled: () => true,
          emit: () => {
            throw new Error("exporter exploded");
          },
        }),
      });

      instrumentation.enable();
      await settle();
      // Two rapid route changes: the second settles the first *synchronously* inside pushState,
      // which is the only path where a throwing exporter can reach the application.
      history.pushState(null, "", "/throwing-exporter-a");
      expect(() => history.pushState(null, "", "/throwing-exporter")).not.toThrow();
      await settle();
      expect(instrumentation.pageViews.getCurrentPageView()?.url).toContain("/throwing-exporter");
    });

    it("constructs and observes with default options", async () => {
      // `InstrumentationBase` enables from its own constructor, before subclass fields exist.
      const provider = new RecordingLoggerProvider();
      const instrumentation = new PageViewInstrumentation();
      active = instrumentation;
      instrumentation.setLoggerProvider(provider);

      expect(instrumentation.pageViews.getCurrentPageView()).toBeDefined();
      await settle();
      history.pushState(null, "", "/default-options");
      await settle();

      const soft = provider.records.at(-1);
      expect(attributesOf(soft as LogRecord)[ATTR_PAGE_VIEW_SAME_DOCUMENT]).toBe(true);
    });

    it("still emits when the page name is set after the navigation begins", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      const before = provider.records.length;

      history.pushState(null, "", "/late-name");
      instrumentation.setPageName("Checkout");
      await settle();

      expect(provider.records.length).toBe(before + 1);
      const record = provider.records.at(-1) as LogRecord;
      expect(attributesOf(record)[ATTR_PAGE_VIEW_NAME]).toBe("Checkout");
      expect(attributesOf(record)[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe("soft_navigation_settled");
    });

    it("does not give a soft navigation the document load duration", async () => {
      const { instrumentation, provider } = createInstrumentation();

      // Starts a soft navigation before the scheduled document-load finalization runs.
      instrumentation.enable();
      history.pushState(null, "", "/before-load-settles");
      await settle();

      expect(provider.records.length).toBe(2);
      const [documentView, softView] = provider.records as [LogRecord, LogRecord];
      expect(attributesOf(documentView)[ATTR_PAGE_VIEW_SAME_DOCUMENT]).toBe(false);
      expect(attributesOf(softView)[ATTR_PAGE_VIEW_SAME_DOCUMENT]).toBe(true);
      expect(attributesOf(softView)[ATTR_PAGE_VIEW_DURATION_SOURCE]).not.toBe("navigation_timing");
      expect(attributesOf(softView)[ATTR_PAGE_VIEW_DURATION]).toBeLessThan(
        attributesOf(documentView)[ATTR_PAGE_VIEW_DURATION] as number,
      );
    });

    it("drops the URL rather than reporting it raw when the sanitizer throws", async () => {
      const { instrumentation, provider } = createInstrumentation({
        sanitizeUrl: () => {
          throw new Error("sanitizer failed");
        },
      });

      instrumentation.enable();
      history.pushState(null, "", "/secret?token=leaked-value");
      await settle();

      expect(provider.records.length).toBeGreaterThan(0);
      for (const record of provider.records) {
        expect(attributesOf(record)).not.toHaveProperty(ATTR_URL_FULL);
      }
      expect(JSON.stringify(provider.records)).not.toContain("leaked-value");
    });

    it("reports no referrer on a back/forward cache restore", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      const before = provider.records.length;

      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      await settle();

      // `document.referrer` is frozen at the original load, so carrying it here would claim a
      // fresh arrival from a site the user did not just come from.
      const restored = attributesOf(provider.records[before] as LogRecord);
      expect(restored[ATTR_PAGE_VIEW_TYPE]).toBe("back_forward");
      expect(restored).not.toHaveProperty(ATTR_PAGE_VIEW_REFERRER);
    });

    it("starts a new page view with a new id when restored from the back/forward cache", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      const before = provider.records.length;
      const firstId = attributesOf(provider.records[before - 1] as LogRecord)[ATTR_PAGE_VIEW_ID];

      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      await settle();

      expect(provider.records.length).toBe(before + 1);
      const restored = attributesOf(provider.records[before] as LogRecord);
      expect(restored[ATTR_PAGE_VIEW_ID]).not.toBe(firstId);
      expect(restored[ATTR_PAGE_VIEW_TYPE]).toBe("back_forward");
      expect(restored[ATTR_PAGE_VIEW_DURATION_SOURCE]).toBe("bfcache_restore_settled");
      expect(instrumentation.pageViews.getCurrentPageView()?.id).toBe(restored[ATTR_PAGE_VIEW_ID]);
    });

    it("ignores a pageshow that is not a back/forward cache restore", async () => {
      const { instrumentation, provider } = createInstrumentation();

      instrumentation.enable();
      await settle();
      const before = provider.records.length;

      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
      await settle();

      expect(provider.records.length).toBe(before);
    });

    it("keeps another instance's history wrapper installed when this one is disabled", async () => {
      const first = createInstrumentation();
      const second = createInstrumentation();

      first.instrumentation.enable();
      second.instrumentation.enable();
      await settle();
      const secondBefore = second.provider.records.length;

      // Disabling the instance that wrapped first must not tear the second instance's wrapper off
      // the shared `history` object.
      first.instrumentation.disable();
      history.pushState(null, "", "/after-first-disabled");
      await settle();

      try {
        expect(second.provider.records.length).toBe(secondBefore + 1);
        expect(
          attributesOf(second.provider.records[secondBefore] as LogRecord)[
            ATTR_PAGE_VIEW_SAME_DOCUMENT
          ],
        ).toBe(true);
      } finally {
        second.instrumentation.disable();
      }
    });
  });
});
