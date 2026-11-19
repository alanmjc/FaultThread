<?php

declare(strict_types=1);

namespace FaultThread\Laravel;

use FilesystemIterator;
use JsonException;
use Psr\Log\NullLogger;
use RuntimeException;
use Sentry\Event;
use Sentry\EventType;
use Sentry\HttpClient\HttpClientInterface;
use Sentry\HttpClient\Request;
use Sentry\HttpClient\Response;
use Sentry\Options;
use Sentry\Serializer\PayloadSerializer;
use Sentry\Transport\RateLimiter;
use Sentry\Transport\Result;
use Sentry\Transport\ResultStatus;
use Sentry\Transport\TransportInterface;
use Throwable;

final class DurableEventTransport implements TransportInterface
{
    private readonly string $directory;
    private readonly PayloadSerializer $serializer;

    public function __construct(
        private readonly Options $options,
        private readonly HttpClientInterface $http,
        string $root,
        string $application,
        private readonly TransportInterface $sdkTransport,
    ) {
        $this->directory = rtrim($root, '/').'/'.hash('sha256', $application."\0".(string) $options->getDsn());
        $this->serializer = new PayloadSerializer($options);
    }

    public function send(Event $event): Result
    {
        if ($event->getType() !== EventType::event()) {
            // Explicit SDK features such as cron check-ins retain their own wire format.
            return $this->sdkTransport->send($event);
        }
        if (! $this->options->getDsn()) {
            return new Result(ResultStatus::skipped());
        }
        // The SDK's normal entry point has already applied before_send. Repeat the allowlist
        // for callers that submit events directly to the transport, including Artisan diagnostics.
        $safe = EventSanitizer::beforeSend($event);
        if ($safe === null) {
            return new Result(ResultStatus::skipped());
        }
        $body = $this->serializer->serialize($safe);
        $id = (string) $safe->getId();
        try {
            $this->ensureDirectory($this->directory);
            foreach (['pending', 'blocked'] as $folder) {
                $this->ensureDirectory($this->directory.'/'.$folder);
            }
            $filename = $this->directory.'/pending/'.$id.'.json';
            if (! is_file($this->directory.'/blocked/'.$id.'.json') && ! is_file($this->directory.'/blocked/'.$id.'.corrupt')) {
                $this->write($filename, json_encode([
                    'sha256' => hash('sha256', $body), 'body' => $body, 'attempts' => 0,
                ], JSON_THROW_ON_ERROR), true);
            }
        } catch (Throwable $e) {
            // Shared hosting may temporarily lose its private disk or exhaust its quota.
            // An immediate HTTP attempt can still deliver the original event.
            LocalDiagnostics::failure($e);
            $response = $this->post($body);

            return new Result($response->hasError() ? ResultStatus::failed() : ResultStatus::createFromHttpStatusCode($response->getStatusCode()), $event);
        }

        try {
            $confirmed = $this->process(1, $id);
        } catch (Throwable $e) {
            LocalDiagnostics::failure($e);
            $confirmed = false;
        }

        return new Result($confirmed ? ResultStatus::success() : ResultStatus::unknown(), $event);
    }

    public function close(?int $timeout = null): Result
    {
        // Every send is synchronous. A persisted event alone does not constitute an ACK.
        foreach (['pending', 'blocked'] as $folder) {
            foreach ($this->entries($folder) as $_) {
                return new Result(ResultStatus::unknown());
            }
        }

        return $this->sdkTransport->close($timeout);
    }

    public function drain(int $limit = 1, bool $retryBlocked = false): void
    {
        $this->process($limit, null, $retryBlocked);
    }

    /** @return array{pending: int, blocked: int} */
    public function status(): array
    {
        $counts = ['pending' => 0, 'blocked' => 0];
        foreach ($counts as $folder => $_) {
            foreach ($this->entries($folder) as $file) {
                ++$counts[$folder];
            }
        }

        return $counts;
    }

    /** A single drainer owns the network attempt. Writers publish independent files without this lock. */
    private function process(int $limit, ?string $target = null, bool $retryBlocked = false): bool
    {
        if (! is_dir($this->directory)) {
            return false;
        }
        $lock = fopen($this->directory.'/.drain.lock', 'c+b');
        if ($lock === false) {
            throw new RuntimeException('Cannot open outbox lock');
        }
        try {
            if (! flock($lock, LOCK_EX | LOCK_NB)) {
                return false;
            }
            $cooldown = $this->directory.'/retry-at';
            if (is_file($cooldown) && (int) file_get_contents($cooldown) > time()) {
                return false;
            }
            if ($retryBlocked) {
                $restored = 0;
                foreach ($this->entries('blocked') as $file) {
                    if (str_ends_with($file, '.json')) {
                        $this->move($file, $this->directory.'/pending/'.basename($file));
                        if (++$restored >= $limit) break;
                    }
                }
            }
            $files = $target === null ? $this->entries('pending') : [$this->directory.'/pending/'.$target.'.json'];
            $processed = 0;
            foreach ($files as $file) {
                if (! is_file($file)) continue;
                $blocked = $this->directory.'/blocked/'.basename($file);
                try {
                    $raw = file_get_contents($file);
                    if ($raw === false) throw new RuntimeException('Cannot read outbox record');
                    $record = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
                    if (! is_array($record) || ! is_string($record['body'] ?? null) || ! is_string($record['sha256'] ?? null)
                        || ! is_int($record['attempts'] ?? null) || ! hash_equals($record['sha256'], hash('sha256', $record['body']))) {
                        throw new JsonException('Invalid record');
                    }
                    $header = json_decode(strtok($record['body'], "\n") ?: '', true, flags: JSON_THROW_ON_ERROR);
                    if (($header['event_id'] ?? null) !== basename($file, '.json') || ($header['dsn'] ?? null) !== (string) $this->options->getDsn()) {
                        throw new JsonException('Outbox record identity mismatch');
                    }
                } catch (JsonException) {
                    $this->move($file, substr($blocked, 0, -5).'.corrupt');
                    error_log('FaultThread: retained corrupted outbox record. Run observability:outbox');
                    if (++$processed >= $limit) break;
                    continue;
                }
                $response = $this->post($record['body']);
                $limiter = new RateLimiter(new NullLogger());
                $limiter->handleResponse($response);
                $until = $limiter->getDisabledUntil('event');
                $code = $response->getStatusCode();
                $ack = ! $response->hasError() && $response->isSuccess();
                $retry = $code === 0 || $code >= 500 || in_array($code, [408, 425, 429], true) || ($response->hasError() && $code < 400);
                if (! $ack && $retry) {
                    ++$record['attempts'];
                    $until = max($until, time() + min(300, 2 ** min(9, $record['attempts'] - 1)));
                    $this->write($file, json_encode($record, JSON_THROW_ON_ERROR));
                }
                if ($until > time()) $this->write($cooldown, (string) $until);
                if ($ack) {
                    if (! unlink($file)) throw new RuntimeException('Cannot acknowledge outbox record');
                    $this->syncDirectory(dirname($file));
                } elseif (! $retry) {
                    $this->move($file, $blocked);
                    error_log('FaultThread: retained error after collector HTTP '.$code.'. Run observability:outbox');
                }
                if ($target !== null) return $ack;
                if (++$processed >= $limit || $until > time()) break;
            }
        } finally {
            fclose($lock);
        }

        return false;
    }

    private function post(string $body): Response
    {
        $request = new Request;
        $request->setStringBody($body);
        try {
            return $this->http->sendRequest($request, $this->options);
        } catch (Throwable) {
            return new Response(0, [], 'No acknowledgement');
        }
    }

    /** @return iterable<string> */
    private function entries(string $folder): iterable
    {
        $dir = $this->directory.'/'.$folder;
        if (! is_dir($dir)) return;
        foreach (new FilesystemIterator($dir) as $file) {
            if ($file->isFile() && ! $file->isLink() && preg_match('/^[a-f0-9]{32}\.(?:json|corrupt)$/D', $file->getFilename())) {
                yield $file->getPathname();
            }
        }
    }

    private function ensureDirectory(string $path): void
    {
        if (! is_dir($path)) {
            $parent = dirname($path);
            if (! is_dir($parent)) $this->ensureDirectory($parent);
            if (! @mkdir($path, 0700) && ! is_dir($path)) throw new RuntimeException('Cannot create private outbox directory');
            $this->syncDirectory($parent);
        }
        if (is_link($path) || (fileperms($path) & 0077)) throw new RuntimeException('Outbox directory is not private');
    }

    private function write(string $path, string $body, bool $once = false): void
    {
        $dir = dirname($path);
        $temp = $dir.'/.'.bin2hex(random_bytes(16)).'.tmp';
        $handle = fopen($temp, 'xb');
        if ($handle === false) throw new RuntimeException('Cannot open outbox file');
        try {
            try {
                if (! chmod($temp, 0600) || fwrite($handle, $body) !== strlen($body) || ! fflush($handle) || ! fsync($handle)) {
                    throw new RuntimeException('Cannot persist outbox file');
                }
            } finally {
                fclose($handle);
            }
            if ($once) {
                // A hard link publishes the complete file only if this event ID does not exist.
                if (! @link($temp, $path) && ! is_file($path)) throw new RuntimeException('Cannot publish outbox file');
            } elseif (! rename($temp, $path)) {
                throw new RuntimeException('Cannot update outbox file');
            }
            $this->syncDirectory($dir);
        } finally {
            if (is_file($temp)) unlink($temp);
        }
    }

    private function move(string $source, string $destination): void
    {
        if (! rename($source, $destination)) throw new RuntimeException('Cannot move outbox record');
        $this->syncDirectory(dirname($destination));
        $this->syncDirectory(dirname($source));
    }

    private function syncDirectory(string $dir): void
    {
        $handle = fopen($dir, 'r');
        if ($handle === false) throw new RuntimeException('Cannot open outbox directory');
        try {
            if (! fsync($handle)) throw new RuntimeException('Cannot sync outbox directory');
        } finally {
            fclose($handle);
        }
    }
}
