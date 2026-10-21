// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isValidInstrumentationKey,
  parseConnectionString,
} from "../../../src/exporter/connectionStringParser.js";

const instrumentationKey = "00000000-0000-0000-0000-000000000000";
const publicCloudConnectionString =
  `InstrumentationKey=${instrumentationKey};` +
  "IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;" +
  "LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;" +
  "ApplicationId=3cd3dd3f-64cc-4d7c-9303-8d69a4bb8558";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Azure Monitor connection string", () => {
  it("uses the public cloud endpoints by default", () => {
    const warn = vi.spyOn(diag, "warn");
    expect(parseConnectionString(`InstrumentationKey=${instrumentationKey}`)).toEqual({
      instrumentationKey,
      ingestionEndpoint: "https://dc.services.visualstudio.com",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("parses explicit public cloud endpoints", () => {
    const warn = vi.spyOn(diag, "warn");
    expect(parseConnectionString(publicCloudConnectionString)).toEqual({
      instrumentationKey,
      ingestionEndpoint: "https://eastus-8.in.applicationinsights.azure.com",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      suffix: "applicationinsights.azure.us",
      ingestionEndpoint: "https://usgovvirginia.dc.applicationinsights.azure.us",
    },
    {
      suffix: "applicationinsights.azure.cn",
      ingestionEndpoint: "https://chinaeast2.dc.applicationinsights.azure.cn",
    },
  ])("resolves sovereign cloud endpoints for $suffix", (expected) => {
    const location = expected.suffix.endsWith(".us") ? "usgovvirginia" : "chinaeast2";
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};EndpointSuffix=${expected.suffix};Location=${location}`,
    );

    expect(result.ingestionEndpoint).toBe(expected.ingestionEndpoint);
  });

  it("prefers explicit HTTPS endpoints and preserves their paths", () => {
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};EndpointSuffix=applicationinsights.azure.us;` +
        "IngestionEndpoint= HTTPS://custom.ingest.example:8443/ingest/ ;" +
        "LiveEndpoint=https://custom.live.example/",
    );

    expect(result.ingestionEndpoint).toBe("https://custom.ingest.example:8443/ingest");
  });

  it.each([
    ["http://localhost:4318/", "http://localhost:4318"],
    ["HTTP://LOCALHOST:4318/ingest/", "http://localhost:4318/ingest"],
    ["http://localhost.:4318/", "http://localhost.:4318"],
    ["HTTP://LOCALHOST.:4318/ingest/", "http://localhost.:4318/ingest"],
    ["http://127.0.0.1:4318/", "http://127.0.0.1:4318"],
    ["http://127.0.0.2/", "http://127.0.0.2"],
    ["http://127.255.255.254/", "http://127.255.255.254"],
    ["http://127.1/", "http://127.0.0.1"],
    ["http://[::1]:4318/", "http://[::1]:4318"],
    ["http://[0:0:0:0:0:0:0:1]/", "http://[::1]"],
  ])("allows HTTP loopback endpoint %s for local development", (endpoint, expected) => {
    const warn = vi.spyOn(diag, "warn");
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};` +
        `IngestionEndpoint=${endpoint};LiveEndpoint=${endpoint}`,
    );

    expect(result.ingestionEndpoint).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    "http://example.test/",
    " HTTP://EXAMPLE.TEST/ ",
    "http://localhost.example.test/",
    "http://localhost.example.test./",
    "http://localhost..:4318/",
    "http://localhost.@example.test/",
    "http://127.0.0.1.example.test/",
    "http://127.example.test/",
    "http://localhost@example.test/",
    "http://127.0.0.1@example.test/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://0.0.0.0/",
    "http://128.0.0.1/",
    "http://[::]/",
    "http://[2001:db8::1]/",
    "ftp://localhost/",
    "ftp://127.0.0.1/",
    "file:///custom/ingest",
    "not-a-url",
    "",
  ])("rejects endpoint %s with a diagnostic and HTTPS defaults", (endpoint) => {
    const warn = vi.spyOn(diag, "warn");
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};` +
        `IngestionEndpoint=${endpoint};LiveEndpoint=${endpoint}`,
    );

    expect(result.instrumentationKey).toBe(instrumentationKey);
    expect(result.ingestionEndpoint).toBe("https://dc.services.visualstudio.com");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Invalid IngestionEndpoint: use HTTPS, or HTTP only for localhost or a loopback IP address. Using a fallback endpoint.",
    );
  });

  it.each(["http", "ftp"])("discards %s overrides and uses suffix-derived endpoints", (scheme) => {
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};EndpointSuffix=applicationinsights.azure.us;` +
        `Location=usgovvirginia;IngestionEndpoint=${scheme}://custom.ingest.example;` +
        `LiveEndpoint=${scheme}://custom.live.example`,
    );

    expect(result.ingestionEndpoint).toBe("https://usgovvirginia.dc.applicationinsights.azure.us");
  });

  it("uses public cloud defaults when overrides and suffix-derived endpoints are invalid", () => {
    const warn = vi.spyOn(diag, "warn");
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};EndpointSuffix=example.test:invalid-port;` +
        "IngestionEndpoint=http://example.test;LiveEndpoint=http://example.test",
    );

    expect(result.ingestionEndpoint).toBe("https://dc.services.visualstudio.com");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("discards malformed endpoint overrides independently", () => {
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};IngestionEndpoint=not-a-url;` +
        "LiveEndpoint=https://custom.live.example/",
    );

    expect(result.ingestionEndpoint).toBe("https://dc.services.visualstudio.com");
  });

  it("parses supported fields case-insensitively and ignores unused fields", () => {
    expect(
      parseConnectionString(
        `instrumentationKEY=${instrumentationKey};INGESTIONendpoint=https://custom.ingest.example;` +
          "ApplicationId=app-id;AadAudience=audience;LiveEndpoint=https://custom.live.example",
      ),
    ).toEqual({ instrumentationKey, ingestionEndpoint: "https://custom.ingest.example" });
  });

  it.each([";", " ; ", ";;", "; ;"])("ignores empty fields in %j", (emptyFields) => {
    const result = parseConnectionString(
      `${emptyFields}InstrumentationKey=${instrumentationKey};` +
        `IngestionEndpoint=https://custom.ingest.example/${emptyFields}`,
    );

    expect(result.instrumentationKey).toBe(instrumentationKey);
    expect(result.ingestionEndpoint).toBe("https://custom.ingest.example");
  });

  it("discards a malformed connection string", () => {
    expect(parseConnectionString(`InstrumentationKey=${instrumentationKey};invalid`)).toEqual({
      ingestionEndpoint: "https://dc.services.visualstudio.com",
    });
  });

  it("preserves equals signs in field values", () => {
    const result = parseConnectionString(
      `InstrumentationKey=${instrumentationKey};IngestionEndpoint=https://custom.ingest.example/?a=b`,
    );

    expect(result.instrumentationKey).toBe(instrumentationKey);
    expect(result.ingestionEndpoint).toBe("https://custom.ingest.example/?a=b");
  });

  it.each([
    [instrumentationKey, true],
    [instrumentationKey.toUpperCase(), true],
    ["not-an-instrumentation-key", false],
  ])("validates instrumentation key %s", (value, expected) => {
    expect(isValidInstrumentationKey(value)).toBe(expected);
  });
});
