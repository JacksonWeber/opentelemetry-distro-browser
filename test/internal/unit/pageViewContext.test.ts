// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPageViewContext,
  generatePageViewId,
} from "../../../src/instrumentation/pageView/pageViewContext.js";
import type { PageView } from "../../../src/instrumentation/pageView/types.js";

const first: PageView = Object.freeze({
  id: "first",
  index: 0,
  name: "Home",
  nameSource: "explicit",
  url: "https://example.test/",
  referrer: "",
  navigationType: "navigate",
  sameDocument: false,
  startTimeUnixMs: 1,
});
const second: PageView = Object.freeze({ ...first, id: "second", index: 1 });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("page-view context", () => {
  it("starts empty and publishes the current value before notifying listeners in order", () => {
    const context = createPageViewContext();
    const seen: PageView[] = [];
    expect(context.getCurrentPageView()).toBeUndefined();
    context.onPageViewChanged((pageView) => {
      expect(context.getCurrentPageView()).toBe(pageView);
      seen.push(pageView);
    });
    const listener = vi.fn(() => expect(seen).toEqual([first]));
    context.onPageViewChanged(listener);

    context.setCurrentPageView(first);

    expect(context.getCurrentPageView()).toBe(first);
    expect(listener).toHaveBeenCalledExactlyOnceWith(first);
  });

  it("does not replay the current page view to new subscribers", () => {
    const context = createPageViewContext();
    context.setCurrentPageView(first);
    const listener = vi.fn();
    context.onPageViewChanged(listener);
    expect(listener).not.toHaveBeenCalled();

    context.setCurrentPageView(second);

    expect(listener).toHaveBeenCalledExactlyOnceWith(second);
    expect(context.getCurrentPageView()).toBe(second);
  });

  it("clears the current value without notifying or removing subscriptions", () => {
    const context = createPageViewContext();
    const listener = vi.fn();
    const unsubscribe = context.onPageViewChanged(listener);
    context.clear();
    context.setCurrentPageView(first);
    context.clear();
    context.clear();
    expect(context.getCurrentPageView()).toBeUndefined();
    expect(listener).toHaveBeenCalledExactlyOnceWith(first);

    context.setCurrentPageView(second);
    expect(listener).toHaveBeenLastCalledWith(second);
    unsubscribe();
    context.clear();
    context.setCurrentPageView(first);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps state and subscriptions isolated between contexts", () => {
    const left = createPageViewContext();
    const right = createPageViewContext();
    const listener = vi.fn();
    left.onPageViewChanged(listener);
    left.setCurrentPageView(first);
    right.setCurrentPageView(second);
    right.clear();

    expect(left.getCurrentPageView()).toBe(first);
    expect(right.getCurrentPageView()).toBeUndefined();
    expect(listener).toHaveBeenCalledExactlyOnceWith(first);
  });

  it("releases duplicate subscriptions independently and idempotently", () => {
    const context = createPageViewContext();
    const listener = vi.fn();
    const unsubscribeFirst = context.onPageViewChanged(listener);
    const unsubscribeSecond = context.onPageViewChanged(listener);
    context.setCurrentPageView(first);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    unsubscribeFirst();
    context.setCurrentPageView(second);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribeSecond();
    unsubscribeSecond();
    context.setCurrentPageView(first);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("finishes the listener snapshot when subscriptions are removed during dispatch", () => {
    const context = createPageViewContext();
    const listener = vi.fn();
    const unsubscribeSelf = context.onPageViewChanged(() => {
      unsubscribeSelf();
      unsubscribeOther();
    });
    const unsubscribeOther = context.onPageViewChanged(listener);

    context.setCurrentPageView(first);
    context.setCurrentPageView(second);

    expect(listener).toHaveBeenCalledExactlyOnceWith(first);
    expect(context.getCurrentPageView()).toBe(second);
  });

  it("waits until the next publication to invoke a listener added during dispatch", () => {
    const context = createPageViewContext();
    const listener = vi.fn();
    const unsubscribe = context.onPageViewChanged(() => {
      unsubscribe();
      context.onPageViewChanged(listener);
    });

    context.setCurrentPageView(first);
    expect(listener).not.toHaveBeenCalled();
    context.setCurrentPageView(second);
    expect(listener).toHaveBeenCalledExactlyOnceWith(second);
  });

  it("surfaces listener failures after updating the current page view", () => {
    const context = createPageViewContext();
    const failure = new Error("listener failed");
    const unsubscribe = context.onPageViewChanged(() => {
      throw failure;
    });

    expect(() => context.setCurrentPageView(first)).toThrow(failure);
    expect(context.getCurrentPageView()).toBe(first);
    unsubscribe();
    context.setCurrentPageView(second);
    expect(context.getCurrentPageView()).toBe(second);
  });
});

describe("page-view ids", () => {
  it("encodes all sixteen cryptographic bytes as padded lowercase hexadecimal", () => {
    const bytes = new Uint8Array([
      0, 1, 15, 16, 127, 128, 254, 255, 0, 1, 15, 16, 127, 128, 254, 255,
    ]);
    const getRandomValues = vi.fn((target: Uint8Array) => {
      target.set(bytes);
      return target;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    const random = vi.spyOn(Math, "random");

    expect(generatePageViewId()).toBe("00010f107f80feff00010f107f80feff");
    expect(getRandomValues).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(random).not.toHaveBeenCalled();
  });

  it("surfaces crypto failures rather than silently falling back", () => {
    const failure = new Error("crypto failed");
    vi.stubGlobal("crypto", {
      getRandomValues: () => {
        throw failure;
      },
    });
    const random = vi.spyOn(Math, "random");

    expect(() => generatePageViewId()).toThrow(failure);
    expect(random).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { getRandomValues: undefined }])(
    "falls back to random bytes without a usable crypto API (%j)",
    (cryptoApi) => {
      vi.stubGlobal("crypto", cryptoApi);
      const random = vi.spyOn(Math, "random").mockReturnValue(255 / 256);
      random
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1 / 256)
        .mockReturnValueOnce(15 / 256);

      expect(generatePageViewId()).toBe(`00010f${"ff".repeat(13)}`);
      expect(random).toHaveBeenCalledTimes(16);
    },
  );
});
