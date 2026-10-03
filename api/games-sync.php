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
 *   v5.11 (2026-09-26) — « API OFFICIELLES » (clans, classé, profils) :
 *     • LADDER RANKED OFFICIEL : /leaderboard/ranked (pages 1-2 = top 100 par
 *       board 1v1/2v2) — elo, peakElo, W/L, accountUsername + public_id.
 *       Snapshot tfh_g_ladder remplacé à chaque refresh (throttle 30 min) +
 *       historique quotidien tfh_g_ladder_history (courbes d'ELO type ofstats).
 *     • LEADERBOARD CLANS OFFICIEL : /public/clans/leaderboard (top 100 par
 *       weightedWins, fenêtre glissante ~90 j, demi-vie 30 j) → colonnes lb_*
 *       de tfh_g_clans (complète notre agrégation roster). Throttle 1 h.
 *     • PROFILS OFFICIELS : /public/player/:id par joueur — username du
 *       compte, createdAt, arbre de stats complet (type→mode→difficulté,
 *       y compris Private/Singleplayer, hors de portée de nos rosters).
 *       Table tfh_g_profiles, budget réservé EN TÊTE de tick (défaut 45 s ≈
 *       90 profils/tick) pour ne pas être affamé par le backfill ; priorité
 *       joueurs vus récemment ; 404 = tombstone (compte supprimé).
 *     NB : /public/clan/:tag (+ /sessions) est limité à 1 jour par requête
 *     côté API — pas de stats de clan lifetime officielles exploitables ;
 *     nos agrégats roster (tfh_g_clans) comblent ça depuis l'epoch.
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
    /* v5.11 — API officielles (ladder ranked, clans LB, profils joueurs) */
    'ladder_refresh_min'       => 30,   // ladder ranked officiel (2 req, top 100 1v1+2v2)
    'clanslb_refresh_min'      => 60,   // leaderboard clans officiel (1 req, weightedWins)
    'profile_seconds_per_tick' => 45,   // budget réservé aux profils officiels (tête de tick)
    'profiles_max_per_tick'    => 90,   // plafond de fetch /public/player/:id par tick
    'profile_refresh_days'     => 14,   // re-sync d'un profil officiel plus vieux que N jours
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
/* v5.16 — HISTORIQUE MAXIMAL : l'archive remonte désormais à la naissance de
 * l'API publique OpenFront (30 mai 2025, ère v0.23-dev). GAMES_EPOCH_MS devient
 * la frontière « ère détaillée » (V34) : les fenêtres au-dessus gardent
 * l'ingestion détail-par-détail (scan_range), celles en dessous passent en
 * « liste d'abord » (scan_meta_range — 1000 parties/requête, version calculée
 * localement) puis sont enrichies progressivement par enrich_phase.
 * Raison : ~3 M de parties pré-V34 — à 2 req/s de détail, plusieurs mois de
 * fetch ; en liste-seule l'archive complète est reconstruite en quelques
 * heures de ticks, les détails suivent du plus récent au plus ancien. */
const GAMES_EPOCH_MS = 1788998400000;      // 2026-09-10T00:00:00Z — début ère V34 (frontière détails)
const GAMES_EPOCH_DEEP_MS = 1748102400000; // 2025-05-25T00:00:00Z — plus vieilles données servies par l'API (~30 mai 2025)
const OF_V0231_MS = 1748715223000;         // tag v0.23.1 (31 mai 2025) — avant : ère dev 'v0.23-dev'
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
/* v5.22 — classification speedrun vérifiée (0 = ligne enrichie avant le fix
 * reclassify, jamais passée par classify_speedrun) */
tfh_add_col($pdo, 'tfh_g_games',   'speedrun_checked',  "`speedrun_checked` TINYINT(1) NOT NULL DEFAULT 0 AFTER `turns_tries`");
tfh_add_idx($pdo, 'tfh_g_games',   'idx_ggames_v5',     "`idx_ggames_v5` (`v5_done`, `started_at`)");
tfh_add_idx($pdo, 'tfh_g_games',   'idx_ggames_turns',  "`idx_ggames_turns` (`turns_done`, `started_at`)");
tfh_add_idx($pdo, 'tfh_g_games',   'idx_ggames_srcheck', "`idx_ggames_srcheck` (`v5_done`, `speedrun_checked`)");
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

/* ─────────────── v5.11 : API officielles (ladder, clans LB, profils) ─────────────── */

/* Ladder ranked OFFICIEL (/leaderboard/ranked, top 100 par board 1v1/2v2).
 * Snapshot courant : remplacé intégralement à chaque refresh. NB : « rank »
 * est un mot réservé MySQL 8 → colonne rank_pos. */
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_ladder (
    board            VARCHAR(4)      NOT NULL,
    rank_pos         INT UNSIGNED    NOT NULL DEFAULT 0,
    public_id        VARCHAR(16)     NOT NULL,
    username         VARCHAR(64)     NULL,
    account_username VARCHAR(64)     NULL,
    elo              INT             NOT NULL DEFAULT 0,
    peak_elo         INT             NOT NULL DEFAULT 0,
    wins             INT UNSIGNED    NOT NULL DEFAULT 0,
    losses           INT UNSIGNED    NOT NULL DEFAULT 0,
    total            INT UNSIGNED    NOT NULL DEFAULT 0,
    fetched_at       DATETIME        NOT NULL,
    PRIMARY KEY (board, public_id),
    INDEX idx_gladder_rank (board, rank_pos)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

/* Historique ELO officiel (1 ligne max par joueur/board/jour) — courbes de
 * progression type ofstats « rating race ». Croissance bornée : 200 lignes/j. */
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_ladder_history (
    board      VARCHAR(4)      NOT NULL,
    public_id  VARCHAR(16)     NOT NULL,
    day        DATE            NOT NULL,
    rank_pos   INT UNSIGNED    NOT NULL DEFAULT 0,
    elo        INT             NOT NULL DEFAULT 0,
    peak_elo   INT             NOT NULL DEFAULT 0,
    PRIMARY KEY (board, public_id, day),
    INDEX idx_glh_pid (public_id, board, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

/* Profils officiels /public/player/:id — username du compte, date de création
 * et arbre de stats complet (type→mode→difficulté→métriques). not_found = 1
 * quand l'API renvoie 404 (compte supprimé — même signal que le poll
 * recently-deleted). stats_json ~2-15 Ko/joueur. */
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_profiles (
    public_id  VARCHAR(16)     NOT NULL PRIMARY KEY,
    username   VARCHAR(64)     NULL,
    created_at DATETIME        NULL,
    fetched_at DATETIME        NOT NULL,
    not_found  TINYINT(1)      NOT NULL DEFAULT 0,
    stats_json MEDIUMTEXT      NULL,
    INDEX idx_gprof_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

/* ── v5.12 — nouveaux flux API officielles ──
 * Board FFA officiel (/leaderboard/public/ffa), ladder des tribus
 * (/leaderboard/tribes), news (/news.json), streams live (/streams.json),
 * sessions de clans (/public/clan/:tag/sessions). Tout est additif. */
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_lb_ffa (
    rank_pos   INT UNSIGNED    NOT NULL PRIMARY KEY,
    public_id  VARCHAR(16)     NOT NULL,
    wins       INT UNSIGNED    NOT NULL DEFAULT 0,
    losses     INT UNSIGNED    NOT NULL DEFAULT 0,
    total      INT UNSIGNED    NOT NULL DEFAULT 0,
    wlr        DOUBLE          NULL,
    fetched_at DATETIME        NOT NULL,
    INDEX idx_glbffa_pid (public_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_lb_ffa_history (
    day        DATE            NOT NULL,
    public_id  VARCHAR(16)     NOT NULL,
    rank_pos   INT UNSIGNED    NOT NULL,
    wins       INT UNSIGNED    NOT NULL DEFAULT 0,
    losses     INT UNSIGNED    NOT NULL DEFAULT 0,
    total      INT UNSIGNED    NOT NULL DEFAULT 0,
    wlr        DOUBLE          NULL,
    PRIMARY KEY (day, public_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_tribes (
    rank_pos       INT UNSIGNED    NOT NULL PRIMARY KEY,
    name           VARCHAR(64)     NOT NULL,
    games_appeared INT UNSIGNED    NOT NULL DEFAULT 0,
    player_reach   INT UNSIGNED    NOT NULL DEFAULT 0,
    owner_public_id VARCHAR(16)    NULL,
    owner_username VARCHAR(64)     NULL,
    active_boosts  INT UNSIGNED    NOT NULL DEFAULT 0,
    window_days    INT UNSIGNED    NOT NULL DEFAULT 30,
    fetched_at     DATETIME        NOT NULL,
    INDEX idx_gtribes_owner (owner_public_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_news (
    news_id     VARCHAR(24)     NOT NULL PRIMARY KEY,
    title       VARCHAR(200)    NULL,
    description TEXT            NULL,
    url         VARCHAR(300)    NULL,
    type        VARCHAR(24)     NULL,
    platforms_json VARCHAR(120) NULL,
    first_seen  DATETIME        NOT NULL,
    last_seen   DATETIME        NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_streams (
    channel       VARCHAR(64)     NOT NULL PRIMARY KEY,
    platform      VARCHAR(16)     NOT NULL,
    display_name  VARCHAR(64)     NULL,
    title         VARCHAR(200)    NULL,
    viewers       INT UNSIGNED    NOT NULL DEFAULT 0,
    avatar_url    VARCHAR(300)    NULL,
    url           VARCHAR(300)    NULL,
    started_at    DATETIME        NULL,
    first_seen_at DATETIME        NOT NULL,
    last_seen_at  DATETIME        NOT NULL,
    INDEX idx_gstreams_viewers (viewers)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_clan_sessions (
    clan_tag           VARCHAR(16)     NOT NULL,
    game_id            VARCHAR(16)     NOT NULL,
    game_start         DATETIME        NOT NULL,
    clan_player_count  INT UNSIGNED    NOT NULL DEFAULT 0,
    has_won            TINYINT(1)      NOT NULL DEFAULT 0,
    num_teams          INT UNSIGNED    NULL,
    player_teams       VARCHAR(32)     NULL,
    total_player_count INT UNSIGNED    NULL,
    score              DOUBLE          NULL,
    fetched_at         DATETIME        NOT NULL,
    PRIMARY KEY (clan_tag, game_id),
    INDEX idx_gcless_tag_start (clan_tag, game_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

/* Colonnes « officielles » du leaderboard clans (weightedWins, fenêtre ~90 j).
 * Complètent participations/wins calculés depuis nos rosters. */
tfh_add_col($pdo, 'tfh_g_clans', 'lb_games',           "`lb_games` INT UNSIGNED NULL");
tfh_add_col($pdo, 'tfh_g_clans', 'lb_wins',            "`lb_wins` INT UNSIGNED NULL");
tfh_add_col($pdo, 'tfh_g_clans', 'lb_losses',          "`lb_losses` INT UNSIGNED NULL");
tfh_add_col($pdo, 'tfh_g_clans', 'lb_player_sessions', "`lb_player_sessions` INT UNSIGNED NULL");
tfh_add_col($pdo, 'tfh_g_clans', 'lb_weighted_wins',   "`lb_weighted_wins` DOUBLE NULL");
tfh_add_col($pdo, 'tfh_g_clans', 'lb_weighted_losses', "`lb_weighted_losses` DOUBLE NULL");
tfh_add_col($pdo, 'tfh_g_clans', 'lb_wl_ratio',        "`lb_wl_ratio` DOUBLE NULL");
tfh_add_col($pdo, 'tfh_g_clans', 'lb_fetched_at',      "`lb_fetched_at` DATETIME NULL");
tfh_add_idx($pdo, 'tfh_g_clans', 'idx_gclans_lb',      "`idx_gclans_lb` (`lb_weighted_wins`)");

/* ─────────────── v5.13 — Top joueurs de la semaine (pré-calcul) ───────────────
 * Table alimentée par weekly_phase() à chaque tick : agrégat des victoires
 * de la semaine courante + la précédente (barème dashboard : FFA casual ×10,
 * FFA classé ×1, Team casual ×5, Team classé ×1), avec rangs par mode.
 * La route API route=weekly (games-api.php) ne fait plus qu'une lecture
 * paginée → « tous les joueurs » sans requête lourde côté visiteur. */
$pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_weekly (
    week_start  DATE                NOT NULL,
    public_id   VARCHAR(16)         NOT NULL,
    ffa_casual  INT UNSIGNED        NOT NULL DEFAULT 0,
    ffa_ranked  INT UNSIGNED        NOT NULL DEFAULT 0,
    team_casual INT UNSIGNED        NOT NULL DEFAULT 0,
    team_ranked INT UNSIGNED        NOT NULL DEFAULT 0,
    pts_all     SMALLINT UNSIGNED   NOT NULL DEFAULT 0,
    pts_ffa     SMALLINT UNSIGNED   NOT NULL DEFAULT 0,
    pts_team    SMALLINT UNSIGNED   NOT NULL DEFAULT 0,
    rank_all    SMALLINT UNSIGNED   NULL,
    rank_ffa    SMALLINT UNSIGNED   NULL,
    rank_team   SMALLINT UNSIGNED   NULL,
    computed_at DATETIME            NOT NULL,
    PRIMARY KEY (week_start, public_id),
    INDEX idx_gweekly_rank (week_start, pts_all),
    INDEX idx_gweekly_pid (public_id)
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
        if (is_array($v)) {
            $nm = $v['name'] ?? null;
            if (is_string($nm) && $nm !== '') {
                /* v5.22 : conserve l'URL CDN fournie par l'API (rendu vitrine
                 * indépendant du cache catalogue serveur). */
                $out[$k] = isset($v['url']) && is_string($v['url']) && $v['url'] !== ''
                    ? ['name' => $nm, 'url' => cut($v['url'], 200)] : $nm;
            }
        } elseif (is_string($v) && $v !== '') $out[$k] = $v;
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
        $v = $c[$k] ?? null;
        /* v5.22 : accepte "name" (string) ou {"name":…, "url":…} */
        if (is_string($v) && $v !== '') $items[] = [$k, $v];
        elseif (is_array($v) && isset($v['name']) && is_string($v['name']) && $v['name'] !== '') $items[] = [$k, $v['name']];
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
             version, num_turns, config_json, v5_done, speedrun_checked)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)');
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
            /* v5.16 : vraie version du jeu (tags OpenFrontIO), pas la constante 'v0.0.2' */
            of_version_for($startMs, $gitc),
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

/* ─────────────── v5.16 : version officielle du jeu (tags OpenFrontIO) ─────────────── */
/* Le champ « version » des réponses OpenFront est une CONSTANTE de schéma
 * analytics (Schemas.ts : version: z.literal("v0.0.2")) — il ne désigne PAS la
 * version du jeu. La vraie version = le build déployé (gitCommit du serveur de
 * la partie) rapproché des tags officiels openfrontio/OpenFrontIO :
 *   1) match SHA exact (git_commit de la partie = commit d'un tag) ;
 *   2) sinon le dernier tag dont la date <= début de partie (les déploiements
 *      non tagués — nightly — restent sur la version précédente) ;
 *   3) avant v0.23.1 (naissance de l'API, 31 mai 2025) → 'v0.23-dev'.
 * Table générée : api/of-version-map.php (284 tags v0.3.6 → v0.34.20). */
$_OF_VER_MAP = null;
function of_version_map(): array {
    global $_OF_VER_MAP;
    if ($_OF_VER_MAP === null) {
        $_OF_VER_MAP = @include __DIR__ . '/of-version-map.php';
        if (!is_array($_OF_VER_MAP)) $_OF_VER_MAP = [];
    }
    return $_OF_VER_MAP;
}
function of_version_for(int $startMs, string $gitc = ''): ?string {
    $map = of_version_map();
    /* Table absente (fenêtre de déploiement) → NULL plutôt qu'une version
     * fausse ; vermig_phase / enrich la poseront plus tard. */
    if (!$map) return null;
    if ($map) {
        if ($gitc !== '') {
            $g = strtolower(substr($gitc, 0, 16));
            foreach ($map as $e) {
                if (!empty($e['sha']) && strncmp((string)$e['sha'], $g, strlen($g)) === 0) return (string)$e['v'];
            }
        }
        $lo = 0; $hi = count($map) - 1; $best = null;
        while ($lo <= $hi) {
            $mid = intdiv($lo + $hi, 2);
            if ((int)$map[$mid]['t'] <= $startMs) { $best = $map[$mid]; $lo = $mid + 1; }
            else { $hi = $mid - 1; }
        }
        if ($best !== null && $startMs >= OF_V0231_MS) return (string)$best['v'];
    }
    return 'v0.23-dev';
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

/* ─────────────────── v5.16 : ingestion « liste d'abord » (historique profond) ─────────────────── */
/**
 * Ingestion SANS fetch détail : les métadonnées de liste (1000 parties/req)
 * suffisent pour reconstruire l'archive profonde (mai 2025 → sept. 2026) en
 * quelques heures de ticks — à 2 req/s de détail, l'ère pré-V34 (~3 M parties)
 * aurait demandé plusieurs mois. La version officielle est calculée LOCALEMENT
 * (table des tags OpenFrontIO — aucun appel supplémentaire). Les détails
 * (carte, roster, config, stats, speedruns) arrivent ensuite via enrich_phase
 * (v5_done = 0, du plus récent au plus ancien).
 * Retour : [ingérées, vues, complète] — même contrat que scan_range().
 */
function scan_meta_range(PDO $pdo, int $startMs, int $endMs, array $cfg, float $deadline, string $label, int $startOffset = 0, ?callable $onProgress = null, string $gameType = 'Public'): array {
    $ingested = 0; $seen = 0;
    $limit = (int)$cfg['list_limit'];
    $minPlayers = max(0, (int)($cfg['min_players_to_keep'] ?? 1));
    $ins = $pdo->prepare('INSERT IGNORE INTO tfh_g_games
        (game_id, started_at, ended_at, duration_s, game_type, game_mode, ranked_type, player_teams,
         difficulty, num_players, max_players, lobby_fill_time, version, v5_done)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)');
    $chk = $pdo->prepare('SELECT 1 FROM tfh_g_games WHERE game_id = ?');
    for ($offset = $startOffset; $offset <= (int)$cfg['list_max_offset']; $offset += $limit) {
        if (microtime(true) >= $deadline) return [$ingested, $seen, false];
        $url = OF_API_BASE . '/public/games?start=' . rawurlencode(gmdate('Y-m-d\\TH:i:s\\Z', intdiv($startMs, 1000)))
             . '&end=' . rawurlencode(gmdate('Y-m-d\\TH:i:s\\Z', intdiv($endMs, 1000)))
             . '&type=' . rawurlencode($gameType) . '&limit=' . $limit . '&offset=' . $offset;
        of_pace(1); // v5.16 : les pages de liste partagent le pacing global (politesse IP mutualisée)
        [$status, $games] = of_request($url, 30);
        if ($status !== 200 || !is_array($games)) {
            log_line("[$label] page liste-meta $gameType offset=$offset : échec HTTP $status — reprise au prochain tick");
            return [$ingested, $seen, false];
        }
        foreach ($games as $g) {
            if (!is_array($g) || empty($g['game'])) continue;
            $np = $g['numPlayers'] ?? null;
            if ($np !== null && $np !== '' && (int)$np < $minPlayers) continue; // lobbies vides (quand l'info existe)
            $gid = (string)$g['game'];
            $seen++;
            $chk->execute([$gid]);
            if ($chk->fetch()) continue;
            $ts = isset($g['start']) ? strtotime((string)$g['start']) : false;
            if ($ts === false) continue;
            $startGms = (int)$ts * 1000;
            $te = isset($g['end']) ? strtotime((string)$g['end']) : false;
            $endGms = $te !== false ? (int)$te * 1000 : null;
            $dur = $endGms !== null ? max(0, (int)round(($endGms - $startGms) / 1000)) : null;
            try {
                $ins->execute([
                    $gid,
                    ms_to_dt($startGms),
                    $endGms !== null ? ms_to_dt($endGms) : null,
                    $dur,
                    (string)($g['type'] ?? 'Public'),
                    (string)($g['mode'] ?? ''),
                    (string)($g['rankedType'] ?? 'unranked'),
                    isset($g['playerTeams']) && $g['playerTeams'] !== null ? (string)$g['playerTeams'] : null,
                    isset($g['difficulty']) && $g['difficulty'] !== null ? cut((string)$g['difficulty'], 16) : null,
                    $np !== null && $np !== '' ? (int)$np : null,
                    isset($g['maxPlayers']) && $g['maxPlayers'] !== null ? (int)$g['maxPlayers'] : null,
                    isset($g['lobbyFillTime']) && $g['lobbyFillTime'] !== null ? (int)$g['lobbyFillTime'] : null,
                    of_version_for($startGms),
                ]);
                if ($ins->rowCount() > 0) $ingested++;
            } catch (Throwable $e) {
                log_line("[$label] ⚠️ meta $gid : " . cut($e->getMessage(), 100));
            }
        }
        if ($onProgress !== null) $onProgress($offset + $limit);
        if (count($games) < $limit) return [$ingested, $seen, true]; // dernière page → fenêtre complète
    }
    return [$ingested, $seen, true];
}

/* ─────────────────── v5 : enrichissement / replays / rating / catalogue ─────────────────── */

/* ─────────────────── v5.16 : migration des versions existantes ─────────────────── */
/**
 * Les ~240 k parties ingérées avant v5.16 portent version = 'v0.0.2' (la
 * constante de schéma analytics, jamais la version du jeu). On les remplace
 * par la version officielle calculée (tags OpenFrontIO : SHA exact sinon
 * date), par lots de 20 k à chaque tick jusqu'à épuisement (aucun appel API).
 */
function vermig_phase(PDO $pdo): void {
    if (state_get($pdo, 'vermig_done', '0') === '1') return;
    phase_mark($pdo, 'vermig');
    $sel = $pdo->prepare("SELECT game_id, UNIX_TIMESTAMP(started_at)*1000 AS s, git_commit
        FROM tfh_g_games WHERE version = 'v0.0.2' OR version IS NULL LIMIT 20000");
    $sel->execute();
    $rows = $sel->fetchAll(PDO::FETCH_ASSOC);
    if (!$rows) {
        state_set($pdo, 'vermig_done', '1');
        state_set($pdo, 'vermig_remaining', '0');
        log_line('[vermig] ✅ toutes les versions sont migrées');
        return;
    }
    $upd = $pdo->prepare("UPDATE tfh_g_games SET version = ? WHERE game_id = ? AND (version = 'v0.0.2' OR version IS NULL)");
    $n = 0;
    foreach ($rows as $r) {
        $upd->execute([of_version_for((int)$r['s'], (string)($r['git_commit'] ?? '')), $r['game_id']]);
        if ($upd->rowCount() > 0) $n++;
    }
    $left = (int)$pdo->query("SELECT COUNT(*) FROM tfh_g_games WHERE version = 'v0.0.2' OR version IS NULL")->fetchColumn();
    state_set($pdo, 'vermig_remaining', (string)$left);
    log_line("[vermig] $n version(s) migrée(s) — restantes : $left");
    if ($left === 0) state_set($pdo, 'vermig_done', '1');
}

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

    /* v5.22 — CLASSIFICATION SPEEDRUN à l'enrichissement (avant : uniquement
     * à l'ingestion → les millions de lignes de l'archive profonde restaient
     * à jamais hors speedruns). classify_speedrun consomme exactement
     * {config, players, winner, duration, start, end} — tous présents ici. */
    [$srCatE, $srDurE, , $modsCsvE] = classify_speedrun($info);
    $endMsE = isset($info['end']) && is_numeric($info['end']) ? (int)$info['end']
            : ($durationS !== null ? $startMs + $durationS * 1000 : null);
    $mapE = isset($cfgG['gameMap']) && is_string($cfgG['gameMap']) && $cfgG['gameMap'] !== '' ? cut($cfgG['gameMap'], 48) : null;

    $gitcE = cut((string)($detail['gitCommit'] ?? ''), 16);
    $pdo->beginTransaction();
    try {
        /* v5.16 : version réelle (tags) + git_commit complété (lignes liste-seule)
         * v5.22 : + carte/format/difficulté/bots/mods/durée/ended_at/speedrun
         * (COALESCE : ne jamais écraser une valeur déjà juste) + speedrun_checked. */
        $pdo->prepare("UPDATE tfh_g_games SET version = ?, num_turns = ?, config_json = ?, v5_done = 1,
            git_commit = IF(? <> '', ?, git_commit),
            ended_at = COALESCE(ended_at, ?),
            duration_s = COALESCE(duration_s, ?),
            game_map = COALESCE(game_map, ?),
            map_size = COALESCE(map_size, ?),
            difficulty = COALESCE(difficulty, ?),
            bots = COALESCE(bots, ?),
            mods = ?,
            speedrun_category = ?, speedrun_duration_s = ?,
            speedrun_checked = 1
            WHERE game_id = ?")
            ->execute([
                of_version_for($startMs, $gitcE),
                isset($info['num_turns']) && is_numeric($info['num_turns']) ? (int)$info['num_turns'] : null,
                $cfgG ? json_encode($cfgG, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) : null,
                $gitcE, $gitcE,
                $endMsE !== null ? ms_to_dt($endMsE) : null,
                $durationS,
                $mapE,
                isset($cfgG['gameMapSize']) ? cut((string)$cfgG['gameMapSize'], 16) : null,
                isset($cfgG['difficulty']) ? cut((string)$cfgG['difficulty'], 16) : null,
                isset($cfgG['bots']) && is_numeric($cfgG['bots']) ? (int)$cfgG['bots'] : null,
                $modsCsvE,
                $srCatE, $srDurE,
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

/** v5.22 — Rattrapage LOCAL des speedruns (zéro appel API).
 *
 * Les lignes enrichies AVANT le fix « enrich → classify » (v5_done=1,
 * speedrun_checked=0) n'ont jamais été classifiées. On les classifie ici à
 * partir des données DÉJÀ stockées :
 *   - config_json  → config (Public/FFA/bots/mods/compact/anti-cheat) ;
 *   - roster       → joueurs (nombre = humains, gagnant = won=1 + username) ;
 *   - duration_s   → durée (l'ingestion la stockait ; l'enrich historique
 *                    parfois non → catégorie laissée NULL mais ligne marquée
 *                    vérifiée pour ne pas re-scanner, carte/bots complétés).
 * Retour [traitées, restantes]. Se termine définitivement (state=1) à sec. */
function reclassify_phase(PDO $pdo, array $cfg): array {
    if (state_get($pdo, 'sr_reclassify_done') === '1') return [0, 0];
    phase_mark($pdo, 'reclassify');
    $batch = min(3000, max(50, (int)($cfg['reclassify_batch'] ?? 1500)));

    $st = $pdo->prepare('SELECT game_id, config_json, duration_s FROM tfh_g_games
        WHERE v5_done = 1 AND speedrun_checked = 0 AND config_json IS NOT NULL
        LIMIT ' . $batch);
    $st->execute();
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);
    if (!$rows) {
        // Lignes sans config (rares) : marquées vérifiées sans classification.
        $pdo->exec('UPDATE tfh_g_games SET speedrun_checked = 1
            WHERE v5_done = 1 AND speedrun_checked = 0 AND config_json IS NULL');
        // Lignes sans config_json restantes ? → terminé.
        $left = (int)$pdo->query('SELECT COUNT(*) FROM tfh_g_games WHERE v5_done = 1 AND speedrun_checked = 0')->fetchColumn();
        if ($left === 0) { state_set($pdo, 'sr_reclassify_done', '1'); log_line('[reclassify] ✅ terminé'); }
        return [0, $left];
    }

    $rosterSt = $pdo->prepare('SELECT r.client_id, r.won, u.username
        FROM tfh_g_roster r LEFT JOIN tfh_g_usernames u ON u.id = r.username_id
        WHERE r.game_id = ?');
    $upd = $pdo->prepare('UPDATE tfh_g_games SET
        game_map = COALESCE(game_map, ?), map_size = COALESCE(map_size, ?),
        difficulty = COALESCE(difficulty, ?), bots = COALESCE(bots, ?),
        mods = COALESCE(mods, ?),
        speedrun_category = ?, speedrun_duration_s = ?, speedrun_checked = 1
        WHERE game_id = ?');

    $done = 0;
    foreach ($rows as $r) {
        $cfgG = json_decode((string)$r['config_json'], true);
        if (!is_array($cfgG)) {
            $upd->execute([null, null, null, null, null, null, null, $r['game_id']]);
            $done++;
            continue;
        }
        $rosterSt->execute([$r['game_id']]);
        $players = $rosterSt->fetchAll(PDO::FETCH_ASSOC);
        $playersArr = [];
        $winnerCid = null;
        foreach ($players as $p) {
            $cid = (string)$p['client_id'];
            $playersArr[] = ['clientID' => $cid, 'username' => (string)($p['username'] ?? '')];
            if ($winnerCid === null && (int)$p['won'] === 1) $winnerCid = $cid;
        }
        $pseudo = [
            'config' => $cfgG,
            'players' => $playersArr,
            'winner' => $winnerCid !== null ? ['player', $winnerCid] : null,
            'duration' => $r['duration_s'] !== null ? (int)$r['duration_s'] : null,
        ];
        [$srCat, $srDur, , $modsCsv] = classify_speedrun($pseudo);
        // duration_s NULL (lignes enrichies historiques) → classification
        // impossible sans durée : on complète carte/format/bots et on marque
        // vérifiée pour ne pas re-scanner ces lignes à chaque tick.
        if ($srCat !== null && $r['duration_s'] === null) $srCat = null;
        $upd->execute([
            isset($cfgG['gameMap']) && is_string($cfgG['gameMap']) ? cut($cfgG['gameMap'], 48) : null,
            isset($cfgG['gameMapSize']) ? cut((string)$cfgG['gameMapSize'], 16) : null,
            isset($cfgG['difficulty']) ? cut((string)$cfgG['difficulty'], 16) : null,
            isset($cfgG['bots']) && is_numeric($cfgG['bots']) ? (int)$cfgG['bots'] : null,
            $modsCsv,
            $srCat, $srDur,
            $r['game_id'],
        ]);
        $done++;
    }

    $left = (int)$pdo->query('SELECT COUNT(*) FROM tfh_g_games WHERE v5_done = 1 AND speedrun_checked = 0')->fetchColumn();
    if ($left === 0) { state_set($pdo, 'sr_reclassify_done', '1'); log_line('[reclassify] ✅ terminé'); }
    return [$done, $left];
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
    $delEmpty = $pdo->prepare('DELETE FROM tfh_g_games WHERE game_id = ?');
    foreach ($ids as $gid) {
        if (microtime(true) >= $deadline) break;
        $d = $details[$gid] ?? null;
        if ($d === null) continue; // transitoire → retenté au prochain tick
        /* v5.16 : détail récupéré mais lobby vide/abandonné (0 joueur) → la
         * ligne liste-seule n'a aucune valeur (ni carte, ni roster) : on la
         * supprime pour ne pas polluer l'archive ni re-tenter indéfiniment. */
        $di = is_array($d['info'] ?? null) ? $d['info'] : null;
        if ($di === null || !is_array($di['players'] ?? null) || !count($di['players'])) {
            try { $delEmpty->execute([$gid]); } catch (Throwable $e2) {}
            continue;
        }
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

/* ─────────────────────────── v5.11 : API officielles ─────────────────────────── */

/* GET avec en-têtes navigateur — contourne le WAF Cloudflare (règle UA) qui
 * 403-ise certaines routes pour les UA inconnus (même mécanique que le
 * catalogue v5.10c). Retour [status, data|null]. */
function of_fetch_browser(string $url, int $timeout = 25): array {
    global $OF_STATS;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_ENCODING       => '',
        CURLOPT_HTTPHEADER     => [
            'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept: application/json, text/plain, */*',
            'Accept-Language: en-US,en;q=0.9',
            'Referer: https://openfront.io/',
        ],
    ]);
    $body   = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($status === 200 && is_string($body)) {
        $OF_STATS['ok']++;
        $d = json_decode($body, true);
        return [200, is_array($d) ? $d : null];
    }
    $OF_STATS['err']++;
    return [$status, null];
}

/** of_request d'abord ; sur 403 (WAF UA), retry en-têtes navigateur. [status, data|null] */
function of_fetch_resilient(string $url, int $timeout = 25): array {
    [$st, $d] = of_request($url, $timeout, 2);
    if ($st === 200) return [$st, $d];
    if ($st === 403) return of_fetch_browser($url, $timeout);
    return [$st, $d];
}

/**
 * Phase 8 — Ladder ranked OFFICIEL (top 100 par board 1v1/2v2).
 * Deux sources, la première dispo gagne :
 *   1) MIROIR LOCAL ../ranked.json — publié par le pipeline GitHub Actions
 *      (sync-ranked.js → release data-latest → pull-data o2switch, ~5 min de
 *      fraîcheur). Même forme que l'API : {"1v1":[...], "2v2":[...]}.
 *      Utilisé EN PREMIER : Cloudflare 403-ise /leaderboard/ranked depuis
 *      l'IP datacenter o2switch (clé ou pas, UA navigateur ou pas — constat
 *      v5.11), alors que le miroir arrive déjà tout frais sur le disque.
 *   2) API OFFICIELLE /leaderboard/ranked?page=1..2 — fallback si le miroir
 *      est absent/trop vieux (ex. run Actions cassé).
 * Snapshot remplacé intégralement + 1 ligne d'historique par joueur/board/jour
 * (courbes d'ELO type ofstats). Throttle 30 min.
 */
function ladder_phase(PDO $pdo, array $cfg): void {
    phase_mark($pdo, 'ladder');
    $mins = max(5, (int)($cfg['ladder_refresh_min'] ?? 30));
    $last = (int)state_get($pdo, 'ladder_refreshed_at', '0');
    if (time() - $last < $mins * 60) return;
    $boards = null; $src = '';
    /* Source 1 : miroir local (fraîcheur < 24 h exigée). */
    $mirror = __DIR__ . '/../ranked.json';
    if (is_readable($mirror)) {
        $age = time() - (int)filemtime($mirror);
        if ($age < 86400) {
            $dec = json_decode((string)file_get_contents($mirror), true);
            if (is_array($dec) && (is_array($dec['1v1'] ?? null) || is_array($dec['2v2'] ?? null))) {
                $boards = [$dec];
                $src = 'miroir local ranked.json (âge ' . $age . ' s)';
            }
        }
    }
    /* Source 2 : API officielle (2 req, pages 1-2 = top 100/board). */
    if (!$boards) {
        $pages = [];
        for ($p = 1; $p <= 2; $p++) {
            [$st, $d] = of_fetch_resilient(OF_API_BASE . '/leaderboard/ranked?page=' . $p);
            if ($st !== 200 || !is_array($d)) { $pages = []; break; }
            $pages[] = $d;
        }
        if ($pages) { $boards = $pages; $src = 'api'; }
    }
    if (!$boards) {
        log_line('[ladder] miroir absent/périmé et API KO (Cloudflare 403 depuis o2switch) — réessayé au prochain tick');
        return;
    }
    $now   = gmdate('Y-m-d H:i:s');
    $today = gmdate('Y-m-d');
    $pdo->beginTransaction();
    try {
        $pdo->exec('DELETE FROM tfh_g_ladder');
        $ins  = $pdo->prepare('INSERT INTO tfh_g_ladder
            (board, rank_pos, public_id, username, account_username, elo, peak_elo, wins, losses, total, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)');
        $hist = $pdo->prepare('INSERT INTO tfh_g_ladder_history (board, public_id, day, rank_pos, elo, peak_elo)
            VALUES (?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE rank_pos = VALUES(rank_pos), elo = VALUES(elo), peak_elo = VALUES(peak_elo)');
        $n = 0;
        foreach ($boards as $d) {
            foreach (['1v1', '2v2'] as $board) {
                $rows = $d[$board] ?? null;
                if (!is_array($rows)) continue;
                foreach ($rows as $r) {
                    if (!is_array($r)) continue;
                    $pid = (string)($r['public_id'] ?? '');
                    if ($pid === '') continue;
                    $elo  = (int)($r['elo'] ?? 0);
                    $peak = (int)($r['peakElo'] ?? 0);
                    $rank = (int)($r['rank'] ?? 0);
                    $ins->execute([
                        $board, $rank, $pid,
                        cut((string)($r['username'] ?? ''), 64),
                        cut((string)($r['accountUsername'] ?? ''), 64),
                        $elo, $peak,
                        (int)($r['wins'] ?? 0), (int)($r['losses'] ?? 0), (int)($r['total'] ?? 0),
                        $now,
                    ]);
                    $hist->execute([$board, $pid, $today, $rank, $elo, $peak]);
                    $n++;
                }
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    state_set($pdo, 'ladder_refreshed_at', (string)time());
    log_line("[ladder] $n entrée(s) officielle(s) (1v1+2v2, top 100) synchronisée(s) — source $src");
}

/**
 * Phase 9 — Leaderboard des clans OFFICIEL (/public/clans/leaderboard, top 100
 * par weightedWins, fenêtre glissante ~90 j, demi-vie 30 j). Les colonnes lb_*
 * enrichissent notre agrégation roster (participations/wins depuis l'epoch).
 * Throttle 1 h, 1 req. NB : /public/clan/:tag est limité à 1 jour/requête
 * côté API → pas de lifetime officiel exploitable, nos agrégats comblent ça.
 */
function clans_lb_phase(PDO $pdo, array $cfg): void {
    phase_mark($pdo, 'clanslb');
    $mins = max(10, (int)($cfg['clanslb_refresh_min'] ?? 60));
    $last = (int)state_get($pdo, 'clanslb_refreshed_at', '0');
    if (time() - $last < $mins * 60) return;
    [$st, $d] = of_fetch_resilient(OF_API_BASE . '/public/clans/leaderboard');
    if ($st !== 200 || !is_array($d) || !is_array($d['clans'] ?? null)) {
        log_line("[clanslb] HTTP $st — réessayé au prochain tick");
        return;
    }
    $now = gmdate('Y-m-d H:i:s');
    $up  = $pdo->prepare('INSERT INTO tfh_g_clans
        (clan_tag, first_seen, last_seen, participations, wins,
         lb_games, lb_wins, lb_losses, lb_player_sessions,
         lb_weighted_wins, lb_weighted_losses, lb_wl_ratio, lb_fetched_at)
        VALUES (?,?,?,0,0,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
         lb_games = VALUES(lb_games), lb_wins = VALUES(lb_wins), lb_losses = VALUES(lb_losses),
         lb_player_sessions = VALUES(lb_player_sessions), lb_weighted_wins = VALUES(lb_weighted_wins),
         lb_weighted_losses = VALUES(lb_weighted_losses), lb_wl_ratio = VALUES(lb_wl_ratio),
         lb_fetched_at = VALUES(lb_fetched_at)');
    $n = 0;
    foreach ($d['clans'] as $c) {
        if (!is_array($c)) continue;
        $tag = (string)($c['clanTag'] ?? '');
        if ($tag === '') continue;
        $up->execute([
            $tag, $now, $now,
            (int)($c['games'] ?? 0), (int)($c['wins'] ?? 0), (int)($c['losses'] ?? 0),
            (int)($c['playerSessions'] ?? 0),
            is_numeric($c['weightedWins'] ?? null)    ? (float)$c['weightedWins']    : null,
            is_numeric($c['weightedLosses'] ?? null)  ? (float)$c['weightedLosses']  : null,
            is_numeric($c['weightedWLRatio'] ?? null) ? (float)$c['weightedWLRatio'] : null,
            $now,
        ]);
        $n++;
    }
    state_set($pdo, 'clanslb_refreshed_at', (string)time());
    log_line("[clanslb] $n clan(s) officiel(s) synchronisé(s) (fenêtre " . cut((string)($d['start'] ?? '?'), 10) . ' → ' . cut((string)($d['end'] ?? '?'), 10) . ')');
}

/**
 * Phase 10 — Profils officiels /public/player/:id.
 * Stocke le username du compte, la date de création et l'arbre de stats
 * complet (type→mode→difficulté, y compris Private/Singleplayer — hors de
 * portée des rosters). Priorité : joueurs vus récemment sans profil, puis
 * refresh des profils les plus anciens (> profile_refresh_days). Budget
 * réservé EN TÊTE de tick (profile_seconds_per_tick) pour ne pas être
 * affamé par le backfill. Pacing calé sur le débit AIMD global (les 429
 * partagent le même circuit de rétroaction que les détails de parties).
 */
function profiles_phase(PDO $pdo, array $cfg, float $deadline): void {
    global $OF_RATE;
    phase_mark($pdo, 'profiles');
    $budgetS     = max(5.0, (float)($cfg['profile_seconds_per_tick'] ?? 45));
    $maxN        = max(1, (int)($cfg['profiles_max_per_tick'] ?? 90));
    $refreshDays = max(1, (int)($cfg['profile_refresh_days'] ?? 14));
    $stopAt      = min(microtime(true) + $budgetS, $deadline > 0 ? $deadline : microtime(true) + $budgetS);

    /* Candidats 1 : joueurs vivants sans profil officiel (les plus récents d'abord). */
    $cands = $pdo->prepare('SELECT p.public_id FROM tfh_g_players p
        LEFT JOIN tfh_g_profiles f ON f.public_id = p.public_id
        WHERE f.public_id IS NULL AND p.deleted_at IS NULL
        ORDER BY p.last_seen DESC LIMIT ?');
    $cands->bindValue(1, $maxN, PDO::PARAM_INT);
    $cands->execute();
    $pids = $cands->fetchAll(PDO::FETCH_COLUMN);
    /* Candidats 2 : refresh des profils les plus anciens (si quota restant). */
    if (count($pids) < $maxN) {
        $stale = $pdo->prepare('SELECT f.public_id FROM tfh_g_profiles f
            JOIN tfh_g_players p ON p.public_id = f.public_id
            WHERE p.deleted_at IS NULL AND f.not_found = 0
              AND f.fetched_at < DATE_SUB(NOW(), INTERVAL ? DAY)
            ORDER BY f.fetched_at ASC LIMIT ?');
        $stale->bindValue(1, $refreshDays, PDO::PARAM_INT);
        $stale->bindValue(2, $maxN - count($pids), PDO::PARAM_INT);
        $stale->execute();
        foreach ($stale->fetchAll(PDO::FETCH_COLUMN) as $sp) $pids[] = $sp;
    }
    if (!$pids) return;

    $now  = gmdate('Y-m-d H:i:s');
    $up   = $pdo->prepare('INSERT INTO tfh_g_profiles (public_id, username, created_at, fetched_at, not_found, stats_json)
        VALUES (?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE username = VALUES(username), created_at = VALUES(created_at),
            fetched_at = VALUES(fetched_at), not_found = VALUES(not_found), stats_json = VALUES(stats_json)');
    $tomb = $pdo->prepare('UPDATE tfh_g_players SET deleted_at = COALESCE(deleted_at, NOW()) WHERE public_id = ?');

    $ok = 0; $nf = 0; $err = 0; $lastReq = 0.0;
    foreach ($pids as $pid) {
        if (microtime(true) >= $stopAt) break;
        /* pacing local calé sur le débit AIMD courant (partagé avec les détails) */
        if ($lastReq > 0) {
            $wait = $lastReq + (1.0 / max(0.5, $OF_RATE)) - microtime(true);
            if ($wait > 0) usleep((int)($wait * 1e6));
        }
        $lastReq = microtime(true);
        [$st, $d] = of_request(OF_API_BASE . '/public/player/' . rawurlencode((string)$pid), 15, 1);
        if ($st === 200 && is_array($d)) {
            $createdAt = null;
            if (!empty($d['createdAt']) && ($t = strtotime((string)$d['createdAt'])) !== false) $createdAt = gmdate('Y-m-d H:i:s', $t);
            $stats = $d['stats'] ?? null;
            $up->execute([
                (string)$pid,
                isset($d['username']) && is_string($d['username']) ? cut($d['username'], 64) : null,
                $createdAt, $now, 0,
                $stats === null ? null : json_encode($stats, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            ]);
            $ok++;
        } elseif ($st === 404) {
            /* 404 = compte supprimé : tombstone + marquage joueur (même signal
             * que /public/players/recently-deleted). */
            $up->execute([(string)$pid, null, null, $now, 1, null]);
            $tomb->execute([(string)$pid]);
            $nf++;
        } else {
            $err++;
            if ($err >= 10) { log_line('[profiles] 10 erreurs consécutives — reprise au prochain tick'); break; }
        }
    }
    if ($ok + $nf > 0) {
        state_set($pdo, 'profiles_fetched_total', (string)((int)state_get($pdo, 'profiles_fetched_total', '0') + $ok + $nf));
        $leftQ = $pdo->query('SELECT COUNT(*) FROM tfh_g_players p
            LEFT JOIN tfh_g_profiles f ON f.public_id = p.public_id
            WHERE f.public_id IS NULL AND p.deleted_at IS NULL');
        $left = (int)$leftQ->fetchColumn();
        log_line("[profiles] $ok profil(s) stocké(s), $nf introuvable(s), $err erreur(s) — sans profil restant : $left");
    }
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

/* ─────────────────── v5.12 — nouveaux flux API officielles ─────────────────── */

/* ISO8601 ("2026-09-27T06:59:33.978Z") → DATETIME MySQL "2026-09-27 06:59:33". */
function iso_to_dt(string $iso): string {
    return substr($iso, 0, 10) . ' ' . substr($iso, 11, 8);
}

/* ── v5.12b — Miroirs GitHub (contournement WAF) ──
 * Constat prod : Cloudflare 403-ise plusieurs routes officielles depuis l'IP
 * o2switch (leaderboard/public/ffa, leaderboard/tribes, news.json,
 * streams.json, clan/:tag/sessions) même avec la clé + en-têtes navigateur.
 * Le job Actions « sync-mirrors » (IP Azure tolérées) publie des assets
 * of_*.json sur la release data-latest ; on les lit ici en HTTP direct
 * (GitHub est joignable depuis o2switch — pull-data.sh le prouve), avec un
 * cache local en /tmp pour absorber les pépins transitifs. */
function tfh_fetch_mirror(string $name, int $maxAgeS = 3600): ?array {
    $cache = sys_get_temp_dir() . '/tfh-mirror-' . $name;
    if (is_readable($cache) && time() - (int)filemtime($cache) < $maxAgeS) {
        $d = json_decode((string)file_get_contents($cache), true);
        if (is_array($d)) return $d;
    }
    $url = 'https://github.com/Skailex239/TheFrontHub2/releases/download/data-latest/' . rawurlencode($name);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_ENCODING       => '',
        CURLOPT_USERAGENT      => 'TheFrontHub-Sync/1.0 (+https://thefronthub.com)',
    ]);
    $body = curl_exec($ch);
    $st = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($st === 200 && is_string($body) && $body !== '') {
        $d = json_decode($body, true);
        if (is_array($d)) { @file_put_contents($cache, $body); return $d; }
    }
    /* GitHub KO : mieux vaut un miroir périmé que rien (l'ingestion est idempotente). */
    if (is_readable($cache)) {
        $d = json_decode((string)file_get_contents($cache), true);
        if (is_array($d)) return $d;
    }
    return null;
}

/* Phase 10 — Board FFA OFFICIEL (/leaderboard/public/ffa, tri par wins).
 * Snapshot remplacé (top 1000) + 1 ligne d'historique/joueur/jour (courbes).
 * Throttle 6 h, 1 req. 403 Cloudflare possible depuis o2switch → retenté. */
function ffa_board_phase(PDO $pdo, array $cfg): void {
    phase_mark($pdo, 'ffaboard');
    $mins = max(30, (int)($cfg['ffaboard_refresh_min'] ?? 360));
    $last = (int)state_get($pdo, 'ffaboard_refreshed_at', '0');
    if (time() - $last < $mins * 60) return;
    /* Source 1 : miroir GitHub (WAF 403 depuis o2switch sur cette route). */
    $d = tfh_fetch_mirror('of_ffa.json');
    $src = 'miroir GitHub';
    /* Source 2 : API directe (repli si miroir absent/périmé). */
    if ($d === null) {
        [$st, $d] = of_fetch_resilient(OF_API_BASE . '/leaderboard/public/ffa');
        $src = 'api';
        if ($st !== 200 || !is_array($d)) { log_line("[ffaboard] HTTP $st (miroir KO aussi) — retenté au prochain tick"); return; }
    }
    $now = gmdate('Y-m-d H:i:s'); $today = gmdate('Y-m-d');
    $pdo->beginTransaction();
    try {
        $pdo->exec('DELETE FROM tfh_g_lb_ffa');
        $ins  = $pdo->prepare('INSERT INTO tfh_g_lb_ffa (rank_pos, public_id, wins, losses, total, wlr, fetched_at) VALUES (?,?,?,?,?,?,?)');
        $hist = $pdo->prepare('INSERT INTO tfh_g_lb_ffa_history (day, public_id, rank_pos, wins, losses, total, wlr)
            VALUES (?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE rank_pos = VALUES(rank_pos), wins = VALUES(wins), losses = VALUES(losses),
                total = VALUES(total), wlr = VALUES(wlr)');
        $n = 0;
        foreach ($d as $i => $r) {
            if (!is_array($r)) continue;
            $pid = (string)($r['public_id'] ?? '');
            if ($pid === '' || $n >= 1000) continue;
            $n++;
            $wins = (int)($r['wins'] ?? 0); $losses = (int)($r['losses'] ?? 0); $total = (int)($r['total'] ?? 0);
            $wlr = isset($r['wlr']) && is_numeric($r['wlr']) ? (float)$r['wlr'] : null;
            $ins->execute([$n, $pid, $wins, $losses, $total, $wlr, $now]);
            $hist->execute([$today, $pid, $n, $wins, $losses, $total, $wlr]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    state_set($pdo, 'ffaboard_refreshed_at', (string)time());
    log_line("[ffaboard] $n entrée(s) officielle(s) FFA synchronisée(s) — source $src");
}

/* Phase 11 — Ladder des TRIBUS (/leaderboard/tribes, fenêtre 30 j).
 * Noms de tribus achetés : reach, propriétaire, boosts actifs. Snapshot.
 * Throttle 6 h, 1 req. */
function tribes_phase(PDO $pdo, array $cfg): void {
    phase_mark($pdo, 'tribes');
    $mins = max(30, (int)($cfg['tribes_refresh_min'] ?? 360));
    $last = (int)state_get($pdo, 'tribes_refreshed_at', '0');
    if (time() - $last < $mins * 60) return;
    /* Source 1 : miroir GitHub. Source 2 : API directe. */
    $d = tfh_fetch_mirror('of_tribes.json');
    $src = 'miroir GitHub';
    if ($d === null) {
        [$st, $d] = of_fetch_resilient(OF_API_BASE . '/leaderboard/tribes');
        $src = 'api';
        if ($st !== 200 || !is_array($d) || !is_array($d['tribes'] ?? null)) { log_line("[tribes] HTTP $st (miroir KO aussi) — retenté au prochain tick"); return; }
    }
    $now = gmdate('Y-m-d H:i:s');
    $pdo->beginTransaction();
    try {
        $pdo->exec('DELETE FROM tfh_g_tribes');
        $ins = $pdo->prepare('INSERT INTO tfh_g_tribes
            (rank_pos, name, games_appeared, player_reach, owner_public_id, owner_username, active_boosts, window_days, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?)');
        $n = 0;
        foreach ($d['tribes'] as $r) {
            if (!is_array($r)) continue;
            $name = trim((string)($r['name'] ?? ''));
            if ($name === '' || $n >= 500) continue;
            $n++;
            $ins->execute([
                (int)($r['rank'] ?? $n),
                cut($name, 64),
                (int)($r['gamesAppeared'] ?? 0),
                (int)($r['playerReach'] ?? 0),
                ($r['ownerPublicId'] ?? null) !== null ? cut((string)$r['ownerPublicId'], 16) : null,
                ($r['ownerUsername'] ?? null) !== null ? cut((string)$r['ownerUsername'], 64) : null,
                (int)($r['activeBoosts'] ?? 0),
                (int)($d['windowDays'] ?? 30),
                $now,
            ]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    state_set($pdo, 'tribes_refreshed_at', (string)time());
    log_line("[tribes] $n tribu(s) officielle(s) synchronisée(s) — source $src");
}

/* Phase 12 — News officielles (/news.json). Upsert par id, throttle 6 h, 1 req. */
function news_phase(PDO $pdo, array $cfg): void {
    phase_mark($pdo, 'news');
    $mins = max(30, (int)($cfg['news_refresh_min'] ?? 360));
    $last = (int)state_get($pdo, 'news_refreshed_at', '0');
    if (time() - $last < $mins * 60) return;
    /* Source 1 : miroir GitHub. Source 2 : API directe. */
    $d = tfh_fetch_mirror('of_news.json');
    $src = 'miroir GitHub';
    if ($d === null) {
        [$st, $d] = of_fetch_resilient(OF_API_BASE . '/news.json');
        $src = 'api';
        if ($st !== 200 || !is_array($d)) { log_line("[news] HTTP $st (miroir KO aussi) — retenté au prochain tick"); return; }
    }
    $now = gmdate('Y-m-d H:i:s');
    $up = $pdo->prepare('INSERT INTO tfh_g_news (news_id, title, description, url, type, platforms_json, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE title = VALUES(title), description = VALUES(description), url = VALUES(url),
            type = VALUES(type), platforms_json = VALUES(platforms_json), last_seen = VALUES(last_seen)');
    $n = 0;
    foreach ($d as $item) {
        if (!is_array($item)) continue;
        $id = (string)($item['id'] ?? '');
        if ($id === '') continue;
        $plats = is_array($item['platforms'] ?? null) ? implode(',', array_slice($item['platforms'], 0, 6)) : '';
        $up->execute([
            cut($id, 24),
            isset($item['title']) ? cut((string)$item['title'], 200) : null,
            isset($item['description']) ? cut_txt((string)$item['description'], 4000) : null,
            isset($item['url']) ? cut((string)$item['url'], 300) : null,
            isset($item['type']) ? cut((string)$item['type'], 24) : null,
            cut($plats, 120),
            $now, $now,
        ]);
        $n++;
    }
    state_set($pdo, 'news_refreshed_at', (string)time());
    log_line("[news] $n annonce(s) synchronisée(s) — source $src");
}

/* Phase 13 — Streams live (/streams.json, Twitch…). Upsert par canal + purge > 7 j.
 * Throttle 30 min, 1 req. */
function streams_phase(PDO $pdo, array $cfg): void {
    phase_mark($pdo, 'streams');
    $mins = max(10, (int)($cfg['streams_refresh_min'] ?? 30));
    $last = (int)state_get($pdo, 'streams_refreshed_at', '0');
    if (time() - $last < $mins * 60) return;
    /* Source 1 : miroir GitHub (frais de 3 h max — flux « live »). Source 2 : API. */
    $d = tfh_fetch_mirror('of_streams.json', 1200);
    $src = 'miroir GitHub';
    if ($d === null) {
        [$st, $d] = of_fetch_resilient(OF_API_BASE . '/streams.json');
        $src = 'api';
        if ($st !== 200 || !is_array($d)) { log_line("[streams] HTTP $st (miroir KO aussi) — retenté au prochain tick"); return; }
    }
    $now = gmdate('Y-m-d H:i:s');
    $up = $pdo->prepare('INSERT INTO tfh_g_streams
        (channel, platform, display_name, title, viewers, avatar_url, url, started_at, first_seen_at, last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE platform = VALUES(platform), display_name = VALUES(display_name), title = VALUES(title),
            viewers = VALUES(viewers), avatar_url = VALUES(avatar_url), url = VALUES(url),
            started_at = VALUES(started_at), last_seen_at = VALUES(last_seen_at)');
    $n = 0;
    foreach (['live', 'featured'] as $bucket) {
        $rows = is_array($d[$bucket] ?? null) ? $d[$bucket] : [];
        foreach ($rows as $s) {
            if (!is_array($s)) continue;
            $ch = trim((string)($s['channel'] ?? ''));
            if ($ch === '' || $n >= 200) continue;
            $started = isset($s['startedAt']) && is_string($s['startedAt']) && strlen($s['startedAt']) >= 19
                ? iso_to_dt($s['startedAt']) : null;
            $up->execute([
                cut($ch, 64),
                cut((string)($s['platform'] ?? 'twitch'), 16),
                isset($s['displayName']) ? cut((string)$s['displayName'], 64) : null,
                isset($s['title']) ? cut((string)$s['title'], 200) : null,
                (int)($s['viewers'] ?? 0),
                isset($s['avatarUrl']) ? cut((string)$s['avatarUrl'], 300) : null,
                isset($s['url']) ? cut((string)$s['url'], 300) : null,
                $started,
                $now, $now,
            ]);
            $n++;
        }
    }
    $pdo->exec('DELETE FROM tfh_g_streams WHERE last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)');
    state_set($pdo, 'streams_refreshed_at', (string)time());
    log_line("[streams] $n stream(s) live synchronisé(s) — source $src");
}

/* Phase 14 — Sessions de clans (/public/clan/:tag/sessions).
 * Top 50 clans officiels (weightedWins), fenêtre glissante ≤ 23 h depuis le
 * dernier passage COMPLET, pagination limit=100 (max 8 pages/clan), INSERT
 * IGNORE. Curseur clansess_idx : un cycle interrompu par le budget reprend au
 * prochain tick (throttle 10 min en cours de cycle, 6 h quand complet) — le
 * backfill n'est jamais affamé. Purge au-delà de 60 jours. */
function clan_sessions_phase(PDO $pdo, array $cfg, float $deadline): void {
    phase_mark($pdo, 'clansess');
    /* Source 1 : miroir GitHub — ingéré dès qu'une version PLUS RÉCENTE sort
     * (~toutes les 8-10 min, sans throttle) : le job Actions avance sa fenêtre
     * à chaque run, il faut donc tout ingérer au fil de l'eau pour zéro trou.
     * INSERT IGNORE absorbe le chevauchement de 1 h de la fenêtre Actions. */
    $mirror = tfh_fetch_mirror('of_clansessions.json', 300);
    if (is_array($mirror) && is_array($mirror['clans'] ?? null) && isset($mirror['fetchedAt'])
        && strcmp((string)$mirror['fetchedAt'], (string)state_get($pdo, 'clansess_mirror_at', '')) > 0) {
        $now = gmdate('Y-m-d H:i:s');
        $ins = $pdo->prepare('INSERT IGNORE INTO tfh_g_clan_sessions
            (clan_tag, game_id, game_start, clan_player_count, has_won, num_teams, player_teams, total_player_count, score, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)');
        $total = 0;
        foreach ($mirror['clans'] as $tag => $sessions) {
            if (!is_array($sessions)) continue;
            $tagU = strtoupper(cut((string)$tag, 16));
            if ($tagU === '') continue;
            foreach ($sessions as $s) {
                if (!is_array($s)) continue;
                $gid = (string)($s['gameId'] ?? '');
                $gStart = (string)($s['gameStart'] ?? '');
                if ($gid === '' || strlen($gStart) < 19) continue;
                $ins->execute([
                    $tagU, $gid, iso_to_dt($gStart),
                    (int)($s['clanPlayerCount'] ?? 0),
                    !empty($s['hasWon']) ? 1 : 0,
                    isset($s['numTeams']) && is_numeric($s['numTeams']) ? (int)$s['numTeams'] : null,
                    isset($s['playerTeams']) ? cut((string)$s['playerTeams'], 32) : null,
                    isset($s['totalPlayerCount']) && is_numeric($s['totalPlayerCount']) ? (int)$s['totalPlayerCount'] : null,
                    isset($s['score']) && is_numeric($s['score']) ? (float)$s['score'] : null,
                    $now,
                ]);
                $total++;
            }
        }
        state_set($pdo, 'clansess_mirror_at', (string)$mirror['fetchedAt']);
        state_set($pdo, 'clansess_idx', '0');
        state_set($pdo, 'clansess_refreshed_at', (string)time());
        /* Purge : 1 fois par jour environ (si la minute courante est 37). */
        if ((int)gmdate('i') === 37) {
            $pdo->exec('DELETE FROM tfh_g_clan_sessions WHERE game_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY)');
        }
        log_line("[clansess] $total session(s) via miroir GitHub (" . count($mirror['clans']) . ' clan(s), fenêtre '
            . cut((string)($mirror['start'] ?? '?'), 24) . ' → ' . cut((string)($mirror['end'] ?? '?'), 24) . ')');
        return;
    }
    /* Source 2 : API directe (repli si miroir absent/périmé) — curseur repreneur. */
    $idx = (int)state_get($pdo, 'clansess_idx', '0');
    $mins = max(10, $idx > 0 ? 10 : (int)($cfg['clansess_refresh_min'] ?? 360));
    $last = (int)state_get($pdo, 'clansess_refreshed_at', '0');
    if (time() - $last < $mins * 60) return;
    $top = $pdo->query('SELECT clan_tag FROM tfh_g_clans WHERE lb_fetched_at IS NOT NULL
        ORDER BY lb_weighted_wins DESC LIMIT 50')->fetchAll(PDO::FETCH_COLUMN);
    if (!$top) { log_line('[clansess] aucun clan officiel encore synchronisé — retenté au prochain tick'); return; }
    /* Fenêtre : depuis le dernier passage (avec 1 h de chevauchement), plafonnée à 23 h. */
    $startTs = (int)state_get($pdo, 'clansess_last_start', (string)(time() - 6 * 3600));
    $startTs = min($startTs - 3600, time() - 600);
    if (time() - $startTs > 23 * 3600) $startTs = time() - 23 * 3600;
    $start = gmdate('Y-m-d\\TH:00:00\\Z', $startTs);
    $end   = gmdate('Y-m-d\\TH:00:00\\Z', time());
    $now = gmdate('Y-m-d H:i:s');
    $ins = $pdo->prepare('INSERT IGNORE INTO tfh_g_clan_sessions
        (clan_tag, game_id, game_start, clan_player_count, has_won, num_teams, player_teams, total_player_count, score, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)');
    $total = 0;
    for ($i = $idx; $i < count($top); $i++) {
        if (microtime(true) >= $deadline) {
            /* Cycle incomplet : reprise à ce clan au prochain tick. */
            state_set($pdo, 'clansess_idx', (string)$i);
            log_line("[clansess] cycle interrompu au clan " . ($i + 1) . '/' . count($top) . " ($total session(s)) — reprise au prochain tick");
            return;
        }
        $tag = $top[$i];
        for ($page = 1; $page <= 8; $page++) {
            [$st, $d] = of_fetch_resilient(OF_API_BASE . '/public/clan/' . rawurlencode($tag) . '/sessions?start=' . $start . '&end=' . $end . '&page=' . $page . '&limit=50');
            if ($st !== 200 || !is_array($d) || !is_array($d['results'] ?? null)) break;
            $rows = $d['results'];
            foreach ($rows as $s) {
                if (!is_array($s)) continue;
                $gid = (string)($s['gameId'] ?? '');
                $gStart = (string)($s['gameStart'] ?? '');
                if ($gid === '' || strlen($gStart) < 19) continue;
                $ins->execute([
                    $tag, $gid, iso_to_dt($gStart),
                    (int)($s['clanPlayerCount'] ?? 0),
                    !empty($s['hasWon']) ? 1 : 0,
                    isset($s['numTeams']) && is_numeric($s['numTeams']) ? (int)$s['numTeams'] : null,
                    isset($s['playerTeams']) ? cut((string)$s['playerTeams'], 32) : null,
                    isset($s['totalPlayerCount']) && is_numeric($s['totalPlayerCount']) ? (int)$s['totalPlayerCount'] : null,
                    isset($s['score']) && is_numeric($s['score']) ? (float)$s['score'] : null,
                    $now,
                ]);
                $total++;
            }
            if (count($rows) < 50) break;
        }
    }
    /* Cycle complet : fenêtre ancrée à maintenant, throttle repasse à 6 h. */
    state_set($pdo, 'clansess_idx', '0');
    state_set($pdo, 'clansess_last_start', (string)(time() - 600));
    state_set($pdo, 'clansess_refreshed_at', (string)time());
    /* Purge : 1 fois par jour environ (si la minute courante est 37). */
    if ((int)gmdate('i') === 37) {
        $pdo->exec('DELETE FROM tfh_g_clan_sessions WHERE game_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY)');
    }
    log_line("[clansess] $total session(s) pour " . count($top) . ' clan(s) — fenêtre ' . $start . ' → ' . $end);
}

/* ─────────────── v5.13 — Top joueurs de la semaine ───────────────
 * Recalcule l'agrégat des victoires (semaine courante + précédente,
 * frontière lundi 00h00 Europe/Paris — identique à sync-dashboard.js)
 * dans tfh_g_weekly. 100 % SQL local, aucun appel OpenFront → quelques
 * secondes max, tolérant aux erreurs (le tick ne doit jamais mourir ici).
 * Barème identique au dashboard : FFA casual ×10 · FFA classé ×1 ·
 * Team casual ×5 · Team classé ×1. */
function weekly_week_bounds(): array {
    $tz  = new DateTimeZone('Europe/Paris');
    $now = new DateTime('now', $tz);
    $dow = (int)$now->format('N');
    $mon = new DateTime($now->format('Y-m-d') . ' 00:00:00', $tz);
    if ($dow !== 1) $mon->modify('-' . ($dow - 1) . ' day');
    $cur = (int)$mon->getTimestamp();
    return [$cur, $cur - 7 * 86400];
}

function weekly_compute_week(PDO $pdo, int $startTs, int $endTs): array {
    $st = $pdo->prepare(
        "SELECT r.public_id AS pid,
            SUM(CASE WHEN (g.game_mode = 'Team' OR g.ranked_type = '2v2') AND g.ranked_type IN ('1v1','2v2') THEN 1 ELSE 0 END) AS tr,
            SUM(CASE WHEN (g.game_mode = 'Team' OR g.ranked_type = '2v2') AND g.ranked_type NOT IN ('1v1','2v2') THEN 1 ELSE 0 END) AS tc,
            SUM(CASE WHEN NOT (g.game_mode = 'Team' OR g.ranked_type = '2v2') AND g.ranked_type IN ('1v1','2v2') THEN 1 ELSE 0 END) AS fr,
            SUM(CASE WHEN NOT (g.game_mode = 'Team' OR g.ranked_type = '2v2') AND g.ranked_type NOT IN ('1v1','2v2') THEN 1 ELSE 0 END) AS fc
         FROM tfh_g_games g
         JOIN tfh_g_roster r ON r.game_id = g.game_id
         WHERE g.started_at >= FROM_UNIXTIME(?) AND g.started_at < FROM_UNIXTIME(?)
           AND g.game_type = 'Public' AND r.won = 1 AND r.public_id IS NOT NULL
         GROUP BY r.public_id"
    );
    $st->execute([$startTs, $endTs]);
    return $st->fetchAll();
}

function weekly_store_week(PDO $pdo, string $weekDate, int $startTs, int $endTs): int {
    $rows = weekly_compute_week($pdo, $startTs, $endTs);
    if (!$rows) {
        $pdo->prepare('DELETE FROM tfh_g_weekly WHERE week_start = ?')->execute([$weekDate]);
        return 0;
    }
    // Points + classements par mode (rang = position, ex æquo départagés par public_id)
    $list = [];
    foreach ($rows as $r) {
        $fc = (int)$r['fc']; $fr = (int)$r['fr']; $tc = (int)$r['tc']; $tr = (int)$r['tr'];
        $list[] = [
            'pid' => (string)$r['pid'], 'fc' => $fc, 'fr' => $fr, 'tc' => $tc, 'tr' => $tr,
            'all'  => $fc * 10 + $fr + $tc * 5 + $tr,
            'ffa'  => $fc * 10 + $fr,
            'team' => $tc * 5 + $tr,
        ];
    }
    usort($list, static function (array $a, array $b): int {
        return ($b['all'] <=> $a['all']) ?: strcmp($a['pid'], $b['pid']);
    });
    foreach ($list as $i => &$x) $x['rank_all'] = $i + 1;
    unset($x);
    /* Rangs par mode : tri sur des COPIES ne remonte pas dans $list (tableaux
     * PHP copiés par valeur) → on calcule des maps pid → rang puis on assigne. */
    $rankOf = static function (array $rows, string $key): array {
        $sorted = $rows;
        usort($sorted, static function (array $a, array $b) use ($key): int {
            return ($b[$key] <=> $a[$key]) ?: strcmp($a['pid'], $b['pid']);
        });
        $map = [];
        foreach ($sorted as $i => $x) $map[$x['pid']] = $i + 1;
        return $map;
    };
    $rankFfa  = $rankOf($list, 'ffa');
    $rankTeam = $rankOf($list, 'team');
    foreach ($list as &$x) {
        $x['rank_ffa']  = $rankFfa[$x['pid']] ?? null;
        $x['rank_team'] = $rankTeam[$x['pid']] ?? null;
    }
    unset($x);

    $pdo->beginTransaction();
    try {
        $pdo->prepare('DELETE FROM tfh_g_weekly WHERE week_start = ?')->execute([$weekDate]);
        $ins = $pdo->prepare(
            'INSERT INTO tfh_g_weekly
                (week_start, public_id, ffa_casual, ffa_ranked, team_casual, team_ranked,
                 pts_all, pts_ffa, pts_team, rank_all, rank_ffa, rank_team, computed_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())'
        );
        $n = 0;
        foreach ($list as $x) {
            $ins->execute([
                $weekDate, $x['pid'], $x['fc'], $x['fr'], $x['tc'], $x['tr'],
                $x['all'], $x['ffa'], $x['team'], $x['rank_all'], $x['rank_ffa'], $x['rank_team'],
            ]);
            $n++;
        }
        $pdo->commit();
        return $n;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

function weekly_phase(PDO $pdo): void {
    [$cur, ] = weekly_week_bounds();
    $curDate  = gmdate('Y-m-d', $cur);
    $prevDate = gmdate('Y-m-d', $cur - 7 * 86400);
    $n1 = weekly_store_week($pdo, $curDate, $cur, $cur + 7 * 86400);
    $n2 = weekly_store_week($pdo, $prevDate, $cur - 7 * 86400, $cur);
    // Rétention : 8 semaines glissantes suffisent (tendance + historique court)
    $pdo->prepare('DELETE FROM tfh_g_weekly WHERE week_start < DATE_SUB(?, INTERVAL 56 DAY)')
        ->execute([$curDate]);
    log_line("[weekly] top semaine recalculé : $n1 joueur(s) (courante) / $n2 (précédente)");
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
    /* v5.11 — compteurs API officielles */
    $v511 = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_ladder) AS ladder_rows,
        (SELECT MAX(fetched_at) FROM tfh_g_ladder) AS ladder_at,
        (SELECT COUNT(*) FROM tfh_g_ladder_history) AS ladder_hist,
        (SELECT COUNT(*) FROM tfh_g_profiles) AS profiles,
        (SELECT COUNT(*) FROM tfh_g_profiles WHERE not_found = 1) AS profiles_gone,
        (SELECT COUNT(*) FROM tfh_g_clans WHERE lb_fetched_at IS NOT NULL) AS clans_official,
        (SELECT MAX(lb_fetched_at) FROM tfh_g_clans) AS clans_official_at')->fetch();
    /* v5.12 — nouveaux flux */
    $v512 = $pdo->query('SELECT
        (SELECT COUNT(*) FROM tfh_g_lb_ffa) AS ffa_rows,
        (SELECT COUNT(*) FROM tfh_g_lb_ffa_history) AS ffa_hist,
        (SELECT COUNT(*) FROM tfh_g_tribes) AS tribes,
        (SELECT COUNT(*) FROM tfh_g_news) AS news,
        (SELECT COUNT(*) FROM tfh_g_streams WHERE last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR)) AS streams_live,
        (SELECT COUNT(*) FROM tfh_g_clan_sessions) AS clan_sessions')->fetch();
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
        'backfill_done' => (int)state_get($pdo, STATE_KEY_BACKFIL, (string)GAMES_EPOCH_DEEP_MS) <= GAMES_EPOCH_DEEP_MS,
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
        'v511' => [
            'ladder_rows' => (int)$v511['ladder_rows'],
            'ladder_fetched_at' => $v511['ladder_at'],
            'ladder_history_rows' => (int)$v511['ladder_hist'],
            'profiles' => (int)$v511['profiles'],
            'profiles_gone' => (int)$v511['profiles_gone'],
            'profiles_total_fetched' => (int)state_get($pdo, 'profiles_fetched_total', '0'),
            'clans_official' => (int)$v511['clans_official'],
            'clans_official_at' => $v511['clans_official_at'],
        ],
        'v512' => [
            'ffa_board_rows' => (int)$v512['ffa_rows'],
            'ffa_board_history' => (int)$v512['ffa_hist'],
            'tribes' => (int)$v512['tribes'],
            'news' => (int)$v512['news'],
            'streams_live' => (int)$v512['streams_live'],
            'clan_sessions' => (int)$v512['clan_sessions'],
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
    if ($ms < GAMES_EPOCH_DEEP_MS) $ms = GAMES_EPOCH_DEEP_MS;
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

// 1b) v5.11 — API OFFICIELLES (tranche réservée en tête de tick) :
//     ladder ranked (2 req, throttle 30 min), leaderboard clans (1 req,
//     throttle 1 h), profils joueurs /public/player/:id (budget dédié
//     profile_seconds_per_tick). En tête de tick pour ne pas être affamées
//     par le backfill ; leurs 429 partagent le circuit AIMD global.
try { if (microtime(true) < $deadline) ladder_phase($pdo, $cfg); } catch (Throwable $e) { log_line('[ladder] ⚠️ ' . cut($e->getMessage(), 140)); }
try { if (microtime(true) < $deadline) clans_lb_phase($pdo, $cfg); } catch (Throwable $e) { log_line('[clanslb] ⚠️ ' . cut($e->getMessage(), 140)); }
// v5.12 — nouveaux flux officielles (tous throttlés, additifs, non bloquants)
try { if (microtime(true) < $deadline) ffa_board_phase($pdo, $cfg); } catch (Throwable $e) { log_line('[ffaboard] ⚠️ ' . cut($e->getMessage(), 140)); }
try { if (microtime(true) < $deadline) tribes_phase($pdo, $cfg); } catch (Throwable $e) { log_line('[tribes] ⚠️ ' . cut($e->getMessage(), 140)); }
try { if (microtime(true) < $deadline) news_phase($pdo, $cfg); } catch (Throwable $e) { log_line('[news] ⚠️ ' . cut($e->getMessage(), 140)); }
try { if (microtime(true) < $deadline) streams_phase($pdo, $cfg); } catch (Throwable $e) { log_line('[streams] ⚠️ ' . cut($e->getMessage(), 140)); }
try { if (microtime(true) < $deadline) clan_sessions_phase($pdo, $cfg, $deadline); } catch (Throwable $e) { log_line('[clansess] ⚠️ ' . cut($e->getMessage(), 140)); }
try { if (microtime(true) < $deadline) profiles_phase($pdo, $cfg, $deadline); } catch (Throwable $e) { log_line('[profiles] ⚠️ ' . cut($e->getMessage(), 140)); }

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

// 2b) v5.16 — migration des versions des parties existantes (lots de 20 k,
//     jusqu'à épuisement ; aucun appel API, quelques ticks seulement)
try { vermig_phase($pdo); } catch (Throwable $e) { log_line('[vermig] ⚠️ ' . cut($e->getMessage(), 140)); }

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
while (microtime(true) < $deadline && $cursor - $windowMs >= GAMES_EPOCH_DEEP_MS - 3600 * 1000) {
    $wEnd = $cursor;
    $wStart = max($cursor - $windowMs, GAMES_EPOCH_DEEP_MS);
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
        /* v5.16 : au-dessus de la frontière V34 → ingestion détaillée
         * (scan_range) ; en dessous → « liste d'abord » (scan_meta_range)
         * pour reconstruire l'archive profonde (mai 2025 → sept. 2026),
         * les détails arrivant ensuite via enrich_phase. */
        if ($wEnd <= GAMES_EPOCH_MS) {
            [$ing, $seen, $ok] = scan_meta_range(
                $pdo, $wStart, $wEnd, $cfg, $deadline, 'backfill-deep', $startOffset,
                function (int $nextOffset) use ($pdo) {
                    state_set($pdo, BK_WIN_OFF, (string)$nextOffset);
                },
                $gt
            );
        } else {
            [$ing, $seen, $ok] = scan_range(
                $pdo, $wStart, $wEnd, $cfg, $deadline, $unameCache, 'backfill', $startOffset,
                function (int $nextOffset) use ($pdo) {
                    state_set($pdo, BK_WIN_OFF, (string)$nextOffset);
                },
                $gt
            );
        }
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
if ($windowsDone > 0 && $cursor <= GAMES_EPOCH_DEEP_MS + 3600 * 1000) {
    log_line('[backfill] ✅ epoch profonde (mai 2025) atteinte — historique maximal ingéré');
}

// 4) v5 — Catalogue officiel des cosmétiques (throttlé 6 h)
try { catalog_phase($pdo, $cfg); } catch (Throwable $e) { log_line('[catalog] ⚠️ ' . cut($e->getMessage(), 140)); }

// 5) v5 — Enrichissement des anciennes parties (cosmétiques, clans, config, stats)
try {
    [$enrDone, $enrLeft] = enrich_phase($pdo, $cfg, $deadline, $unameCache);
    if ($enrDone > 0) log_line("[enrich] $enrDone partie(s) enrichie(s) — restantes : $enrLeft");
} catch (Throwable $e) { log_line('[enrich] ⚠️ ' . cut($e->getMessage(), 140)); }

// 5-bis) v5.22 — Rattrapage local des speedruns (ZÉRO appel API) : classifie
// les lignes déjà enrichies avant le fix (v5_done=1, jamais passées par
// classify_speedrun) à partir de config_json + roster stockés.
try {
    if (microtime(true) < $deadline) {
        [$rcDone, $rcLeft] = reclassify_phase($pdo, $cfg);
        if ($rcDone > 0) log_line("[reclassify] $rcDone partie(s) classée(s) — restantes : $rcLeft");
    }
} catch (Throwable $e) { log_line('[reclassify] ⚠️ ' . cut($e->getMessage(), 140)); }

// 6) v5 — Rating Glicko-2 (3 boards, curseur chronologique)
try { if (microtime(true) < $deadline) rating_phase($pdo, $cfg, $deadline); } catch (Throwable $e) { log_line('[rating] ⚠️ ' . cut($e->getMessage(), 140)); }

// 7) v5 — Replays turn-by-turn (gzip, plafonné par tick)
try {
    if (microtime(true) < $deadline) {
        $tn = turns_phase($pdo, $cfg, $deadline);
        if ($tn > 0) log_line("[turns] $tn replay(s) stocké(s)");
    }
} catch (Throwable $e) { log_line('[turns] ⚠️ ' . cut($e->getMessage(), 140)); }

// 8) v5.13 — Top joueurs de la semaine (pré-calcul local, semaine + précédente)
try { weekly_phase($pdo); } catch (Throwable $e) { log_line('[weekly] ⚠️ ' . cut($e->getMessage(), 140)); }

phase_mark($pdo, 'fin');

// Résumé + persistance des stats HTTP (visibilité rate limits)
// v4.1 : tick sans le moindre 429 → le débit remonte au moins au niveau de
// départ (élasticité rapide après un passage au plancher AIMD).
$rateStart = max(0.5, (float)$cfg['detail_rate_start_per_s']);
if ($OF_STATS['r429'] === 0 && $OF_RATE < $rateStart) {
    $OF_RATE = min($OF_RATE_MAX, $rateStart);
    $OF_OK_RUN = 0;
}
$done = $cursor <= GAMES_EPOCH_DEEP_MS + 3600 * 1000;
state_set($pdo, 'of_rate_cur', (string)round($OF_RATE, 2));
state_set($pdo, 'of_429_total', (string)((int)state_get($pdo, 'of_429_total', '0') + $OF_STATS['r429']));
state_set($pdo, 'of_err_total', (string)((int)state_get($pdo, 'of_err_total', '0') + $OF_STATS['err']));
log_line("[fin] $totalIngested partie(s) ingérée(s) — $windowsDone fenêtre(s) backfill — HTTP ok:{$OF_STATS['ok']} 429:{$OF_STATS['r429']} err:{$OF_STATS['err']} — débit détail " . round($OF_RATE, 1) . '/s — backfill ' . ($done ? 'TERMINÉ' : 'en cours (' . gmdate('Y-m-d', intdiv($cursor, 1000)) . ')'));
