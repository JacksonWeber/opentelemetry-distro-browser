// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";

/** Internal limits, named after the Application Insights initialization settings. */
interface StartupQueueOptions {
  readonly initTimeOut?: number;
  readonly initInMemoMaxSize?: number;
}

/**
 * Application Insights-style startup gate: pending buffers, active delivers, inactive drops.
 * Owns only the queue and timer; destination resolution and processors belong to the caller.
 * The limit counts items, not bytes. No timers are started merely by importing this module.
 */
export class StartupQueue<T> {
  #status: "pending" | "active" | "inactive" = "pending";
  #queue: T[] = [];
  #deliver: ((item: T) => void) | undefined;
  #queueFullReported = false;
  readonly #capacity: number;
  readonly #deadline: number;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #warn: (message: string) => void;

  public constructor(
    options: StartupQueueOptions = {},
    warn: (message: string) => void = (message) => diag.warn(message),
  ) {
    this.#warn = warn;
    const timeout = options.initTimeOut ?? 50_000;
    this.#capacity = options.initInMemoMaxSize ?? 100;
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483_647) {
      throw new RangeError("initTimeOut must be between 0 and 2147483647 milliseconds");
    }
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 0) {
      throw new RangeError("initInMemoMaxSize must be a nonnegative safe integer");
    }
    this.#deadline = Date.now() + timeout;
    this.#timer = setTimeout(() => this.fail(), timeout);
  }

  /** Check before constructing a destination so late resolution cannot start a stopped pipeline. */
  public get pending(): boolean {
    this.#checkTimeout();
    return this.#status === "pending";
  }

  public track(item: T): "QUEUE_FULL" | undefined {
    this.#checkTimeout();
    if (this.#status === "active") {
      this.#send(item);
    } else if (this.#status === "pending") {
      if (this.#queue.length < this.#capacity) {
        this.#queue.push(item);
      } else {
        if (!this.#queueFullReported) {
          this.#queueFullReported = true;
          this.#warn("Telemetry startup queue full; dropping new items");
        }
        return "QUEUE_FULL";
      }
    }
    return undefined;
  }

  /** Activates once and releases buffered items in arrival order. Late activation is ignored. */
  public activate(deliver: (item: T) => void): void {
    this.#checkTimeout();
    if (this.#status !== "pending") return;
    this.#status = "active";
    this.#deliver = deliver;
    clearTimeout(this.#timer);
    const buffered = this.#queue;
    this.#queue = [];
    for (const item of buffered) this.#send(item);
  }

  /** Resolution failure and timeout share the same terminal transition and safe diagnostic. */
  public fail(): void {
    if (this.#status !== "pending") return;
    const count = this.#queue.length;
    this.shutdown();
    this.#warn(`Telemetry startup failed or timed out; dropping ${count} buffered items`);
  }

  /** Cancels pending startup, releases retained items/callbacks, and drops subsequent telemetry. */
  public shutdown(): void {
    this.#status = "inactive";
    clearTimeout(this.#timer);
    this.#queue = [];
    this.#deliver = undefined;
  }

  #checkTimeout(): void {
    // Enforce the deadline even when a background tab delays timer callbacks.
    if (this.#status === "pending" && Date.now() >= this.#deadline) this.fail();
  }

  #send(item: T): void {
    try {
      this.#deliver?.(item);
    } catch {
      // One bad item must not prevent releasing the rest or expose telemetry in diagnostics.
      this.#warn("Telemetry startup delivery failed; dropping item");
    }
  }
}
