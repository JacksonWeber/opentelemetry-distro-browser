// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { commands } from "vitest/browser";
import { expect, inject, it } from "vitest";

interface PageResult {
  traceId: string;
  parentId: string;
  routeId: string;
  fetchHeaders: { traceparent: string; tracestate?: string };
  xhrHeaders: { traceparent: string; tracestate?: string };
  serverTiming: string[];
}

interface Envelope {
  tags: Record<string, string>;
  data: {
    baseType: string;
    baseData: { id?: string; name?: string; properties?: Record<string, unknown> };
  };
}

it.each([
  ...["meta", "header", "both", "invalid", "missing", "opt-out"].map((scenario) => ({
    scenario,
    hash: "",
    lateHash: "",
  })),
  ...["meta", "header"].flatMap((scenario) => [
    { scenario, hash: "#/home", lateHash: "" },
    { scenario, hash: "#/home", lateHash: "#/checkout" },
    { scenario, hash: "", lateHash: "#/checkout" },
  ]),
])(
  "correlates a served document and real fetch/XHR calls ($scenario, hash=$hash, lateHash=$lateHash)",
  async ({ scenario, hash, lateHash }) => {
    const runId = crypto.randomUUID();
    const ingestionOrigin = new URL(inject("ingestionEndpoint")).origin;
    const pageUrl = new URL("/server-trace.html", inject("cdnPageOrigin"));
    pageUrl.hash = hash;
    if (lateHash) pageUrl.searchParams.set("lateHash", lateHash);
    pageUrl.searchParams.set("scenario", scenario);
    pageUrl.searchParams.set("ingestionEndpoint", `${inject("ingestionEndpoint")}${runId}`);
    pageUrl.searchParams.set(
      "requestEndpoint",
      new URL("/headers", inject("redirectEndpoint")).href,
    );
    const { state, diagnostics } = await commands.loadSnippetPage(pageUrl.href);
    expect(state, diagnostics.join("\n")).not.toMatch(/^failed:/);
    const result = JSON.parse(state) as PageResult;
    const continued = ["meta", "header", "both"].includes(scenario) && !lateHash;
    const expectedTrace = scenario === "header" ? "3".repeat(32) : "1".repeat(32);
    const expectedParent = scenario === "header" ? "4".repeat(16) : "2".repeat(16);
    if (continued) {
      expect(result.traceId).toBe(expectedTrace);
      expect(result.parentId).toBe(expectedParent);
    } else {
      expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(result.traceId).not.toBe("1".repeat(32));
      expect(result.traceId).not.toBe("3".repeat(32));
    }
    if (["header", "both", "invalid"].includes(scenario)) {
      expect(result.serverTiming).toEqual(["traceparent", "tracestate"]);
    }
    expect(result.routeId).not.toBe(result.traceId);

    const response = await fetch(`${ingestionOrigin}/captured?runId=${runId}`);
    const envelopes = (await response.json()) as Envelope[];
    const pageViews = envelopes.filter((envelope) => envelope.data.baseType === "PageViewData");
    expect(
      pageViews.filter((envelope) => envelope.tags["ai.operation.id"] === result.traceId),
    ).toHaveLength(2);
    expect(
      pageViews.filter((envelope) => envelope.tags["ai.operation.id"] === result.routeId),
    ).toHaveLength(2);
    const initial = envelopes.filter(
      (envelope) => envelope.tags["ai.operation.id"] === result.traceId,
    );
    expect(initial.some((envelope) => envelope.data.baseType === "MessageData")).toBe(true);
    for (const envelope of initial) {
      expect(envelope.tags["ai.operation.parentId"]).toBe(continued ? expectedParent : undefined);
    }
    for (const headers of [result.fetchHeaders, result.xhrHeaders]) {
      const [, requestTraceId, requestSpanId] = headers.traceparent.split("-");
      expect(requestTraceId).toBe(result.traceId);
      expect(headers.tracestate).toBe(
        continued ? (scenario === "header" ? "header=state" : "meta=state") : undefined,
      );
      expect(
        initial.some(
          (envelope) =>
            envelope.data.baseType === "RemoteDependencyData" &&
            envelope.data.baseData.id === requestSpanId,
        ),
      ).toBe(true);
    }
    for (const envelope of envelopes.filter(
      (record) => record.tags["ai.operation.id"] === result.routeId,
    )) {
      expect(envelope.tags).not.toHaveProperty("ai.operation.parentId");
    }
  },
);
