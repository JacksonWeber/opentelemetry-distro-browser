// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SessionIdGenerator } from "@opentelemetry/browser-sdk/session";
import type { IdGenerator } from "@opentelemetry/sdk-trace-base";

/**
 * Independent, repeatable nonzero hex sequences for traces, spans and sessions.
 * Create a new generator per test. This never patches global randomness.
 */
export function createDeterministicIdGenerator(seed = 1): IdGenerator & SessionIdGenerator {
  if (!Number.isSafeInteger(seed) || seed < 1) {
    throw new RangeError("ID seed must be a positive safe integer.");
  }
  function sequence(width: number) {
    let next = BigInt(seed);
    return () => {
      const id = next.toString(16).padStart(width, "0");
      if (id.length > width) throw new RangeError("Deterministic ID sequence exhausted.");
      next++;
      return id;
    };
  }
  return {
    generateTraceId: sequence(32),
    generateSpanId: sequence(16),
    generateSessionId: sequence(32),
  };
}
