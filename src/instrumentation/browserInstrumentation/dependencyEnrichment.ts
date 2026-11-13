// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  diag,
  INVALID_SPAN_CONTEXT,
  trace,
  type AttributeValue,
  type Span,
  type TracerProvider,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import type { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import type { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import { getSharedRegistry, reportError } from "../../shared/globalOwnership.js";
import type { BrowserInstrumentation, DependencyInstrumentationOptions } from "../../types.js";

const SENSITIVE_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
  "x-api-key",
];

interface RequestData {
  url: string;
  start: number;
  timing?: PendingTiming;
  headers?: Headers;
}

interface PendingTiming {
  count: number;
  ambiguous: boolean;
}

interface Quota {
  page?: string;
  count: number;
}

/** Metadata wrappers form a removable chain around the shared upstream patch. */
export interface DependencyPatch {
  previous: unknown;
  wrapper?: unknown;
  before?: DependencyPatch;
  after?: DependencyPatch;
}

function requestData(input: string): RequestData {
  return { url: new URL(input, document.baseURI).href, start: performance.now() };
}

function setDefaultAttribute(span: Span, name: string, value: AttributeValue): void {
  if (
    "attributes" in span &&
    typeof span.attributes === "object" &&
    span.attributes !== null &&
    Object.hasOwn(span.attributes, name)
  ) {
    return;
  }
  span.setAttribute(name, value);
}

/** Uses only an unambiguous completed entry, without waiting or changing the browser's buffer. */
export function addDependencyTiming(span: Span, request: RequestData, initiatorType: string): void {
  if (request.timing?.ambiguous) {
    diag.debug("Dependency resource timing unavailable or ambiguous");
    return;
  }
  const end = performance.now();
  const resources = performance.getEntriesByName(request.url, "resource");
  const hash = request.url.indexOf("#");
  // WebKit omits fragments, while Chromium and Firefox retain them in resource names.
  if (hash >= 0) {
    resources.push(...performance.getEntriesByName(request.url.slice(0, hash), "resource"));
  }
  const entries = resources.filter(
    (entry): entry is PerformanceResourceTiming =>
      "initiatorType" in entry &&
      entry.initiatorType === initiatorType &&
      entry.startTime >= request.start &&
      "responseEnd" in entry &&
      typeof entry.responseEnd === "number" &&
      entry.responseEnd > 0 &&
      entry.responseEnd <= end,
  );
  if (entries.length !== 1) {
    diag.debug("Dependency resource timing unavailable or ambiguous");
    return;
  }
  const entry = entries[0];
  const duration = (name: string, start: number, finish: number): void => {
    if (start > 0 && finish >= start && Number.isFinite(finish - start)) {
      setDefaultAttribute(span, `browser.dependency.${name}.duration`, finish - start);
    }
  };
  if (Number.isFinite(entry.duration) && entry.duration >= 0) {
    setDefaultAttribute(span, "browser.dependency.duration", entry.duration);
  }
  duration("dns", entry.domainLookupStart, entry.domainLookupEnd);
  duration("connect", entry.connectStart, entry.connectEnd);
  duration("tls", entry.secureConnectionStart, entry.connectEnd);
  duration("request", entry.requestStart, entry.responseStart);
  duration("response", entry.responseStart, entry.responseEnd);
  duration("redirect", entry.redirectStart, entry.redirectEnd);
}

/** Snapshots policy once and shares only the quota for instrumentations bound to one provider. */
export function createDependencyEnrichment(options: DependencyInstrumentationOptions) {
  const config = { ...options };
  for (const key of [
    "captureRequestHeaders",
    "captureResponseHeaders",
    "includeErrorStatusText",
    "enableResourceTiming",
  ] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      throw new TypeError(`dependencies.${key} must be a boolean`);
    }
  }
  const limit = config.maxDependenciesPerView;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new TypeError("dependencies.maxDependenciesPerView must be a nonnegative safe integer");
  }
  if (
    config.ignoreHeaders !== undefined &&
    (!Array.isArray(config.ignoreHeaders) ||
      config.ignoreHeaders.some(
        (name) => typeof name !== "string" || !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name),
      ))
  ) {
    throw new TypeError("dependencies.ignoreHeaders must contain HTTP header names");
  }
  const denied = new Set(SENSITIVE_HEADERS);
  for (const name of options.ignoreHeaders ?? []) denied.add(name.toLowerCase());
  const quotas = new WeakMap<TracerProvider, Quota>();
  const selected =
    config.captureRequestHeaders ||
    config.captureResponseHeaders ||
    config.includeErrorStatusText ||
    config.enableResourceTiming ||
    limit !== undefined;

  function captureHeaders(span: Span, direction: "request" | "response", headers: Headers): void {
    headers.forEach((value, name) => {
      if (!denied.has(name)) {
        setDefaultAttribute(span, `http.${direction}.header.${name}`, [value]);
      }
    });
  }

  function complete(span: Span, response: { status?: number; statusText?: string }): void {
    if (config.includeErrorStatusText && (response.status ?? 0) >= 400 && response.statusText) {
      setDefaultAttribute(span, "http.response.status_text", response.statusText);
    }
  }

  function adapt(
    instrumentation: BrowserInstrumentation & { instrumentationName: string },
    initiatorType: "fetch" | "xmlhttprequest",
  ) {
    let enabled = false;
    let current: RequestData | undefined;
    const requests = new WeakMap<Span, RequestData>();
    const pending = new Map<string, PendingTiming>();
    const cleanups: (() => void)[] = [];
    const enable = instrumentation.enable.bind(instrumentation);
    const disable = instrumentation.disable.bind(instrumentation);
    const setTracerProvider = instrumentation.setTracerProvider.bind(instrumentation);

    function patch<T extends object, K extends keyof T>(
      target: T,
      key: K,
      wrap: (original: T[K]) => T[K],
    ): void {
      const targets = (getSharedRegistry().dependencyPatches ??= new WeakMap());
      let methods = targets.get(target);
      if (!methods) targets.set(target, (methods = new Map<PropertyKey, DependencyPatch>()));
      const before = methods.get(key);
      const link: DependencyPatch = { previous: target[key] };
      const forward = function (this: unknown, ...args: unknown[]): unknown {
        if (typeof link.previous !== "function")
          throw new TypeError("Dependency patch is not callable");
        return Reflect.apply(link.previous, this, args) as unknown;
      };
      const value = wrap(forward as T[K]);
      target[key] = value;
      link.wrapper = value;
      if (before && before.wrapper === link.previous) {
        link.before = before;
        before.after = link;
      }
      methods.set(key, link);
      cleanups.push(() => {
        if (target[key] === value) target[key] = link.previous as T[K];
        if (link.after) {
          link.after.previous = link.previous;
          link.after.before = link.before;
        }
        if (link.before) link.before.after = link.after;
        if (methods.get(key) === link) {
          if (link.before) methods.set(key, link.before);
          else methods.delete(key);
        }
      });
    }

    function duringRequest<T>(request: RequestData | undefined, run: () => T): T {
      if (request && config.enableResourceTiming) {
        const competing = pending.get(request.url.split("#", 1)[0]);
        if (competing) competing.ambiguous = true;
        request.timing = competing ?? { count: 0, ambiguous: false };
      }
      const previous = current;
      current = request;
      try {
        return run();
      } finally {
        current = previous;
      }
    }

    function enrich(span: Span, run: () => void): void {
      if (!span.isRecording()) return;
      try {
        run();
      } catch {
        // Header parsing errors can include credentials. Never log the input or exception.
        reportError("Dependency enrichment failed");
      }
    }

    const adapter = {
      setTracerProvider(provider: TracerProvider): void {
        let quota = quotas.get(provider);
        if (!quota) {
          quota = { count: 0 };
          quotas.set(provider, quota);
        }
        const budget = quota;
        setTracerProvider({
          getTracer(...args) {
            const tracer = provider.getTracer(...args);
            return {
              startActiveSpan: tracer.startActiveSpan.bind(tracer),
              startSpan(name, options, parent = context.active()) {
                if (!enabled || isTracingSuppressed(parent)) {
                  return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
                }
                if (limit !== undefined) {
                  const page = getSharedRegistry().page?.correlation?.operation()?.traceId;
                  if (budget.page !== page) {
                    budget.page = page;
                    budget.count = 0;
                  }
                  if (budget.count >= limit) {
                    if (budget.count === limit) {
                      budget.count++;
                      diag.warn("Dependency limit reached for this page view");
                    }
                    return trace.wrapSpanContext(
                      trace.getSpanContext(parent) ?? INVALID_SPAN_CONTEXT,
                    );
                  }
                  budget.count++;
                }
                const span = tracer.startSpan(name, options, parent);
                if (current && span.isRecording()) {
                  requests.set(span, current);
                  if (current.timing) {
                    current.timing.count++;
                    pending.set(current.url.split("#", 1)[0], current.timing);
                  }
                  const headers = current.headers;
                  if (config.captureRequestHeaders && headers) {
                    enrich(span, () => captureHeaders(span, "request", headers));
                  }
                }
                return span;
              },
            };
          },
        });
      },
      enable(): void {
        if (enabled) return;
        if (cleanups.length)
          throw new Error("Dependency cleanup incomplete; disable before enabling");
        enable();
        if (typeof document === "undefined") return;
        enabled = true;
        try {
          install();
        } catch (error) {
          try {
            adapter.disable();
          } catch {
            reportError("Dependency initialization cleanup failed");
          }
          throw error;
        }
      },
      disable(): void {
        enabled = false;
        // Once wrappers are removed, competing requests are no longer observable.
        for (const timing of pending.values()) timing.ambiguous = true;
        pending.clear();
        const errors: unknown[] = [];
        for (let index = cleanups.length - 1; index >= 0; index--) {
          try {
            cleanups[index]();
            cleanups.splice(index, 1);
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          disable();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Dependency cleanup failed");
      },
    };

    let install = (): void => {};

    return {
      adapter: Object.assign(instrumentation, adapter),
      enrich,
      finish(span: Span): void {
        const request = requests.get(span);
        requests.delete(span);
        if (request?.timing) {
          const key = request.url.split("#", 1)[0];
          if (--request.timing.count === 0 && pending.get(key) === request.timing) {
            pending.delete(key);
          }
          enrich(span, () => addDependencyTiming(span, request, initiatorType));
        }
      },
      installFetch(): void {
        if (!config.enableResourceTiming) return;
        install = () => {
          patch(
            globalThis,
            "fetch",
            (original) =>
              function (this: unknown, ...args: Parameters<typeof fetch>) {
                if (!enabled) return original.apply(this, args);
                const input = args[0];
                let request: RequestData | undefined;
                try {
                  request = requestData(input instanceof Request ? input.url : String(input));
                } catch {
                  reportError("Dependency request timing setup failed");
                }
                return duringRequest(request, () => original.apply(this, args));
              },
          );
        };
      },
      installXhr(): void {
        if (!config.captureRequestHeaders && !config.enableResourceTiming) return;
        install = () => {
          let records = new WeakMap<XMLHttpRequest, RequestData>();
          cleanups.push(() => {
            records = new WeakMap();
          });
          const prototype = XMLHttpRequest.prototype;
          patch(
            prototype,
            "open",
            (open) =>
              function (
                this: XMLHttpRequest,
                ...args: [string, string | URL, boolean?, (string | null)?, (string | null)?]
              ) {
                const previous = records.get(this);
                let record: RequestData | undefined;
                if (enabled) {
                  try {
                    record = {
                      ...requestData(String(args[1])),
                      headers: config.captureRequestHeaders ? new Headers() : undefined,
                    };
                  } catch {
                    reportError("Dependency request setup failed");
                  }
                }
                // open() can synchronously dispatch readystatechange and application send().
                if (record) records.set(this, record);
                else records.delete(this);
                try {
                  Reflect.apply(open, this, args);
                } catch (error) {
                  if (records.get(this) === record) {
                    if (previous) records.set(this, previous);
                    else records.delete(this);
                  }
                  throw error;
                }
              },
          );
          if (config.captureRequestHeaders) {
            patch(
              prototype,
              "setRequestHeader",
              (setHeader) =>
                function (this: XMLHttpRequest, name, value) {
                  const result = setHeader.call(this, name, value);
                  if (enabled) {
                    try {
                      const normalized = String(name).toLowerCase();
                      if (!denied.has(normalized))
                        records.get(this)?.headers?.append(normalized, value);
                    } catch {
                      reportError("Dependency request header capture failed");
                    }
                  }
                  return result;
                },
            );
          }
          patch(
            prototype,
            "send",
            (send) =>
              function (this: XMLHttpRequest, body) {
                const record = enabled ? records.get(this) : undefined;
                const request = record && {
                  ...record,
                  start: performance.now(),
                  headers: record.headers && new Headers(record.headers),
                };
                return duringRequest(request, () => send.call(this, body));
              },
          );
        };
      },
    };
  }

  return {
    fetch(instrumentation: FetchInstrumentation): BrowserInstrumentation {
      if (!selected) return instrumentation;
      const state = adapt(instrumentation, "fetch");
      const original = instrumentation.getConfig();
      instrumentation.setConfig({
        ...original,
        requestHook(span, request) {
          try {
            original.requestHook?.(span, request);
          } finally {
            if (config.captureRequestHeaders) {
              state.enrich(span, () =>
                captureHeaders(span, "request", new Headers(request.headers)),
              );
            }
          }
        },
        applyCustomAttributesOnSpan(span, request, response) {
          state.enrich(span, () => {
            if (config.captureResponseHeaders && response instanceof Response) {
              captureHeaders(span, "response", response.headers);
            }
            complete(span, response);
          });
          state.finish(span);
          original.applyCustomAttributesOnSpan?.(span, request, response);
        },
      });
      state.installFetch();
      return state.adapter;
    },
    xhr(instrumentation: XhrInstrumentation): BrowserInstrumentation {
      if (!selected) return instrumentation;
      const state = adapt(instrumentation, "xmlhttprequest");
      const original = instrumentation.getConfig();
      instrumentation.setConfig({
        ...original,
        applyCustomAttributesOnSpan(span, xhr) {
          state.enrich(span, () => {
            if (config.captureResponseHeaders) {
              const headers = new Headers();
              for (const line of xhr.getAllResponseHeaders().split(/[\r\n]+/)) {
                const colon = line.indexOf(":");
                if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
              }
              captureHeaders(span, "response", headers);
            }
            complete(span, xhr);
          });
          state.finish(span);
          original.applyCustomAttributesOnSpan?.(span, xhr);
        },
      });
      state.installXhr();
      return state.adapter;
    },
  };
}
