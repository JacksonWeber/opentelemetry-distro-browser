// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Configuration for {@link getSdkLoaderScript}.
 *
 * @public
 */
export interface SdkLoaderConfig {
  /**
   * URL of a classic script that exposes
   * `Microsoft.OpenTelemetry.useMicrosoftOpenTelemetry` on `window`.
   *
   * @remarks
   * The package's ESM output is not compatible with this loader. No CDN location is assumed.
   */
  readonly src: string;
  /** Azure Monitor connection string passed to the distribution initializer. */
  readonly connectionString: string;
  /** `crossorigin` value applied to the injected script. Defaults to `anonymous`. */
  readonly crossOrigin?: string;
  /** Subresource Integrity metadata applied to the injected script. */
  readonly integrity?: string;
}

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
 * Creates an inline loader that downloads a supplied browser bundle and starts Azure Monitor
 * telemetry.
 *
 * @remarks
 * The generated script exposes initialization as `window.microsoftOpenTelemetry`, a promise that
 * resolves to the distribution lifecycle handle. The caller must supply the bundle URL because
 * this package does not assume that any version has been published to a CDN.
 *
 * @public
 */
export function getSdkLoaderScript(config: SdkLoaderConfig): string {
  if (typeof config?.src !== "string" || config.src.trim() === "") {
    throw new TypeError("SdkLoaderConfig.src must be a non-empty string.");
  }
  if (typeof config.connectionString !== "string" || config.connectionString.trim() === "") {
    throw new TypeError("SdkLoaderConfig.connectionString must be a non-empty string.");
  }
  if (
    config.integrity !== undefined &&
    (typeof config.integrity !== "string" || config.integrity.trim() === "")
  ) {
    throw new TypeError("SdkLoaderConfig.integrity must be a non-empty string when provided.");
  }

  const serialized = inlineJson({
    src: config.src,
    connectionString: config.connectionString,
    crossOrigin: config.crossOrigin ?? "anonymous",
    ...(config.integrity === undefined ? {} : { integrity: config.integrity }),
  });
  return `!(function(w,d,c){var s=d.createElement("script");w.microsoftOpenTelemetry=new Promise(function(resolve,reject){s.src=c.src;s.crossOrigin=c.crossOrigin;if(c.integrity)s.integrity=c.integrity;s.onload=function(){var sdk=w.Microsoft&&w.Microsoft.OpenTelemetry;if(!sdk||typeof sdk.useMicrosoftOpenTelemetry!=="function"){reject(new Error("OpenTelemetry browser bundle did not expose Microsoft.OpenTelemetry"));return}Promise.resolve().then(function(){return sdk.useMicrosoftOpenTelemetry({azureMonitor:{connectionString:c.connectionString}})}).then(resolve,reject)};s.onerror=function(){reject(new Error("OpenTelemetry browser bundle failed to load: "+c.src))};d.head.appendChild(s)})})(window,document,${serialized});`;
}
