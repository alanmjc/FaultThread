<?php

declare(strict_types=1);

namespace EventObservability\Laravel;

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Support\ServiceProvider;
use InvalidArgumentException;
use Sentry\Dsn;
use TypeError;

final class ObservabilityServiceProvider extends ServiceProvider
{
    private const DISABLED_DSN_VALUES = ['', 'false', '(false)', 'empty', '(empty)', 'null', '(null)'];

    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/observability.php', 'observability');

        $this->app['config']->set([
            'sentry.dsn' => $this->collectorDsn(),
            'sentry.environment' => config('observability.environment'),
            'sentry.release' => config('observability.release'),
            'sentry.send_default_pii' => false,
            'sentry.max_request_body_size' => 'never',
            'sentry.integrations' => EventSanitizer::class.'::integrations',
            'sentry.before_send' => [EventSanitizer::class, 'beforeSend'],
            'sentry.before_breadcrumb' => [EventSanitizer::class, 'beforeBreadcrumb'],
            'sentry.max_breadcrumbs' => config('observability.max_breadcrumbs'),
            'sentry.http_connect_timeout' => self::timeout(config('observability.http_connect_timeout'), 1.0),
            'sentry.http_ssl_verify_peer' => true,
            'sentry.http_timeout' => self::timeout(config('observability.http_timeout'), 2.0),
            'sentry.enable_tracing' => false,
            'sentry.trace_propagation_targets' => [],
            'sentry.profiles_sample_rate' => 0.0,
            'sentry.enable_logs' => false,
            'sentry.enable_metrics' => false,
            'sentry.spotlight' => false,
            'sentry.logger' => LocalDiagnostics::class,
            'sentry.breadcrumbs' => [
                'logs' => true, 'sql_queries' => true, 'sql_bindings' => false,
                'queue_info' => false, 'command_info' => true, 'http_client_requests' => true,
                'cache' => false, 'livewire' => false, 'notifications' => false,
            ],
            'sentry.tracing.default_integrations' => false,
            'sentry.tracing.queue_job_transactions' => false,
            'sentry.tracing.queue_jobs' => false,
        ]);
    }

    private function collectorDsn(): ?string
    {
        $this->app['config']->set('observability.invalid_dsn', false);
        $configured = config('observability.dsn');
        $value = is_string($configured) ? strtolower($configured) : $configured;
        if ($value === null || $value === false || in_array($value, self::DISABLED_DSN_VALUES, true)) {
            return null;
        }

        try {
            $raw = $configured instanceof Dsn ? (string) $configured : $configured;
            $dsn = Dsn::createFromString($raw);
            $parts = parse_url($raw);
            $host = strtolower($dsn->getHost());
            $local = in_array($host, ['localhost', 'localhost.', '[::1]'], true)
                || (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) && str_starts_with($host, '127.'));
            if ($dsn->getProjectId() !== '' && ($dsn->getScheme() === 'https' || $local)
                && ! isset($parts['pass']) && ! isset($parts['query']) && ! isset($parts['fragment'])) {
                return (string) $dsn;
            }
        } catch (InvalidArgumentException|TypeError) {
            // SDK validation messages can contain the complete DSN.
        }

        $this->app['config']->set('observability.invalid_dsn', true);

        return null;
    }

    private static function timeout(mixed $value, float $default): float
    {
        // The SDK uses whole milliseconds. A zero timeout disables cURL's deadline.
        $seconds = is_numeric($value) ? (float) $value : 0.0;

        return $seconds >= 0.001 && $seconds < PHP_INT_MAX / 1000 ? $seconds : $default;
    }

    public function boot(): void
    {
        $this->publishes([
            __DIR__.'/../config/observability.php' => config_path('observability.php'),
        ], 'observability-config');

        // Prepend after the SDK has installed its own middleware, regardless of discovery order.
        $this->app->booted(function (): void {
            $this->callAfterResolving(Kernel::class, static function (Kernel $kernel): void {
                if (method_exists($kernel, 'prependMiddleware')) {
                    $kernel->prependMiddleware(ObserveRequest::class);
                }
            });
        });

        if (config('sentry.dsn')) {
            $this->app['events']->subscribe(new ObserveQueue);
        }

        if ($this->app->runningInConsole()) {
            $this->commands([DiagnoseCommand::class]);
        }
    }
}
