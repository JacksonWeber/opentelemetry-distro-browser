// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { MAX_RETRY_AFTER_MS } from "./constants.js";

export interface BreezeError {
  readonly index: number;
  readonly statusCode: number;
  readonly message: string;
}

export interface BreezeResponse {
  readonly itemsReceived: number;
  readonly itemsAccepted: number;
  readonly errors: readonly BreezeError[];
}

export function parseBreezeResponse(responseBody: string): BreezeResponse | undefined {
  let value: unknown;
  try {
    value = JSON.parse(responseBody) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.errors) || !value.errors.every(isBreezeError)) {
    return undefined;
  }
  if (typeof value.itemsReceived !== "number" || typeof value.itemsAccepted !== "number") {
    return undefined;
  }
  return {
    itemsReceived: value.itemsReceived,
    itemsAccepted: value.itemsAccepted,
    errors: value.errors,
  };
}

export function isRetriable(statusCode: number): boolean {
  return (
    statusCode === 206 ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 439 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  );
}

export function isSamplingRejection(error: BreezeError): boolean {
  return error.message.toLowerCase() === "telemetry sampled out.";
}

export function parseRetryAfterHeader(retryAfter: string | null): number | undefined {
  if (!retryAfter) {
    return undefined;
  }

  const trimmed = retryAfter.trim();
  if (/^\d+$/.test(trimmed)) {
    const delaySeconds = Number(trimmed);
    return delaySeconds > 0 ? Math.min(delaySeconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }

  const delayMs = date - Date.now();
  return delayMs > 0 ? Math.min(delayMs, MAX_RETRY_AFTER_MS) : undefined;
}

function isBreezeError(value: unknown): value is BreezeError {
  return (
    isRecord(value) &&
    typeof value.index === "number" &&
    typeof value.statusCode === "number" &&
    typeof value.message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
