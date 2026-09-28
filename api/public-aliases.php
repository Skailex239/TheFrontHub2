<?php
declare(strict_types=1);

/**
 * GET /api/public-aliases.php
 * Liste publique des alias joueurs (remplace la collection Firestore
 * public-aliases consultee par app.js, runs.js et le dashboard).
 * uid + username + publicId + aliases[] pour la compatibilite frontend.
 *
 * aliases[] contient TOUS les noms connus du joueur :
 *   - game_username : pseudo EN JEU (OpenFront, fetch serveur + cache DB)
 *   - username      : pseudo hub (choisi dans les parametres TheFrontHub)
 * C'est ce qui permet aux leaderboards (qui affichent le pseudo en jeu)
 * de le remplacer par le pseudo hub choisi sur le site.
 */

define('TFH_API', true);
require __DIR__ . '/config.php';
require_once __DIR__ . '/profile-schema.php';
tfh_profile_ensure_schema($pdo);

rate_limit($pdo, 'aliases:' . client_ip(), 60, 60);

/* ── Pseudo en jeu : fetch OpenFront (lazy, cache DB) ─────────────────
 * On complete au maximum 3 lignes par requete : les premieres visites
 * peuplent la colonne progressivement, ensuite tout vient du cache et
 * la requete ne coute que le SELECT. Pas de blocage si l'API OpenFront
 * est indisponible (on renvoie ce qu'on a).                                   */
function of_fetch_game_username(string $publicId): ?string
{
    $url = 'https://api.openfront.io/public/player/' . rawurlencode($publicId);
    if (!function_exists('curl_init')) {
        return null; // pas de cURL : on restera sur le pseudo hub seul
    }
    /* v5.10 : on envoie la clé OpenFront comme le cron (x-skailex-access).
     * Sans elle, ces appels passent dans le quota anonyme strict. */
    global $secrets;
    $headers = ['Accept: application/json'];
    $ofKey = (string) ($secrets['openfront_access'] ?? '');
    if ($ofKey !== '') {
        $headers[] = 'x-skailex-access: ' . $ofKey;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_USERAGENT      => 'TheFrontHub/1.0 (+https://thefronthub.com)',
        CURLOPT_HTTPHEADER     => $headers,
    ]);
    $body = curl_exec($ch);
    $err  = curl_error($ch);
    curl_close($ch);
    if ($body === false || $body === '') {
        if ($err !== '') {
            error_log('[tfh-api] aliases: openfront fetch error: ' . $err);
        }
        return null;
    }
    $j = json_decode((string) $body, true);
    $u = is_array($j) ? ($j['username'] ?? null) : null;
    if (!is_string($u)) {
        return null;
    }
    $u = trim(function_exists('mb_substr') ? mb_substr($u, 0, 64) : substr($u, 0, 64));
    return ($u !== '') ? $u : null;
}

$hasGameCol = true; // la colonne game_username existe-t-elle ? (SQL pas encore passé => false)
try {
    /* v5.13 — jointure tfh_users pour le badge « vérifié » + extras profil
     * (bio, map préférée, liens réseaux). LEFT JOIN : un alias orphelin
     * (compte supprimé) reste listé, simplement non vérifié. */
    $rows = $pdo->query(
        'SELECT pa.user_id, pa.username, pa.public_id, pa.game_username,
                u.bio, u.fav_map, u.link_x, u.link_youtube, u.link_twitch, u.link_discord,
                u.verified_at
         FROM tfh_public_aliases pa
         LEFT JOIN tfh_users u ON u.id = pa.user_id
         ORDER BY pa.updated_at DESC LIMIT 1000'
    )->fetchAll();
} catch (PDOException $e) {
    if ((string) $e->getCode() !== '42S22') { // 42S22 = colonne game_username absente
        throw $e;
    }
    error_log('[tfh-api] public-aliases: colonne game_username absente, fallback sans pseudo en jeu');
    $hasGameCol = false;
    $rows = $pdo->query(
        'SELECT pa.user_id, pa.username, pa.public_id, NULL AS game_username,
                u.bio, u.fav_map, u.link_x, u.link_youtube, u.link_twitch, u.link_discord,
                u.verified_at
         FROM tfh_public_aliases pa
         LEFT JOIN tfh_users u ON u.id = pa.user_id
         ORDER BY pa.updated_at DESC LIMIT 1000'
    )->fetchAll();
}

$toFetch = [];
if ($hasGameCol) {
    foreach ($rows as $r) {
        if (!empty($r['public_id']) && ($r['game_username'] === null || $r['game_username'] === '')) {
            $toFetch[] = $r;
            if (count($toFetch) >= 3) {
                break;
            }
        }
    }
}

/* Le prepare de l'UPDATE est DANS le try : si la colonne manque, on ne
 * casse surtout pas la reponse (degradation = aliases sans pseudo en jeu). */
if ($toFetch) {
    try {
        $stUpd = $pdo->prepare('UPDATE tfh_public_aliases SET game_username = ? WHERE user_id = ?');
        foreach ($toFetch as $r) {
            $game = of_fetch_game_username((string) $r['public_id']);
            if ($game !== null) {
                $stUpd->execute([$game, (int) $r['user_id']]);
                $r['game_username'] = $game; // sert directement pour cette reponse
            }
        }
    } catch (PDOException $e) {
        if ((string) $e->getCode() !== '42S22') {
            error_log('[tfh-api] public-aliases: update game_username: ' . $e->getMessage());
        }
        // non bloquant : on renvoie les rows telles quelles
    }
}

$aliases = array_map(
    static function (array $r): array {
        // aliases = tous les noms connus (en jeu + hub), dédupliqués
        $all = [];
        foreach ([$r['game_username'] ?? null, $r['username']] as $n) {
            if (is_string($n) && $n !== '' && !in_array($n, $all, true)) {
                $all[] = $n;
            }
        }
        /* v5.13 — badge « vérifié » (verified_at posé par la vérification
         * serveur du défi en jeu) + extras profil publics. */
        $isVerified = !empty($r['public_id']) && !empty($r['verified_at']);
        return [
            'uid'      => (string) $r['user_id'],
            'username' => $r['username'],
            'publicId' => $r['public_id'],
            'aliases'  => $all,
            'verified' => $isVerified,
            'bio'      => ($r['bio'] ?? null) !== null ? (string) $r['bio'] : null,
            'favMap'   => ($r['fav_map'] ?? null) !== null ? (string) $r['fav_map'] : null,
            'links'    => [
                'x'       => ($r['link_x'] ?? null) !== null ? (string) $r['link_x'] : null,
                'youtube' => ($r['link_youtube'] ?? null) !== null ? (string) $r['link_youtube'] : null,
                'twitch'  => ($r['link_twitch'] ?? null) !== null ? (string) $r['link_twitch'] : null,
                'discord' => ($r['link_discord'] ?? null) !== null ? (string) $r['link_discord'] : null,
            ],
        ];
    },
    $rows
);

json_out([
    'ok'      => true,
    'v'       => 5, // marqueur debug déploiement (v5.13 : verified + extras profil)
    'aliases' => $aliases,
    'count'   => count($aliases),
]);
