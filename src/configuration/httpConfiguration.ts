// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { fields } from "./runtimeConfiguration.js";
import { withAbort } from "../shared/lifecycle.js";
import { getSharedRegistry, registerConfigurationUrl } from "../shared/globalOwnership.js";

const maximumBytes = 65_536;

/** One bounded download. Cancellation also settles wrappers that ignore AbortSignal. */
export async function downloadConfiguration(
  url: string,
  timeout: number,
  controller: AbortController,
): Promise<Record<string, unknown> | undefined> {
  const { signal } = controller;
  if (signal.aborted) throw new DOMException("Configuration request aborted.", "AbortError");
  const releaseUrl = registerConfigurationUrl(url);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body: ReadableStream<Uint8Array> | null | undefined;
  const cancelBody = (): void => {
    void (reader ? reader.cancel() : body?.cancel())?.catch(() => {});
  };
  signal.addEventListener("abort", cancelBody, { once: true });
  try {
    return await withAbort(
      (async () => {
        // Use the shared patch's underlying transport, including when an older SDK copy owns
        // the wrapper. The pinned fetch observer does not honor context suppression itself.
        const transport = (getSharedRegistry().browserPatches?.targets.get(globalThis)?.get("fetch")
          ?.original ?? globalThis.fetch) as typeof globalThis.fetch;
        const response = await context.with(suppressTracing(context.active()), () =>
          transport.call(globalThis, url, {
            signal,
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            redirect: "error",
          }),
        );
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new DOMException("Configuration request aborted.", "AbortError");
        }
        body = response.body;
        if (!response.ok || response.redirected) throw new Error("Configuration request failed.");
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes))
          throw new RangeError("Configuration response exceeds 65536 bytes.");
        if (!body) throw new TypeError("Configuration response has no body.");
        reader = body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let size = 0;
        let text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (signal.aborted)
            throw new DOMException("Configuration request aborted.", "AbortError");
          if (done) break;
          size += value.byteLength;
          if (size > maximumBytes)
            throw new RangeError("Configuration response exceeds 65536 bytes.");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          throw new TypeError("Configuration response must be valid JSON.");
        }
        const envelope = fields(payload, "response.", ["enabled", "config", "version"]);
        if (
          !["boolean", "number", "string"].includes(typeof envelope.enabled) ||
          (typeof envelope.enabled === "number" && !Number.isFinite(envelope.enabled))
        )
          throw new TypeError("Configuration enabled must be a scalar.");
        if (
          envelope.version !== undefined &&
          typeof envelope.version !== "string" &&
          (typeof envelope.version !== "number" || !Number.isFinite(envelope.version))
        )
          throw new TypeError("Configuration version must be a string or finite number.");
        let patch: Record<string, unknown> | undefined;
        if (Object.hasOwn(envelope, "config") || envelope.enabled) {
          patch = fields(envelope.config, "config.", [
            "samplingPercentage",
            "disableFetchTracking",
            "disableAjaxTracking",
          ]);
          for (const [key, value] of Object.entries(patch)) {
            if (
              key === "samplingPercentage"
                ? typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100
                : typeof value !== "boolean"
            )
              throw new TypeError(`Invalid configuration field: ${key}.`);
          }
        }
        return envelope.enabled ? patch : undefined;
      })(),
      signal,
    );
  } catch (error) {
    if (timedOut) throw new Error("Configuration request timed out.", { cause: error });
    throw error;
  } finally {
    releaseUrl();
    clearTimeout(timer);
    signal.removeEventListener("abort", cancelBody);
    cancelBody();
  }
}
