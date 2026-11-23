// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, type Context } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { ErrorsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/errors";
import { SKIP_PAGE_FALLBACK } from "../../shared/pageOperationContext.js";
import type { InstrumentationOptions } from "../../types.js";
import { getInstrumentations as create } from "./getInstrumentations.js";

type Snapshot = [timestamp: number, name?: string, message?: string, stack?: string, ctx?: Context];

/** The combined CDN SDK takes over the loader's queue once, when live collection starts. */
export async function getInstrumentations(
  options?: InstrumentationOptions,
  onErrorsEnabled?: (emit: (snapshot: Snapshot, samePage?: boolean) => void) => void,
) {
  if (!onErrorsEnabled || options?.errors?.enabled !== true) return create(options);

  class LoaderErrors extends ErrorsInstrumentation {
    override enable(): void {
      super.enable();
      onErrorsEnabled?.(([timestamp, name, message, stack, ctx = ROOT_CONTEXT], samePage) => {
        this.logger.emit({
          timestamp,
          context: samePage ? ctx : ctx.setValue(SKIP_PAGE_FALLBACK, true),
          eventName: "exception",
          severityNumber: SeverityNumber.ERROR,
          attributes: {
            "exception.type": name,
            "exception.message": message,
            "exception.stacktrace": stack,
          },
        });
      });
      onErrorsEnabled = undefined;
    }
  }
  const { errors, ...others } = options;
  return [...(await create(others)), new LoaderErrors({ ...errors, enabled: false })];
}
