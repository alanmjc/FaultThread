<?php

declare(strict_types=1);

namespace EventObservability\Laravel;

use Illuminate\Console\Command;
use Sentry\ClientBuilder;
use Throwable;

final class OutboxCommand extends Command
{
    protected $signature = 'observability:outbox {--limit=25 : Maximum envelopes to attempt (1 to 100)} {--retry-blocked : Retry records previously rejected by the collector}';
    protected $description = 'Retry retained Laravel error envelopes and show outstanding counts';

    public function handle(ClientBuilder $builder): int
    {
        $limit = filter_var($this->option('limit'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 100]]);
        if ($limit === false) {
            $this->components->error('The limit must be an integer between 1 and 100');

            return self::FAILURE;
        }
        $transport = $builder->getTransport();
        if (! $transport instanceof DurableEventTransport) {
            $this->components->info('The local outbox is inactive for the configured transport');

            return self::SUCCESS;
        }
        try {
            $transport->drain($limit, (bool) $this->option('retry-blocked'));
            $status = $transport->status();
            $this->line(sprintf('%d pending, %d blocked', $status['pending'], $status['blocked']));

            return $status['blocked'] || $status['pending'] ? self::FAILURE : self::SUCCESS;
        } catch (Throwable $e) {
            LocalDiagnostics::failure($e);
            $this->components->error('The local outbox could not be read or updated');

            return self::FAILURE;
        }
    }
}
