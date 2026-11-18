<?php

declare(strict_types=1);

use EventObservability\Laravel\ObservabilityServiceProvider;
use EventObservability\Laravel\EventSanitizer;
use Illuminate\Foundation\Application;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Facade;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\TestCase;
use Sentry\Breadcrumb;
use Sentry\Event;
use Sentry\Laravel\Integration;
use Sentry\State\HubInterface;
use Sentry\Transport\Result;
use Sentry\Transport\ResultStatus;
use Sentry\Transport\TransportInterface;

final class InMemoryTransport implements TransportInterface
{
    /** @var list<Event> */
    public array $events = [];

    public function send(Event $event): Result
    {
        $this->events[] = $event;

        return new Result(ResultStatus::success(), $event);
    }

    public function close(?int $timeout = null): Result
    {
        return new Result(ResultStatus::success());
    }
}

final class NestedSyncJob
{
    public function fire(Illuminate\Queue\Jobs\SyncJob $job, array $data): void
    {
        if ($data === []) {
            Sentry\configureScope(static fn (Sentry\State\Scope $scope) => $scope->setTag('request_id', request()->header('X-Request-Id')));
            report(new RuntimeException('Error handled inside the nested job'));
            throw new DomainException('Failed nested job');
        }
        Sentry\configureScope(static fn (Sentry\State\Scope $scope) => $scope->setUser(['id' => 'job-user']));
        try {
            app('queue')->connection('sync')->push(self::class, []);
        } catch (DomainException) {
            Sentry\captureMessage('Outer job continued');
        }
    }
}

final class ObservabilityTest extends TestCase
{
    private Application $app;
    private InMemoryTransport $transport;
    private string $base;

    protected function setUp(): void
    {
        parent::setUp();
        $this->base = sys_get_temp_dir().'/observability-'.bin2hex(random_bytes(8));
        foreach (['bootstrap/cache', 'config', 'storage/framework/views', 'storage/logs'] as $directory) {
            mkdir($this->base.'/'.$directory, 0777, true);
        }
        $_ENV['OBSERVER_DSN'] = $_SERVER['OBSERVER_DSN'] = 'https://public@observer.invalid/2';
        $_ENV['APP_ENV'] = $_SERVER['APP_ENV'] = 'testing';
        $_ENV['APP_KEY'] = $_SERVER['APP_KEY'] = 'base64:'.base64_encode(str_repeat('x', 32));

        file_put_contents($this->base.'/bootstrap/app.php', <<<'PHP'
<?php
return Illuminate\Foundation\Application::configure(basePath: dirname(__DIR__))
            ->withProviders([
                EventObservability\Laravel\ObservabilityServiceProvider::class,
                Sentry\Laravel\ServiceProvider::class,
                Sentry\Laravel\Tracing\ServiceProvider::class,
            ], withBootstrapProviders: false)
            ->withMiddleware()
            ->withExceptions(static function (Illuminate\Foundation\Configuration\Exceptions $exceptions): void {
                Sentry\Laravel\Integration::handles($exceptions);
            })
            ->create();
PHP);
        $this->app = require $this->base.'/bootstrap/app.php';
        $this->app->make(Kernel::class)->bootstrap();
        $this->transport = new InMemoryTransport;
        config([
            'sentry.transport' => $this->transport,
            'observability.application' => 'test-backend',
        ]);
        $this->app->forgetInstance(HubInterface::class);
        $this->app->make(HubInterface::class);
        Route::get('failure/{id}', static fn () => response()->json(['error' => 'original'], 503));
        Route::get('exception', static fn () => throw new RuntimeException('Failure for REC-000123, field@example.invalid token=private'));
        Route::get('reported', static function () {
            report(new RuntimeException('Already reported'));

            return response()->json(['error' => 'original'], 500);
        });
        Route::get('validation', static fn () => response()->json(['message' => 'original'], 422));
        Route::get('ok', static fn () => response()->json(['ok' => true]));
    }

    protected function tearDown(): void
    {
        $this->app->flush();
        Illuminate\Foundation\Bootstrap\HandleExceptions::flushState($this);
        Facade::clearResolvedInstances();
        foreach (['OBSERVER_DSN', 'APP_ENV', 'APP_KEY'] as $key) {
            unset($_ENV[$key], $_SERVER[$key]);
        }
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($this->base, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST,
        );
        foreach ($iterator as $file) {
            $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir($this->base);
        parent::tearDown();
    }

    public function test_5xx_correlation_and_request_local_deduplication(): void
    {
        $first = $this->get('/failure/42?token=private', 'first-123');
        self::assertSame(503, $first->getStatusCode());
        self::assertSame('first-123', $first->headers->get('X-Request-Id'));
        self::assertSame(['error' => 'original'], json_decode($first->getContent(), true));
        $this->get('/failure/99', 'second-123');
        self::assertCount(2, $this->transport->events);
        self::assertSame('first-123', $this->transport->events[0]->getTags()['request_id']);
        self::assertSame('second-123', $this->transport->events[1]->getTags()['request_id']);
        self::assertSame('test-backend', $this->transport->events[1]->getTags()['application']);
        self::assertSame(['server-response', 'GET', '/failure/{id}', '503'], $this->transport->events[0]->getFingerprint());
    }

    public function test_exceptions_and_explicit_reports_are_not_duplicated(): void
    {
        self::assertSame(500, $this->get('/exception')->getStatusCode());
        self::assertCount(1, $this->transport->events);
        self::assertSame('[omitted]', $this->transport->events[0]->getExceptions()[0]->getValue());
        $this->get('/reported');
        self::assertCount(2, $this->transport->events);
    }

    public function test_invalid_ids_are_replaced_and_4xx_are_not_reported(): void
    {
        $response = $this->get('/validation', 'an invalid id');
        self::assertSame(422, $response->getStatusCode());
        self::assertMatchesRegularExpression('/^[a-f0-9]{32}$/', $response->headers->get('X-Request-Id'));
        self::assertCount(0, $this->transport->events);
        $this->get('/ok', 'valid-42');
        self::assertCount(0, $this->transport->events);
    }

    public function test_tracking_is_limited_to_the_error_collector(): void
    {
        $options = $this->app->make(HubInterface::class)->getClient()->getOptions();
        self::assertFalse($options->isTracingEnabled());
        self::assertFalse($options->isSpotlightEnabled());
        Illuminate\Support\Facades\Http::fake();
        Illuminate\Support\Facades\Http::get('https://service.invalid/health');
        Illuminate\Support\Facades\Http::assertSent(
            static fn (Illuminate\Http\Client\Request $request): bool =>
                ! $request->hasHeader('baggage') && ! $request->hasHeader('sentry-trace'),
        );
    }

    public function test_no_dsn_disables_delivery(): void
    {
        config(['sentry.dsn' => null]);
        $this->app->forgetInstance(HubInterface::class);
        $this->app->make(HubInterface::class);
        self::assertSame(503, $this->get('/failure/42')->getStatusCode());
        self::assertCount(0, $this->transport->events);
    }

    public function test_invalid_dsn_disables_reporting_without_breaking_requests_or_revealing_credentials(): void
    {
        config([
            'observability.dsn' => 'https://private-key@collector.invalid',
            'observability.http_connect_timeout' => 'not a number',
            'observability.http_timeout' => 0,
        ]);
        (new ObservabilityServiceProvider($this->app))->register();
        $this->app->forgetInstance(HubInterface::class);
        $options = $this->app->make(HubInterface::class)->getClient()->getOptions();
        self::assertNull($options->getDsn());
        self::assertSame(1.0, $options->getHttpConnectTimeout());
        self::assertSame(2.0, $options->getHttpTimeout());
        self::assertSame(503, $this->get('/failure/42')->getStatusCode());
        self::assertCount(0, $this->transport->events);
        self::assertSame(1, Artisan::call('observability:diagnose'));
        self::assertStringContainsString('DSN is invalid', Artisan::output());
        self::assertStringNotContainsString('private-key', Artisan::output());
    }

    public function test_collector_transport_uses_verified_https_or_local_http(): void
    {
        $provider = new ObservabilityServiceProvider($this->app);
        foreach (['https://key@collector.invalid/2', 'http://key@localhost:8080/2',
            'http://key@127.0.0.2/2', 'http://key@[::1]/2'] as $dsn) {
            config(['observability.dsn' => $dsn, 'sentry.http_ssl_verify_peer' => false]);
            $provider->register();
            self::assertSame($dsn, config('sentry.dsn'));
            self::assertTrue(config('sentry.http_ssl_verify_peer'));
        }

        foreach (['http://key@collector.invalid/2', 'https://key:private@collector.invalid/2',
            'https://key@collector.invalid/2?token=private', 'https://key@collector.invalid/2#private'] as $dsn) {
            config(['observability.dsn' => $dsn]);
            $provider->register();
            self::assertNull(config('sentry.dsn'));
            self::assertTrue(config('observability.invalid_dsn'));
        }
    }

    public function test_sanitizer_excludes_payloads_users_context_and_sql_literals(): void
    {
        config([
            'observability.privacy.breadcrumb_text' => 'redact',
            'observability.privacy.urls' => 'redact',
            'observability.capture_user_id' => true,
        ]);
        $event = Event::createEvent();
        $event->setRequest(['url' => 'https://user:pass@api.test/users/12?secret=yes', 'data' => ['password' => 'private'], 'headers' => ['Cookie' => 'private']]);
        $event->setExtra(['private' => 'private']);
        $event->setContext('form', ['password' => 'private']);
        $event->setUser(Sentry\UserDataBag::createFromArray(['id' => '42', 'email' => 'field@example.invalid']));
        $event->setBreadcrumb([new Breadcrumb(
            Breadcrumb::LEVEL_INFO, Breadcrumb::TYPE_DEFAULT, 'db.sql.query',
            "select * from users where email = 'field@example.invalid' and id = 123", ['bindings' => ['private']],
        )]);
        $event = EventSanitizer::beforeSend($event);
        self::assertSame(['url' => 'https://api.test/users/:id'], $event->getRequest());
        self::assertSame([], $event->getExtra());
        self::assertSame([], $event->getContexts());
        self::assertSame('42', $event->getUser()?->getId());
        self::assertNull($event->getUser()?->getEmail());
        self::assertSame('select * from users where email = ? and id = ?', $event->getBreadcrumbs()[0]->getMessage());
        self::assertSame([], $event->getBreadcrumbs()[0]->getMetadata());
        self::assertSame('/search/:redacted', EventSanitizer::sanitizeUrl('/search/field%40example.invalid'));
    }

    public function test_event_and_breadcrumb_text_can_be_enabled_independently(): void
    {
        config([
            'observability.privacy.event_text' => 'redact',
            'observability.privacy.breadcrumb_text' => 'full',
        ]);
        $this->get('/exception');
        self::assertSame(
            'Failure for REC-000123, [email redacted] token=[redacted]',
            $this->transport->events[0]->getExceptions()[0]->getValue(),
        );

        $event = Event::createEvent();
        $event->setMessage('Failure for REC-000123, field@example.invalid');
        $event->setRequest(['url' => '/records/sample-record', 'data' => 'private']);
        $event->setUser(Sentry\UserDataBag::createFromUserIdentifier('record-42'));
        $event->setBreadcrumb([new Breadcrumb(
            Breadcrumb::LEVEL_INFO, Breadcrumb::TYPE_DEFAULT, 'log.info', 'Record: REC-000123',
        )]);
        $event->setFingerprint(['REC-000123']);

        config(['observability.privacy.event_text' => 'full']);
        $full = EventSanitizer::beforeSend($event);
        self::assertSame('Failure for REC-000123, field@example.invalid', $full->getMessage());
        self::assertSame('Record: REC-000123', $full->getBreadcrumbs()[0]->getMessage());
        self::assertSame([], $full->getRequest());
        self::assertNull($full->getUser());

        config([
            'observability.privacy.event_text' => 'typo',
            'observability.privacy.breadcrumb_text' => 'omit',
        ]);
        $minimal = EventSanitizer::beforeSend($event);
        self::assertSame('Application event', $minimal->getMessage());
        self::assertNull($minimal->getBreadcrumbs()[0]->getMessage());
        self::assertSame([], $minimal->getFingerprint());
    }

    public function test_transport_failure_does_not_change_http_response(): void
    {
        config(['sentry.transport' => new class implements TransportInterface {
            public function send(Event $event): Result { throw new RuntimeException('transport unavailable'); }
            public function close(?int $timeout = null): Result { return new Result(ResultStatus::failed()); }
        }]);
        $this->app->forgetInstance(HubInterface::class);
        $this->app->make(HubInterface::class);
        $response = $this->get('/failure/42');
        self::assertSame(503, $response->getStatusCode());
        self::assertSame(['error' => 'original'], json_decode($response->getContent(), true));
    }

    public function test_configuration_can_be_cached_and_diagnostics_do_not_send_or_reveal_dsn(): void
    {
        self::assertSame(0, Illuminate\Support\Facades\Artisan::call('config:cache'));
        $cached = require $this->base.'/bootstrap/cache/config.php';
        self::assertSame(EventSanitizer::class, $cached['sentry']['before_send'][0]);
        self::assertSame(0, Illuminate\Support\Facades\Artisan::call('observability:diagnose'));
        $output = Illuminate\Support\Facades\Artisan::output();
        self::assertStringContainsString('Error reporting is configured', $output);
        self::assertStringNotContainsString('public@', $output);
        self::assertCount(0, $this->transport->events);
    }

    public function test_synthetic_diagnostic_excludes_ambient_user_and_breadcrumbs(): void
    {
        config(['observability.capture_user_id' => true, 'observability.privacy.breadcrumb_text' => 'full']);
        Sentry\configureScope(static function (Sentry\State\Scope $scope): void {
            $scope->setUser(['id' => 'ambient-user']);
            $scope->setTag('request_id', 'ambient-request');
        });
        Integration::addBreadcrumb(new Breadcrumb(Breadcrumb::LEVEL_INFO, Breadcrumb::TYPE_DEFAULT, 'log.info', 'ambient text'));

        self::assertSame(0, Artisan::call('observability:diagnose', ['--send' => true]));
        self::assertCount(1, $this->transport->events);
        $event = $this->transport->events[0];
        self::assertNull($event->getUser());
        self::assertArrayNotHasKey('request_id', $event->getTags());
        self::assertSame([], $event->getBreadcrumbs());
    }

    public function test_diagnostic_fails_when_the_transport_rejects_an_identifiable_event(): void
    {
        $transport = $this->createMock(TransportInterface::class);
        $transport->expects(self::once())->method('send')
            ->willReturnCallback(static fn (Event $event) => new Result(ResultStatus::invalid(), $event));
        $transport->method('close')->willReturn(new Result(ResultStatus::success()));
        config(['sentry.transport' => $transport]);

        self::assertSame(1, Artisan::call('observability:diagnose', ['--send' => true]));
        self::assertStringContainsString('did not confirm delivery', Artisan::output());
    }

    public function test_queue_jobs_do_not_inherit_http_users_correlation_or_previous_breadcrumbs(): void
    {
        config([
            'observability.capture_user_id' => true,
            'observability.privacy.breadcrumb_text' => 'redact',
            'observability.privacy.urls' => 'redact',
        ]);
        $this->get('/ok', 'finished-request');
        Sentry\configureScope(static function (Sentry\State\Scope $scope): void {
            $scope->setUser(['id' => 'private-user']);
            $scope->setTag('request_id', 'previous-request');
        });
        $job = $this->createMock(Illuminate\Contracts\Queue\Job::class);
        $job->method('getName')->willReturn('ExampleJob');
        $job->method('getQueue')->willReturn('default');
        $job->method('attempts')->willReturn(1);
        $job->method('resolveName')->willReturn('ExampleJob');
        foreach (['first', 'second'] as $index => $name) {
            $this->app['events']->dispatch(new Illuminate\Queue\Events\JobProcessing('worker', $job));
            Integration::addBreadcrumb(new Breadcrumb(
                Breadcrumb::LEVEL_INFO, Breadcrumb::TYPE_DEFAULT, 'log.info', $name,
            ));
            if ($index === 0) {
                $this->app['events']->dispatch(new Illuminate\Queue\Events\JobAttempted('worker', $job, true));
            }
            Sentry\captureMessage('job '.$name);
            if ($index === 1) {
                $this->app['events']->dispatch(new Illuminate\Queue\Events\JobAttempted('worker', $job));
            }
            $event = $this->transport->events[$index];
            self::assertNull($event->getUser());
            self::assertArrayNotHasKey('request_id', $event->getTags());
            self::assertSame([], $event->getRequest());
            self::assertNull($event->getTransaction());
        }
        self::assertNotContains('first', array_map(
            static fn (Breadcrumb $breadcrumb): ?string => $breadcrumb->getMessage(),
            $this->transport->events[1]->getBreadcrumbs(),
        ));
    }

    public function test_synchronous_job_reports_cannot_mark_the_enclosing_request_as_reported(): void
    {
        config(['observability.privacy.urls' => 'redact', 'observability.capture_user_id' => true]);
        Route::get('sync-job', static function () {
            Sentry\configureScope(static fn (Sentry\State\Scope $scope) => $scope->setUser(['id' => 'parent-user']));
            app('queue')->connection('sync')->push(NestedSyncJob::class, ['nest' => true]);

            return response('', 503);
        });

        self::assertSame(503, $this->get('/sync-job', 'outer-request')->getStatusCode());
        self::assertCount(3, $this->transport->events);
        [$jobEvent, $outerJobEvent, $requestEvent] = $this->transport->events;
        self::assertNotEmpty($jobEvent->getExceptions());
        self::assertNull($jobEvent->getUser());
        self::assertSame('outer-request', $jobEvent->getTags()['request_id']);
        self::assertSame([], $jobEvent->getRequest());
        self::assertNull($jobEvent->getTransaction());
        self::assertSame('job-user', $outerJobEvent->getUser()?->getId());
        self::assertArrayNotHasKey('request_id', $outerJobEvent->getTags());
        self::assertSame('outer-request', $requestEvent->getTags()['request_id']);
        self::assertSame('parent-user', $requestEvent->getUser()?->getId());
        self::assertSame(['method' => 'GET', 'url' => 'http://localhost/sync-job'], $requestEvent->getRequest());
        self::assertSame(['server-response', 'GET', '/sync-job', '503'], $requestEvent->getFingerprint());
    }

    public function test_console_reporting_after_a_request_excludes_framework_http_context(): void
    {
        config(['observability.privacy.urls' => 'redact']);
        $this->get('/ok', 'finished-request');
        Sentry\captureMessage('An operation outside the HTTP request');

        self::assertCount(1, $this->transport->events);
        $event = $this->transport->events[0];
        self::assertSame([], $event->getRequest());
        self::assertNull($event->getTransaction());
        self::assertArrayNotHasKey('request_id', $event->getTags());
    }

    private function get(string $path, ?string $id = null): Symfony\Component\HttpFoundation\Response
    {
        $request = Request::create($path, 'GET', server: ['HTTP_ACCEPT' => 'application/json']);
        if ($id !== null) {
            $request->headers->set('X-Request-Id', $id);
        }
        $kernel = $this->app->make(Kernel::class);
        $response = $kernel->handle($request);
        $kernel->terminate($request, $response);

        return $response;
    }
}
