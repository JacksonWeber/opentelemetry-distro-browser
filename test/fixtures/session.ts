// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  SessionManager,
  type Session,
  type SessionManagerConfig,
  type SessionStore,
} from "@opentelemetry/browser-sdk/session";
import { onTestFinished } from "vitest";
import { createDeterministicIdGenerator } from "./ids.js";

/**
 * An upstream session manager with isolated in-memory storage and deterministic IDs.
 * Install a fake clock first for repeatable timestamps and expiration. Call start()
 * before use. Timers are stopped automatically when the test finishes.
 * Pass the same store and ID generator to simulate reloads without resetting the sequence.
 * Renewal follows OpenTelemetry's activity semantics, not the AI cookie implementation.
 * This does not emulate the distro's persisted last-activity or browser-storage policy.
 *
 * @see https://github.com/microsoft/ApplicationInsights-JS/blob/main/extensions/applicationinsights-properties-js/Tests/Unit/src/SessionManager.Tests.ts
 */
export function createSessionFixture(options: Partial<SessionManagerConfig> = {}) {
  let saved: Session | null = null;
  const store: SessionStore = options.sessionStore ?? {
    async get() {
      return saved === null ? null : { ...saved };
    },
    async save(session) {
      saved = { ...session };
    },
  };
  const manager = new SessionManager({
    sessionIdGenerator: createDeterministicIdGenerator(),
    ...options,
    sessionStore: store,
  });
  onTestFinished(() => manager.shutdown());
  return { manager, store };
}
