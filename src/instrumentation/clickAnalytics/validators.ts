// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Creates an Application Insights-compatible behavior dictionary validator.
 * @public
 */
export function BehaviorMapValidator(
  map: Readonly<Record<string, string | number>>,
): (key: string | number) => string | number {
  return (key) => (Object.hasOwn(map, key) ? map[key] || "" : "");
}

/**
 * Creates an exact-match behavior allowlist validator.
 * @public
 */
export function BehaviorValueValidator(
  values: readonly string[],
): (key: string | number) => string {
  return (key) => (typeof key === "string" && values.includes(key) ? key : "");
}

/**
 * Creates an Application Insights-compatible enum validator, including numeric reverse lookup.
 * @public
 */
export function BehaviorEnumValidator(
  values: Readonly<Record<string, string | number>>,
): (key: string | number) => string | number {
  return BehaviorMapValidator(values);
}
