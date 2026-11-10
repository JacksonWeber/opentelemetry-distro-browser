// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Attributes } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { truncateCustomDimensions, truncateToLength } from "./exporter/common.js";
import { getUtf8Size } from "./exporter/logUtils.js";
import { redactUrl } from "./shared/urlRedaction.js";
import type { MicrosoftOpenTelemetryBrowserExceptionOptions } from "./types.js";

const MAX_ATTACHMENT_SIZE = 8192;
const MAX_SCRIPTS = 100;
// Telemetry instances use the SDK's default per-event attribute limit.
const MAX_EVENT_ATTRIBUTES = 128;

interface ExceptionScript {
  url: string;
  crossOrigin?: string;
  async?: boolean;
  defer?: boolean;
  referrerPolicy?: string;
}

/** Captures configuration before startup awaits; owns no patches, timers, storage or log history. */
export function createExceptionEnrichment(
  options: MicrosoftOpenTelemetryBrowserExceptionOptions | undefined,
  redactedQueryParams: readonly string[],
): (SpanProcessor & LogRecordProcessor) | undefined {
  if (
    options !== undefined &&
    (!options || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new TypeError("expCfg must be an object.");
  }
  const { inclScripts = false, expLog, maxLogs = 50 } = options ?? {};
  if (
    typeof inclScripts !== "boolean" ||
    (expLog !== undefined && typeof expLog !== "function") ||
    !Number.isSafeInteger(maxLogs) ||
    maxLogs < 0
  ) {
    throw new TypeError(
      "Invalid expCfg: use a boolean inclScripts, callback expLog and nonnegative integer maxLogs.",
    );
  }
  if (!inclScripts && (!expLog || maxLogs === 0)) return undefined;
  let collecting = false;
  let stopped = false;

  function attachments(attributes: Readonly<Record<string, unknown>>): Attributes {
    const result: Attributes = {};
    // Application callbacks can emit more exceptions or synchronously shut down their instance.
    if (collecting || stopped) return result;
    collecting = true;
    try {
      if (
        inclScripts &&
        attributes.exceptionScripts === undefined &&
        typeof document !== "undefined"
      ) {
        try {
          const metadata: ExceptionScript[] = [];
          let size = 2;
          const scripts = document.scripts;
          for (let index = 0; index < Math.min(scripts.length, MAX_SCRIPTS); index++) {
            const script = scripts[index];
            const src = script.getAttribute("src");
            if (!src || src.length > MAX_ATTACHMENT_SIZE) continue;
            let url: URL;
            try {
              url = new URL(src, document.baseURI);
            } catch {
              continue;
            }
            if (url.protocol !== "https:" && url.protocol !== "http:") continue;
            const crossOrigin = script.getAttribute("crossorigin");
            const referrerPolicy = script.getAttribute("referrerpolicy");
            if (
              (crossOrigin && crossOrigin.length > MAX_ATTACHMENT_SIZE) ||
              (referrerPolicy && referrerPolicy.length > MAX_ATTACHMENT_SIZE)
            )
              continue;
            const info: ExceptionScript = { url: redactUrl(url.href, redactedQueryParams) };
            if (crossOrigin) info.crossOrigin = crossOrigin;
            if (script.hasAttribute("async")) info.async = true;
            if (script.hasAttribute("defer")) info.defer = true;
            if (referrerPolicy) info.referrerPolicy = referrerPolicy;
            const addedSize = getUtf8Size(JSON.stringify(info)) + (metadata.length ? 1 : 0);
            if (size + addedSize > MAX_ATTACHMENT_SIZE) break;
            metadata.push(info);
            size += addedSize;
          }
          result.exceptionScripts = JSON.stringify(metadata);
        } catch {
          // DOM access is optional and must never prevent exception export.
        }
      }
      if (expLog && maxLogs > 0 && attributes.exceptionLog === undefined) {
        try {
          const snapshot = expLog();
          const asynchronous =
            snapshot && typeof (snapshot as { then?: unknown }).then === "function";
          // JavaScript callers may accidentally return a promise despite the synchronous contract.
          if (asynchronous) void Promise.resolve(snapshot).catch(() => {});
          const logs = asynchronous ? undefined : snapshot?.logs;
          if (Array.isArray(logs)) {
            const entries: string[] = [];
            let remaining = MAX_ATTACHMENT_SIZE;
            for (
              let index = 0;
              index < Math.min(logs.length, maxLogs, MAX_ATTACHMENT_SIZE) && remaining > 0;
              index++
            ) {
              const entry: unknown = logs[index];
              if (typeof entry !== "string") continue;
              const bounded = truncateToLength(entry, remaining);
              entries.push(bounded);
              remaining -= bounded.length + 1;
            }
            result.exceptionLog = truncateCustomDimensions({
              exceptionLog: entries.join("\n"),
            }).exceptionLog;
          }
        } catch {
          // Do not log callback failures: diagnostics may themselves be instrumented.
        }
      }
    } finally {
      collecting = false;
    }
    return stopped ? {} : result;
  }

  return {
    enabled: () => false,
    onEmit(record) {
      if (record.eventName === "exception" || record.attributes["exception.type"]) {
        record.setAttributes(attachments(record.attributes));
      }
    },
    onStart() {},
    onEnd(span) {
      // The SDK marks the span ended before onEnd, so callbacks cannot re-end and export it twice.
      for (const event of span.events.slice()) {
        if (event.name === "exception") {
          const attributes = { ...event.attributes };
          let count = Object.keys(attributes).length;
          for (const [key, value] of Object.entries(attachments(attributes))) {
            if (count < MAX_EVENT_ATTRIBUTES) {
              attributes[key] = value;
              count++;
            } else {
              event.droppedAttributesCount = (event.droppedAttributesCount ?? 0) + 1;
            }
          }
          event.attributes = attributes;
        }
      }
    },
    async forceFlush() {},
    shutdown() {
      stopped = true;
      return Promise.resolve();
    },
  };
}
