// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";

const DEFAULT_INGESTION_ENDPOINT = "https://dc.services.visualstudio.com";
const DEFAULT_LIVE_ENDPOINT = "https://rt.services.visualstudio.com";

type ConnectionStringKey =
  | "authorization"
  | "aadaudience"
  | "applicationid"
  | "instrumentationkey"
  | "ingestionendpoint"
  | "liveendpoint"
  | "location"
  | "endpointsuffix";

type ParsedConnectionString = Partial<Record<ConnectionStringKey, string>>;

export interface ResolvedConnectionString {
  readonly instrumentationKey?: string;
  readonly ingestionEndpoint: string;
  readonly liveEndpoint: string;
  readonly aadAudience?: string;
  readonly applicationId?: string;
  readonly location?: string;
}

const connectionStringKeys = new Set<ConnectionStringKey>([
  "authorization",
  "aadaudience",
  "applicationid",
  "instrumentationkey",
  "ingestionendpoint",
  "liveendpoint",
  "location",
  "endpointsuffix",
]);

function sanitizeEndpoint(endpoint: string | undefined, name: string): string | undefined {
  if (endpoint === undefined) return undefined;

  try {
    const sanitizedEndpoint = new URL(endpoint.trim());
    const { hostname, protocol } = sanitizedEndpoint;
    const isLoopback =
      hostname === "localhost" ||
      hostname === "localhost." ||
      hostname === "[::1]" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    if (protocol === "https:" || (protocol === "http:" && isLoopback)) {
      const value = sanitizedEndpoint.toString();
      return value.endsWith("/") ? value.slice(0, -1) : value;
    }
  } catch {
    // Report invalid URLs below.
  }
  diag.warn(
    `Invalid ${name}: use HTTPS, or HTTP only for localhost or a loopback IP address. Using a fallback endpoint.`,
  );
  return undefined;
}

function parseFields(connectionString: string): ParsedConnectionString | undefined {
  const fields: ParsedConnectionString = {};

  for (const field of connectionString.split(";")) {
    const separatorIndex = field.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex !== field.lastIndexOf("=")) {
      diag.error(
        "Connection string key-value pair is invalid: Entire connection string will be discarded",
      );
      return undefined;
    }

    const key = field.slice(0, separatorIndex).trim().toLowerCase();
    if (connectionStringKeys.has(key as ConnectionStringKey)) {
      fields[key as ConnectionStringKey] = field.slice(separatorIndex + 1).trim();
    }
  }

  return fields;
}

export function parseConnectionString(connectionString: string): ResolvedConnectionString {
  const fields = parseFields(connectionString);
  if (!fields || Object.keys(fields).length === 0) {
    diag.error("An invalid connection string was passed in. There may be telemetry loss");
    return {
      ingestionEndpoint: DEFAULT_INGESTION_ENDPOINT,
      liveEndpoint: DEFAULT_LIVE_ENDPOINT,
    };
  }

  let fallbackIngestionEndpoint = DEFAULT_INGESTION_ENDPOINT;
  let fallbackLiveEndpoint = DEFAULT_LIVE_ENDPOINT;
  if (fields.endpointsuffix) {
    const locationPrefix = fields.location ? `${fields.location}.` : "";
    fallbackIngestionEndpoint = `https://${locationPrefix}dc.${fields.endpointsuffix}`;
    fallbackLiveEndpoint = `https://${locationPrefix}live.${fields.endpointsuffix}`;
  }

  if (fields.authorization && fields.authorization.toLowerCase() !== "ikey") {
    diag.warn(
      "Connection String contains an unsupported 'Authorization' value. Defaulting to 'Authorization=ikey'",
    );
  }

  return {
    instrumentationKey: fields.instrumentationkey,
    ingestionEndpoint:
      sanitizeEndpoint(fields.ingestionendpoint, "IngestionEndpoint") ??
      sanitizeEndpoint(fallbackIngestionEndpoint, "IngestionEndpoint") ??
      DEFAULT_INGESTION_ENDPOINT,
    liveEndpoint:
      sanitizeEndpoint(fields.liveendpoint, "LiveEndpoint") ??
      sanitizeEndpoint(fallbackLiveEndpoint, "LiveEndpoint") ??
      DEFAULT_LIVE_ENDPOINT,
    aadAudience: fields.aadaudience,
    applicationId: fields.applicationid,
    location: fields.location,
  };
}

export function isValidInstrumentationKey(instrumentationKey: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instrumentationKey);
}
