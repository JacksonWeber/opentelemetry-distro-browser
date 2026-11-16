// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { SeverityNumber, type LogRecord } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createClickAnalyticsInstrumentation } from "../../../src/instrumentation/browserInstrumentation/index.js";
import { ClickAnalyticsInstrumentation } from "../../../src/instrumentation/clickAnalytics/clickAnalyticsInstrumentation.js";
import {
  getElementContent,
  getMetadata,
  isDoNotTrack,
} from "../../../src/instrumentation/clickAnalytics/content.js";
import type {
  ClickAnalyticsInstrumentationConfig,
  ClickAnalyticsPageAction,
} from "../../../src/instrumentation/clickAnalytics/types.js";
import {
  BehaviorEnumValidator,
  BehaviorMapValidator,
  BehaviorValueValidator,
} from "../../../src/instrumentation/clickAnalytics/validators.js";
import type { BrowserInstrumentation } from "../../../src/types.js";

const fixtures: Element[] = [];
const active: BrowserInstrumentation[] = [];
const providers: LoggerProvider[] = [];

function mount(markup: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.append(root);
  fixtures.push(root);
  return root;
}

function element(markup: string, selector = "button"): Element {
  const target = mount(markup).querySelector(selector);
  if (!target) throw new Error(`Missing fixture element: ${selector}`);
  return target;
}

function meta(name: string, content: string): HTMLMetaElement {
  const tag = document.createElement("meta");
  tag.name = name;
  tag.content = content;
  document.head.append(tag);
  fixtures.push(tag);
  return tag;
}

function createInstrumentation(config: ClickAnalyticsInstrumentationConfig = {}) {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
  const instrumentation = new ClickAnalyticsInstrumentation({ ...config, enabled: false });
  active.push(instrumentation);
  providers.push(provider);
  instrumentation.setLoggerProvider(provider);
  return {
    instrumentation,
    async records() {
      await provider.forceFlush();
      return exporter.getFinishedLogRecords();
    },
  };
}

function mouse(target: Element, button = 0): void {
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, button, clientX: 12, clientY: 34 }),
  );
}

function keyboard(target: Element, key: string, keyCode = 0): KeyboardEvent {
  const event = new KeyboardEvent("keyup", { bubbles: true, key, keyCode });
  target.dispatchEvent(event);
  return event;
}

afterEach(async () => {
  for (const instrumentation of active.splice(0)) instrumentation.disable();
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
  for (const fixture of fixtures.splice(0)) fixture.remove();
  vi.restoreAllMocks();
});

describe("click analytics content", () => {
  it.each(
    ["name", "id"].flatMap((attribute) =>
      ["content", "parent", "dnt"].map((mode) => ({ attribute, mode })),
    ),
  )(
    "bounds $mode traversal when a form control has $attribute=parentElement",
    ({ attribute, mode }) => {
      const target = element(
        `<section data-ai-dnt="true" data-id="outer"><form><input ${attribute}="parentElement"><button data-id="child"></button></form></section>`,
      );
      const form = target.closest("form")!;
      const input = form.querySelector("input")!;
      expect(form.parentElement).toBe(input);
      // Bound the old form -> input -> form cycle so this regression cannot hang the runner.
      let reads = 0;
      Object.defineProperty(input, "parentElement", {
        configurable: true,
        get: () => {
          if (++reads > 10) throw new Error("Cyclic parentElement traversal");
          return form;
        },
      });
      if (mode === "dnt") {
        expect(isDoNotTrack(target, {})).toBe(true);
      } else {
        if (mode === "parent") target.setAttribute("data-ai-blob", '{"id":"child"}');
        expect(
          getElementContent(target, { dataTags: { parentDataTag: "boundary" } }).parentid,
        ).toBe("outer");
      }
      expect(reads).toBe(0);
      if (mode === "dnt") {
        target.closest("section")!.removeAttribute("data-ai-dnt");
        expect(isDoNotTrack(target, {})).toBe(false);
      }
    },
  );

  it.each(["name", "id"])(
    "reads parent attributes despite %s-based form clobbering",
    (attribute) => {
      for (const blob of [false, true]) {
        const target = element(
          `<form ${blob ? 'data-ai-blob=\'{"id":"parent"}\'' : 'data-id="parent"'}><input ${attribute}="getAttribute"><input ${attribute}="attributes"><input ${attribute}="hasAttribute"><button data-id="child"></button></form>`,
        );
        expect(
          getElementContent(target, { dataTags: { parentDataTag: "boundary" } }).parentid,
        ).toBe("parent");
      }
    },
  );

  it("does not collect untagged HTML identifiers, text or input values by default", () => {
    for (const target of mount(
      '<button id="private">Private text</button><input id="secret" value="private value">',
    ).children) {
      expect(getElementContent(target, {})).toEqual({});
    }
  });

  it("preserves tagged DOM casing and does not add HTML fallbacks unless opted in", () => {
    const target = element(
      '<button id="html-id" data-id="tag-id" data-contentName="tag name" data-count="0">HTML text</button>',
    );
    expect(getElementContent(target, {})).toEqual({
      id: "tag-id",
      contentname: "tag name",
      count: "0",
    });
  });

  it.each([
    ['<button id="html-id">Button text</button>', "button", "Button text"],
    ['<a id="html-id" href="/destination">Link <b>text</b></a>', "a", "Link text"],
    ['<img id="html-id" alt="Image name">', "img", "Image name"],
    ['<area id="html-id" alt="Area name">', "area", "Area name"],
    ['<input id="html-id" name="input-name" value="Input value">', "input", "Input value"],
    ['<input id="html-id" name="input-name">', "input", "input-name"],
    ['<button id="html-id"></button>', "button", "html-id"],
  ])("uses opted-in default HTML content for %s", (markup, selector, name) => {
    expect(
      getElementContent(element(markup, selector), {
        dataTags: { useDefaultContentNameOrId: true },
      }),
    ).toEqual({ id: "html-id", contentName: name });
  });

  it("fills an empty tagged ID from HTML while keeping explicit tagged content separate", () => {
    expect(
      getElementContent(
        element('<button id="html" data-id="" data-contentname="tag">Text</button>'),
        {
          dataTags: { useDefaultContentNameOrId: true },
        },
      ),
    ).toEqual({ id: "html", contentname: "tag", contentName: "Text" });
  });

  it("limits default names to 200 characters, but does not truncate callback names", () => {
    const target = element(`<button id="html">${"x".repeat(250)}</button>`);
    const contentName = vi.fn(() => "custom".repeat(50));
    expect(
      getElementContent(target, { dataTags: { useDefaultContentNameOrId: true } }).contentName,
    ).toBe("x".repeat(200));
    expect(
      getElementContent(target, {
        dataTags: { useDefaultContentNameOrId: true },
        callback: { contentName },
      }).contentName,
    ).toBe("custom".repeat(50));
    expect(contentName).toHaveBeenCalledWith(target, true);
    expect(
      getElementContent(target, {
        dataTags: { useDefaultContentNameOrId: true },
        callback: { contentName: () => "" },
      }).contentName,
    ).toBe("x".repeat(200));
  });

  it("does not invoke the HTML callback unless opted in, or when a blob is present", () => {
    const target = element('<button data-ai-blob=\'{"id":"blob"}\'>Text</button>');
    const contentName = vi.fn(() => "callback");
    expect(getElementContent(target, { callback: { contentName } })).toEqual({ id: "blob" });
    expect(
      getElementContent(target, {
        dataTags: { useDefaultContentNameOrId: true },
        callback: { contentName },
      }),
    ).toEqual({ id: "blob" });
    target.removeAttribute("data-ai-blob");
    expect(getElementContent(target, { callback: { contentName } })).toEqual({});
    expect(contentName).not.toHaveBeenCalled();
  });

  it("gives nonempty blobs precedence over tags and HTML and retains useful JSON values", () => {
    const target = element('<button id="html" data-id="tag" data-extra="ignored">Text</button>');
    target.setAttribute(
      "data-ai-blob",
      JSON.stringify({
        id: "blob",
        contentName: "blob name",
        zero: 0,
        no: false,
        nested: { value: 1 },
        items: [1, "two"],
        emptyArray: [],
        empty: "",
        nil: null,
        emptyObject: {},
      }),
    );
    const before = target.outerHTML;
    expect(getElementContent(target, { dataTags: { useDefaultContentNameOrId: true } })).toEqual({
      id: "blob",
      contentName: "blob name",
      zero: 0,
      no: false,
      nested: { value: 1 },
      items: [1, "two"],
      emptyArray: [],
    });
    expect(target.outerHTML).toBe(before);
  });

  it.each(["{invalid", "[]", "null", "42", '"text"', "true", "{}"])(
    "does not fall back to tags or HTML for a nonempty invalid or empty-object blob %s",
    (blob) => {
      const target = element('<button id="html" data-id="tag">Text</button>');
      target.setAttribute("data-ai-blob", blob);
      expect(getElementContent(target, { dataTags: { useDefaultContentNameOrId: true } })).toEqual(
        {},
      );
    },
  );

  it("treats an explicitly empty blob as untagged rather than falling back to individual tags", () => {
    const target = element('<button id="html" data-id="tag" data-ai-blob="">Text</button>');
    expect(getElementContent(target, {})).toEqual({});
    expect(getElementContent(target, { dataTags: { useDefaultContentNameOrId: true } })).toEqual({
      id: "html",
      contentName: "Text",
    });
  });

  it("does not collect ancestor content or parent identity without a nonempty parent tag", () => {
    const target = element(
      '<section data-id="parent" data-extra="ancestor"><button data-id="child"></button></section>',
    );
    expect(getElementContent(target, {})).toEqual({ id: "child" });
    expect(getElementContent(target, { dataTags: { parentDataTag: "" } })).toEqual({ id: "child" });
  });

  it("merges nearest assigned ancestor values and excludes ancestor IDs and blobs", () => {
    const target = element(`
      <section data-id="outer" data-category="outer" data-outer="yes">
        <div data-id="parent" data-category="near" data-empty="filled" data-ai-blob='{"id":"blob-parent","hidden":"no"}'>
          <button data-id="child" data-category="child" data-empty="" data-zero="0"></button>
        </div>
      </section>`);
    expect(getElementContent(target, { dataTags: { parentDataTag: "boundary" } })).toEqual({
      id: "child",
      category: "child",
      empty: "filled",
      zero: "0",
      outer: "yes",
      parentid: "blob-parent",
    });
  });

  it.each(["data-boundary", "data-boundary-extra"])(
    "includes empty boundary-level attributes and stops content traversal at %s",
    (boundary) => {
      const target = element(`
        <section data-id="outside" data-secret="excluded">
          <div ${boundary}="" data-section="included"><button data-id="child"></button></div>
        </section>`);
      expect(getElementContent(target, { dataTags: { parentDataTag: "boundary" } })).toEqual({
        id: "child",
        section: "included",
      });
    },
  );

  it("retains nonempty boundary tags for the capture path to remove", () => {
    const target = element('<div data-boundary="stop"><button data-id="child"></button></div>');
    expect(getElementContent(target, { dataTags: { parentDataTag: "boundary" } })).toEqual({
      id: "child",
      boundary: "stop",
    });
  });

  it("searches past the clicked element's content boundary for a parent identifier", () => {
    const target = element(
      '<div data-id="parent"><button data-id="child" data-boundary="stop"></button></div>',
    );
    expect(getElementContent(target, { dataTags: { parentDataTag: "boundary" } })).toEqual({
      id: "child",
      boundary: "stop",
      parentid: "parent",
    });
  });

  it("does not skip the closest tagged ancestor when that ancestor has no ID", () => {
    const target = element(
      '<section data-id="outer"><div data-category="near"><button data-id="child"></button></div></section>',
    );
    expect(getElementContent(target, { dataTags: { parentDataTag: "boundary" } })).toEqual({
      id: "child",
      category: "near",
    });
  });

  it("preserves explicit parent identity instead of replacing it from ancestors", () => {
    const target = element(
      '<div data-id="ancestor"><button data-id="child" data-parentid="explicit"></button></div>',
    );
    expect(getElementContent(target, { dataTags: { parentDataTag: "boundary" } }).parentid).toBe(
      "explicit",
    );
    target.removeAttribute("data-parentid");
    target.setAttribute("data-parentname", "explicit name");
    expect(getElementContent(target, { dataTags: { parentDataTag: "boundary" } })).toEqual({
      id: "child",
      parentname: "explicit name",
    });
  });

  it("uses opted-in immediate-parent HTML as the parent identity fallback", () => {
    const target = element('<div id="html-parent"><button data-id="child"></button></div>');
    expect(
      getElementContent(target, {
        dataTags: { parentDataTag: "boundary", useDefaultContentNameOrId: true },
      }),
    ).toMatchObject({ id: "child", parentid: "html-parent", parentname: "html-parent" });
  });

  it("honors custom data, blob, boundary and DNT suffixes without collecting other prefixes", () => {
    const config: ClickAnalyticsInstrumentationConfig = {
      dataTags: {
        customDataPrefix: "data-track-",
        aiBlobAttributeTag: "json",
        parentDataTag: "stop",
        dntDataTag: "private",
      },
    };
    const target = element(
      '<div data-track-id="parent"><button data-track-id="child" data-other="excluded" data-track-stop="yes"></button></div>',
    );
    expect(getElementContent(target, config)).toEqual({
      id: "child",
      stop: "yes",
      parentid: "parent",
    });
    target.setAttribute("data-track-json", '{"id":"blob"}');
    expect(getElementContent(target, config)).toEqual({ id: "blob", parentid: "parent" });
    target.setAttribute("data-ai-dnt", "true");
    expect(isDoNotTrack(target, config)).toBe(false);
    target.setAttribute("data-track-private", "false");
    expect(isDoNotTrack(target, config)).toBe(true);
  });

  it.each(["invalid-", ""])("falls back to data- for an invalid prefix %s", (prefix) => {
    const target = element('<button data-id="default" data-ai-dnt="1"></button>');
    const config = { dataTags: { customDataPrefix: prefix } };
    expect(getElementContent(target, config)).toEqual({ id: "default", "ai-dnt": "1" });
    expect(isDoNotTrack(target, config)).toBe(true);
  });

  it.each([
    [undefined, false],
    ["", false],
    ["false", true],
    ["0", true],
    ["true", true],
    [" ", true],
  ] as const)("uses actual nonempty DNT behavior for value %s", (value, expected) => {
    const target = element("<button></button>");
    if (value !== undefined) target.setAttribute("data-ai-dnt", value);
    expect(isDoNotTrack(target, {})).toBe(expected);
  });

  it("checks all DNT ancestors independently of content traversal boundaries", () => {
    const target = element(
      '<section data-ai-dnt="false"><div data-boundary="stop"><button></button></div></section>',
    );
    expect(isDoNotTrack(target, { dataTags: { parentDataTag: "boundary" } })).toBe(true);
  });

  it.each(["blob", "attributes"] as const)(
    "handles prototype keys in %s without pollution",
    (source) => {
      const target = element("<button></button>");
      if (source === "blob") {
        target.setAttribute(
          "data-ai-blob",
          '{"__proto__":{"polluted":true},"constructor":"own constructor","toString":"own toString"}',
        );
      } else {
        target.setAttribute("data-__proto__", "own prototype");
        target.setAttribute("data-constructor", "own constructor");
        target.setAttribute("data-tostring", "own toString");
      }
      const content = getElementContent(target, {});
      expect(Object.getPrototypeOf(content)).toBeNull();
      expect(Object.hasOwn(content, "__proto__")).toBe(true);
      expect(content["__proto__"]).toEqual(
        source === "blob" ? { polluted: true } : "own prototype",
      );
      expect(content.constructor).toBe("own constructor");
      expect(content[source === "blob" ? "toString" : "tostring"]).toBe("own toString");
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    },
  );

  describe("metadata", () => {
    it("matches prefixes without stripping them and lets the last duplicate win", () => {
      meta("click-test:category", "first");
      meta("click-test:category", "last");
      meta("unrelated-click-test", "excluded");
      expect(getMetadata({ dataTags: { metaDataPrefix: "click-test:" } })).toEqual({
        "click-test:category": "last",
      });
    });

    it.each([
      {},
      { metaDataPrefix: "", captureAllMetaDataContent: false },
      { metaDataPrefix: "nonmatching:", captureAllMetaDataContent: true },
    ])("collects all named metadata with %j", (dataTags) => {
      meta("click-test:all", "included");
      meta("", "unnamed excluded");
      const expected = Object.fromEntries(
        Array.from(document.querySelectorAll("meta"))
          .filter((tag) => tag.name)
          .map((tag) => [tag.name, tag.content]),
      );
      expect(getMetadata({ dataTags })).toEqual(expected);
      expect(getMetadata({ dataTags })["click-test:all"]).toBe("included");
    });

    it("keeps metadata prototype keys as ordinary own properties", () => {
      meta("__proto__", "safe");
      meta("constructor", "own");
      const metadata = getMetadata({});
      expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
      expect(metadata["__proto__"]).toBe("safe");
      expect(metadata.constructor).toBe("own");
      expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    });
  });
});

describe("click analytics behavior validators", () => {
  it("maps only own dictionary entries, including numeric keys and falsy zero values", () => {
    const map = Object.assign(
      Object.create({ inherited: "excluded" }) as Record<string, string | number>,
      {
        purchase: 10,
        10: "purchase",
        zero: 0,
      },
    );
    const validate = BehaviorMapValidator(map);
    expect(validate("purchase")).toBe(10);
    expect(validate(10)).toBe("purchase");
    expect(validate("zero")).toBe("");
    for (const key of ["missing", "inherited", "constructor", "__proto__", "toString"]) {
      expect(validate(key)).toBe("");
    }
  });

  it("matches an exact string allowlist without coercing numbers or case", () => {
    const validate = BehaviorValueValidator(["purchase", "0"]);
    expect(validate("purchase")).toBe("purchase");
    expect(validate("0")).toBe("0");
    for (const key of ["Purchase", "missing", "constructor", 0, 1]) expect(validate(key)).toBe("");
  });

  it("supports enum name and reverse lookup, including zero's upstream falsy-name behavior", () => {
    enum Behavior {
      Unknown = 0,
      Purchase = 10,
    }
    const validate = BehaviorEnumValidator(Behavior);
    expect(validate("Purchase")).toBe(10);
    expect(validate(10)).toBe("Purchase");
    expect(validate("10")).toBe("Purchase");
    expect(validate(0)).toBe("Unknown");
    expect(validate("0")).toBe("Unknown");
    expect(validate("Unknown")).toBe("");
    expect(validate("missing")).toBe("");
    expect(validate("constructor")).toBe("");
  });
});

describe("ClickAnalyticsInstrumentation", () => {
  it("supports both manual APIs on a factory instance only after provider binding and enablement", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    providers.push(provider);
    const applyCustomLogRecordData = vi.fn();
    const instrumentation = await createClickAnalyticsInstrumentation({
      enabled: true,
      autoCapture: false,
      applyCustomLogRecordData,
    });
    active.push(instrumentation);
    const target = element('<button data-id="factory capture"></button>');
    instrumentation.capturePageAction(target);
    instrumentation.trackPageAction({ name: "before binding" });
    instrumentation.setLoggerProvider(provider);
    instrumentation.capturePageAction(target);
    instrumentation.trackPageAction({ name: "before enablement" });
    expect(applyCustomLogRecordData).not.toHaveBeenCalled();

    instrumentation.enable();
    mouse(target);
    keyboard(target, "Enter");
    instrumentation.capturePageAction(target, { actionType: "custom" });
    instrumentation.trackPageAction({ name: "factory manual", properties: { source: "app" } });
    await provider.forceFlush();
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(2);
    expect(records[0].attributes).toMatchObject({
      "browser.click.name": "factory capture",
      "browser.click.action_type": "custom",
    });
    expect(records[1].attributes).toMatchObject({
      "browser.click.name": "factory manual",
      "browser.click.properties": '{"source":"app"}',
    });
    expect(applyCustomLogRecordData).toHaveBeenCalledTimes(2);
  });

  it("satisfies registration and stays inert until enabled after direct provider binding", async () => {
    const { instrumentation, records } = createInstrumentation();
    expectTypeOf(instrumentation).toExtend<BrowserInstrumentation>();
    expect(instrumentation.getConfig().enabled).toBe(false);
    const target = element('<button data-id="button"></button>');
    mouse(target);
    instrumentation.capturePageAction(target);
    instrumentation.trackPageAction({ name: "manual" });
    expect(await records()).toEqual([]);

    instrumentation.enable();
    mouse(target);
    const [record] = await records();
    expect(record.eventName).toBe("browser.click");
    expect(record.severityNumber).toBe(SeverityNumber.INFO);
    expect(record.instrumentationScope.name).toBe(
      "@microsoft/opentelemetry-browser/click-analytics",
    );
    expect(record.attributes["browser.click.name"]).toBe("button");
  });

  it("emits all supplied manual action fields and merges action properties over custom properties", async () => {
    const { instrumentation, records } = createInstrumentation({ autoCapture: false });
    instrumentation.enable();
    const action: ClickAnalyticsPageAction = {
      name: "purchase",
      uri: "https://example.test/page",
      pageName: "Page",
      pageType: "checkout",
      refUri: "https://example.test/referrer",
      targetUri: "https://example.test/target",
      actionType: "custom",
      behavior: 0,
      clickCoordinates: "0X0",
      content: '[{"sku":"item"}]',
      timeToAction: 0,
      parentId: "parent",
      properties: { winner: "action", nested: { safe: true }, no: false },
    };
    instrumentation.trackPageAction(action, { winner: "custom", extra: "kept" });
    const [record] = await records();
    expect(record.attributes).toEqual({
      "browser.click.name": "purchase",
      "url.full": action.uri,
      "browser.page_view.name": "Page",
      "browser.click.page_type": "checkout",
      "url.referrer": action.refUri,
      "browser.click.target_url": action.targetUri,
      "browser.click.action_type": "custom",
      "browser.click.behavior": 0,
      "browser.click.coordinates": "0X0",
      "browser.click.content": action.content,
      "browser.click.time_to_action": 0,
      "browser.click.parent_id": "parent",
      "browser.click.properties": JSON.stringify({
        winner: "action",
        extra: "kept",
        nested: { safe: true },
        no: false,
      }),
    });
    expect(action.properties?.winner).toBe("action");
  });

  it("omits unassigned optional action fields rather than emitting empty attributes", async () => {
    const { instrumentation, records } = createInstrumentation();
    instrumentation.enable();
    instrumentation.trackPageAction({ name: "minimal", behavior: "", content: "" });
    expect((await records())[0].attributes).toEqual({
      "browser.click.name": "minimal",
      "browser.click.properties": "{}",
    });
  });

  it("applies DOM capture overrides, page-tag precedence, metadata and custom properties", async () => {
    meta("behavior", "metadata behavior");
    meta("market", "excluded market");
    meta("pageType", "metadata type");
    meta("click-test:extra", "metadata extra");
    const pageName = vi.fn(() => "callback page");
    const pageActionPageTags = vi.fn(() => ({ shared: "callback", callbackOnly: true }));
    const behaviorValidator = vi.fn((value: string | number) => `validated:${value}`);
    const { instrumentation, records } = createInstrumentation({
      dataTags: { parentDataTag: "boundary" },
      pageTags: { shared: "config", configOnly: 1 },
      callback: { pageName, pageActionPageTags },
      coreData: {
        requestUri: "https://example.test/request",
        referrerUri: "core referrer",
        pageName: "core page",
        pageType: "core type",
      },
      behaviorValidator,
    });
    instrumentation.enable();
    const target = element(
      '<div data-id="parent" data-boundary="stop"><button data-id="child" data-bhvr="tag behavior" data-category="tag"></button></div>',
    );
    instrumentation.capturePageAction(
      target,
      {
        refUri: "override referrer",
        actionType: "manual",
        targetUri: "https://example.test/override",
        clickCoordinateX: 0,
        clickCoordinateY: 0,
        contentTags: { category: "override", nested: { value: true } },
        behavior: "override behavior",
        pageName: "override page",
        pageType: "override type",
        pageTags: { shared: "override", overrideOnly: false },
      },
      { custom: { value: "kept" }, pageTags: "must not replace managed tags" },
    );
    const attributes = (await records())[0].attributes;
    expect(attributes).toMatchObject({
      "browser.click.name": "child",
      "browser.click.parent_id": "parent",
      "url.full": "https://example.test/request",
      "url.referrer": "override referrer",
      "browser.page_view.name": "override page",
      "browser.click.page_type": "override type",
      "browser.click.action_type": "manual",
      "browser.click.target_url": "https://example.test/override",
      "browser.click.coordinates": "0X0",
      "browser.click.behavior": "validated:override behavior",
    });
    expect(JSON.parse(attributes["browser.click.content"] as string)).toEqual([
      { bhvr: "tag behavior", category: "override", nested: { value: true } },
    ]);
    const properties = JSON.parse(attributes["browser.click.properties"] as string);
    expect(properties).toMatchObject({
      custom: { value: "kept" },
      pageTags: {
        shared: "override",
        configOnly: 1,
        callbackOnly: true,
        overrideOnly: false,
        metaTags: { "click-test:extra": "metadata extra" },
      },
    });
    expect(properties.pageTags.metaTags).not.toHaveProperty("behavior");
    expect(properties.pageTags.metaTags).not.toHaveProperty("market");
    expect(properties.pageTags.metaTags).not.toHaveProperty("pageType");
    expect(pageActionPageTags).toHaveBeenCalledWith(target);
    expect(pageName).not.toHaveBeenCalled();
    expect(behaviorValidator).toHaveBeenCalledWith("override behavior");
    expect(attributes["browser.click.time_to_action"]).toBeGreaterThanOrEqual(0);
  });

  it("uses callback/core/metadata defaults and derives the current page URL without query or hash", async () => {
    meta("behavior", "metadata behavior");
    meta("pageType", "metadata type");
    const { instrumentation, records } = createInstrumentation({
      callback: { pageName: () => "callback page" },
      coreData: { pageName: "core page", referrerUri: "core referrer" },
    });
    instrumentation.enable();
    instrumentation.capturePageAction(element('<button data-id="child"></button>'));
    expect((await records())[0].attributes).toMatchObject({
      "url.full": location.origin + location.pathname,
      "browser.page_view.name": "callback page",
      "browser.click.page_type": "metadata type",
      "url.referrer": "core referrer",
      "browser.click.behavior": "metadata behavior",
    });
  });

  it("preserves an empty page-name callback result and falls back from an empty referrer override", async () => {
    const { instrumentation, records } = createInstrumentation({
      autoCapture: false,
      callback: { pageName: () => "" },
      coreData: { pageName: "must not replace callback", referrerUri: "core referrer" },
    });
    instrumentation.enable();
    instrumentation.capturePageAction(element('<button data-id="empty overrides"></button>'), {
      pageName: "",
      refUri: "",
    });
    const [record] = await records();
    expect(record.attributes).not.toHaveProperty("browser.page_view.name");
    expect(record.attributes["url.referrer"]).toBe("core referrer");
  });

  it.each([undefined, ""])(
    "falls back to metadata and tagged behavior for an unassigned override %s",
    async (behavior) => {
      meta("behavior", "metadata");
      const { instrumentation, records } = createInstrumentation({
        behaviorValidator: BehaviorMapValidator({ metadata: 10, tagged: 20 }),
      });
      instrumentation.enable();
      const target = element('<button data-id="behavior"></button>');
      instrumentation.capturePageAction(target, { behavior });
      target.setAttribute("data-bhvr", "tagged");
      instrumentation.capturePageAction(target, { behavior });

      const exported = await records();
      expect(exported).toHaveLength(2);
      expect(exported[0].attributes["browser.click.behavior"]).toBe(10);
      expect(exported[1].attributes["browser.click.behavior"]).toBe(20);
      expect(exported[1].attributes["browser.click.content"]).toBe("[{}]");
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "collects hash=%s and query=%s only when opted in",
    async (urlCollectHash, urlCollectQuery) => {
      const original = location.href;
      try {
        history.replaceState(null, "", `${location.pathname}?click-test=query#click-test-hash`);
        const { instrumentation, records } = createInstrumentation({
          urlCollectHash,
          urlCollectQuery,
        });
        instrumentation.enable();
        instrumentation.capturePageAction(element('<button data-id="url"></button>'));
        expect((await records())[0].attributes["url.full"]).toBe(
          location.origin +
            location.pathname +
            (urlCollectHash ? location.hash : "") +
            (urlCollectQuery ? location.search : ""),
        );
      } finally {
        history.replaceState(null, "", original);
      }
    },
  );

  it("validates tagged behavior and lets tagged behavior override the right-click default", async () => {
    const { instrumentation, records } = createInstrumentation({
      defaultRightClickBhvr: "right",
      behaviorValidator: BehaviorMapValidator({ tagged: 10 }),
    });
    instrumentation.enable();
    const target = element('<button data-id="child" data-bhvr="tagged"></button>');
    instrumentation.capturePageAction(target, {}, {}, true);
    target.removeAttribute("data-bhvr");
    instrumentation.capturePageAction(target, {}, {}, true);
    const exported = await records();
    expect(exported[0].attributes["browser.click.behavior"]).toBe(10);
    expect(JSON.parse(exported[0].attributes["browser.click.content"] as string)).toEqual([{}]);
    expect(exported[1].attributes["browser.click.behavior"]).toBe("right");
  });

  it("keeps a custom validator's numeric zero behavior", async () => {
    const { instrumentation, records } = createInstrumentation({ behaviorValidator: () => 0 });
    instrumentation.enable();
    instrumentation.capturePageAction(element('<button data-id="child"></button>'), {
      behavior: 0,
    });
    expect((await records())[0].attributes["browser.click.behavior"]).toBe(0);
  });

  it.each([
    ["<button></button>", false],
    ['<button data-id="valid"></button>', true],
    ['<button data-category="valid"></button>', true],
    ['<button data-parentid="valid"></button>', true],
  ] as const)("drops only invalid extracted content for %s", async (markup, kept) => {
    const { instrumentation, records } = createInstrumentation({ dropInvalidEvents: true });
    instrumentation.enable();
    instrumentation.capturePageAction(element(markup));
    expect(await records()).toHaveLength(kept ? 1 : 0);
  });

  it("keeps otherwise empty captures by default and does not apply the DOM filter to trackPageAction", async () => {
    const first = createInstrumentation();
    first.instrumentation.enable();
    first.instrumentation.capturePageAction(element("<button></button>"));
    expect((await first.records())[0].attributes).toMatchObject({
      "browser.click.name": "not_specified",
      "browser.click.parent_id": "not_specified",
      "browser.click.content": "[{}]",
    });
    const second = createInstrumentation({ dropInvalidEvents: true });
    second.instrumentation.enable();
    second.instrumentation.trackPageAction({ name: "explicit" });
    expect(await second.records()).toHaveLength(1);
  });

  it("lets the custom log callback modify the actual exported record", async () => {
    const applyCustomLogRecordData = vi.fn((record: LogRecord) => {
      record.eventName = "custom.click";
      record.attributes = { ...record.attributes, custom: "kept" };
    });
    const { instrumentation, records } = createInstrumentation({ applyCustomLogRecordData });
    instrumentation.enable();
    instrumentation.trackPageAction({ name: "customized" });
    const [record] = await records();
    expect(applyCustomLogRecordData).toHaveBeenCalledTimes(1);
    expect(record.eventName).toBe("custom.click");
    expect(record.attributes.custom).toBe("kept");
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "redacts secrets in every absolute URL field after the custom hook (hook=%s, parser whitespace=%s)",
    async (hook, whitespace) => {
      const scheme = whitespace ? "\u0000 \nht\rt\tp\ns" : "https";
      const action: ClickAnalyticsPageAction = {
        name: "redacted",
        uri: `${scheme}://user:password@example.test/page?token=page-secret&keep=page#access_token=page-fragment`,
        refUri: `${scheme}://user:password@example.test/referrer?token=referrer-secret&keep=referrer#access_token=referrer-fragment`,
        targetUri: `${scheme}://user:password@example.test/target?token=target-secret&keep=target#access_token=target-fragment`,
      };
      const applyCustomLogRecordData = vi.fn((record: LogRecord) => {
        expect(record.attributes).toMatchObject({
          "url.full": action.uri,
          "url.referrer": action.refUri,
          "browser.click.target_url": action.targetUri,
        });
        record.attributes = {
          ...record.attributes,
          "url.full": action.uri?.replaceAll("secret", "hook-secret"),
          "url.referrer": action.refUri?.replaceAll("secret", "hook-secret"),
          "browser.click.target_url": action.targetUri?.replaceAll("secret", "hook-secret"),
          custom: "kept",
        };
      });
      const { instrumentation, records } = createInstrumentation({
        applyCustomLogRecordData: hook ? applyCustomLogRecordData : undefined,
      });
      instrumentation.enable();
      instrumentation.trackPageAction(action);

      const exported = await records();
      expect(exported).toHaveLength(1);
      expect(exported[0].attributes).toMatchObject({
        "url.full":
          "https://REDACTED:REDACTED@example.test/page?token=REDACTED&keep=page#access_token=REDACTED",
        "url.referrer":
          "https://REDACTED:REDACTED@example.test/referrer?token=REDACTED&keep=referrer#access_token=REDACTED",
        "browser.click.target_url":
          "https://REDACTED:REDACTED@example.test/target?token=REDACTED&keep=target#access_token=REDACTED",
      });
      expect(applyCustomLogRecordData).toHaveBeenCalledTimes(hook ? 1 : 0);
      if (hook) expect(exported[0].attributes.custom).toBe("kept");
      expect(action.uri).toContain("token=page-secret");
      expect(action.refUri).toContain("token=referrer-secret");
      expect(action.targetUri).toContain("token=target-secret");
    },
  );

  it.each(["manual", "capture", "hook"])(
    "omits malformed absolute URLs from %s actions without dropping the event",
    async (source) => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      const target = element('<button data-id="safe"></button>');
      const urls = [
        "https://user:password@example.test:invalid/path?token=secret",
        "http://user:password@example.test:99999/path?token=secret",
        " \nHTTPS://user:password@example.test:invalid/path?token=secret",
        "ht\ttps://user:password@example.test:invalid/path?token=secret",
        "\u0000\u001fHTTPS://user:password@example.test:invalid/path?token=secret",
        "ht\rtp\ns://user:password@example.test:invalid/path?token=secret",
        "ftp://user:password@example.test:invalid/path?token=secret",
        "wss://user:password@example.test:99999/path?token=secret",
        "custom+v1.test://user:password@example.test:invalid/path?token=secret",
        "1https://user:password@example.test:invalid/path?token=secret",
        "ht*tp://user:password@example.test/path?token=secret",
        "://user:password@example.test/path?token=secret",
      ];
      for (const url of urls) {
        if (source === "capture") {
          instrumentation.setConfig({
            enabled: true,
            coreData: { requestUri: url },
          });
          instrumentation.capturePageAction(target, Object.freeze({ refUri: url, targetUri: url }));
        } else {
          if (source === "hook") {
            instrumentation.setConfig({
              enabled: true,
              applyCustomLogRecordData: (record) => {
                record.attributes = Object.freeze({
                  ...record.attributes,
                  "url.full": url,
                  "url.referrer": url,
                  "browser.click.target_url": url,
                  custom: "kept",
                });
              },
            });
          }
          instrumentation.trackPageAction(
            Object.freeze({ name: "safe", uri: url, refUri: url, targetUri: url }),
          );
        }
      }
      const exported = await records();
      expect(exported).toHaveLength(urls.length);
      for (const record of exported) {
        expect(record.eventName).toBe("browser.click");
        expect(record.attributes["browser.click.name"]).toBe("safe");
        if (source === "hook") expect(record.attributes.custom).toBe("kept");
        for (const key of ["url.full", "url.referrer", "browser.click.target_url"]) {
          expect(record.attributes).not.toHaveProperty(key);
        }
      }
    },
  );

  it.each(["manual", "hook"])("preserves opaque URL labels from %s actions", async (source) => {
    const attributes = {
      "url.full": "page label: action",
      "url.referrer": "/relative/referrer",
      "browser.click.target_url": "target label://destination",
    };
    const { instrumentation, records } = createInstrumentation({
      applyCustomLogRecordData:
        source === "hook"
          ? (record) => {
              record.attributes = attributes;
            }
          : undefined,
    });
    instrumentation.enable();
    instrumentation.trackPageAction({
      name: "labels",
      uri: attributes["url.full"],
      refUri: attributes["url.referrer"],
      targetUri: attributes["browser.click.target_url"],
    });
    const exported = await records();
    expect(exported).toHaveLength(1);
    expect(exported[0].attributes).toMatchObject(attributes);
  });

  it("redacts frozen hook attributes without mutating the hook-owned object", async () => {
    const attributes = Object.freeze({
      "url.full": "https://user:password@example.test/page?token=secret&keep=yes",
      "url.referrer": "https://example.test/ref?access_token=secret",
      "browser.click.target_url": "https://example.test/target?token=secret",
      custom: "kept",
    });
    const { instrumentation, records } = createInstrumentation({
      applyCustomLogRecordData: (record) => {
        record.attributes = attributes;
      },
    });
    instrumentation.enable();
    instrumentation.trackPageAction({ name: "frozen" });
    const exported = await records();
    expect(exported).toHaveLength(1);
    expect(exported[0].attributes).toMatchObject({
      "url.full": "https://REDACTED:REDACTED@example.test/page?token=REDACTED&keep=yes",
      "url.referrer": "https://example.test/ref?access_token=REDACTED",
      "browser.click.target_url": "https://example.test/target?token=REDACTED",
      custom: "kept",
    });
    expect(attributes["url.full"]).toContain("token=secret");
    expect(attributes["url.referrer"]).toContain("access_token=secret");
    expect(attributes["browser.click.target_url"]).toContain("token=secret");
  });

  it("isolates throwing callbacks from browser events and subsequent captures", async () => {
    const applyCustomLogRecordData = vi.fn(() => {
      throw new Error("callback failed");
    });
    const { instrumentation, records } = createInstrumentation({ applyCustomLogRecordData });
    instrumentation.enable();
    const target = element('<button data-id="safe"></button>');
    expect(() => mouse(target)).not.toThrow();
    expect(() => instrumentation.trackPageAction({ name: "manual" })).not.toThrow();
    expect(await records()).toEqual([]);
    instrumentation.setConfig({ enabled: true });
    mouse(target);
    expect(await records()).toHaveLength(1);
  });

  it("does not emit if a custom log callback disables capture", async () => {
    const { instrumentation, records } = createInstrumentation({
      applyCustomLogRecordData: () => instrumentation.disable(),
    });
    instrumentation.enable();
    instrumentation.trackPageAction({ name: "disabled in callback" });
    expect(await records()).toEqual([]);
  });

  describe("automatic actions", () => {
    it.each(["name", "id"])(
      "checks clobbered ancestry of off-path label controls (%s)",
      async (attribute) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        const root = mount(
          `<label for="off-path-control"><span>Label</span></label><section data-ai-dnt="true"><form><input ${attribute}="parentElement"><input id="off-path-control" type="checkbox" data-id="control"></form></section>`,
        );
        const form = root.querySelector("form")!;
        const input = form.querySelector("input")!;
        let reads = 0;
        Object.defineProperty(input, "parentElement", {
          configurable: true,
          get: () => {
            if (++reads > 10) throw new Error("Cyclic parentElement traversal");
            return form;
          },
        });
        const target = root.querySelector("span")!;
        for (const dnt of ["true", "false", ""]) {
          root.querySelector("section")!.setAttribute("data-ai-dnt", dnt);
          mouse(target);
          keyboard(target, "Enter");
          keyboard(target, " ");
          expect(await records()).toHaveLength(dnt ? 0 : 3);
        }
        expect(reads).toBe(0);
      },
    );

    it.each(["name", "id"])("handles %s-based structural form collisions", async (attribute) => {
      const { instrumentation, records } = createInstrumentation({
        dataTags: { parentDataTag: "boundary", useDefaultContentNameOrId: true },
      });
      instrumentation.enable();
      const root = mount(
        `<form id="parent"><input ${attribute}="tagName"><input ${attribute}="id"><input ${attribute}="control" type="submit" data-id="unrelated"><span>Text</span><button data-id="child">Action</button></form>`,
      );
      mouse(root.querySelector("span")!);
      expect(await records()).toEqual([]);
      const target = root.querySelector("button")!;
      mouse(target);
      keyboard(target, "Enter");
      instrumentation.capturePageAction(target);
      const exported = await records();
      expect(exported).toHaveLength(3);
      for (const record of exported) {
        expect(record.attributes["browser.click.name"]).toBe("child");
        expect(record.attributes["browser.click.parent_id"]).toBe("parent");
      }
    });

    it("does not follow a clobbered form parent when searching for a supported ancestor", async () => {
      const { instrumentation, records } = createInstrumentation({ trackElementTypes: "BUTTON" });
      instrumentation.enable();
      const target = element('<form><input name="parentElement"><span>Text</span></form>', "span");
      const form = target.closest("form")!;
      const input = form.querySelector("input")!;
      let reads = 0;
      Object.defineProperty(input, "parentElement", {
        configurable: true,
        get: () => {
          if (++reads > 10) throw new Error("Cyclic parentElement traversal");
          return form;
        },
      });
      mouse(target);
      keyboard(target, "Enter");
      expect(await records()).toEqual([]);
      expect(reads).toBe(0);
    });

    it.each(["name", "id"])("honors form DNT when an input has %s=nodeType", async (attribute) => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      const target = element(
        `<form><input ${attribute}="nodeType"><button data-id="protected">Action</button></form>`,
        "button",
      );
      const form = target.parentElement!;
      expect(form.nodeType).toBe(form.querySelector("input"));
      for (const dnt of ["true", "false", ""]) {
        form.setAttribute("data-ai-dnt", dnt);
        mouse(target);
        keyboard(target, "Enter");
        keyboard(target, " ");
        expect(await records()).toHaveLength(dnt ? 0 : 3);
      }
    });

    it.each([false, true])(
      "checks each composed-path DNT attribute once (eligible control: %s)",
      async (eligible) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        const root = mount(eligible ? '<button data-id="deep"></button>' : "<section></section>");
        let target = root.firstElementChild!;
        const path: Element[] = [target, root, document.body, document.documentElement];
        for (let depth = 0; depth < 40; depth++) {
          const child = document.createElement("span");
          target.append(child);
          target = child;
          path.push(child);
        }
        const reads = vi.spyOn(Element.prototype, "getAttribute");
        for (const dispatch of [() => mouse(target), () => keyboard(target, "Enter")]) {
          reads.mockClear();
          dispatch();
          const dntReads = reads.mock.calls
            .map(([attribute], index) =>
              attribute === "data-ai-dnt" ? reads.mock.contexts[index] : undefined,
            )
            .filter((element) => element !== undefined);
          expect(dntReads).toHaveLength(path.length);
          for (const element of path)
            expect(dntReads.filter((read) => read === element)).toHaveLength(1);
        }
        expect(await records()).toHaveLength(eligible ? 2 : 0);
      },
    );

    it.each([0, 7])(
      "captures tagged actions beneath a numeric parent value of %s",
      async (value) => {
        const { instrumentation, records } = createInstrumentation({
          dataTags: { useDefaultContentNameOrId: true, parentDataTag: "boundary" },
        });
        instrumentation.enable();
        const target = element(
          `<ol><li value="${value}"><button data-id="child">Action</button></li></ol>`,
        );
        mouse(target);
        instrumentation.capturePageAction(target);
        const exported = await records();
        expect(exported).toHaveLength(2);
        for (const record of exported) {
          expect(record.attributes["browser.click.name"]).toBe("child");
          expect(record.attributes["browser.click.content"]).toBe('[{"contentName":"Action"}]');
        }
        expect(
          getElementContent(target, {
            dataTags: { useDefaultContentNameOrId: true, parentDataTag: "boundary" },
          }).parentname,
        ).toBe(value ? String(value) : "Action");
      },
    );

    it.each(
      ["name", "id"].flatMap((attribute) =>
        [false, true].flatMap((duplicate) =>
          [["value"], ["name"], ["value", "name"]].map((properties) => ({
            attribute,
            duplicate,
            properties,
          })),
        ),
      ),
    )(
      "captures form-parent content with $attribute=$properties controls (duplicate: $duplicate)",
      async ({ attribute, duplicate, properties }) => {
        const { instrumentation, records } = createInstrumentation({
          dataTags: { useDefaultContentNameOrId: true, parentDataTag: "boundary" },
        });
        instrumentation.enable();
        const controls = properties
          .map((property) => `<input ${attribute}="${property}">`.repeat(duplicate ? 2 : 1))
          .join("");
        const target = element(
          `<form name="parent-name">${controls}<button data-id="child">Action</button></form>`,
          "button",
        );
        const content = getElementContent(target, {
          dataTags: { useDefaultContentNameOrId: true, parentDataTag: "boundary" },
        });
        expect(content.parentname).toBe(properties.includes("name") ? "Action" : "parent-name");
        mouse(target);
        keyboard(target, "Enter");
        instrumentation.capturePageAction(target);
        const exported = await records();
        expect(exported).toHaveLength(3);
        for (const record of exported) {
          expect(record.attributes["browser.click.name"]).toBe("child");
          expect(record.attributes["browser.click.content"]).toBe('[{"contentName":"Action"}]');
        }
      },
    );

    it.each(
      [false, true].flatMap((outer) =>
        ["button", "label", "text input"].map((kind) => ({ outer, kind })),
      ),
    )(
      "resolves shadow $kind targets (supported outer ancestor: $outer)",
      async ({ outer, kind }) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        const root = mount(outer ? '<a data-id="outer"><span></span></a>' : "<span></span>");
        const host = root.querySelector("span")!;
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML =
          kind === "button"
            ? '<button data-id="inner"><span>Action</span></button>'
            : kind === "label"
              ? '<label for="shadow-control"><span>Action</span></label><input id="shadow-control" type="checkbox" data-id="inner">'
              : '<input type="text" data-id="private" value="secret">';
        const target = shadow.querySelector("span, input")!;
        for (const event of [
          new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0 }),
          new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "Enter" }),
          new KeyboardEvent("keyup", { bubbles: true, composed: true, key: " " }),
        ])
          target.dispatchEvent(event);
        const exported = await records();
        expect(exported).toHaveLength(kind === "text input" ? 0 : 3);
        for (const record of exported)
          expect(record.attributes["browser.click.name"]).toBe("inner");
      },
    );

    it.each(["", "true", "false"])(
      "honors DNT=%s on a shadow button's host after resolving its inner target",
      async (dnt) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        const host = element(`<span data-ai-dnt="${dnt}"></span>`, "span");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = '<button data-id="inner">Action</button>';
        shadow
          .querySelector("button")!
          .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0 }));
        expect(await records()).toHaveLength(dnt ? 0 : 1);
      },
    );

    it.each(["", "true", "false"])(
      "honors composed-path DNT=%s inside nested shadow roots",
      async (dnt) => {
        const { instrumentation, records } = createInstrumentation({
          dataTags: { customDataPrefix: "data-track-", dntDataTag: "private" },
        });
        instrumentation.enable();
        const anchor = element(
          '<a href="/destination" data-track-id="link"><span></span></a>',
          "a",
        );
        const shadow = anchor.querySelector("span")!.attachShadow({ mode: "open" });
        shadow.innerHTML = `<section data-track-private="${dnt}"><span></span></section>`;
        const nested = shadow.querySelector("span")!.attachShadow({ mode: "open" });
        nested.innerHTML = "<span>Action</span>";
        const target = nested.querySelector("span")!;
        target.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0 }),
        );
        target.dispatchEvent(
          new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "Enter" }),
        );
        const exported = await records();
        expect(exported).toHaveLength(dnt ? 0 : 2);
        for (const record of exported) expect(record.attributes["browser.click.name"]).toBe("link");
      },
    );

    it.each(["name", "id"])(
      "reads form destinations when an input has %s=action",
      async (attribute) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        for (const action of ["/submit?token=secret&keep=yes", "", undefined]) {
          const target = element(
            `<form${action === undefined ? "" : ` action="${action}"`}><input ${attribute}="action"><input ${attribute}="getAttribute"><input type="submit" data-id="submit"></form>`,
            'input[type="submit"]',
          );
          mouse(target);
          instrumentation.capturePageAction(target);
        }
        const exported = await records();
        expect(exported).toHaveLength(6);
        for (const [index, record] of exported.entries()) {
          expect(record.attributes["browser.click.target_url"]).toBe(
            index < 2
              ? new URL("/submit?token=REDACTED&keep=yes", location.href).href
              : location.href,
          );
          expect(JSON.stringify(record.attributes)).not.toContain("secret");
        }
      },
    );

    it.each(["a", "area", "input"])(
      "omits malformed DOM destinations for %s without dropping clicks",
      async (tag) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        const invalid = "https://example.test:invalid/path?token=secret";
        const target = element(
          tag === "input"
            ? `<form action="${invalid}"><input type="submit" data-id="invalid"></form>`
            : `<${tag} href="${invalid}" data-id="invalid"></${tag}>`,
          tag,
        );
        mouse(target);
        instrumentation.capturePageAction(target);
        const exported = await records();
        expect(exported).toHaveLength(2);
        for (const record of exported) {
          expect(record.attributes["browser.click.name"]).toBe("invalid");
          expect(record.attributes["browser.click.target_url"]).toBeUndefined();
          expect(JSON.stringify(record.attributes)).not.toContain("secret");
        }
      },
    );

    it.each(["", "true"])("preserves original-target and selected-control DNT=%s", async (dnt) => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      for (const markup of [
        `<button data-id="ancestor"><span data-ai-dnt="${dnt}">Text</span></button>`,
        `<section data-ai-dnt="${dnt}"><label for="dnt-control"><span>Label</span></label></section><input id="dnt-control" type="checkbox" data-id="external">`,
        `<label for="dnt-control"><span>Label</span></label><section data-ai-dnt="${dnt}"><input id="dnt-control" type="checkbox" data-id="protected"></section>`,
      ]) {
        const target = element(markup, "span");
        mouse(target);
        keyboard(target, "Enter");
        target.closest("div")?.remove();
      }
      expect(await records()).toHaveLength(dnt ? 0 : 6);
    });

    it.each(["href", "xlink:href"])(
      "preserves SVG clicks with invalid %s destinations",
      async (attribute) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        mouse(
          element(
            `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a data-id="invalid-svg" ${attribute}="http://["><text>Link</text></a></svg>`,
            "text",
          ),
        );
        const exported = await records();
        expect(exported).toHaveLength(1);
        expect(exported[0].attributes["browser.click.name"]).toBe("invalid-svg");
        expect(exported[0].attributes["browser.click.target_url"]).toBeUndefined();
      },
    );

    it.each(["href", "xlink:href"])(
      "resolves SVG %s links against their base URI",
      async (attribute) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        const target = element(
          `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a data-id="svg" ${attribute}="../target?token=secret"><text>Link</text></a></svg>`,
          "text",
        );
        const anchor = target.parentElement!;
        mouse(target);
        const exported = await records();
        const expected = new URL("../target?token=REDACTED", anchor.baseURI).href;
        expect(exported).toHaveLength(1);
        expect(exported[0].attributes["browser.click.target_url"]).toBe(expected);
      },
    );

    it.each([
      [0, "CL"],
      [1, "CM"],
      [2, "CR"],
    ] as const)("captures mouse button %s as %s", async (button, actionType) => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      const target = element('<button data-id="mouse"></button>');
      mouse(target, button);
      const exported = await records();
      expect(exported).toHaveLength(1);
      expect(exported[0].attributes).toMatchObject({
        "browser.click.name": "mouse",
        "browser.click.action_type": actionType,
      });
      expect(exported[0].attributes["browser.click.coordinates"]).toMatch(/^\d+X\d+$/);
    });

    it.each([
      ["Enter", 0, "KE"],
      [" ", 0, "KS"],
      ["", 13, "KE"],
      ["", 32, "KS"],
    ] as const)("captures keyboard key %s/code %s as %s", async (key, keyCode, actionType) => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      const event = keyboard(element('<button data-id="keyboard"></button>'), key, keyCode);
      const exported = await records();
      expect(exported).toHaveLength(1);
      expect(exported[0].attributes).toMatchObject({
        "browser.click.name": "keyboard",
        "browser.click.action_type": actionType,
      });
      // WebKit exposes page coordinates on KeyboardEvent; the other browsers omit them.
      const coordinates = event as KeyboardEvent & Partial<Pick<MouseEvent, "pageX" | "pageY">>;
      expect(exported[0].attributes["browser.click.coordinates"]).toBe(
        coordinates.pageX === undefined || coordinates.pageY === undefined
          ? undefined
          : `${coordinates.pageX}X${coordinates.pageY}`,
      );
    });

    it("ignores unrelated keys, unsupported buttons and click/keydown events", async () => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      const target = element('<button data-id="ignored"></button>');
      for (const key of ["Escape", "Tab", "a", "Space"]) keyboard(target, key);
      mouse(target, 3);
      mouse(target, 4);
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      expect(await records()).toEqual([]);
    });

    it.each(["button", "checkbox", "radio", "reset", "submit"])(
      "captures allowed input type %s and its form action",
      async (type) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        mouse(
          element(
            `<form action="/click-test-submit"><input type="${type}" data-id="input"></form>`,
            "input",
          ),
        );
        expect((await records())[0].attributes).toMatchObject({
          "browser.click.name": "input",
          "browser.click.target_url": new URL("/click-test-submit", location.href).href,
        });
      },
    );

    it.each(["text", "password", "email", "hidden", "number", "range", "file", "search", "image"])(
      "ignores disallowed input type %s",
      async (type) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        const target = element(`<input type="${type}" data-id="private">`, "input");
        mouse(target);
        keyboard(target, "Enter");
        expect(await records()).toEqual([]);
      },
    );

    it.each(["text", "password"])(
      "does not read or capture XHTML %s input values, directly or through labels",
      async (type) => {
        const xhtml = new DOMParser().parseFromString(
          `<html xmlns="http://www.w3.org/1999/xhtml"><body><label for="xhtml-input">Input</label><input id="xhtml-input" type="${type}" value="private input value" /></body></html>`,
          "application/xhtml+xml",
        );
        const input = xhtml.querySelector<HTMLInputElement>("input")!;
        const label = xhtml.querySelector<HTMLLabelElement>("label")!;
        expect(input.tagName).toBe("input");
        expect(label.control).toBe(input);
        // Parsed XHTML has no window; attach the automatic handlers to its event tree instead.
        vi.spyOn(window, "addEventListener").mockImplementation((...args) =>
          xhtml.addEventListener(...args),
        );
        vi.spyOn(window, "removeEventListener").mockImplementation((...args) =>
          xhtml.removeEventListener(...args),
        );
        const contentName = vi.fn(() => "");
        const { instrumentation, records } = createInstrumentation({
          dataTags: { useDefaultContentNameOrId: true },
          callback: { contentName },
        });
        instrumentation.enable();
        for (const target of [input, label]) {
          mouse(target);
          keyboard(target, "Enter");
          keyboard(target, " ");
        }
        expect(await records()).toEqual([]);
        expect(contentName).not.toHaveBeenCalled();

        input.type = "button";
        input.value = "Public action";
        mouse(input);
        const exported = await records();
        expect(exported).toHaveLength(1);
        expect(exported[0].attributes["browser.click.content"]).toBe(
          '[{"contentName":"Public action"}]',
        );
      },
    );

    it.each(["a", "area"])("captures a %s destination as an absolute URL", async (tag) => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      mouse(element(`<${tag} data-id="link" href="/click-test-destination"></${tag}>`, tag));
      expect((await records())[0].attributes["browser.click.target_url"]).toBe(
        new URL("/click-test-destination", location.href).href,
      );
    });

    it("resolves nested targets to the nearest supported ancestor", async () => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      mouse(
        element('<button data-id="button"><span data-id="nested">Text</span></button>', "span"),
      );
      const exported = await records();
      expect(exported).toHaveLength(1);
      expect(exported[0].attributes["browser.click.name"]).toBe("button");
    });

    it.each(["associated", "nested"] as const)(
      "resolves %s labels to their controls",
      async (kind) => {
        const { instrumentation, records } = createInstrumentation();
        instrumentation.enable();
        const markup =
          kind === "associated"
            ? '<label for="click-test-control"><span>Label</span></label><input id="click-test-control" type="checkbox" data-id="control">'
            : '<label><input type="checkbox" data-id="control"><span>Label</span></label>';
        mouse(element(markup, "label span"));
        const exported = await records();
        expect(exported).toHaveLength(1);
        expect(exported[0].attributes["browser.click.name"]).toBe("control");
      },
    );

    it("ignores labels for disallowed inputs and unassociated labels", async () => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      mouse(
        element(
          '<label for="click-test-text">Private</label><input id="click-test-text" type="text">',
          "label",
        ),
      );
      mouse(element("<label>Unassociated</label>", "label"));
      expect(await records()).toEqual([]);
    });

    it("replaces default element types with the explicitly configured list", async () => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      const target = element('<div data-id="custom"><span>Nested</span></div>', "span");
      mouse(target);
      expect(await records()).toEqual([]);
      instrumentation.setConfig({ enabled: true, trackElementTypes: " div, span " });
      mouse(target);
      expect((await records())[0].attributes["browser.click.name"]).toBe("not_specified");
      instrumentation.setConfig({ enabled: true, trackElementTypes: " div " });
      mouse(target);
      expect((await records())[1].attributes["browser.click.name"]).toBe("custom");
      const excluded = document.createElement("button");
      excluded.setAttribute("data-id", "excluded default");
      document.body.append(excluded);
      fixtures.push(excluded);
      mouse(excluded);
      expect(await records()).toHaveLength(2);
      instrumentation.setConfig({ enabled: true, trackElementTypes: "" });
      mouse(target);
      mouse(element('<button data-id="empty list"></button>'));
      expect(await records()).toHaveLength(2);
    });

    it("captures SVG paths only when trackElementTypes includes path", async () => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      const target = element(
        '<svg><path id="svg-action" data-category="icon" d="M0 0h10v10z"></path></svg>',
        "path",
      );
      expect(target).toBeInstanceOf(SVGElement);
      mouse(target);
      keyboard(target, "Enter");
      expect(await records()).toEqual([]);

      instrumentation.setConfig({
        enabled: true,
        trackElementTypes: " path ",
        dataTags: { useDefaultContentNameOrId: true },
      });
      mouse(target);
      keyboard(target, "Enter");
      const exported = await records();
      expect(exported).toHaveLength(2);
      for (const [index, record] of exported.entries()) {
        expect(record.attributes).toMatchObject({
          "browser.click.name": "svg-action",
          "browser.click.action_type": index === 0 ? "CL" : "KE",
        });
        expect(JSON.parse(record.attributes["browser.click.content"] as string)).toEqual([
          { category: "icon", contentName: "svg-action" },
        ]);
      }
    });

    it.each([
      ["", 1],
      ["false", 0],
      ["0", 0],
      ["true", 0],
    ] as const)("honors DNT=%s for automatic actions", async (dnt, count) => {
      const { instrumentation, records } = createInstrumentation({
        dataTags: { parentDataTag: "boundary" },
      });
      instrumentation.enable();
      const target = element(
        `<section data-ai-dnt="${dnt}"><div data-boundary="stop"><button data-id="private"></button></div></section>`,
      );
      mouse(target);
      keyboard(target, "Enter");
      expect(await records()).toHaveLength(count * 2);
    });
  });

  describe("lifecycle and isolation", () => {
    it("bounds cleanup when every mousedown removal reenters and throws", async () => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      const originalRemove = window.removeEventListener.bind(window);
      let attempts = 0;
      const remove = vi
        .spyOn(window, "removeEventListener")
        .mockImplementation((type, listener, options) => {
          if (type === "mousedown") {
            // Cap the fixture itself so a regression fails without exhausting the browser stack.
            if (++attempts <= 5) {
              instrumentation.disable();
              instrumentation.enable();
            }
            throw new Error("reentrant removal failed");
          }
          originalRemove(type, listener, options);
        });
      try {
        instrumentation.disable();
        expect(attempts).toBe(2);
        const target = element('<button data-id="latest"></button>');
        mouse(target);
        keyboard(target, "Enter");
        expect(await records()).toHaveLength(2);
      } finally {
        remove.mockRestore();
        instrumentation.disable();
      }
    });

    it.each(["mousedown", "keyup", "both"])(
      "retries transient %s removal once within a single disable",
      async (failedEvent) => {
        const { instrumentation, records } = createInstrumentation();
        const add = vi.spyOn(window, "addEventListener");
        instrumentation.enable();
        const listener = add.mock.calls[0][1];
        const originalRemove = window.removeEventListener.bind(window);
        const attempts = new Map<string, number>();
        const warn = vi.spyOn(diag, "warn");
        const remove = vi
          .spyOn(window, "removeEventListener")
          .mockImplementation((type, callback, options) => {
            attempts.set(type, (attempts.get(type) ?? 0) + 1);
            if (attempts.get(type) === 1 && (type === failedEvent || failedEvent === "both"))
              throw new Error("transient cleanup failure");
            originalRemove(type, callback, options);
          });
        instrumentation.disable();
        for (const type of ["mousedown", "keyup"]) {
          expect(attempts.get(type)).toBe(type === failedEvent || failedEvent === "both" ? 2 : 1);
          expect(remove).toHaveBeenCalledWith(type, listener);
        }
        expect(warn).not.toHaveBeenCalled();
        const target = element('<button data-id="cleanup"></button>');
        mouse(target);
        keyboard(target, "Enter");
        expect(await records()).toEqual([]);
        remove.mockClear();
        instrumentation.disable();
        expect(remove).not.toHaveBeenCalled();
      },
    );

    it("retains failed cancellation cleanup and preserves the registration error", () => {
      const { instrumentation } = createInstrumentation();
      const originalAdd = window.addEventListener.bind(window);
      const originalRemove = window.removeEventListener.bind(window);
      const failure = new Error("registration failed");
      let failCleanup = true;
      const remove = vi
        .spyOn(window, "removeEventListener")
        .mockImplementation((type, listener, options) => {
          if (failCleanup) throw new Error("cleanup failed");
          originalRemove(type, listener, options);
        });
      const add = vi
        .spyOn(window, "addEventListener")
        .mockImplementation((type, listener, options) => {
          instrumentation.disable();
          originalAdd(type, listener, options);
          throw failure;
        });
      expect(() => instrumentation.enable()).toThrow(failure);
      const listener = add.mock.calls[0][1];
      failCleanup = false;
      remove.mockClear();
      instrumentation.disable();
      expect(remove.mock.calls).toEqual([
        ["mousedown", listener],
        ["keyup", listener],
      ]);
    });

    it.each(["mousedown", "keyup", "both"])(
      "retries failed %s cleanup while disabled callbacks stay inert",
      async (failedEvent) => {
        const { instrumentation, records } = createInstrumentation();
        const add = vi.spyOn(window, "addEventListener");
        instrumentation.enable();
        const listener = add.mock.calls[0][1];
        const originalRemove = window.removeEventListener.bind(window);
        let fail = true;
        const warn = vi.spyOn(diag, "warn");
        const remove = vi
          .spyOn(window, "removeEventListener")
          .mockImplementation((type, callback, options) => {
            if (fail && (type === failedEvent || failedEvent === "both"))
              throw new Error("cleanup failed");
            originalRemove(type, callback, options);
          });
        expect(() => instrumentation.disable()).not.toThrow();
        for (const type of ["mousedown", "keyup"]) {
          expect(remove.mock.calls.filter(([event]) => event === type)).toHaveLength(
            type === failedEvent || failedEvent === "both" ? 2 : 1,
          );
        }
        expect(warn).toHaveBeenCalledExactlyOnceWith("Click cleanup failed after retry.");
        const target = element('<button data-id="cleanup"></button>');
        mouse(target);
        keyboard(target, "Enter");
        instrumentation.trackPageAction({ name: "disabled" });
        expect(await records()).toEqual([]);
        remove.mockClear();
        fail = false;
        instrumentation.disable();
        expect(remove.mock.calls).toEqual([
          ["mousedown", listener],
          ["keyup", listener],
        ]);
        remove.mockClear();
        instrumentation.disable();
        expect(remove).not.toHaveBeenCalled();
      },
    );

    it("keeps reentrant activation live while retrying the older listener cleanup", async () => {
      const { instrumentation, records } = createInstrumentation();
      const add = vi.spyOn(window, "addEventListener");
      instrumentation.enable();
      const oldListener = add.mock.calls[0][1];
      const originalRemove = window.removeEventListener.bind(window);
      let reentered = false;
      const remove = vi
        .spyOn(window, "removeEventListener")
        .mockImplementation((type, listener, options) => {
          if (!reentered) {
            reentered = true;
            instrumentation.disable();
            instrumentation.enable();
            throw new Error("old cleanup failed");
          }
          originalRemove(type, listener, options);
        });
      instrumentation.disable();
      expect(
        remove.mock.calls.filter(
          ([type, listener]) => type === "mousedown" && listener === oldListener,
        ),
      ).toHaveLength(2);
      expect(remove).toHaveBeenCalledWith("keyup", oldListener);
      const target = element('<button data-id="new"></button>');
      mouse(target);
      keyboard(target, "Enter");
      expect(await records()).toHaveLength(2);
      remove.mockClear();
      instrumentation.disable();
      expect(remove).not.toHaveBeenCalledWith("mousedown", oldListener);
      expect(remove).not.toHaveBeenCalledWith("keyup", oldListener);
      mouse(target);
      keyboard(target, "Enter");
      expect(await records()).toHaveLength(2);
      remove.mockClear();
      instrumentation.disable();
      expect(remove).not.toHaveBeenCalled();
    });

    it.each(["mousedown", "keyup"])(
      "cancels %s registration after reentrant disable",
      async (failedEvent) => {
        const { instrumentation, records } = createInstrumentation();
        const originalAdd = window.addEventListener.bind(window);
        const originalRemove = window.removeEventListener.bind(window);
        const installed = new Set<EventListenerOrEventListenerObject | null>();
        const remove = vi
          .spyOn(window, "removeEventListener")
          .mockImplementation((type, listener, options) => {
            originalRemove(type, listener, options);
            if (type === failedEvent) installed.delete(listener);
          });
        const add = vi
          .spyOn(window, "addEventListener")
          .mockImplementation((type, listener, options) => {
            if (type === failedEvent) instrumentation.disable();
            originalAdd(type, listener, options);
            if (type === failedEvent) installed.add(listener);
          });
        instrumentation.enable();
        const listener = add.mock.calls[0][1];
        expect(remove).toHaveBeenLastCalledWith("keyup", listener);
        expect(installed.size).toBe(0);
        const target = element('<button data-id="cancelled"></button>');
        mouse(target);
        keyboard(target, "Enter");
        expect(await records()).toEqual([]);
        add.mockRestore();
        instrumentation.enable();
        mouse(target);
        expect(await records()).toHaveLength(1);
      },
    );

    it.each([false, true])(
      "preserves a newer activation when old registration is cancelled (throws: %s)",
      async (throws) => {
        const { instrumentation, records } = createInstrumentation();
        const originalAdd = window.addEventListener.bind(window);
        let reentered = false;
        const failure = new Error("old registration failed");
        vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
          if (!reentered) {
            reentered = true;
            instrumentation.disable();
            instrumentation.enable();
            originalAdd(type, listener, options);
            if (throws) throw failure;
          } else originalAdd(type, listener, options);
        });
        if (throws) expect(() => instrumentation.enable()).toThrow(failure);
        else instrumentation.enable();
        const target = element('<button data-id="new-activation"></button>');
        mouse(target);
        keyboard(target, "Enter");
        expect(await records()).toHaveLength(2);
        instrumentation.disable();
        mouse(target);
        keyboard(target, "Enter");
        expect(await records()).toHaveLength(2);
      },
    );

    it.each([
      ["mousedown", false],
      ["mousedown", true],
      ["keyup", false],
      ["keyup", true],
    ] as const)(
      "rolls back listener installation when %s throws (after registration: %s)",
      async (failedEvent, afterRegistration) => {
        const { instrumentation, records } = createInstrumentation();
        const target = element('<button data-id="retry"></button>');
        const originalAdd = window.addEventListener.bind(window);
        const failure = new Error("listener installation failed");
        const remove = vi.spyOn(window, "removeEventListener");
        const add = vi
          .spyOn(window, "addEventListener")
          .mockImplementation((type, listener, options) => {
            if (type !== failedEvent || afterRegistration) originalAdd(type, listener, options);
            if (type === failedEvent) throw failure;
          });

        expect(() => instrumentation.enable()).toThrow(failure);
        const listener = add.mock.calls[0][1];
        expect(remove).toHaveBeenCalledWith("mousedown", listener);
        expect(remove).toHaveBeenCalledWith("keyup", listener);
        mouse(target);
        keyboard(target, "Enter");
        instrumentation.capturePageAction(target);
        instrumentation.trackPageAction({ name: "failed initialization" });
        expect(await records()).toEqual([]);

        add.mockRestore();
        instrumentation.enable();
        mouse(target);
        keyboard(target, "Enter");
        expect(await records()).toHaveLength(2);
        instrumentation.disable();
        mouse(target);
        keyboard(target, "Enter");
        expect(await records()).toHaveLength(2);
      },
    );

    it("supports manual capture with autoCapture disabled and updates automatic listeners with config", async () => {
      const { instrumentation, records } = createInstrumentation({ autoCapture: false });
      instrumentation.enable();
      const target = element('<button data-id="toggle"></button>');
      mouse(target);
      keyboard(target, "Enter");
      expect(await records()).toEqual([]);
      instrumentation.capturePageAction(target);
      expect(await records()).toHaveLength(1);
      instrumentation.setConfig({ enabled: true, autoCapture: true });
      mouse(target);
      keyboard(target, "Enter");
      expect(await records()).toHaveLength(3);
      instrumentation.setConfig({ enabled: true, autoCapture: false });
      mouse(target);
      keyboard(target, "Enter");
      expect(await records()).toHaveLength(3);
      instrumentation.trackPageAction({ name: "still manual" });
      expect(await records()).toHaveLength(4);
    });

    it("does not duplicate listeners across repeated enable, config replacement or re-enable", async () => {
      const { instrumentation, records } = createInstrumentation();
      const target = element('<button data-id="once"></button>');
      instrumentation.enable();
      instrumentation.enable();
      instrumentation.setConfig({ enabled: true });
      instrumentation.setConfig({ enabled: true });
      mouse(target);
      keyboard(target, "Enter");
      expect(await records()).toHaveLength(2);
      instrumentation.disable();
      instrumentation.disable();
      instrumentation.enable();
      instrumentation.enable();
      mouse(target);
      keyboard(target, " ");
      expect(await records()).toHaveLength(4);
    });

    it("suppresses automatic and manual emissions after disable and keeps disabled config updates inert", async () => {
      const { instrumentation, records } = createInstrumentation();
      instrumentation.enable();
      const target = element('<button data-id="disabled"></button>');
      mouse(target);
      expect(await records()).toHaveLength(1);
      instrumentation.disable();
      instrumentation.setConfig({ enabled: false, autoCapture: true });
      mouse(target);
      keyboard(target, "Enter");
      instrumentation.capturePageAction(target);
      instrumentation.trackPageAction({ name: "disabled" });
      expect(await records()).toHaveLength(1);
    });

    it("removes listeners and suppresses all capture when setConfig disables an active instance", async () => {
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      const applyCustomLogRecordData = vi.fn();
      const { instrumentation, records } = createInstrumentation({ applyCustomLogRecordData });
      const target = element('<button data-id="config-disabled"></button>');
      instrumentation.enable();
      mouse(target);
      expect(await records()).toHaveLength(1);
      const listeners = add.mock.calls.filter(([name]) => name === "mousedown" || name === "keyup");
      expect(listeners.map(([name]) => name)).toEqual(["mousedown", "keyup"]);

      instrumentation.setConfig({ enabled: false, applyCustomLogRecordData });
      expect(instrumentation.getConfig().enabled).toBe(false);
      expect(
        remove.mock.calls.filter(([name]) => name === "mousedown" || name === "keyup"),
      ).toEqual(listeners);
      expect(add.mock.calls.filter(([name]) => name === "mousedown" || name === "keyup")).toEqual(
        listeners,
      );
      mouse(target);
      keyboard(target, "Enter");
      instrumentation.capturePageAction(target);
      instrumentation.trackPageAction({ name: "config-disabled" });
      expect(await records()).toHaveLength(1);
      expect(applyCustomLogRecordData).toHaveBeenCalledOnce();

      instrumentation.enable();
      mouse(target);
      keyboard(target, "Enter");
      instrumentation.capturePageAction(target);
      instrumentation.trackPageAction({ name: "re-enabled" });
      expect(await records()).toHaveLength(5);
      expect(applyCustomLogRecordData).toHaveBeenCalledTimes(5);
    });

    it("removes the exact listeners installed by this instance on disable", () => {
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      const { instrumentation } = createInstrumentation();
      instrumentation.enable();
      instrumentation.enable();
      const listeners = add.mock.calls.filter(([name]) => name === "mousedown" || name === "keyup");
      expect(listeners.map(([name]) => name)).toEqual(["mousedown", "keyup"]);
      instrumentation.disable();
      instrumentation.disable();
      const removed = remove.mock.calls.filter(
        ([name]) => name === "mousedown" || name === "keyup",
      );
      expect(removed).toEqual(listeners);
    });

    it("refreshes its metadata snapshot on re-enable", async () => {
      const tag = meta("click-test:version", "first");
      const { instrumentation, records } = createInstrumentation({
        dataTags: { metaDataPrefix: "click-test:" },
      });
      instrumentation.enable();
      const target = element('<button data-id="metadata"></button>');
      tag.content = "second";
      instrumentation.capturePageAction(target);
      instrumentation.disable();
      instrumentation.enable();
      instrumentation.capturePageAction(target);
      const exported = await records();
      expect(
        JSON.parse(exported[0].attributes["browser.click.properties"] as string).pageTags.metaTags,
      ).toEqual({ "click-test:version": "first" });
      expect(
        JSON.parse(exported[1].attributes["browser.click.properties"] as string).pageTags.metaTags,
      ).toEqual({ "click-test:version": "second" });
    });

    it("routes independent instances to their bound providers and removes only their own listeners", async () => {
      const first = createInstrumentation({ pageTags: { owner: "first" } });
      const second = createInstrumentation({ pageTags: { owner: "second" } });
      first.instrumentation.enable();
      second.instrumentation.enable();
      const target = element('<button data-id="shared"></button>');
      mouse(target);
      const firstRecords = await first.records();
      const secondRecords = await second.records();
      expect(firstRecords).toHaveLength(1);
      expect(secondRecords).toHaveLength(1);
      expect(
        JSON.parse(firstRecords[0].attributes["browser.click.properties"] as string).pageTags.owner,
      ).toBe("first");
      expect(
        JSON.parse(secondRecords[0].attributes["browser.click.properties"] as string).pageTags
          .owner,
      ).toBe("second");
      first.instrumentation.disable();
      keyboard(target, "Enter");
      expect(await first.records()).toHaveLength(1);
      expect(await second.records()).toHaveLength(2);
      second.instrumentation.disable();
      first.instrumentation.enable();
      mouse(target);
      expect(await first.records()).toHaveLength(2);
      expect(await second.records()).toHaveLength(2);
    });
  });
});
