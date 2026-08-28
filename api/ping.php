<?php
declare(strict_types=1);

/**
 * GET /api/ping.php
 * Health-check : PHP, MySQL, secrets Discord charges, cURL present.
 * Premier endpoint a tester apres le deploiement.
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

try {
    $pdo->query('SELECT 1');
} catch (Throwable $e) {
    error_log('[tfh-api] ping: ' . $e->getMessage());
    json_out(['ok' => false, 'db' => false], 500);
}

json_out([
    'ok'           => true,
    'service'      => 'tfh-api',
    'php'          => PHP_VERSION,
    'db'           => true,
    'curl'         => extension_loaded('curl'),
    'discordReady' => strlen(TFH_DISCORD_CLIENT_ID) >= 17 && strlen(TFH_DISCORD_CLIENT_SECRET) >= 25,
    'time'         => gmdate('c'),
]);
