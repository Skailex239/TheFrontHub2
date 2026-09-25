<?php
declare(strict_types=1);

/**
 * api/games-sync.php — Ingestion "parties & pré-profils" OpenFront → MySQL o2switch.
 *
 * À lancer par le cron cPanel (toutes les 5-15 min) :
 *   php /home/USER/public_html/thefronthub.com/api/games-sync.php
 *
 * Ce que fait chaque tick :
 *   1. Scan RÉCENT : toutes les parties (PUBLIC + PRIVÉ) depuis le dernier
 *      scan (fenêtre avec chevauchement de 10 min) → métadonnées + roster
 *      complet (publicId de CHAQUE joueur) + speedruns pré-calculés.
 *   2. BACKFILL : reprend le curseur historique (newest → oldest, epoch =
 *      2026-09-10T00:00Z, début de l'ère V34) dans la limite du budget.
 *   3. Purges : poll quotidien de /public/players/recently-deleted (tombstone).
 *
 *   Périmètre v2 (2026-09-23) : Public + Private, parties gardées dès
 *   1 joueur. Chaque changement de périmètre (SCOPE_VER) relance
 *   automatiquement un re-backfill complet (idempotent).
 *
 *   Moteur v3 (2026-09-24) : HTTP FIABLE. Constat : depuis l'IP mutualisée
 *   o2switch l'API rate-limite les rafales de détails → l'ancien code sautait
 *   silencieusement les parties non détaillées et déclarait les fenêtres
 *   terminées à moitié vides (backfill "terminé" avec ~2 % des parties).
 *   Corrections : pacing AIMD du débit détail (3 req/s → plafond 10, /2 à
 *   chaque 429), retries avec backoff (transitoire ≠ 404 permanent), curseur
 *   STRICT (aucune fenêtre ni page déclarée faite tant qu'il reste un échec
 *   transitoire), garde-fou anti-blocage (5 tentatives max par fenêtre),
 *   compteurs 429/erreurs tracés dans le log + --status.
 *
 *   Epoch v4.3 (2026-09-25) : GAMES_EPOCH_MS réalignée sur le début de
 *   l'ère V34 du jeu (v0.34.0-beta1 publiée le 2026-09-10) — le backfill
 *   s'arrête désormais au 10 sept 2026 00:00 UTC (au lieu du 10 sept 2025).
 *   SCOPE_VER inchangé : le backfill en cours continue et s'arrête plus tôt,
 *   aucun re-scan complet n'est déclenché.
 *
 * Commandes CLI :
 *   (sans argument)        tick normal (budget TICK_BUDGET)
 *   --backfill=N           session backfill prolongée de N secondes
 *   --since=ISO            repositionne le curseur backfill (ex: 2026-09-10T00:00:00Z)
 *   --status               état de la sync (compteurs, curseurs)
 *   --reset-backfill       remet le curseur backfill à maintenant
 *
 * Secrets : même fichier que le reste de l'API (~/.tfs_secrets/tfh-secrets.json),
 * avec en plus (optionnel mais recommandé) :
 *   { "mysql": {...}, "openfront_access": "token-skailex",
 *     "games": { "game_types": "Public,Private", "min_players_to_keep": 1,
 *                "detail_concurrency": 4, "player_stats_mode": "subset" } }
 *
 *   NB : l'ancienne clé "min_players" (v1) est ignorée — la nouvelle clé
 *   "min_players_to_keep" la remplace (défaut 1).

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Forbidden (CLI only)');
}

error_reporting(E_ALL & ~E_DEPRECATED);
ini_set('memory_limit', '512M');

/* ─────────────────────────── Secrets / config ─────────────────────────── */

$secrets = null;
foreach ([
    rtrim((string) getenv('HOME'), '/') . '/.tfs_secrets/tfh-secrets.json',
    dirname(__DIR__, 3) . '/.tfs_secrets/tfh-secrets.json',
] as $p) {
    if (is_readable($p)) {
        $d = json_decode((string) file_get_contents($p), true);
        if (is_array($d)) { $secrets = $d; break; }
    }
}
if (!is_array($secrets) || !is_array($secrets['mysql'] ?? null)) {
    fwrite(STDERR, "[games-sync] secrets introuvables (~/.tfs_secrets/tfh-secrets.json)\n");
    exit(1);
}

$cfg = array_merge([
    'game_types'          => 'Public,Private', // types scannés (API : Public|Private|Singleplayer)
    'min_players_to_keep' => 1,       // on garde même les parties à 1-2 joueurs
    'detail_concurrency'  => 4,       // appels /public/game/:id en parallèle
    'player_stats_mode'   => 'subset', // subset | all | none
    'tick_budget'         => 420,     // secondes max par tick cron (cron 10 min, verrou anti-chevauchement)
    'recent_overlap_min'  => 10,
    'window_days'         => 0.25,    // fenêtre backfill 6 h : finissable en 1-2 ticks → abandons rarissimes, pertes bornées
    'list_limit'          => 1000,
    'list_max_offset'     => 40000,   // garde-fou pagination
    'hard_delete'         => false,   // purge réelle des joueurs supprimés ?
    'detail_rate_start_per_s' => 1.5,   // v4.2 : débit détail initial (req/s) — calibré au seuil soutenable de l'API (4 req/s = 40 429/tick mesuré)
    'detail_rate_max_per_s'   => 2.0,  // v4.2 : plafond de remontée AIMD (au-delà : 429 massifs)
], is_array($secrets['games'] ?? null) ? $secrets['games'] : []);

/* Types de parties scannés (liste blanche API). Singleplayer EXCLU par
 * défaut : 80 000+ parties/jour, quasi toutes des lobbies solo VIDES
 * (numPlayers 0, pas de winner) — des millions de lignes
 * pour zéro valeur classement/profil. Activable via secrets :
 *   "games": { "game_types": ["Public","Private","Singleplayer"] } */
$GAME_TYPES = array_values(array_filter(array_map('trim',
    is_array($cfg['game_types'] ?? null) ? $cfg['game_types'] : explode(',', (string)($cfg['game_types'] ?? 'Public,Private')))));
$GAME_TYPES = array_values(array_intersect($GAME_TYPES, ['Public', 'Private', 'Singleplayer']));
if (!$GAME_TYPES) $GAME_TYPES = ['Public', 'Private'];
$MIN_KEEP = max(0, (int)($cfg['min_players_to_keep'] ?? 1));

const OF_API_BASE    = 'https://api.openfront.io';
const GAMES_EPOCH_MS = 1788998400000;  // 2026-09-10T00:00:00Z — début ère V34 (v0.34.0-beta1)
const TIME_OFFSET_S  = 32;             // offset speedrun (extract-speedrun.js)
const STATE_KEY_RECENT  = 'recent_end_ms';
const STATE_KEY_BACKFIL = 'backfill_cursor_ms';
const STATE_KEY_DELETER = 'deletions_polled_ms';

/* ─────────────────────────── PDO ─────────────────────────── */

$m = $secrets['mysql'];
$pdo = new PDO(
    sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', (string)$m['host'], (int)($m['port'] ?? 3306), (string)$m['database']),
    (string)$m['username'],
    (string)$m['password'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]
);

$OF_ACCESS = (string)($secrets['openfront_access'] ?? '');
if ($OF_ACCESS === '') fwrite(STDERR, "[games-sync] ⚠️ openfront_access absent — rate limit strict\n");

/* ─────────────────────────── CLI args ─────────────────────────── */

$argBackfill = 0; $argStatus = false; $argSince = ''; $argReset = false;
foreach (array_slice($argv, 1) as $a) {
    if (preg_match('/^--backfill=(\d+)$/', $a, $mm))      $argBackfill = (int)$mm[1];
    elseif ($a === '--status')                            $argStatus   = true;
    elseif (preg_match('/^--since=(.+)$/', $a, $mm))      $argSince    = $mm[1];
    elseif ($a === '--reset-backfill')                    $argReset    = true;
}

/* ─────────────────────────── Lock anti-chevauchement ─────────────────────────── */

$lockFile = sys_get_temp_dir() . '/tfh-games-sync.lock';
$lockFp = fopen($lockFile, 'c');
if (!$lockFp || !flock($lockFp, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, "[games-sync] un tick est déjà en cours — sortie\n");
    exit(0);
}

$t0 = time();
$deadline = $t0 + ($argBackfill > 0 ? $argBackfill : (int)$cfg['tick_budget']);

/* ─────────────────────────── Tables (auto-install) ─────────────────────────── */

$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_players (
    public_id     VARCHAR(16)  NOT NULL PRIMARY KEY,
    last_username VARCHAR(64)  NULL,
    first_seen    DATETIME     NOT NULL,
    last_seen     DATETIME     NOT NULL,
    last_game_id  VARCHAR(16)  NULL,
    games_count   INT UNSIGNED NOT NULL DEFAULT 0,
    wins_count    INT UNSIGNED NOT NULL DEFAULT 0,
    deleted_at    DATETIME     NULL,
    INDEX idx_gplayers_seen (last_seen),
    INDEX idx_gplayers_games (games_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_usernames (
    id       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64)  NOT NULL,
    norm     VARCHAR(64)  NOT NULL,
    UNIQUE KEY uq_gusername (username),
    INDEX idx_gusername_norm (norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_aliases (
    public_id  VARCHAR(16)  NOT NULL,
    username_id INT UNSIGNED NOT NULL,
    first_seen DATETIME     NOT NULL,
    last_seen  DATETIME     NOT NULL,
    times_used INT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (public_id, username_id),
    INDEX idx_galias_uname (username_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_games (
    game_id            VARCHAR(16)     NOT NULL PRIMARY KEY,
    started_at         DATETIME(3)     NOT NULL,
    ended_at           DATETIME(3)     NULL,
    duration_s         SMALLINT UNSIGNED NULL,
    game_type          VARCHAR(16)     NULL,
    game_mode          VARCHAR(20)     NULL,
    ranked_type        VARCHAR(12)     NULL,
    player_teams       VARCHAR(16)     NULL,
    game_map           VARCHAR(48)     NULL,
    map_size           VARCHAR(16)     NULL,
    difficulty         VARCHAR(16)     NULL,
    bots               SMALLINT UNSIGNED NULL,
    num_players        SMALLINT UNSIGNED NULL,
    max_players        SMALLINT UNSIGNED NULL,
    lobby_fill_time    INT UNSIGNED    NULL,
    winner_kind        VARCHAR(8)      NULL,
    winner_public_id   VARCHAR(16)     NULL,
    winner_username_id INT UNSIGNED    NULL,
    speedrun_category  VARCHAR(10)     NULL,
    speedrun_duration_s SMALLINT UNSIGNED NULL,
    mods               VARCHAR(128)    NULL,
    git_commit         VARCHAR(16)     NULL,
    ingested_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ggames_started (started_at),
    INDEX idx_ggames_sr (speedrun_category, game_map, speedrun_duration_s),
    INDEX idx_ggames_winner (winner_public_id),
    INDEX idx_ggames_ranked (ranked_type, started_at),
    INDEX idx_ggames_mode (game_mode, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_roster (
    game_id    VARCHAR(16)  NOT NULL,
    client_id  VARCHAR(16)  NOT NULL,
    public_id  VARCHAR(16)  NULL,
    username_id INT UNSIGNED NOT NULL,
    won        TINYINT(1)   NOT NULL DEFAULT 0,
    stats_json MEDIUMTEXT   NULL,
    PRIMARY KEY (game_id, client_id),
    INDEX idx_groster_pid (public_id, game_id),
    INDEX idx_groster_uname (username_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_state (
    skey   VARCHAR(40) NOT NULL PRIMARY KEY,
    svalue TEXT        NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

/* ─────────────────────────── Helpers ─────────────────────────── */

function state_get(PDO $pdo, string $k, ?string $def = null): ?string {
    $st = $pdo->prepare('SELECT svalue FROM tfh_g_state WHERE skey = ?');
    $st->execute([$k]);
    $row = $st->fetch();
    return $row === false ? $def : (string)$row['svalue'];
}
function state_set(PDO $pdo, string $k, string $v): void {
    $pdo->prepare('INSERT INTO tfh_g_state (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)')
        ->execute([$k, $v]);
}
function log_line(string $s): void { fwrite(STDERR, '[' . gmdate('H:i:s') . '] ' . $s . "\n"); }

/** Normalise un pseudo (miroir de normPlayerName.js) : minuscule, sans [TAG] ni discriminateur. */
function norm_name(string $s): string {
    $s = mb_strtolower(trim($s), 'UTF-8');
    $s = preg_replace('/^\[[a-z0-9_\-]{2,8}\]\s*/u', '', $s) ?? $s;
    $s = preg_replace('/\.\d{3,6}$/', '', $s) ?? $s;
    return trim($s);
}

function cut(string $s, int $n): string {
    return function_exists('mb_substr') ? mb_substr($s, 0, $n, 'UTF-8') : substr($s, 0, $n);
}

/** id du dictionnaire de pseudos (INSERT IGNORE + SELECT, anti-race). */
$unameCache = [];
function username_id(PDO $pdo, string $name, array &$cache): int {
    if (isset($cache[$name])) return $cache[$name];
    $pdo->prepare('INSERT IGNORE INTO tfh_g_usernames (username, norm) VALUES (?, ?)')
        ->execute([$name, norm_name($name)]);
    $st = $pdo->prepare('SELECT id FROM tfh_g_usernames WHERE username = ?');
    $st->execute([$name]);
    $id = (int)$st->fetchColumn();
    $cache[$name] = $id;
    return $id;
}

/** epoch ms → DATETIME(3) MySQL. */
function ms_to_dt(int $ms): string {
    return gmdate('Y-m-d H:i:s', intdiv($ms, 1000)) . '.' . sprintf('%03d', $ms % 1000);
}

/* ─────────────────────────── HTTP OpenFront ─────────────────────────── */

/* v3 (2026-09-24) : HTTP fiable.
 * Constat du 23-24 sept : depuis l'IP mutualisée o2switch, l'API rate-limite
 * les rafales d'appels détail. L'ancien code sautait silencieusement toute
 * partie dont le détail échouait ET déclarait la fenêtre terminée quand même
 * → backfill quasi vide (~16,5 k parties au lieu de centaines de milliers).
 * Désormais : pacing AIMD (débit détail adaptatif), retries avec backoff,
 * échec transitoire ≠ échec permanent (404), et AUCUNE progression du
 * curseur tant qu'une page n'est pas traitée intégralement. Tout est tracé. */

$OF_STATS     = ['ok' => 0, 'r429' => 0, 'err' => 0, 'retries' => 0]; // compteurs HTTP du tick
$OF_RATE      = 3.0;  // débit détail courant (req/s) — piloté par AIMD
$OF_RATE_MIN  = 0.5;
$OF_RATE_MAX  = 10.0; // réellement appliqué depuis $cfg au démarrage du tick
$OF_OK_RUN    = 0;     // succès consécutifs (remontée AIMD)
$OF_PACE_LAST = 0.0;   // fin du dernier batch détail (pacing)

/** Maintient un débit ≈ $OF_RATE req/s entre deux batches de détails. */
function of_pace(int $n): void {
    global $OF_RATE, $OF_RATE_MIN, $OF_PACE_LAST;
    if ($OF_PACE_LAST <= 0) return;
    $minGap = $n / max($OF_RATE_MIN, $OF_RATE);
    $wait = ($OF_PACE_LAST + $minGap) - microtime(true);
    if ($wait > 0) usleep((int)($wait * 1e6));
}

/** 429 reçu : descente AIMD (débit /2) + respiration avant reprise. */
function of_on_429(): void {
    global $OF_RATE, $OF_RATE_MIN, $OF_OK_RUN, $OF_STATS;
    $OF_STATS['r429']++;
    $OF_OK_RUN = 0;
    $OF_RATE = max($OF_RATE_MIN, $OF_RATE / 2);
    sleep(4);
}

/** Succès détail : remontée AIMD rapide (+20 % tous les 100 succès, plafonnée).
 * v4.1 : 500 → 100 succès par palier — à 0,5 req/s au plancher il fallait
 * ~5500 succès (~3 h) pour revenir à 4 req/s : le récent restait bloqué. */
function of_ok_nudge(): void {
    global $OF_OK_RUN, $OF_RATE, $OF_RATE_MAX;
    $OF_OK_RUN++;
    if ($OF_OK_RUN >= 100) {
        $OF_RATE = min($OF_RATE_MAX, $OF_RATE * 1.2);
        $OF_OK_RUN = 0;
    }
}

/**
 * GET OpenFront avec retries et backoff — v3. Retour [status, data|null].
 * 429 → backoff long + AIMD ; autres erreurs → backoff croissant ;
 * retourne le dernier status si tout échoue (l'appelant décide : reprise).
 */
function of_request(string $url, int $timeout, int $maxAttempts = 4): array {
    global $OF_ACCESS, $OF_STATS;
    $status = 0; $backoff = 2;
    for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
        $ch = curl_init($url);
        $headers = ['User-Agent: TheFrontHub-GamesSync/1.0', 'Accept: application/json'];
        if ($OF_ACCESS !== '') $headers[] = 'x-skailex-access: ' . $OF_ACCESS;
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_ENCODING       => '',
        ]);
        $body   = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($status === 200 && is_string($body)) {
            $OF_STATS['ok']++;
            $d = json_decode($body, true);
            return [200, is_array($d) ? $d : null];
        }
        if ($status === 429) { $OF_STATS['retries']++; of_on_429(); continue; }
        $OF_STATS['err']++;
        if ($attempt < $maxAttempts) { $OF_STATS['retries']++; sleep($backoff); $backoff = min(15, $backoff * 2); }
    }
    return [$status, null];
}

/** Wrapper compat (listes ponctuelles, poll deletions) : data|null. */
function of_get(string $url, int $retries = 4): ?array {
    [$status, $data] = of_request($url, 30, $retries);
    return $status === 200 ? $data : null;
}

/**
 * GET parallélisé de N détails de parties — v3 : pacing AIMD + retries transitoires.
 * Retour [gameId → détail|null, nbÉchecsTransitoiresRestants].
 *   - 404             → null PERMANENT (partie disparue), la page peut avancer
 *   - 429/5xx/réseau  → retryé 2× dans le tick (attente 3 s puis 6 s), sinon transitoire
 */
function of_details_multi(array $gameIds, int $concurrency): array {
    global $OF_ACCESS, $OF_PACE_LAST;
    $out = [];
    $pending = array_values($gameIds);
    for ($round = 0; $round < 3 && $pending; $round++) {
        if ($round > 0) sleep(3 * $round);
        $queue = $pending;
        $pending = [];
        while ($queue) {
            $batch = array_splice($queue, 0, max(1, $concurrency));
            of_pace(count($batch));
            $mh = curl_multi_init();
            $handles = [];
            foreach ($batch as $gid) {
                $ch = curl_init(OF_API_BASE . '/public/game/' . rawurlencode($gid) . '?turns=false');
                $headers = ['User-Agent: TheFrontHub-GamesSync/1.0', 'Accept: application/json'];
                if ($OF_ACCESS !== '') $headers[] = 'x-skailex-access: ' . $OF_ACCESS;
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_CONNECTTIMEOUT => 8,
                    CURLOPT_TIMEOUT        => 40,
                    CURLOPT_HTTPHEADER     => $headers,
                    CURLOPT_ENCODING       => '',
                ]);
                curl_multi_add_handle($mh, $ch);
                $handles[$gid] = $ch;
            }
            do {
                curl_multi_exec($mh, $running);
                if ($running) curl_multi_select($mh, 0.5);
            } while ($running > 0);
            foreach ($handles as $gid => $ch) {
                $body   = curl_multi_getcontent($ch);
                $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
                if ($status === 200 && is_string($body)) {
                    $d = json_decode($body, true);
                    if (is_array($d)) { $out[$gid] = $d; of_ok_nudge(); continue; }
                }
                if ($status === 429) of_on_429();
                if ($status === 404) { $out[$gid] = null; continue; } // permanent
                $pending[] = $gid;                                    // transitoire → retry
            }
            curl_multi_close($mh);
            $OF_PACE_LAST = microtime(true);
        }
    }
    foreach ($pending as $gid) $out[$gid] = null;
    return [$out, count($pending)];
}

/* ─────────────────────────── Règles speedrun (miroir extract-speedrun.js) ─────────────────────────── */

/**
 * Classifie une partie (détail API) en speedrun valide.
 * Retourne [category('normal'|'compact'|null), duration_s(int|null), winnerClientId(?string), modsCsv(?string)].
 */
function classify_speedrun(array $info): array {
    $cfg = is_array($info['config'] ?? null) ? $info['config'] : [];
    if (($cfg['gameType'] ?? null) !== 'Public')            return [null, null, null, null];
    if (($cfg['gameMode'] ?? null) !== 'Free For All')      return [null, null, null, null];

    $isCompact = null;
    if (($cfg['gameMapSize'] ?? null) === 'Compact' && (int)($cfg['bots'] ?? 0) === 100)      $isCompact = true;
    elseif (($cfg['gameMapSize'] ?? null) === 'Normal' && (int)($cfg['bots'] ?? 0) === 400)  $isCompact = false;
    else return [null, null, null, null];

    $mods = is_array($cfg['publicGameModifiers'] ?? null) ? $cfg['publicGameModifiers'] : [];
    $active = [];
    foreach ($mods as $k => $v) { if ($v) $active[] = (string)$k; }
    if ($isCompact) {
        // Compact : seul isCompact autorisé
        foreach ($active as $a) if ($a !== 'isCompact') return [null, null, null, null];
    } else {
        // Normal : aucun mod
        if ($active) return [null, null, null, null];
    }

    // Anti-cheat (miroir extract-speedrun.js)
    if (($cfg['randomSpawn'] ?? false) === true)   return [null, null, null, null];
    if (($cfg['donateGold'] ?? false) === true)    return [null, null, null, null];
    if (($cfg['donateTroops'] ?? false) === true)  return [null, null, null, null];
    if (!empty($cfg['infiniteGold']))              return [null, null, null, null];
    if (!empty($cfg['infiniteTroops']))            return [null, null, null, null];
    if (!empty($cfg['instantBuild']))              return [null, null, null, null];
    if (isset($cfg['startingGold']) && $cfg['startingGold'] !== null && (int)$cfg['startingGold'] !== 0) return [null, null, null, null];
    if (isset($cfg['goldMultiplier']) && $cfg['goldMultiplier'] !== null && (int)$cfg['goldMultiplier'] !== 1) return [null, null, null, null];

    $players = is_array($info['players'] ?? null) ? $info['players'] : [];
    $minHumans = $isCompact ? 3 : 10;
    if (count($players) < $minHumans) return [null, null, null, null];

    $winner = $info['winner'] ?? null;
    if (!is_array($winner) || count($winner) < 2) return [null, null, null, null];
    $winnerKind = (string)$winner[0];
    if ($winnerKind !== 'player') return [null, null, null, null]; // team/nation exclus (FFA)
    $winnerCid = (string)$winner[1];
    $winnerPlayer = null;
    foreach ($players as $p) {
        if (($p['clientID'] ?? null) === $winnerCid) { $winnerPlayer = $p; break; }
    }
    if (!is_array($winnerPlayer) || empty($winnerPlayer['username'])) return [null, null, null, null];

    // Durée (secondes ; tolère les records historiques en ms)
    $dur = null;
    if (isset($info['duration']) && is_numeric($info['duration'])) {
        $d = (int)$info['duration'];
        $dur = $d > 100000 ? (int)round($d / 1000) : $d;
    } elseif (isset($info['start'], $info['end']) && is_numeric($info['start']) && is_numeric($info['end'])) {
        $diff = (int)$info['end'] - (int)$info['start'];
        $dur  = $diff > 100000 ? (int)round($diff / 1000) : $diff;
    }
    if ($dur === null || $dur < 60) return [null, null, null, null];
    $dur = max(0, $dur - TIME_OFFSET_S);

    return [$isCompact ? 'compact' : 'normal', $dur, $winnerCid, $active ? implode(',', array_slice($active, 0, 6)) : null];
}

/* ─────────────────────────── Ingestion d'une partie ─────────────────────────── */

/**
 * Ingeste un détail de partie. $listMeta = métadonnées de la liste /public/games (peut être []).
 * Retourne 1 si nouvelle partie ingérée, 0 sinon (déjà présente / invalide).
 */
function ingest_game(PDO $pdo, string $gameId, array $detail, array $listMeta, array $cfg, array &$unameCache): int {
    $info = is_array($detail['info'] ?? null) ? $detail['info'] : null;
    if ($info === null) return 0;
    $cfgG = is_array($info['config'] ?? null) ? $info['config'] : [];
    $players = is_array($info['players'] ?? null) ? $info['players'] : [];
    if (!$players) return 0;

    // Guard : partie déjà ingérée ?
    $chk = $pdo->prepare('SELECT 1 FROM tfh_g_games WHERE game_id = ?');
    $chk->execute([$gameId]);
    if ($chk->fetch()) return 0;

    // ── Timing ──
    $startMs = null;
    if (isset($info['start']) && is_numeric($info['start'])) $startMs = (int)$info['start'];
    elseif (isset($listMeta['start'])) { $t = strtotime((string)$listMeta['start']); if ($t !== false) $startMs = $t * 1000; }
    if ($startMs === null) return 0;
    $endMs = null;
    if (isset($info['end']) && is_numeric($info['end'])) $endMs = (int)$info['end'];
    elseif (isset($listMeta['end'])) { $t = strtotime((string)$listMeta['end']); if ($t !== false) $endMs = $t * 1000; }
    $durationS = null;
    if (isset($info['duration']) && is_numeric($info['duration'])) {
        $d = (int)$info['duration'];
        $durationS = $d > 100000 ? (int)round($d / 1000) : $d;
    } elseif ($endMs !== null) {
        $durationS = (int)round(($endMs - $startMs) / 1000);
    }

    // ── Winner ──
    $winner = $info['winner'] ?? null;
    $winnerKind = null; $winnerPid = null; $winnerUnameId = null;
    $winnerCids = [];
    if (is_array($winner) && count($winner) >= 2) {
        $winnerKind = (string)$winner[0];
        if ($winnerKind === 'player') {
            $winnerCids = [(string)$winner[1]];
        } elseif ($winnerKind === 'team') {
            foreach (array_slice($winner, 2) as $cid) $winnerCids[] = (string)$cid;
        }
    }

    // ── Speedrun ──
    [$srCat, $srDur, $srWinCid, $modsCsv] = classify_speedrun($info);

    // ── Colonnes simples ──
    $gt = (string)($listMeta['type'] ?? $cfgG['gameType'] ?? 'Public');
    $gm = (string)($listMeta['mode'] ?? $cfgG['gameMode'] ?? '');
    $rt = (string)($listMeta['rankedType'] ?? $cfgG['rankedType'] ?? 'unranked');
    $pt = isset($listMeta['playerTeams']) ? (string)$listMeta['playerTeams'] : (isset($cfgG['playerTeams']) ? (string)$cfgG['playerTeams'] : null);
    $map = cut((string)($cfgG['gameMap'] ?? ($listMeta['map'] ?? '')), 48);
    $gitc = cut((string)($detail['gitCommit'] ?? ''), 16);

    $pdo->beginTransaction();
    try {
        $ins = $pdo->prepare('INSERT IGNORE INTO tfh_g_games
            (game_id, started_at, ended_at, duration_s, game_type, game_mode, ranked_type, player_teams,
             game_map, map_size, difficulty, bots, num_players, max_players, lobby_fill_time,
             winner_kind, winner_public_id, winner_username_id, speedrun_category, speedrun_duration_s, mods, git_commit)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        $ins->execute([
            $gameId,
            ms_to_dt($startMs),
            $endMs !== null ? ms_to_dt($endMs) : null,
            $durationS,
            $gt, $gm, $rt, $pt,
            $map !== '' ? $map : null,
            isset($cfgG['gameMapSize']) ? cut((string)$cfgG['gameMapSize'], 16) : null,
            isset($cfgG['difficulty']) ? cut((string)$cfgG['difficulty'], 16) : null,
            isset($cfgG['bots']) && is_numeric($cfgG['bots']) ? (int)$cfgG['bots'] : null,
            isset($listMeta['numPlayers']) && $listMeta['numPlayers'] !== null ? (int)$listMeta['numPlayers'] : count($players),
            isset($cfgG['maxPlayers']) && is_numeric($cfgG['maxPlayers']) ? (int)$cfgG['maxPlayers'] : null,
            isset($listMeta['lobbyFillTime']) && is_numeric($listMeta['lobbyFillTime']) ? (int)$listMeta['lobbyFillTime'] : null,
            $winnerKind,
            null, null, // remplis après résolution roster
            $srCat, $srDur, $modsCsv, $gitc !== '' ? $gitc : null,
        ]);
        if ($ins->rowCount() === 0) { $pdo->rollBack(); return 0; } // course inter-process

        // ── Roster + joueurs + alias ──
        $rosterIns = $pdo->prepare('INSERT IGNORE INTO tfh_g_roster (game_id, client_id, public_id, username_id, won, stats_json) VALUES (?,?,?,?,?,?)');
        $nowDt = ms_to_dt($startMs);
        $statsMode = (string)$cfg['player_stats_mode'];
        $storeStats = $statsMode === 'all'
            || ($statsMode === 'subset' && ($srCat !== null || $rt !== 'unranked'));

        $winnerPidResolved = null; $winnerUnameIdResolved = null;
        foreach ($players as $p) {
            if (!is_array($p)) continue;
            $cid = (string)($p['clientID'] ?? '');
            $uname = cut((string)($p['username'] ?? ''), 64);
            if ($cid === '' || $uname === '') continue;
            $pid  = isset($p['publicID']) && is_string($p['publicID']) && $p['publicID'] !== '' ? cut($p['publicID'], 16) : null;
            $uid  = username_id($pdo, $uname, $unameCache);
            $won  = in_array($cid, $winnerCids, true) ? 1 : 0;
            $sj   = null;
            if ($storeStats && isset($p['stats']) && is_array($p['stats'])) {
                $sj = json_encode($p['stats'], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            }
            $rosterIns->execute([$gameId, $cid, $pid, $uid, $won, $sj]);

            if ($winnerKind === 'player' && $cid === $winnerCids[0]) {
                $winnerPidResolved = $pid; $winnerUnameIdResolved = $uid;
            }

            if ($pid !== null) {
                // Pré-profil : upsert joueur + compteurs
                $pdo->prepare('INSERT INTO tfh_g_players (public_id, last_username, first_seen, last_seen, last_game_id, games_count, wins_count)
                    VALUES (?,?,?,?,?,1,?)
                    ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), last_game_id = VALUES(last_game_id),
                        games_count = games_count + 1, wins_count = wins_count + VALUES(wins_count),
                        deleted_at = NULL')
                    ->execute([$pid, $uname, $nowDt, $nowDt, $gameId, $won]);
                // Alias
                $pdo->prepare('INSERT INTO tfh_g_aliases (public_id, username_id, first_seen, last_seen, times_used)
                    VALUES (?,?,?,?,1)
                    ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), times_used = times_used + 1')
                    ->execute([$pid, $uid, $nowDt, $nowDt]);
            }
        }
        if ($winnerPidResolved !== null || $winnerUnameIdResolved !== null) {
            $pdo->prepare('UPDATE tfh_g_games SET winner_public_id = ?, winner_username_id = ? WHERE game_id = ?')
                ->execute([$winnerPidResolved, $winnerUnameIdResolved, $gameId]);
        }
        $pdo->commit();
        return 1;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

/* ─────────────────────────── Scan d'une plage temporelle ─────────────────────────── */

/**
 * Liste + ingère les parties de [startMs, endMs] pour UN type donné
 * (Public, Private…). Respecte $deadline.
 * $startOffset : reprise intra-fenêtre (offset de pagination).
 * $onProgress : callable(int $offset) appelé après chaque page traitée.
 * $gameType   : valeur du paramètre type de /public/games.
 *
 * v3 : retourne [ingérées, vues, complète]. complète=false si une page liste
 * a échoué, si des détails restent en échec transitoire, ou si le budget du
 * tick s'est écoulé avant la fin → l'appelant NE doit PAS avancer son
 * curseur (la fenêtre sera reprise au prochain tick, dédup par la base).
 */
function scan_range(PDO $pdo, int $startMs, int $endMs, array $cfg, float $deadline, array &$unameCache, string $label, int $startOffset = 0, ?callable $onProgress = null, string $gameType = 'Public'): array {
    $ingested = 0; $seen = 0;
    $limit = (int)$cfg['list_limit'];
    $minPlayers = max(0, (int)($cfg['min_players_to_keep'] ?? 1));
    $chunkSize = max(1, (int)$cfg['detail_concurrency']) * 4;

    for ($offset = $startOffset; $offset <= (int)$cfg['list_max_offset']; $offset += $limit) {
        if (microtime(true) >= $deadline) return [$ingested, $seen, false];
        $url = OF_API_BASE . '/public/games?start=' . rawurlencode(gmdate('Y-m-d\TH:i:s\Z', intdiv($startMs, 1000)))
             . '&end=' . rawurlencode(gmdate('Y-m-d\TH:i:s\Z', intdiv($endMs, 1000)))
             . '&type=' . rawurlencode($gameType) . '&limit=' . $limit . '&offset=' . $offset;
        [$status, $games] = of_request($url, 30);
        if ($status !== 200 || !is_array($games)) {
            log_line("[$label] page liste $gameType offset=$offset : échec HTTP $status — reprise au prochain tick");
            return [$ingested, $seen, false];
        }

        $candidates = [];
        foreach ($games as $g) {
            if (!is_array($g) || empty($g['game'])) continue;
            $np = $g['numPlayers'] ?? null;
            if ($np !== null && $np !== '' && (int)$np < $minPlayers) continue; // lobbies vides/abandonnés
            $candidates[(string)$g['game']] = $g;
        }
        $seen += count($candidates);

        // Détails (nouvelles parties uniquement) — 2 passes : check DB puis fetch multi
        $todo = [];
        $chk = $pdo->prepare('SELECT 1 FROM tfh_g_games WHERE game_id = ?');
        foreach (array_keys($candidates) as $gid) {
            $chk->execute([$gid]);
            if (!$chk->fetch()) $todo[] = $gid;
        }
        foreach (array_chunk($todo, $chunkSize) as $chunk) {
            if (microtime(true) >= $deadline) return [$ingested, $seen, false];
            [$details, $tfail] = of_details_multi($chunk, (int)$cfg['detail_concurrency']);
            foreach ($chunk as $gid) {
                $d = $details[$gid] ?? null;
                if ($d === null) continue;
                try {
                    $ingested += ingest_game($pdo, $gid, $d, $candidates[$gid], $cfg, $unameCache);
                } catch (Throwable $e) {
                    log_line("[$label] ⚠️ $gid : " . cut($e->getMessage(), 120));
                }
            }
            if ($tfail > 0) {
                // Échecs transitoires : on NE valide PAS la page → elle sera
                // rejouée au prochain tick (dédup par la base : seuls les
                // détails manquants seront refetchés).
                log_line("[$label] $tfail détail(s) en échec transitoire (page offset=$offset) — reprise au prochain tick");
                return [$ingested, $seen, false];
            }
            if ($onProgress !== null) $onProgress($offset + $limit); // offset de la PROCHAINE page
        }
        if ($onProgress !== null && count($todo) === 0) $onProgress($offset + $limit);

        if (count($games) < $limit) return [$ingested, $seen, true]; // dernière page → fenêtre complète
    }
    // list_max_offset atteint (garde-fou historique) : fenêtre considérée traitée
    return [$ingested, $seen, true];
}

/* ─────────────────────────── Commandes spéciales ─────────────────────────── */

if ($argStatus) {
    $cnt = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_games) AS games,
        (SELECT COUNT(*) FROM tfh_g_roster) AS roster,
        (SELECT COUNT(*) FROM tfh_g_players) AS players,
        (SELECT COUNT(*) FROM tfh_g_games WHERE speedrun_category IS NOT NULL) AS speedruns')->fetch();
    $oldest = $pdo->query('SELECT MIN(started_at) AS o FROM tfh_g_games')->fetchColumn();
    $newest = $pdo->query('SELECT MAX(started_at) AS n FROM tfh_g_games')->fetchColumn();
    echo json_encode([
        'ok' => true,
        'games' => (int)$cnt['games'],
        'roster_rows' => (int)$cnt['roster'],
        'players' => (int)$cnt['players'],
        'speedruns' => (int)$cnt['speedruns'],
        'oldest_game' => $oldest,
        'newest_game' => $newest,
        'recent_end_ms' => state_get($pdo, STATE_KEY_RECENT),
        'backfill_cursor_ms' => state_get($pdo, STATE_KEY_BACKFIL),
        'backfill_done' => (int)state_get($pdo, STATE_KEY_BACKFIL, (string)GAMES_EPOCH_MS) <= GAMES_EPOCH_MS,
        'detail_rate_per_s' => (float)state_get($pdo, 'of_rate_cur', '3'),
        'http_429_total' => (int)state_get($pdo, 'of_429_total', '0'),
        'http_err_total' => (int)state_get($pdo, 'of_err_total', '0'),
    ], JSON_PRETTY_PRINT) . "\n";
    exit(0);
}

if ($argReset) {
    state_set($pdo, STATE_KEY_BACKFIL, (string)(round(microtime(true) * 1000)));
    log_line('[reset] curseur backfill repositionné à maintenant');
    exit(0);
}

if ($argSince !== '') {
    $t = strtotime($argSince);
    if ($t === false) { fwrite(STDERR, "[since] date invalide\n"); exit(1); }
    $ms = $t * 1000;
    if ($ms < GAMES_EPOCH_MS) $ms = GAMES_EPOCH_MS;
    state_set($pdo, STATE_KEY_BACKFIL, (string)$ms);
    log_line('[since] curseur backfill = ' . $argSince);
    exit(0);
}

/* ─────────────────────────── Tick principal ─────────────────────────── */

$unameCache = [];
$totalIngested = 0;

// v3 : débit détail AIMD — repris de l'état du tick précédent
$OF_RATE_MAX = max(1.0, (float)$cfg['detail_rate_max_per_s']);
$OF_RATE = max(0.5, min($OF_RATE_MAX, (float)state_get($pdo, 'of_rate_cur', (string)$cfg['detail_rate_start_per_s'])));

// 1) Purge quotidienne des joueurs supprimés (tombstone)
$lastDel = (int)state_get($pdo, STATE_KEY_DELETER, '0');
if (time() - $lastDel > 86400) {
    $sinceIso = $lastDel > 0 ? gmdate('Y-m-d\TH:i:s\Z', $lastDel) : gmdate('Y-m-d\TH:i:s\Z', time() - 86400);
    $deleted = of_get(OF_API_BASE . '/public/players/recently-deleted?since=' . rawurlencode($sinceIso));
    if (is_array($deleted)) {
        $n = 0;
        foreach ($deleted as $row) {
            $pid = (string)($row['publicId'] ?? '');
            if ($pid === '') continue;
            if ($cfg['hard_delete']) {
                $pdo->prepare('DELETE FROM tfh_g_roster WHERE public_id = ?')->execute([$pid]);
                $pdo->prepare('DELETE FROM tfh_g_aliases WHERE public_id = ?')->execute([$pid]);
                $pdo->prepare('DELETE FROM tfh_g_players WHERE public_id = ?')->execute([$pid]);
            } else {
                $pdo->prepare('UPDATE tfh_g_players SET deleted_at = COALESCE(deleted_at, NOW()) WHERE public_id = ?')->execute([$pid]);
            }
            $n++;
        }
        state_set($pdo, STATE_KEY_DELETER, (string)time());
        log_line("[deletions] $n joueur(s) supprimé(s) traité(s)");
    }
}

// 2) Scan récent (depuis le dernier état, chevauchement inclus) — tous les types
$nowMs = (int)round(microtime(true) * 1000);
$recentEnd = (int)state_get($pdo, STATE_KEY_RECENT, (string)($nowMs - 3 * 3600 * 1000));
$recentStart = $recentEnd - (int)$cfg['recent_overlap_min'] * 60 * 1000;
if ($recentStart < $nowMs) {
    $ingTotal = 0; $seenTotal = 0; $recentComplete = true;
    foreach ($GAME_TYPES as $gt) {
        if (microtime(true) >= $deadline) { $recentComplete = false; break; }
        [$ing, $seen, $ok] = scan_range($pdo, $recentStart, $nowMs, $cfg, $deadline, $unameCache, 'recent', 0, null, $gt);
        $ingTotal += $ing; $seenTotal += $seen;
        if (!$ok) $recentComplete = false;
    }
    $totalIngested += $ingTotal;
    log_line("[recent] fenêtre " . gmdate('m-d H:i', intdiv($recentStart, 1000)) . " → maintenant : $ingTotal nouvelle(s) partie(s) ($seenTotal vues, types " . implode('+', $GAME_TYPES) . ')');
    // v3 : on n'avance le curseur récent QUE si la fenêtre est intégralement traitée
    if ($recentComplete && microtime(true) < $deadline) state_set($pdo, STATE_KEY_RECENT, (string)$nowMs);
}

// 3) Backfill historique (newest → oldest jusqu'à l'epoch publicID)
//    Reprise intra-fenêtre : l'offset de pagination est persisté après chaque
//    page (une fenêtre de 2 jours ne tient pas dans un tick de 240 s).
//    v2 : la fenêtre est parcourue pour CHAQUE type (Public puis Private),
//    le type en cours est persisté pour reprendre au bon endroit.
const BK_WIN_START = 'backfill_window_start_ms';
const BK_WIN_TYPE  = 'backfill_window_type';
const BK_WIN_OFF   = 'backfill_window_offset';
const BK_WIN_TRIES = 'backfill_window_tries';

/* Changement de périmètre / moteur d'ingestion → re-backfill automatique.
 * v3 (2026-09-24) : moteur HTTP fiable (pacing AIMD + retries + curseur
 * strict). Le curseur repart de « maintenant » pour ré-ingérer TOUT
 * l'historique V34 (idempotent : les parties déjà en base ne sont pas
 * dupliquées, seuls les manquants des passages v2/v3 sont refetchés).
 * v4 : corrige le bug des fenêtres abandonnées — une fenêtre de 2 jours
 * (~50 000 détails) était abandonnée après 5 ticks (~7 % traités) et le
 * curseur avançait quand même → ~90 % de parties perdues par fenêtre.
 * Fenêtres de 6 h + 30 essais : une fenêtre est quasi toujours finie
 * avant l'abandon, et une perte éventuelle est bornée à 6 h d'historique. */
const SCOPE_VER_KEY = 'ingest_scope_ver';
const SCOPE_VER     = '4';
if (state_get($pdo, SCOPE_VER_KEY) !== SCOPE_VER) {
    state_set($pdo, STATE_KEY_BACKFIL, (string)$nowMs);
    state_set($pdo, BK_WIN_START, '0');
    state_set($pdo, BK_WIN_TYPE, '');
    state_set($pdo, BK_WIN_OFF, '0');
    state_set($pdo, SCOPE_VER_KEY, SCOPE_VER);
    log_line('[scope] v' . SCOPE_VER . ' activée (' . implode('+', $GAME_TYPES) . ', ≥' . $MIN_KEEP . ' joueur) — re-backfill complet relancé depuis maintenant');
}

$cursor = (int)state_get($pdo, STATE_KEY_BACKFIL, (string)$nowMs);
$windowMs = (int)round((float)$cfg['window_days'] * 86400 * 1000);
$windowsDone = 0;
while (microtime(true) < $deadline && $cursor - $windowMs >= GAMES_EPOCH_MS - 3600 * 1000) {
    $wEnd = $cursor;
    $wStart = max($cursor - $windowMs, GAMES_EPOCH_MS);
    // Reprise : si la fenêtre en cours est la même, on reprend au type et à
    // l'offset persistés (sinon on démarre au premier type, offset 0)
    $savedWinStart = (int)state_get($pdo, BK_WIN_START, '0');
    $savedWinType  = (string)state_get($pdo, BK_WIN_TYPE, '');
    $typeStart = ($savedWinStart === $wStart && in_array($savedWinType, $GAME_TYPES, true))
        ? max(0, array_search($savedWinType, $GAME_TYPES, true)) : 0;
    $resumeOffset = ($savedWinStart === $wStart) ? (int)state_get($pdo, BK_WIN_OFF, '0') : 0;
    $winIng = 0; $winSeen = 0; $winComplete = true;
    for ($ti = $typeStart; $ti < count($GAME_TYPES) && microtime(true) < $deadline; $ti++) {
        $gt = $GAME_TYPES[$ti];
        $startOffset = ($ti === $typeStart) ? $resumeOffset : 0;
        state_set($pdo, BK_WIN_START, (string)$wStart);
        state_set($pdo, BK_WIN_TYPE, $gt);
        state_set($pdo, BK_WIN_OFF, (string)$startOffset);
        [$ing, $seen, $ok] = scan_range(
            $pdo, $wStart, $wEnd, $cfg, $deadline, $unameCache, 'backfill', $startOffset,
            function (int $nextOffset) use ($pdo) {
                state_set($pdo, BK_WIN_OFF, (string)$nextOffset);
            },
            $gt
        );
        $winIng += $ing; $winSeen += $seen;
        if (!$ok) { $winComplete = false; break; } // v3 : échec → on NE recule PAS le curseur
    }
    $totalIngested += $winIng;
    if (!$winComplete) {
        $tries = (int)state_get($pdo, BK_WIN_TRIES, '0') + 1;
        state_set($pdo, BK_WIN_TRIES, (string)$tries);
        $maxTries = max(5, (int)($cfg['bk_window_max_tries'] ?? 30));
        if ($tries >= $maxTries) {
            // Garde-fou anti-blocage : après $maxTries ticks incomplets sur la
            // même fenêtre (30 = ~2 h de traitement), on l'abandonne (perte
            // assumée, bornée à 6 h d'historique, et tracée) pour ne pas
            // bloquer définitivement le curseur sur un jeu récalcitrant.
            log_line('[backfill] ⚠️ fenêtre ' . gmdate('Y-m-d', intdiv($wStart, 1000)) . " abandonnée après $tries ticks incomplets ($winIng ingérée(s), $winSeen vue(s)) — curseur avancé quand même");
            state_set($pdo, BK_WIN_TRIES, '0');
            state_set($pdo, BK_WIN_START, '0');
            state_set($pdo, BK_WIN_OFF, '0');
            $cursor = $wStart;
            state_set($pdo, STATE_KEY_BACKFIL, (string)$cursor);
            $windowsDone++;
        } else {
            log_line('[backfill] fenêtre ' . gmdate('Y-m-d', intdiv($wStart, 1000)) . " incomplète (essai $tries/5, $winIng ingérée(s)) — reprise au prochain tick");
        }
        break; // pas d'autre fenêtre ce tick — on reprendra celle-ci
    }
    $windowsDone++;
    state_set($pdo, BK_WIN_TRIES, '0');
    state_set($pdo, BK_WIN_START, '0');
    state_set($pdo, BK_WIN_OFF, '0');
    $cursor = $wStart;
    state_set($pdo, STATE_KEY_BACKFIL, (string)$cursor);
    log_line('[backfill] fenêtre ' . gmdate('Y-m-d', intdiv($wStart, 1000)) . " ✅ : $winIng partie(s) ($winSeen vues) — curseur " . gmdate('Y-m-d', intdiv($cursor, 1000)));
}
if ($windowsDone > 0 && $cursor <= GAMES_EPOCH_MS + 3600 * 1000) {
    log_line('[backfill] ✅ epoch publicID atteinte');
}

// Résumé + persistance des stats HTTP (visibilité rate limits)
// v4.1 : tick sans le moindre 429 → le débit remonte au moins au niveau de
// départ (élasticité rapide après un passage au plancher AIMD).
$rateStart = max(0.5, (float)$cfg['detail_rate_start_per_s']);
if ($OF_STATS['r429'] === 0 && $OF_RATE < $rateStart) {
    $OF_RATE = min($OF_RATE_MAX, $rateStart);
    $OF_OK_RUN = 0;
}
$done = $cursor <= GAMES_EPOCH_MS + 3600 * 1000;
state_set($pdo, 'of_rate_cur', (string)round($OF_RATE, 2));
state_set($pdo, 'of_429_total', (string)((int)state_get($pdo, 'of_429_total', '0') + $OF_STATS['r429']));
state_set($pdo, 'of_err_total', (string)((int)state_get($pdo, 'of_err_total', '0') + $OF_STATS['err']));
log_line("[fin] $totalIngested partie(s) ingérée(s) — $windowsDone fenêtre(s) backfill — HTTP ok:{$OF_STATS['ok']} 429:{$OF_STATS['r429']} err:{$OF_STATS['err']} — débit détail " . round($OF_RATE, 1) . '/s — backfill ' . ($done ? 'TERMINÉ' : 'en cours (' . gmdate('Y-m-d', intdiv($cursor, 1000)) . ')'));
