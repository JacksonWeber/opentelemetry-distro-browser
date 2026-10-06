// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export * from "./coexistenceEntry.mjs";

export function loadRemote() {
  return import("coexistenceRemote/telemetry");
}
