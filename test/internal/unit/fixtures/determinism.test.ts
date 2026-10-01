// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isSpanContextValid } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeClock, TEST_TIME } from "../../../fixtures/clock.js";
import { createDeterministicIdGenerator } from "../../../fixtures/ids.js";
import { createSessionFixture } from "../../../fixtures/session.js";

afterEach(() => vi.restoreAllMocks());

describe("deterministic IDs", () => {
  it("generates independent valid trace, span and session sequences", () => {
    const random = vi.spyOn(Math, "random");
    const ids = createDeterministicIdGenerator();
    const traceId = ids.generateTraceId();
    const spanId = ids.generateSpanId();
    expect(isSpanContextValid({ traceId, spanId, traceFlags: 1 })).toBe(true);
    expect(traceId).toBe("00000000000000000000000000000001");
    expect(spanId).toBe("0000000000000001");
    expect(ids.generateTraceId()).toBe("00000000000000000000000000000002");
    expect(ids.generateSpanId()).toBe("0000000000000002");
    expect(ids.generateSessionId()).toBe("00000000000000000000000000000001");
    expect(ids.generateSessionId()).toBe("00000000000000000000000000000002");
    expect(random).not.toHaveBeenCalled();
  });

  it("replays a seed without sharing state across fixtures", () => {
    const first = createDeterministicIdGenerator(42);
    const second = createDeterministicIdGenerator(42);
    expect(first.generateSpanId()).toBe("000000000000002a");
    expect(first.generateSpanId()).toBe("000000000000002b");
    expect(second.generateSpanId()).toBe("000000000000002a");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects seed %s", (seed) => {
    expect(() => createDeterministicIdGenerator(seed)).toThrow("positive safe integer");
  });
});

describe("fake clock", () => {
  it("advances wall time, performance time, intervals and asynchronous timers", async () => {
    const clock = installFakeClock();
    const ticks: number[] = [];
    const start = performance.now();
    const interval = setInterval(() => ticks.push(Date.now()), 10);
    const completed = vi.fn();
    setTimeout(async () => {
      await Promise.resolve();
      completed();
    }, 15);
    await clock.advance(20);
    expect(Date.now()).toBe(TEST_TIME + 20);
    expect(performance.now() - start).toBe(20);
    expect(ticks).toEqual([TEST_TIME + 10, TEST_TIME + 20]);
    expect(completed).toHaveBeenCalledOnce();
    clearInterval(interval);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards pending timers and restores globals idempotently", async () => {
    const originalDate = Date;
    const originalSetTimeout = setTimeout;
    const originalPerformance = performance;
    const clock = installFakeClock();
    const callback = vi.fn();
    setTimeout(callback, 60_000);
    expect(() => installFakeClock()).toThrow("already installed");
    clock.restore();
    clock.restore();
    expect(Date).toBe(originalDate);
    expect(setTimeout).toBe(originalSetTimeout);
    expect(performance).toBe(originalPerformance);
    expect(vi.isFakeTimers()).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    await expect(clock.advance(1)).rejects.toThrow("restored");
  });

  it("rejects invalid advancement without changing the clock", async () => {
    const clock = installFakeClock(1234);
    for (const value of [-1, Infinity, NaN]) {
      await expect(clock.advance(value)).rejects.toThrow("nonnegative");
    }
    expect(Date.now()).toBe(1234);
  });

  it("rejects an invalid initial time without installing timers", () => {
    expect(vi.isFakeTimers()).toBe(false);
    expect(() => installFakeClock(NaN)).toThrow("finite");
    expect(vi.isFakeTimers()).toBe(false);
  });
});

describe("deterministic sessions", () => {
  it("preserves the session across reloads and expires at the original duration boundary", async () => {
    const clock = installFakeClock();
    const ids = createDeterministicIdGenerator();
    const first = createSessionFixture({ sessionIdGenerator: ids, maxDuration: 10 });
    await first.manager.start();
    const original = first.manager.getSession();
    await clock.advance(6000);
    first.manager.shutdown();

    const reloaded = createSessionFixture({
      sessionIdGenerator: ids,
      sessionStore: first.store,
      maxDuration: 10,
    });
    await reloaded.manager.start();
    expect(reloaded.manager.getSession()).toEqual(original);
    await clock.advance(3999);
    expect(await reloaded.store.get()).toEqual(original);
    await clock.advance(1);
    expect(await reloaded.store.get()).toEqual({
      id: "00000000000000000000000000000002",
      startTimestamp: TEST_TIME + 10_000,
    });
  });

  it("renews inactivity after activity and expires exactly at the renewed boundary", async () => {
    const clock = installFakeClock();
    const { manager, store } = createSessionFixture({ inactivityTimeout: 10 });
    await manager.start();
    const original = manager.getSession();
    await clock.advance(6000);
    expect(manager.getSession()).toEqual(original);
    await clock.advance(9999);
    expect(await store.get()).toEqual(original);
    await clock.advance(1);
    expect(await store.get()).toEqual({
      id: "00000000000000000000000000000002",
      startTimestamp: TEST_TIME + 16_000,
    });
  });

  it("does not extend maximum duration when activity renews inactivity", async () => {
    const clock = installFakeClock();
    const { manager, store } = createSessionFixture({ maxDuration: 12, inactivityTimeout: 10 });
    await manager.start();
    const original = manager.getSession();
    await clock.advance(6000);
    expect(manager.getSession()).toEqual(original);
    await clock.advance(5999);
    expect(await store.get()).toEqual(original);
    await clock.advance(1);
    expect(await store.get()).toEqual({
      id: "00000000000000000000000000000002",
      startTimestamp: TEST_TIME + 12_000,
    });
  });

  it("uses the upstream contract and rotates on maximum duration", async () => {
    const clock = installFakeClock();
    const fixture = createSessionFixture({ maxDuration: 2 });
    await fixture.manager.start();
    expect(fixture.manager.getSession()).toEqual({
      id: "00000000000000000000000000000001",
      startTimestamp: TEST_TIME,
    });
    await clock.advance(2000);
    expect(fixture.manager.getSession()).toEqual({
      id: "00000000000000000000000000000002",
      startTimestamp: TEST_TIME + 2000,
    });
    expect(await fixture.store.get()).toEqual(fixture.manager.getSession());
    fixture.manager.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rotates inactive sessions and cancels expiration on shutdown", async () => {
    const clock = installFakeClock();
    const { manager } = createSessionFixture({ inactivityTimeout: 1 });
    await manager.start();
    await clock.advance(1000);
    expect(manager.getSessionId()).toBe("00000000000000000000000000000002");
    manager.shutdown();
    await clock.advance(10_000);
    expect(manager.getSessionId()).toBe("00000000000000000000000000000002");
  });

  it("restores seeded storage without aliasing or using browser storage", async () => {
    installFakeClock();
    const getStorage = vi.spyOn(Storage.prototype, "getItem");
    const setStorage = vi.spyOn(Storage.prototype, "setItem");
    const first = createSessionFixture();
    const second = createSessionFixture();
    const saved = { id: "restored-session", startTimestamp: TEST_TIME - 1000 };
    await first.store.save(saved);
    saved.id = "mutated";
    const copy = await first.store.get();
    if (copy) copy.id = "also-mutated";
    await first.manager.start();
    await second.manager.start();
    expect(first.manager.getSession()).toEqual({
      id: "restored-session",
      startTimestamp: TEST_TIME - 1000,
    });
    expect(second.manager.getSessionId()).toBe("00000000000000000000000000000001");
    expect(getStorage).not.toHaveBeenCalled();
    expect(setStorage).not.toHaveBeenCalled();
  });
});
