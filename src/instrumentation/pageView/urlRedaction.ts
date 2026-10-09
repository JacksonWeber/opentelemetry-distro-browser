// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const REDACTED = "REDACTED";
const DEFAULT_QUERY_STRINGS_TO_REDACT = [
  "sig",
  "Signature",
  "AWSAccessKeyId",
  "X-Goog-Signature",
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "code",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "client_secret",
  "password",
] as const;

function redactParameters(
  searchParams: URLSearchParams,
  parametersToRedact: readonly string[],
): string {
  const parameters = new URLSearchParams(searchParams);
  for (const parameter of parametersToRedact) {
    if (parameters.has(parameter)) parameters.set(parameter, REDACTED);
  }
  return parameters.toString();
}

/** Applies the distribution's security redaction before an application sanitizer sees a URL. */
export function redactUrl(url: string, redactedQueryParams?: readonly string[]): string {
  const parsed = new URL(url);
  const parametersToRedact = redactedQueryParams ?? DEFAULT_QUERY_STRINGS_TO_REDACT;

  if (parsed.username || parsed.password) {
    parsed.username = REDACTED;
    parsed.password = REDACTED;
  }

  if (parsed.search) parsed.search = redactParameters(parsed.searchParams, parametersToRedact);

  const fragment = parsed.hash.slice(1);
  const fragmentParts = fragment.split("?");
  if (fragmentParts.length > 1) {
    const [prefix, ...queryParts] = fragmentParts;
    const prefixParameters = new URLSearchParams(prefix);
    const redactedPrefix = parametersToRedact.some((parameter) => prefixParameters.has(parameter))
      ? redactParameters(prefixParameters, parametersToRedact)
      : prefix;
    parsed.hash = [
      redactedPrefix,
      ...queryParts.map((query) =>
        redactParameters(new URLSearchParams(query), parametersToRedact),
      ),
    ].join("?");
  } else if (fragment.includes("=")) {
    parsed.hash = redactParameters(new URLSearchParams(fragment), parametersToRedact);
  }

  return parsed.href;
}
