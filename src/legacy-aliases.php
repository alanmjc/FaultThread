<?php

declare(strict_types=1);

namespace FaultThread\Laravel;

// Cached provider manifests, middleware and SDK callbacks may still use the original class names.
foreach ([
    'DiagnoseCommand' => DiagnoseCommand::class,
    'DurableEventTransport' => DurableEventTransport::class,
    'EventSanitizer' => EventSanitizer::class,
    'LocalDiagnostics' => LocalDiagnostics::class,
    'ObservabilityServiceProvider' => LegacyServiceProvider::class,
    'ObserveQueue' => ObserveQueue::class,
    'ObserveRequest' => ObserveRequest::class,
    'OutboxCommand' => OutboxCommand::class,
    'Redaction' => Redaction::class,
] as $shortName => $faultThreadClass) {
    $legacyName = 'EventObservability\\Laravel\\'.$shortName;
    if (! class_exists($legacyName, false)) {
        class_alias($faultThreadClass, $legacyName);
    }
}
