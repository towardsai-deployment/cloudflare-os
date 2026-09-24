# Backend utilities

`@gadgets/backend-utils` is a shared library for code that runs in Cloudflare Workers. It is not a
standalone Worker and has no deployable entrypoint or Wrangler project configuration.

The package's Vitest configuration uses the Workers test pool to exercise runtime-specific APIs.
Consumers that import `@gadgets/backend-utils/observability-context` must enable `nodejs_als` (or
`nodejs_compat`); the default `@gadgets/backend-utils/logger` entry point has no such requirement.

An observability context exposes typed `.with()` and `.get()` methods, and creates loggers that
inherit its ambient fields.

The optional `@gadgets/backend-utils/error-reporting` entry point dispatches bounded error events to
a private Reporter bound as `ERROR_REPORTER`; `reportIssue(failureSite, caught, options?)` accepts
ambient fields under `options.attributes`, so callers can spread the context's `.get()` result and
augment it inline. Reporting is a no-op when the binding is absent.

`@gadgets/backend-utils/document-markdown` converts uploaded or fetched documents (PDF, Word,
Excel, OpenDocument, Numbers) to Markdown through the Workers AI binding's `toMarkdown()`, with
embedded-image conversion always off so it stays in the free tier. Its format list and messages
also live in `@gadgets/backend-utils/document-formats`, which has no Workers types and so can be
imported by browser bundles.
