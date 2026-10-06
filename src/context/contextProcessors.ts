// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { isNonEmptyString } from "../shared/isNonEmptyString.js";
import {
  ATTR_ENDUSER_ID,
  ATTR_ENDUSER_PSEUDO_ID,
  ATTR_USER_ACCOUNT_ID,
  ATTR_USER_ID,
} from "../user/constants.js";
import type { UserContextProvider } from "../user/createUserContext.js";

export interface BrowserContextProvider extends UserContextProvider {
  getSessionId(): string | null;
}

type AttributeBag = Readonly<Record<string, unknown>>;

function enrich(
  attributes: AttributeBag,
  resourceAttributes: AttributeBag,
  setAttribute: (name: string, value: string) => void,
  provider: BrowserContextProvider,
): void {
  if (!isNonEmptyString(attributes["session.id"])) {
    const sessionId = provider.getSessionId();
    if (sessionId !== null) setAttribute("session.id", sessionId);
  }
  // Identity configured on the record or its resource belongs to the application.
  const hasIdentity = (name: string): boolean =>
    isNonEmptyString(attributes[name]) || isNonEmptyString(resourceAttributes[name]);
  if (!hasIdentity(ATTR_ENDUSER_PSEUDO_ID)) {
    setAttribute(ATTR_ENDUSER_PSEUDO_ID, provider.getAnonymousUserId());
  }
  // Managed user and account form one identity; never mix them with application identity.
  if (
    !hasIdentity(ATTR_USER_ID) &&
    !hasIdentity(ATTR_ENDUSER_ID) &&
    !hasIdentity(ATTR_USER_ACCOUNT_ID)
  ) {
    const userId = provider.getAuthenticatedUserId();
    if (userId !== undefined) setAttribute(ATTR_USER_ID, userId);
    const accountId = provider.getAccountId();
    if (accountId !== undefined) setAttribute(ATTR_USER_ACCOUNT_ID, accountId);
  }
}

export class BrowserContextSpanProcessor implements SpanProcessor {
  public constructor(private readonly provider: BrowserContextProvider) {}

  public onStart(span: Span): void {
    enrich(
      span.attributes,
      span.resource.attributes,
      (name, value) => span.setAttribute(name, value),
      this.provider,
    );
  }

  public onEnd(): void {}

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export class BrowserContextLogRecordProcessor implements LogRecordProcessor {
  public constructor(private readonly provider: BrowserContextProvider) {}

  // Enrichment must not enable logging; the SDK still invokes onEmit for accepted records.
  public enabled(): boolean {
    return false;
  }

  public onEmit(record: ReadWriteLogRecord): void {
    enrich(
      record.attributes,
      record.resource.attributes,
      (name, value) => record.setAttribute(name, value),
      this.provider,
    );
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
