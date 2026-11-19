<?php

declare(strict_types=1);

namespace FaultThread\Laravel;

use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Contracts\Queue\Job;
use Illuminate\Queue\Events\JobAttempted;
use Illuminate\Queue\Events\JobProcessing;
use Illuminate\Queue\Events\Looping;
use Illuminate\Queue\Events\WorkerStopping;
use Illuminate\Queue\Jobs\SyncJob;
use Sentry\Breadcrumb;
use Sentry\Laravel\Integration;
use Sentry\SentrySdk;
use Sentry\State\HubInterface;
use Sentry\Tracing\PropagationContext;
use Throwable;

final class ObserveQueue
{
    public const SCOPE_TAG = '_observability_job';

    /** @var array<int, HubInterface> */
    private array $scopes = [];

    private ?Job $failedWorkerJob = null;

    public function subscribe(Dispatcher $events): void
    {
        $events->listen(JobProcessing::class, $this->start(...));
        $events->listen(JobAttempted::class, $this->finish(...));
        $events->listen([Looping::class, WorkerStopping::class], $this->clearFailedWorker(...));
        $events->listen(WorkerStopping::class, self::flush(...));
    }

    private function start(JobProcessing $event): void
    {
        $job = $event->job;
        if (! $job instanceof SyncJob) {
            $this->clearFailedWorker();
        }

        $hub = SentrySdk::getCurrentHub();
        $scope = $hub->pushScope()->clear();
        $scope->setTag(self::SCOPE_TAG, '1');
        $scope->setPropagationContext(PropagationContext::fromDefaults());
        $this->scopes[spl_object_id($job)] = $hub;

        try {
            $hub->addBreadcrumb(new Breadcrumb(
                Breadcrumb::LEVEL_INFO,
                Breadcrumb::TYPE_DEFAULT,
                'queue.job',
                'Processing queue job',
                [
                    'job' => $job->getName(),
                    'resolved' => $job->resolveName(),
                    'queue' => $job->getQueue(),
                    'attempts' => $job->attempts(),
                    'connection' => $event->connectionName,
                ],
            ));
        } catch (Throwable $exception) {
            LocalDiagnostics::failure($exception);
        }
    }

    private function finish(JobAttempted $event): void
    {
        if (! $event->job instanceof SyncJob && ! $event->successful()) {
            // The worker reports uncaught exceptions after dispatching this event.
            $this->failedWorkerJob = $event->job;
        } else {
            $this->pop($event->job);
        }

        self::flush();
    }

    private static function flush(): void
    {
        try {
            Integration::flushEvents();
        } catch (Throwable $exception) {
            LocalDiagnostics::failure($exception);
        }
    }

    private function clearFailedWorker(): void
    {
        if ($this->failedWorkerJob !== null) {
            $this->pop($this->failedWorkerJob);
            $this->failedWorkerJob = null;
        }
    }

    private function pop(Job $job): void
    {
        $id = spl_object_id($job);
        if (isset($this->scopes[$id])) {
            $this->scopes[$id]->popScope();
            unset($this->scopes[$id]);
        }
    }
}
