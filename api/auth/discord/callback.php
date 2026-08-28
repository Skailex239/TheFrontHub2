<?php
declare(strict_types=1);

/**
 * GET /api/auth/discord/callback.php
 * Discord redirige ici avec ?code=...&state=...
 *
 * 1) Verifie le state (usage unique, anti-CSRF, 15 min)
 * 2) Echange le code contre un access_token
 * 3) Recupere le profil Discord complet
 * 4) Cree ou met a jour le compte MySQL (profil complet + identite)
 * 5) Ouvre la session (cookie HttpOnly, 30 jours)
 * 6) Redirige vers le site
 */

define('TFH_API', true);
require __DIR__ . '/../../config.php';

rate_limit($pdo, 'oauth-cb:' . client_ip(), 20, 600);

function login_error(string $reason): never
{
    error_log('[tfh-api] oauth discord: ' . $reason);
    header('Location: ' . TFH_BASE_URL . '/?login=error&reason=' . urlencode($reason), true, 302);
    exit;
}

/* ---------- 1) Parametres ---------- */

if (isset($_GET['error'])) {
    login_error((string) $_GET['error']);
}

$state = (string) ($_GET['state'] ?? '');
$code  = (string) ($_GET['code'] ?? '');

if (!preg_match('/^[a-f0-9]{64}$/', $state) || $code === '' || strlen($code) > 200) {
    login_error('bad_params');
}

/* ---------- 2) State a usage unique ---------- */

$st = $pdo->prepare(
    'DELETE FROM tfh_oauth_states
     WHERE state = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ' . TFH_STATE_TTL . ' SECOND)'
);
$st->execute([$state]);
if ($st->rowCount() === 0) {
    login_error('bad_state');
}

/* ---------- 3) Echange code -> access_token ---------- */

[$status, $body] = discord_http(TFH_DISCORD_TOKEN_URL, [
    'client_id'     => TFH_DISCORD_CLIENT_ID,
    'client_secret' => TFH_DISCORD_CLIENT_SECRET,
    'grant_type'    => 'authorization_code',
    'code'          => $code,
    'redirect_uri'  => TFH_DISCORD_REDIRECT_URI,
]);

if ($status !== 200) {
    login_error('token_exchange_http_' . $status);
}

$token = json_decode($body, true);
$accessToken = is_array($token) ? (string) ($token['access_token'] ?? '') : '';
if ($accessToken === '') {
    login_error('token_missing');
}

/* ---------- 4) Profil Discord ---------- */

[$status, $body] = discord_http(
    TFH_DISCORD_ME_URL,
    null,
    ['Authorization: Bearer ' . $accessToken]
);

if ($status !== 200) {
    login_error('profile_http_' . $status);
}

$du = json_decode($body, true);
if (!is_array($du) || empty($du['id'])) {
    login_error('profile_invalid');
}
$did = (string) $du['id'];

/* ---------- 5) Champs a stocker (profil complet) ---------- */

$username    = tfh_cut($du['username'] ?? null, 64);
$globalName  = tfh_cut($du['global_name'] ?? null, 64);
$avatarUrl   = discord_avatar_url($did, isset($du['avatar']) ? (string) $du['avatar'] : null);
$locale      = tfh_cut($du['locale'] ?? null, 16);
$flags       = isset($du['flags']) ? (int) $du['flags'] : null;
$premiumType = isset($du['premium_type']) ? (int) $du['premium_type'] : null;
$dcCreatedAt = discord_created_at($did);
$email       = filter_var((string) ($du['email'] ?? ''), FILTER_VALIDATE_EMAIL) ?: null;
$verified    = !empty($du['verified']) ? 1 : 0;

/* ---------- 6) Creation / mise a jour du compte ---------- */

try {
    $pdo->beginTransaction();

    $find = $pdo->prepare('SELECT user_id FROM tfh_user_identities WHERE provider = ? AND provider_uid = ?');
    $find->execute(['discord', $did]);
    $ident = $find->fetch();

    if ($ident !== false) {
        /* Compte existant : rafraichissement du profil */
        $userId = (int) $ident['user_id'];

        if ($email !== null) {
            $chk = $pdo->prepare('SELECT id FROM tfh_users WHERE email = ? AND id != ?');
            $chk->execute([$email, $userId]);
            if ($chk->fetch() !== false) {
                $email = null; // email deja porte par un autre compte : on ne l'ecrase pas
            }
        }

        $pdo->prepare(
            'UPDATE tfh_users
             SET username = ?, global_name = ?, avatar_url = ?, locale = ?,
                 discord_flags = ?, discord_premium_type = ?, discord_created_at = ?,
                 email = COALESCE(?, email), email_verified = ?, last_login_at = NOW()
             WHERE id = ?'
        )->execute([$username, $globalName, $avatarUrl, $locale, $flags, $premiumType, $dcCreatedAt, $email, $verified, $userId]);

        /* Synchronise l'affichage public si le pseudo a change */
        $pdo->prepare('UPDATE tfh_public_aliases SET username = COALESCE(?, username) WHERE user_id = ?')
            ->execute([$username, $userId]);
        $pdo->prepare('UPDATE tfh_public_rewards SET username = COALESCE(?, username) WHERE user_id = ?')
            ->execute([$username, $userId]);
    } else {
        /* Nouveau compte */
        if ($email !== null) {
            $chk = $pdo->prepare('SELECT id FROM tfh_users WHERE email = ?');
            $chk->execute([$email]);
            if ($chk->fetch() !== false) {
                $email = null;
            }
        }

        $userId = 0;
        $publicId = '';
        for ($try = 0; $try < 3; $try++) {
            $publicId = 'tfh' . bin2hex(random_bytes(6)); // 15 caracteres
            try {
                $pdo->prepare(
                    'INSERT INTO tfh_users
                     (username, global_name, avatar_url, locale, discord_flags,
                      discord_premium_type, discord_created_at, email, email_verified,
                      public_id, role, last_login_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'user\', NOW())'
                )->execute([$username, $globalName, $avatarUrl, $locale, $flags, $premiumType, $dcCreatedAt, $email, $verified, $publicId]);
                $userId = (int) $pdo->lastInsertId();
                break;
            } catch (PDOException $e) {
                if ($try === 2) {
                    throw $e; // 3 essais suffisent pour eviter une collision improbable
                }
            }
        }

        $pdo->prepare('INSERT INTO tfh_user_identities (user_id, provider, provider_uid) VALUES (?, ?, ?)')
            ->execute([$userId, 'discord', $did]);

        $pdo->prepare('INSERT INTO tfh_public_aliases (user_id, username, public_id) VALUES (?, ?, ?)')
            ->execute([$userId, $username ?? ('user' . $userId), $publicId]);
    }

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('[tfh-api] callback DB: ' . $e->getMessage());
    login_error('db_error');
}

/* ---------- 7) Ouverture de session ---------- */

create_session($pdo, $userId);

/* ---------- 8) Retour vers le site ---------- */

header('Location: ' . TFH_BASE_URL . '/?login=discord-ok', true, 302);
exit;
