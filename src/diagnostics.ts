// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  diag,
  context,
  DiagConsoleLogger,
  DiagLogLevel,
  ROOT_CONTEXT,
  type DiagLogger,
} from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { suppressTracing } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  getSharedRegistry,
  isReportingSdkStats,
  reportWithoutTelemetry,
} from "./shared/globalOwnership.js";
import { runLifecycleTasks } from "./shared/lifecycle.js";
import type { MicrosoftOpenTelemetryBrowserDiagnosticsOptions } from "./types.js";

const levels = [0, 30, 50, 60, 70, 80, 9999];

/** Validates and snapshots options before startup can yield or change global state. */
export function captureDiagnostics(options?: MicrosoftOpenTelemetryBrowserDiagnosticsOptions): {
  consoleLogLevel: DiagLogLevel;
  telemetryLogLevel: DiagLogLevel;
  logRecordProcessors: LogRecordProcessor[] | undefined;
} {
  if (
    options !== undefined &&
    (typeof options !== "object" ||
      options === null ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => !["consoleLogLevel", "telemetryLogLevel", "logRecordProcessors"].includes(key),
      ))
  ) {
    throw new TypeError("diagnostics must contain only supported diagnostic options.");
  }
  const { consoleLogLevel = DiagLogLevel.INFO, telemetryLogLevel = DiagLogLevel.NONE } =
    options ?? {};
  if (!levels.includes(consoleLogLevel) || !levels.includes(telemetryLogLevel)) {
    throw new TypeError("diagnostics levels must be OpenTelemetry DiagLogLevel values.");
  }
  const processors = options?.logRecordProcessors;
  if (processors !== undefined) {
    if (!Array.isArray(processors)) {
      throw new TypeError("diagnostics.logRecordProcessors must be an array.");
    }
    for (const processor of processors as readonly LogRecordProcessor[]) {
      if (
        !processor ||
        typeof processor.onEmit !== "function" ||
        typeof processor.forceFlush !== "function" ||
        typeof processor.shutdown !== "function"
      ) {
        throw new TypeError("diagnostics.logRecordProcessors must contain log processors.");
      }
    }
    if (new Set(processors).size !== processors.length) {
      throw new TypeError("diagnostics.logRecordProcessors must contain distinct log processors.");
    }
  }
  return { consoleLogLevel, telemetryLogLevel, logRecordProcessors: processors?.slice() };
}

/** Shared across compatible package copies; never registered as the global log provider. */
export interface SharedDiagnostics {
  users: number;
  ready?: Promise<void>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

function createDiagnostics(options: ReturnType<typeof captureDiagnostics>) {
  const { consoleLogLevel, telemetryLogLevel } = options;
  const consoleLogger = new DiagConsoleLogger();
  let processors = options.logRecordProcessors ?? [];
  let provider = processors.length
    ? new LoggerProvider({
        resource: resourceFromAttributes({}),
        processors: processors.map((processor): LogRecordProcessor => ({
          enabled(options) {
            try {
              return processor.enabled?.(options) ?? true;
            } catch {
              return false;
            }
          },
          onEmit(record, ctx) {
            try {
              processor.onEmit(record, ctx);
            } catch {
              /* Isolate sibling diagnostic processors. */
            }
          },
          async forceFlush() {},
          async shutdown() {},
        })),
      })
    : undefined;
  let logger: Logger | undefined = provider?.getLogger(
    "@microsoft/opentelemetry-browser/diagnostics",
  );
  let reporting = false;
  let flushPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const seen = new Set<string>();
  const lifecycle = (callback: () => Promise<void>): Promise<void> => {
    let result!: Promise<void>;
    reportWithoutTelemetry(() => {
      result = context.with(suppressTracing(ROOT_CONTEXT), callback);
    });
    return result;
  };
  const log =
    (name: keyof DiagLogger, level: DiagLogLevel, severityNumber: SeverityNumber) =>
    (message: string, ...args: unknown[]): void => {
      if (reporting) return;
      const suppressed = isReportingSdkStats();
      reporting = true;
      try {
        reportWithoutTelemetry(() => {
          if (level <= consoleLogLevel) {
            try {
              consoleLogger[name](message, ...args);
            } catch {
              /* Diagnostics must not interrupt applications. */
            }
          }
          if (!logger || suppressed || level > telemetryLogLevel || seen.size >= 100) return;
          // ComponentLogger forwards its namespace first, followed by its actual message.
          const text = typeof args[0] === "string" ? `${message} ${args[0]}` : message;
          const body = typeof text === "string" ? text.slice(0, 4096) : "SDK diagnostic";
          const key = `${name}:${body}`;
          if (seen.has(key)) return;
          // Also bounds asynchronous exporter-failure feedback, after the synchronous guard ends.
          seen.add(key);
          context.with(suppressTracing(ROOT_CONTEXT), () =>
            logger?.emit({
              body,
              severityNumber,
              severityText: name.toUpperCase(),
              context: ROOT_CONTEXT,
            }),
          );
        });
      } catch {
        // A custom processor or console must not break customer telemetry or cleanup.
      } finally {
        reporting = false;
      }
    };
  const diagnosticLogger: DiagLogger = {
    error: log("error", DiagLogLevel.ERROR, SeverityNumber.ERROR),
    warn: log("warn", DiagLogLevel.WARN, SeverityNumber.WARN),
    info: log("info", DiagLogLevel.INFO, SeverityNumber.INFO),
    debug: log("debug", DiagLogLevel.DEBUG, SeverityNumber.DEBUG),
    verbose: log("verbose", DiagLogLevel.VERBOSE, SeverityNumber.TRACE),
  };
  const shared: SharedDiagnostics = {
    users: 0,
    forceFlush() {
      if (!provider) return shutdownPromise ?? Promise.resolve();
      const previous = flushPromise ?? Promise.resolve();
      const operation = previous
        .catch(() => {})
        .then(() => {
          if (!provider) return;
          return runLifecycleTasks(
            processors.map((processor) => () => lifecycle(() => processor.forceFlush())),
            "Diagnostic flush failed",
          );
        });
      const tracked = operation.finally(() => {
        if (flushPromise === tracked) flushPromise = undefined;
      });
      flushPromise = tracked;
      return flushPromise;
    },
    shutdown() {
      if (!shutdownPromise) {
        const current = provider;
        const flushing = flushPromise;
        provider = undefined;
        logger = undefined;
        seen.clear();
        shutdownPromise = runLifecycleTasks(
          flushing ? [() => flushing] : [],
          "Diagnostic shutdown failed",
          current
            ? [
                ...processors.map((processor) => () => lifecycle(() => processor.shutdown())),
                () => current.shutdown(),
              ]
            : [],
        ).finally(() => {
          processors = [];
        });
      }
      return shutdownPromise;
    },
  };
  return {
    shared,
    logger: diagnosticLogger,
    logLevel: Math.max(consoleLogLevel, telemetryLogLevel),
  };
}

/** Acquires one reference without replacing a later application-provided diagnostic logger. */
export async function acquireDiagnostics(options = captureDiagnostics()) {
  const registry = getSharedRegistry();
  if (!registry.diagInitialized) {
    const diagnostic = createDiagnostics(options);
    // Reserve before OpenTelemetry calls the previous logger, which can re-enter initialization.
    registry.diagInitialized = true;
    registry.diagnostics = diagnostic.shared;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    diagnostic.shared.ready = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    void diagnostic.shared.ready.catch(() => {});
    try {
      reportWithoutTelemetry(() => {
        registry.diagInitialized = diag.setLogger(diagnostic.logger, diagnostic.logLevel);
      });
      if (!registry.diagInitialized) {
        registry.diagnostics = undefined;
        await diagnostic.shared.shutdown();
      }
      resolve();
    } catch (error) {
      reject(error);
      registry.diagInitialized = false;
      registry.diagnostics = undefined;
      try {
        await diagnostic.shared.shutdown();
      } catch {
        /* Preserve the registration error. */
      }
      throw error;
    }
  }
  const shared = registry.diagnostics;
  if (shared) shared.users++;
  try {
    await shared?.ready;
  } catch (error) {
    if (shared) shared.users--;
    throw error;
  }
  let released = false;
  return {
    forceFlush: () => (released ? Promise.resolve() : (shared?.forceFlush() ?? Promise.resolve())),
    shutdown() {
      if (released) return Promise.resolve();
      released = true;
      return shared && --shared.users === 0 ? shared.shutdown() : Promise.resolve();
    },
  };
}
