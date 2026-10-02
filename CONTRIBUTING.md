# Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant
Microsoft the rights to use your contribution. For details, visit
[Contributor License Agreements](https://cla.opensource.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a
CLA and decorate the pull request appropriately. Follow the instructions provided by the bot. You
only need to do this once across repositories using Microsoft's CLA process.

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more
information, see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com) with questions or concerns.

## Before You Start

- Search existing issues before opening a new one.
- Open an issue before starting large changes so the scope and direction can be discussed.
- Keep changes focused and include tests when behavior changes.

## Development Setup

1. Install a [Node.js](https://nodejs.org/) version supported by `package.json`.
2. Install Python 3.10 or newer, available as `python`, for the coverage artifact safety checks.
   These use only the Python standard library and do not affect the browser package.
3. Install dependencies and Chromium.
4. Run the repository checks before opening a pull request.

```powershell
npm ci
npm run test:install-browsers
npm run check
```

Microsoft contributors must use the required Microsoft package proxy. The committed lockfile omits
registry URLs so external contributors can install the same dependency versions from an accessible
npm registry.

## Pull Requests

- Describe the problem and the approach clearly.
- Link related issues when applicable.
- Update documentation when public behavior or setup changes.
- Keep the repository planning, API reports, and README documents aligned with the implementation.

## Performance Workflow

PR validation runs `npm run perf` after building the bundles in the Node.js 22 and 24 Chromium
jobs. These measurements and `npm run test:perf` are offline and do not require collector
configuration or publish telemetry.

The `Merged PR performance` workflow uses `pull_request_target: closed` so merged fork
contributions can access the upstream repository's Actions variables. The job runs only for
confirmed merges into `main` in `microsoft/opentelemetry-distro-browser`. It checks out the exact
`merge_commit_sha`, including the final squash or rebase commit, never the unmerged PR head.

The workflow uses read-only repository permissions and does not persist checkout credentials.
Checkout v7 also guards already-merged fork SHAs, so its `allow-unsafe-pr-checkout` opt-in is
restricted to this merged-only job. The exporter independently requires the same
`pull_request_target` merge event and rejects dirty results or a source SHA that differs from
the exact merged revision.

A repository administrator must set `SDK_PERF_COLLECTOR_ENDPOINT` under **Settings > Secrets
and variables > Actions > Variables** to the approved HTTPS collector URL ending in
`/otlp/v1/logs`. This must be an Actions variable, not a secret. Missing configuration,
measurement failures, and export failures fail the post-merge job explicitly. The workflow
does not publish from unmerged PRs, fork repositories, direct pushes, or manual dispatches.

The measurement step writes a GitHub job summary with the run UUID, measured commit, SDK
version, and bundle sizes before publishing. Use the UUID in the **MOT for Browser** page's
**Explicit run** selector. The summary remains available if publishing fails, and collector
acceptance alone does not confirm downstream ingestion or report refresh.
