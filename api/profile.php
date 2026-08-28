<?php
declare(strict_types=1);

/**
 * POST /api/profile.php   { "username": "...", "publicId": "..." }
 * Met a jour le pseudo et/ou l'identifiant public du joueur connecte,
 * puis resynchronise les tables publiques (aliases + rewards).
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

/* Champs vides = "ne pas changer" */
if ($newUsername === '') {
    $newUsername = null;
}
if ($newPublicId === '') {
    $newPublicId = null;
}

if ($newUsername !== null && !preg_match('/^[A-Za-z0-9_.-]{3,32}$/u', $newUsername)) {
    fail(400, 'invalid_username', 'Pseudo : 3 a 32 caracteres (lettres, chiffres, . _ -).');
}
if ($newPublicId !== null && !preg_match('/^[A-Za-z0-9_-]{3,64}$/', $newPublicId)) {
    fail(400, 'invalid_public_id', 'Identifiant public : 3 a 64 caracteres (lettres, chiffres, _ -).');
}

$username = $newUsername ?? $user['username'];
$publicId = $newPublicId ?? $user['public_id'];

try {
    $pdo->beginTransaction();

    $pdo->prepare('UPDATE tfh_users SET username = ?, public_id = ? WHERE id = ?')
        ->execute([$username, $publicId, $user['id']]);

    $pdo->prepare(
        'INSERT INTO tfh_public_aliases (user_id, username, public_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE username = VALUES(username), public_id = VALUES(public_id)'
    )->execute([$user['id'], $username, $publicId]);

    $pdo->prepare('UPDATE tfh_public_rewards SET username = ?, public_id = ? WHERE user_id = ?')
        ->execute([$username, $publicId, $user['id']]);

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
