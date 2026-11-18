# Changelog

## 0.2.1

- Builds the JavaScript modules and type declarations from a single TypeScript implementation. JavaScript and TypeScript applications keep their existing imports.

## 0.2.0

- Adds a native Rollup build path and waits for source maps to become available when using the Rollup or Vite adapter.
- Requires HTTPS for remote collectors. For GlitchTip uploads, set `collector: 'glitchtip'`.
- Preserves Axios response transformations, retries and requests in flight when the observer closes.

## 0.1.0

- Added a Vue observer with explicit configuration and lifecycle cleanup.
- Added allowlisted event data and configurable application identification.
- Added optional native Fetch, Axios, and VueUse adapters with request correlation.
- Added the Vite plugin for uploading private release sourcemaps.
- Filters final SDK envelopes, including attachments and internal SDK errors.
- Added TypeScript declarations and tests that run without a live collector.
