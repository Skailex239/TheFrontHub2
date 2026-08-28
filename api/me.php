<?php
declare(strict_types=1);

/**
 * GET /api/me.php
 * Profil du joueur connecte (session cookie tfh_session).
 * Etend la session de 30 jours a chaque appel (session glissante).
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

rate_limit($pdo, 'me:' . client_ip(), 120, 60);

$user = current_user($pdo);
if ($user === null) {
    fail(401, 'not_authenticated', 'Non connecte.');
}

/* Providers lies a ce compte (discord maintenant, google plus tard) */
$prov = $pdo->prepare('SELECT provider FROM tfh_user_identities WHERE user_id = ?');
$prov->execute([$user['id']]);
$providers = array_column($prov->fetchAll(), 'provider');

json_out([
    'ok'   => true,
    'user' => [
        'id'               => (int) $user['id'],
        'publicId'         => $user['public_id'],
        'username'         => $user['username'],
        'globalName'       => $user['global_name'],
        'displayName'      => $user['global_name'] !== null && $user['global_name'] !== ''
                                ? $user['global_name']
                                : $user['username'],
        'avatarUrl'        => $user['avatar_url'],
        'email'            => $user['email'],
        'emailVerified'    => (bool) $user['email_verified'],
        'locale'           => $user['locale'],
        'role'             => $user['role'],
        'isAdmin'          => $user['role'] === 'admin',
        'discordCreatedAt' => $user['discord_created_at'],
        'createdAt'        => $user['created_at'],
        'lastLoginAt'      => $user['last_login_at'],
        'providers'        => $providers,
    ],
]);
