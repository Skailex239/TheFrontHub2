<?php
declare(strict_types=1);

/**
 * GET /api/public-rewards.php
 * Liste publique des statuts VIP / skins (remplace la collection
 * Firestore public-rewards consultee par le dashboard et le profil).
 * Cles camelCase pour coller directement aux attentes du frontend.
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

rate_limit($pdo, 'rewards:' . client_ip(), 60, 60);

$rows = $pdo->query(
    'SELECT public_id, username, active_type, type, activated
     FROM tfh_public_rewards
     ORDER BY updated_at DESC
     LIMIT 500'
)->fetchAll();

$rewards = array_map(
    static fn(array $r): array => [
        'publicId'   => $r['public_id'],
        'username'   => $r['username'],
        'activeType' => $r['active_type'],
        'type'       => $r['type'],
        'activated'  => (bool) $r['activated'],
    ],
    $rows
);

json_out([
    'ok'      => true,
    'rewards' => $rewards,
    'count'   => count($rewards),
]);
