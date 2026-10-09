// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { commands } from "vitest/browser";
import { expect, inject, it } from "vitest";

const openSnippetPage = async (scenario: "valid" | "tampered" | "missing") => {
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

async function waitForEnvelopes(captureUrl: string, names: string[]): Promise<unknown[]> {
  const deadline = Date.now() + 5_000;
  let envelopes: { name?: string }[] = [];
  do {
    envelopes = (await fetch(captureUrl).then((response) => response.json())) as typeof envelopes;
    if (names.every((name) => envelopes.some((envelope) => envelope.name === name))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return envelopes;
}

it("loads the CDN bundle into a plain HTML page under CSP and sends Azure Monitor telemetry", async () => {
  const { state, diagnostics, runId, captureUrl } = await openSnippetPage("valid");

  expect(state, diagnostics.join("\n")).toBe("ready");
  expect(diagnostics.filter((line) => /Content Security Policy|CSP/i.test(line))).toEqual([]);
  const envelopes = await waitForEnvelopes(captureUrl, [
    "Microsoft.ApplicationInsights.PageView",
    "Microsoft.ApplicationInsights.RemoteDependency",
  ]);
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
    ]),
  );
});

it.each([
  ["an integrity mismatch", "tampered"],
  ["a missing bundle", "missing"],
] as const)("reports %s as an initialization failure", async (_label, scenario) => {
  const { state, captureUrl } = await openSnippetPage(scenario);

  expect(state).toMatch(/^failed: OpenTelemetry browser bundle failed to load: /);
  await expect(fetch(captureUrl).then((response) => response.json())).resolves.toEqual([]);
});
