// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";

const DEFAULT_INGESTION_ENDPOINT = "https://dc.services.visualstudio.com";

type ConnectionStringKey =
  "authorization" | "instrumentationkey" | "ingestionendpoint" | "location" | "endpointsuffix";

type ParsedConnectionString = Partial<Record<ConnectionStringKey, string>>;

export function isSupportedEndpoint({ hostname, protocol }: URL): boolean {
  const isLoopback =
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  return protocol === "https:" || (protocol === "http:" && isLoopback);
}

/** Connection string fields used by the browser exporter. Other fields are ignored. */
export interface ResolvedConnectionString {
  readonly instrumentationKey?: string;
  readonly ingestionEndpoint: string;
}

const connectionStringKeys = new Set<ConnectionStringKey>([
  "authorization",
  "instrumentationkey",
  "ingestionendpoint",
  "location",
  "endpointsuffix",
]);

function sanitizeEndpoint(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;

  try {
    const sanitizedEndpoint = new URL(endpoint.trim());
    if (isSupportedEndpoint(sanitizedEndpoint)) {
      const value = sanitizedEndpoint.toString();
      return value.endsWith("/") ? value.slice(0, -1) : value;
    }
  } catch {
    // Report invalid URLs below.
  }
  diag.warn(
    "Invalid IngestionEndpoint: use HTTPS, or HTTP only for localhost or a loopback IP address. Using a fallback endpoint.",
  );
  return undefined;
}

function parseFields(connectionString: string): ParsedConnectionString | undefined {
  const fields: ParsedConnectionString = {};

  for (const field of connectionString.split(";")) {
    if (!field.trim()) {
      continue;
    }

    const separatorIndex = field.indexOf("=");
    if (separatorIndex <= 0) {
      diag.error("Invalid connection string pair; connection string ignored");
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
    diag.error("Invalid connection string; telemetry may be lost");
    return { ingestionEndpoint: DEFAULT_INGESTION_ENDPOINT };
  }

  const fallbackIngestionEndpoint = fields.endpointsuffix
    ? `https://${fields.location ? `${fields.location}.` : ""}dc.${fields.endpointsuffix}`
    : DEFAULT_INGESTION_ENDPOINT;

  if (fields.authorization && fields.authorization.toLowerCase() !== "ikey") {
    diag.warn("Unsupported connection string Authorization; using ikey");
  }

  return {
    instrumentationKey: fields.instrumentationkey,
    ingestionEndpoint:
      sanitizeEndpoint(fields.ingestionendpoint) ??
      sanitizeEndpoint(fallbackIngestionEndpoint) ??
      DEFAULT_INGESTION_ENDPOINT,
  };
}

export function isValidInstrumentationKey(instrumentationKey: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instrumentationKey);
}
