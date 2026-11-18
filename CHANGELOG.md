# Changelog

## 0.2.0

- Requires verified HTTPS for remote collectors using the standard SDK transport.
- Checks the send result and flush status for synthetic Artisan diagnostic events.

## 0.1.0

- Added automatic provider discovery and publishable Laravel configuration.
- Correlates HTTP requests, captures 5xx responses, and deduplicates reports per request.
- Rebuilds events from an allowlist and redacts SQL literals.
- Isolates request and job context across nested synchronous jobs and worker failures.
- Restricts serialized event fields and outbound Sentry headers, and disables delivery for invalid DSNs.
