// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import type { PageVisitNamespaceSnapshot } from "./pageVisitNamespaceFixture.js";

function fixture(pageName: string, parameters: Record<string, string> = {}): string {
  const url = new URL("./pageVisitNamespaceFixture.html", import.meta.url);
  url.search = new URLSearchParams({ pageName, ...parameters }).toString();
  return url.href;
}

function visits(snapshot: PageVisitNamespaceSnapshot) {
  return snapshot.records.filter((record) => record.eventName === "browser.page_visit");
}

function expectPreviousVisit(
  previous: PageVisitNamespaceSnapshot,
  next: PageVisitNamespaceSnapshot,
) {
  const pageView = previous.records.find((record) => record.eventName === "browser.page_view")!;
  expect(visits(next)).toHaveLength(1);
  expect(visits(next)[0]).toMatchObject({
    traceId: pageView.traceId,
    attributes: {
      "browser.page_view.id": pageView.attributes["browser.page_view.id"],
      "browser.page_view.name": pageView.attributes["browser.page_view.name"],
      "url.full": pageView.attributes["url.full"],
      "browser.page_visit.duration": expect.any(Number),
    },
  });
  expect(visits(next)[0].attributes["browser.page_visit.duration"]).toBeCloseTo(
    next.pageStart - previous.pageStart,
    3,
  );
}

describe("page visit persistence namespaces in real browsing contexts", () => {
  it.each([
    { namePrefix: undefined, connectionString: "string", navigateOpenerBeforeStart: false },
    {
      namePrefix: "popup-destination-",
      connectionString: "promise",
      navigateOpenerBeforeStart: false,
    },
    { namePrefix: undefined, connectionString: "string", navigateOpenerBeforeStart: true },
    {
      namePrefix: "popup-destination-",
      connectionString: "promise",
      navigateOpenerBeforeStart: true,
    },
  ])(
    "rejects copied opener visits but preserves popup handoffs (%j)",
    async (scenario) => {
      const parameters = {
        connectionString: scenario.connectionString,
        ...(scenario.namePrefix === undefined ? {} : { namePrefix: scenario.namePrefix }),
      };
      const { documents, popup } = await commands.inspectPageVisitNamespaces(
        [fixture("Opener document", parameters), fixture("Next opener document", parameters)],
        {
          urls: [
            fixture("Popup document", parameters),
            fixture("Next popup document", parameters),
            fixture("Next popup document", parameters),
          ],
          navigateOpenerBeforeStart: scenario.navigateOpenerBeforeStart,
        },
      );

      expect(visits(documents[0])).toEqual([]);
      expect(popup).toBeDefined();
      // Prove the browser copied the live opener's predecessor before the SDK started.
      expect(popup!.copiedStorage).toMatchObject(documents[0].storage);
      expect(visits(popup!.documents[0])).toEqual([]);
      expect(popup!.documents[0].hasOpener).toBe(true);
      expect(popup!.documents[0].storageOwner).toBeTruthy();
      expect(popup!.documents[0].storageOwner).not.toBe(documents[0].storageOwner);
      expect(popup!.openerAfterStart).toEqual(
        documents[scenario.navigateOpenerBeforeStart ? 1 : 0],
      );
      expectPreviousVisit(documents[0], documents[1]);
      expect(documents[1].storageOwner).toBe(documents[0].storageOwner);
      for (const [index, document] of popup!.documents.entries()) {
        expect(document.storageOwner).toBe(popup!.documents[0].storageOwner);
        expect(document.applicationState).toBe("preserved");
        expect(document.windowName).toBe("page-visit-popup");
        expect(Object.keys(document.storage)).toEqual(Object.keys(documents[0].storage));
        if (index > 0) expectPreviousVisit(popup!.documents[index - 1], document);
      }
    },
    30_000,
  );

  it.each(["closed", "cross-origin"] as const)(
    "preserves established popup ownership when its opener becomes %s",
    async (openerAfterStart) => {
      const { documents, popup } = await commands.inspectPageVisitNamespaces(
        [fixture("Opener document")],
        {
          urls: [fixture("Popup document"), fixture("Next popup document")],
          openerAfterStart,
        },
      );

      expect(visits(popup!.documents[0])).toEqual([]);
      expect(popup!.openerAfterStart).toEqual(documents[0]);
      expect(popup!.documents[1].storageOwner).toBe(popup!.documents[0].storageOwner);
      expectPreviousVisit(popup!.documents[0], popup!.documents[1]);
    },
    30_000,
  );

  it.each([
    ["string", "promise"],
    ["promise", "string"],
  ])("bridges %s -> %s documents with one destination-specific prefix", async (first, second) => {
    const namePrefix = `namespace-${crypto.randomUUID()}-`;
    const { documents } = await commands.inspectPageVisitNamespaces([
      fixture("First document", { namePrefix, connectionString: first }),
      fixture("Second document", { namePrefix, connectionString: second }),
      fixture("Third document", { namePrefix, connectionString: first }),
    ]);

    expect(visits(documents[0])).toEqual([]);
    const keys = Object.keys(documents[0].storage);
    expect(keys).toHaveLength(1);
    for (const [index, document] of documents.entries()) {
      expect(Object.keys(document.storage)).toEqual(keys);
      if (index > 0) expectPreviousVisit(documents[index - 1], document);
    }
  });

  it("bridges alternating instrumentation key casing without an explicit prefix", async () => {
    const instrumentationKey = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
    const { documents } = await commands.inspectPageVisitNamespaces(
      [
        instrumentationKey,
        instrumentationKey.toLowerCase(),
        instrumentationKey,
        instrumentationKey.toLowerCase(),
      ].map((instrumentationKey, index) =>
        fixture(`Document ${index + 1}`, { instrumentationKey }),
      ),
    );

    expect(documents).toHaveLength(4);
    expect(visits(documents[0])).toEqual([]);
    const keys = Object.keys(documents[0].storage);
    expect(keys).toHaveLength(1);
    for (const [index, document] of documents.entries()) {
      expect(Object.keys(document.storage)).toEqual(keys);
      if (index > 0) expectPreviousVisit(documents[index - 1], document);
    }
  });

  it("isolates ingestion endpoint paths differing only in case with the same instrumentation key", async () => {
    const instrumentationKey = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const { documents } = await commands.inspectPageVisitNamespaces(
      ["Destination", "destination", "Destination", "destination"].map((destination, index) =>
        fixture(`Document ${index + 1}`, { instrumentationKey, destination }),
      ),
    );

    expect(documents).toHaveLength(4);
    expect(visits(documents[0])).toEqual([]);
    expect(visits(documents[1])).toEqual([]);
    expect(Object.keys(documents[0].storage)).toHaveLength(1);
    const keys = Object.keys(documents[1].storage);
    expect(keys).toHaveLength(2);
    for (const [key, value] of Object.entries(documents[0].storage)) {
      expect(documents[1].storage[key]).toBe(value);
    }
    expect(Object.keys(documents[2].storage)).toEqual(keys);
    expect(Object.keys(documents[3].storage)).toEqual(keys);
    expectPreviousVisit(documents[0], documents[2]);
    expectPreviousVisit(documents[1], documents[3]);
  });

  it.each(["prefix", "instrumentation key", "ingestion endpoint"])(
    "keeps different %s namespaces isolated across documents",
    async (difference) => {
      const first: Record<string, string> =
        difference === "prefix" ? { namePrefix: "destination-one-" } : {};
      const other: Record<string, string> =
        difference === "prefix"
          ? { namePrefix: "destination-two-" }
          : difference === "instrumentation key"
            ? { instrumentationKey: "11111111-1111-1111-1111-111111111111" }
            : { destination: "other-endpoint" };
      const { documents } = await commands.inspectPageVisitNamespaces([
        fixture("First destination", first),
        fixture("Other namespace", other),
        fixture("First destination again", first),
      ]);

      expect(visits(documents[0])).toEqual([]);
      expect(visits(documents[1])).toEqual([]);
      expect(Object.keys(documents[0].storage)).toHaveLength(1);
      expect(Object.keys(documents[1].storage)).toHaveLength(2);
      for (const [key, value] of Object.entries(documents[0].storage)) {
        expect(documents[1].storage[key]).toBe(value);
      }
      expectPreviousVisit(documents[0], documents[2]);
    },
  );

  it.each([undefined, ""])(
    "does not let a deferred destination consume known state without a nonempty prefix (%s)",
    async (namePrefix) => {
      const { documents } = await commands.inspectPageVisitNamespaces([
        fixture("Known destination"),
        fixture("Unknown destination", {
          connectionString: "promise",
          ...(namePrefix === undefined ? {} : { namePrefix }),
        }),
        fixture("Known destination again"),
      ]);

      expect(Object.keys(documents[0].storage)).toHaveLength(1);
      expect(visits(documents[1])).toEqual([]);
      expect(documents[1].storage).toEqual(documents[0].storage);
      expectPreviousVisit(documents[0], documents[2]);
    },
  );

  it.each([undefined, "shared-destination-"])(
    "keeps a concurrent same-origin iframe memory-only with parent/child prefix=%s",
    async (namePrefix) => {
      const parameters: Record<string, string> = namePrefix === undefined ? {} : { namePrefix };
      const { documents, frame } = await commands.inspectPageVisitNamespaces(
        [fixture("Parent document", parameters), fixture("Next parent document", parameters)],
        fixture("Child document", parameters),
      );

      expect(Object.keys(documents[0].storage)).toHaveLength(1);
      expect(visits(documents[0])).toEqual([]);
      expect(frame).toBeDefined();
      for (const parent of [
        frame!.parentAfterStart,
        frame!.parentAfterNavigation,
        frame!.parentAfterReload,
        frame!.parentAfterShutdown,
      ]) {
        expect(parent).toEqual(documents[0]);
      }
      for (const child of [frame!.initial, frame!.navigated, frame!.reloaded]) {
        expect(child.storage).toEqual(documents[0].storage);
      }
      expect(visits(frame!.initial)).toEqual([]);
      expect(visits(frame!.reloaded)).toEqual([]);
      const childPage = frame!.initial.records.find(
        (record) => record.eventName === "browser.page_view",
      )!;
      expect(visits(frame!.navigated)).toHaveLength(1);
      expect(visits(frame!.navigated)[0]).toMatchObject({
        traceId: childPage.traceId,
        attributes: {
          "browser.page_view.name": "Child document",
          "url.full": childPage.attributes["url.full"],
          "browser.page_visit.duration": expect.any(Number),
        },
      });
      expectPreviousVisit(documents[0], documents[1]);
    },
    30_000,
  );
});
