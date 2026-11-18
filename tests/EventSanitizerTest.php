<?php

declare(strict_types=1);

use EventObservability\Laravel\EventSanitizer;
use EventObservability\Laravel\ObserveQueue;
use EventObservability\Laravel\ObserveRequest;
use Illuminate\Config\Repository;
use Illuminate\Container\Container;
use Illuminate\Http\Request;
use PHPUnit\Framework\TestCase;
use Sentry\Breadcrumb;
use Sentry\Event;
use Sentry\EventHint;
use Sentry\ExceptionDataBag;
use Sentry\ExceptionMechanism;
use Sentry\Frame;
use Sentry\Options;
use Sentry\Serializer\PayloadSerializer;
use Sentry\Stacktrace;

final class EventSanitizerTest extends TestCase
{
    private Container $previousContainer;

    protected function setUp(): void
    {
        $this->previousContainer = Container::getInstance();
        $app = new Container();
        $app->instance('config', new Repository([
            'sentry' => ['dsn' => 'https://key@observer.invalid/1'],
            'observability' => ['application' => 'backend'],
        ]));
        Container::setInstance($app);
    }

    protected function tearDown(): void
    {
        Container::setInstance($this->previousContainer);
    }

    public function test_serialized_events_only_contain_structural_exception_and_http_data_in_every_mode(): void
    {
        $directory = '/home/private-marker/project';
        $frame = new Frame('App\\Service::run', '/app/Service.php', 13, 'private-marker', $directory.'/app/Service.php', ['token' => 'private-marker']);
        $frame->setContextLine('private-marker');
        $frame->setPreContext(['private-marker']);
        $frame->setPostContext(['private-marker']);
        $trace = new Stacktrace([$frame, new Frame('{closure:'.$directory.'/file.php:2}', $directory.'/file.php', 2)]);
        $mechanism = new ExceptionMechanism('private-marker', false, ['payload' => ['token' => 'private-marker']]);
        $exception = new ExceptionDataBag(new LogicException('sample message'), $trace, $mechanism);
        $exception->setType("Exception@anonymous\x00".$directory.'/Exception.php:2');
        $event = Event::createEvent()->setStacktrace($trace)->setExceptions([$exception])
            ->setTags(['request_id' => ['private-marker'], 'http.status_code' => 'private-marker'])
            ->setRequest(['method' => ['private-marker'], 'url' => ['private-marker']])
            ->setExtra(['token' => 'private-marker'])
            ->setBreadcrumb([
                new Breadcrumb('info', 'private-marker', 'log.private-marker'),
                new Breadcrumb('info', 'private-marker', 'http', null, [
                    'http.request.method' => 'GET', 'http.response.status_code' => 204,
                    'http.query' => 'private-marker', 'queue' => 'private-marker', 'url' => ['private-marker'],
                ]),
            ]);

        $serializer = new PayloadSerializer(new Options());
        foreach (['omit', 'redact', 'full'] as $mode) {
            config(['observability.privacy.event_text' => $mode, 'observability.privacy.breadcrumb_text' => $mode, 'observability.privacy.urls' => 'redact']);
            $safe = EventSanitizer::beforeSend($event);
            $envelope = $serializer->serialize($safe);
            self::assertStringNotContainsString('private-marker', $envelope);
            $payload = json_decode(explode("\n", $envelope)[2], true, flags: JSON_THROW_ON_ERROR);

            self::assertSame(['method' => 'OTHER'], $payload['request']);
            self::assertSame(['application' => 'backend'], $payload['tags']);
            self::assertSame(['type' => 'generic', 'handled' => false], $payload['exception']['values'][0]['mechanism']);
            self::assertSame('app/Service.php', $payload['stacktrace']['frames'][0]['filename']);
            self::assertSame('file.php', $payload['stacktrace']['frames'][1]['filename']);
            self::assertSame('{closure}', $payload['stacktrace']['frames'][1]['function']);
            self::assertSame($payload['stacktrace'], $payload['exception']['values'][0]['stacktrace']);
            self::assertSame(['http.request.method' => 'GET', 'http.response.status_code' => 204], $payload['breadcrumbs']['values'][0]['data']);
            self::assertSame($mode === 'omit' ? '[omitted]' : 'sample message', $payload['exception']['values'][0]['value']);
        }
        self::assertSame('sample message', $exception->getValue());
        self::assertSame('private-marker', $frame->getContextLine());
    }

    public function test_a_job_can_propagate_correlation_without_inheriting_the_http_request(): void
    {
        config(['observability.privacy.urls' => 'redact']);
        $request = Request::create('/outer');
        $request->attributes->set(ObserveRequest::ACTIVE, 'shared-id');
        app()->instance('request', $request);
        $event = Event::createEvent()
            ->setTransaction('/outer')
            ->setRequest(['method' => 'GET', 'url' => '/outer'])
            ->setTags([ObserveQueue::SCOPE_TAG => '1', 'request_id' => 'shared-id']);
        $safe = EventSanitizer::beforeSend($event, EventHint::fromArray(['exception' => new LogicException()]));

        self::assertSame(['application' => 'backend', 'request_id' => 'shared-id'], $safe->getTags());
        self::assertSame([], $safe->getRequest());
        self::assertNull($safe->getTransaction());
        self::assertFalse($request->attributes->getBoolean(ObserveRequest::REPORTED));
    }

    public function test_redaction_handles_common_credential_formats_before_shortening_text(): void
    {
        foreach ([
            '{"api_key":"private-marker with spaces"}',
            'password="private-marker with spaces"',
            'Authorization: Basic private-marker',
            'Cookie: id=1; session=private-marker',
            'Opened https://user:private-marker@api.example.test/report?token=private-marker',
        ] as $message) {
            self::assertStringNotContainsString('private-marker', EventSanitizer::sanitizeMessage($message));
        }
        self::assertSame('see https://api.example.test/report', EventSanitizer::sanitizeMessage('see https://user:pass@api.example.test/report?q=123'));
        self::assertSame('[invalid URL]', EventSanitizer::sanitizeUrl("http:\\private-marker"));
        self::assertSame('select ? as name, ?', EventSanitizer::sanitizeSql("select 'O''Connor' as name, 123"));
        self::assertSame('[omitted]', EventSanitizer::sanitizeSql('select $note$some text$note$'));
        self::assertSame('[omitted]', EventSanitizer::sanitizeSql('select 1 -- annotated query'));
    }
}
