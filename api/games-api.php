<?php
declare(strict_types=1);

/**
 * api/games-api.php — API JSON publique "parties & pré-profils" TheFrontHub.
 *
 * Lecture seule sur les tables tfh_g_* (remplies par api/games-sync.php).
 * Endpoints (GET, ?route=…) :
 *
 *   route=recent    &limit=30&offset=0        → dernières parties publiques
 *   route=game      &id=XXXXXXXXXX            → détail d'une partie + roster lié
 *   route=speedruns &category=normal|compact  → records speedrun (sort=duration|date)
 *                   &map=Italy&window=30d&limit=50&offset=0
 *   route=profile   &publicId=XXXXXXXX        → pré-profil complet d'un joueur
 *   route=search    &q= skailex &limit=10     → recherche joueurs (tous alias)
 *   route=maps      &category=normal          → cartes avec compteur de runs
 *   route=status                              → état de la base (admin/widgets)
 *
 *   v5 — nouvelles routes :
 *   route=leaderboard &board=ffa|team|ranked   → classement Glicko-2 (minGames)
 *   route=clans      &window=all|week|Nd       → ladder des clans (participations/wins/membres)
 *   route=clan       &tag=UN                   → détail d'un clan (membres, parties récentes)
 *   route=cosmetics  &category=&sort=wearers|price|name → catalogue cosmétiques + porteurs
 *   route=cosmetic   &name=&category=          → détail d'un cosmétique (top porteurs)
 *   route=replay     &id=                      → replay JSON complet (turn-by-turn, gz en base)
 *   + route=game enrichie (cosmétiques/clan/config/hasReplay), profile enrichie
 *     (ratings, cosmétiques portés, clans), search multi (joueurs+clans+games),
 *     maps &scope=all.
 *
 * Réponses : { ok:true, … } en JSON, cache 60 s. Erreurs : { ok:false, error }.
 */

define('TFH_API', 1);
require __DIR__ . '/config.php';

/* v5 : les nouvelles tables (ratings, cosmétiques, replay, clans) sont créées
 * par le prochain tick de games-sync.php. Si elles n'existent pas encore
 * (juste après un déploiement), on dégrade proprement au lieu de 500. */
$V5_READY = true;
try { $pdo->query('SELECT 1 FROM tfh_g_ratings LIMIT 1'); } catch (Throwable $e) { $V5_READY = false; }

/* ── Headers communs : JSON + cache court + CORS GET ── */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Vary: Origin');

/* Émetteur local (json_out de helpers.php force « no-store » — ici on garde
   le Cache-Control posé par chaque route). */
function gout(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
function gfail(int $status, string $code, string $message = ''): void
{
    $payload = ['ok' => false, 'error' => $code];
    if ($message !== '') $payload['message'] = $message;
    gout($payload, $status);
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    header('Access-Control-Max-Age: 86400');
    gout(['ok' => true]);
}

$route = (string)($_GET['route'] ?? '');
$limit = max(1, min(200, (int)($_GET['limit'] ?? 30)));
$offset = max(0, min(100000, (int)($_GET['offset'] ?? 0)));

/** epoch DATETIME(3) → millisecondes (entier). */
function ts_ms(array $row, string $field): ?int {
    if (!isset($row[$field]) || $row[$field] === null) return null;
    $v = (float)$row[$field];
    return (int)round($v * 1000);
}

/** Projetction standard d'une ligne tfh_g_games. */
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
        'numPlayers' => $r['num_players'] !== null ? (int)$r['num_players'] : null,
        'speedrun'   => $sr,
        'winner'     => $r['winner_public_id'] !== null || $r['winner_username'] !== null ? [
            'publicId' => $r['winner_public_id'] !== null ? (string)$r['winner_public_id'] : null,
            'username' => $r['winner_username'] !== null ? (string)$r['winner_username'] : null,
        ] : null,
    ];
}

const GAMES_SELECT = 'SELECT g.*, UNIX_TIMESTAMP(g.started_at) AS started_ts, u.username AS winner_username
    FROM tfh_g_games g LEFT JOIN tfh_g_usernames u ON u.id = g.winner_username_id';

/* ═══════════════════════════ Router ═══════════════════════════ */

switch ($route) {

/* ── Dernières parties publiques ─────────────────────────────────────────── */
case 'recent': {
    header('Cache-Control: public, max-age=45');
    $st = $pdo->prepare(GAMES_SELECT . ' ORDER BY g.started_at DESC LIMIT ? OFFSET ?');
    $st->bindValue(1, $limit, PDO::PARAM_INT);
    $st->bindValue(2, $offset, PDO::PARAM_INT);
    $st->execute();
    $games = array_map('game_row', $st->fetchAll());
    json_out(['ok' => true, 'games' => $games]);
}

/* ── Détail d'une partie + roster ────────────────────────────────────────── */
case 'game': {
    header('Cache-Control: public, max-age=300');
    $id = (string)($_GET['id'] ?? '');
    if (!preg_match('/^[A-Za-z0-9]{6,16}$/', $id)) gfail(400, 'bad_id');
    $st = $pdo->prepare(GAMES_SELECT . ' WHERE g.game_id = ?');
    $st->execute([$id]);
    $r = $st->fetch();
    if ($r === false) gfail(404, 'game_not_found');
    $roster = $pdo->prepare('SELECT r.client_id, r.public_id, r.won, r.stats_json, r.clan_tag,
            r.is_lobby_creator, r.persistent_id, r.team_index, r.cosmetics_json, u.username
        FROM tfh_g_roster r JOIN tfh_g_usernames u ON u.id = r.username_id
        WHERE r.game_id = ? ORDER BY r.won DESC, u.username');
    $roster->execute([$id]);
    $players = [];
    foreach ($roster->fetchAll() as $p) {
        $players[] = [
            'publicId'   => $p['public_id'],
            'clientId'   => (string)$p['client_id'],
            'username'   => (string)$p['username'],
            'won'        => (bool)$p['won'],
            'stats'      => $p['stats_json'] !== null ? json_decode((string)$p['stats_json'], true) : null,
            'clanTag'    => $p['clan_tag'] !== null ? (string)$p['clan_tag'] : null,
            'isLobbyCreator' => (bool)$p['is_lobby_creator'],
            'persistentId'   => ($p['persistent_id'] ?? null) !== null ? (string)$p['persistent_id'] : null,
            'teamIndex'  => ($p['team_index'] ?? null) !== null ? (int)$p['team_index'] : null,
            'cosmetics'  => ($p['cosmetics_json'] ?? null) !== null ? json_decode((string)$p['cosmetics_json'], true) : null,
        ];
    }
    $out = game_row($r);
    $out['players'] = $players;
    $out['version'] = ($r['version'] ?? null) !== null ? (string)$r['version'] : null;
    $out['numTurns'] = ($r['num_turns'] ?? null) !== null ? (int)$r['num_turns'] : null;
    $out['config'] = ($r['config_json'] ?? null) !== null ? json_decode((string)$r['config_json'], true) : null;
    $hr = $pdo->prepare('SELECT 1 FROM tfh_g_turns WHERE game_id = ?');
    $out['hasReplay'] = false;
    try { $hr->execute([$id]); $out['hasReplay'] = (bool)$hr->fetchColumn(); } catch (Throwable $e) {}
    json_out(['ok' => true, 'game' => $out]);
}

/* ── Speedruns (records par carte / récents) ─────────────────────────────── */
case 'speedruns': {
    header('Cache-Control: public, max-age=60');
    $category = (string)($_GET['category'] ?? 'normal');
    if (!in_array($category, ['normal', 'compact'], true)) gfail(400, 'bad_category');
    $map = trim((string)($_GET['map'] ?? ''));
    $sort = (string)($_GET['sort'] ?? 'duration');
    $window = (string)($_GET['window'] ?? 'all');
    $where = 'WHERE g.speedrun_category = ? AND g.speedrun_duration_s IS NOT NULL';
    $args = [$category];
    if ($map !== '' && $map !== 'all') { $where .= ' AND g.game_map = ?'; $args[] = $map; }
    if (preg_match('/^(\d+)d$/', $window, $mm)) {
        $where .= ' AND g.started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        $args[] = (int)$mm[1];
    }
    $order = $sort === 'date' ? 'g.started_at DESC' : 'g.speedrun_duration_s ASC, g.started_at ASC';
    $st = $pdo->prepare(GAMES_SELECT . " $where ORDER BY $order LIMIT ? OFFSET ?");
    foreach ($args as $i => $a) $st->bindValue($i + 1, $a);
    $st->bindValue(count($args) + 1, $limit, PDO::PARAM_INT);
    $st->bindValue(count($args) + 2, $offset, PDO::PARAM_INT);
    $st->execute();
    $runs = [];
    foreach ($st->fetchAll() as $r) {
        $g = game_row($r);
        $runs[] = [
            'id'          => $g['id'],
            'startedAt'   => $g['startedAt'],
            'map'         => $g['map'],
            'durationS'   => $g['speedrun']['durationS'],
            'numPlayers'  => $g['numPlayers'],
            'difficulty'  => $g['difficulty'],
            'player'      => [
                'publicId' => $g['winner']['publicId'] ?? null,
                'username' => $g['winner']['username'] ?? null,
            ],
        ];
    }
    $gamesTotal = (int)$pdo->query('SELECT COUNT(*) FROM tfh_g_games')->fetchColumn();
    json_out(['ok' => true, 'runs' => $runs, 'games_total' => $gamesTotal]);
}

/* ── Pré-profil d'un joueur (par publicId) ───────────────────────────────── */
case 'profile': {
    header('Cache-Control: public, max-age=60');
    $pid = (string)($_GET['publicId'] ?? '');
    if (!preg_match('/^[A-Za-z0-9]{6,16}$/', $pid)) gfail(400, 'bad_public_id');

    $st = $pdo->prepare('SELECT *, UNIX_TIMESTAMP(last_seen) AS last_seen_ts, UNIX_TIMESTAMP(first_seen) AS first_seen_ts FROM tfh_g_players WHERE public_id = ?');
    $st->execute([$pid]);
    $p = $st->fetch();
    if ($p === false) gfail(404, 'player_not_found');

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
    $rg->bindValue(2, min($limit, 100), PDO::PARAM_INT);
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
            c.rarity, c.price_hard, c.url
        FROM tfh_g_cosmetic_wearers w LEFT JOIN tfh_g_cosmetics c ON c.category = w.category AND c.name = w.name
        WHERE w.public_id = ? ORDER BY w.times_worn DESC LIMIT 60');
    $cw->execute([$pid]);
    foreach ($cw->fetchAll() as $x) {
        $cosmetics[] = [
            'category' => (string)$x['category'], 'name' => (string)$x['name'],
            'timesWorn' => (int)$x['times_worn'],
            'firstWorn' => (int)strtotime((string)$x['first_worn']),
            'lastWorn' => (int)strtotime((string)$x['last_worn']),
            'rarity' => $x['rarity'] !== null ? (string)$x['rarity'] : null,
            'priceHard' => $x['price_hard'] !== null ? (int)$x['price_hard'] : null,
            'url' => $x['url'] !== null ? (string)$x['url'] : null,
        ];
    }

    // v5 : clans portés
    $ct = $pdo->prepare('SELECT r.clan_tag, COUNT(*) AS games, SUM(r.won) AS wins
        FROM tfh_g_roster r WHERE r.public_id = ? AND r.clan_tag IS NOT NULL
        GROUP BY r.clan_tag ORDER BY games DESC LIMIT 10');
    $ct->execute([$pid]);
    foreach ($ct->fetchAll() as $x) {
        $clans[] = ['tag' => (string)$x['clan_tag'], 'games' => (int)$x['games'], 'wins' => (int)$x['wins']];
    }
    }

    json_out([
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
        'aliases' => $aliases,
        'ratings' => $ratings,
        'cosmetics' => $cosmetics,
        'clans' => $clans,
        'stats' => [
            'byMode' => $byMode,
            'byMap' => $byMap,
            'bestSpeedruns' => $bestSpeedruns,
            'recentGames' => $recentGames,
        ],
    ]);
}

/* ── Recherche de joueurs (tous alias connus) ────────────────────────────── */
case 'search': {
    header('Cache-Control: public, max-age=120');
    $q = trim((string)($_GET['q'] ?? ''));
    if (mb_strlen($q) < 2) json_out(['ok' => true, 'results' => []]);
    $norm = mb_strtolower($q, 'UTF-8');
    $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], $norm) . '%';
    $st = $pdo->prepare("SELECT p.public_id, p.last_username, p.games_count, p.wins_count, u.username AS matched
        FROM tfh_g_players p
        JOIN tfh_g_aliases a ON a.public_id = p.public_id
        JOIN tfh_g_usernames u ON u.id = a.username_id
        WHERE p.deleted_at IS NULL AND (u.norm LIKE ? OR u.username LIKE ?)
        GROUP BY p.public_id, p.last_username, p.games_count, p.wins_count, u.username
        ORDER BY p.games_count DESC LIMIT ?");
    $st->bindValue(1, $like);
    $st->bindValue(2, $like);
    $st->bindValue(3, $limit, PDO::PARAM_INT);
    $st->execute();
    $results = [];
    foreach ($st->fetchAll() as $r) {
        $results[] = [
            'publicId' => (string)$r['public_id'],
            'lastUsername' => $r['last_username'] !== null ? (string)$r['last_username'] : (string)$r['matched'],
            'matchedName' => (string)$r['matched'],
            'gamesCount' => (int)$r['games_count'],
            'winsCount' => (int)$r['wins_count'],
        ];
    }

    // v5 : clans correspondants
    $clans = [];
    if ($V5_READY) {
    $sc = $pdo->prepare('SELECT c.clan_tag, c.participations, c.wins
        FROM tfh_g_clans c WHERE c.clan_tag LIKE ? ORDER BY c.wins DESC LIMIT 5');
    $sc->execute([$like]);
    foreach ($sc->fetchAll() as $r) {
        $clans[] = ['tag' => (string)$r['clan_tag'], 'participations' => (int)$r['participations'], 'wins' => (int)$r['wins']];
    }
    }

    // v5 : parties par préfixe d'id
    $games = [];
    if (preg_match('/^[A-Za-z0-9]{4,16}$/', $q)) {
        $sg = $pdo->prepare('SELECT g.game_id, UNIX_TIMESTAMP(g.started_at) AS started_ts, g.game_mode, g.game_map, g.num_players
            FROM tfh_g_games g WHERE g.game_id LIKE ? ORDER BY g.started_at DESC LIMIT 5');
        $sg->execute([$q . '%']);
        foreach ($sg->fetchAll() as $r) {
            $games[] = [
                'id' => (string)$r['game_id'], 'startedAt' => (int)$r['started_ts'],
                'mode' => $r['game_mode'] !== null ? (string)$r['game_mode'] : null,
                'map' => $r['game_map'] !== null ? (string)$r['game_map'] : null,
                'numPlayers' => $r['num_players'] !== null ? (int)$r['num_players'] : null,
            ];
        }
    }
    json_out(['ok' => true, 'results' => $results, 'clans' => $clans, 'games' => $games]);
}

/* ── Cartes disponibles (pour les filtres speedruns ou vue globale v5) ───── */
case 'maps': {
    header('Cache-Control: public, max-age=600');
    $scope = (string)($_GET['scope'] ?? 'speedrun');
    if ($scope === 'all') {
        $st = $pdo->query('SELECT game_map, COUNT(*) AS games, AVG(duration_s) AS avg_duration,
                MAX(num_players) AS max_players
            FROM tfh_g_games WHERE game_map IS NOT NULL
            GROUP BY game_map ORDER BY games DESC LIMIT 200');
        $maps = [];
        foreach ($st->fetchAll() as $m) {
            $maps[] = [
                'map' => (string)$m['game_map'], 'games' => (int)$m['games'],
                'avgDurationS' => $m['avg_duration'] !== null ? (int)round((float)$m['avg_duration']) : null,
                'maxPlayers' => $m['max_players'] !== null ? (int)$m['max_players'] : null,
            ];
        }
        json_out(['ok' => true, 'scope' => 'all', 'maps' => $maps]);
    }
    $category = (string)($_GET['category'] ?? 'normal');
    if (!in_array($category, ['normal', 'compact'], true)) gfail(400, 'bad_category');
    $st = $pdo->prepare('SELECT game_map, COUNT(*) AS runs FROM tfh_g_games
        WHERE speedrun_category = ? AND game_map IS NOT NULL
        GROUP BY game_map ORDER BY runs DESC');
    $st->execute([$category]);
    $maps = [];
    foreach ($st->fetchAll() as $m) {
        $maps[] = ['map' => (string)$m['game_map'], 'runs' => (int)$m['runs']];
    }
    json_out(['ok' => true, 'maps' => $maps]);
}

/* ── État de la base (admin / widgets) ───────────────────────────────────── */
case 'status': {
    header('Cache-Control: public, max-age=60');
    $cnt = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_games) AS games,
        (SELECT COUNT(*) FROM tfh_g_players WHERE deleted_at IS NULL) AS players,
        (SELECT COUNT(*) FROM tfh_g_games WHERE speedrun_category IS NOT NULL) AS speedruns,
        (SELECT MAX(started_at) FROM tfh_g_games) AS newest')->fetch();
    $st = $pdo->query("SELECT skey, svalue FROM tfh_g_state WHERE skey IN
        ('backfill_cursor_ms','recent_end_ms','of_rate_cur','of_429_total','of_err_total','rating_cursor_ms')");
    $state = [];
    foreach ($st->fetchAll() as $row) $state[$row['skey']] = $row['svalue'];
    $cursorMs = $state['backfill_cursor_ms'] ?? null;
    $recentMs = $state['recent_end_ms'] ?? null;
    $ratingMs = $state['rating_cursor_ms'] ?? null;
    $v5 = ['enrich_left' => 0, 'turns_left' => 0, 'turns_ok' => 0, 'clans' => 0, 'cosmetics' => 0, 'wearers' => 0, 'rated_players' => 0];
    if ($V5_READY) {
    $v5 = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_games WHERE v5_done = 0) AS enrich_left,
        (SELECT COUNT(*) FROM tfh_g_games WHERE turns_done = 0) AS turns_left,
        (SELECT COUNT(*) FROM tfh_g_turns) AS turns_ok,
        (SELECT COUNT(*) FROM tfh_g_clans) AS clans,
        (SELECT COUNT(*) FROM tfh_g_cosmetics) AS cosmetics,
        (SELECT COUNT(*) FROM tfh_g_cosmetic_wearers) AS wearers,
        (SELECT COUNT(*) FROM tfh_g_ratings) AS rated_players')->fetch();
    }
    json_out([
        'ok' => true,
        'games' => (int)$cnt['games'],
        'players' => (int)$cnt['players'],
        'speedruns' => (int)$cnt['speedruns'],
        'newestGame' => $cnt['newest'] !== null ? (string)$cnt['newest'] : null,
        'backfillCursor' => $cursorMs !== null ? gmdate('Y-m-d H:i', (int)round(((int)$cursorMs) / 1000)) : null,
        'recentCursor' => $recentMs !== null ? gmdate('Y-m-d H:i', (int)round(((int)$recentMs) / 1000)) : null,
        'httpStats' => [
            'detailRatePerS' => isset($state['of_rate_cur']) ? round((float)$state['of_rate_cur'], 2) : null,
            'total429' => isset($state['of_429_total']) ? (int)$state['of_429_total'] : null,
            'totalErr' => isset($state['of_err_total']) ? (int)$state['of_err_total'] : null,
        ],
        'v5' => [
            'enrichRemaining' => (int)$v5['enrich_left'],
            'turnsRemaining' => (int)$v5['turns_left'],
            'turnsStored' => (int)$v5['turns_ok'],
            'clans' => (int)$v5['clans'],
            'cosmeticsCatalog' => (int)$v5['cosmetics'],
            'cosmeticWearers' => (int)$v5['wearers'],
            'ratedPlayers' => (int)$v5['rated_players'],
        ],
        'ratingCursor' => $ratingMs !== null ? gmdate('Y-m-d H:i', (int)round(((int)$ratingMs) / 1000)) : null,
        'v5Phase' => $state['v5_phase'] ?? null,
        'v5PhaseAt' => isset($state['v5_phase_at']) ? (int)$state['v5_phase_at'] : null,
    ]);
}

/* ── v5 : Leaderboard Glicko-2 (ffa / team / ranked) ─────────────────── */
case 'leaderboard': {
    header('Cache-Control: public, max-age=120');
    $board = (string)($_GET['board'] ?? 'ffa');
    if (!in_array($board, ['ffa', 'team', 'ranked'], true)) gfail(400, 'bad_board');
    $minGames = max(0, min(100, (int)($_GET['minGames'] ?? 3)));
    $st = $pdo->prepare("SELECT r.public_id, r.rating, r.rd, r.games, r.wins, r.peak, p.last_username
        FROM tfh_g_ratings r JOIN tfh_g_players p ON p.public_id = r.public_id
        WHERE r.board = ? AND p.deleted_at IS NULL AND r.games >= ?
        ORDER BY r.rating DESC LIMIT ? OFFSET ?");
    $st->bindValue(1, $board);
    $st->bindValue(2, $minGames, PDO::PARAM_INT);
    $st->bindValue(3, $limit, PDO::PARAM_INT);
    $st->bindValue(4, $offset, PDO::PARAM_INT);
    $st->execute();
    $entries = [];
    $i = $offset;
    foreach ($st->fetchAll() as $x) {
        $i++;
        $entries[] = [
            'rank' => $i, 'publicId' => (string)$x['public_id'], 'username' => (string)$x['last_username'],
            'rating' => round((float)$x['rating'], 1), 'rd' => round((float)$x['rd'], 1),
            'games' => (int)$x['games'], 'wins' => (int)$x['wins'],
            'winRate' => (int)$x['games'] > 0 ? round((int)$x['wins'] / (int)$x['games'], 4) : null,
            'peak' => round((float)$x['peak'], 1),
        ];
    }
    gout(['ok' => true, 'board' => $board, 'entries' => $entries]);
}

/* ── v5 : Ladder des clans ──────────────────────────────────────────── */
case 'clans': {
    header('Cache-Control: public, max-age=300');
    $window = (string)($_GET['window'] ?? 'all');
    $where = ''; $args = [];
    if (preg_match('/^(\d+)d$/', $window, $mm)) {
        $where = ' AND g.started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        $args[] = (int)$mm[1];
    } elseif ($window === 'week') {
        $where = ' AND g.started_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
    }
    $st = $pdo->prepare("SELECT r.clan_tag, COUNT(*) AS participations, SUM(r.won) AS wins,
            COUNT(DISTINCT r.public_id) AS members
        FROM tfh_g_roster r JOIN tfh_g_games g ON g.game_id = r.game_id
        WHERE r.clan_tag IS NOT NULL $where
        GROUP BY r.clan_tag ORDER BY wins DESC, participations DESC LIMIT ? OFFSET ?");
    foreach ($args as $i2 => $a) $st->bindValue($i2 + 1, $a);
    $st->bindValue(count($args) + 1, $limit, PDO::PARAM_INT);
    $st->bindValue(count($args) + 2, $offset, PDO::PARAM_INT);
    $st->execute();
    $clans = [];
    $i = $offset;
    foreach ($st->fetchAll() as $x) {
        $i++;
        $clans[] = [
            'rank' => $i, 'tag' => (string)$x['clan_tag'],
            'participations' => (int)$x['participations'], 'wins' => (int)$x['wins'],
            'members' => (int)$x['members'],
            'winRate' => (int)$x['participations'] > 0 ? round((int)$x['wins'] / (int)$x['participations'], 4) : null,
        ];
    }
    gout(['ok' => true, 'window' => $window, 'clans' => $clans]);
}

/* ── v5 : Détail d'un clan ──────────────────────────────────────────── */
case 'clan': {
    header('Cache-Control: public, max-age=120');
    $tag = trim((string)($_GET['tag'] ?? ''));
    if ($tag === '' || mb_strlen($tag) > 16) gfail(400, 'bad_tag');
    $sm = $pdo->prepare("SELECT r.public_id, COUNT(*) AS games, SUM(r.won) AS wins, p.last_username
        FROM tfh_g_roster r JOIN tfh_g_players p ON p.public_id = r.public_id
        WHERE r.clan_tag = ? AND p.deleted_at IS NULL
        GROUP BY r.public_id, p.last_username
        ORDER BY games DESC LIMIT ?");
    $sm->bindValue(1, $tag);
    $sm->bindValue(2, min($limit, 100), PDO::PARAM_INT);
    $sm->execute();
    $members = [];
    foreach ($sm->fetchAll() as $x) {
        $members[] = [
            'publicId' => (string)$x['public_id'], 'username' => (string)$x['last_username'],
            'games' => (int)$x['games'], 'wins' => (int)$x['wins'],
        ];
    }
    $gi = $pdo->prepare('SELECT r.game_id FROM tfh_g_roster r JOIN tfh_g_games g ON g.game_id = r.game_id
        WHERE r.clan_tag = ? ORDER BY g.started_at DESC LIMIT 20');
    $gi->execute([$tag]);
    $ids = $gi->fetchAll(PDO::FETCH_COLUMN);
    $recentGames = [];
    if ($ids) {
        $in = implode(',', array_fill(0, count($ids), '?'));
        $sg = $pdo->prepare(GAMES_SELECT . " WHERE g.game_id IN ($in) ORDER BY g.started_at DESC");
        $sg->execute($ids);
        foreach ($sg->fetchAll() as $r) $recentGames[] = game_row($r);
    }
    $tot = $pdo->prepare('SELECT COUNT(*) AS games, COALESCE(SUM(r.won), 0) AS wins
        FROM tfh_g_roster r WHERE r.clan_tag = ?');
    $tot->execute([$tag]);
    $t = $tot->fetch();
    gout([
        'ok' => true, 'tag' => $tag,
        'participations' => (int)$t['games'], 'wins' => (int)$t['wins'],
        'members' => $members, 'recentGames' => $recentGames,
    ]);
}

/* ── v5 : Catalogue des cosmétiques ──────────────────────────────────── */
case 'cosmetics': {
    header('Cache-Control: public, max-age=300');
    $category = (string)($_GET['category'] ?? 'all');
    $sort = (string)($_GET['sort'] ?? 'wearers');
    $cats = ['pattern', 'flag', 'skin', 'crown', 'effect', 'palette', 'pack', 'currency', 'subscription'];
    $where = ''; $args = [];
    if (in_array($category, $cats, true)) { $where = 'WHERE c.category = ?'; $args[] = $category; }
    $order = match ($sort) {
        'price' => 'c.price_hard DESC, wearers DESC',
        'name' => 'c.name ASC',
        default => 'wearers DESC, c.name ASC',
    };
    $sql = "SELECT c.category, c.name, c.display_name, c.rarity, c.price_hard, c.price_cents, c.artist, c.url,
            COALESCE(w.players, 0) AS players, COALESCE(w.wearers, 0) AS wearers
        FROM tfh_g_cosmetics c
        LEFT JOIN (SELECT category, name, COUNT(*) AS players, SUM(times_worn) AS wearers
                   FROM tfh_g_cosmetic_wearers GROUP BY category, name) w
            ON w.category = c.category AND w.name = c.name
        $where
        ORDER BY $order
        LIMIT ? OFFSET ?";
    $st = $pdo->prepare($sql);
    foreach ($args as $i2 => $a) $st->bindValue($i2 + 1, $a);
    $st->bindValue(count($args) + 1, $limit, PDO::PARAM_INT);
    $st->bindValue(count($args) + 2, $offset, PDO::PARAM_INT);
    $st->execute();
    $items = [];
    foreach ($st->fetchAll() as $x) {
        $items[] = [
            'category' => (string)$x['category'], 'name' => (string)$x['name'],
            'displayName' => $x['display_name'] !== null ? (string)$x['display_name'] : null,
            'rarity' => $x['rarity'] !== null ? (string)$x['rarity'] : null,
            'priceHard' => $x['price_hard'] !== null ? (int)$x['price_hard'] : null,
            'priceCents' => $x['price_cents'] !== null ? (int)$x['price_cents'] : null,
            'artist' => $x['artist'] !== null ? (string)$x['artist'] : null,
            'url' => $x['url'] !== null ? (string)$x['url'] : null,
            'players' => (int)$x['players'], 'wearers' => (int)$x['wearers'],
        ];
    }
    gout(['ok' => true, 'items' => $items]);
}

/* ── v5 : Détail d'un cosmétique (top porteurs) ──────────────────────── */
case 'cosmetic': {
    header('Cache-Control: public, max-age=120');
    $name = trim((string)($_GET['name'] ?? ''));
    $category = trim((string)($_GET['category'] ?? ''));
    if ($name === '' || mb_strlen($name) > 64) gfail(400, 'bad_name');
    $st = $pdo->prepare('SELECT * FROM tfh_g_cosmetics WHERE name = ?' . ($category !== '' ? ' AND category = ?' : ''));
    $st->execute($category !== '' ? [$name, $category] : [$name]);
    $c = $st->fetch();
    if ($c === false) gfail(404, 'cosmetic_not_found');
    $tw = $pdo->prepare('SELECT w.public_id, w.times_worn, w.first_worn, w.last_worn, p.last_username
        FROM tfh_g_cosmetic_wearers w JOIN tfh_g_players p ON p.public_id = w.public_id
        WHERE w.category = ? AND w.name = ? AND p.deleted_at IS NULL
        ORDER BY w.times_worn DESC LIMIT 25');
    $tw->execute([(string)$c['category'], $name]);
    $wearers = [];
    foreach ($tw->fetchAll() as $x) {
        $wearers[] = [
            'publicId' => (string)$x['public_id'], 'username' => (string)$x['last_username'],
            'timesWorn' => (int)$x['times_worn'], 'lastWorn' => (int)strtotime((string)$x['last_worn']),
        ];
    }
    $tot = $pdo->prepare('SELECT COUNT(*) AS players, COALESCE(SUM(times_worn), 0) AS wearers
        FROM tfh_g_cosmetic_wearers WHERE category = ? AND name = ?');
    $tot->execute([(string)$c['category'], $name]);
    $t = $tot->fetch();
    gout([
        'ok' => true,
        'item' => [
            'category' => (string)$c['category'], 'name' => (string)$c['name'],
            'displayName' => $c['display_name'] !== null ? (string)$c['display_name'] : null,
            'rarity' => $c['rarity'] !== null ? (string)$c['rarity'] : null,
            'priceHard' => $c['price_hard'] !== null ? (int)$c['price_hard'] : null,
            'priceCents' => $c['price_cents'] !== null ? (int)$c['price_cents'] : null,
            'artist' => $c['artist'] !== null ? (string)$c['artist'] : null,
            'url' => $c['url'] !== null ? (string)$c['url'] : null,
        ],
        'totalPlayers' => (int)$t['players'], 'totalWears' => (int)$t['wearers'],
        'topWearers' => $wearers,
    ]);
}

/* ── v5 : Replay JSON complet d'une partie ───────────────────────────── */
case 'replay': {
    $id = (string)($_GET['id'] ?? '');
    if (!preg_match('/^[A-Za-z0-9]{6,16}$/', $id)) gfail(400, 'bad_id');
    $st = $pdo->prepare('SELECT data FROM tfh_g_turns WHERE game_id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    if ($row === false) gfail(404, 'replay_not_found');
    $json = gzdecode((string)$row['data']);
    if ($json === false) gfail(500, 'replay_corrupt');
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: public, max-age=86400');
    header('X-Content-Type-Options: nosniff');
    echo $json;
    exit;
}

default:
    gfail(400, 'bad_route', 'Routes : recent, game, speedruns, profile, search, maps, status, leaderboard, clans, clan, cosmetics, cosmetic, replay');
}
