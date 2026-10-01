# Repository guidance

## Markdown file creation

Avoid creating new Markdown (`.md`) files as part of routine work. Prefer updating existing
documentation, subject to the README restrictions below. Only add a new document when explicitly
requested by the user or when it adds clear, lasting value that existing documentation cannot cover.
Do not create summary, planning, progress, or implementation-note Markdown files unless requested.

## README changes

Do not add `README.md` files inside source folders. This repository has one root `README.md`.
Document code in TSDoc on the declarations themselves.

Do not modify the root `README.md` during general updates unless the user explicitly requests
README changes. This includes feature work, bug fixes, dependency updates, tooling changes, and
formatting. Do not replace the existing README with generated summaries or generic project scaffolding.

When README changes are explicitly requested, preserve its existing structure, voice, and content
unless the requested change requires otherwise, and keep edits limited to the requested scope.

## JavaScript distro alignment

Use [microsoft/opentelemetry-distro-javascript](https://github.com/microsoft/opentelemetry-distro-javascript)
as a design reference. Align public APIs, configuration, naming, and initialization/lifecycle patterns
where practical and compatible with the browser environment. Prefer established distro patterns over
inventing alternatives, but do not pursue parity at the expense of browser bundle size. Explain
necessary deviations and use the bundle-size checks below to evaluate runtime or dependency tradeoffs.

## Browser bundle size

Treat minified browser bundle size as a design constraint for every change, not a final cleanup.
Optimize the emitted production JavaScript rather than source length:

- Use type-only imports and exports for contracts so upstream SDK types add no runtime code.
- Prefer tree-shakeable modules and supported, focused public dependency entry points. Keep optional
  exporters and instrumentations out of unrelated bundles; avoid unnecessary runtime wrappers,
  duplicate helpers, polyfills, and type-only concepts emitted as runtime objects.
- Keep diagnostics concise and actionable. Do not sacrifice correctness, public API compatibility,
  useful error reporting, or readable source through hand-minification or unsafe property mangling.
- For runtime, dependency, or build changes, compare before/after sizes using the same production
  build: `npm run build` followed by `npm run size`. Check minified, gzip, and Brotli output, not
  unminified source size or summed dependency sizes. Investigate unexpected growth with
  `reports/bundle-stats.html` and verify unused exports remain tree-shakeable.
