// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeConfiguration,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
} from "../../../src/configuration/runtimeConfiguration.js";

const invalid = (value: unknown) => value as MicrosoftOpenTelemetryBrowserConfigurationUpdate;

function create(initial: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {}) {
  let stopped = false;
  const controller = createRuntimeConfiguration(initial, () => stopped);
  return {
    controller,
    stop: () => {
      stopped = true;
    },
  };
}

describe("sampling configuration", () => {
  it("starts with a frozen default or explicit initial policy", () => {
    const { controller } = create();
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    expect(create({ samplingPercentage: 0 }).controller.snapshot().samplingPercentage).toBe(0);
  });

  it("commits sequential revisions and preserves snapshots", async () => {
    const { controller } = create();
    const original = controller.snapshot();
    const first = controller.updateCfg({ samplingPercentage: 25 });
    const second = controller.updateCfg({ samplingPercentage: 0 });
    expect(controller.snapshot()).toBe(original);
    expect(await first).toEqual({ revision: 1, changedPaths: ["samplingPercentage"] });
    expect(await second).toEqual({ revision: 2, changedPaths: ["samplingPercentage"] });
    expect(controller.snapshot().samplingPercentage).toBe(0);
    expect(original.samplingPercentage).toBeUndefined();
  });

  it("captures queued input and freezes results", async () => {
    const { controller } = create();
    const patch = { samplingPercentage: 25 };
    const operation = controller.updateCfg(patch);
    patch.samplingPercentage = 90;
    const result = await operation;
    expect(controller.snapshot().samplingPercentage).toBe(25);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.changedPaths)).toBe(true);
  });

  it("distinguishes omission, explicit undefined and replacement resets", async () => {
    const { controller } = create({ samplingPercentage: 50 });
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
    expect(await controller.updateCfg({ samplingPercentage: undefined })).toEqual({
      revision: 1,
      changedPaths: ["samplingPercentage"],
    });
    await controller.updateCfg({ samplingPercentage: 100 });
    expect(await controller.updateCfg({ samplingPercentage: 100 })).toEqual({
      revision: 2,
      changedPaths: [],
    });
    expect(await controller.updateCfg({}, false)).toEqual({
      revision: 3,
      changedPaths: ["samplingPercentage"],
    });
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
  });

  it.each([NaN, Infinity, -1, 101, "25", null, true])(
    "rejects invalid percentages: %s",
    async (value) => {
      const { controller } = create({ samplingPercentage: 50 });
      await expect(controller.updateCfg(invalid({ samplingPercentage: value }))).rejects.toThrow();
      expect(controller.snapshot().samplingPercentage).toBe(50);
      expect(await controller.updateCfg({ samplingPercentage: 25 })).toEqual({
        revision: 1,
        changedPaths: ["samplingPercentage"],
      });
    },
  );

  it.each([null, [], 1, "config", new Date(), { session: {} }, { azureMonitor: {} }])(
    "rejects unsupported patches: %s",
    async (value) => {
      const { controller } = create();
      await expect(controller.updateCfg(invalid(value))).rejects.toThrow();
      expect(controller.snapshot().samplingPercentage).toBeUndefined();
    },
  );

  it("rejects mixed valid/unsupported fields before queuing any change", async () => {
    const { controller } = create({ samplingPercentage: 50 });
    await expect(
      controller.updateCfg(invalid({ samplingPercentage: 0, resource: {} })),
    ).rejects.toThrow("Unsupported configuration path: resource");
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it("rejects accessors, inherited options, symbols and pollution keys without executing getters", async () => {
    const { controller } = create();
    const getter = vi.fn(() => 25);
    const accessor = Object.defineProperty({}, "samplingPercentage", { get: getter });
    await expect(controller.updateCfg(accessor)).rejects.toThrow("data property");
    expect(getter).not.toHaveBeenCalled();
    await expect(
      controller.updateCfg(invalid(Object.create({ samplingPercentage: 0 }))),
    ).rejects.toThrow("plain object");
    await expect(
      controller.updateCfg(invalid({ [Symbol("samplingPercentage")]: 0 })),
    ).rejects.toThrow("Unsupported");
    await expect(controller.updateCfg(invalid(JSON.parse('{"__proto__":{}}')))).rejects.toThrow(
      "Unsupported",
    );
  });

  it("accepts null-prototype data without exposing a mutable snapshot", async () => {
    const { controller } = create();
    const patch = Object.create(null) as MicrosoftOpenTelemetryBrowserConfigurationUpdate;
    patch.samplingPercentage = 25;
    await controller.updateCfg(patch);
    expect(controller.snapshot().samplingPercentage).toBe(25);
  });

  it("validates mergeExisting and initial values", async () => {
    const { controller } = create();
    await expect(controller.updateCfg({}, undefined as unknown as boolean)).resolves.toEqual({
      revision: 0,
      changedPaths: [],
    });
    await expect(controller.updateCfg({}, 1 as unknown as boolean)).rejects.toThrow(
      "mergeExisting",
    );
    expect(() => create({ samplingPercentage: NaN })).toThrow();
  });

  it("rejects pending and future changes immediately after shutdown begins", async () => {
    const { controller, stop } = create();
    const queued = controller.updateCfg({ samplingPercentage: 0 });
    stop();
    await expect(queued).rejects.toThrow("stopped");
    await expect(controller.updateCfg({ samplingPercentage: 100 })).rejects.toThrow("stopped");
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
  });
});
