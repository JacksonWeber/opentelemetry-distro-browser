// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type PageView, type PageViewContext, type PageViewListener } from "./types.js";

/**
 * Creates an isolated page-view context.
 *
 * @remarks
 * Deliberately a factory rather than a module-level singleton, so two independently configured
 * consumers on one page never share page-view state through this module.
 *
 * @returns A context that the instrumentation writes to and a correlation processor reads from.
 * @public
 */
export function createPageViewContext(): PageViewContext {
  let current: PageView | undefined;
  const listeners: PageViewListener[] = [];

  return {
    getCurrentPageView(): PageView | undefined {
      return current;
    },

    onPageViewChanged(listener: PageViewListener): () => void {
      listeners.push(listener);
      let released = false;
      return (): void => {
        if (released) {
          return;
        }
        released = true;
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },

    setCurrentPageView(pageView: PageView): void {
      current = pageView;
      // Iterate a snapshot: a listener may unsubscribe during dispatch.
      for (const listener of listeners.slice()) {
        listener(pageView);
      }
    },

    clear(): void {
      // Subscriptions survive: the instrumentation clears on `disable()`, and a processor that
      // subscribed once must keep receiving page views if it is enabled again.
      current = undefined;
    },
  };
}

const HEX = "0123456789abcdef";

/**
 * Mints a page-view id: sixteen random bytes, lowercase hexadecimal.
 *
 * @remarks
 * Uses `crypto.getRandomValues` where available and falls back to `Math.random` on browsers that
 * do not expose it. The value is a correlation key, not a security token.
 *
 * @returns A 32-character lowercase hexadecimal identifier.
 * @public
 */
export function generatePageViewId(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi: Crypto | undefined = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  let id = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    id += HEX[byte >> 4];
    id += HEX[byte & 0x0f];
  }
  return id;
}
