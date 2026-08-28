<?php
declare(strict_types=1);

/**
 * /api/rewards.php — Statuts VIP / skins publics
 * (remplace la collection Firestore public-rewards).
 *
 * GET   (aucun paramètre) → identique à /api/public-rewards.php
 * POST  { publicId, username }                    → pont public (session requise) :
 *        upsert de la ligne SANS toucher aux champs VIP (activeType/type/activated)
 * POST  { action:'grant', publicId, activeType }  → accorde un type VIP (admin)
 * POST  { action:'revoke', publicId }             → désactive le VIP (admin)
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

/* ------------------------------------------------------------------ */
/* GET — liste publique (même format que public-rewards.php)           */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    rate_limit($pdo, 'rewards-get:' . client_ip(), 60, 60);

    $rows = $pdo->query(
        'SELECT public_id, username, active_type, type, activated
         FROM tfh_public_rewards ORDER BY updated_at DESC LIMIT 500'
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

    json_out(['ok' => true, 'rewards' => $rewards, 'count' => count($rewards)]);
}

/* ------------------------------------------------------------------ */
/* POST                                                                 */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'method_not_allowed', 'GET ou POST uniquement.');
}

rate_limit($pdo, 'rewards-post:' . client_ip(), 30, 60);

$user = current_user($pdo);
if ($user === null) {
    fail(401, 'not_authenticated', 'Connecte-toi d\'abord.');
}

$in = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($in)) {
    fail(400, 'bad_request', 'Corps JSON invalide.');
}

$action = (string) ($in['action'] ?? '');

try {
    /* ---------- Pont public (appelé par le frontend à la connexion) ---------- */
    if ($action === '') {
        $publicId = (string) ($in['publicId'] ?? '');
        $username = tfh_cut((string) ($in['username'] ?? ''), 64);

        if ($publicId === '' || !preg_match('/^[A-Za-z0-9_-]{3,64}$/', $publicId)) {
            fail(400, 'invalid_public_id', 'Identifiant public invalide.');
        }
        if ($username === null) {
            fail(400, 'invalid_username', 'Pseudo manquant.');
        }

        /* La ligne appartient au compte connecté : le publicId transmis doit
           être celui du compte (sinon n'importe qui écraserait les ponts). */
        if ($user['public_id'] !== $publicId) {
            fail(403, 'public_id_mismatch', 'Ce compte n\'est pas lié à cet identifiant public.');
        }

        $pdo->prepare(
            'INSERT INTO tfh_public_rewards (public_id, user_id, username, activated)
             VALUES (?, ?, ?, 0)
             ON DUPLICATE KEY UPDATE username = VALUES(username), user_id = VALUES(user_id)'
        )->execute([$publicId, $user['id'], $username]);

        json_out(['ok' => true]);
    }

    /* ---------- Actions admin ---------- */

    if ($user['role'] !== 'admin') {
        fail(403, 'forbidden', 'Réservé aux administrateurs.');
    }

    $publicId = (string) ($in['publicId'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{3,64}$/', $publicId)) {
        fail(400, 'invalid_public_id', 'Identifiant public invalide.');
    }

    switch ($action) {
        case 'grant': {
            $activeType = tfh_cut((string) ($in['activeType'] ?? ''), 32);
            if ($activeType === null) {
                fail(400, 'invalid_type', 'Type de récompense manquant.');
            }
            $pdo->prepare(
                'INSERT INTO tfh_public_rewards (public_id, username, active_type, activated)
                 VALUES (?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                   active_type = VALUES(active_type),
                   type = COALESCE(type, VALUES(active_type)),
                   activated = 1'
            )->execute([$publicId, tfh_cut((string) ($in['username'] ?? $publicId), 64) ?? $publicId, $activeType]);
            json_out(['ok' => true, 'publicId' => $publicId, 'activeType' => $activeType]);
        }

        case 'revoke': {
            $pdo->prepare('UPDATE tfh_public_rewards SET activated = 0 WHERE public_id = ?')
                ->execute([$publicId]);
            json_out(['ok' => true, 'publicId' => $publicId]);
        }

        default:
            fail(400, 'invalid_action', 'Action inconnue.');
    }
} catch (PDOException $e) {
    error_log('[tfh-api] rewards: ' . $e->getMessage());
    fail(500, 'db_error', 'Erreur inattendue, réessaie.');
}
