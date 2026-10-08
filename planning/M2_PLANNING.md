# Milestone M2 - Planning

Provide a supported browser artifact and a copy/paste setup path for applications that do not use a
bundler.

Status: in progress. The browser bundle awaits exact supported browser versions from M1; CDN
publishing and the initialization snippet remain.

## Work items

| Item | M2 outcome | Status |
| --- | --- | --- |
| Browser bundle | Build the production browser bundle from the supported distribution for the declared browser matrix and enforce minified, gzip and Brotli budgets. | In progress. UMD and IIFE bundles ship with blocking minified, gzip and Brotli budgets and an ES2022 syntax check. Validation against exact supported browser versions waits on the M1 browser matrix. |
| CDN publishing | Publish each release at an immutable versioned CDN URL and make the URL available with the release artifacts. Integrity, caching, CSP, cross-origin loading and load-failure checks are acceptance criteria for this deliverable. | Not started |
| Initialization snippet | Generate a concise copy/paste asynchronous snippet that loads the versioned bundle, applies connection and consent configuration, starts the distribution, and reports initialization success and failure. | Not started |

M2 does not add legacy tracking APIs or speculative loader and fallback variants.
