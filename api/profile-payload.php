<?php
declare(strict_types=1);

/**
 * api/profile-payload.php — Construction du payload « pré-profil » (v5.36).
 *
 * Corps de la route /api/games-api.php?route=profile EXTRAIT tel quel pour
 * être partagé par DEUX contextes :
 *   1. games-api.php (service en direct) → calcule le payload à la demande ;
 *   2. profile-warm.php (cron o2switch)  → PRÉ-GÉNÈRE les payloads des
 *      joueurs pertinents dans profile-cache/ → visites servies en fichier.
 * Zéro divergence : le même code construit le payload servi et le payload
 * pré-calculé.
 *
 * Dépendances :
 *   - TOUJOURS   : config.php ($pdo, $secrets), profile-schema.php
 *                  (tfh_profile_extras), profile-cache.php, of-patterns.php
 *                  (tfh_patterns_map) ;
 *   - via games-api.php : gout/gfail/ts_ms/game_row/GAMES_SELECT ;
 *   - via profile-warm.php : ce fichier fournit lui-même des copies
 *     conditionnelles (function_exists / defined) de ts_ms, game_row et
 *     GAMES_SELECT — VERBATIM de games-api.php — pour fonctionner hors du
 *     routeur (les gardes évitent toute redéfinition quand games-api.php
 *     est déjà chargé). Le payload ne lève jamais d'erreur fatale : joueur
 *     absent → exception TfhProfileNotFound (attrapée par chaque appelant).
 */

require_once __DIR__ . '/profile-cache.php';
require_once __DIR__ . '/of-patterns.php';

/* ── Copies conditionnelles (contexte profile-warm.php uniquement) ──────── */

if (!function_exists('ts_ms')) {
    /** epoch DATETIME(3) → millisecondes (entier). Miroir de games-api.php. */
    function ts_ms(array $row, string $field): ?int {
        if (!isset($row[$field]) || $row[$field] === null) return null;
        $v = (float)$row[$field];
        return (int)round($v * 1000);
    }
}

if (!defined('GAMES_SELECT')) {
    define('GAMES_SELECT', 'SELECT g.*, UNIX_TIMESTAMP(g.started_at) AS started_ts, u.username AS winner_username
        FROM tfh_g_games g LEFT JOIN tfh_g_usernames u ON u.id = g.winner_username_id');
}

if (!function_exists('game_row')) {
    /** Projection standard d'une ligne tfh_g_games. Miroir de games-api.php. */
    function game_row(array $r): array {
        $sr = null;
        if (!empty($r['speedrun_category'])) {
            $sr = ['category' => (string)$r['speedrun_category'], 'durationS' => $r['speedrun_duration_s'] !== null ? (int)$r['speedrun_duration_s'] : null];
        }
        return [
            'id'         => (string)$r['game_id'],
            'startedAt'  => ts_ms($r, 'started_ts'),
            'durationS'  => $r['duration_s'] !== null ? (int)$r['duration_s'] : null,
            'type'       => $r['game_type'] !== null ? (string)$r['game_type'] : null,
            'mode'       => $r['game_mode'] !== null ? (string)$r['game_mode'] : null,
            'rankedType' => $r['ranked_type'] !== null ? (string)$r['ranked_type'] : null,
            'playerTeams'=> $r['player_teams'] !== null ? (string)$r['player_teams'] : null,
            'map'        => $r['game_map'] !== null ? (string)$r['game_map'] : null,
            'mapSize'    => $r['map_size'] !== null ? (string)$r['map_size'] : null,
            'difficulty' => $r['difficulty'] !== null ? (string)$r['difficulty'] : null,
            'version'    => isset($r['version']) && (string)$r['version'] !== '' && (string)$r['version'] !== 'v0.0.2'
                ? (string)$r['version'] : null,
            'numPlayers' => $r['num_players'] !== null ? (int)$r['num_players'] : null,
            'speedrun'   => $sr,
            'winner'     => $r['winner_public_id'] !== null || $r['winner_username'] !== null ? [
                'publicId' => $r['winner_public_id'] !== null ? (string)$r['winner_public_id'] : null,
                'username' => $r['winner_username'] !== null ? (string)$r['winner_username'] : null,
            ] : null,
        ];
    }
}

/** Joueur absent de la DB locale (pas encore archivé / id inconnu). */
class TfhProfileNotFound extends Exception {}

/**
 * Construit le payload complet route=profile d'un joueur.
 *
 * @param PDO  $pdo                  connexion MySQL GAMES (tables tfh_g_* —
 *                                   v5.43 : base isolée sur dev via games-db.php)
 * @param string $pid                 publicId validé [A-Za-z0-9]{6,16} (par l'appelant)
 * @param int  $limit                 nb de dernières parties embarquées (borné 1..100)
 * @param bool $allowOfficialRefresh  autoriser le fetch on-demand du profil
 *                                    officiel OpenFront (route &refresh=1 ;
 *                                    le warm passe false — games-sync rafraîchit)
 * @param PDO|null $sitePdo           connexion SITE (vitrine hub : skins,
 *                                   bannières, VIP). Null = même base (prod
 *                                   fallback / avant séparation v5.43).
 * @throws TfhProfileNotFound         joueur absent de tfh_g_players
 */
function tfh_profile_payload(PDO $pdo, string $pid, int $limit, bool $allowOfficialRefresh, ?PDO $sitePdo = null): array
{
    global $V5_READY, $V511_READY, $secrets;
    $siteDb = $sitePdo ?? $pdo;

    /* Drapeaux v5/v5.11 : définis par games-api.php en contexte route ;
     * détectés à la volée en contexte warm (les mêmes try/query que là-bas). */
    if (!isset($V5_READY)) {
        try { $pdo->query('SELECT 1 FROM tfh_g_ratings LIMIT 1'); $V5_READY = true; } catch (Throwable $e) { $V5_READY = false; }
    }
    if (!isset($V511_READY)) {
        try { $pdo->query('SELECT 1 FROM tfh_g_ladder LIMIT 1'); $V511_READY = true; } catch (Throwable $e) { $V511_READY = false; }
    }

    $limit = max(1, min(100, $limit));

    $st = $pdo->prepare('SELECT *, UNIX_TIMESTAMP(last_seen) AS last_seen_ts, UNIX_TIMESTAMP(first_seen) AS first_seen_ts FROM tfh_g_players WHERE public_id = ?');
    $st->execute([$pid]);
    $p = $st->fetch();
    if ($p === false) throw new TfhProfileNotFound($pid);

    // Alias (pseudos connus, du plus utilisé au moins utilisé)
    $al = $pdo->prepare('SELECT u.username, a.times_used, UNIX_TIMESTAMP(a.last_seen) AS last_seen_ts
        FROM tfh_g_aliases a JOIN tfh_g_usernames u ON u.id = a.username_id
        WHERE a.public_id = ? ORDER BY a.times_used DESC LIMIT 25');
    $al->execute([$pid]);
    $aliases = [];
    foreach ($al->fetchAll() as $a) {
        $aliases[] = ['username' => (string)$a['username'], 'timesUsed' => (int)$a['times_used'], 'lastSeen' => (int)$a['last_seen_ts']];
    }

    // Stats par mode / ranked
    $bm = $pdo->prepare("SELECT g.game_mode, g.ranked_type, COUNT(*) AS games, SUM(r.won) AS wins
        FROM tfh_g_roster r JOIN tfh_g_games g ON g.game_id = r.game_id
        WHERE r.public_id = ? GROUP BY g.game_mode, g.ranked_type");
    $bm->execute([$pid]);
    $byMode = [];
    foreach ($bm->fetchAll() as $m) {
        $byMode[] = [
            'mode' => $m['game_mode'], 'rankedType' => $m['ranked_type'],
            'games' => (int)$m['games'], 'wins' => (int)$m['wins'],
            'winRate' => (int)$m['games'] > 0 ? round((int)$m['wins'] / (int)$m['games'], 4) : null,
        ];
    }

    // Top cartes
    $bmp = $pdo->prepare('SELECT g.game_map, COUNT(*) AS games, SUM(r.won) AS wins
        FROM tfh_g_roster r JOIN tfh_g_games g ON g.game_id = r.game_id
        WHERE r.public_id = ? AND g.game_map IS NOT NULL
        GROUP BY g.game_map ORDER BY games DESC LIMIT 10');
    $bmp->execute([$pid]);
    $byMap = [];
    foreach ($bmp->fetchAll() as $m) {
        $byMap[] = ['map' => (string)$m['game_map'], 'games' => (int)$m['games'], 'wins' => (int)$m['wins']];
    }

    // Dernières parties (avec résultat personnel + roster complet en option)
    $rg = $pdo->prepare(GAMES_SELECT . ' JOIN tfh_g_roster r ON r.game_id = g.game_id AND r.public_id = ?
        ORDER BY g.started_at DESC LIMIT ?');
    $rg->bindValue(1, $pid);
    $rg->bindValue(2, $limit, PDO::PARAM_INT);
    $rg->execute();
    $recentGames = [];
    foreach ($rg->fetchAll() as $r) {
        $g = game_row($r);
        unset($g['winner']);
        $g['won'] = (bool)$r['won'];
        $g['clientId'] = (string)$r['client_id'];
        $recentGames[] = $g;
    }

    // Meilleurs speedruns du joueur (par catégorie)
    $bs = $pdo->prepare("SELECT g.game_id, g.speedrun_category, g.speedrun_duration_s, g.game_map,
            UNIX_TIMESTAMP(g.started_at) AS started_ts
        FROM tfh_g_roster r JOIN tfh_g_games g ON g.game_id = r.game_id
        WHERE r.public_id = ? AND g.speedrun_category IS NOT NULL AND r.won = 1
        ORDER BY g.speedrun_duration_s ASC LIMIT 20");
    $bs->execute([$pid]);
    $bestSpeedruns = [];
    foreach ($bs->fetchAll() as $s) {
        $bestSpeedruns[] = [
            'id' => (string)$s['game_id'], 'category' => (string)$s['speedrun_category'],
            'durationS' => (int)$s['speedrun_duration_s'], 'map' => (string)$s['game_map'],
            'startedAt' => (int)$s['started_ts'],
        ];
    }

    // v5 : ratings Glicko-2, cosmétiques portés, clans (graceful si tables absentes)
    $ratings = []; $cosmetics = []; $clans = [];
    /* v5.14 — Vitrine site (défaut vide ; remplie plus bas si v5 + tables là) */
    $hubCos = [
        'activeSkinId' => null, 'ownedSkins' => [],
        'activeBannerId' => null, 'ownedBanners' => [],
        'vipType' => null, 'vipActive' => false,
    ];
    if ($V5_READY) {
    $rt2 = $pdo->prepare('SELECT board, rating, rd, games, wins, peak, peak_at
        FROM tfh_g_ratings WHERE public_id = ? ORDER BY rating DESC');
    $rt2->execute([$pid]);
    foreach ($rt2->fetchAll() as $x) {
        $ratings[] = [
            'board' => (string)$x['board'], 'rating' => round((float)$x['rating'], 1),
            'rd' => round((float)$x['rd'], 1), 'games' => (int)$x['games'], 'wins' => (int)$x['wins'],
            'peak' => round((float)$x['peak'], 1),
            'peakAt' => $x['peak_at'] !== null ? (int)strtotime((string)$x['peak_at']) : null,
        ];
    }

    // v5 : cosmétiques portés (reliés au catalogue)
    $cw = $pdo->prepare('SELECT w.category, w.name, w.times_worn, w.first_worn, w.last_worn,
            c.rarity, c.price_hard, c.url, c.display_name
        FROM tfh_g_cosmetic_wearers w LEFT JOIN tfh_g_cosmetics c ON c.category = w.category AND c.name = w.name
        WHERE w.public_id = ? ORDER BY w.times_worn DESC LIMIT 60');
    $cw->execute([$pid]);
    /* v5.15 : bitmaps des motifs (une seule lecture du cache catalogue pour la
     * boucle — jamais d'appel réseau par cosmétique). */
    $patternsMap = [];
    foreach ($cw->fetchAll() as $x) {
        $item = [
            'category' => (string)$x['category'], 'name' => (string)$x['name'],
            'displayName' => $x['display_name'] !== null ? (string)$x['display_name'] : null,
            'timesWorn' => (int)$x['times_worn'],
            'firstWorn' => (int)strtotime((string)$x['first_worn']),
            'lastWorn' => (int)strtotime((string)$x['last_worn']),
            'rarity' => $x['rarity'] !== null ? (string)$x['rarity'] : null,
            'priceHard' => $x['price_hard'] !== null ? (int)$x['price_hard'] : null,
            'url' => $x['url'] !== null ? (string)$x['url'] : null,
        ];
        if ($item['category'] === 'pattern') {
            if ($patternsMap === []) { $patternsMap = tfh_patterns_map(); }
            $item['patternData'] = $patternsMap[$item['name']] ?? null;
        }
        $cosmetics[] = $item;
    }

    /* v5.14 — Vitrine cosmétiques TheFrontHub : skins/bannières possédés et
     * actifs + statut VIP. Tables du SITE (même BDD) — défensif : une table
     * absente (SQL pas encore passé) ne doit jamais casser la route. */
    $hubCos = [
        'activeSkinId' => null, 'ownedSkins' => [],
        'activeBannerId' => null, 'ownedBanners' => [],
        'vipType' => null, 'vipActive' => false,
    ];
    try {
        $hs = $siteDb->prepare('SELECT skin_id, active FROM tfh_user_skins WHERE public_id = ? ORDER BY redeemed_at DESC LIMIT 100');
        $hs->execute([$pid]);
        foreach ($hs->fetchAll() as $r) {
            $hubCos['ownedSkins'][] = ['skinId' => (string)$r['skin_id'], 'active' => (bool)$r['active']];
            if ((bool)$r['active']) $hubCos['activeSkinId'] = (string)$r['skin_id'];
        }
    } catch (Throwable $e) { /* table absente — vitrine site vide */ }
    try {
        $hb = $siteDb->prepare('SELECT banner_id, active FROM tfh_user_banners WHERE public_id = ? ORDER BY redeemed_at DESC LIMIT 100');
        $hb->execute([$pid]);
        foreach ($hb->fetchAll() as $r) {
            $hubCos['ownedBanners'][] = ['bannerId' => (string)$r['banner_id'], 'active' => (bool)$r['active']];
            if ((bool)$r['active']) $hubCos['activeBannerId'] = (string)$r['banner_id'];
        }
    } catch (Throwable $e) { /* table absente — vitrine site vide */ }
    try {
        $hv = $siteDb->prepare('SELECT active_type, activated FROM tfh_public_rewards WHERE public_id = ? ORDER BY updated_at DESC LIMIT 1');
        $hv->execute([$pid]);
        $vrow = $hv->fetch();
        if ($vrow) {
            $hubCos['vipType'] = $vrow['active_type'] !== null ? (string)$vrow['active_type'] : null;
            $hubCos['vipActive'] = (bool)$vrow['activated'];
        }
    } catch (Throwable $e) { /* table absente — pas de VIP */ }

    // v5 : clans portés
    $ct = $pdo->prepare('SELECT r.clan_tag, COUNT(*) AS games, SUM(r.won) AS wins
        FROM tfh_g_roster r WHERE r.public_id = ? AND r.clan_tag IS NOT NULL
        GROUP BY r.clan_tag ORDER BY games DESC LIMIT 10');
    $ct->execute([$pid]);
    foreach ($ct->fetchAll() as $x) {
        $clans[] = ['tag' => (string)$x['clan_tag'], 'games' => (int)$x['games'], 'wins' => (int)$x['wins']];
    }
    }

    /* v5.11 : profil OFFICIEL /public/player/:id — username du compte, date de
     * création et arbre de stats complet (type→mode→difficulté, incluant
     * Private/Singleplayer, que nos rosters ne captent pas).
     * &refresh=1 : fetch on-demand (1 requête max/appel, cooldown 10 min). */
    $official = null;
    if ($V511_READY) {
        $sp = $pdo->prepare('SELECT username, created_at, fetched_at, not_found, stats_json FROM tfh_g_profiles WHERE public_id = ?');
        $sp->execute([$pid]);
        $pr = $sp->fetch();
        if ($pr !== false && (int)$pr['not_found'] === 0) {
            $official = [
                'username'  => $pr['username'] !== null ? (string)$pr['username'] : null,
                'createdAt' => $pr['created_at'] !== null ? (int)strtotime((string)$pr['created_at']) : null,
                'fetchedAt' => (int)strtotime((string)$pr['fetched_at']),
            ];
            $sj = $pr['stats_json'] !== null ? json_decode((string)$pr['stats_json'], true) : null;
            if (is_array($sj)) $official['stats'] = $sj;
        }
        $stale = $pr === false
            || ((int)$pr['not_found'] === 0 && (time() - (int)strtotime((string)$pr['fetched_at'])) > 600);
        if ($allowOfficialRefresh && $stale) {
            $ofKey = (string)($secrets['openfront_access'] ?? '');
            $ch = curl_init('https://api.openfront.io/public/player/' . rawurlencode($pid));
            $hdrs = ['Accept: application/json'];
            if ($ofKey !== '') $hdrs[] = 'x-skailex-access: ' . $ofKey;
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_TIMEOUT        => 12,
                CURLOPT_HTTPHEADER     => $hdrs,
                CURLOPT_ENCODING       => '',
            ]);
            $body = curl_exec($ch);
            $stt  = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            curl_close($ch);
            $now2 = gmdate('Y-m-d H:i:s');
            if ($stt === 404) {
                $up = $pdo->prepare('INSERT INTO tfh_g_profiles (public_id, username, created_at, fetched_at, not_found)
                    VALUES (?, NULL, NULL, ?, 1)
                    ON DUPLICATE KEY UPDATE fetched_at = VALUES(fetched_at), not_found = 1');
                $up->execute([$pid, $now2]);
            } elseif ($stt === 200 && is_string($body)) {
                $d = json_decode($body, true);
                if (is_array($d)) {
                    $createdAt = null;
                    if (!empty($d['createdAt']) && ($tc = strtotime((string)$d['createdAt'])) !== false) $createdAt = gmdate('Y-m-d H:i:s', $tc);
                    $statsJson = isset($d['stats']) && is_array($d['stats'])
                        ? json_encode($d['stats'], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) : null;
                    $up = $pdo->prepare('INSERT INTO tfh_g_profiles (public_id, username, created_at, fetched_at, not_found, stats_json)
                        VALUES (?,?,?,?,0,?)
                        ON DUPLICATE KEY UPDATE username = VALUES(username), created_at = VALUES(created_at),
                            fetched_at = VALUES(fetched_at), not_found = 0, stats_json = VALUES(stats_json)');
                    $up->execute([
                        $pid,
                        isset($d['username']) && is_string($d['username']) ? mb_substr($d['username'], 0, 64) : null,
                        $createdAt, $now2, $statsJson,
                    ]);
                    $official = [
                        'username'  => isset($d['username']) && is_string($d['username']) ? (string)$d['username'] : null,
                        'createdAt' => $createdAt !== null ? (int)strtotime($createdAt) : null,
                        'fetchedAt' => (int)strtotime($now2),
                    ];
                    if (isset($d['stats']) && is_array($d['stats'])) $official['stats'] = $d['stats'];
                }
            }
        }
    }

    /* v5.13 — Profil revendiqué : badge vérifié + bio / map préférée / liens.
     * La « map préférée » affichée = choix du joueur s'il en a défini un,
     * sinon sa carte la plus jouée (données du site, byMap[0]). */
    $extras = tfh_profile_extras($pdo, $pid);
    $topMapName = ($byMap[0]['map'] ?? null);
    $favMapShown = $extras['favMap'] ?? null;
    if ($favMapShown === null && $topMapName !== null) {
        $favMapShown = $topMapName; // fallback calculé (non éditable)
    }

    return [
        'ok' => true,
        'player' => [
            'publicId'    => (string)$p['public_id'],
            'lastUsername'=> $p['last_username'],
            'lastClanTag' => ($p['last_clan_tag'] ?? null) !== null ? (string)$p['last_clan_tag'] : null,
            'firstSeen'   => ts_ms($p, 'first_seen_ts'),
            'lastSeen'    => ts_ms($p, 'last_seen_ts'),
            'gamesCount'  => (int)$p['games_count'],
            'winsCount'   => (int)$p['wins_count'],
            'deletedAt'   => $p['deleted_at'],
        ],
        'verified' => $extras['verified'] ?? false,
        'profile' => $extras !== null ? [
            'bio'        => $extras['bio'],
            'favMap'     => $favMapShown,
            'favMapUserSet' => $extras['favMap'] !== null,
            'links'      => $extras['links'],
            'alias'      => $extras['alias'],
            'verifiedAt' => $extras['verifiedAt'],
        ] : [
            'bio' => null, 'favMap' => $favMapShown, 'favMapUserSet' => false,
            'links' => ['x' => null, 'youtube' => null, 'twitch' => null, 'discord' => null],
            'alias' => null, 'verifiedAt' => null,
        ],
        'aliases' => $aliases,
        'ratings' => $ratings,
        'cosmetics' => $cosmetics,
        'hubCosmetics' => $hubCos,
        'clans' => $clans,
        'official' => $official,
        'stats' => [
            'byMode' => $byMode,
            'byMap' => $byMap,
            'bestSpeedruns' => $bestSpeedruns,
            'recentGames' => $recentGames,
        ],
    ];
}
