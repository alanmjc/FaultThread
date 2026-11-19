<?php

declare(strict_types=1);

$externalAutoload = getenv('OBSERVER_TEST_AUTOLOAD');
$autoload = $externalAutoload ?: dirname(__DIR__).'/vendor/autoload.php';
if (! is_file($autoload)) {
    throw new RuntimeException('Run composer install in the package directory or set OBSERVER_TEST_AUTOLOAD.');
}
require $autoload;
if (! $externalAutoload) {
    return;
}

spl_autoload_register(static function (string $class): void {
    $prefix = 'FaultThread\\Laravel\\';
    if (str_starts_with($class, $prefix)) {
        $path = __DIR__.'/../src/'.str_replace('\\', '/', substr($class, strlen($prefix))).'.php';
        if (is_file($path)) {
            require $path;
        }
    }
}, prepend: true);

require_once __DIR__.'/../src/legacy-aliases.php';
