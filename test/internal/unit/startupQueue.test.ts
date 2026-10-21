// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { StartupQueue } from "../../../src/shared/startupQueue.js";
import { installFakeClock } from "../../fixtures/clock.js";

afterEach(() => vi.restoreAllMocks());

it("buffers while pending, releases in order, and delivers new items when active", async () => {
  const clock = installFakeClock();
  const queue = new StartupQueue<string>();
  const deliver = vi.fn();
  queue.track("first");
  queue.track("second");
  expect(deliver).not.toHaveBeenCalled();
  queue.activate(deliver);
  queue.track("third");
  expect(deliver.mock.calls).toEqual([["first"], ["second"], ["third"]]);
  expect(vi.getTimerCount()).toBe(0);
  await clock.advance(50_000);
  queue.track("still active");
  expect(deliver).toHaveBeenLastCalledWith("still active");
});

it("strictly caps the shared item count and reports overflow only once", () => {
  installFakeClock();
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const queue = new StartupQueue<string>({ initInMemoMaxSize: 2 });
  const deliver = vi.fn();
  queue.track("span");
  queue.track("log");
  queue.track("overflow");
  queue.track("also overflow");
  expect(warn).toHaveBeenCalledExactlyOnceWith("Telemetry startup queue full; dropping new items");
  queue.activate(deliver);
  expect(deliver.mock.calls).toEqual([["span"], ["log"]]);
});

it("defaults to 100 items and a 50000 ms timeout", async () => {
  const clock = installFakeClock();
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const queue = new StartupQueue<number>();
  for (let i = 0; i < 101; i++) queue.track(i);
  await clock.advance(49_999);
  expect(warn).toHaveBeenCalledTimes(1);
  await clock.advance(1);
  expect(warn).toHaveBeenLastCalledWith(
    "Telemetry startup failed or timed out; dropping 100 buffered items",
  );
  const deliver = vi.fn();
  queue.activate(deliver);
  queue.track(102);
  expect(deliver).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["fail", "shutdown"] as const)(
  "%s clears pending items and ignores late activation",
  (method) => {
    installFakeClock();
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    const queue = new StartupQueue<string>();
    queue.track("private telemetry");
    queue[method]();
    queue[method]();
    const deliver = vi.fn();
    queue.activate(deliver);
    queue.track("after");
    expect(deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(method === "fail" ? 1 : 0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private telemetry");
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not replace an active destination or fail it a second time", () => {
  installFakeClock();
  const queue = new StartupQueue<string>();
  const first = vi.fn();
  const second = vi.fn();
  queue.activate(first);
  queue.activate(second);
  queue.fail();
  queue.track("active");
  expect(first).toHaveBeenCalledWith("active");
  expect(second).not.toHaveBeenCalled();
  queue.shutdown();
  queue.track("stopped");
  expect(first).toHaveBeenCalledTimes(1);
});

it("allows zero capacity without disabling delivery after activation", () => {
  installFakeClock();
  vi.spyOn(diag, "warn").mockImplementation(() => {});
  const queue = new StartupQueue<string>({ initInMemoMaxSize: 0 });
  queue.track("dropped");
  const deliver = vi.fn();
  queue.activate(deliver);
  queue.track("delivered");
  expect(deliver).toHaveBeenCalledExactlyOnceWith("delivered");
});

it("expires immediately with a zero timeout", () => {
  installFakeClock();
  vi.spyOn(diag, "warn").mockImplementation(() => {});
  const queue = new StartupQueue<string>({ initTimeOut: 0 });
  const deliver = vi.fn();
  queue.activate(deliver);
  queue.track("late");
  expect(deliver).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["track", "activate"] as const)(
  "checks the deadline on %s even before a delayed timer runs",
  (method) => {
    installFakeClock();
    vi.spyOn(diag, "warn").mockImplementation(() => {});
    const queue = new StartupQueue<string>({ initTimeOut: 10 });
    queue.track("before deadline");
    vi.setSystemTime(Date.now() + 10);
    const deliver = vi.fn();
    if (method === "track") queue.track("at deadline");
    queue.activate(deliver);
    expect(deliver).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps separate queues independent", () => {
  installFakeClock();
  const first = new StartupQueue<string>();
  const second = new StartupQueue<string>();
  first.track("first");
  second.track("second");
  first.shutdown();
  const deliver = vi.fn();
  second.activate(deliver);
  expect(deliver).toHaveBeenCalledExactlyOnceWith("second");
  expect(vi.getTimerCount()).toBe(0);
});

it("continues releasing items after a delivery callback throws", () => {
  installFakeClock();
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const queue = new StartupQueue<string>();
  queue.track("bad");
  queue.track("good");
  const deliver = vi.fn((item: string) => {
    if (item === "bad") throw new Error("private failure");
  });
  queue.activate(deliver);
  expect(deliver.mock.calls).toEqual([["bad"], ["good"]]);
  expect(warn).toHaveBeenCalledExactlyOnceWith("Telemetry startup delivery failed; dropping item");
});

it("stops replay if shutdown is called during delivery", () => {
  installFakeClock();
  const queue = new StartupQueue<string>();
  queue.track("first");
  queue.track("second");
  const deliver = vi.fn(() => queue.shutdown());
  queue.activate(deliver);
  expect(deliver).toHaveBeenCalledExactlyOnceWith("first");
});

it.each([
  { initTimeOut: -1 },
  { initTimeOut: NaN },
  { initTimeOut: Infinity },
  { initTimeOut: 2_147_483_648 },
  { initInMemoMaxSize: -1 },
  { initInMemoMaxSize: 1.5 },
  { initInMemoMaxSize: Infinity },
  { initInMemoMaxSize: NaN },
])("rejects invalid limits without starting a timer: %j", (options) => {
  installFakeClock();
  expect(() => new StartupQueue(options)).toThrow(RangeError);
  expect(vi.getTimerCount()).toBe(0);
});
