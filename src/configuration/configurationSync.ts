// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fields, type createRuntimeConfiguration } from "./runtimeConfiguration.js";
import { downloadConfiguration } from "./httpConfiguration.js";
import type {
  MicrosoftOpenTelemetryBrowserConfigurationSyncOptions,
  MicrosoftOpenTelemetryBrowserConfigurationSync,
} from "../types.js";

const paths = ["samplingPercentage", "disableFetchTracking", "disableAjaxTracking"] as const;
type Controller = ReturnType<typeof createRuntimeConfiguration>;

/** Captures startup-only synchronization without invoking nested application accessors. */
export function captureConfigurationSync(value: unknown) {
  if (value === undefined) return undefined;
  const extension = fields(value, "extensionConfig.", ["AppInsightsCfgSyncPlugin"]);
  if (extension.AppInsightsCfgSyncPlugin === undefined) return undefined;
  const options = fields(extension.AppInsightsCfgSyncPlugin, "AppInsightsCfgSyncPlugin.", [
    "syncMode",
    "customEvtName",
    "nonOverrideConfigs",
    "onError",
    "cfgUrl",
    "blkCdnCfg",
    "scheduleFetchTimeout",
    "requestTimeoutMs",
  ]);
  const mode = options.syncMode === undefined ? 2 : options.syncMode;
  const name = options.customEvtName === undefined ? "ai_cfgsync" : options.customEvtName;
  if (mode !== 0 && mode !== 1 && mode !== 2) throw new TypeError("syncMode must be 0, 1 or 2.");
  if (typeof name !== "string" || !name.trim())
    throw new TypeError("customEvtName must be a non-empty string.");
  if (options.onError !== undefined && typeof options.onError !== "function")
    throw new TypeError("onError must be a function.");
  if (options.blkCdnCfg !== undefined && typeof options.blkCdnCfg !== "boolean")
    throw new TypeError("blkCdnCfg must be a boolean.");
  let url: string | undefined;
  if (options.cfgUrl !== undefined && options.cfgUrl !== "") {
    if (typeof options.cfgUrl !== "string") throw new TypeError("cfgUrl must be a string.");
    const parsed = new URL(options.cfgUrl, globalThis.location?.href);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password)
      throw new TypeError("cfgUrl must use HTTP(S) without credentials.");
    parsed.hash = "";
    url = parsed.href;
  }
  function delay(name: string, fallback: number, minimum: number): number {
    const value = options[name] === undefined ? fallback : options[name];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > 2_147_483_647
    )
      throw new RangeError(`${name} must be between ${minimum} and 2147483647 milliseconds.`);
    return value;
  }
  const interval = delay("scheduleFetchTimeout", 1_800_000, 0);
  const timeout = delay("requestTimeoutMs", 10_000, 1);
  const excluded = new Set<string>();
  if (options.nonOverrideConfigs !== undefined) {
    const overrides = fields(options.nonOverrideConfigs, "nonOverrideConfigs.", paths);
    for (const [key, blocked] of Object.entries(overrides)) {
      if (typeof blocked !== "boolean")
        throw new TypeError("nonOverrideConfigs values must be booleans.");
      if (blocked) excluded.add(key);
    }
  }
  return {
    mode,
    name,
    excluded,
    onError: options.onError as MicrosoftOpenTelemetryBrowserConfigurationSyncOptions["onError"],
    http: url && !options.blkCdnCfg ? { url, interval, timeout } : undefined,
  };
}

/** Event and optional HTTP transports share the owning configuration queue and cancellation epoch. */
export function createConfigurationSync(
  options: NonNullable<ReturnType<typeof captureConfigurationSync>>,
  configuration: Controller,
) {
  let paused = false;
  let stopped = false;
  let generation = 0;
  let listening = false;
  let changing = false;
  let uncertainRemoval = false;
  let pendingShutdown = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let failures = 0;
  const report = (error: unknown): void => {
    try {
      void Promise.resolve(options.onError?.(error)).catch(() => {});
    } catch {
      /* Application error reporting must not escape event dispatch. */
    }
  };
  const cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
    const previous = request;
    request = undefined;
    pending = undefined;
    previous?.abort();
  };
  const publish = (cfg: Record<string, unknown>, version: number): Promise<void> =>
    configuration.enqueue(() => {
      if (paused || stopped || version !== generation) return;
      const filtered = Object.freeze(
        Object.fromEntries(Object.entries(cfg).filter(([key]) => !options.excluded.has(key))),
      );
      globalThis.dispatchEvent(
        new CustomEvent(options.name, { detail: Object.freeze({ cfg: filtered }) }),
      );
    });
  const download = (): Promise<void> => {
    if (!started || paused || stopped || options.mode === 0 || !options.http)
      return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    timer = undefined;
    const version = generation;
    const controller = new AbortController();
    request = controller;
    const active = () => !paused && !stopped && version === generation;
    const http = options.http;
    const operation = Promise.resolve()
      .then(() => downloadConfiguration(http.url, http.timeout, controller))
      .then(async (patch) => {
        if (!active()) return;
        if (patch) {
          if (options.mode === 1) await publish(patch, version);
          else await configuration.receive(patch, active, options.excluded);
        }
        if (active()) failures = 0;
      })
      .catch((error: unknown) => {
        if (!active()) return;
        failures++;
        throw error;
      })
      .finally(() => {
        if (pending !== operation) return;
        pending = undefined;
        request = undefined;
        if (active() && failures < 3 && http.interval > 0) {
          timer = setTimeout(() => {
            void download().catch(report);
          }, http.interval);
        }
      });
    pending = operation;
    return operation;
  };
  const receive = (event: Event): void => {
    if (paused || stopped || options.mode !== 2) return;
    const version = generation;
    try {
      // Read the browser's native detail accessor, then require own data for the envelope and patch.
      const envelope = fields(Reflect.get(CustomEvent.prototype, "detail", event), "detail.", [
        "cfg",
      ]);
      const patch = fields(envelope.cfg, "cfg.", paths);
      for (const key of ["disableFetchTracking", "disableAjaxTracking"] as const) {
        if (Object.hasOwn(patch, key) && typeof patch[key] !== "boolean")
          throw new TypeError(`${key} must be a boolean.`);
      }
      void configuration
        .receive(patch, () => !paused && !stopped && version === generation, options.excluded)
        .catch(report);
    } catch (error) {
      report(error);
    }
  };
  const reconcile = (): void => {
    if (changing) return;
    changing = true;
    try {
      while (listening !== (!paused && !stopped && options.mode === 2)) {
        const add = !listening;
        listening = add;
        try {
          globalThis[add ? "addEventListener" : "removeEventListener"](options.name, receive);
          uncertainRemoval = false;
        } catch (error) {
          if (add) {
            stopped = true;
            generation++;
            // addEventListener may have registered before a wrapper threw.
            try {
              globalThis.removeEventListener(options.name, receive);
              listening = false;
            } catch {
              /* The owning shutdown retries removal; the listener is already inert. */
            }
          } else {
            listening = true;
            uncertainRemoval = true;
          }
          throw error;
        }
      }
    } finally {
      changing = false;
      if (pendingShutdown) {
        pendingShutdown = false;
        // Reentrant shutdown could not remove a listener while this transition was active.
        // Complete one deferred attempt without replacing the outer transition's error.
        try {
          reconcile();
        } catch {
          /* The adapter is terminal; preserve the original cleanup failure. */
        }
      } else if (uncertainRemoval && !paused && !stopped && options.mode === 2) {
        listening = false;
        try {
          reconcile();
        } catch {
          /* Failed registration already makes the adapter terminal. */
        }
      }
    }
  };
  const handle: MicrosoftOpenTelemetryBrowserConfigurationSync = {
    sync(): Promise<void> {
      if (options.http) return download();
      const version = generation;
      return configuration.enqueue(() => {
        if (stopped || paused || options.mode !== 1 || version !== generation) return;
        const snapshot = configuration.snapshot();
        const cfg = Object.freeze(
          Object.fromEntries(
            paths.filter((key) => !options.excluded.has(key)).map((key) => [key, snapshot[key]]),
          ),
        );
        globalThis.dispatchEvent(new CustomEvent(options.name, { detail: Object.freeze({ cfg }) }));
      });
    },
    pause(): void {
      paused = true;
      generation++;
      cancel();
      reconcile();
    },
    resume(): void {
      if (!stopped) {
        const wasPaused = paused;
        paused = false;
        // An earlier wrapper may have removed the listener before throwing. Native add is idempotent.
        if (uncertainRemoval) listening = false;
        reconcile();
        if (wasPaused || failures >= 3) {
          failures = 0;
          void download().catch(report);
        }
      }
    },
    shutdown(): void {
      if (changing && !stopped) pendingShutdown = true;
      stopped = true;
      generation++;
      cancel();
      try {
        reconcile();
      } catch (error) {
        // A wrapper may fail once during removal; keep the listener inert and retry once.
        try {
          reconcile();
        } catch {
          /* Preserve the original cleanup failure. */
        }
        throw error;
      }
    },
  };
  return {
    handle,
    start: () => {
      reconcile();
      if (!started) {
        started = true;
        void download().catch(report);
      }
    },
  };
}
