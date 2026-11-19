<?php

declare(strict_types=1);

namespace FaultThread\Laravel;

use Psr\Log\AbstractLogger;
use Stringable;
use Throwable;

final class LocalDiagnostics extends AbstractLogger
{
    public function log(mixed $level, string|Stringable $message, array $context = []): void
    {
        // The package deliberately omits frame arguments. The SDK warns on each client
        // initialization when PHP itself also omits them.
        if ($level === 'warning' && is_string($message)
            && str_starts_with($message, 'The "zend.exception_ignore_args" PHP setting is enabled')) {
            return;
        }
        if (in_array($level, ['warning', 'error', 'critical', 'alert', 'emergency'], true)) {
            error_log('FaultThread: SDK level '.$level.'. Run observability:diagnose');
        }
    }

    public static function failure(Throwable $exception): void
    {
        // Avoid the application's log channels: they may report back to Sentry.
        error_log('FaultThread: internal failure of type '.get_class($exception));
    }
}
