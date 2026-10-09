<?php
declare(strict_types=1);

/**
 * POST /api/profile.php   { action?, username, publicId, openFrontSessions? }
 *
 * Actions :
 *  - (defaut / "save")  : met a jour le pseudo et/ou l'identifiant public du
 *    joueur connecte, puis resynchronise les tables publiques (aliases +
 *    rewards). Comportement historique preserve.
 *  - "verify"           : VERIFICATION SERVEUR du defi de propriete — scanne
 *    les parties recentes du publicId et cherche le code. Seule source de
 *    verite pour le badge « joueur vérifié » (verified_at).
 *  - "link_token"       : LIAISON INSTANTANEE par Identity Token OpenFront —
 *    le joueur génère un token sur openfront.io (Paramètres du compte →
 *    « Lier à un site tiers » → thefronthub.com) et le colle ici. On le
 *    valide auprès de l'API officielle (POST /public/identity_token/validate,
 *    audience = thefronthub.com) : la réponse donne le publicId, le token EST
 *    la preuve de propriété (JWT EdDSA signé par OpenFront, TTL 10 min, aud
 *    verrouillé au site). Liaison du Public ID + badge « vérifié » immédiats.
 *  - "details"          : edition du profil complet (bio, map préférée,
 *    liens réseaux) — débloqué une fois le profil revendiqué.
 *
 * Regles :
 *  - publicId : immuable une fois defini (l'ID OpenFront verifie appartient
 *    au compte pour toujours — meme regle que l'ancien frontend).
 *  - username : modifiable librement.
 *  - openFrontSessions : cache JSON optionnel (equivalent Firestore).
 */

define('TFH_API', true);
require __DIR__ . '/config.php';
require __DIR__ . '/profile-schema.php';
/* v5.36 — invalidation du cache fichier des profils (mutation des données hub) */
require_once __DIR__ . '/profile-cache.php';
/* v5.43 — les tables tfh_g_profile_* vivent dans la base GAMES (isolée sur
 * dev) ; le reste du fichier (auth, comptes hub, rate-limit) reste sur la
 * base site ($pdo). */
require_once __DIR__ . '/games-db.php';
tfh_profile_ensure_schema(tfh_games_pdo('auto') ?? $pdo, $pdo);

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

/* ═══════════════ Vérification serveur du défi de propriété ═══════════════
 * Le code doit apparaître dans le pseudo d'une partie récente jouée avec le
 * publicId revendiqué. Seule la personne qui CONTRÔLE ce compte OpenFront
 * peut le faire apparaître — un appel API forgé ne suffit pas (le scan se
 * fait ici, côté serveur, sur les données officielles OpenFront).
 * Retour : [ok, raison]. */
function tfh_of_games_page(string $publicId, string $cursor = ''): ?array
{
    $url = 'https://api.openfront.io/public/player/' . rawurlencode($publicId) . '/games';
    if ($cursor !== '') {
        $url .= '?cursor=' . rawurlencode($cursor);
    }
    if (!function_exists('curl_init')) {
        return null;
    }
    global $secrets;
    $headers = ['Accept: application/json'];
    $ofKey = (string) ($secrets['openfront_access'] ?? '');
    if ($ofKey !== '') {
        $headers[] = 'x-skailex-access: ' . $ofKey;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_USERAGENT      => 'TheFrontHub/1.0 (+https://thefronthub.com)',
        CURLOPT_HTTPHEADER     => $headers,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    if ($body === false || $body === '') {
        return null;
    }
    $j = json_decode((string) $body, true);
    return is_array($j) ? $j : null;
}

function tfh_server_verify_ownership(string $publicId, string $code): array
{
    $code = strtoupper(trim($code));
    if (!preg_match('/^[A-Z0-9]{4,10}$/', $code)) {
        return [false, 'bad_code'];
    }
    $cursor = '';
    for ($page = 0; $page < 3; $page++) {
        $j = tfh_of_games_page($publicId, $cursor);
        if ($j === null) {
            return $page === 0 ? [false, 'api_unavailable'] : [false, 'code_not_found'];
        }
        $results = is_array($j['results'] ?? null) ? $j['results'] : [];
        foreach ($results as $g) {
            $uname = strtoupper((string) ($g['username'] ?? ''));
            if ($uname !== '' && str_contains($uname, $code)) {
                return [true, ''];
            }
        }
        $next = $j['nextCursor'] ?? $j['next_cursor'] ?? null;
        if (!is_string($next) || $next === '' || !$results) {
            break;
        }
        $cursor = $next;
    }
    return [false, 'code_not_found'];
}

function tfh_own_verify_ok(array $user, string $code): void
{
    $pid = (string) ($user['public_id'] ?? '');
    if ($pid === '') {
        fail(400, 'not_linked', 'Lie d’abord ton Public ID OpenFront.');
    }
    [$ok, $why] = tfh_server_verify_ownership($pid, $code);
    if (!$ok) {
        $msg = match ($why) {
            'api_unavailable' => 'API OpenFront momentanément indisponible — réessaie dans quelques minutes.',
            'bad_code'        => 'Format de code invalide.',
            default           => 'Code non trouvé dans tes parties récentes. Joue une partie avec le code dans ton pseudo, puis revérifie.',
        };
        fail(400, $why === 'api_unavailable' ? 'verify_retry' : 'verify_failed', $msg);
    }
    global $pdo;
    $pdo->prepare('UPDATE tfh_users SET verified_at = NOW(), own_code = NULL, own_code_expires = NULL WHERE id = ?')
        ->execute([(int) $user['id']]);
}

$action = trim((string) ($in['action'] ?? 'save'));

/* ═══════════════ Liaison instantanée par Identity Token OpenFront ══════════
 * Audience enregistrée côté OpenFront (admin-managed) : thefronthub.com.
 * Le joueur choisit ce site dans le menu « Lier à un site tiers » d'OpenFront ;
 * le token généré (JWT EdDSA, TTL 10 min, aud=thefronthub.com) ne prouve
 * rien d'autre que « je contrôle ce publicId » — il ne permet PAS de se
 * connecter à OpenFront et ne fuit aucune donnée d'identité. */
const TFH_IDENTITY_AUDIENCE = 'thefronthub.com';

function tfh_validate_identity_token(string $token): array
{
    if (strlen($token) < 20 || strlen($token) > 4000) {
        return [false, 'bad_token', null];
    }
    if (!function_exists('curl_init')) {
        return [false, 'api_unavailable', null];
    }
    $ch = curl_init('https://api.openfront.io/public/identity_token/validate');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode([
            'token'    => $token,
            'audience' => TFH_IDENTITY_AUDIENCE,
        ]),
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_USERAGENT      => 'TheFrontHub/1.0 (+https://thefronthub.com)',
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $st   = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($st === 200 && is_string($body) && $body !== '') {
        $j   = json_decode($body, true);
        $pid = is_array($j) ? (string) ($j['publicId'] ?? '') : '';
        if (preg_match('/^[A-Za-z0-9_-]{3,64}$/', $pid)) {
            return [true, '', $pid];
        }
        return [false, 'bad_response', null];
    }
    if ($st === 400 || $st === 401 || $st === 403 || $st === 404) {
        return [false, 'token_invalid', null];
    }
    return [false, 'api_unavailable', null];
}

/* ═══════════════ Action : link_token (liaison + badge instantanés) ═════════ */
if ($action === 'link_token') {
    rate_limit($pdo, 'linktok:' . (int) $user['id'] . ':' . client_ip(), 12, 3600);

    $token = trim((string) ($in['token'] ?? ''));
    if ($token === '') {
        fail(400, 'token_missing', 'Colle le token généré sur OpenFront (Paramètres du compte → Lier à un site tiers).');
    }

    [$tokOk, $why, $tokenPid] = tfh_validate_identity_token($token);
    if (!$tokOk) {
        $msg = match ($why) {
            'token_invalid'   => 'Token invalide, expiré (valable 10 min) ou généré pour un autre site. Sur openfront.io : Paramètres du compte → Lier à un site tiers → thefronthub.com → Générer, puis colle le nouveau token.',
            'bad_token'       => 'Format de token invalide.',
            'bad_response'    => 'Réponse inattendue de l’API OpenFront — réessaie dans un instant.',
            default           => 'API OpenFront momentanément indisponible — réessaie dans quelques minutes.',
        };
        fail(400, $why === 'api_unavailable' ? 'link_retry' : ($why === 'token_invalid' ? 'token_invalid' : 'link_failed'), $msg);
    }

    /* publicId immuable : un compte déjà lié doit prouver le MÊME compte. */
    $existingPid = (string) ($user['public_id'] ?? '');
    if ($existingPid !== '' && $tokenPid !== $existingPid) {
        fail(409, 'public_id_locked', 'Ton compte est déjà lié au Public ID ' . $existingPid . ' — il est immuable.');
    }
    /* Un publicId ne peut être lié qu'à un seul compte (contrôles serveur). */
    $st = $pdo->prepare('SELECT id FROM tfh_users WHERE public_id = ? AND id <> ? LIMIT 1');
    $st->execute([$tokenPid, $user['id']]);
    if ($st->fetch()) {
        fail(409, 'public_id_taken', 'Ce Public ID est deja lie a un autre compte.');
    }
    $st = $pdo->prepare('SELECT user_id FROM tfh_public_aliases WHERE public_id = ? AND user_id <> ? LIMIT 1');
    $st->execute([$tokenPid, $user['id']]);
    if ($st->fetch()) {
        fail(409, 'public_id_taken', 'Ce Public ID est deja lie a un autre compte.');
    }

    $username = (string) ($user['username'] ?? ('user' . $user['id']));
    try {
        $pdo->beginTransaction();
        /* Le token EST la preuve de propriété : liaison + verified_at d'un coup. */
        $pdo->prepare('UPDATE tfh_users SET public_id = ?, verified_at = NOW(), own_code = NULL, own_code_expires = NULL WHERE id = ?')
            ->execute([$tokenPid, $user['id']]);
        try {
            $pdo->prepare(
                'INSERT INTO tfh_public_aliases (user_id, username, public_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE public_id = VALUES(public_id),
                   game_username = IF(public_id <> VALUES(public_id), NULL, game_username)'
            )->execute([$user['id'], $username, $tokenPid]);
        } catch (PDOException $e) {
            if ((string) $e->getCode() !== '42S22') { // colonne game_username absente (SQL pas encore passé)
                throw $e;
            }
            $pdo->prepare(
                'INSERT INTO tfh_public_aliases (user_id, username, public_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE public_id = VALUES(public_id)'
            )->execute([$user['id'], $username, $tokenPid]);
        }
        $pdo->prepare(
            'INSERT INTO tfh_public_rewards (public_id, user_id, username, activated)
             VALUES (?, ?, ?, 0)
             ON DUPLICATE KEY UPDATE username = VALUES(username), user_id = VALUES(user_id)'
        )->execute([$tokenPid, $user['id'], $username]);
        $pdo->commit();
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        if ((int) $e->getCode() === 23000) {
            fail(409, 'already_taken', 'Ce pseudo ou cet identifiant public est deja utilise.');
        }
        error_log('[tfh-api] profile link_token: ' . $e->getMessage());
        fail(500, 'db_error', 'Erreur inattendue, reessaie.');
    }

    tfh_profile_cache_invalidate((string) $tokenPid);
    $st = $pdo->prepare('SELECT UNIX_TIMESTAMP(verified_at) AS v FROM tfh_users WHERE id = ?');
    $st->execute([(int) $user['id']]);
    $vts = $st->fetchColumn();

    json_out([
        'ok'          => true,
        'linked'      => true,
        'publicId'    => $tokenPid,
        'verified'    => $vts !== false && $vts !== null,
        'verifiedNow' => true,
        'verifiedAt'  => $vts !== false && $vts !== null ? (int) $vts : null,
    ]);
}

/* ═══════════════ Action : verify (badge « vérifié » serveur) ═══════════════ */
if ($action === 'verify') {
    rate_limit($pdo, 'verify:' . (int) $user['id'] . ':' . client_ip(), 12, 3600);
    $code = (string) ($in['code'] ?? '');
    tfh_own_verify_ok($user, $code);
    tfh_profile_cache_invalidate((string) ($user['public_id'] ?? ''));
    $st = $pdo->prepare('SELECT UNIX_TIMESTAMP(verified_at) AS v FROM tfh_users WHERE id = ?');
    $st->execute([(int) $user['id']]);
    $vts = $st->fetchColumn();
    json_out([
        'ok'         => true,
        'verified'   => true,
        'verifiedAt' => $vts !== false && $vts !== null ? (int) $vts : null,
    ]);
}

/* ═══════════════ Action : details (bio / map préférée / liens) ═══════════ */
if ($action === 'details') {
    rate_limit($pdo, 'details:' . (int) $user['id'] . ':' . client_ip(), 20, 600);

    $pid = (string) ($user['public_id'] ?? '');
    if ($pid === '') {
        fail(403, 'not_claimed', 'Revendique d’abord ton profil (Public ID + vérification en jeu) pour débloquer l’édition.');
    }

    $clean = static function ($v, int $max): ?string {
        $v = trim(strip_tags((string) ($v ?? '')));
        if ($v === '') return null;
        return function_exists('mb_substr') ? mb_substr($v, 0, $max, 'UTF-8') : substr($v, 0, $max);
    };

    $bio = isset($in['bio']) ? $clean($in['bio'], 400) : null;
    $favMap = isset($in['favMap']) ? $clean($in['favMap'], 64) : null;
    $linksIn = is_array($in['links'] ?? null) ? $in['links'] : [];
    $lx = isset($linksIn['x']) ? $clean($linksIn['x'], 150) : null;
    $ly = isset($linksIn['youtube']) ? $clean($linksIn['youtube'], 150) : null;
    $lt = isset($linksIn['twitch']) ? $clean($linksIn['twitch'], 150) : null;
    $ld = isset($linksIn['discord']) ? $clean($linksIn['discord'], 150) : null;

    /* Validation légère des liens : pas de script, schémas connus ou handles. */
    foreach ([&$lx, &$ly, &$lt, &$ld] as &$lv) {
        if ($lv !== null && preg_match('#(javascript:|data:|<|>)#i', $lv)) {
            fail(400, 'invalid_link', 'Lien invalide.');
        }
    }
    unset($lv);

    /* Champs absents de la requête = "ne pas changer" (édition partielle). */
    $sets = [];
    $args = [];
    if (array_key_exists('bio', $in))        { $sets[] = 'bio = ?';          $args[] = $bio; }
    if (array_key_exists('favMap', $in))     { $sets[] = 'fav_map = ?';      $args[] = $favMap; }
    if (array_key_exists('x', $linksIn))       { $sets[] = 'link_x = ?';       $args[] = $lx; }
    if (array_key_exists('youtube', $linksIn)) { $sets[] = 'link_youtube = ?'; $args[] = $ly; }
    if (array_key_exists('twitch', $linksIn))  { $sets[] = 'link_twitch = ?';  $args[] = $lt; }
    if (array_key_exists('discord', $linksIn)) { $sets[] = 'link_discord = ?'; $args[] = $ld; }
    if ($sets) {
        $args[] = (int) $user['id'];
        $pdo->prepare('UPDATE tfh_users SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
    }

    tfh_profile_cache_invalidate((string) ($user['public_id'] ?? ''));
    $st = $pdo->prepare('SELECT bio, fav_map, link_x, link_youtube, link_twitch, link_discord FROM tfh_users WHERE id = ?');
    $st->execute([(int) $user['id']]);
    $row = $st->fetch();
    json_out([
        'ok'   => true,
        'profile' => [
            'bio'    => $row['bio'] ?? null,
            'favMap' => $row['fav_map'] ?? null,
            'links'  => [
                'x'       => $row['link_x'] ?? null,
                'youtube' => $row['link_youtube'] ?? null,
                'twitch'  => $row['link_twitch'] ?? null,
                'discord' => $row['link_discord'] ?? null,
            ],
        ],
    ]);
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
            if ((string) $e->getCode() !== '42S22') { // 42S22 = colonne game_username absente (SQL pas encore passe)
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

/* ── Vérification serveur optionnelle au moment de la liaison ──
 * Le frontend passe le code du défi (verifyCode) : on tente la vérification
 * serveur immédiatement (badge « vérifié » sans second aller-retour).
 * Non bloquant : si l'API OpenFront rame, le joueur réessaie via action=verify. */
$verifiedNow = false;
$verifyCode = trim((string) ($in['verifyCode'] ?? ''));
if ($verifyCode !== '' && $publicId !== null && $publicId !== '') {
    [$vOk] = tfh_server_verify_ownership((string) $publicId, $verifyCode);
    if ($vOk) {
        $pdo->prepare('UPDATE tfh_users SET verified_at = NOW(), own_code = NULL, own_code_expires = NULL WHERE id = ?')
            ->execute([(int) $user['id']]);
        $verifiedNow = true;
    }
}

tfh_profile_cache_invalidate((string) ($publicId ?? ''));
$stV = $pdo->prepare('SELECT UNIX_TIMESTAMP(verified_at) FROM tfh_users WHERE id = ?');
$stV->execute([(int) $user['id']]);
$verifiedAtTs = $stV->fetchColumn();

json_out([
    'ok'   => true,
    'user' => [
        'publicId' => $publicId,
        'username' => $username,
    ],
    'verified'   => $verifiedAtTs !== false && $verifiedAtTs !== null,
    'verifiedAt' => $verifiedAtTs !== false && $verifiedAtTs !== null ? (int) $verifiedAtTs : null,
    'verifiedNow' => $verifiedNow,
]);
