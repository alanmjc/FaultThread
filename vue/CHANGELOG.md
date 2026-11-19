# Changelog

## 0.4.0

- Renames the npm package to `@faultthread/vue`. All module entry points use the new scope.
- Adds the `FaultThread` classic page global and `FaultThreadWorker` service worker global. Existing classic integrations and queued events continue to work across the upgrade.

## 0.3.0

- Adds opt-in OpenReplay, on-device masking and high-fidelity DOM and public canvas capture.
- Persists sanitized errors, explicit application logs and replay batches during outages, with acknowledgement-based retries, integrity checks and controls for rejected uploads.
- Adds service worker delivery, an optional versioned public-asset precache and a standalone ES5 error reporter for older browsers.
- Exposes the durable outbox for custom collectors and application events requiring confirmation of a local write.

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
