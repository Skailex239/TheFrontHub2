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

rate_limit($pdo, 'aliases:' . client_ip(), 60, 60);

/* ── Pseudo en jeu : fetch OpenFront (lazy, cache DB) ─────────────────
 * On complete au maximum 3 lignes par requete : les premieres visites
 * peuplent la colonne progressivement, ensuite tout vient du cache et
 * la requete ne coute que le SELECT. Pas de blocage si l'API OpenFront
 * est indisponible (on renvoie ce qu'on a).                                   */
function of_fetch_game_username(string $publicId): ?string
{
    $url = 'https://api.openfront.io/public/player/' . rawurlencode($publicId);
    $ctx = stream_context_create([
        'http' => [
            'method'  => 'GET',
            'timeout' => 4,
            'header'  => "Accept: application/json\r\nUser-Agent: TheFrontHub/1.0\r\n",
            'ignore_errors' => true,
        ],
    ]);
    $raw = @file_get_contents($url, false, $ctx);
    if ($raw === false || $raw === '') {
        return null;
    }
    $j = json_decode($raw, true);
    $u = is_array($j) ? ($j['username'] ?? null) : null;
    if (!is_string($u)) {
        return null;
    }
    $u = trim(mb_substr($u, 0, 64));
    return ($u !== '') ? $u : null;
}

try {
    $rows = $pdo->query(
        'SELECT user_id, username, public_id, game_username FROM tfh_public_aliases ORDER BY updated_at DESC LIMIT 1000'
    )->fetchAll();
} catch (PDOException $e) {
    if ((int) $e->getCode() !== 42S22) { // 42S22 = colonne game_username absente (SQL pas encore passe)
        throw $e;
    }
    error_log('[tfh-api] public-aliases: colonne game_username absente, fallback sans pseudo en jeu');
    $rows = $pdo->query(
        'SELECT user_id, username, public_id, NULL AS game_username FROM tfh_public_aliases ORDER BY updated_at DESC LIMIT 1000'
    )->fetchAll();
}

$toFetch = [];
foreach ($rows as $r) {
    if (!empty($r['public_id']) && ($r['game_username'] === null || $r['game_username'] === '')) {
        $toFetch[] = $r;
        if (count($toFetch) >= 3) {
            break;
        }
    }
}

$stUpd = $pdo->prepare('UPDATE tfh_public_aliases SET game_username = ? WHERE user_id = ?');
foreach ($toFetch as $r) {
    $game = of_fetch_game_username((string) $r['public_id']);
    if ($game !== null) {
        $stUpd->execute([$game, (int) $r['user_id']]);
        $r['game_username'] = $game; // sert directement pour cette reponse
    }
}

$aliases = array_map(
    static function (array $r): array {
        // aliases = tous les noms connus (en jeu + hub), dedupliques
        $all = [];
        foreach ([$r['game_username'] ?? null, $r['username']] as $n) {
            if (is_string($n) && $n !== '' && !in_array($n, $all, true)) {
                $all[] = $n;
            }
        }
        return [
            'uid'      => (string) $r['user_id'],
            'username' => $r['username'],
            'publicId' => $r['public_id'],
            'aliases'  => $all,
        ];
    },
    $rows
);

json_out([
    'ok'      => true,
    'aliases' => $aliases,
    'count'   => count($aliases),
]);
