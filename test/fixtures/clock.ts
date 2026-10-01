// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { onTestFinished, vi } from "vitest";

export const TEST_TIME = Date.parse("2025-01-01T00:00:00.000Z");

/**
 * Install inside a non-concurrent test. Advances wall time, performance time and
 * timers together. Cleanup discards pending timers and restores the real clock.
 *
 * @see https://github.com/microsoft/ApplicationInsights-JS/blob/main/common/Tests/Framework/src/AITestClass.ts
 */
export function installFakeClock(now = TEST_TIME) {
  if (!Number.isFinite(now)) throw new RangeError("Clock time must be finite.");
  if (vi.isFakeTimers()) throw new Error("A fake clock is already installed.");
  vi.useFakeTimers({
    now,
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  let restored = false;
  function restore() {
    if (restored) return;
    vi.clearAllTimers();
    vi.useRealTimers();
    restored = true;
  }
  onTestFinished(restore);
  return {
    async advance(milliseconds: number): Promise<void> {
      if (restored) throw new Error("The fake clock has been restored.");
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new RangeError("Clock advancement must be finite and nonnegative.");
      }
      await vi.advanceTimersByTimeAsync(milliseconds);
    },
    restore,
  };
}
