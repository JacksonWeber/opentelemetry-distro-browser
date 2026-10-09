// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ContextManager, TextMapPropagator } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { Resource } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import type { SessionManagerConfig } from "@opentelemetry/browser-sdk/session";
import { expectTypeOf, it } from "vitest";
import {
  AzureMonitorLogRecordExporter,
  AzureMonitorSpanExporter,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
  type MicrosoftOpenTelemetryBrowserSessionOptions,
  type MicrosoftOpenTelemetryBrowserTraceOptions,
  type MicrosoftOpenTelemetryBrowserUserContext,
  type PageViewInstrumentationConfig,
} from "../../../src/index.js";

it("exposes distro-owned configuration and lifecycle contracts", () => {
  expectTypeOf(useMicrosoftOpenTelemetry)
    .parameter(0)
    .toEqualTypeOf<MicrosoftOpenTelemetryBrowserOptions | undefined>();
  expectTypeOf(useMicrosoftOpenTelemetry).returns.toEqualTypeOf<
    Promise<MicrosoftOpenTelemetryBrowser>
  >();
  expectTypeOf<keyof MicrosoftOpenTelemetryBrowserOptions>().toEqualTypeOf<
    | "resource"
    | "samplingPercentage"
    | "azureMonitor"
    | "spanProcessors"
    | "logRecordProcessors"
    | "instrumentations"
    | "pageView"
    | "session"
    | "userContext"
    | "traces"
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["resource"]>().toEqualTypeOf<
    Resource | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["traces"]>().toEqualTypeOf<
    MicrosoftOpenTelemetryBrowserTraceOptions | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserTraceOptions["contextManager"]>().toEqualTypeOf<
    ContextManager | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserTraceOptions["propagators"]>().toEqualTypeOf<
    readonly TextMapPropagator[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["session"]>().toEqualTypeOf<
    MicrosoftOpenTelemetryBrowserSessionOptions | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["userContext"]>().toEqualTypeOf<
    { enabled?: boolean } | undefined
  >();
  expectTypeOf<keyof MicrosoftOpenTelemetryBrowserSessionOptions>().toEqualTypeOf<
    "enabled" | "persist" | "inactivityTimeout" | "maxDuration"
  >();
  expectTypeOf<
    Pick<MicrosoftOpenTelemetryBrowserSessionOptions, "inactivityTimeout" | "maxDuration">
  >().toEqualTypeOf<Pick<SessionManagerConfig, "inactivityTimeout" | "maxDuration">>();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["azureMonitor"]>().toEqualTypeOf<
    AzureMonitorOptions | undefined
  >();
  expectTypeOf<keyof AzureMonitorOptions>().toEqualTypeOf<"connectionString" | "disableBeacon">();
  expectTypeOf(AzureMonitorSpanExporter).constructorParameters.toEqualTypeOf<
    [options: AzureMonitorOptions]
  >();
  expectTypeOf(AzureMonitorLogRecordExporter).constructorParameters.toEqualTypeOf<
    [options: AzureMonitorOptions]
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["spanProcessors"]>().toEqualTypeOf<
    SpanProcessor[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["logRecordProcessors"]>().toEqualTypeOf<
    LogRecordProcessor[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["instrumentations"]>().toEqualTypeOf<
    readonly BrowserInstrumentation[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["pageView"]>().toEqualTypeOf<
    PageViewInstrumentationConfig | undefined
  >();
  expectTypeOf<Instrumentation>().toExtend<BrowserInstrumentation>();
  expectTypeOf<MicrosoftOpenTelemetryBrowser["forceFlush"]>().toEqualTypeOf<() => Promise<void>>();
  expectTypeOf<
    MicrosoftOpenTelemetryBrowser["userContext"]
  >().toEqualTypeOf<MicrosoftOpenTelemetryBrowserUserContext>();
});
