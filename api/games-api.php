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
 * Réponses : { ok:true, … } en JSON, cache 60 s. Erreurs : { ok:false, error }.
 */

define('TFH_API', 1);
require __DIR__ . '/config.php';

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
    $roster = $pdo->prepare('SELECT r.client_id, r.public_id, r.won, r.stats_json, u.username
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
        ];
    }
    $out = game_row($r);
    $out['players'] = $players;
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
    json_out(['ok' => true, 'runs' => $runs]);
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

    json_out([
        'ok' => true,
        'player' => [
            'publicId'    => (string)$p['public_id'],
            'lastUsername'=> $p['last_username'],
            'firstSeen'   => ts_ms($p, 'first_seen_ts'),
            'lastSeen'    => ts_ms($p, 'last_seen_ts'),
            'gamesCount'  => (int)$p['games_count'],
            'winsCount'   => (int)$p['wins_count'],
            'deletedAt'   => $p['deleted_at'],
        ],
        'aliases' => $aliases,
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
    json_out(['ok' => true, 'results' => $results]);
}

/* ── Cartes disponibles (pour les filtres speedruns) ─────────────────────── */
case 'maps': {
    header('Cache-Control: public, max-age=600');
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
    $backfill = $pdo->query("SELECT svalue FROM tfh_g_state WHERE skey = 'backfill_cursor_ms'")->fetchColumn();
    json_out([
        'ok' => true,
        'games' => (int)$cnt['games'],
        'players' => (int)$cnt['players'],
        'speedruns' => (int)$cnt['speedruns'],
        'newestGame' => $cnt['newest'] !== null ? (string)$cnt['newest'] : null,
        'backfillCursor' => $backfill !== false ? gmdate('Y-m-d', (int)round(((int)$backfill) / 1000)) : null,
    ]);
}

default:
    gfail(400, 'bad_route', 'Routes : recent, game, speedruns, profile, search, maps, status');
}
