<?php
declare(strict_types=1);

/**
 * GET /api/public-aliases.php
 * Liste publique des alias joueurs (remplace la collection Firestore
 * public-aliases consultee par app.js et le dashboard).
 * uid + username + publicId + aliases[] pour la compatibilite frontend.
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

rate_limit($pdo, 'aliases:' . client_ip(), 60, 60);

$rows = $pdo->query(
    'SELECT user_id, username, public_id FROM tfh_public_aliases ORDER BY updated_at DESC LIMIT 1000'
)->fetchAll();

$aliases = array_map(
    static fn(array $r): array => [
        'uid'      => (string) $r['user_id'],
        'username' => $r['username'],
        'publicId' => $r['public_id'],
        'aliases'  => $r['username'] !== null ? [$r['username']] : [],
    ],
    $rows
);

json_out([
    'ok'      => true,
    'aliases' => $aliases,
    'count'   => count($aliases),
]);
