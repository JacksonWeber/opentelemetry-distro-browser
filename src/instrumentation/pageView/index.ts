// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export {
  PAGE_VIEW_INSTRUMENTATION_NAME,
  PageViewInstrumentation,
} from "./pageViewInstrumentation.js";
export { createPageViewContext, generatePageViewId } from "./pageViewContext.js";
export type {
  InternalPageViewInstrumentationConfig,
  PageView,
  PageViewContext,
  PageViewDurationSource,
  PageViewInstrumentationConfig,
  PageViewListener,
  PageViewNameSource,
  PageViewNavigationType,
  PageViewSource,
} from "./types.js";

// `semconv.js` is intentionally not re-exported. The event name and attribute keys are an internal
// mapping layer, so an upstream convention change stays a table edit instead of a breaking change
// to this package's public API.
