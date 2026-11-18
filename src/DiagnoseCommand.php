<?php

declare(strict_types=1);

namespace EventObservability\Laravel;

use Illuminate\Console\Command;
use Sentry\ClientBuilder;
use Sentry\Event;
use Sentry\Transport\ResultStatus;
use Throwable;

final class DiagnoseCommand extends Command
{
    protected $signature = 'observability:diagnose {--send : Send a synthetic event without real data}';

    protected $description = 'Check observability configuration without revealing secrets';

    public function handle(ClientBuilder $builder): int
    {
        if (config('observability.invalid_dsn')) {
            $this->components->error('Error reporting is disabled because the collector DSN is invalid');

            return self::FAILURE;
        }
        $options = $builder->getOptions();
        $dsn = $options->getDsn();
        $this->components->info($dsn ? 'Error reporting is configured' : 'Error reporting is disabled because no DSN is configured');
        $this->line('Application: '.config('observability.application'));
        $this->line('Environment: '.config('observability.environment'));
        $this->line('Release: '.(config('observability.release') ?: 'not set'));
        if (! $this->option('send')) {
            return self::SUCCESS;
        }
        if (! $dsn) {
            $this->components->error('A DSN is required to send a test event');

            return self::FAILURE;
        }

        try {
            // captureMessage can return an event ID even when the HTTP transport rejects it.
            $event = Event::createEvent()
                ->setMessage('Observability: manually requested synthetic event')
                ->setEnvironment($options->getEnvironment())
                ->setRelease($options->getRelease())
                ->setTags(['application' => (string) config('observability.application')]);
            $transport = $builder->getTransport();
            $delivery = $transport->send($event)->getStatus();
            $flush = $transport->close(3)->getStatus();
            if ($delivery === ResultStatus::success() && $flush === ResultStatus::success()) {
                $this->components->info('The configured transport accepted the diagnostic event. Event ID: '.$event->getId());

                return self::SUCCESS;
            }
        } catch (Throwable $exception) {
            LocalDiagnostics::failure($exception);
        }
        $this->components->error('The configured transport did not confirm delivery');

        return self::FAILURE;
    }
}
