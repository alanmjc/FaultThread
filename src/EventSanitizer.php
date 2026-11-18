<?php

declare(strict_types=1);

namespace EventObservability\Laravel;

use Illuminate\Database\QueryException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Sentry\Breadcrumb;
use Sentry\Event;
use Sentry\EventHint;
use Sentry\ExceptionMechanism;
use Sentry\Frame;
use Sentry\Integration\FrameContextifierIntegration;
use Sentry\Integration\RequestIntegration;
use Sentry\Stacktrace;
use Sentry\UserDataBag;
use Symfony\Component\HttpFoundation\Exception\SuspiciousOperationException;
use Throwable;

final class EventSanitizer
{
    public static function integrations(array $integrations): array
    {
        return array_values(array_filter(
            $integrations,
            static fn (object $integration): bool => ! $integration instanceof FrameContextifierIntegration
                && ! $integration instanceof RequestIntegration,
        ));
    }

    public static function beforeSend(Event $event, ?EventHint $hint = null): ?Event
    {
        if (! config('sentry.dsn')) {
            return null;
        }
        $textMode = config('observability.privacy.event_text');
        $includeUrls = config('observability.privacy.urls') === 'redact';
        $original = $event;
        $request = app()->bound('request') ? request() : null;
        $activeId = $request?->attributes->get(ObserveRequest::ACTIVE);
        $scopeTags = $original->getTags();
        $requestId = $scopeTags['request_id'] ?? null;
        $isJob = isset($scopeTags[ObserveQueue::SCOPE_TAG]);
        $isRequestScope = ! $isJob && is_string($activeId) && $activeId === $requestId;
        $includeRequest = ! $isJob && ($activeId === null || $isRequestScope);

        // A fresh event excludes contexts, extra data, attachments and future SDK fields by default.
        $event = Event::createEvent($original->getId())
            ->setTimestamp($original->getTimestamp())
            ->setLevel($original->getLevel())
            ->setRelease($original->getRelease())
            ->setEnvironment($original->getEnvironment())
            ->setSdkIdentifier($original->getSdkIdentifier())
            ->setSdkVersion($original->getSdkVersion())
            ->setExceptions(self::exceptions($original, $hint, $textMode))
            ->setStacktrace(self::stacktrace($original->getStacktrace()))
            ->setBreadcrumb(array_values(array_filter(array_map(
                [self::class, 'beforeBreadcrumb'], $original->getBreadcrumbs(),
            ))));

        if ($includeRequest) {
            $event->setRequest(self::requestData($original, $isRequestScope ? $request : null, $includeUrls));
            // The Laravel SDK retains the last matched route name in process-global state.
            if ($includeUrls && $isRequestScope && $request->route() !== null && $original->getTransaction() !== null) {
                $event->setTransaction(Redaction::url($original->getTransaction()));
            }
        }
        if ($isRequestScope && $hint?->exception !== null) {
            $request->attributes->set(ObserveRequest::REPORTED, true);
        }
        $tags = ['application' => (string) config('observability.application')];
        if (is_string($requestId) && preg_match('/^[a-z\d-]{1,64}$/iD', $requestId) === 1) {
            $tags['request_id'] = $requestId;
        }
        $status = self::httpStatus($scopeTags['http.status_code'] ?? null);
        if ($status !== null) {
            $tags['http.status_code'] = (string) $status;
        }
        $event->setTags($tags);

        $message = $original->getMessageFormatted() ?? $original->getMessage();
        if ($message !== null) {
            $event->setMessage(Redaction::text($message, $textMode) ?? 'Application event');
        }
        $fingerprint = $original->getFingerprint();
        if ($isRequestScope && $status >= 500 && $fingerprint === ObserveRequest::responseFingerprint($request, $status)) {
            $event->setFingerprint($fingerprint);
            if ($message !== null && ! in_array($textMode, ['redact', 'full'], true)) {
                $event->setMessage("HTTP {$status} response without a reported exception");
            }
        } elseif (in_array($textMode, ['redact', 'full'], true)) {
            $event->setFingerprint(array_values(array_map([Redaction::class, 'message'], array_filter($fingerprint, 'is_string'))));
        }
        if (config('observability.capture_user_id') === true) {
            $userId = $original->getUser()?->getId() ?? ($isRequestScope ? self::userId() : null);
            if ($userId !== null) {
                $event->setUser(UserDataBag::createFromUserIdentifier((string) $userId));
            }
        }

        return $event;
    }

    /** @return array{method?: string, url?: string} */
    private static function requestData(Event $event, ?Request $activeRequest, bool $includeUrls): array
    {
        $explicit = $event->getRequest();
        $method = $explicit['method'] ?? $activeRequest?->getRealMethod();
        $url = $explicit['url'] ?? null;
        if ($includeUrls && $url === null && $activeRequest !== null) {
            try {
                $url = $activeRequest->root().$activeRequest->getPathInfo();
            } catch (SuspiciousOperationException) {
                // Keep the route path when Symfony rejects an untrusted Host.
                $url = $activeRequest->getPathInfo();
            }
        }

        return array_filter([
            'method' => $method !== null ? ObserveRequest::normalizeMethod($method) : null,
            'url' => $includeUrls && is_string($url) ? Redaction::url($url) : null,
        ]);
    }

    /** @return list<\Sentry\ExceptionDataBag> */
    private static function exceptions(Event $event, ?EventHint $hint, mixed $textMode): array
    {
        $replacements = [];
        for ($current = $textMode === 'redact' ? $hint?->exception : null; $current !== null; $current = $current->getPrevious()) {
            if ($current instanceof QueryException) {
                $replacements[$current->getMessage()] = sprintf(
                    '%s (Connection: %s, prepared SQL: %s)',
                    $current->getPrevious()?->getMessage() ?? 'Database error',
                    $current->getConnectionName(),
                    Redaction::sql($current->getSql()),
                );
            }
        }
        $exceptions = [];
        foreach ($event->getExceptions() as $original) {
            $exception = clone $original;
            $value = $replacements[$original->getValue()] ?? $original->getValue();
            $exception->setValue(Redaction::text($value, $textMode) ?? '[omitted]');
            $exception->setType(self::symbol($original->getType()));
            $mechanism = $original->getMechanism();
            if ($mechanism !== null) {
                $exception->setMechanism(new ExceptionMechanism(ExceptionMechanism::TYPE_GENERIC, $mechanism->isHandled()));
            }
            if ($original->getStacktrace() !== null) {
                $exception->setStacktrace(self::stacktrace($original->getStacktrace()));
            }
            $exceptions[] = $exception;
        }

        return $exceptions;
    }

    private static function stacktrace(?Stacktrace $trace): ?Stacktrace
    {
        if ($trace === null) {
            return null;
        }

        $frames = [];
        foreach ($trace->getFrames() as $frame) {
            $file = str_replace('\\', '/', $frame->getFile());
            // Laravel strips its base path in filename; an unstripped host path only needs its basename.
            if (str_starts_with($file, '/') || preg_match('~^[a-z]:/~i', $file)) {
                $absolute = str_replace('\\', '/', $frame->getAbsoluteFilePath() ?? $file);
                $file = $absolute !== $file && str_ends_with($absolute, $file) ? ltrim($file, '/') : basename($file);
            }
            $function = $frame->getFunctionName();
            $frames[] = new Frame(
                $function !== null ? self::symbol($function) : null,
                $file, $frame->getLine(), inApp: $frame->isInApp(),
            );
        }

        return new Stacktrace($frames);
    }

    private static function symbol(string $name): string
    {
        // Anonymous classes and PHP 8.4+ closure names can embed the absolute file path.
        $name = preg_replace('/@anonymous\x00.*?(?=::|$)/s', '@anonymous', $name);

        return (string) preg_replace('/\{closure:.*?\}/s', '{closure}', $name);
    }

    private static function httpStatus(mixed $value): ?int
    {
        return (is_int($value) || is_string($value)) && preg_match('/^[1-5]\d{2}$/D', (string) $value) === 1
            ? (int) $value
            : null;
    }

    public static function beforeBreadcrumb(Breadcrumb $breadcrumb): ?Breadcrumb
    {
        $category = $breadcrumb->getCategory();
        $metadataKeys = match ($category) {
            'log.emergency', 'log.alert', 'log.critical', 'log.error', 'log.warning',
            'log.notice', 'log.info', 'log.debug', 'route' => [],
            'db.sql.query' => ['connectionName', 'executionTimeMs'],
            'queue.job' => ['job', 'queue', 'attempts', 'connection', 'resolved'],
            'artisan.command' => ['exit'],
            'http' => ['method', 'http.request.method', 'status_code', 'http.response.status_code', 'url'],
            default => null,
        };
        if ($metadataKeys === null) {
            return null;
        }
        $textMode = config('observability.privacy.breadcrumb_text');
        $message = $breadcrumb->getMessage();
        if ($message !== null && $textMode === 'redact') {
            $message = match ($category) {
                'db.sql.query' => Redaction::sql($message),
                'artisan.command' => preg_match('/^((?:Starting|Finished) Artisan command: [\w:-]+)\b/', $message, $match) ? $match[1] : null,
                default => Redaction::message($message),
            };
        } elseif ($textMode !== 'full') {
            $message = null;
        }
        $metadata = [];
        foreach (array_intersect_key($breadcrumb->getMetadata(), array_flip($metadataKeys)) as $key => $value) {
            $field = match ($key) {
                'method', 'http.request.method' => ObserveRequest::normalizeMethod($value),
                'status_code', 'http.response.status_code' => self::httpStatus($value),
                'url' => is_string($value) && config('observability.privacy.urls') === 'redact' ? Redaction::url($value) : null,
                'attempts', 'exit' => is_int($value) ? $value : null,
                'executionTimeMs' => is_int($value) || (is_float($value) && is_finite($value)) ? $value : null,
                default => is_string($value) ? Redaction::text($value, $textMode) : null,
            };
            if ($field !== null) {
                $metadata[$key] = $field;
            }
        }
        $type = match ($category) {
            'http' => Breadcrumb::TYPE_HTTP,
            'route' => Breadcrumb::TYPE_NAVIGATION,
            default => Breadcrumb::TYPE_DEFAULT,
        };

        return new Breadcrumb($breadcrumb->getLevel(), $type, $category, $message, $metadata, $breadcrumb->getTimestamp());
    }

    public static function sanitizeMessage(string $value): string
    {
        return Redaction::message($value);
    }

    public static function sanitizeSql(string $sql): string
    {
        return Redaction::sql($sql);
    }

    public static function sanitizeUrl(string $url): string
    {
        return Redaction::url($url);
    }

    private static function userId(): int|string|null
    {
        try {
            foreach (array_keys((array) config('auth.guards', [])) as $guard) {
                $authGuard = Auth::guard($guard);
                if (method_exists($authGuard, 'hasUser') && $authGuard->hasUser()) {
                    return $authGuard->id();
                }
            }
        } catch (Throwable $exception) {
            LocalDiagnostics::failure($exception);
        }

        return null;
    }
}
