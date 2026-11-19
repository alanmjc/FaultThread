# Laravel Observability

`event-observability/laravel` reports Laravel errors to a Sentry-compatible
collector using the official SDK. It correlates requests and errors with
`X-Request-Id` and limits the event data sent to the collector.

Install the Laravel package for backend errors, the [Vue package](vue/README.md) for
browser errors, or both to correlate a failure across the HTTP response. The
browser package supports native Fetch, Axios, VueUse, optional OpenReplay session
replay and private sourcemaps with Rollup or Vite. For offline storage on phones,
tablets and desktops, see the [browser delivery and setup guide](vue/README.md#delivery-during-network-outages).

## Architecture

```mermaid
flowchart LR
    subgraph BROWSER["Browser"]
        VUE["Vue application"]
        FRONTEND["Vue observer and Sentry SDK"]
        VUE -->|Vue and HTTP errors| FRONTEND
        BROWSER_QUEUE["Local error outbox"]
        FRONTEND --> BROWSER_QUEUE
        VUE -->|Optional consented replay| REPLAY_QUEUE["OpenReplay service worker and local batches"]
    end

    subgraph BACKEND["Laravel application"]
        MIDDLEWARE["Request correlation middleware"]
        APP["Routes and exception handler"]
        SENTRY["Event sanitizer and Sentry SDK"]
        MIDDLEWARE <-->|Request and response| APP
        APP -->|Reported exceptions| SENTRY
        MIDDLEWARE -->|5xx fallback events| SENTRY
    end

    VUE <-->|HTTP and X-Request-Id| MIDDLEWARE
    REPLAY_QUEUE -->|Replay batches and public canvas frames| OR["OpenReplay collector"]
    BROWSER_QUEUE -->|Sanitized frontend events| COLLECTOR["Sentry-compatible event collector"]
    SENTRY -->|Sanitized envelopes| DISK["Private Laravel outbox"]
    DISK -->|HTTPS delivery| COLLECTOR
```

The response carries `X-Request-Id`. When a browser adapter can read it, related
frontend and backend events can be matched in the configured collector using the `request_id` tag.

## Requirements

| Laravel | Minimum PHP |
| --- | --- |
| 12.71+ within 12.x | 8.2 |
| 13.40+ within 13.x | 8.3 |

These minimum versions include upstream security fixes. Applications on Laravel 11
need to upgrade before installing this revision. The package requires PHP's
`mbstring` extension and Sentry's Laravel SDK 4.28 or later within the 4.x series.

## Installation

To try the current checkout from a Laravel application, register its local path
and require the development branch. Composer links the checkout when the
filesystem supports symlinks.

```sh
composer config repositories.observability-local path /absolute/path/to/observabilidad
composer require event-observability/laravel:dev-main
```

For the release ZIP, place it in a directory dedicated to Composer artifacts.
Composer reads the release version directly from the ZIP.

```sh
composer config repositories.observability-archives artifact /absolute/path/to/archives
composer require event-observability/laravel:^0.3.0
```

A shared host can run the package without a queue worker, jobs table, Redis, or
cron. Its optional queue listener runs only when the application processes a job.
The web process needs a writable private directory for delivery during outages.

For a private Composer registry hosting version 0.3.0, use its endpoint instead.

```sh
composer config repositories.observability-packages composer "$COMPOSER_REGISTRY_URL"
composer require event-observability/laravel:^0.3.0
```

Serve versioned release archives from stable registry URLs so existing
installations can still resolve and download them if the source code moves.

Laravel discovers the service provider and registers the request middleware automatically.
Register Sentry's exception handler once in the application's `bootstrap/app.php`.

```php
use Illuminate\Foundation\Configuration\Exceptions;
use Sentry\Laravel\Integration;

// Inside the Application::configure(...) chain:
->withExceptions(function (Exceptions $exceptions): void {
    Integration::handles($exceptions);
})
```

When migrating an existing application, remove its previous 5xx reporting middleware
and migrate any custom Sentry settings that refer to its old integration classes.
Keep a single call to `Integration::handles()`.

## Configuration

Set the application name, DSN, environment, and release in the Laravel application's environment.

```dotenv
OBSERVER_APPLICATION=my-app-backend
OBSERVER_DSN=
SENTRY_ENVIRONMENT=staging
SENTRY_RELEASE=my-app-backend@deployment-id
SENTRY_HTTP_CONNECT_TIMEOUT=1
SENTRY_HTTP_TIMEOUT=2
```

`OBSERVER_DSN` takes precedence over `SENTRY_LARAVEL_DSN` and `SENTRY_DSN`.
An explicitly empty value disables reporting. An invalid DSN disables delivery
and makes `observability:diagnose` exit with an error without printing the DSN.
Use an HTTPS DSN with a public project key. The standard transport verifies
the collector's TLS certificate. HTTP is supported on loopback for local testing.
Passwords, query strings and fragments make the DSN invalid.
`APP_ENV` is the fallback environment.

To customize the package configuration in PHP, publish
`config/observability.php`. Rebuild the configuration cache after changing
settings in an application that uses cached configuration.

```sh
php artisan vendor:publish --tag=observability-config
php artisan config:cache
php artisan observability:diagnose
```

The diagnostic command checks configuration without printing credentials or
sending an event. Run `php artisan observability:diagnose --send` to send a fixed
synthetic event through the configured transport. With the default transport,
success requires an HTTP 2xx acknowledgement for that specific event ID. A
retained event can still reach the collector after the command reports failure.

### Server delivery during outages

Laravel writes each sanitized error envelope to
`storage/app/private/event-observability` before the first HTTP attempt. Set
`OBSERVABILITY_OUTBOX_PATH` to an absolute path on persistent private storage
to override this location. Keep it outside the document root and across releases.
The filesystem must support file locking, hard links, atomic rename and syncing of
files and directories. For multiple application instances, use a persistent
volume per instance or a shared filesystem that provides these operations.

Records are isolated by application name and collector DSN. A later request
retries one eligible envelope during termination. A quiet site resumes on its
next request. Timeouts, HTTP 408, 425, 429 and 5xx responses back off, including
collector rate limits. Confirmed 2xx delivery removes the record. An interruption
between acceptance and deletion can resend the same event ID.

To process a backlog immediately or retry after fixing a collector rejection, run:

```sh
php artisan observability:outbox
php artisan observability:outbox --limit=100 --retry-blocked
```

The command attempts up to 25 envelopes by default (`--limit` accepts 1–100).
It prints pending and blocked counts and exits nonzero while either has records.
Permanent HTTP rejections remain blocked until explicitly retried. Files that
fail their checksum or envelope identity checks are retained with a `.corrupt`
suffix in the private `blocked` directory for inspection. They require recovery
from a trusted copy. Monitor storage space during extended outages. If the
server cannot persist a new error, the package logs a local diagnostic and tries
immediate HTTP delivery. Simultaneous disk and network failure can lose that
event. Applications using a custom `sentry.transport` manage their own delivery.

### Privacy settings by deployment

Configure each application and environment independently. Choose the event
and breadcrumb text settings separately so a deployment can send exception
messages while omitting logs and action descriptions.
For a deployment with both Laravel and Vue, configure each SDK with its
own policy and DSN. For a deployment with only one runtime, configure that
package alone.

| Laravel environment variable | Vue `privacy` option | Values and default |
| --- | --- | --- |
| `OBSERVER_EVENT_TEXT` | `eventText` | `omit` (default), `redact`, `full` |
| `OBSERVER_BREADCRUMB_TEXT` | `breadcrumbText` | `omit` (default), `redact`, `full` |
| `OBSERVER_URLS` | `urls` | `omit` (default), `redact` |
| `OBSERVER_CAPTURE_USER_ID` | `captureUserId` | `false` (default), `true` |

- `omit` keeps diagnostic structure such as exception type, stack locations,
  HTTP status, request correlation, and breadcrumb categories. It replaces
  captured free-text messages with placeholders or omits the text field.
- `redact` masks recognized patterns. Free text and URL path segments can
  still contain personal data. URL redaction strips credentials, query strings,
  and fragments from the URL fields it handles.
- `full` sends the text of the selected field as captured. It can include
  personal data, secrets, or URLs embedded in that text. Enable it only for
  deployments where the collector is authorized to receive that data.
- User ID capture adds the internal ID. Evaluate that ID according to the
  application's data policy. Vue also accepts a `getUserId` callback when
  user ID capture is enabled.

For example, a deployment with restricted collector access can enable full
exception text and keep breadcrumb text and IDs omitted.

```dotenv
OBSERVER_EVENT_TEXT=full
OBSERVER_BREADCRUMB_TEXT=omit
OBSERVER_URLS=omit
OBSERVER_CAPTURE_USER_ID=false
```

Keep the defaults for deployments that only need structured diagnostics. For
development or staging, choose `redact` for the text and URL fields that
developers need. Existing Laravel apps with a published `capture_user_id`
setting can change it directly or replace it with the environment-backed
setting from the current configuration.

## Reporting and privacy

### Request correlation and error reporting

```mermaid
flowchart TD
    REQUEST["Incoming HTTP request"] --> ID["Reuse a valid X-Request-Id or generate one"]
    ID --> HANDLE["Run Laravel with the request ID in the Sentry scope"]
    HANDLE --> RESPONSE["Prepare the HTTP response with the same X-Request-Id"]
    RESPONSE --> FALLBACK{"5xx response without a reported exception?"}
    FALLBACK -->|No| RETURN["Return the HTTP response"]
    FALLBACK -->|Yes| CAPTURE["Capture a 5xx event"]
    CAPTURE --> RETURN
    HANDLE -->|Laravel reports an exception| FILTER["Sanitize the event and tag it with request_id"]
    CAPTURE --> FILTER
    FILTER -->|DSN configured| DISK["Persist the sanitized error envelope"]
    DISK --> COLLECTOR["Send the envelope and remove it after HTTP 2xx"]
```

- The global middleware reuses a request ID of 1–64 alphanumeric or hyphen
  characters or generates a random, 32-character hexadecimal ID. It returns the
  ID in `X-Request-Id`, including on error responses, and tags events with
  `request_id`. For cross-origin requests, allow and expose this header in the
  application's CORS settings. Request IDs are public correlation labels. Use a
  generated opaque value and keep authorization decisions independent of it.
- Laravel handles exception reporting. A 5xx response without a reported
  exception generates an event grouped by method, route template, and status.
  A 4xx response alone does not generate an event. To report a caught exception
  that returns a successful or 4xx response, call `report($exception)`.
- Each HTTP request and queue job has its own SDK scope. Nested synchronous
  jobs restore their parent's context on return. Worker failures keep their job
  context while Laravel reports the exception.
- Events include the `application` tag, environment, release, approved
  breadcrumbs, stack frame locations, and optionally an internal user ID.
  The event allowlist removes HTTP body and header fields, cookies, source
  snippets, frame variables, and unrelated context in every privacy mode.
- Reporting is synchronous with configurable connection and request timeouts.
  Invalid timeouts and values below one millisecond use the defaults of one
  second to connect and two seconds total. Transport failures preserve the
  application's response. SDK diagnostics go to the local PHP error log
  without event payloads.
- The integration disables tracing, profiling, structured logs, metrics, and
  Spotlight. Outgoing Laravel HTTP requests omit Sentry trace and baggage
  headers. SDK features explicitly called by the host application, such as
  cron check-ins, have their own data contract.

## Development

Run these commands from the directory containing `composer.json`.

```sh
composer validate --strict
composer install
composer test
composer audit
```

The library resolves dependencies for the current PHP version. To test
Laravel 13 explicitly on PHP 8.3 or later, run
`composer update --with 'laravel/framework:^13.40'` in a separate working copy.
The test suite boots a minimal Laravel application. It exercises custom transports,
private disk retention, collector responses and delivery on a later request.

To run the suite against an existing Laravel installation that already includes
the Sentry SDK dependencies, set `OBSERVER_TEST_AUTOLOAD` to its autoloader.

```sh
OBSERVER_TEST_AUTOLOAD=/path/to/app/vendor/autoload.php \
  php /path/to/phpunit.phar -c phpunit.xml.dist
```

Composer distribution archives exclude development files and the Vue package.
For a release distributed via an artifact repository, set the release manifest's
`version` field to the published version in the staging directory before archiving.
Consuming applications manage their own dependency locks.

```sh
composer archive --format=zip --dir=/path/to/archives
```
