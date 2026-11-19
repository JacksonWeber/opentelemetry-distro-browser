// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SeverityNumber } from "@opentelemetry/api-logs";
import { ErrorsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/errors";
import type { InstrumentationOptions } from "../../types.js";
import { getInstrumentations as create } from "./getInstrumentations.js";

type Snapshot = [timestamp: number, name?: string, message?: string, stack?: string];

/** The optional CDN loader handshake runs once, when this instance takes over live collection. */
export async function getInstrumentations(
  options?: InstrumentationOptions,
  onErrorsEnabled?: (emit: (snapshot: Snapshot) => void) => void,
) {
  if (!onErrorsEnabled || options?.errors?.enabled !== true) return create(options);

  class LoaderErrors extends ErrorsInstrumentation {
    override enable(): void {
      super.enable();
      onErrorsEnabled?.(([timestamp, name, message, stack]) => {
        this.logger.emit({
          timestamp,
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
  const others = await create({ ...options, errors: { enabled: false } });
  return [...others, new LoaderErrors({ ...options.errors, enabled: false })];
}
