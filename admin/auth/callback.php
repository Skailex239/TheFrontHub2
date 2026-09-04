<?php
declare(strict_types=1);

/**
 * GET task/auth/callback.php
 * Discord revient ici avec ?code=...&state=...
 *
 * 1) Vérifie le state (usage unique, 15 min, table partagée avec le site)
 * 2) Échange le code contre un access_token
 * 3) Récupère le profil Discord
 * 4) Crée/met à jour le compte MySQL (mêmes tables que le site)
 * 5) Contrôle l'accès au panel :
 *      - whitelist tfh_task_admins, OU
 *      - rôle "admin" du site (tfh_users.role)
 *    Bootstrap : si la whitelist est vide, le premier compte devient propriétaire.
 * 6) Ouvre la session (cookie HttpOnly 30 jours) et revient au panel.
 */

define('TFH_API', true);
require __DIR__ . '/../lib.php';

task_security_headers();

rate_limit($pdo, 'task-oauth-cb:' . client_ip(), 20, 600);

function cb_error(string $message): never
{
    error_log('[tfh-task] oauth: ' . $message);
    task_render_login(['error' => $message]);
    exit;
}

/* ---------- 1) Paramètres ---------- */

if (isset($_GET['error'])) {
    cb_error('Connexion annulée ou refusée côté Discord.');
}

$state = (string) ($_GET['state'] ?? '');
$code  = (string) ($_GET['code'] ?? '');

if (!preg_match('/^[a-f0-9]{64}$/', $state) || $code === '' || strlen($code) > 200) {
    cb_error('Lien de connexion invalide.');
}

/* ---------- 2) State à usage unique ---------- */

$st = $pdo->prepare(
    'DELETE FROM tfh_oauth_states
     WHERE state = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ' . TFH_STATE_TTL . ' SECOND)'
);
$st->execute([$state]);
if ($st->rowCount() === 0) {
    cb_error('Lien de connexion expiré — recommence depuis le panel.');
}

/* ---------- 3) Échange code -> access_token ---------- */

[$status, $body] = discord_http(TFH_DISCORD_TOKEN_URL, [
    'client_id'     => TFH_DISCORD_CLIENT_ID,
    'client_secret' => TFH_DISCORD_CLIENT_SECRET,
    'grant_type'    => 'authorization_code',
    'code'          => $code,
    'redirect_uri'  => task_redirect_uri(),
]);

if ($status !== 200) {
    cb_error('Échange avec Discord impossible (HTTP ' . $status . '). Si le portail Discord ne liste pas encore l\'URL de redirection du panel, ajoute-la dans OAuth2 → Redirects.');
}

$token = json_decode($body, true);
$accessToken = is_array($token) ? (string) ($token['access_token'] ?? '') : '';
if ($accessToken === '') {
    cb_error('Réponse Discord inattendue (jeton manquant).');
}

/* ---------- 4) Profil Discord ---------- */

[$status, $body] = discord_http(
    TFH_DISCORD_ME_URL,
    null,
    ['Authorization: Bearer ' . $accessToken]
);

if ($status !== 200) {
    cb_error('Profil Discord indisponible (HTTP ' . $status . ').');
}

$du = json_decode($body, true);
if (!is_array($du) || empty($du['id'])) {
    cb_error('Profil Discord invalide.');
}
$did = (string) $du['id'];

$username   = tfh_cut($du['username'] ?? null, 64);
$globalName = tfh_cut($du['global_name'] ?? null, 64);
$avatarUrl  = discord_avatar_url($did, isset($du['avatar']) ? (string) $du['avatar'] : null);
$displayName = task_display_name($username, $globalName, 'Discord ' . substr($did, -4));
$email      = filter_var((string) ($du['email'] ?? ''), FILTER_VALIDATE_EMAIL) ?: null;
$verified   = !empty($du['verified']) ? 1 : 0;

/* ---------- 5) Compte : création ou mise à jour ---------- */

try {
    $pdo->beginTransaction();

    $find = $pdo->prepare("SELECT user_id FROM tfh_user_identities WHERE provider = 'discord' AND provider_uid = ?");
    $find->execute([$did]);
    $ident = $find->fetch();

    if ($ident !== false) {
        /* Compte existant : rafraîchissement du profil */
        $userId = (int) $ident['user_id'];

        if ($email !== null) {
            $chk = $pdo->prepare('SELECT id FROM tfh_users WHERE email = ? AND id != ?');
            $chk->execute([$email, $userId]);
            if ($chk->fetch() !== false) {
                $email = null;
            }
        }

        $pdo->prepare(
            'UPDATE tfh_users
             SET username = ?, global_name = ?, avatar_url = ?,
                 email = COALESCE(?, email), email_verified = ?, last_login_at = NOW()
             WHERE id = ?'
        )->execute([$username, $globalName, $avatarUrl, $email, $verified, $userId]);
    } else {
        /* Nouveau compte */
        if ($email !== null) {
            $chk = $pdo->prepare('SELECT id FROM tfh_users WHERE email = ?');
            $chk->execute([$email]);
            if ($chk->fetch() !== false) {
                $email = null;
            }
        }

        $pdo->prepare(
            "INSERT INTO tfh_users
             (username, global_name, avatar_url, email, email_verified, role, last_login_at)
             VALUES (?, ?, ?, ?, ?, 'user', NOW())"
        )->execute([$username, $globalName, $avatarUrl, $email, $verified]);
        $userId = (int) $pdo->lastInsertId();

        $pdo->prepare("INSERT INTO tfh_user_identities (user_id, provider, provider_uid) VALUES (?, 'discord', ?)")
            ->execute([$userId, $did]);

        $pdo->prepare('INSERT INTO tfh_public_aliases (user_id, username, public_id) VALUES (?, ?, NULL)')
            ->execute([$userId, $username ?? ('user' . $userId)]);
    }

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('[tfh-task] callback DB: ' . $e->getMessage());
    cb_error('Erreur base de données pendant la connexion.');
}

/* ---------- 6) Contrôle d'accès au panel ---------- */

task_ensure_schema($pdo);

$st = $pdo->prepare('SELECT role FROM tfh_users WHERE id = ? LIMIT 1');
$st->execute([$userId]);
$urow   = $st->fetch();
$siteAdmin = $urow !== false && (string) $urow['role'] === 'admin';

$panelRole = task_whitelist_role($pdo, $did);

$count = (int) $pdo->query('SELECT COUNT(*) FROM tfh_task_admins')->fetchColumn();
if ($count === 0) {
    /* Bootstrap : le premier compte à se connecter devient propriétaire */
    $pdo->prepare('INSERT INTO tfh_task_admins (discord_id, role, added_by, added_at) VALUES (?, ?, ?, NOW())')
        ->execute([$did, 'owner', 'bootstrap']);
    $panelRole = 'owner';
    error_log('[tfh-task] bootstrap owner: ' . $did . ' (' . $displayName . ')');
} elseif ($panelRole === null && !$siteAdmin) {
    task_render_denied([
        'id'     => $did,
        'name'   => $displayName,
        'avatar' => $avatarUrl,
    ]);
    exit;
}

/* ---------- 7) Session + retour au panel ---------- */

create_session($pdo, $userId);
task_redirect('index.php');
