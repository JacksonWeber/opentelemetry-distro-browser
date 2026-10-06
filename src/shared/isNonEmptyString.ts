// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function selectNonEmptyString(value: unknown, fallback: unknown): string | undefined {
  if (isNonEmptyString(value)) return value;
  return isNonEmptyString(fallback) ? fallback : undefined;
}
