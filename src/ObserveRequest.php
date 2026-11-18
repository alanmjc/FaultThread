<?php

declare(strict_types=1);

namespace EventObservability\Laravel;

use Closure;
use Illuminate\Http\Request;
use Sentry\SentrySdk;
use Sentry\Severity;
use Sentry\State\Scope;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

final class ObserveRequest
{
    public const ACTIVE = '_observability_active';
    public const REPORTED = '_observability_reported';

    public function handle(Request $request, Closure $next): Response
    {
        $id = $request->headers->get('X-Request-Id');
        if (! is_string($id) || preg_match('/^[a-z\d-]{1,64}$/iD', $id) !== 1) {
            $id = bin2hex(random_bytes(16));
        }

        $request->headers->set('X-Request-Id', $id);
        $request->attributes->set(self::ACTIVE, $id);
        $request->attributes->set(self::REPORTED, false);
        $hub = SentrySdk::getCurrentHub();
        $scope = $hub->pushScope();
        $scope->clear();
        $scope->setTag('request_id', $id);

        try {
            // Laravel's routing pipeline reports and renders exceptions inside this scope.
            $response = $next($request);
            $response->headers->set('X-Request-Id', $id);
            if ($response->getStatusCode() >= 500 && ! $request->attributes->get(self::REPORTED)) {
                $this->reportResponse($request, $response);
            }

            return $response;
        } finally {
            $request->attributes->remove(self::ACTIVE);
            $request->attributes->remove(self::REPORTED);
            $hub->popScope();
        }
    }

    private function reportResponse(Request $request, Response $response): void
    {
        $status = $response->getStatusCode();

        try {
            $fingerprint = self::responseFingerprint($request, $status);
            \Sentry\withScope(static function (Scope $scope) use ($status, $fingerprint): void {
                $scope->setFingerprint($fingerprint);
                $scope->setTag('http.status_code', (string) $status);
                \Sentry\captureMessage(
                    sprintf('HTTP %d response without a reported exception', $status),
                    Severity::error(),
                );
            });
        } catch (Throwable $exception) {
            LocalDiagnostics::failure($exception);
        }
    }

    /** @return list<string> */
    public static function responseFingerprint(Request $request, int $status): array
    {
        $route = $request->route()?->uri();
        $template = $route === null ? '[unmatched route]' : '/'.ltrim($route, '/');

        return ['server-response', self::normalizeMethod($request->getMethod()), $template, (string) $status];
    }

    public static function normalizeMethod(mixed $method): string
    {
        return in_array($method, ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'], true)
            ? $method
            : 'OTHER';
    }
}
