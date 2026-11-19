<?php

declare(strict_types=1);

namespace FaultThread\Laravel;

use Illuminate\Support\ServiceProvider;

/** @internal Entry point for applications with the original provider name still configured. */
final class LegacyServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Laravel deduplicates registrations by their exact class name.
        $this->app->register(ObservabilityServiceProvider::class);
    }
}
