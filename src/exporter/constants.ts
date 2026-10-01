// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export const MAX_RETRY_AFTER_MS: number = 24 * 60 * 60 * 1000;
export const MAX_SEND_ATTEMPTS: number = 4;
export const RETRY_DELAY_MS: number = 1_000;
export const MAX_RETRY_DELAY_MS: number = 64_000;
export const MAX_BATCH_SIZE_IN_BYTES: number = 100 * 1024;
export const MAX_PENDING_KEEPALIVE_BODY_SIZE: number = 60 * 1024;
export const MAX_PENDING_KEEPALIVE_REQUESTS: number = 9;
export const MAX_BEACON_BODY_SIZE: number = 65_000;

export const HTTP_METHOD = "http.request.method";
export const HTTP_STATUS_CODE = "http.response.status_code";
export const SERVER_ADDRESS = "server.address";
export const SERVER_PORT = "server.port";
export const URL_FULL = "url.full";

export const EXCEPTION_MESSAGE = "exception.message";
export const EXCEPTION_STACKTRACE = "exception.stacktrace";
export const EXCEPTION_TYPE = "exception.type";
export const NAVIGATION_DURATION = "browser.navigation.duration";
export const NAVIGATION_EVENT_NAME = "browser.navigation";
