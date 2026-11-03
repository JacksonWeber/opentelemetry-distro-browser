// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { commands } from "vitest/browser";
import { expect, inject, it } from "vitest";

const openSnippetPage = async (
  scenario: "valid" | "configured" | "tampered" | "missing" | "reported",
) => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${encodeURIComponent(runId)}`;
  const pageUrl = new URL("/snippet.html", inject("cdnPageOrigin"));
  pageUrl.searchParams.set("ingestionEndpoint", ingestionEndpoint);
  pageUrl.searchParams.set("runId", runId);
  pageUrl.searchParams.set("scenario", scenario);
  const result = await commands.loadSnippetPage(pageUrl.href);
  const captureUrl = `${new URL(ingestionEndpoint).origin}/captured?runId=${encodeURIComponent(runId)}`;
  return { ...result, runId, captureUrl };
};

interface CapturedEnvelope {
  name?: string;
  tags?: Record<string, string>;
}

async function waitForEnvelopes(
  captureUrl: string,
  isComplete: (envelopes: CapturedEnvelope[]) => boolean,
): Promise<unknown[]> {
  const deadline = Date.now() + 5_000;
  let envelopes: CapturedEnvelope[] = [];
  do {
    envelopes = (await fetch(captureUrl).then((response) => response.json())) as typeof envelopes;
    if (isComplete(envelopes)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return envelopes;
}

it("loads the CDN bundle into a plain HTML page under CSP and sends page view, span, fetch and XHR telemetry", async () => {
  const { state, diagnostics, runId, captureUrl } = await openSnippetPage("valid");

  expect(state, diagnostics.join("\n")).toBe("ready");
  expect(diagnostics.filter((line) => /Content Security Policy|CSP/i.test(line))).toEqual([]);
  const envelopes = await waitForEnvelopes(
    captureUrl,
    (captured) =>
      captured.some(({ name }) => name === "Microsoft.ApplicationInsights.PageView") &&
      captured.filter(({ name }) => name === "Microsoft.ApplicationInsights.RemoteDependency")
        .length >= 3,
  );
  const httpDependency = (runIdQuery: string) =>
    expect.objectContaining({
      name: "Microsoft.ApplicationInsights.RemoteDependency",
      data: expect.objectContaining({
        baseData: expect.objectContaining({
          name: "GET /captured",
          type: "Http",
          data: expect.stringContaining(`/captured?runId=${runIdQuery}`),
        }),
      }),
    });
  expect(envelopes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Microsoft.ApplicationInsights.PageView",
        data: expect.objectContaining({ baseType: "PageViewData" }),
      }),
      expect.objectContaining({
        name: "Microsoft.ApplicationInsights.RemoteDependency",
        data: expect.objectContaining({
          baseData: expect.objectContaining({
            name: "cdn-snippet-span",
            properties: expect.objectContaining({ "test.run_id": runId }),
          }),
        }),
      }),
      httpDependency("snippet-fetch"),
      httpDependency("snippet-xhr"),
    ]),
  );
});

it("applies snippet configuration: opt-in instrumentations and resource attributes", async () => {
  const { state, diagnostics, captureUrl } = await openSnippetPage("configured");

  expect(state, diagnostics.join("\n")).toBe("ready");
  const envelopes = (await waitForEnvelopes(
    captureUrl,
    (captured) =>
      captured.some(({ name }) => name === "Microsoft.ApplicationInsights.Exception") &&
      captured.some(({ name }) => name === "Microsoft.ApplicationInsights.PageView"),
  )) as CapturedEnvelope[];
  expect(envelopes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Microsoft.ApplicationInsights.Exception",
        data: expect.objectContaining({
          baseData: expect.objectContaining({
            exceptions: [expect.objectContaining({ message: "cdn snippet failure" })],
          }),
        }),
      }),
    ]),
  );
  expect(envelopes.length).toBeGreaterThan(0);
  for (const envelope of envelopes) {
    expect(envelope.tags?.["ai.cloud.role"], envelope.name).toBe("cdn-snippet-service");
  }
});

it.each([
  ["an integrity mismatch", "tampered"],
  ["a missing bundle", "missing"],
] as const)("reports %s as an initialization failure", async (_label, scenario) => {
  const { state, captureUrl } = await openSnippetPage(scenario);

  expect(state).toMatch(/^failed: OpenTelemetry browser bundle failed to load: /);
  await expect(fetch(captureUrl).then((response) => response.json())).resolves.toEqual([]);
});

it("reports a missing bundle to Azure Monitor when reportLoadFailure is set", async () => {
  const { state, captureUrl } = await openSnippetPage("reported");

  expect(state).toMatch(/^failed: OpenTelemetry browser bundle failed to load: /);
  const envelopes = await waitForEnvelopes(captureUrl, (captured) => captured.length > 0);
  expect(envelopes).toEqual([
    expect.objectContaining({
      name: "Microsoft.ApplicationInsights.Exception",
      iKey: "00000000-0000-0000-0000-000000000000",
      data: expect.objectContaining({
        baseData: expect.objectContaining({
          exceptions: [
            expect.objectContaining({
              typeName: "SDKLoadFailed",
              message: expect.stringMatching(/failed to load: http:\/\/127\.0\.0\.1:\d+\/missing-/),
            }),
          ],
        }),
      }),
    }),
  ]);
});
