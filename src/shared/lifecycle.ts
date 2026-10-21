// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { callWithTimeout } from "@opentelemetry/core";
import { getSharedRegistry, reportError } from "./globalOwnership.js";

/** Rethrows a single collected error as-is, or several as one `AggregateError`. */
export function throwErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

/** Runs bounded task groups in order, collecting all failures. */
export async function runLifecycleTasks(
  tasks: readonly (() => Promise<void>)[],
  message: string,
  followingTasks?: readonly (() => Promise<void>)[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const group of followingTasks ? [tasks, followingTasks] : [tasks]) {
    const results = await Promise.allSettled(
      group.map((task) => callWithTimeout(Promise.resolve().then(task), 30_000)),
    );
    for (const result of results) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }
  throwErrors(errors, message);
}

/** Waits for every already-bounded operation without imposing a second deadline. */
export async function waitForAll(
  operations: readonly Promise<void>[],
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(operations);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  throwErrors(errors, message);
}

/** Installs one pair of unload listeners for all active instances in this realm. */
export function subscribeToUnload(flush: () => void): () => void {
  const registry = getSharedRegistry();
  const subscribers = (registry.unloadSubscribers ??= new Set());
  if (!subscribers.size) {
    const pagehide = (): void => {
      for (const subscriber of [...subscribers]) {
        try {
          subscriber();
        } catch (error) {
          reportError("Telemetry unload flush failed", error);
        }
      }
    };
    const document = globalThis.document;
    const visibilitychange = (): void => {
      if (document?.visibilityState === "hidden") pagehide();
    };
    const remove = (): void => {
      try {
        globalThis.removeEventListener?.("pagehide", pagehide);
      } finally {
        document?.removeEventListener("visibilitychange", visibilitychange);
      }
    };
    try {
      globalThis.addEventListener?.("pagehide", pagehide);
      document?.addEventListener("visibilitychange", visibilitychange);
    } catch (error) {
      try {
        remove();
      } catch (cleanupError) {
        reportError("Telemetry unload listener cleanup failed", cleanupError);
      }
      throw error;
    }
    registry.removeUnloadListeners = remove;
  }
  subscribers.add(flush);
  return () => {
    subscribers.delete(flush);
    if (!subscribers.size) {
      const remove = registry.removeUnloadListeners;
      registry.removeUnloadListeners = undefined;
      remove?.();
    }
  };
}
