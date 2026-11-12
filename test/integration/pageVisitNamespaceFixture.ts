// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMicrosoftOpenTelemetry } from "../../src/useMicrosoftOpenTelemetry.js";

interface RecordedLog {
  eventName?: string;
  attributes: Record<string, unknown>;
  traceId?: string;
}

export interface PageVisitNamespaceSnapshot {
  records: RecordedLog[];
  storage: Record<string, string>;
  pageStart: number;
  storageOwner: string | null;
  applicationState: string | null;
  windowName: string;
  hasOpener: boolean;
}

declare global {
  interface Window {
    startPageVisitNamespaceFixture(): Promise<void>;
    pageVisitNamespaceFixture: {
      snapshot(): PageVisitNamespaceSnapshot;
      navigate(): Promise<void>;
      shutdown(): Promise<void>;
    };
  }
}

async function start(): Promise<void> {
  const parameters = new URL(location.href).searchParams;
  document.title = parameters.get("pageName") ?? "First document";
  const connectionString =
    `InstrumentationKey=${parameters.get("instrumentationKey") ?? "00000000-0000-0000-0000-000000000000"};` +
    `IngestionEndpoint=${location.origin}/page-visit-namespace-ingestion/${parameters.get("destination") ?? "default"}`;
  const records: RecordedLog[] = [];
  let pageStart: number | undefined;
  let onPageView: (() => void) | undefined;
  const nextPageView = () =>
    new Promise<void>((resolve) => {
      onPageView = resolve;
    });
  const initialPageView = nextPageView();
  const telemetry = await useMicrosoftOpenTelemetry({
    azureMonitor: {
      // Leave deferred strings unresolved: namespace selection must not wait for a destination.
      connectionString:
        parameters.get("connectionString") === "promise"
          ? new Promise<string>(() => {})
          : connectionString,
    },
    storage: { namePrefix: parameters.get("namePrefix") ?? "" },
    session: { enabled: false },
    userContext: { enabled: false },
    spanProcessors: [],
    logRecordProcessors: [
      {
        onEmit(record) {
          records.push({
            eventName: record.eventName,
            attributes: { ...record.attributes },
            traceId: record.spanContext?.traceId,
          });
          if (record.eventName === "browser.page_view") {
            // Use the initial page view's captured timestamp, not repeated privacy-rounded
            // timeOrigin reads, which can differ within one document in WebKit.
            pageStart ??= record.hrTime[0] * 1_000 + record.hrTime[1] / 1_000_000;
            onPageView?.();
          }
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    pageView: {
      autoTrackPageVisitTime: true,
      routeResolver: () => document.title,
      softNavigationSettleTimeoutMs: 100,
    },
  });
  await initialPageView;
  window.pageVisitNamespaceFixture = {
    snapshot: () => ({
      records: structuredClone(records),
      storage: Object.fromEntries(
        Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)!)
          .filter((key) => key.startsWith("otel.pageVisit."))
          .sort()
          .map((key) => [key, sessionStorage.getItem(key)!]),
      ),
      pageStart: pageStart!,
      storageOwner: sessionStorage.getItem("otel.pageVisitOwner"),
      applicationState: sessionStorage.getItem("pageVisitNamespace.application"),
      windowName: window.name,
      hasOpener: window.opener !== null,
    }),
    async navigate() {
      const settled = nextPageView();
      document.title += " SPA";
      history.pushState(null, "", `${location.href}#spa`);
      await settled;
    },
    shutdown: () => telemetry.shutdown(),
  };
  document.body.dataset.state = "ready";
}

window.startPageVisitNamespaceFixture = () =>
  start().catch((error: unknown) => {
    document.body.dataset.state = `failed: ${String(error)}`;
  });
if (new URL(location.href).searchParams.has("deferStart")) {
  document.body.dataset.state = "waiting";
} else {
  void window.startPageVisitNamespaceFixture();
}
