# Milestone M2 - Planning

Provide a supported browser artifact and a copy/paste setup path for applications that do not use a
bundler.

Status: nearly complete. The browser bundles, CDN publication and the CDN-backed snippet have
shipped. Validation against exact supported browser versions waits on the M1 browser matrix, and
snippet consent configuration remains.

## Work items

| Item | M2 outcome | Status |
| --- | --- | --- |
| Browser bundle | Build the production browser bundle from the supported distribution for the declared browser matrix and enforce minified, gzip and Brotli budgets. | In progress. UMD and IIFE SDK and instrumentation bundles, alongside CommonJS npm entries, ship after M0 and are tested in Chromium, Firefox and WebKit (#56). The UMD and IIFE bundles have blocking minified, gzip and Brotli budgets and an ES2022 syntax check (#84). Validation against exact supported browser versions waits on the M1 browser matrix. |
| CDN publishing | Publish each release at an immutable versioned CDN URL and make the URL available with the release artifacts. Integrity, caching, CSP, cross-origin loading and load-failure checks are acceptance criteria for this deliverable. | Done. `npm run build` prepares versioned `js.monitor.azure.com/scripts/otel/<channel>/` files with source maps and `integrity.json`, `npm run cdn:publish` uploads them with immutable caching, and a plain HTML integration test covers SRI, CSP, cross-origin loading and load failures in Chromium, Firefox and WebKit. `0.1.0-alpha.3` is published at `js.monitor.azure.com/scripts/otel/alpha/` (#86, #90), and the README documents CDN setup (#95). |
| Initialization snippet | Generate a concise copy/paste asynchronous snippet that loads the versioned bundle, applies connection and consent configuration, starts the distribution, and reports initialization success and failure. | In progress. `getSdkLoaderScript()` on `./snippet` (#53) loads this package version's CDN bundle by default, or a caller-supplied IIFE bundle, with optional SRI, starts Azure Monitor telemetry, and exposes initialization as the `window.microsoftOpenTelemetry` promise. Consent configuration remains. |

M2 does not add legacy tracking APIs or speculative loader and fallback variants.
