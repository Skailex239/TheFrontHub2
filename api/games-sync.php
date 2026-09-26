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
 *   v5.0 (2026-09-25) — « TOUT STOCKER, TOUT RELIER ». Migrations additives
 *   (aucun reset, aucune perte) :
 *     • Débit détail : plafond AIMD 2 → 10 req/s (plafond officiel révélé par
 *       evan [OF] : ~250 req/10 s ; on reste à 40 %, AIMD toujours actif).
 *       Démarrage plancher dur à 3 req/s (v5 ignore les secrets < 3/10).
 *     • stats par joueur stockées pour TOUTES les parties (fin du mode subset).
 *     • Roster enrichi : clan_tag, is_lobby_creator, persistent_id,
 *       cosmetics_json (pattern+palette, couronne, drapeau, effets).
 *     • Games enrichies : version, num_turns, config_json (config complète).
 *     • ENRICHISSEMENT : les ~124k parties antérieures sont re-détaillées
 *       (v5_done=0 → 1) pour remplir les nouvelles colonnes + agrégats.
 *     • REPLAYS : stockage gzip du turn-by-turn (tfh_g_turns, LONGBLOB),
 *       plafonds par tick (jeux + octets), réessais bornés (5).
 *     • RATING : Glicko-2 (3 boards ffa/team/ranked), curseur chronologique,
 *       historique par partie (tfh_g_ratings + tfh_g_rating_history).
 *     • CATALOGUE cosmétiques : snapshot api /cosmetics.json toutes les 6 h.
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
 *                "detail_concurrency": 6, "player_stats_mode": "all",
 *                "turns_enabled": true, "turns_max_games_per_tick": 30 } }
 *
 *   NB : l'ancienne clé "min_players" (v1) est ignorée — la nouvelle clé
 *   "min_players_to_keep" la remplace (défaut 1).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Forbidden (CLI only)');
}

error_reporting(E_ALL & ~E_DEPRECATED);
ini_set('display_errors', '0');
/* v5.2 : log fichier lisible à distance (route=synclog) + capture des fatals. */
$_TFH_LOG = __DIR__ . '/games-sync.log';
ini_set('error_log', $_TFH_LOG);
register_shutdown_function(function () use ($_TFH_LOG) {
    $e = error_get_last();
    if ($e && in_array((int)$e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        @file_put_contents($_TFH_LOG, '[' . gmdate('H:i:s') . '] 💥 FATAL: ' . cut_txt($e['message'], 300) . ' @ ' . $e['file'] . ':' . $e['line'] . "\n", FILE_APPEND);
    }
});
function cut_txt(string $s, int $n): string { return function_exists('mb_substr') ? mb_substr($s, 0, $n, 'UTF-8') : substr($s, 0, $n); }
ini_set('memory_limit', '1G');   // v5.1 : 512M → 1G (les replays géants peuvent dépasser 512M au décodage)
/* v5.1 : heartbeat + garde-fous par phase — chaque phase trace son état dans
 * tfh_g_state (v5_phase / v5_phase_at) visible via route=status, et un échec
 * dans une phase ne tue plus le tick (les autres continuent, l'état final
 * est toujours sauvegardé). */

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
    'detail_concurrency'  => 6,       // v5 : appels /public/game/:id en parallèle (débit 10 req/s atteignable)
    'player_stats_mode'   => 'all',   // v5 : stats par joueur stockées pour TOUTES les parties
    'tick_budget'         => 300,     // v5.6 : 300 s (5 min) — marge sous le watchdog de l'hôte
    'recent_overlap_min'  => 10,
    'window_days'         => 0.25,    // fenêtre backfill 6 h : finissable en 1-2 ticks → abandons rarissimes, pertes bornées
    'list_limit'          => 1000,
    'list_max_offset'     => 40000,   // garde-fou pagination
    'hard_delete'         => false,   // purge réelle des joueurs supprimés ?
    'detail_rate_start_per_s' => 2.0,   // v5.7 : retour au profil éprouvé 2 req/s — le plafond officiel (~25 req/s) ne s'applique PAS à notre IP mutualisée (429 mesurés dès 4 req/s)
    'detail_rate_max_per_s'   => 2.0,   // v5.7 : plafond AIMD 2 req/s (empirique, stable depuis v4.2 : 0 erreur sur 130k+ requêtes)
    'turns_enabled'            => true, // v5 : stockage des replays (turn-by-turn gzip)
    'turns_max_games_per_tick' => 10,   // v5.7 : 10/tick au régime 2 req/s
    'turns_max_bytes_per_tick' => 83886080, // v5 : 80 Mo gz max par tick
    'enrich_max_games_per_tick'=> 400,  // v5 : anciennes parties enrichies par tick
    'catalog_refresh_hours'    => 6,    // v5 : rafraîchissement catalogue cosmétiques
    'rating_seconds_per_tick'  => 60,   // v5 : budget Glicko-2 par tick
    'rating_games_per_tick'    => 300,  // v5.7 : lots courts au régime 2 req/s
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
const STATE_KEY_ENRICH  = 'enrich_cursor_ms';   // v5 (réservé)
const STATE_KEY_TURNS   = 'turns_cursor_ms';    // v5 (réservé)
const STATE_KEY_RATING  = 'rating_cursor_ms';   // v5 : parties antérieures à ce started_at déjà notées

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

/* v5.3 : lock versionné — si un processus zombie d'une version antérieure
 * retient l'ancien lock, les nouveaux ticks tournent quand même (l'ingestion
 * est idempotente : INSERT IGNORE + dédup partout). */
$lockFile = sys_get_temp_dir() . '/tfh-games-sync-v5.lock';
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

/* ─────────────── v5 : migration additive (idempotente, aucun reset) ─────────────── */

function tfh_col_exists(PDO $pdo, string $table, string $col): bool {
    $st = $pdo->prepare("SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?");
    $st->execute([$table, $col]);
    return (int)$st->fetchColumn() > 0;
}
function tfh_idx_exists(PDO $pdo, string $table, string $idx): bool {
    $st = $pdo->prepare("SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?");
    $st->execute([$table, $idx]);
    return (int)$st->fetchColumn() > 0;
}
function tfh_add_col(PDO $pdo, string $table, string $col, string $ddl): void {
    if (!tfh_col_exists($pdo, $table, $col)) {
        $pdo->exec("ALTER TABLE `" . str_replace('`', '', $table) . "` ADD COLUMN " . $ddl);
        log_line("[schema] $table.$col ajouté");
    }
}
function tfh_add_idx(PDO $pdo, string $table, string $idx, string $ddl): void {
    if (!tfh_idx_exists($pdo, $table, $idx)) {
        $pdo->exec("ALTER TABLE `" . str_replace('`', '', $table) . "` ADD INDEX " . $ddl);
        log_line("[schema] $table.$idx ajouté");
    }
}

tfh_add_col($pdo, 'tfh_g_roster',  'clan_tag',          "`clan_tag` VARCHAR(16) NULL AFTER `public_id`");
tfh_add_col($pdo, 'tfh_g_roster',  'is_lobby_creator',  "`is_lobby_creator` TINYINT(1) NOT NULL DEFAULT 0");
tfh_add_col($pdo, 'tfh_g_roster',  'persistent_id',     "`persistent_id` VARCHAR(32) NULL");
tfh_add_col($pdo, 'tfh_g_roster',  'team_index',        "`team_index` SMALLINT NULL");
tfh_add_col($pdo, 'tfh_g_roster',  'cosmetics_json',    "`cosmetics_json` MEDIUMTEXT NULL");
tfh_add_idx($pdo, 'tfh_g_roster',  'idx_groster_clan',  "`idx_groster_clan` (`clan_tag`, `game_id`)");
tfh_add_col($pdo, 'tfh_g_games',   'version',           "`version` VARCHAR(24) NULL AFTER `git_commit`");
tfh_add_col($pdo, 'tfh_g_games',   'num_turns',         "`num_turns` INT UNSIGNED NULL AFTER `version`");
tfh_add_col($pdo, 'tfh_g_games',   'config_json',       "`config_json` MEDIUMTEXT NULL AFTER `num_turns`");
tfh_add_col($pdo, 'tfh_g_games',   'v5_done',           "`v5_done` TINYINT(1) NOT NULL DEFAULT 0 AFTER `config_json`");
tfh_add_col($pdo, 'tfh_g_games',   'turns_done',        "`turns_done` TINYINT(1) NOT NULL DEFAULT 0 AFTER `v5_done`");
tfh_add_col($pdo, 'tfh_g_games',   'turns_tries',       "`turns_tries` TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER `turns_done`");
tfh_add_idx($pdo, 'tfh_g_games',   'idx_ggames_v5',     "`idx_ggames_v5` (`v5_done`, `started_at`)");
tfh_add_idx($pdo, 'tfh_g_games',   'idx_ggames_turns',  "`idx_ggames_turns` (`turns_done`, `started_at`)");
tfh_add_col($pdo, 'tfh_g_players', 'last_clan_tag',     "`last_clan_tag` VARCHAR(16) NULL AFTER `last_username`");

$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_clans (
    clan_tag       VARCHAR(16)     NOT NULL PRIMARY KEY,
    first_seen     DATETIME        NOT NULL,
    last_seen      DATETIME        NOT NULL,
    participations INT UNSIGNED    NOT NULL DEFAULT 0,
    wins           INT UNSIGNED    NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_cosmetics (
    category       VARCHAR(12)     NOT NULL,
    name           VARCHAR(64)     NOT NULL,
    display_name   VARCHAR(80)     NULL,
    rarity         VARCHAR(12)     NULL,
    price_hard     INT UNSIGNED    NULL,
    price_cents    INT UNSIGNED    NULL,
    artist         VARCHAR(48)     NULL,
    url            VARCHAR(160)    NULL,
    affiliate_code VARCHAR(32)     NULL,
    raw_json       MEDIUMTEXT      NULL,
    first_seen     DATETIME        NOT NULL,
    last_seen      DATETIME        NOT NULL,
    PRIMARY KEY (category, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_cosmetic_wearers (
    category   VARCHAR(12)     NOT NULL,
    name       VARCHAR(64)     NOT NULL,
    public_id  VARCHAR(16)     NOT NULL,
    times_worn INT UNSIGNED    NOT NULL DEFAULT 0,
    first_worn DATETIME        NOT NULL,
    last_worn  DATETIME        NOT NULL,
    PRIMARY KEY (category, name, public_id),
    INDEX idx_gcw_pid (public_id),
    INDEX idx_gcw_last (category, name, last_worn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_player_stats (
    public_id      VARCHAR(16)     NOT NULL PRIMARY KEY,
    games_count    INT UNSIGNED    NOT NULL DEFAULT 0,
    wins_count     INT UNSIGNED    NOT NULL DEFAULT 0,
    survived_count INT UNSIGNED    NOT NULL DEFAULT 0,
    time_played_s  INT UNSIGNED    NOT NULL DEFAULT 0,
    ffa_games      INT UNSIGNED    NOT NULL DEFAULT 0,
    team_games     INT UNSIGNED    NOT NULL DEFAULT 0,
    ranked_games   INT UNSIGNED    NOT NULL DEFAULT 0,
    first_game_at  DATETIME        NULL,
    last_game_at   DATETIME        NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_turns (
    game_id    VARCHAR(16)     NOT NULL PRIMARY KEY,
    version    VARCHAR(24)     NULL,
    raw_bytes  INT UNSIGNED    NOT NULL DEFAULT 0,
    gz_bytes   INT UNSIGNED    NOT NULL DEFAULT 0,
    num_turns  INT UNSIGNED    NULL,
    fetched_at DATETIME        NOT NULL,
    data       LONGBLOB        NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_ratings (
    public_id  VARCHAR(16)     NOT NULL,
    board      VARCHAR(12)     NOT NULL,
    rating     DOUBLE          NOT NULL DEFAULT 1500,
    rd         DOUBLE          NOT NULL DEFAULT 350,
    volatility DOUBLE          NOT NULL DEFAULT 0.06,
    games      INT UNSIGNED    NOT NULL DEFAULT 0,
    wins       INT UNSIGNED    NOT NULL DEFAULT 0,
    peak       DOUBLE          NOT NULL DEFAULT 1500,
    peak_at    DATETIME        NULL,
    last_at    DATETIME        NULL,
    PRIMARY KEY (public_id, board),
    INDEX idx_gr_board (board, rating)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_rating_history (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    public_id  VARCHAR(16)     NOT NULL,
    board      VARCHAR(12)     NOT NULL,
    game_id    VARCHAR(16)     NOT NULL,
    started_at DATETIME(3)     NOT NULL,
    rating     DOUBLE          NOT NULL,
    rd         DOUBLE          NOT NULL,
    INDEX idx_grh_pid (public_id, board, started_at),
    INDEX idx_grh_game (game_id),
    INDEX idx_grh_board (board, started_at)
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
function log_line(string $s): void {
    fwrite(STDERR, '[' . gmdate('H:i:s') . '] ' . $s . "\n");
    @file_put_contents(__DIR__ . '/games-sync.log', '[' . gmdate('Y-m-d H:i:s') . 'Z] ' . $s . "\n", FILE_APPEND);
}

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
    sleep(2);
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
function of_details_multi(array $gameIds, int $concurrency, bool $turns = false, float $deadline = 0.0): array {
    global $OF_ACCESS, $OF_PACE_LAST;
    $out = [];
    $gone = []; // 404 permanents
    $pending = array_values($gameIds);
    for ($round = 0; $round < 3 && $pending; $round++) {
        if ($round > 0) sleep(3 * $round);
        $queue = $pending;
        $pending = [];
        while ($queue) {
            // v5.5 : un batch au-delà de la deadline devient transitoire →
            // repris au prochain tick (le fetch d'un lot ne doit jamais
            // déborder du budget : c'est ce qui bloquait la phase enrich).
            if ($deadline > 0 && microtime(true) >= $deadline) {
                $pending = $queue;
                $queue = [];
                break;
            }
            $batch = array_splice($queue, 0, max(1, $concurrency));
            of_pace(count($batch));
            $mh = curl_multi_init();
            $handles = [];
            foreach ($batch as $gid) {
                $ch = curl_init(OF_API_BASE . '/public/game/' . rawurlencode($gid) . '?turns=' . ($turns ? 'true' : 'false'));
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
                if ($status === 404) { $out[$gid] = null; $gone[] = $gid; continue; } // permanent
                $pending[] = $gid;                                    // transitoire → retry
            }
            curl_multi_close($mh);
            $OF_PACE_LAST = microtime(true);
        }
    }
    foreach ($pending as $gid) $out[$gid] = null;
    return [$out, count($pending), $gone];
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

/* ─────────────────────── v5 : normalisation + agrégats ─────────────────────── */

/** Heartbeat de diagnostic : la phase en cours est visible via route=status. */
function phase_mark(PDO $pdo, string $phase): void {
    global $OF_RATE;
    state_set($pdo, 'v5_phase', $phase);
    state_set($pdo, 'v5_phase_at', (string)time());
    if (isset($OF_RATE)) state_set($pdo, 'of_rate_cur', (string)round($OF_RATE, 2));
}

/** Compresse les cosmétiques portés d'un joueur (sans les patternData/base64). */
function norm_cosmetics(mixed $c): ?string {
    if (!is_array($c)) return null;
    $out = [];
    if (isset($c['flag']) && is_string($c['flag']) && $c['flag'] !== '') $out['flag'] = $c['flag'];
    if (isset($c['pattern']) && is_array($c['pattern'])) {
        $p = $c['pattern'];
        $pe = [];
        if (isset($p['name']) && is_string($p['name']) && $p['name'] !== '') {
            $pe['name'] = $p['name'];
            if (isset($p['colorPalette']) && is_array($p['colorPalette'])) {
                $pal = $p['colorPalette'];
                if (isset($pal['name']) && is_string($pal['name'])) $pe['palette'] = $pal['name'];
                if (isset($pal['primaryColor']) && is_string($pal['primaryColor'])) $pe['primary'] = $pal['primaryColor'];
                if (isset($pal['secondaryColor']) && is_string($pal['secondaryColor'])) $pe['secondary'] = $pal['secondaryColor'];
            }
            $out['pattern'] = $pe;
        }
    }
    foreach (['crown', 'skin'] as $k) {
        $v = $c[$k] ?? null;
        if (is_array($v)) $v = $v['name'] ?? null;
        if (is_string($v) && $v !== '') $out[$k] = $v;
    }
    if (isset($c['effects']) && is_array($c['effects'])) {
        $effs = [];
        foreach ($c['effects'] as $slot => $name) {
            if (is_string($name) && $name !== '') $effs[(string)$slot] = $name;
        }
        if ($effs) $out['effects'] = $effs;
    }
    return $out ? json_encode($out, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) : null;
}

/** Board de classement d'une partie : ffa | team | ranked. */
function rating_board(string $rankedType, ?string $playerTeams): string {
    if ($rankedType !== '' && $rankedType !== 'unranked') return 'ranked';
    $pt = strtolower(trim((string)($playerTeams ?? 'ffa')));
    return ($pt === '' || $pt === 'ffa') ? 'ffa' : 'team';
}

/** Aggrège la participation d'un tag de clan (1 ligne = 1 participation joueur). */
function agg_clan(PDO $pdo, ?string $tag, string $at, int $won): void {
    if ($tag === null || $tag === '') return;
    $pdo->prepare('INSERT INTO tfh_g_clans (clan_tag, first_seen, last_seen, participations, wins)
        VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen),
            participations = participations + 1, wins = wins + VALUES(wins)')
        /* v5.10b FIX HY093 : 5 placeholders mais 4 paramètres — il manquait le
         * "1" de participations. Chaque partie contenant au moins un joueur
         * clané échouait ENTIEREMENT (rollback game+roster+players) depuis v5.0. */
        ->execute([$tag, $at, $at, 1, $won]);
}

/** Aggrège le port d'un cosmétique par un joueur. */
function agg_cosmetics_wear(PDO $pdo, string $cosJson, string $pid, string $at): void {
    $c = json_decode($cosJson, true);
    if (!is_array($c)) return;
    $st = $pdo->prepare('INSERT INTO tfh_g_cosmetic_wearers (category, name, public_id, times_worn, first_worn, last_worn)
        VALUES (?,?,?,1,?,?)
        ON DUPLICATE KEY UPDATE times_worn = times_worn + 1, last_worn = VALUES(last_worn)');
    $items = [];
    foreach (['flag', 'crown', 'skin'] as $k) {
        if (isset($c[$k]) && is_string($c[$k]) && $c[$k] !== '') $items[] = [$k, $c[$k]];
    }
    if (isset($c['pattern']['name']) && is_string($c['pattern']['name']) && $c['pattern']['name'] !== '') {
        $items[] = ['pattern', $c['pattern']['name']];
    }
    foreach (($c['effects'] ?? []) as $effName) {
        if (is_string($effName) && $effName !== '') $items[] = ['effect', $effName];
    }
    foreach ($items as [$cat, $name]) {
        $st->execute([$cat, cut((string)$name, 64), $pid, $at, $at]);
    }
}

/** Aggrège les compteurs lifetime d'un joueur (1 appel = 1 partie jouée). */
function agg_player_stats(PDO $pdo, string $pid, string $at, int $durationS, int $won, int $survived, string $board): void {
    $pdo->prepare('INSERT INTO tfh_g_player_stats
        (public_id, games_count, wins_count, survived_count, time_played_s, ffa_games, team_games, ranked_games, first_game_at, last_game_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
            games_count = games_count + 1, wins_count = wins_count + VALUES(wins_count),
            survived_count = survived_count + VALUES(survived_count),
            time_played_s = time_played_s + VALUES(time_played_s),
            ffa_games = ffa_games + VALUES(ffa_games),
            team_games = team_games + VALUES(team_games),
            ranked_games = ranked_games + VALUES(ranked_games),
            first_game_at = IF(first_game_at IS NULL OR VALUES(first_game_at) < first_game_at, VALUES(first_game_at), first_game_at),
            last_game_at = IF(last_game_at IS NULL OR VALUES(last_game_at) > last_game_at, VALUES(last_game_at), last_game_at)')
        ->execute([
            $pid, 1, $won, $survived, max(0, $durationS),
            $board === 'ffa' ? 1 : 0, $board === 'team' ? 1 : 0, $board === 'ranked' ? 1 : 0,
            $at, $at,
        ]);
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
             winner_kind, winner_public_id, winner_username_id, speedrun_category, speedrun_duration_s, mods, git_commit,
             version, num_turns, config_json, v5_done)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)');
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
            (string)($detail['version'] ?? '') !== '' ? cut((string)$detail['version'], 24) : null,
            isset($info['num_turns']) && is_numeric($info['num_turns']) ? (int)$info['num_turns'] : null,
            $cfgG ? json_encode($cfgG, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) : null,
        ]);
        if ($ins->rowCount() === 0) { $pdo->rollBack(); return 0; } // course inter-process

        // ── Roster + joueurs + alias + v5 (clan, cosmétiques, stats lifetime) ──
        $rosterIns = $pdo->prepare('INSERT IGNORE INTO tfh_g_roster
            (game_id, client_id, public_id, username_id, won, stats_json, clan_tag, is_lobby_creator, persistent_id, cosmetics_json)
            VALUES (?,?,?,?,?,?,?,?,?,?)');
        $nowDt = ms_to_dt($startMs);
        $statsMode = (string)$cfg['player_stats_mode'];
        $storeStats = $statsMode === 'all'
            || ($statsMode === 'subset' && ($srCat !== null || $rt !== 'unranked'));
        $board = rating_board($rt, $pt);

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
            $clan = isset($p['clanTag']) && is_string($p['clanTag']) && $p['clanTag'] !== '' ? cut($p['clanTag'], 16) : null;
            $cosj = norm_cosmetics($p['cosmetics'] ?? null);
            $persistId = isset($p['persistentID']) && is_string($p['persistentID']) && $p['persistentID'] !== '' ? cut($p['persistentID'], 32) : null;
            $rosterIns->execute([$gameId, $cid, $pid, $uid, $won, $sj, $clan, !empty($p['isLobbyCreator']) ? 1 : 0, $persistId, $cosj]);

            if ($winnerKind === 'player' && $cid === $winnerCids[0]) {
                $winnerPidResolved = $pid; $winnerUnameIdResolved = $uid;
            }

            if ($pid !== null) {
                // Pré-profil : upsert joueur + compteurs
                $pdo->prepare('INSERT INTO tfh_g_players (public_id, last_username, last_clan_tag, first_seen, last_seen, last_game_id, games_count, wins_count)
                    VALUES (?,?,?,?,?,?,1,?)
                    ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), last_game_id = VALUES(last_game_id),
                        last_clan_tag = COALESCE(VALUES(last_clan_tag), last_clan_tag),
                        games_count = games_count + 1, wins_count = wins_count + VALUES(wins_count),
                        deleted_at = NULL')
                    ->execute([$pid, $uname, $clan, $nowDt, $nowDt, $gameId, $won]);
                // Alias
                $pdo->prepare('INSERT INTO tfh_g_aliases (public_id, username_id, first_seen, last_seen, times_used)
                    VALUES (?,?,?,?,1)
                    ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), times_used = times_used + 1')
                    ->execute([$pid, $uid, $nowDt, $nowDt]);
                // v5 : agrégats (clans, cosmétiques portés, stats lifetime)
                agg_clan($pdo, $clan, $nowDt, $won);
                if ($cosj !== null) agg_cosmetics_wear($pdo, $cosj, $pid, $nowDt);
                $survived = ($won === 1 || !isset($p['stats']['killedAt'])) ? 1 : 0;
                agg_player_stats($pdo, $pid, $nowDt, (int)($durationS ?? 0), $won, $survived, $board);
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
            [$details, $tfail] = of_details_multi($chunk, (int)$cfg['detail_concurrency'], false, $deadline);
            foreach ($chunk as $gid) {
                // v5.6 : deadline AUSSI pendant l'écriture (l'ingestion v5 fait
                // ~40 SQL/partie : 1000 parties = plusieurs minutes d'écriture !)
                if (microtime(true) >= $deadline) return [$ingested, $seen, false];
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

/* ─────────────────── v5 : enrichissement / replays / rating / catalogue ─────────────────── */

/**
 * Enrichit une partie EXISTANTE avec les données v5 (cosmétiques, clan, config…).
 * Les agrégats ne sont comptés QUE pour les jeux v5_done = 0 → aucun double comptage.
 */
function enrich_game(PDO $pdo, string $gameId, array $detail, array &$unameCache): int {
    $info = is_array($detail['info'] ?? null) ? $detail['info'] : null;
    if ($info === null) return 0;
    $cfgG = is_array($info['config'] ?? null) ? $info['config'] : [];
    $players = is_array($info['players'] ?? null) ? $info['players'] : [];
    if (!$players) return 0;

    $startMs = isset($info['start']) && is_numeric($info['start']) ? (int)$info['start'] : null;
    if ($startMs === null) return 0;
    $durationS = null;
    if (isset($info['duration']) && is_numeric($info['duration'])) {
        $d = (int)$info['duration'];
        $durationS = $d > 100000 ? (int)round($d / 1000) : $d;
    } elseif (isset($info['end']) && is_numeric($info['end'])) {
        $durationS = (int)round(((int)$info['end'] - $startMs) / 1000);
    }

    $winner = $info['winner'] ?? null;
    $winnerKind = null; $winnerCids = [];
    if (is_array($winner) && count($winner) >= 2) {
        $winnerKind = (string)$winner[0];
        if ($winnerKind === 'player') $winnerCids = [(string)$winner[1]];
        elseif ($winnerKind === 'team') foreach (array_slice($winner, 2) as $cid) $winnerCids[] = (string)$cid;
    }

    $rt = (string)($cfgG['rankedType'] ?? 'unranked');
    $pt = isset($cfgG['playerTeams']) ? (string)$cfgG['playerTeams'] : null;
    $board = rating_board($rt, $pt);
    $nowDt = ms_to_dt($startMs);

    $pdo->beginTransaction();
    try {
        $pdo->prepare('UPDATE tfh_g_games SET version = ?, num_turns = ?, config_json = ?, v5_done = 1 WHERE game_id = ?')
            ->execute([
                (string)($detail['version'] ?? '') !== '' ? cut((string)$detail['version'], 24) : null,
                isset($info['num_turns']) && is_numeric($info['num_turns']) ? (int)$info['num_turns'] : null,
                $cfgG ? json_encode($cfgG, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) : null,
                $gameId,
            ]);

        $rosterUp = $pdo->prepare('INSERT INTO tfh_g_roster
            (game_id, client_id, public_id, username_id, won, stats_json, clan_tag, is_lobby_creator, persistent_id, cosmetics_json)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE clan_tag = VALUES(clan_tag), is_lobby_creator = VALUES(is_lobby_creator),
                persistent_id = VALUES(persistent_id), cosmetics_json = VALUES(cosmetics_json),
                stats_json = COALESCE(stats_json, VALUES(stats_json))');
        $winnerPidResolved = null; $winnerUnameIdResolved = null;
        foreach ($players as $p) {
            if (!is_array($p)) continue;
            $cid = (string)($p['clientID'] ?? '');
            $uname = cut((string)($p['username'] ?? ''), 64);
            if ($cid === '' || $uname === '') continue;
            $pid  = isset($p['publicID']) && is_string($p['publicID']) && $p['publicID'] !== '' ? cut($p['publicID'], 16) : null;
            $uid  = username_id($pdo, $uname, $unameCache);
            $won  = in_array($cid, $winnerCids, true) ? 1 : 0;
            $sj   = isset($p['stats']) && is_array($p['stats']) ? json_encode($p['stats'], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) : null;
            $clan = isset($p['clanTag']) && is_string($p['clanTag']) && $p['clanTag'] !== '' ? cut($p['clanTag'], 16) : null;
            $cosj = norm_cosmetics($p['cosmetics'] ?? null);
            $persistId = isset($p['persistentID']) && is_string($p['persistentID']) && $p['persistentID'] !== '' ? cut($p['persistentID'], 32) : null;
            $rosterUp->execute([$gameId, $cid, $pid, $uid, $won, $sj, $clan, !empty($p['isLobbyCreator']) ? 1 : 0, $persistId, $cosj]);

            if ($winnerKind === 'player' && $cid === $winnerCids[0]) {
                $winnerPidResolved = $pid; $winnerUnameIdResolved = $uid;
            }
            if ($pid !== null) {
                agg_clan($pdo, $clan, $nowDt, $won);
                if ($cosj !== null) agg_cosmetics_wear($pdo, $cosj, $pid, $nowDt);
                $survived = ($won === 1 || !isset($p['stats']['killedAt'])) ? 1 : 0;
                agg_player_stats($pdo, $pid, $nowDt, (int)($durationS ?? 0), $won, $survived, $board);
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

/** Phase d'enrichissement : re-détaille les parties antérieures à la v5. Retour [faites, restantes]. */
function enrich_phase(PDO $pdo, array $cfg, float $deadline, array &$unameCache): array {
    phase_mark($pdo, 'enrich');
    $batch = min(1500, max(10, (int)($cfg['enrich_max_games_per_tick'] ?? 150)));
    $st = $pdo->prepare('SELECT game_id FROM tfh_g_games WHERE v5_done = 0 ORDER BY started_at DESC LIMIT ' . $batch);
    $st->execute();
    $ids = $st->fetchAll(PDO::FETCH_COLUMN);
    if (!$ids) return [0, 0];
    [$details, $tfail, $gone] = of_details_multi($ids, (int)$cfg['detail_concurrency'], false, $deadline);
    if ($gone) {
        $mark = $pdo->prepare('UPDATE tfh_g_games SET v5_done = 2 WHERE game_id = ?'); // disparues → abandon définitif
        foreach ($gone as $gid) $mark->execute([$gid]);
    }
    $done = 0;
    foreach ($ids as $gid) {
        if (microtime(true) >= $deadline) break;
        $d = $details[$gid] ?? null;
        if ($d === null) continue; // transitoire → retenté au prochain tick
        try {
            $done += enrich_game($pdo, $gid, $d, $unameCache);
        } catch (Throwable $e) {
            log_line("[enrich] ⚠️ $gid : " . cut($e->getMessage(), 120));
        }
    }
    $left = (int)$pdo->query('SELECT COUNT(*) FROM tfh_g_games WHERE v5_done = 0')->fetchColumn();
    return [$done, $left];
}

/** Phase replays : stocke le turn-by-turn gzip des parties sans replay (récentes d'abord). */
function turns_phase(PDO $pdo, array $cfg, float $deadline): int {
    if (empty($cfg['turns_enabled'])) return 0;
    phase_mark($pdo, 'turns');
    $maxGames = max(1, (int)($cfg['turns_max_games_per_tick'] ?? 30));
    $maxBytes = max(1048576, (int)($cfg['turns_max_bytes_per_tick'] ?? 83886080));
    $bytesUsed = 0; $done = 0;
    $st = $pdo->prepare('SELECT game_id FROM tfh_g_games WHERE turns_done = 0 ORDER BY started_at DESC LIMIT ' . ($maxGames * 2));
    $st->execute();
    $ids = $st->fetchAll(PDO::FETCH_COLUMN);
    $ins = $pdo->prepare('INSERT INTO tfh_g_turns (game_id, version, raw_bytes, gz_bytes, num_turns, fetched_at, data)
        VALUES (?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE version = VALUES(version), raw_bytes = VALUES(raw_bytes), gz_bytes = VALUES(gz_bytes),
            num_turns = VALUES(num_turns), fetched_at = VALUES(fetched_at), data = VALUES(data)');
    $mark = $pdo->prepare('UPDATE tfh_g_games SET turns_done = ?, turns_tries = turns_tries + ? WHERE game_id = ?');
    $triesSel = $pdo->prepare('SELECT turns_tries FROM tfh_g_games WHERE game_id = ?');
    foreach ($ids as $gid) {
        if ($done >= $maxGames || $bytesUsed >= $maxBytes || microtime(true) >= $deadline) break;
        of_pace(1); // pacing global (partage le budget débit avec les détails)
        // v5.1 : fetch brut direct — on rejette les corps > 25 Mo AVANT le
        // décodage JSON pour ne jamais saturer la RAM (fatal = tick mort).
        $ch = curl_init(OF_API_BASE . '/public/game/' . rawurlencode($gid) . '?turns=true');
        $headers = ['User-Agent: TheFrontHub-GamesSync/1.0', 'Accept: application/json'];
        global $OF_ACCESS;
        if ($OF_ACCESS !== '') $headers[] = 'x-skailex-access: ' . $OF_ACCESS;
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_TIMEOUT        => 120,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_ENCODING       => '',
        ]);
        $body = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($status === 200) $OF_STATS['ok']++;
        if ($status === 404) { $mark->execute([2, 0, $gid]); continue; }
        if ($status !== 200 || !is_string($body) || $body === '') {
            if ($status === 429) of_on_429();
            $triesSel->execute([$gid]);
            $t = (int)$triesSel->fetchColumn();
            if ($t >= 4) { $mark->execute([2, 0, $gid]); log_line("[turns] ⚠️ $gid abandonné après " . ($t + 1) . " tentatives"); }
            else $mark->execute([0, 1, $gid]);
            continue;
        }
        if (strlen($body) > 26214400) { // > 25 Mo brut : trop gros, sauté (tracé)
            log_line('[turns] ⚠️ ' . $gid . ' : replay ' . round(strlen($body) / 1048576, 1) . " Mo trop volumineux — sauté");
            $mark->execute([2, 0, $gid]);
            continue;
        }
        $d = json_decode($body, true);
        unset($body);
        if (!is_array($d) || !isset($d['turns']) || !is_array($d['turns'])) {
            $triesSel->execute([$gid]);
            $t = (int)$triesSel->fetchColumn();
            if ($t >= 4) { $mark->execute([2, 0, $gid]); log_line("[turns] ⚠️ $gid abandonné après " . ($t + 1) . " tentatives"); }
            else $mark->execute([0, 1, $gid]);
            continue;
        }
        $raw = json_encode($d, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($raw === false) { $mark->execute([2, 0, $gid]); continue; }
        $gz = gzencode($raw, 1);
        if ($gz === false) { $mark->execute([2, 0, $gid]); continue; }
        $info = is_array($d['info'] ?? null) ? $d['info'] : [];
        $ins->execute([
            $gid,
            (string)($d['version'] ?? '') !== '' ? cut((string)$d['version'], 24) : null,
            strlen($raw), strlen($gz),
            isset($info['num_turns']) && is_numeric($info['num_turns']) ? (int)$info['num_turns'] : count($d['turns']),
            gmdate('Y-m-d H:i:s'),
            $gz,
        ]);
        $mark->execute([1, 0, $gid]);
        $bytesUsed += strlen($gz);
        $done++;
    }
    return $done;
}

/** Phase catalogue : snapshot du catalogue officiel des cosmétiques (throttlé). */
function catalog_phase(PDO $pdo, array $cfg): void {
    phase_mark($pdo, 'catalog');
    $hours = max(1, (int)($cfg['catalog_refresh_hours'] ?? 6));
    $last = (int)state_get($pdo, 'catalog_refreshed_at', '0');
    if (time() - $last < $hours * 3600) return;

    /* v5.10c : Cloudflare renvoie 403 sur /cosmetics.json pour les IP datacenter
     * (observé depuis o2switch alors que /public/games passe — règle WAF sur le
     * fichier statique). Deux sources en cascade :
     *   1) fetch direct avec en-têtes navigateur (contourne les règles UA) ;
     *   2) seed local data/cosmetics-seed.json (snapshot complet du 2026-09-26,
     *      base64 des patterns retiré : ~244 Ko).
     * Dans les deux cas on pose catalog_refreshed_at : plus de retry chaque tick
     * contre un 403 (4 err/tick à chaque fois avant). */
    $d = null; $src = ''; $httpSt = 0;
    $ch = curl_init(OF_API_BASE . '/cosmetics.json');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_ENCODING       => '',
        CURLOPT_HTTPHEADER     => [
            'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept: application/json, text/plain, */*',
            'Accept-Language: en-US,en;q=0.9',
            'Referer: https://openfront.io/',
        ],
    ]);
    $body = curl_exec($ch);
    $httpSt = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($httpSt === 200 && is_string($body) && $body !== '') {
        $dec = json_decode($body, true);
        if (is_array($dec)) { $d = $dec; $src = 'api'; }
    }
    if ($d === null) {
        $seed = @file_get_contents(__DIR__ . '/../data/cosmetics-seed.json');
        if (is_string($seed) && $seed !== '') {
            $dec = json_decode($seed, true);
            if (is_array($dec)) { $d = $dec; $src = "seed locale (HTTP $httpSt)"; }
        }
    }
    if ($d === null) { log_line("[catalog] catalogue indisponible (HTTP $httpSt) et seed absent/invalide"); return; }
    $now = gmdate('Y-m-d H:i:s');
    $st = $pdo->prepare('INSERT INTO tfh_g_cosmetics
        (category, name, display_name, rarity, price_hard, price_cents, artist, url, affiliate_code, raw_json, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), rarity = VALUES(rarity),
            price_hard = VALUES(price_hard), price_cents = VALUES(price_cents), artist = VALUES(artist),
            url = VALUES(url), affiliate_code = VALUES(affiliate_code), raw_json = VALUES(raw_json), last_seen = VALUES(last_seen)');
    $map = [
        'patterns' => 'pattern', 'flags' => 'flag', 'skins' => 'skin', 'crowns' => 'crown',
        'effects' => 'effect', 'colorPalettes' => 'palette', 'packs' => 'pack',
        'currencyPacks' => 'currency', 'subscriptions' => 'subscription',
    ];
    $n = 0;
    foreach ($map as $key => $cat) {
        $items = $d[$key] ?? null;
        if (!is_array($items)) continue;
        foreach ($items as $name => $item) {
            if (!is_array($item)) continue;
            $raw = $item;
            unset($raw['pattern'], $raw['patternData']); // pas de base64 volumineux en base
            $priceHard = isset($raw['priceHard']) && is_numeric($raw['priceHard']) ? (int)$raw['priceHard'] : null;
            $priceCents = isset($raw['product']['priceInCents']) && is_numeric($raw['product']['priceInCents']) ? (int)$raw['product']['priceInCents'] : null;
            $st->execute([
                $cat, cut((string)$name, 64),
                isset($raw['displayName']) && is_string($raw['displayName']) ? cut($raw['displayName'], 80) : null,
                isset($raw['rarity']) && is_string($raw['rarity']) ? cut($raw['rarity'], 12) : null,
                $priceHard, $priceCents,
                isset($raw['artist']) && is_string($raw['artist']) ? cut($raw['artist'], 48) : null,
                isset($raw['url']) && is_string($raw['url']) ? cut($raw['url'], 160) : null,
                isset($raw['affiliateCode']) && is_string($raw['affiliateCode']) ? cut($raw['affiliateCode'], 32) : null,
                json_encode($raw, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                $now, $now,
            ]);
            $n++;
        }
    }
    state_set($pdo, 'catalog_refreshed_at', (string)time());
    log_line("[catalog] $n cosmétique(s) synchronisé(s) — source $src");
}

/** Glicko-2 (Glickman) — unités internes μ/φ, échelle 173.7178. */
final class Glicko2 {
    const TAU = 0.5;
    const SCALE = 173.7178;

    public static function toMu(float $r): float { return ($r - 1500.0) / self::SCALE; }
    public static function toR(float $mu): float { return $mu * self::SCALE + 1500.0; }
    public static function toPhi(float $rd): float { return $rd / self::SCALE; }
    public static function toRd(float $phi): float { return $phi * self::SCALE; }

    private static function g(float $phi): float {
        return 1.0 / sqrt(1.0 + 3.0 * $phi * $phi / (M_PI * M_PI));
    }
    private static function expect(float $mu, float $muj, float $phij): float {
        return 1.0 / (1.0 + exp(-self::g($phij) * ($mu - $muj)));
    }
    /** $vs = [[muj, phij, score], …] → [μ', φ'] */
    public static function rate(float $mu, float $phi, array $vs): array {
        if (!$vs) return [$mu, $phi];
        $v = 0.0; $deltaSum = 0.0;
        foreach ($vs as $tuple) {
            [$muj, $phij, $s] = $tuple;
            $g = self::g($phij);
            $e = self::expect($mu, $muj, $phij);
            $v += $g * $g * $e * (1.0 - $e);
            $deltaSum += $g * ($s - $e);
        }
        if ($v <= 0.0) return [$mu, $phi];
        $delta = $deltaSum / $v;
        $a = log($phi * $phi);
        $f = function (float $x) use ($phi, $v, $delta, $a): float {
            $ex = exp($x);
            $den = 2.0 * (($phi * $phi + $v + $ex) ** 2);
            if ($den == 0.0) return 0.0;
            return ($ex * ($delta * $delta - $phi * $phi - $v - $ex)) / $den - ($x - $a) / self::TAU;
        };
        $eps = 0.000001;
        $A = $a;
        if (($delta * $delta) > ($phi * $phi + $v)) {
            $B = log($delta * $delta - $phi * $phi - $v);
        } else {
            $k = 1;
            while ($f($a - $k * self::TAU) < 0.0 && $k < 100) $k++;
            $B = $a - $k * self::TAU;
        }
        $fA = $f($A); $fB = $f($B);
        $guard = 0;
        while (abs($B - $A) > $eps && $guard++ < 200) {
            $C = $A + ($A - $B) * $fA / ($fB - $fA);
            $fC = $f($C);
            if ($fC * $fB <= 0.0) { $A = $B; $fA = $fB; } else { $fA = $fA / 2.0; }
            $B = $C; $fB = $fC;
        }
        $xStar = ($A + $B) / 2.0;
        $newPhi = exp($xStar / 2.0);
        $newMu = $mu + $newPhi * $newPhi * $delta;
        return [$newMu, $newPhi];
    }
}

/**
 * Phase rating : Glicko-2 chronologique (curseur = started_at du dernier lot).
 * 3 boards : ffa / team / ranked. Seuls les joueurs avec publicID comptent.
 */
function rating_phase(PDO $pdo, array $cfg, float $deadline): void {
    phase_mark($pdo, 'rating');
    $budget = max(5.0, (float)($cfg['rating_seconds_per_tick'] ?? 60));
    $endAt = microtime(true) + min($budget, max(5.0, $deadline - microtime(true)));
    $batchGames = min(10000, max(100, (int)($cfg['rating_games_per_tick'] ?? 800))); // v5.1 : lots courts
    $cursor = (int)state_get($pdo, STATE_KEY_RATING, (string)GAMES_EPOCH_MS);
    if ($cursor < GAMES_EPOCH_MS) $cursor = GAMES_EPOCH_MS;
    $gRated = 0; $pRated = 0;

    $histIns = $pdo->prepare('INSERT INTO tfh_g_rating_history (public_id, board, game_id, started_at, rating, rd) VALUES (?,?,?,?,?,?)');
    $seenChk = $pdo->prepare('SELECT 1 FROM tfh_g_rating_history WHERE game_id = ? LIMIT 1');
    $selState = $pdo->prepare('SELECT rating, rd, games, wins, peak, peak_at FROM tfh_g_ratings WHERE board = ? AND public_id = ?');
    $upState = $pdo->prepare('INSERT INTO tfh_g_ratings
        (public_id, board, rating, rd, volatility, games, wins, peak, peak_at, last_at)
        VALUES (?,?,?,?,0.06,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE rating = VALUES(rating), rd = VALUES(rd), games = VALUES(games), wins = VALUES(wins),
            peak = VALUES(peak), peak_at = VALUES(peak_at), last_at = VALUES(last_at)');

    while (microtime(true) < $endAt && microtime(true) < $deadline) {
        $dt = gmdate('Y-m-d H:i:s', intdiv($cursor, 1000)) . '.' . sprintf('%03d', $cursor % 1000);
        $st = $pdo->prepare('SELECT game_id, started_at, UNIX_TIMESTAMP(started_at) AS start_s, ranked_type, player_teams
            FROM tfh_g_games
            WHERE started_at >= ? AND (game_type IS NULL OR game_type <> ?)
            ORDER BY started_at ASC LIMIT ' . $batchGames);
        $st->execute([$dt, 'Singleplayer']);
        $games = $st->fetchAll();
        if (!$games) {
            state_set($pdo, STATE_KEY_RATING, (string)(int)(microtime(true) * 1000));
            break;
        }

        $gids = array_column($games, 'game_id');
        $in = implode(',', array_fill(0, count($gids), '?'));
        $rs = $pdo->prepare("SELECT r.game_id, r.public_id, r.won FROM tfh_g_roster r
            WHERE r.game_id IN ($in) AND r.public_id IS NOT NULL");
        $rs->execute($gids);
        $rosterByGame = [];
        foreach ($rs->fetchAll() as $row) $rosterByGame[$row['game_id']][] = $row;

        $stateCache = ['ffa' => [], 'team' => [], 'ranked' => []];
        foreach ($games as $g) {
            if (microtime(true) >= $endAt) break; // v5.1 : budget aussi à l'intérieur du lot
            $seenChk->execute([$g['game_id']]);
            if ($seenChk->fetchColumn()) continue; // déjà notée (limite de lot sur même horodatage)
            $board = rating_board((string)($g['ranked_type'] ?? 'unranked'), $g['player_teams']);
            $parts = $rosterByGame[$g['game_id']] ?? [];
            if (count($parts) < 2) continue;
            foreach ($parts as $p) {
                $pid = (string)$p['public_id'];
                if (isset($stateCache[$board][$pid])) continue;
                $selState->execute([$board, $pid]);
                $row = $selState->fetch();
                $stateCache[$board][$pid] = $row === false
                    ? ['mu' => 0.0, 'phi' => 350.0 / Glicko2::SCALE, 'games' => 0, 'wins' => 0, 'peak' => 1500.0, 'peak_at' => null, 'last_at' => null, 'dirty' => false]
                    : ['mu' => Glicko2::toMu((float)$row['rating']), 'phi' => Glicko2::toPhi((float)$row['rd']),
                       'games' => (int)$row['games'], 'wins' => (int)$row['wins'], 'peak' => (float)$row['peak'],
                       'peak_at' => $row['peak_at'], 'last_at' => $row['last_at'], 'dirty' => false];
            }
            // v5.9 : curseur sauvegardé PAR PARTIE (un lot peut dépasser le
            // budget → sans sauvegarde incrémentale, rating restait à 0).
            $_gMs = (int)round(((float)$g['start_s']) * 1000);
            if ($_gMs > $cursor) { $cursor = $_gMs; state_set($pdo, STATE_KEY_RATING, (string)$cursor); }
            foreach ($parts as $i => $pa) {
                $pidA = (string)$pa['public_id'];
                $vs = [];
                foreach ($parts as $j => $pb) {
                    if ($i === $j) continue;
                    $pidB = (string)$pb['public_id'];
                    $s = ((int)$pa['won'] === 1) ? 1.0 : (((int)$pb['won'] === 1) ? 0.0 : 0.5);
                    $vs[] = [$stateCache[$board][$pidB]['mu'], $stateCache[$board][$pidB]['phi'], $s];
                }
                if (!$vs) continue;
                $sa = &$stateCache[$board][$pidA];
                [$newMu, $newPhi] = Glicko2::rate($sa['mu'], $sa['phi'], $vs);
                $sa['mu'] = $newMu; $sa['phi'] = $newPhi;
                $sa['games']++;
                if ((int)$pa['won'] === 1) $sa['wins']++;
                $rNow = Glicko2::toR($newMu);
                if ($rNow > $sa['peak']) { $sa['peak'] = $rNow; $sa['peak_at'] = (string)$g['started_at']; }
                $sa['last_at'] = (string)$g['started_at'];
                $sa['dirty'] = true;
                unset($sa);
                $histIns->execute([$pidA, $board, $g['game_id'], (string)$g['started_at'], $rNow, Glicko2::toRd($newPhi)]);
                $pRated++;
            }
            $gRated++;
        }

        // écriture des états modifiés (une fois par lot)
        foreach ($stateCache as $_board => $playersStates) {
            foreach ($playersStates as $pid => $s) {
                if (empty($s['dirty'])) continue;
                $upState->execute([
                    $pid, $_board, Glicko2::toR($s['mu']), Glicko2::toRd($s['phi']),
                    $s['games'], $s['wins'], $s['peak'], $s['peak_at'], $s['last_at'],
                ]);
            }
        }

        $lastGame = $games[count($games) - 1];
        $cursor = (int)round(((float)$lastGame['start_s']) * 1000);
        state_set($pdo, STATE_KEY_RATING, (string)$cursor);
        if (count($games) < $batchGames) {
            // plus rien à traiter pour l'instant → curseur à maintenant
            state_set($pdo, STATE_KEY_RATING, (string)(int)(microtime(true) * 1000));
            break;
        }
    }
    if ($gRated > 0) log_line("[rating] $gRated partie(s) notée(s) ($pRated mises à jour joueurs)");
}

/* ─────────────────────────── Commandes spéciales ─────────────────────────── */

if ($argStatus) {
    $cnt = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_games) AS games,
        (SELECT COUNT(*) FROM tfh_g_roster) AS roster,
        (SELECT COUNT(*) FROM tfh_g_players) AS players,
        (SELECT COUNT(*) FROM tfh_g_games WHERE speedrun_category IS NOT NULL) AS speedruns')->fetch();
    $v5 = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_games WHERE v5_done = 0) AS enrich_left,
        (SELECT COUNT(*) FROM tfh_g_games WHERE turns_done = 0) AS turns_left,
        (SELECT COUNT(*) FROM tfh_g_turns) AS turns_ok,
        (SELECT COUNT(*) FROM tfh_g_clans) AS clans,
        (SELECT COUNT(*) FROM tfh_g_cosmetics) AS cosmetics,
        (SELECT COUNT(*) FROM tfh_g_cosmetic_wearers) AS wearers,
        (SELECT COUNT(*) FROM tfh_g_ratings) AS rated_players,
        (SELECT COUNT(*) FROM tfh_g_games WHERE v5_done = 1) AS v5_games')->fetch();
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
        'v5' => [
            'enrich_remaining' => (int)$v5['enrich_left'],
            'enriched_games' => (int)$v5['v5_games'],
            'turns_remaining' => (int)$v5['turns_left'],
            'turns_stored' => (int)$v5['turns_ok'],
            'clans' => (int)$v5['clans'],
            'cosmetics_catalog' => (int)$v5['cosmetics'],
            'cosmetic_wearers' => (int)$v5['wearers'],
            'rated_players' => (int)$v5['rated_players'],
            'rating_cursor_ms' => state_get($pdo, STATE_KEY_RATING),
        ],
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

// v3 : débit détail AIMD — départ frais à chaque tick.
// v5.7 : CONSTAT MESURÉ — le plafond officiel (~250 req/10 s, evan [OF]) ne
// s'applique pas à notre IP mutualisée : 429 dès 4 req/s (22:04, mesuré).
// On revient au profil éprouvé 2 req/s (v4.2 : 0 erreur sur 130k+ requêtes).
$OF_RATE_MAX = min(10.0, max(0.5, (float)$cfg['detail_rate_max_per_s']));
$rateStart5 = min($OF_RATE_MAX, max(0.5, (float)$cfg['detail_rate_start_per_s']));
$OF_RATE = $rateStart5;

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
phase_mark($pdo, 'recent');
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

phase_mark($pdo, 'backfill');
$cursor = (int)state_get($pdo, STATE_KEY_BACKFIL, (string)$nowMs);
$windowMs = (int)round((float)$cfg['window_days'] * 86400 * 1000);
$windowsDone = 0;
try {
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
} catch (Throwable $e) { log_line('[backfill] 💥 ' . cut_txt($e->getMessage(), 200) . ' @ ' . basename($e->getFile()) . ':' . $e->getLine()); }
if ($windowsDone > 0 && $cursor <= GAMES_EPOCH_MS + 3600 * 1000) {
    log_line('[backfill] ✅ epoch publicID atteinte');
}

// 4) v5 — Catalogue officiel des cosmétiques (throttlé 6 h)
try { catalog_phase($pdo, $cfg); } catch (Throwable $e) { log_line('[catalog] ⚠️ ' . cut($e->getMessage(), 140)); }

// 5) v5 — Enrichissement des anciennes parties (cosmétiques, clans, config, stats)
try {
    [$enrDone, $enrLeft] = enrich_phase($pdo, $cfg, $deadline, $unameCache);
    if ($enrDone > 0) log_line("[enrich] $enrDone partie(s) enrichie(s) — restantes : $enrLeft");
} catch (Throwable $e) { log_line('[enrich] ⚠️ ' . cut($e->getMessage(), 140)); }

// 6) v5 — Rating Glicko-2 (3 boards, curseur chronologique)
try { if (microtime(true) < $deadline) rating_phase($pdo, $cfg, $deadline); } catch (Throwable $e) { log_line('[rating] ⚠️ ' . cut($e->getMessage(), 140)); }

// 7) v5 — Replays turn-by-turn (gzip, plafonné par tick)
try {
    if (microtime(true) < $deadline) {
        $tn = turns_phase($pdo, $cfg, $deadline);
        if ($tn > 0) log_line("[turns] $tn replay(s) stocké(s)");
    }
} catch (Throwable $e) { log_line('[turns] ⚠️ ' . cut($e->getMessage(), 140)); }
phase_mark($pdo, 'fin');

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
