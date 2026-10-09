// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";

/**
 * Configuration for {@link getSdkLoaderScript}.
 *
 * @public
 */
export interface SdkLoaderConfig {
  /**
   * URL of a classic script that exposes
   * `Microsoft.OpenTelemetry.useMicrosoftOpenTelemetry` on `window`, such as the package's
   * `opentelemetry-browser.iife.min.js` bundle.
   *
   * @remarks
   * Defaults to this package version's immutable CDN bundle,
   * `https://js.monitor.azure.com/scripts/otel/<channel>/opentelemetry-browser.<version>.min.js`,
   * where the channel is `b` for stable releases and the prerelease identifier, such as `alpha`,
   * otherwise. The package's ESM output is not compatible with this loader. A UMD bundle only
   * sets the global when no AMD loader is present.
   */
  readonly src?: string;
  /** Azure Monitor connection string passed to the distribution initializer. */
  readonly connectionString: string;
  /** `crossorigin` value applied to the injected script. Defaults to `anonymous`. */
  readonly crossOrigin?: string;
  /** Subresource Integrity metadata applied to the injected script. */
  readonly integrity?: string;
}

const defaultSrc = (): string =>
  `https://js.monitor.azure.com/scripts/otel/${
    /^[^-+]+-([a-z]+)/.exec(OPENTELEMETRY_BROWSER_VERSION)?.[1] ?? "b"
  }/opentelemetry-browser.${OPENTELEMETRY_BROWSER_VERSION}.min.js`;

const inlineJson = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "\u2028":
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });

/**
 * Creates an inline loader that downloads the browser bundle and starts Azure Monitor telemetry.
 *
 * @remarks
 * The generated script exposes initialization as `window.microsoftOpenTelemetry`, a promise that
 * resolves to the distribution lifecycle handle and rejects when the bundle fails to load or
 * initialize. Without `src`, it loads this package version's bundle from the CDN; supply the
 * matching `integrity` value from the release's `integrity.json` to verify it.
 *
 * @public
 */
export function getSdkLoaderScript(config: SdkLoaderConfig): string {
  const src = config?.src === undefined ? defaultSrc() : config.src;
  if (typeof src !== "string" || src.trim() === "") {
    throw new TypeError("SdkLoaderConfig.src must be a non-empty string when provided.");
  }
  if (typeof config?.connectionString !== "string" || config.connectionString.trim() === "") {
    throw new TypeError("SdkLoaderConfig.connectionString must be a non-empty string.");
  }
  if (
    config.integrity !== undefined &&
    (typeof config.integrity !== "string" || config.integrity.trim() === "")
  ) {
    throw new TypeError("SdkLoaderConfig.integrity must be a non-empty string when provided.");
  }

  const serialized = inlineJson({
    src,
    connectionString: config.connectionString,
    crossOrigin: config.crossOrigin ?? "anonymous",
    ...(config.integrity === undefined ? {} : { integrity: config.integrity }),
  });
  return `!(function(w,d,c){var s=d.createElement("script");w.microsoftOpenTelemetry=new Promise(function(resolve,reject){s.src=c.src;s.crossOrigin=c.crossOrigin;if(c.integrity)s.integrity=c.integrity;s.onload=function(){var sdk=w.Microsoft&&w.Microsoft.OpenTelemetry;if(!sdk||typeof sdk.useMicrosoftOpenTelemetry!=="function"){reject(new Error("OpenTelemetry browser bundle did not expose Microsoft.OpenTelemetry"));return}Promise.resolve().then(function(){return sdk.useMicrosoftOpenTelemetry({azureMonitor:{connectionString:c.connectionString}})}).then(resolve,reject)};s.onerror=function(){reject(new Error("OpenTelemetry browser bundle failed to load: "+c.src))};d.head.appendChild(s)})})(window,document,${serialized});`;
}
