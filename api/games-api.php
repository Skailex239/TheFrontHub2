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
require_once __DIR__ . '/profile-schema.php';
/* v5.36 — Cache fichier + constructeur de payload partagé (profile-warm.php) */
require_once __DIR__ . '/profile-payload.php';
tfh_profile_ensure_schema($pdo);

/* v5 : les nouvelles tables (ratings, cosmétiques, replay, clans) sont créées
 * par le prochain tick de games-sync.php. Si elles n'existent pas encore
 * (juste après un déploiement), on dégrade proprement au lieu de 500. */
$V5_READY = true;
try { $pdo->query('SELECT 1 FROM tfh_g_ratings LIMIT 1'); } catch (Throwable $e) { $V5_READY = false; }

/* v5.11 : tables API officielles (ladder ranked, profils joueurs, colonnes
 * lb_* clans) — créées par le prochain tick games-sync.php ; dégradation
 * propre des routes concernées tant qu'elles n'existent pas. */
$V511_READY = true;
try { $pdo->query('SELECT 1 FROM tfh_g_ladder LIMIT 1'); } catch (Throwable $e) { $V511_READY = false; }
/* v5.12 — nouveaux flux (board FFA, tribus, news, streams, sessions clans) */
$V512_READY = true;
try { $pdo->query('SELECT 1 FROM tfh_g_lb_ffa LIMIT 1'); } catch (Throwable $e) { $V512_READY = false; }

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

/* ── Audit P0-2 (2026-10) : garde admin pour les routes diagnostiques ──────
 * status / synclog exposaient publiquement l'état interne de la base et du
 * cycle de synchronisation. Ces routes ne servent AUCUN page du front :
 * on les verrouille sur une session Discord site avec role = admin
 * (helpers.php : current_user(), chargé via config.php).
 * Devient 403 JSON pour tout visiteur externe. */
function tfh_route_admin_only(PDO $pdo): bool
{
    try {
        $user = current_user($pdo);
        return is_array($user) && (($user['role'] ?? '') === 'admin');
    } catch (Throwable $e) {
        return false;
    }
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
        /* v5.16 : version officielle du jeu (tags OpenFrontIO) — 'v0.0.2' = constante
         * analytics sans valeur, filtrée pour ne jamais s'afficher */
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
    /* v5.13 — badge « vérifié » par joueur (comptes revendiqués) : les
     * rosters pointent vers des profils publics reliés. */
    $vmap = tfh_verified_map($pdo, array_filter(array_map(
        static fn(array $p): string => (string)($p['publicId'] ?? ''), $players
    )));
    foreach ($players as &$pv) {
        $pv['verified'] = $pv['publicId'] !== null && !empty($vmap[(string)$pv['publicId']]);
    }
    unset($pv);
    $out = game_row($r);
    $out['players'] = $players;
    /* v5.16 : l'historique profond est ingéré « liste d'abord » — les détails
     * (carte, roster) arrivent avec le backfill d'enrichissement */
    $out['enriching'] = isset($r['v5_done']) && (int)$r['v5_done'] === 0;
    $out['version'] = isset($r['version']) && (string)$r['version'] !== '' && (string)$r['version'] !== 'v0.0.2'
        ? (string)$r['version'] : null;
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
            'version'     => $g['version'],
            'player'      => [
                'publicId' => $g['winner']['publicId'] ?? null,
                'username' => $g['winner']['username'] ?? null,
            ],
        ];
    }
    $gamesTotal = (int)$pdo->query('SELECT COUNT(*) FROM tfh_g_games')->fetchColumn();
    json_out(['ok' => true, 'runs' => $runs, 'games_total' => $gamesTotal]);
}

/* ── Pré-profil d'un joueur (par publicId) ─────────────────────────────────
 * v5.36 — CACHE FICHIER : le payload complet est pré-généré pour les joueurs
 * pertinents par api/profile-warm.php (cron) et stocké dans profile-cache/.
 * Ici : lecture fichier (~qq ms) si le cache est frais, sinon calcul (corps
 * extrait vers api/profile-payload.php — code unique partagé avec le warm)
 * puis écriture du cache. &refresh / &nocache court-circuitent la lecture. */
case 'profile': {
    header('Cache-Control: public, max-age=60');
    $pid = (string)($_GET['publicId'] ?? '');
    if (!preg_match('/^[A-Za-z0-9]{6,16}$/', $pid)) gfail(400, 'bad_public_id');

    /* Popularité (alimente la priorité de pré-génération du cron) — jamais bloquant. */
    tfh_profile_count_view($pdo, $pid);

    $bypassCache = isset($_GET['refresh']) || isset($_GET['nocache']);
    if (!$bypassCache && ($cached = tfh_profile_cache_read($pid)) !== null) {
        gout($cached);
    }

    try {
        /* Limite 100 : le cache est UNIQUE par joueur — les consommateurs qui
         * demandent moins (limit=1/20) reçoivent un payload un peu plus riche
         * et tronquent côté client ; en échange, le dossier cockpit client
         * dispose d'un échantillon suffisant (fin des appels OpenFront lents). */
        $payload = tfh_profile_payload($pdo, $pid, 100, isset($_GET['refresh']));
    } catch (TfhProfileNotFound $e) {
        gfail(404, 'player_not_found');
    }
    tfh_profile_cache_write($pid, $payload);
    gout($payload);
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
    /* v5.13 — badge « vérifié » dans les résultats de recherche */
    $vmapS = tfh_verified_map($pdo, array_map(
        static fn(array $r): string => (string)$r['public_id'], $results
    ));
    foreach ($results as &$sr) {
        $sr['verified'] = !empty($vmapS[$sr['publicId']]);
    }
    unset($sr);

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

/* ── Top joueurs de la semaine (TOUS les joueurs, pré-calculé par le cron) ──
 * Barème identique au dashboard : FFA casual ×10 · FFA classé ×1 ·
 * Team casual ×5 · Team classé ×1. Données issues de tfh_g_weekly
 * (agrégat rerécalculé à chaque tick de games-sync.php pour la semaine
 * courante + la précédente → flèches de tendance incluses).
 *
 *   route=weekly &limit=50&offset=0 &mode=all|ffa|team &q= &me=PUBLICID
 */
case 'weekly': {
    header('Cache-Control: public, max-age=60');
    $mode = (string)($_GET['mode'] ?? 'all');
    if (!in_array($mode, ['all', 'ffa', 'team'], true)) $mode = 'all';
    $q = trim((string)($_GET['q'] ?? ''));
    $me = trim((string)($_GET['me'] ?? ''));
    $wLimit = max(1, min(200, (int)($_GET['limit'] ?? 50)));
    $wOffset = max(0, min(100000, (int)($_GET['offset'] ?? 0)));

    [$curMs, $prevMs] = tfh_week_bounds_ms();
    $week = gmdate('Y-m-d', intdiv($curMs, 1000));
    $prevWeek = gmdate('Y-m-d', intdiv($prevMs, 1000));

    $ptsKey  = ['all' => 'pts_all',  'ffa' => 'pts_ffa',  'team' => 'pts_team'][$mode];
    $rankCol = ['all' => 'w.rank_all', 'ffa' => 'w.rank_ffa', 'team' => 'w.rank_team'][$mode];
    $prevRankCol = ['all' => 'pw.rank_all', 'ffa' => 'pw.rank_ffa', 'team' => 'pw.rank_team'][$mode];

    /* Position « TOI » : envoyée avec la ligne du joueur connecté (rank
     * déjà stocké par le cron) même s'il est au-delà de la fenêtre paginée. */
    $meRow = null;
    if (preg_match('/^[A-Za-z0-9]{6,16}$/', $me)) {
        try {
            $stm = $pdo->prepare(
                "SELECT w.public_id, w.pts_all, w.pts_ffa, w.pts_team, w.{$rankCol} AS rk,
                        p.last_username, pa.username AS hub_username, u.verified_at
                 FROM tfh_g_weekly w
                 LEFT JOIN tfh_g_players p ON p.public_id = w.public_id
                 LEFT JOIN tfh_public_aliases pa ON pa.public_id = w.public_id
                 LEFT JOIN tfh_users u ON u.id = pa.user_id
                 WHERE w.week_start = ? AND w.public_id = ? LIMIT 1"
            );
            $stm->execute([$week, $me]);
            $mrow = $stm->fetch();
            if ($mrow !== false) {
                $meRow = [
                    'publicId' => (string)$mrow['public_id'],
                    'rank'     => $mrow['rk'] !== null ? (int)$mrow['rk'] : null,
                    'points'   => (int)$mrow[$ptsKey],
                    'username' => $mrow['last_username'] !== null ? (string)$mrow['last_username'] : null,
                    'hubName'  => $mrow['hub_username'] !== null ? (string)$mrow['hub_username'] : null,
                    'verified' => $mrow['verified_at'] !== null,
                ];
            }
        } catch (Throwable $e) {}
    }

    $where = 'w.week_start = ?';
    $args = [$week];
    /* La table ne contient que les joueurs avec ≥ 1 victoire ; en mode ffa /
     * team on exclut ceux à 0 pt dans la catégorie (comme le dashboard). */
    if ($mode === 'ffa')  { $where .= ' AND w.pts_ffa > 0'; }
    if ($mode === 'team') { $where .= ' AND w.pts_team > 0'; }
    if ($q !== '') {
        $qLike = '%' . str_replace(['%', '_'], ['\\%', '\\_'], mb_strtolower($q, 'UTF-8')) . '%';
        $where .= " AND (LOWER(COALESCE(pa.username, '')) LIKE ? OR LOWER(COALESCE(p.last_username, '')) LIKE ?)";
        $args[] = $qLike;
        $args[] = $qLike;
    }

    try {
        $sqlBase = "FROM tfh_g_weekly w
            LEFT JOIN tfh_g_players p ON p.public_id = w.public_id
            LEFT JOIN tfh_public_aliases pa ON pa.public_id = w.public_id
            LEFT JOIN tfh_users u ON u.id = pa.user_id
            LEFT JOIN tfh_g_weekly pw ON pw.week_start = ? AND pw.public_id = w.public_id
            WHERE $where";
        $cnt = $pdo->prepare('SELECT COUNT(*) ' . $sqlBase);
        $cnt->execute(array_merge([$prevWeek], $args));
        $total = (int)$cnt->fetchColumn();

        /* v5.13 — table vide ? (cron pas encore passé / première activation)
         * → recalcul sur place (quelques secondes, ensuite servi depuis la
         * table ; le cron de prod la rafraîchit toutes les 5 min). Un seul
         * visiteur paie le coût, les suivants lisent la table remplie. */
        $dbg = null;
        if ($total === 0 && $q === '' && !isset($_GET['norecompute'])) {
            $dbg = [];
            try {
                $dbg['recompute'] = tfh_weekly_recompute($pdo);
                $curSec = intdiv($curMs, 1000);
                $p1 = $pdo->prepare('SELECT COUNT(*) FROM tfh_g_games WHERE started_at >= FROM_UNIXTIME(?) AND started_at < FROM_UNIXTIME(?)');
                $p1->execute([$curSec, $curSec + 7 * 86400]);
                $dbg['gamesInWindow'] = (int)$p1->fetchColumn();
                $p2 = $pdo->prepare("SELECT COUNT(*) FROM tfh_g_games g JOIN tfh_g_roster r ON r.game_id = g.game_id
                    WHERE g.started_at >= FROM_UNIXTIME(?) AND g.started_at < FROM_UNIXTIME(?) AND r.won = 1 AND r.public_id IS NOT NULL");
                $p2->execute([$curSec, $curSec + 7 * 86400]);
                $dbg['winnersInWindow'] = (int)$p2->fetchColumn();
                $p3 = $pdo->prepare("SELECT MIN(started_at) AS mn, MAX(started_at) AS mx FROM tfh_g_games");
                $p3->execute();
                $dbg['gamesRange'] = $p3->fetch();
                $cnt->execute(array_merge([$prevWeek], $args));
                $total = (int)$cnt->fetchColumn();
            } catch (Throwable $e) {
                $dbg['error'] = $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine();
            }
            if ($total === 0) {
                json_out([
                    'ok' => true, 'weekStart' => $curMs, 'mode' => $mode,
                    'total' => 0, 'offset' => $wOffset, 'limit' => $wLimit,
                    'me' => null, 'players' => [], 'debug' => $dbg,
                ]);
            }
        }

        $st = $pdo->prepare(
            "SELECT w.public_id, w.ffa_casual, w.ffa_ranked, w.team_casual, w.team_ranked,
                    w.pts_all, w.pts_ffa, w.pts_team,
                    {$rankCol} AS rk, {$prevRankCol} AS prev_rk,
                    p.last_username, pa.username AS hub_username,
                    (u.verified_at IS NOT NULL) AS verified
             $sqlBase
             ORDER BY {$rankCol} ASC, w.public_id ASC
             LIMIT ? OFFSET ?"
        );
        $allArgs = array_merge([$prevWeek], $args);
        foreach ($allArgs as $i => $a) $st->bindValue($i + 1, $a);
        $st->bindValue(count($allArgs) + 1, $wLimit, PDO::PARAM_INT);
        $st->bindValue(count($allArgs) + 2, $wOffset, PDO::PARAM_INT);
        $st->execute();

        $players = [];
        foreach ($st->fetchAll() as $r) {
            $players[] = [
                'rank'           => $r['rk'] !== null ? (int)$r['rk'] : $wOffset + count($players) + 1,
                'publicId'       => (string)$r['public_id'],
                'username'       => $r['last_username'] !== null ? (string)$r['last_username'] : (string)$r['public_id'],
                'hubName'        => $r['hub_username'] !== null ? (string)$r['hub_username'] : null,
                'verified'       => (bool)$r['verified'],
                'ffaCasualWins'  => (int)$r['ffa_casual'],
                'ffaRankedWins'  => (int)$r['ffa_ranked'],
                'teamCasualWins' => (int)$r['team_casual'],
                'teamRankedWins' => (int)$r['team_ranked'],
                'points'         => (int)$r[$ptsKey],
                'prevRank'       => $r['prev_rk'] !== null ? (int)$r['prev_rk'] : null,
            ];
        }

        json_out([
            'ok'        => true,
            'weekStart' => $curMs,
            'mode'      => $mode,
            'total'     => $total,
            'offset'    => $wOffset,
            'limit'     => $wLimit,
            'me'        => $meRow,
            'players'   => $players,
        ]);
    } catch (Throwable $e) {
        /* Table pas encore créée / premier tick non passé → dégradation propre */
        error_log('[tfh-api] weekly: ' . $e->getMessage());
        json_out([
            'ok' => true, 'weekStart' => $curMs, 'mode' => $mode,
            'total' => 0, 'offset' => $wOffset, 'limit' => $wLimit,
            'me' => null, 'players' => [], 'pending' => true,
        ]);
    }
}

/* ── Cartes disponibles (pour les filtres speedruns ou vue globale v5) ───── */
case 'maps': {
    header('Cache-Control: public, max-age=600');
    $scope = (string)($_GET['scope'] ?? 'speedrun');
    if ($scope === 'all') {
        /* v5.19 — stats de cartes (maps) alimentées par la collecte continue
         * (cron games-sync) : les compteurs cumulent 24/7 côté serveur, donc
         * un visiteur qui arrive voit TOUS les totaux accumulés, pas seulement
         * ce qui s'est passé pendant sa visite.
         *   &period=all|7d|24h  (défaut all)   fenêtre sur started_at
         * Réponse enrichie : players (somme), share %, totalGames, newestGame
         * (dernière partie collectée = preuve que la collecte tourne). */
        $period = (string)($_GET['period'] ?? 'all');
        $where = 'game_map IS NOT NULL';
        if ($period === '24h')      $where .= ' AND started_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY';
        elseif ($period === '7d')   $where .= ' AND started_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY';
        elseif ($period === '30d')  $where .= ' AND started_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY';
        else                        $period = 'all';
        $st = $pdo->query("SELECT game_map, COUNT(*) AS games, AVG(duration_s) AS avg_duration,
                MAX(num_players) AS max_players, SUM(num_players) AS players
            FROM tfh_g_games WHERE $where
            GROUP BY game_map ORDER BY games DESC LIMIT 200");
        $maps = [];
        $sumGames = 0;
        foreach ($st->fetchAll() as $m) {
            $g = (int)$m['games'];
            $sumGames += $g;
            $maps[] = [
                'map' => (string)$m['game_map'], 'games' => $g,
                'avgDurationS' => $m['avg_duration'] !== null ? (int)round((float)$m['avg_duration']) : null,
                'maxPlayers' => $m['max_players'] !== null ? (int)$m['max_players'] : null,
                'players' => $m['players'] !== null ? (int)$m['players'] : null,
            ];
        }
        /* parts calculées côté client par rapport à $sumGames (cartes listées) */
        $tot = $pdo->query('SELECT COUNT(*) AS g, MAX(started_at) AS newest,
                (SELECT COUNT(*) FROM tfh_g_games WHERE started_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AS g24,
                (SELECT COUNT(*) FROM tfh_g_games WHERE started_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY) AS g7
            FROM tfh_g_games')->fetch();
        json_out(['ok' => true, 'scope' => 'all', 'period' => $period, 'maps' => $maps,
            'listedGames' => $sumGames,
            'totalGames' => (int)$tot['g'],
            'totalGames24h' => (int)$tot['g24'],
            'totalGames7d' => (int)$tot['g7'],
            'newestGame' => $tot['newest'] !== null ? (string)$tot['newest'] : null]);
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
case 'totals': {
    /* v5.22 — Compteurs publics pour la page d'accueil (« Parties en base »).
     * COUNT(*) sur des millions de lignes = trop cher à chaque visite →
     * cache fichier 5 min hors webroot (~/.tfs_cache, même philosophie que
     * tfh_patterns_map). Aucun compteur interne sensible exposé. */
    header('Cache-Control: public, max-age=120');
    $cacheDir = (getenv('HOME') ?: sys_get_temp_dir()) . '/.tfs_cache';
    $cacheFile = $cacheDir . '/games_totals.json';
    $data = null;
    if (is_file($cacheFile) && (time() - (int)filemtime($cacheFile)) < 300) {
        $data = json_decode((string)@file_get_contents($cacheFile), true);
    }
    if (!is_array($data)) {
        $row = $pdo->query('SELECT
            (SELECT COUNT(*) FROM tfh_g_games) AS games,
            (SELECT COUNT(*) FROM tfh_g_games WHERE game_type = \'Public\') AS public_games,
            (SELECT COUNT(*) FROM tfh_g_games WHERE speedrun_category IS NOT NULL) AS speedruns,
            (SELECT COUNT(*) FROM tfh_g_games WHERE started_at >= NOW() - INTERVAL 1 DAY) AS last24h,
            (SELECT COUNT(*) FROM tfh_g_players WHERE deleted_at IS NULL) AS players')->fetch();
        $data = [
            'ok'          => true,
            'games'       => (int)$row['games'],
            'publicGames' => (int)$row['public_games'],
            'speedruns'   => (int)$row['speedruns'],
            'last24h'     => (int)$row['last24h'],
            'players'     => (int)$row['players'],
            'generatedAt' => time(),
        ];
        if (!is_dir($cacheDir)) @mkdir($cacheDir, 0700, true);
        @file_put_contents($cacheFile, json_encode($data), LOCK_EX);
    }
    json_out($data);
}

case 'status': {
    /* Audit P0-2 : route diagnostique réservée aux admins (session Discord
     * site avec role=admin). Aucune page du front ne la consomme — verrou
     * anti-exposition publique des compteurs internes (curseurs, 429…). */
    if (!tfh_route_admin_only($pdo)) {
        gfail(403, 'forbidden', 'Route réservée aux administrateurs.');
    }
    header('Cache-Control: public, max-age=60');
    $cnt = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_games) AS games,
        (SELECT COUNT(*) FROM tfh_g_players WHERE deleted_at IS NULL) AS players,
        (SELECT COUNT(*) FROM tfh_g_games WHERE speedrun_category IS NOT NULL) AS speedruns,
        (SELECT MAX(started_at) FROM tfh_g_games) AS newest')->fetch();
    $st = $pdo->query("SELECT skey, svalue FROM tfh_g_state WHERE skey IN
        ('backfill_cursor_ms','recent_end_ms','of_rate_cur','of_429_total','of_err_total','rating_cursor_ms','v5_phase','v5_phase_at','ladder_refreshed_at','clanslb_refreshed_at','profiles_fetched_total','vermig_remaining','vermig_done')");
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
    /* v5.11 : compteurs API officielles */
    $v511 = ['ladder_rows' => 0, 'ladder_hist' => 0, 'profiles' => 0, 'profiles_gone' => 0, 'clans_official' => 0];
    if ($V511_READY) {
    $v511 = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_ladder) AS ladder_rows,
        (SELECT COUNT(*) FROM tfh_g_ladder_history) AS ladder_hist,
        (SELECT COUNT(*) FROM tfh_g_profiles) AS profiles,
        (SELECT COUNT(*) FROM tfh_g_profiles WHERE not_found = 1) AS profiles_gone,
        (SELECT COUNT(*) FROM tfh_g_clans WHERE lb_fetched_at IS NOT NULL) AS clans_official')->fetch();
    }
    /* v5.12 : nouveaux flux */
    $v512 = ['ffa_rows' => 0, 'tribes' => 0, 'news' => 0, 'streams_live' => 0, 'clan_sessions' => 0];
    if ($V512_READY) {
    $v512 = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_lb_ffa) AS ffa_rows,
        (SELECT COUNT(*) FROM tfh_g_tribes) AS tribes,
        (SELECT COUNT(*) FROM tfh_g_news) AS news,
        (SELECT COUNT(*) FROM tfh_g_streams WHERE last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR)) AS streams_live,
        (SELECT COUNT(*) FROM tfh_g_clan_sessions) AS clan_sessions')->fetch();
    }
    json_out([
        'ok' => true,
        'games' => (int)$cnt['games'],
        'players' => (int)$cnt['players'],
        'speedruns' => (int)$cnt['speedruns'],
        'newestGame' => $cnt['newest'] !== null ? (string)$cnt['newest'] : null,
        'backfillCursor' => $cursorMs !== null ? gmdate('Y-m-d H:i', (int)round(((int)$cursorMs) / 1000)) : null,
        'verMig' => [
            'remaining' => isset($state['vermig_remaining']) ? (int)$state['vermig_remaining'] : null,
            'done' => isset($state['vermig_done']) ? (string)$state['vermig_done'] === '1' : false,
        ],
        'recentCursor' => $recentMs !== null ? gmdate('Y-m-d H:i', (int)round(((int)$recentMs) / 1000)) : null,
        'httpStats' => [
            'detailRatePerS' => isset($state['of_rate_cur']) ? round((float)$state['of_rate_cur'], 2) : null,
            'total429' => isset($state['of_429_total']) ? (int)$state['of_429_total'] : null,
            'totalErr' => isset($state['of_err_total']) ? (int)$state['of_err_total'] : null,
            /* v5.10 : diagnostic clé OpenFront — true = la clé est bien chargée
             * dans les secrets prod et envoyée par le cron. La valeur de la clé
             * n'est JAMAIS exposée ici. */
            'ofAccessSet' => isset($secrets) && is_array($secrets) && (string)($secrets['openfront_access'] ?? '') !== '',
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
        'v511' => [
            'ladderRows' => (int)$v511['ladder_rows'],
            'ladderHistoryRows' => (int)$v511['ladder_hist'],
            'ladderFetchedAt' => isset($state['ladder_refreshed_at']) ? (int)$state['ladder_refreshed_at'] : null,
            'clansOfficial' => (int)$v511['clans_official'],
            'clansOfficialAt' => isset($state['clanslb_refreshed_at']) ? (int)$state['clanslb_refreshed_at'] : null,
            'profilesOfficial' => (int)$v511['profiles'],
            'profilesGone' => (int)$v511['profiles_gone'],
            'profilesFetchedTotal' => isset($state['profiles_fetched_total']) ? (int)$state['profiles_fetched_total'] : 0,
        ],
        'v512' => [
            'ffaBoardRows' => (int)$v512['ffa_rows'],
            'tribes' => (int)$v512['tribes'],
            'news' => (int)$v512['news'],
            'streamsLive' => (int)$v512['streams_live'],
            'clanSessions' => (int)$v512['clan_sessions'],
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

/* ── v5.11 : Ladder ranked OFFICIEL (ELO, top 100 1v1/2v2) ─── */
case 'ladder': {
    header('Cache-Control: public, max-age=300');
    /* Courbe ELO d'un joueur (historique quotidien du ladder officiel) */
    $histOf = (string)($_GET['historyOf'] ?? '');
    if ($histOf !== '') {
        if (!preg_match('/^[A-Za-z0-9]{6,16}$/', $histOf)) gfail(400, 'bad_public_id');
        $hist = [];
        if ($V511_READY) {
            $sh = $pdo->prepare("SELECT board, rank_pos, elo, peak_elo, DATE_FORMAT(day, '%Y-%m-%d') AS d
                FROM tfh_g_ladder_history WHERE public_id = ? ORDER BY board, day ASC LIMIT 730");
            $sh->execute([$histOf]);
            foreach ($sh->fetchAll() as $r) {
                $hist[] = [
                    'board' => (string)$r['board'], 'day' => (string)$r['d'],
                    'rank' => (int)$r['rank_pos'], 'elo' => (int)$r['elo'], 'peakElo' => (int)$r['peak_elo'],
                ];
            }
        }
        gout(['ok' => true, 'publicId' => $histOf, 'history' => $hist]);
    }
    $board = (string)($_GET['board'] ?? 'all');
    if (!in_array($board, ['all', '1v1', '2v2'], true)) gfail(400, 'bad_board');
    $boards = $board === 'all' ? ['1v1', '2v2'] : [$board];
    $out = [];
    $fetchedAt = null;
    foreach ($boards as $b) {
        $rows = [];
        if ($V511_READY) {
            $st = $pdo->prepare('SELECT rank_pos, public_id, username, account_username, elo, peak_elo, wins, losses, total, fetched_at
                FROM tfh_g_ladder WHERE board = ? ORDER BY rank_pos ASC LIMIT 100');
            $st->execute([$b]);
            foreach ($st->fetchAll() as $r) {
                $rows[] = [
                    'rank' => (int)$r['rank_pos'], 'publicId' => (string)$r['public_id'],
                    'username' => $r['username'] !== null ? (string)$r['username'] : null,
                    'accountUsername' => $r['account_username'] !== null ? (string)$r['account_username'] : null,
                    'elo' => (int)$r['elo'], 'peakElo' => (int)$r['peak_elo'],
                    'wins' => (int)$r['wins'], 'losses' => (int)$r['losses'], 'total' => (int)$r['total'],
                ];
                if ($fetchedAt === null || (string)$r['fetched_at'] > $fetchedAt) $fetchedAt = (string)$r['fetched_at'];
            }
        }
        $out[$b] = $rows;
    }
    gout(['ok' => true, 'boards' => $out, 'fetchedAt' => $fetchedAt]);
}

/* ── v5 : Ladder des clans ──────────────────────────────────────────── */
case 'clans': {
    header('Cache-Control: public, max-age=300');
    $window = (string)($_GET['window'] ?? 'all');
    /* v5.11 : sort=official trie sur les weightedWins officiels (si dispo) */
    $sort = (string)($_GET['sort'] ?? 'wins');
    $where = ''; $args = [];
    if (preg_match('/^(\d+)d$/', $window, $mm)) {
        $where = ' AND g.started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        $args[] = (int)$mm[1];
    } elseif ($window === 'week') {
        $where = ' AND g.started_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
    }
    /* v5.11 : jointure tfh_g_clans pour les chiffres officiels (weightedWins,
     * fenêtre glissante ~90 j). Si les colonnes n'existent pas encore (juste
     * après déploiement), on retombe sur la requête historique. */
    $lbCols = "'' AS lb_dummy";
    if ($V511_READY) $lbCols = "MAX(c.lb_games) AS lb_games, MAX(c.lb_wins) AS lb_wins, MAX(c.lb_losses) AS lb_losses,
            MAX(c.lb_player_sessions) AS lb_player_sessions, MAX(c.lb_weighted_wins) AS lb_weighted_wins,
            MAX(c.lb_weighted_losses) AS lb_weighted_losses, MAX(c.lb_wl_ratio) AS lb_wl_ratio";
    $join = $V511_READY ? 'LEFT JOIN tfh_g_clans c ON c.clan_tag = r.clan_tag' : '';
    $order = ($sort === 'official' && $V511_READY)
        ? 'lb_weighted_wins IS NULL ASC, lb_weighted_wins DESC'
        : 'wins DESC, participations DESC';
    $st = $pdo->prepare("SELECT r.clan_tag, COUNT(*) AS participations, SUM(r.won) AS wins,
            COUNT(DISTINCT r.public_id) AS members,
            $lbCols
        FROM tfh_g_roster r JOIN tfh_g_games g ON g.game_id = r.game_id
        $join
        WHERE r.clan_tag IS NOT NULL $where
        GROUP BY r.clan_tag ORDER BY $order LIMIT ? OFFSET ?");
    foreach ($args as $i2 => $a) $st->bindValue($i2 + 1, $a);
    $st->bindValue(count($args) + 1, $limit, PDO::PARAM_INT);
    $st->bindValue(count($args) + 2, $offset, PDO::PARAM_INT);
    $st->execute();
    $clans = [];
    $i = $offset;
    foreach ($st->fetchAll() as $x) {
        $i++;
        $row = [
            'rank' => $i, 'tag' => (string)$x['clan_tag'],
            'participations' => (int)$x['participations'], 'wins' => (int)$x['wins'],
            'members' => (int)$x['members'],
            'winRate' => (int)$x['participations'] > 0 ? round((int)$x['wins'] / (int)$x['participations'], 4) : null,
        ];
        if ($V511_READY) {
            $row['official'] = ($x['lb_weighted_wins'] ?? null) === null ? null : [
                'games' => (int)$x['lb_games'], 'wins' => (int)$x['lb_wins'], 'losses' => (int)$x['lb_losses'],
                'playerSessions' => (int)$x['lb_player_sessions'],
                'weightedWins' => round((float)$x['lb_weighted_wins'], 2),
                'weightedLosses' => $x['lb_weighted_losses'] !== null ? round((float)$x['lb_weighted_losses'], 2) : null,
                'weightedWLRatio' => $x['lb_wl_ratio'] !== null ? round((float)$x['lb_wl_ratio'], 2) : null,
            ];
        }
        $clans[] = $row;
    }
    gout(['ok' => true, 'window' => $window, 'sort' => $sort, 'clans' => $clans]);
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
    /* v5.13 — badge « vérifié » sur les membres (profils revendiqués) */
    $vmapC = tfh_verified_map($pdo, array_map(
        static fn(array $m): string => $m['publicId'], $members
    ));
    foreach ($members as &$mb) {
        $mb['verified'] = !empty($vmapC[$mb['publicId']]);
    }
    unset($mb);
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
    /* v5.11 : bloc officiel (leaderboard clans, weightedWins ~90 j) si dispo */
    $official = null;
    if ($V511_READY) {
        $so = $pdo->prepare('SELECT lb_games, lb_wins, lb_losses, lb_player_sessions,
                lb_weighted_wins, lb_weighted_losses, lb_wl_ratio, lb_fetched_at
            FROM tfh_g_clans WHERE clan_tag = ? AND lb_fetched_at IS NOT NULL');
        $so->execute([$tag]);
        if (($or = $so->fetch()) !== false) {
            $official = [
                'games' => (int)$or['lb_games'], 'wins' => (int)$or['lb_wins'], 'losses' => (int)$or['lb_losses'],
                'playerSessions' => (int)$or['lb_player_sessions'],
                'weightedWins' => $or['lb_weighted_wins'] !== null ? round((float)$or['lb_weighted_wins'], 2) : null,
                'weightedLosses' => $or['lb_weighted_losses'] !== null ? round((float)$or['lb_weighted_losses'], 2) : null,
                'weightedWLRatio' => $or['lb_wl_ratio'] !== null ? round((float)$or['lb_wl_ratio'], 2) : null,
                'fetchedAt' => (int)strtotime((string)$or['lb_fetched_at']),
            ];
        }
    }
    gout([
        'ok' => true, 'tag' => $tag,
        'participations' => (int)$t['games'], 'wins' => (int)$t['wins'],
        'official' => $official,
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

/* ── v5.12 : Board FFA officiel (+ historique par joueur) ─────────────── */
case 'ffaboard': {
    header('Cache-Control: public, max-age=300');
    if (!$V512_READY) gfail(503, 'v512_not_ready');
    $histOf = (string)($_GET['historyOf'] ?? '');
    if ($histOf !== '') {
        if (!preg_match('/^[A-Za-z0-9]{6,16}$/', $histOf)) gfail(400, 'bad_public_id');
        $h = $pdo->prepare("SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d, rank_pos, wins, losses, total, wlr
            FROM tfh_g_lb_ffa_history WHERE public_id = ? ORDER BY day ASC LIMIT 400");
        $h->execute([$histOf]);
        $history = [];
        foreach ($h->fetchAll() as $r) {
            $history[] = [
                'day' => (string)$r['d'], 'rank' => (int)$r['rank_pos'],
                'wins' => (int)$r['wins'], 'losses' => (int)$r['losses'],
                'total' => (int)$r['total'], 'wlr' => $r['wlr'] !== null ? round((float)$r['wlr'], 2) : null,
            ];
        }
        gout(['ok' => true, 'publicId' => $histOf, 'history' => $history]);
    }
    $st = $pdo->prepare('SELECT f.rank_pos, f.public_id, f.wins, f.losses, f.total, f.wlr, p.last_username
        FROM tfh_g_lb_ffa f LEFT JOIN tfh_g_players p ON p.public_id = f.public_id
        ORDER BY f.rank_pos ASC LIMIT ?');
    $st->bindValue(1, min(1000, $limit), PDO::PARAM_INT);
    $st->execute();
    $entries = [];
    foreach ($st->fetchAll() as $r) {
        $entries[] = [
            'rank' => (int)$r['rank_pos'], 'publicId' => (string)$r['public_id'],
            'username' => ($r['last_username'] ?? null) !== null ? (string)$r['last_username'] : null,
            'wins' => (int)$r['wins'], 'losses' => (int)$r['losses'], 'total' => (int)$r['total'],
            'wlr' => $r['wlr'] !== null ? round((float)$r['wlr'], 2) : null,
        ];
    }
    $fetchedAt = $pdo->query('SELECT MAX(fetched_at) FROM tfh_g_lb_ffa')->fetchColumn();
    gout(['ok' => true, 'entries' => $entries, 'fetchedAt' => $fetchedAt ?: null]);
}

/* ── v5.12 : Ladder des tribus (noms achetés, reach, boosts) ──────────── */
case 'tribes': {
    header('Cache-Control: public, max-age=600');
    if (!$V512_READY) gfail(503, 'v512_not_ready');
    $st = $pdo->prepare('SELECT rank_pos, name, games_appeared, player_reach, owner_public_id, owner_username,
        active_boosts, window_days, fetched_at FROM tfh_g_tribes ORDER BY rank_pos ASC LIMIT ?');
    $st->bindValue(1, min(500, $limit), PDO::PARAM_INT);
    $st->execute();
    $tribes = [];
    foreach ($st->fetchAll() as $r) {
        $tribes[] = [
            'rank' => (int)$r['rank_pos'], 'name' => (string)$r['name'],
            'gamesAppeared' => (int)$r['games_appeared'], 'playerReach' => (int)$r['player_reach'],
            'ownerPublicId' => $r['owner_public_id'] !== null ? (string)$r['owner_public_id'] : null,
            'ownerUsername' => $r['owner_username'] !== null ? (string)$r['owner_username'] : null,
            'activeBoosts' => (int)$r['active_boosts'],
        ];
    }
    $fetchedAt = $pdo->query('SELECT MAX(fetched_at) FROM tfh_g_tribes')->fetchColumn();
    gout(['ok' => true, 'tribes' => $tribes, 'fetchedAt' => $fetchedAt ?: null]);
}

/* ── v5.12 : News officielles OpenFront ───────────────────────────────── */
case 'news': {
    header('Cache-Control: public, max-age=600');
    if (!$V512_READY) gfail(503, 'v512_not_ready');
    $st = $pdo->prepare('SELECT news_id, title, description, url, type, platforms_json, first_seen, last_seen
        FROM tfh_g_news ORDER BY CAST(news_id AS UNSIGNED) DESC LIMIT ?');
    $st->bindValue(1, min(100, $limit), PDO::PARAM_INT);
    $st->execute();
    $items = [];
    foreach ($st->fetchAll() as $r) {
        $items[] = [
            'id' => (string)$r['news_id'],
            'title' => $r['title'] !== null ? (string)$r['title'] : null,
            'description' => $r['description'] !== null ? (string)$r['description'] : null,
            'url' => $r['url'] !== null ? (string)$r['url'] : null,
            'type' => $r['type'] !== null ? (string)$r['type'] : null,
            'platforms' => $r['platforms_json'] ? array_values(array_filter(explode(',', (string)$r['platforms_json']))) : [],
            'firstSeen' => $r['first_seen'], 'lastSeen' => $r['last_seen'],
        ];
    }
    gout(['ok' => true, 'items' => $items]);
}

/* ── v5.12 : Streams live (Twitch…) ───────────────────────────── */
case 'streams': {
    header('Cache-Control: public, max-age=120');
    if (!$V512_READY) gfail(503, 'v512_not_ready');
    $st = $pdo->prepare('SELECT channel, platform, display_name, title, viewers, avatar_url, url, started_at,
            first_seen_at, last_seen_at
        FROM tfh_g_streams WHERE last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR)
        ORDER BY viewers DESC LIMIT ?');
    $st->bindValue(1, min(200, $limit), PDO::PARAM_INT);
    $st->execute();
    $live = [];
    foreach ($st->fetchAll() as $r) {
        $live[] = [
            'platform' => (string)$r['platform'], 'channel' => (string)$r['channel'],
            'displayName' => $r['display_name'] !== null ? (string)$r['display_name'] : null,
            'title' => $r['title'] !== null ? (string)$r['title'] : null,
            'viewers' => (int)$r['viewers'],
            'avatarUrl' => $r['avatar_url'] !== null ? (string)$r['avatar_url'] : null,
            'url' => $r['url'] !== null ? (string)$r['url'] : null,
            'startedAt' => $r['started_at'],
        ];
    }
    gout(['ok' => true, 'live' => $live]);
}

/* ── v5.12 : Sessions d'un clan (hist. récente + agrégats quotidiens) ─── */
case 'clansessions': {
    header('Cache-Control: public, max-age=300');
    if (!$V512_READY) gfail(503, 'v512_not_ready');
    $tag = strtoupper(trim((string)($_GET['tag'] ?? '')));
    if (!preg_match('/^[A-Z0-9]{1,10}$/', $tag)) gfail(400, 'bad_tag');
    $recent = $pdo->prepare('SELECT game_id, game_start, clan_player_count, has_won, num_teams, player_teams,
            total_player_count, score
        FROM tfh_g_clan_sessions WHERE clan_tag = ? ORDER BY game_start DESC LIMIT ?');
    $recent->bindValue(1, $tag);
    $recent->bindValue(2, min(200, $limit), PDO::PARAM_INT);
    $recent->execute();
    $sessions = [];
    foreach ($recent->fetchAll() as $r) {
        $sessions[] = [
            'gameId' => (string)$r['game_id'], 'gameStart' => (string)$r['game_start'],
            'clanPlayerCount' => (int)$r['clan_player_count'], 'hasWon' => (bool)$r['has_won'],
            'numTeams' => $r['num_teams'] !== null ? (int)$r['num_teams'] : null,
            'playerTeams' => $r['player_teams'] !== null ? (string)$r['player_teams'] : null,
            'totalPlayerCount' => $r['total_player_count'] !== null ? (int)$r['total_player_count'] : null,
            'score' => $r['score'] !== null ? round((float)$r['score'], 2) : null,
        ];
    }
    $agg = $pdo->prepare("SELECT DATE_FORMAT(game_start, '%Y-%m-%d') AS d, COUNT(*) AS games,
            SUM(has_won) AS wins, ROUND(AVG(score), 3) AS avg_score, MAX(clan_player_count) AS max_players
        FROM tfh_g_clan_sessions WHERE clan_tag = ? AND game_start >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
        GROUP BY d ORDER BY d ASC LIMIT 31");
    $agg->execute([$tag]);
    $daily = [];
    foreach ($agg->fetchAll() as $r) {
        $daily[] = [
            'day' => (string)$r['d'], 'games' => (int)$r['games'], 'wins' => (int)$r['wins'],
            'avgScore' => $r['avg_score'] !== null ? (float)$r['avg_score'] : null,
            'maxPlayers' => (int)$r['max_players'],
        ];
    }
    gout(['ok' => true, 'tag' => $tag, 'sessions' => $sessions, 'daily' => $daily]);
}

/* ── v5.12 : Cosmétiques portés par un joueur (proxy d'inventaire) ────── */
case 'playercosmetics': {
    header('Cache-Control: public, max-age=300');
    $pid = (string)($_GET['publicId'] ?? '');
    if (!preg_match('/^[A-Za-z0-9]{6,16}$/', $pid)) gfail(400, 'bad_public_id');
    $st = $pdo->prepare('SELECT category, name, times_worn, first_worn, last_worn
        FROM tfh_g_cosmetic_wearers WHERE public_id = ? ORDER BY times_worn DESC, last_worn DESC LIMIT 200');
    $st->execute([$pid]);
    $worn = [];
    foreach ($st->fetchAll() as $r) {
        $worn[] = [
            'category' => (string)$r['category'], 'name' => (string)$r['name'],
            'timesWorn' => (int)$r['times_worn'], 'firstWorn' => (string)$r['first_worn'],
            'lastWorn' => (string)$r['last_worn'],
        ];
    }
    gout(['ok' => true, 'publicId' => $pid, 'worn' => $worn]);
}

/* ── v5.12 : diagnostic — dernières lignes du log de sync ────────────────── */
case 'synclog': {
    /* Audit P0-2 : log de synchronisation interne (IP, débits, erreurs) —
     * strictement réservé aux administrateurs du site. */
    if (!tfh_route_admin_only($pdo)) {
        gfail(403, 'forbidden', 'Route réservée aux administrateurs.');
    }
    $f = __DIR__ . '/games-sync.log';
    $lines = [];
    if (is_readable($f)) {
        $all = @file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if (is_array($all)) $lines = array_slice($all, -60);
    }
    gout(['ok' => true,
        'fileExists' => file_exists($f), 'fileSize' => file_exists($f) ? (int)filesize($f) : 0,
        'fileWritable' => is_writable(__DIR__),
        'lines' => $lines]);
}

default:
    gfail(400, 'bad_route', 'Routes : recent, game, speedruns, profile, search, maps, status, leaderboard, clans, clan, cosmetics, cosmetic, replay, synclog');
}
