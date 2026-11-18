<?php

declare(strict_types=1);

namespace EventObservability\Laravel;

/** @internal */
final class Redaction
{
    private const MAX_REDACTION_BYTES = 32768;
    private const MAX_URL_BYTES = 8192;

    public static function text(string $value, mixed $mode): ?string
    {
        return match ($mode) {
            'redact' => self::message($value),
            'full' => $value,
            default => null,
        };
    }

    public static function message(string $value): string
    {
        if (strlen($value) > self::MAX_REDACTION_BYTES) {
            return '[omitted]';
        }
        $value = (string) preg_replace('/\bSQL: .*$/s', 'SQL: [omitted])', $value);
        $value = (string) preg_replace_callback(
            '#https?://[^\s)\'"]+#i',
            static fn (array $match): string => self::url($match[0]), $value,
        );
        $value = (string) preg_replace('/\b(?:Bearer|Basic)\h+[^\s,;"\']+/i', '******', $value);
        $value = (string) preg_replace('/(?<![\w.+-])[\w.+-]++@[\w-]++(?:\.[\w-]++)+/', '[email redacted]', $value);
        // A Cookie header may contain several semicolon-separated credentials.
        $value = (string) preg_replace('/(\b(?:set-cookie|cookie)\h*:\h*)[^\r\n]+/i', '$1[redacted]', $value);
        $value = (string) preg_replace(
            <<<'REGEX'
~((?:password|contrase[nñ]a|token|authorization|cookie|secret|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*+(?:"|$)|'(?:\\.|[^'\\])*+(?:'|$)|[^\s,;]+)~iu
REGEX,
            '$1[redacted]', $value,
        );
        if (str_starts_with($value, 'SQLSTATE')) {
            $value = (string) preg_replace("/'[^']*'/", "'?'", $value);
        }

        return mb_substr($value, 0, 1000);
    }

    public static function sql(string $sql): string
    {
        // Omit dialect-specific literals and comments instead of guessing where sensitive text ends.
        if (strlen($sql) > self::MAX_REDACTION_BYTES || preg_match('~\#|--|/\*|\$(?:[a-z_][\w]*)?\$~i', $sql)) {
            return '[omitted]';
        }
        $sql = (string) preg_replace(
            <<<'REGEX'
~'(?:''|\\.|[^'\\])*+'|"(?:""|\\.|[^"\\])*+"~s
REGEX,
            '?', $sql,
        );
        if (str_contains($sql, "'") || str_contains($sql, '"')) {
            return '[omitted]';
        }
        $sql = (string) preg_replace('/(?<![\w])(?:0x[a-f\d]+|\d+(?:\.\d+)?)(?![\w])/i', '?', $sql);

        return mb_substr($sql, 0, 1000);
    }

    public static function url(string $url): string
    {
        if (strlen($url) > self::MAX_URL_BYTES || str_contains($url, '\\') || preg_match('/[\x00-\x1f\x7f]/', $url)) {
            return '[invalid URL]';
        }
        $parts = parse_url($url);
        if ($parts === false) {
            return '[invalid URL]';
        }
        $scheme = strtolower($parts['scheme'] ?? 'http');
        if (! in_array($scheme, ['http', 'https'], true) || (isset($parts['scheme']) && ! isset($parts['host']))) {
            return '[invalid URL]';
        }
        $route = (string) preg_replace(
            ['#/\d+(?=/|$)#', '#/[a-f\d]{8}-[a-f\d-]{27,}(?=/|$)#i', '#(^|/)[^/]*(?:@|%40)[^/]*#i'],
            ['/:id', '/:id', '$1:redacted'], $parts['path'] ?? '/',
        );
        if (! isset($parts['host'])) {
            return $route;
        }
        $port = isset($parts['port']) ? ':'.$parts['port'] : '';

        return $scheme.'://'.$parts['host'].$port.$route;
    }
}
