// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { PageVisitTime } from "../../../src/instrumentation/pageView/pageVisitTime.js";
import type { PageView } from "../../../src/instrumentation/pageView/types.js";
import {
  createKeyValueStorage,
  type KeyValueStorage,
} from "../../../src/storage/keyValueStorage.js";

const key = "test.pageVisit";

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => ({ success: true as const, value: values.get(name) ?? null })),
    setItem: vi.fn((name: string, value: string) => {
      values.set(name, value);
      return true;
    }),
    removeItem: vi.fn((name: string) => {
      values.delete(name);
      return true;
    }),
  };
}

function page(ordinal: number, startTimeUnixMs: number): PageView {
  return {
    id: ordinal.toString(16).padStart(32, "0"),
    index: ordinal - 1,
    name: `Page ${ordinal}`,
    nameSource: "explicit",
    url: `https://example.test/page-${ordinal}`,
    referrer: "",
    navigationType: "navigate",
    sameDocument: false,
    startTimeUnixMs,
  };
}

function visitOf(value: PageView) {
  const { id, name, url, startTimeUnixMs } = value;
  return { id, name, url, startTimeUnixMs };
}

describe("PageVisitTime", () => {
  it("bridges two documents through shared storage and consumes each visit once", () => {
    const storage = memoryStorage();
    const firstReport = vi.fn();
    const secondReport = vi.fn();
    const first = new PageVisitTime(storage, key, firstReport);
    const second = new PageVisitTime(storage, key, secondReport);
    const initial = page(1, 1_000);
    const next = page(2, 8_000);

    first.start(initial);
    first.suspend();
    second.start(next);
    second.start(next);

    expect(firstReport).not.toHaveBeenCalled();
    expect(secondReport).toHaveBeenCalledExactlyOnceWith(visitOf(initial), 7_000);
    expect(storage.getItem(key)).toEqual({
      success: true,
      value: JSON.stringify(visitOf(next)),
    });
  });

  it.each([true, false])("times SPA visits from page starts with persistence=%s", (persist) => {
    const report = vi.fn();
    const tracker = new PageVisitTime(persist ? memoryStorage() : null, key, report);
    const initial = page(1, 1_000);
    const next = page(2, 6_000);

    tracker.start(initial);
    tracker.update({ ...initial, name: "Finalized initial name" });
    tracker.start(next);
    tracker.start(next);
    tracker.start(page(3, 6_000));
    tracker.start(page(4, 6_001));

    expect(report.mock.calls).toEqual([
      [{ ...visitOf(initial), name: "Finalized initial name" }, 5_000],
      [visitOf(next), 0],
      [visitOf(page(3, 6_000)), 1],
    ]);
  });

  it("persists finalized names without restarting the previous page's clock", () => {
    const storage = memoryStorage();
    const report = vi.fn();
    const first = new PageVisitTime(storage, key, vi.fn());
    const initial = page(1, 1_000);
    first.start(initial);
    first.update({ ...initial, name: "Final route name", nameSource: "route" });
    first.suspend();

    new PageVisitTime(storage, key, report).start(page(2, 9_000));

    expect(report).toHaveBeenCalledExactlyOnceWith(
      { ...visitOf(initial), name: "Final route name" },
      8_000,
    );
  });

  it.each([false, true])(
    "consumes the predecessor before invoking a re-entrant reporter (write failure=%s)",
    (writeFailure) => {
      const storage = memoryStorage();
      const next = page(2, 2_000);
      const report = vi.fn((): void => {
        expect(storage.getItem(key)).toEqual({
          success: true,
          value: writeFailure ? null : JSON.stringify(visitOf(next)),
        });
        tracker.start(next);
      });
      const tracker = new PageVisitTime(storage, key, report);
      tracker.start(page(1, 1_000));
      if (writeFailure) vi.mocked(storage.setItem).mockReturnValue(false);

      tracker.start(next);

      expect(report).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "reports separate occurrences with the same trace ID (restored=%s)",
    (restored) => {
      const storage = memoryStorage();
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      const initial = page(1, 1_000);
      const next = { ...initial, name: "Next document", startTimeUnixMs: 8_000 };
      if (restored) storage.setItem(key, JSON.stringify(visitOf(initial)));
      else tracker.start(initial);

      tracker.start(next);
      tracker.start({ ...next, name: "Final next document" });

      expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(initial), 7_000);
      expect(storage.getItem(key)).toEqual({
        success: true,
        value: JSON.stringify({ ...visitOf(next), name: "Final next document" }),
      });
      tracker.stop();
      expect(storage.getItem(key)).toEqual({ success: true, value: null });
    },
  );

  it.each([false, true])(
    "persists only the latest startup owner once before re-entrant reporting (suspended=%s)",
    (suspended) => {
      const storage = memoryStorage();
      const previous = page(1, 1_000);
      const saved = JSON.stringify(visitOf(previous));
      storage.setItem(key, saved);
      vi.mocked(storage.setItem).mockClear();
      const initial = { ...page(2, 2_000), name: "Final initial name" };
      const latest = { ...page(3, 5_000), name: "Final latest name" };
      const serialized = JSON.stringify(visitOf(latest));
      const report = vi.fn(() => {
        expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(key, serialized);
        expect(storage.getItem(key)).toEqual({ success: true, value: serialized });
        tracker.commitStartup();
        tracker.rollbackStartup();
      });
      const tracker = new PageVisitTime(storage, key, report);
      tracker.beginStartup();
      tracker.start(page(2, 2_000));
      tracker.update(initial);
      tracker.start(page(3, 5_000));
      tracker.update(latest);
      if (suspended) tracker.suspend();
      expect(report).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(storage.getItem(key)).toEqual({ success: true, value: saved });

      tracker.commitStartup();
      tracker.commitStartup();
      tracker.rollbackStartup();

      expect(report.mock.calls).toEqual([
        [visitOf(previous), 1_000],
        [visitOf(initial), 3_000],
      ]);
      expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(key, serialized);
      expect(storage.removeItem).not.toHaveBeenCalled();
      tracker.stop();
      expect(storage.getItem(key)).toEqual({
        success: true,
        value: suspended ? serialized : null,
      });
    },
  );

  it.each([false, true])(
    "leaves the unsanitized predecessor untouched after startup rollback (suspended=%s)",
    (suspended) => {
      const storage = memoryStorage();
      const previous = page(1, 1_000);
      const saved = JSON.stringify(visitOf(previous));
      storage.setItem(key, saved);
      vi.mocked(storage.setItem).mockClear();
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report, (url) => `${url}/sanitized`);
      tracker.beginStartup();
      tracker.start(page(2, 2_000));
      tracker.start(page(3, 3_000));
      if (suspended) tracker.suspend();

      tracker.rollbackStartup();
      tracker.rollbackStartup();
      tracker.stop();
      tracker.commitStartup();

      expect(report).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(storage.getItem(key)).toEqual({ success: true, value: saved });
      const retry = new PageVisitTime(storage, key, report, (url) => `${url}/sanitized`);
      retry.beginStartup();
      retry.start(page(4, 5_000));
      retry.commitStartup();
      expect(report).toHaveBeenCalledExactlyOnceWith(
        { ...visitOf(previous), url: `${previous.url}/sanitized` },
        4_000,
      );
    },
  );

  it("rolls back an uncommitted startup when stop is called directly", () => {
    const storage = memoryStorage();
    const previous = page(1, 1_000);
    const saved = JSON.stringify(visitOf(previous));
    storage.setItem(key, saved);
    const report = vi.fn();
    const tracker = new PageVisitTime(storage, key, report);
    tracker.beginStartup();
    tracker.start(page(2, 2_000));

    tracker.stop();
    tracker.commitStartup();

    expect(report).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toEqual({ success: true, value: saved });
  });

  it.each(["rollbackStartup", "stop"] as const)(
    "%s never attempts startup writes even when writes would fail and allows a retry",
    (cleanup) => {
      const storage = memoryStorage();
      const previous = page(1, 1_000);
      const saved = JSON.stringify(visitOf(previous));
      storage.setItem(key, saved);
      const write = vi.mocked(storage.setItem);
      const persist = write.getMockImplementation()!;
      write.mockClear().mockReturnValue(false);
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      tracker.beginStartup();
      tracker.start(page(2, 2_000));
      tracker.start(page(3, 3_000));
      tracker.update({ ...page(3, 3_000), name: "Final name" });

      expect(write).not.toHaveBeenCalled();
      expect(storage.getItem(key)).toEqual({ success: true, value: saved });
      tracker[cleanup]();
      tracker.commitStartup();
      expect(report).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(storage.getItem(key)).toEqual({ success: true, value: saved });

      write.mockImplementation(persist);
      tracker.beginStartup();
      const retry = page(4, 5_000);
      tracker.start(retry);
      tracker.commitStartup();
      expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(previous), 4_000);
      expect(storage.getItem(key)).toEqual({
        success: true,
        value: JSON.stringify(visitOf(retry)),
      });
      tracker.start(page(5, 8_000));
      expect(report.mock.calls).toEqual([
        [visitOf(previous), 4_000],
        [visitOf(retry), 3_000],
      ]);
    },
  );

  it.each(["rollbackStartup", "stop"] as const)(
    "%s avoids the short-write/later-quota sequence with the production storage adapter",
    (cleanup) => {
      const previous = page(1, 1_000);
      const saved = JSON.stringify(visitOf(previous), null, 2);
      const initial = page(2, 2_000);
      const large = { ...page(3, 3_000), name: "Large route name ".repeat(64) };
      const quotaBytes = Math.max(saved.length, JSON.stringify(visitOf(initial)).length) + 32;
      const values = new Map([[key, saved]]);
      const write = vi.fn((name: string, value: string) => {
        if (value.length > quotaBytes) {
          throw new DOMException("Visit storage full", "QuotaExceededError");
        }
        values.set(name, value);
      });
      const remove = vi.fn((name: string) => {
        values.delete(name);
      });
      vi.stubGlobal("sessionStorage", {
        getItem: (name: string) => values.get(name) ?? null,
        setItem: write,
        removeItem: remove,
      });
      try {
        const storage = createKeyValueStorage("sessionStorage", "Visit storage unavailable");
        const report = vi.fn();
        const tracker = new PageVisitTime(storage, key, report);
        tracker.beginStartup();
        tracker.start(initial);
        tracker.update({ ...initial, name: large.name });
        tracker.start(large);
        tracker.update({ ...large, name: `${large.name} finalized` });
        tracker.suspend();

        // The old short successful write followed by quota/backoff is prevented, not replayed.
        expect(JSON.stringify(visitOf(initial)).length).toBeLessThan(quotaBytes);
        expect(JSON.stringify(visitOf(large)).length).toBeGreaterThan(quotaBytes);
        expect(write).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(values.get(key)).toBe(saved);
        tracker[cleanup]();
        tracker.rollbackStartup();
        tracker.stop();
        tracker.commitStartup();

        expect(write).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(values.get(key)).toBe(saved);
        expect(report).not.toHaveBeenCalled();

        const retry = new PageVisitTime(storage, key, report);
        const next = page(4, 5_000);
        retry.beginStartup();
        retry.start(next);
        expect(write).not.toHaveBeenCalled();
        retry.commitStartup();
        retry.commitStartup();

        expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(previous), 4_000);
        expect(write).toHaveBeenCalledExactlyOnceWith(key, JSON.stringify(visitOf(next)));
        expect(values.get(key)).toBe(JSON.stringify(visitOf(next)));
        retry.start(page(5, 8_000));
        expect(report.mock.calls).toEqual([
          [visitOf(previous), 4_000],
          [visitOf(next), 3_000],
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("rolls back without writes and consumes the seed on retry under externally forced adapter backoff", () => {
    const previous = page(1, 1_000);
    const saved = JSON.stringify(visitOf(previous), null, 2);
    const values = new Map([[key, saved]]);
    const externalKey = "external-write";
    const nativeWrite = vi.fn((name: string, value: string) => {
      if (name === externalKey) {
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      values.set(name, value);
    });
    const remove = vi.fn((name: string) => {
      values.delete(name);
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    vi.stubGlobal("sessionStorage", {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: nativeWrite,
      removeItem: remove,
    });
    try {
      const storage = createKeyValueStorage("sessionStorage", "Visit storage unavailable");
      const write = vi.spyOn(storage, "setItem");
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      tracker.beginStartup();
      tracker.start(page(2, 2_000));
      tracker.update({ ...page(2, 2_000), name: "Final initial name" });
      expect(write).not.toHaveBeenCalled();
      expect(storage.setItem(externalKey, "force backoff")).toBe(false);
      tracker.start(page(3, 3_000));
      tracker.update({ ...page(3, 3_000), name: "Final later route name" });
      tracker.suspend();
      tracker.rollbackStartup();
      tracker.stop();
      tracker.commitStartup();

      expect(write).toHaveBeenCalledExactlyOnceWith(externalKey, "force backoff");
      expect(nativeWrite).toHaveBeenCalledExactlyOnceWith(externalKey, "force backoff");
      expect(remove).not.toHaveBeenCalled();
      expect(values.get(key)).toBe(saved);
      expect(report).not.toHaveBeenCalled();

      const retryReport = vi.fn(() => {
        // Removal bypasses write backoff, and must happen before application callbacks.
        expect(remove).toHaveBeenCalledExactlyOnceWith(key);
        expect(values.has(key)).toBe(false);
      });
      const retry = new PageVisitTime(storage, key, retryReport);
      const next = page(4, 5_000);
      retry.beginStartup();
      retry.start(next);
      expect(write).toHaveBeenCalledTimes(1);
      expect(values.get(key)).toBe(saved);
      retry.commitStartup();
      retry.commitStartup();

      expect(write.mock.calls).toEqual([
        [externalKey, "force backoff"],
        [key, JSON.stringify(visitOf(next))],
      ]);
      expect(write.mock.results.map((result) => result.value)).toEqual([false, false]);
      expect(nativeWrite).toHaveBeenCalledTimes(1);
      expect(retryReport).toHaveBeenCalledExactlyOnceWith(visitOf(previous), 4_000);
      expect(values.has(key)).toBe(false);
      new PageVisitTime(storage, key, retryReport).start(page(5, 8_000));
      expect(retryReport).toHaveBeenCalledTimes(1);
      expect(values.get(key)).toBe(JSON.stringify(visitOf(page(5, 8_000))));
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])(
    "does not replay a consumed predecessor after a failed write (managed=%s)",
    (managed) => {
      const storage = memoryStorage();
      const previous = page(1, 1_000);
      storage.setItem(key, JSON.stringify(visitOf(previous)));
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      const write = vi.mocked(storage.setItem).mockClear().mockReturnValueOnce(false);
      if (managed) tracker.beginStartup();
      tracker.start(page(2, 2_000));
      if (managed) {
        expect(write).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
        expect(storage.getItem(key)).toEqual({
          success: true,
          value: JSON.stringify(visitOf(previous)),
        });
        tracker.suspend();
        tracker.commitStartup();
      }

      expect(write).toHaveBeenCalledExactlyOnceWith(key, JSON.stringify(visitOf(page(2, 2_000))));
      expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(previous), 1_000);
      expect(storage.getItem(key)).toEqual({ success: true, value: null });
      const next = new PageVisitTime(storage, key, report);
      next.start(page(3, 3_000));
      expect(report).toHaveBeenCalledTimes(1);
      next.start(page(4, 4_000));
      expect(report.mock.calls).toEqual([
        [visitOf(previous), 1_000],
        [visitOf(page(3, 3_000)), 1_000],
      ]);
    },
  );

  it("consumes the original predecessor before reporting when the only commit write fails", () => {
    const storage = memoryStorage();
    const previous = page(1, 1_000);
    storage.setItem(key, JSON.stringify(visitOf(previous)));
    vi.mocked(storage.setItem).mockClear();
    const report = vi.fn(() => {
      expect(storage.getItem(key)).toEqual({ success: true, value: null });
      expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(key);
    });
    const tracker = new PageVisitTime(storage, key, report);
    tracker.beginStartup();
    tracker.start(page(2, 2_000));
    vi.mocked(storage.setItem).mockReturnValueOnce(false);
    tracker.start(page(3, 3_000));
    tracker.update({ ...page(3, 3_000), name: "Final route name" });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();

    tracker.commitStartup();
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      key,
      JSON.stringify({ ...visitOf(page(3, 3_000)), name: "Final route name" }),
    );
    tracker.commitStartup();
    new PageVisitTime(storage, key, report).start(page(4, 4_000));

    expect(report.mock.calls).toEqual([
      [visitOf(previous), 1_000],
      [visitOf(page(2, 2_000)), 1_000],
    ]);
  });

  it.each(["standalone", "before commit", "during commit", "rollback"] as const)(
    "preserves a newer owner with the original trace ID but a different start (%s)",
    (scenario) => {
      const storage = memoryStorage();
      storage.setItem(key, JSON.stringify(visitOf(page(1, 1_000))));
      const write = vi.mocked(storage.setItem);
      const persist = write.getMockImplementation()!;
      write.mockClear();
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      const successor = page(2, 2_000);
      const latest = page(3, 4_000);
      const newer = JSON.stringify({ ...visitOf(page(1, 1_000)), startTimeUnixMs: 5_000 });
      if (scenario !== "standalone") {
        tracker.beginStartup();
        tracker.start(successor);
        tracker.start(latest);
        expect(write).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();
      }
      if (scenario === "before commit" || scenario === "rollback") {
        persist(key, newer);
        write.mockReturnValueOnce(false);
      } else {
        write.mockImplementationOnce(() => {
          persist(key, newer);
          return false;
        });
      }

      if (scenario === "standalone") tracker.start(latest);
      else if (scenario === "rollback") tracker.rollbackStartup();
      else tracker.commitStartup();
      tracker.stop();

      expect(storage.getItem(key)).toEqual({ success: true, value: newer });
      expect(storage.removeItem).not.toHaveBeenCalled();
      if (scenario === "rollback") {
        expect(write).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
      } else {
        expect(write).toHaveBeenCalledExactlyOnceWith(key, JSON.stringify(visitOf(latest)));
        expect(report.mock.calls).toEqual(
          scenario === "standalone"
            ? [[visitOf(page(1, 1_000)), 3_000]]
            : [
                [visitOf(page(1, 1_000)), 1_000],
                [visitOf(successor), 2_000],
              ],
        );
      }
    },
  );

  it("never persists or removes an uncommitted successor when there was no predecessor", () => {
    const storage = memoryStorage();
    const tracker = new PageVisitTime(storage, key, vi.fn());
    tracker.beginStartup();
    tracker.start(page(1, 1_000));

    tracker.rollbackStartup();

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toEqual({ success: true, value: null });
  });

  it.each(["stop", "rollbackStartup"] as const)(
    "%s preserves a newer owner with the same trace ID and a different start",
    (cleanup) => {
      const storage = memoryStorage();
      storage.setItem(key, JSON.stringify(visitOf(page(1, 1_000))));
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      if (cleanup === "rollbackStartup") tracker.beginStartup();
      const current = page(2, 2_000);
      tracker.start(current);
      const newer = { ...visitOf(current), startTimeUnixMs: 3_000 };
      const saved = JSON.stringify(newer);
      storage.setItem(key, saved);
      report.mockClear();

      tracker[cleanup]();
      tracker.stop();
      tracker.commitStartup();

      expect(storage.getItem(key)).toEqual({ success: true, value: saved });
      expect(report).not.toHaveBeenCalled();
    },
  );

  it.each([
    "not JSON",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...visitOf(page(1, 1_000)), id: "not-a-trace-id" }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), id: "0".repeat(32) }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), name: null }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), url: 123 }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), startTimeUnixMs: "1000" }),
    JSON.stringify({ ...visitOf(page(1, 1_000)), startTimeUnixMs: null }),
    JSON.stringify(visitOf(page(1, 1_000))).replace("1000", "1e400"),
  ])("replaces corrupt or invalid persisted state without reporting it: %s", (serialized) => {
    const storage = memoryStorage();
    storage.setItem(key, serialized);
    const report = vi.fn();
    const tracker = new PageVisitTime(storage, key, report);
    const next = page(2, 2_000);

    expect(() => tracker.start(next)).not.toThrow();
    expect(report).not.toHaveBeenCalled();
    tracker.start(page(3, 3_000));
    expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(next), 1_000);
  });

  it.each([true, false])(
    "discards a future start without replaying it (persisted=%s)",
    (persisted) => {
      const storage = memoryStorage();
      const report = vi.fn();
      const tracker = new PageVisitTime(storage, key, report);
      const future = page(1, 50_000);
      if (persisted) storage.setItem(key, JSON.stringify(visitOf(future)));
      else tracker.start(future);

      tracker.start(page(2, 2_000));
      expect(report).not.toHaveBeenCalled();
      tracker.start(page(3, 3_000));
      expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 2_000)), 1_000);
    },
  );

  it.each(["read", "write", "remove", "all"] as const)(
    "keeps SPA timing in memory when Web Storage %s throws",
    (failure) => {
      const values = new Map<string, string>();
      const fail = (operation: string) => {
        if (failure === operation || failure === "all") throw new Error("Storage blocked");
      };
      vi.stubGlobal("sessionStorage", {
        getItem: (name: string) => {
          fail("read");
          return values.get(name) ?? null;
        },
        setItem: (name: string, value: string) => {
          fail("write");
          values.set(name, value);
        },
        removeItem: (name: string) => {
          fail("remove");
          values.delete(name);
        },
      });
      try {
        const storage = createKeyValueStorage("sessionStorage", "Visit storage unavailable");
        const report = vi.fn();
        const tracker = new PageVisitTime(storage, key, report);

        expect(() => {
          tracker.start(page(1, 1_000));
          tracker.start(page(2, 5_000));
          tracker.stop();
        }).not.toThrow();
        expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(1, 1_000)), 4_000);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("resumes BFCache from the successor document's persisted state, not stale memory", () => {
    const storage = memoryStorage();
    const originalReport = vi.fn();
    const successorReport = vi.fn();
    const original = new PageVisitTime(storage, key, originalReport);
    const successor = new PageVisitTime(storage, key, successorReport);
    original.start(page(1, 1_000));
    original.suspend();
    successor.start(page(2, 4_000));
    successor.suspend();

    original.start(page(3, 10_000));

    expect(successorReport).toHaveBeenCalledExactlyOnceWith(visitOf(page(1, 1_000)), 3_000);
    expect(originalReport).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 4_000)), 6_000);
    original.start(page(4, 11_000));
    expect(originalReport.mock.calls).toEqual([
      [visitOf(page(2, 4_000)), 6_000],
      [visitOf(page(3, 10_000)), 1_000],
    ]);
  });

  it("does not resurrect an in-memory visit after suspension without storage", () => {
    const report = vi.fn();
    const tracker = new PageVisitTime(null, key, report);
    tracker.start(page(1, 1_000));
    tracker.suspend();
    tracker.start(page(2, 10_000));
    expect(report).not.toHaveBeenCalled();
    tracker.start(page(3, 12_000));
    expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 10_000)), 2_000);
  });

  it("does not replay stale memory when persisted state disappears while suspended", () => {
    const storage = memoryStorage();
    const report = vi.fn();
    const tracker = new PageVisitTime(storage, key, report);
    tracker.start(page(1, 1_000));
    tracker.suspend();
    storage.removeItem(key);

    tracker.start(page(2, 10_000));

    expect(report).not.toHaveBeenCalled();
    tracker.start(page(3, 12_000));
    expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 10_000)), 2_000);
  });

  it("stop removes only its own active entry and never emits a final visit", () => {
    const storage = memoryStorage();
    const report = vi.fn();
    const first = new PageVisitTime(storage, key, report);
    const second = new PageVisitTime(storage, key, report);
    first.start(page(1, 1_000));
    second.start(page(2, 2_000));
    report.mockClear();

    first.stop();
    expect(storage.getItem(key)).toEqual({
      success: true,
      value: JSON.stringify(visitOf(page(2, 2_000))),
    });
    second.stop();
    expect(storage.getItem(key)).toEqual({ success: true, value: null });
    expect(report).not.toHaveBeenCalled();
  });

  it("stop preserves a suspended visit for the next document", () => {
    const storage = memoryStorage();
    const tracker = new PageVisitTime(storage, key, vi.fn());
    tracker.start(page(1, 1_000));
    tracker.suspend();
    tracker.stop();
    const report = vi.fn();
    new PageVisitTime(storage, key, report).start(page(2, 2_000));
    expect(report).toHaveBeenCalledExactlyOnceWith(visitOf(page(1, 1_000)), 1_000);
  });

  it("isolates independent trackers with separate keys in the same storage", () => {
    const storage = memoryStorage();
    const firstReport = vi.fn();
    const secondReport = vi.fn();
    const first = new PageVisitTime(storage, "first", firstReport);
    const second = new PageVisitTime(storage, "second", secondReport);
    first.start(page(1, 1_000));
    second.start(page(2, 2_000));
    first.start(page(3, 5_000));
    first.stop();
    second.start(page(4, 8_000));
    expect(firstReport).toHaveBeenCalledExactlyOnceWith(visitOf(page(1, 1_000)), 4_000);
    expect(secondReport).toHaveBeenCalledExactlyOnceWith(visitOf(page(2, 2_000)), 6_000);
  });
});
