// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { redactUrl } from "../../../src/instrumentation/pageView/urlRedaction.js";

describe("redactUrl", () => {
  it.each([
    "https://example.test/products?color=blue#details",
    "file:///C:/Users/example/Documents/file.txt",
    "data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==",
  ])("preserves a URL that contains no sensitive fields: %s", (url) => {
    expect(redactUrl(url)).toBe(url);
  });

  it("redacts empty and valueless sensitive parameters", () => {
    expect(redactUrl("https://example.test:8443/path?Signature=&sig#section")).toBe(
      "https://example.test:8443/path?Signature=REDACTED&sig=REDACTED#section",
    );
  });

  it.each([
    ["https://user:pass@example.test/path", "https://REDACTED:REDACTED@example.test/path"],
    [
      "https://admin:secret@192.168.1.1:8443/admin",
      "https://REDACTED:REDACTED@192.168.1.1:8443/admin",
    ],
    [
      "https://user%40domain.com:p%40ssw%24rd@example.test/path",
      "https://REDACTED:REDACTED@example.test/path",
    ],
    [
      "https://user%2540domain:pass%2540word@example.test",
      "https://REDACTED:REDACTED@example.test/",
    ],
    [
      "https://user:pass@example.test/path@somewhere",
      "https://REDACTED:REDACTED@example.test/path@somewhere",
    ],
    ["https://user@example.test/path", "https://REDACTED:REDACTED@example.test/path"],
    [
      `https://${"u".repeat(300)}:${"p".repeat(300)}@example.test/path`,
      "https://REDACTED:REDACTED@example.test/path",
    ],
  ])("redacts URL credentials in %s", (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  it("redacts credentials in a Unicode URL", () => {
    const redacted = new URL(redactUrl("https://user:пароль@例子.测试/路径?参数=值"));
    expect(redacted.username).toBe("REDACTED");
    expect(redacted.password).toBe("REDACTED");
    expect(redacted.hostname).toBe("xn--fsqu00a.xn--0zwm56d");
    expect(redacted.searchParams.get("参数")).toBe("值");
  });

  it("redacts the OpenTelemetry defaults using URLSearchParams serialization", () => {
    const redacted = redactUrl(
      "https://example.test/path?sig=secret&Signature=other&AWSAccessKeyId=key&X-Goog-Signature=google&X-Amz-Signature=aws&X-Amz-Credential=credential&X-Amz-Security-Token=token&return=a%20b&flag",
    );

    expect(redacted).toBe(
      "https://example.test/path?sig=REDACTED&Signature=REDACTED&AWSAccessKeyId=REDACTED&X-Goog-Signature=REDACTED&X-Amz-Signature=REDACTED&X-Amz-Credential=REDACTED&X-Amz-Security-Token=REDACTED&return=a+b&flag=",
    );
  });

  it("redacts OAuth parameters in query strings and fragments", () => {
    expect(
      redactUrl(
        "https://app.example/callback?code=query-secret#access_token=access-secret&id_token=id-secret&state=public",
      ),
    ).toBe(
      "https://app.example/callback?code=REDACTED#access_token=REDACTED&id_token=REDACTED&state=public",
    );
  });

  it("redacts OAuth parameters after a hash-router path", () => {
    expect(
      redactUrl("https://app.example/#/callback?access_token=ACCESS&id_token=ID&state=public"),
    ).toBe("https://app.example/#/callback?access_token=REDACTED&id_token=REDACTED&state=public");
  });

  it("redacts OAuth parameters on both sides of a question mark in a parameter fragment", () => {
    expect(redactUrl("https://app.example/#access_token=SECRET?state=public&id_token=ID")).toBe(
      "https://app.example/#access_token=REDACTED?state=public&id_token=REDACTED",
    );
  });

  it.each([
    ["https://app.example/#?access_token=SECRET", "https://app.example/#?access_token=REDACTED"],
    ["https://app.example/#access_token=SECRET?", "https://app.example/#access_token=REDACTED?"],
    [
      "https://app.example/#/search/foo=bar?access_token=SECRET",
      "https://app.example/#/search/foo=bar?access_token=REDACTED",
    ],
    [
      "https://app.example/#/callback?state=public?access_token=SECRET",
      "https://app.example/#/callback?state=public?access_token=REDACTED",
    ],
  ])("handles an ambiguous fragment boundary in %s", (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  it("uses case-sensitive names and collapses repeated exact keys", () => {
    expect(redactUrl("https://example.test/?TOKEN=one&token=two&token=&color=blue")).toBe(
      "https://example.test/?TOKEN=one&token=REDACTED&color=blue",
    );
  });

  it.each([
    ["code=x", "code=REDACTED"],
    ["code=%78", "code=REDACTED"],
    ["co%64e=x", "code=REDACTED"],
    ["access%5Ftoken=x", "access_token=REDACTED"],
    ["%63%6F%64%65=x", "code=REDACTED"],
  ])("redacts tiny or encoded sensitive query data in %s", (query, expected) => {
    expect(redactUrl(`https://example.test/?${query}#${query}`)).toBe(
      `https://example.test/?${expected}#${expected}`,
    );
  });

  it("uses URLSearchParams replacement semantics for malformed encoded data", () => {
    expect(redactUrl("https://example.test/?safe=%E0%A4%A&code=x")).toBe(
      "https://example.test/?safe=%EF%BF%BD%25A&code=REDACTED",
    );
  });

  it("replaces the default parameter list when redactedQueryParams is configured", () => {
    expect(
      redactUrl(
        "https://user:pass@example.test/?code=default&tenant_secret=custom#access_token=default&tenant_secret=custom",
        ["tenant_secret"],
      ),
    ).toBe(
      "https://REDACTED:REDACTED@example.test/?code=default&tenant_secret=REDACTED#access_token=default&tenant_secret=REDACTED",
    );
  });

  it("supports an empty custom list without disabling credential redaction", () => {
    expect(redactUrl("https://user:pass@example.test/?code=visible", [])).toBe(
      "https://REDACTED:REDACTED@example.test/?code=visible",
    );
  });

  it.each([
    "code",
    "token",
    "access_token",
    "id_token",
    "refresh_token",
    "client_secret",
    "password",
  ])("redacts the OAuth parameter %s in query strings and fragments", (name) => {
    expect(redactUrl(`https://example.test/?${name}=query#${name}=fragment&safe=value`)).toBe(
      `https://example.test/?${name}=REDACTED#${name}=REDACTED&safe=value`,
    );
  });

  it("does not treat an ordinary anchor as query parameters", () => {
    const url = "https://example.test/path?color=blue#token-section";
    expect(redactUrl(url)).toBe(url);
  });

  it.each(["", " ", "not a URL?code=secret", "/relative?code=secret", "://user:pass@example.test"])(
    "throws for an unparseable URL so its caller can fail closed: %j",
    (url) => {
      expect(() => redactUrl(url)).toThrow();
    },
  );
});
