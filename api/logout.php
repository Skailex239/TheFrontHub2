<?php
declare(strict_types=1);

/**
 * POST /api/logout.php  (GET accepte pour faciliter les tests)
 * Detruit la session en base et expire le cookie.
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (!in_array($method, ['POST', 'GET'], true)) {
    fail(405, 'method_not_allowed', 'POST ou GET uniquement.');
}

rate_limit($pdo, 'logout:' . client_ip(), 30, 60);

destroy_session($pdo);

json_out(['ok' => true, 'loggedOut' => true]);
