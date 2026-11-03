// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getOperationName, getSharedRegistry } from "../shared/globalOwnership.js";

/** Snapshots managed page context without adding vendor attributes to OpenTelemetry records. */
export function setManagedOperationName(record: object, name: string | undefined): void {
  const registry = getSharedRegistry();
  if (name) {
    (registry.operationNames ??= new WeakMap()).set(record, name);
  } else {
    registry.operationNames?.delete(record);
  }
}

/** Preserves managed context when a processor derives another record object. */
export function copyManagedOperationName(source: object, target: object): void {
  setManagedOperationName(target, getOperationName(source));
}

/** Reads page context captured when the record entered its provider pipeline. */
export function getManagedOperationName(record: object): string | undefined {
  return getOperationName(record);
}
