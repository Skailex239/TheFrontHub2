<?php
declare(strict_types=1);

/**
 * POST /api/profile.php   { username, publicId, openFrontSessions? }
 * Met a jour le pseudo et/ou l'identifiant public du joueur connecte,
 * puis resynchronise les tables publiques (aliases + rewards).
 *
 * Regles :
 *  - publicId : immuable une fois defini (l'ID OpenFront verifie appartient
 *    au compte pour toujours — meme regle que l'ancien frontend).
 *  - username : modifiable librement.
 *  - openFrontSessions : cache JSON optionnel (equivalent Firestore).
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'method_not_allowed', 'POST uniquement.');
}

rate_limit($pdo, 'profile:' . client_ip(), 30, 60);

$user = current_user($pdo);
if ($user === null) {
    fail(401, 'not_authenticated', 'Non connecte.');
}

$in = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($in)) {
    $in = [];
}

$newUsername = isset($in['username']) ? trim((string) $in['username']) : null;
$newPublicId = isset($in['publicId']) ? trim((string) $in['publicId']) : null;
$sessions    = isset($in['openFrontSessions']) ? $in['openFrontSessions'] : null;

/* Champs vides = "ne pas changer" */
if ($newUsername === '') {
    $newUsername = null;
}
if ($newPublicId === '') {
    $newPublicId = null;
}

if ($newUsername !== null && !preg_match('/^[A-Za-z0-9_.\- ]{3,32}$/u', $newUsername)) {
    fail(400, 'invalid_username', 'Pseudo : 3 a 32 caracteres (lettres, chiffres, . _ - espace).');
}
if ($newPublicId !== null && !preg_match('/^[A-Za-z0-9_-]{3,64}$/', $newPublicId)) {
    fail(400, 'invalid_public_id', 'Identifiant public : 3 a 64 caracteres (lettres, chiffres, _ -).');
}
if ($sessions !== null && !is_array($sessions)) {
    $sessions = null;
}

/* publicId immuable une fois lie au compte */
$existingPublicId = $user['public_id'];
if ($newPublicId !== null && $existingPublicId !== null && $newPublicId !== $existingPublicId) {
    fail(409, 'public_id_locked', 'Le Public ID OpenFront ne peut plus etre modifie.');
}

/* ── Protections serveur (2026-09-03) ────────────────────────────────
 * Le check frontend peut etre contourne (appel API direct) ou echouer
 * (API aliases indisponible). Le serveur fait donc lui-meme respecter :
 *  1. un publicId ne peut pas etre lie a deux comptes ;
 *  2. un pseudo hub ne peut pas etre pris par deux comptes.            */
if ($newPublicId !== null && $newPublicId !== $existingPublicId) {
    $st = $pdo->prepare('SELECT id FROM tfh_users WHERE public_id = ? AND id <> ? LIMIT 1');
    $st->execute([$newPublicId, $user['id']]);
    if ($st->fetch()) {
        fail(409, 'public_id_taken', 'Ce Public ID est deja lie a un autre compte.');
    }
    $st = $pdo->prepare('SELECT user_id FROM tfh_public_aliases WHERE public_id = ? AND user_id <> ? LIMIT 1');
    $st->execute([$newPublicId, $user['id']]);
    if ($st->fetch()) {
        fail(409, 'public_id_taken', 'Ce Public ID est deja lie a un autre compte.');
    }
}
if ($newUsername !== null && strcasecmp($newUsername, (string) ($user['username'] ?? '')) !== 0) {
    $st = $pdo->prepare('SELECT user_id FROM tfh_public_aliases WHERE LOWER(username) = LOWER(?) AND user_id <> ? LIMIT 1');
    $st->execute([$newUsername, $user['id']]);
    if ($st->fetch()) {
        fail(409, 'already_taken', 'Ce pseudo est deja utilise par un autre compte.');
    }
}

$username = $newUsername ?? $user['username'];
$publicId = $newPublicId ?? $existingPublicId;

try {
    $pdo->beginTransaction();

    if ($sessions !== null) {
        $pdo->prepare('UPDATE tfh_users SET username = ?, public_id = ?, openfront_sessions = ? WHERE id = ?')
            ->execute([$username, $publicId, json_encode($sessions, JSON_UNESCAPED_UNICODE), $user['id']]);
    } else {
        $pdo->prepare('UPDATE tfh_users SET username = ?, public_id = ? WHERE id = ?')
            ->execute([$username, $publicId, $user['id']]);
    }

    $aliasUpd = static function () use ($pdo, $user, $username, $publicId): void {
        try {
            $pdo->prepare(
                'INSERT INTO tfh_public_aliases (user_id, username, public_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE username = VALUES(username), public_id = VALUES(public_id),
                   /* publicId change -> on invalide le pseudo en jeu cache pour refetch */
                   game_username = IF(public_id <> VALUES(public_id) OR (public_id IS NULL) <> (VALUES(public_id) IS NULL), NULL, game_username)'
            )->execute([$user['id'], $username ?? ('user' . $user['id']), $publicId]);
        } catch (PDOException $e) {
            if ((int) $e->getCode() !== 42S22) { // 42S22 = colonne game_username absente (SQL pas encore passe)
                throw $e;
            }
            // Fallback degrada : upsert sans la colonne (meme comportement qu'avant)
            $pdo->prepare(
                'INSERT INTO tfh_public_aliases (user_id, username, public_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE username = VALUES(username), public_id = VALUES(public_id)'
            )->execute([$user['id'], $username ?? ('user' . $user['id']), $publicId]);
        }
    };
    $aliasUpd();

    if ($publicId !== null) {
        $pdo->prepare(
            'INSERT INTO tfh_public_rewards (public_id, user_id, username, activated)
             VALUES (?, ?, ?, 0)
             ON DUPLICATE KEY UPDATE username = VALUES(username), user_id = VALUES(user_id)'
        )->execute([$publicId, $user['id'], $username ?? ('user' . $user['id'])]);
    }

    $pdo->commit();
} catch (PDOException $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    if ((int) $e->getCode() === 23000) {
        fail(409, 'already_taken', 'Ce pseudo ou cet identifiant public est deja utilise.');
    }
    error_log('[tfh-api] profile: ' . $e->getMessage());
    fail(500, 'db_error', 'Erreur inattendue, reessaie.');
}

json_out([
    'ok'   => true,
    'user' => [
        'publicId' => $publicId,
        'username' => $username,
    ],
]);
