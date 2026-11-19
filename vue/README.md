# Vue Observability

`@event-observability/vue` reports Vue errors to a Sentry-compatible collector using the official
Sentry SDK. The core requires Vue 3.5.42 or later within 3.x, Sentry Vue SDK
10.75.3 or later within 10.x, and Node 18+. Native Fetch, Axios, VueUse, OpenReplay, Rollup, and
Vite have separate entry points. Import the integrations your application uses.

## Installation

Run `npm ci` and `npm pack` from this directory to build the tarball. Install it
in the Vue application. JavaScript applications can import it directly. TypeScript
applications use the declarations included in the same package.

```sh
npm install /path/to/event-observability-vue-0.3.0.tgz @sentry/vue@^10.75.3
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

## Delivery during network outages

The default error transport writes the sanitized Sentry envelope to IndexedDB
before its first delivery attempt. It also supports localStorage in the page.
A successful HTTP response from the configured Sentry or GlitchTip collector
acknowledges the event. An interrupted response can cause another submission
with the same event ID. Changing the application or DSN selects a different queue.
A supplied `transport` continues to own its delivery and retention.

Network failures, HTTP 408, 425, 429 and server errors are retried with backoff.
The transport respects collector rate-limit headers. Permanent rejections and
records failing the checksum stay in storage for inspection. After fixing a
collector or authorization problem, call `await observer.retryDelivery()`.
`await observer.deliveryStatus()` reports `pending` and `blocked` counts, or
`null` for a custom or inactive transport. `memoryOnly` counts errors held
in the current page when durable storage failed. `unavailable` signals that
a storage backend could not be checked. Set `onDeliveryError(error)` on the
observer to surface storage and collector problems locally.

The foreground client retries on startup and reconnection. The service worker
below can also deliver saved errors when the browser grants Background Sync.
A foreground visit resumes delivery on browsers that suspend background work.
Disk quotas, private browsing, clearing site data and device failure affect
retention. The SDK may also have an event or a frame in memory when the OS kills
the process. HTTP acceptance confirms ingestion at the receiver. Availability
in the receiver's dashboard depends on its own processing and retention.

On a user gesture, the application can request persistent storage and display
the browser's decision and estimated quota.

```js
import { requestPersistentStorage } from '@event-observability/vue/storage'

const { persistent, usage, quota } = await requestPersistentStorage()
```

### Other collectors and critical application events

The same persistent outbox is available for a custom protocol. Give each
application, environment and destination its own stable queue name. Use a fresh
ID per event and reuse it on retries. Pass JSON data that is safe to retain on
the device. The following receiver explicitly acknowledges durable ingestion
with HTTP 200 and deduplicates by event ID.

```js
import { DurableOutbox } from '@event-observability/vue/outbox'

const queue = new DurableOutbox('orders:prod:audit-v1', async (event, id) => {
  const response = await fetch('/telemetry/audit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, event }), redirect: 'error',
  })
  if (response.status === 200) return { state: 'ack' }
  if ([408, 425, 429].includes(response.status) || response.status >= 500) return { state: 'retry' }
  return { state: 'blocked', reason: 'HTTP ' + response.status }
})
queue.start() // Each time the application opens
await queue.put(eventId, { code: 'order.saved' })
```

`put()` completes after a local write. If every durable store fails, it rejects,
so the application can keep a critical operation open. A network exception
retains the queued item for another attempt. `status()`, `retryBlocked()` and
`stop()` expose the same delivery lifecycle to the application.

## Optional OpenReplay

Install the tested tracker in applications using replay.

```sh
npm install @openreplay/tracker@19.1.2
```

Recording is disabled by default. The replay plugin runs independently of the
error observer and its Sentry DSN. Set `enabled` to the boolean `true`, install
the plugin, and call `start()` after the user's recording choice. The tracker
loads at that point. Do Not Track and Global Privacy Control disable recording.
`stop()` ends capture, including an in-progress start. Vue unmount calls it
automatically. Previously authorized and persisted packets can finish delivery.

```js
import { createOpenReplay } from '@event-observability/vue/openreplay'

const replay = createOpenReplay({
  enabled: import.meta.env.VITE_REPLAY_ENABLED === 'true',
  projectKey: import.meta.env.VITE_REPLAY_PROJECT_KEY,
})
app.use(replay)

// In the handler that grants recording permission
const recordingStarted = await replay.start()
// In the handler that withdraws it
replay.stop()
```

`start()` returns `false` if permission, browser features, configuration or
the selected gateway are unavailable. By default it requires the local service
worker at `/__observability/openreplay`. Use `gatewayPath` if the worker uses
a different path. One tracker owns a document. Reuse its controller when
restarting. An explicitly supplied `ingestPoint` on the page selects direct,
online-only recording to that HTTPS collector.

### Visual fidelity and sensitive data

Replay captures DOM changes, scrolling, pointer movement, styles, supported web
animations and the viewport. Masking happens on the device. Apply
`data-openreplay-unmask` to public UI whose text and images may be recorded. Mark
private regions with `data-openreplay-hidden` on the surrounding element from
the first render. Input values, select controls and editable fields stay private
inside public sections. Public canvas/WebGL surfaces need the unmask attribute
on the canvas itself. Their pixel data cannot be inspected for confidential
content. The OpenReplay server controls canvas availability, quality and FPS.
For a self-hosted installation enable canvas and select the server's high quality
setting. [OpenReplay canvas configuration](https://docs.openreplay.com/en/session-replay/canvas/)

```html
<header data-openreplay-unmask>Order status</header>
<canvas data-openreplay-unmask id="public-chart"></canvas>
<section data-openreplay-hidden><!-- Account or payment details --></section>
```

Keep secrets out of CSS, asset URLs, and element IDs. Use public asset paths and
a public `<base href>` if the application serves assets under a subdirectory.
The privacy profile omits page locations from batch headers, console logs,
network bodies and cross-origin frame capture. Use `Referrer-Policy: no-referrer`
on the host page so browser-managed requests also omit its address. The tracker
uses a blob worker. Allow the configured collector in `connect-src` and the
site's own workers plus `blob:` in `worker-src`.

### Installing durable replay delivery

Serve the worker over HTTPS (loopback HTTP is supported for development).
Copy `dist/openreplay-worker.global.js` from the installed package to a
versioned public path. The following is a classic service worker at
`/observability-sw.js`. If the site already owns a service worker, add these
handlers to it. The module equivalent is `@event-observability/vue/openreplay-worker`.

```js
importScripts('/vendor/observability-0.3.0/openreplay-worker.global.js')

EventObservabilityWorker.installOpenReplayGateway({
  projectKey: 'YOUR_PUBLIC_OPENREPLAY_PROJECT_KEY',
  ingestPoint: 'https://replay.example.org/ingest',
})
EventObservabilityWorker.installEventDeliveryWorker({
  application: 'my-app-frontend',
  dsn: 'https://PUBLIC_KEY@errors.example.org/1',
})
```

The application and worker must use the same project key. For background error
delivery, use the same application name and DSN as the Vue observer. Register
the worker during application setup and allow it to control the page before
the first recording attempt.

```js
if ('serviceWorker' in navigator) {
  await navigator.serviceWorker.register('/observability-sw.js')
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise(resolve =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
  }
}
```

To reopen the application during a device-wide outage, precache its public
app shell and versioned build files on an earlier connected visit. Include the
lazy OpenReplay chunk. An existing PWA's precache can do this. Alternatively,
the same worker includes the following helper. Populate it from the deployment's
actual build manifest. Serve every listed resource with `Cache-Control: public`.
The optional navigation fallback serves a static public shell for exact paths.

```js
EventObservabilityWorker.installOfflineAssets({
  version: 'release-42',
  assets: ['/assets/app.abc123.js', '/assets/replay.def456.js', '/assets/app.abc123.css'],
  navigationFallback: { shell: '/offline.abc123.html', paths: ['/app'] },
})
```

The client requests a flush every second and on page hide or stop. The browser
can still suspend it before a flush finishes. The gateway saves SDK batches
and canvas uploads locally before acknowledging them to the tracker.
It forwards the original data to the configured project,
checks delivery integrity and keeps enough acknowledged history to restore a
session if its token expires while packets are pending. An ambiguous ACK or a
restored session can appear twice upstream. When the first recording starts
offline, the gateway can store DOM changes immediately after provisioning.
Canvas frames use capabilities previously confirmed by that project's server.
Inspect `await replay.deliveryStatus()` and call `await replay.retryDelivery()`
after correcting a permanent rejection. The SDK and collector versions matter
for this protocol. The tracker peer is pinned and tested against actual binary
batches, input masking and session recovery.

### Older devices

The full Vue integration needs the APIs of Vue 3, its Sentry SDK and the
OpenReplay tracker. Durable replay also needs a controlling service worker,
Cache Storage, IndexedDB, Web Crypto and a previously provisioned application.
Where those APIs are unavailable, the package includes a standalone ES5 error
reporter. Serve `dist/legacy/observer.js` as a classic script and initialize it
on the application's legacy entry point. It uses XMLHttpRequest and can retain
basic error type, timestamp and stable ID in localStorage across page loads.

```html
<script src="/vendor/observability-0.3.0/legacy/observer.js"></script>
<script>
  var errors = EventObservability.install({
    application: 'my-app-legacy',
    dsn: 'https://PUBLIC_KEY@errors.example.org/1'
  })
</script>
```

Use a separate collector origin and configure CORS and the page's referrer policy.
The legacy API provides `errors.reportError(error)`, `reportLog(message, level)`, `status()`, `flush()`,
`retryBlocked()` and `stop()`. Its basic error reporting works independently of
Vue, session replay and service workers. Devices that cannot negotiate the
collector's TLS configuration need a supported local application or HTTPS
gateway to deliver data.

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
const eventId = observer.reportLog('Offline order saved', 'info')
```

Use `reportLog()` for important messages that should reach GlitchTip or Sentry
even if no exception occurs. It returns a correlation ID for the event, or
`null` when the observer is inactive. The default text policy retains the level
and replaces the message with a placeholder. Choose `redact` or `full` for
deployments that need message text. The ES5 reporter always uses a placeholder.
Breadcrumbs from `recordAction()` accompany the next captured event.

Use static labels in actions and `data-observer-action`. Click breadcrumbs use
that attribute or the element type. Navigation breadcrumbs use router templates.
An optional user getter supplies an internal ID and clears it on logout when it
returns `null` or `undefined`. Set `privacy.captureUserId` to `true` to use it.

The event transport sends allowlisted error events and drops attachments.
Structured request fields exclude HTTP payloads, headers, cookies, query strings,
and fragments. Vue state and props are excluded. They include an `application` tag and, when
available, the `request_id` from the HTTP response. The adapter ignores canceled
requests and 4xx responses. The Sentry client disables session tracking, Sentry Replay and tracing.

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
TypeScript checks the public contracts in strict mode. Run `npm run test:browser`
with Chromium available to verify the actual replay bytes and offline delivery
after a reload. Set `CHROMIUM_PATH` to select the browser executable.
