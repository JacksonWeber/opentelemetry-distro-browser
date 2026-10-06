# OpenTelemetry Dependency Policy

## Pinned versions

OpenTelemetry dependencies use exact versions in the root `package.json`. Exact pins are required
because the logs SDK and browser instrumentation are pre-1.0 and may introduce breaking changes
in a minor release.

| Release cohort          | Packages                                                                                                                                                                    | Version   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| API                     | `@opentelemetry/api`                                                                                                                                                        | `1.9.1`   |
| Stable SDK              | `@opentelemetry/core`, `@opentelemetry/resources`, `@opentelemetry/sdk-trace`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-trace-web`                              | `2.11.0`  |
| Development SDK         | `@opentelemetry/api-logs`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/instrumentation`, `@opentelemetry/sdk-logs` | `0.222.0` |
| Browser SDK             | `@opentelemetry/browser-sdk`                                                                                                                                                | `0.4.0`   |
| Browser instrumentation | `@opentelemetry/browser-instrumentation`                                                                                                                                    | `0.8.1`   |
| Semantic conventions    | `@opentelemetry/semantic-conventions`                                                                                                                                       | `1.43.0`  |

The different version numbers are intentional. OpenTelemetry JavaScript publishes stable SDK,
development SDK, and instrumentation packages on related but independently numbered release
lines. Compatibility is determined from package peer dependencies and verified by tests, not by
forcing every package to use the same version number.

## Upgrade policy

1. Upgrade an OpenTelemetry release cohort atomically. Do not update only one package from the
   stable SDK or `0.x` development SDK cohort.
2. Inspect release notes, public type declarations, peer dependencies, and browser support before
   changing a pin. Do not import internal OpenTelemetry paths or carry local forks without an
   approved architecture decision.
3. Keep direct OpenTelemetry dependencies exact. Regenerate and commit `package-lock.json` with
   the manifest so clean installs resolve the reviewed dependency graph.
4. Run `npm ci`, `npm ls`, `npm run typecheck`, `npm run lint`, and the unit and browser test suites.
   Upgrades must preserve multi-instance isolation, context propagation, lifecycle cleanup, and
   tree shaking.
5. Review duplicate versions of `@opentelemetry/api`. A release must use one compatible API copy
   in the production dependency graph.
6. Treat every `0.x` minor update as potentially breaking. Record any compatibility limitation or
   fallback before merging an update to browser instrumentation or the logs SDK line.
7. Update the table above in the same change as the package pins. OpenTelemetry dependency updates
   require API and package-owner review.

Automated dependency update tooling may open pull requests, but it must not merge OpenTelemetry
updates automatically.
