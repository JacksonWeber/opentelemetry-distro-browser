// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { getInstrumentations, createClickAnalyticsInstrumentation } from "./getInstrumentations.js";
export type { BrowserInstrumentation, InstrumentationOptions } from "../../types.js";
export {
  BehaviorMapValidator,
  BehaviorValueValidator,
  BehaviorEnumValidator,
} from "../clickAnalytics/validators.js";
export type {
  ClickAnalyticsInstrumentation,
  ClickAnalyticsInstrumentationConfig,
  ClickAnalyticsPageAction,
  ClickAnalyticsPageActionOverrides,
  ClickAnalyticsProperties,
} from "../clickAnalytics/types.js";
