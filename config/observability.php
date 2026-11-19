<?php

declare(strict_types=1);

return [
    'application' => env('OBSERVER_APPLICATION', env('APP_NAME', 'laravel')),
    'dsn' => env('OBSERVER_DSN', env('SENTRY_LARAVEL_DSN', env('SENTRY_DSN'))),
    'environment' => env('SENTRY_ENVIRONMENT', env('APP_ENV', 'production')),
    'release' => env('SENTRY_RELEASE'),
    'outbox_path' => env('OBSERVABILITY_OUTBOX_PATH', storage_path('app/private/event-observability')),
    'http_connect_timeout' => (float) env('SENTRY_HTTP_CONNECT_TIMEOUT', 1),
    'http_timeout' => (float) env('SENTRY_HTTP_TIMEOUT', 2),
    'max_breadcrumbs' => 100,
    'capture_user_id' => env('OBSERVER_CAPTURE_USER_ID', false),
    'privacy' => [
        'event_text' => env('OBSERVER_EVENT_TEXT', 'omit'),
        'breadcrumb_text' => env('OBSERVER_BREADCRUMB_TEXT', 'omit'),
        'urls' => env('OBSERVER_URLS', 'omit'),
    ],
];
