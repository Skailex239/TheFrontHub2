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

/* Cache sessions OpenFront (équivalent Firestore users.openFrontSessions) */
$openFrontSessions = null;
$sessionsRaw = $user['openfront_sessions'] ?? null;
if ($sessionsRaw !== null) {
    $decoded = json_decode((string) $sessionsRaw, true);
    if (is_array($decoded)) {
        $openFrontSessions = $decoded;
    }
}

/* v5.13 — Profil revendiqué : état de vérification + champs profil
 * (bio, map préférée, liens réseaux). Colonnes garanties par
 * tfh_profile_ensure_schema (profile-schema.php). */
require_once __DIR__ . '/profile-schema.php';
require_once __DIR__ . '/games-db.php'; // v5.43
 tfh_profile_ensure_schema(tfh_games_pdo('auto') ?? $pdo, $pdo); // weekly sur la base GAMES, colonnes hub sur SITE

$verifiedAt = null;
if (!empty($user['verified_at'])) {
    $vt = strtotime((string) $user['verified_at']);
    if ($vt !== false) {
        $verifiedAt = $vt;
    }
}
$isVerified = ($user['public_id'] ?? null) !== null && ($user['public_id'] ?? '') !== '' && $verifiedAt !== null;

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
        'language'         => ($user['language'] ?? null) === 'en' ? 'en' : 'fr',
        'role'             => $user['role'],
        'isAdmin'          => $user['role'] === 'admin',
        'discordCreatedAt' => $user['discord_created_at'],
        'createdAt'        => $user['created_at'],
        'lastLoginAt'      => $user['last_login_at'],
        'providers'        => $providers,
        'openFrontSessions' => $openFrontSessions,
        /* Profil revendiqué (v5.13) */
        'verified'         => $isVerified,
        'verifiedAt'       => $verifiedAt,
        'bio'              => $user['bio'] ?? null,
        'favMap'           => $user['fav_map'] ?? null,
        'links'            => [
            'x'       => $user['link_x'] ?? null,
            'youtube' => $user['link_youtube'] ?? null,
            'twitch'  => $user['link_twitch'] ?? null,
            'discord' => $user['link_discord'] ?? null,
        ],
    ],
]);
