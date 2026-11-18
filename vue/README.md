# Vue Observability

`@event-observability/vue` reports Vue errors to a Sentry-compatible collector using the official
Sentry SDK. The core requires Vue 3.5.42 or later within 3.x, Sentry Vue SDK
10.75.3 or later within 10.x, and Node 18+. Native Fetch, Axios, VueUse, Rollup, and
Vite have separate entry points. Import the integrations your application uses.

## Installation

Run `npm ci` and `npm pack` from this directory to build the tarball. Install it
in the Vue application. JavaScript applications can import it directly. TypeScript
applications use the declarations included in the same package.

```sh
npm install /path/to/event-observability-vue-0.2.1.tgz @sentry/vue@^10.75.3
```

For shared releases, publish the tarball to a private npm registry. Keep the
resolved dependency in the application's lockfile.

## Shared observer

```js
// observability.js
import { createObserver } from '@event-observability/vue'

export const observer = createObserver({
  application: 'my-app-frontend',
  dsn: import.meta.env.VITE_OBSERVER_DSN,
  environment: import.meta.env.VITE_OBSERVER_ENVIRONMENT,
  release: import.meta.env.VITE_OBSERVER_RELEASE,
})
```

Call `app.use(observer)` before `app.mount(...)` for Vue errors alone.
To also observe an existing Axios client and Vue Router instance, install it
with those adapters (Vue Router 4.3+ or 5.5.1+ within their respective majors).

```js
// Before app.mount(...)
import { observeAxios } from '@event-observability/vue/axios'
import { observer } from './observability.js'

app.use(observer, {
  router,
  adapters: [httpObserver => observeAxios(api, httpObserver)],
})
```

Install the plugin during client startup. It uses a single active Sentry client
per browser context. To switch applications, wait for `await observer.close()`
before installing a new observer. Closing or unmounting removes listeners,
watchers, and interceptors and closes the SDK client. If an adapter fails to
install, previously installed adapters are cleaned up. Register app-specific
Sentry event processors on the installed client with
`Sentry.getClient()?.addEventProcessor(processEvent)`. Processors on shared
SDK scopes persist across client changes within the same browser realm.

The factory receives settings explicitly. An omitted or empty DSN disables
reporting. Remote collectors require a public HTTPS DSN. HTTP is accepted on
loopback for local testing. A DSN with a password, query, or fragment produces
an installation error.

The optional Axios adapter supports Axios 1.20+ within 1.x. Add each client once. The adapter uses the client passed to it. If
`validateStatus` accepts a 5xx response, the adapter records it and preserves the
resolved response.

## Native Fetch

Use the wrapper anywhere you call Fetch. It returns the original response,
leaves the body available to the caller, and associates each HTTP failure with
its own response's request ID.

```js
import { observeFetch } from '@event-observability/vue/fetch'
import { observer } from './observability.js'

const apiFetch = observeFetch(globalThis.fetch.bind(globalThis), observer)
const response = await apiFetch('/api/orders')
```

## VueUse

The VueUse adapter supports `@vueuse/core` 10.9 through 15.x.
It preserves reactive URLs, hooks, and transformed errors. VueUse 15 itself
requires Node 22+ and its type declarations use Temporal and Web Bluetooth.
With TypeScript 7, include `ESNext` and `DOM` in `lib` and `web-bluetooth` in
an explicit `types` list.

```js
import { createObservedFetch } from '@event-observability/vue/vueuse'
import { observer } from './observability.js'

export const useApi = createObservedFetch({
  baseUrl: '/api',
  options: {
    refetch: true,
    beforeFetch: ctx => ctx,
    afterFetch: ctx => ctx,
    onFetchError: ctx => ctx,
  },
}, observer)
```

## Breadcrumbs and manual reporting

```js
observer.recordAction('record.save', 'attempt')
observer.reportError(new Error('Unexpected failure'))
```

Use static labels in actions and `data-observer-action`. Click breadcrumbs use
that attribute or the element type. Navigation breadcrumbs use router templates.
An optional user getter supplies an internal ID and clears it on logout when it
returns `null` or `undefined`. Set `privacy.captureUserId` to `true` to use it.

The event transport sends allowlisted error events and drops attachments.
Structured request fields exclude HTTP payloads, headers, cookies, query strings,
and fragments. Vue state and props are excluded. They include an `application` tag and, when
available, the `request_id` from the HTTP response. The adapter ignores canceled
requests and 4xx responses. Session tracking, replay, and tracing are disabled.

## Privacy configuration

The default omits free-text messages, breadcrumb descriptions, page and request
URLs, and user IDs. Stack frames can retain filtered code asset names for
symbolication. Set each option independently when creating the observer.
Supply options from the application's build or runtime configuration to use
different policies by environment.

```js
const observer = createObserver({
  application: 'my-app-frontend',
  dsn: import.meta.env.VITE_OBSERVER_DSN,
  privacy: {
    eventText: 'full',
    breadcrumbText: 'redact',
    urls: 'omit',
    captureUserId: false,
  },
})
```

Use `omit`, `redact`, or `full` for either text option. `redact` masks known
patterns and can retain personal data. `full` can include secrets and URLs
embedded in the message. Use `urls: 'redact'` to include filtered request and
navigation URL fields. Their path segments can still contain personal data.
The event allowlist continues to exclude HTTP body and header fields, Vue
props, and arbitrary context in all modes.

## Private sourcemaps

Install the CLI in the application that builds your assets.

```sh
npm install --save-dev @sentry/cli@^2.58.6
```

The build plugin stages generated bundles and their maps in a private temporary
directory, uploads them to the collector, and removes the staged files even on
failure. The write step waits for the collector to finish processing before
publishing the bundle. Generated maps stay out of the public output. An upload,
processing, or verification failure stops the build. Use a clean output directory to exclude files left by earlier builds
or copied from a public assets folder.

Use an HTTPS collector URL. HTTP is supported on loopback. Set the same release
in the build and browser runtime, and keep `SENTRY_AUTH_TOKEN` available only
to the build process. Both plugins support these collector settings.

| Build option | Behavior |
| --- | --- |
| `collector: 'sentry'` (default) | Wait for the Sentry CLI to confirm that processing has finished. |
| `collector: 'glitchtip'` | Wait until the release files API lists the expected names and checksums. Use a project release token and distinct asset basenames, such as content-hashed filenames. |
| `processingTimeoutSeconds` | Maximum processing wait, from 1 to 3600 seconds. The default is 60. |

Set `collector: 'glitchtip'` when building for GlitchTip. Use a unique release
identifier for each deployment so its maps match the deployed JavaScript.

### Rollup

Applications using Rollup 4.68.5+ within 4.x can add the plugin directly.
Set `base` to the public path of the output directory. It defaults to `/`.

```js
// rollup.config.mjs
import { observabilitySourcemaps } from '@event-observability/vue/rollup'

export default {
  input: 'src/main.js',
  output: { dir: 'dist', format: 'es' },
  plugins: [
    observabilitySourcemaps({
      enabled: process.env.OBSERVER_UPLOAD_SOURCEMAPS === 'true',
      base: '/assets/',
      release: process.env.OBSERVER_RELEASE,
      url: process.env.SENTRY_URL,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
}
```

Uploads run during `bundle.write()`, which Rollup's CLI uses for a configured
output directory. Calling `bundle.generate()` returns the build and its maps in memory and
skips the upload. A caller writing that result controls which files become public.

### Vite

The Vite adapter uses the application's configured `base` and the same uploader.
It supports Vite 6.4.6+, 7.3.8+, and 8.3.8+ within their respective majors.
`vite build` uploads during the write phase. Setting `build.write: false`
returns the build and its maps in memory and skips the upload.

```js
import { defineConfig, loadEnv } from 'vite'
import { observabilitySourcemaps } from '@event-observability/vue/vite'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  return {
    plugins: [
      observabilitySourcemaps({
        enabled: env.OBSERVER_UPLOAD_SOURCEMAPS === 'true',
        release: env.VITE_OBSERVER_RELEASE,
        url: env.SENTRY_URL,
        org: env.SENTRY_ORG,
        project: env.SENTRY_PROJECT,
        authToken: env.SENTRY_AUTH_TOKEN,
      }),
    ],
  }
})
```

Vite is supplied by the host application. Audit that application's lockfile and
use trusted build configuration. The listed Vite releases depend on picomatch,
which has an advisory for processing untrusted glob patterns. The native Rollup
build path works independently of Vite. [picomatch advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)

## Development

```sh
npm ci
npm test
npm audit
npm pack --dry-run
```

Edit the TypeScript modules in `src/`. Run `npm run build` to generate ESM
JavaScript and declarations in `dist/`. Both `npm test` and `npm pack` build
from source. The tarball includes the compiled modules and their types.

The development lockfile records the dependency tree used by the tests and
audit. Tests exercise the Sentry SDK with an in-memory transport, the Vite
adapter configuration, and real Rollup builds with simulated CLI uploads.
TypeScript checks usage of all seven public entry points in strict mode.
