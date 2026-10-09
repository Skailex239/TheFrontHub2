<?php
declare(strict_types=1);

/**
 * api/games-db.php — Résolution de la base « games » (tables tfh_g_*) v5.43.
 *
 * v5.43 — SÉPARATION DEV / MAIN. Constat : dev.thefronthub.com et
 * thefronthub.com partageaient la MÊME base MySQL (mêmes secrets), donc un
 * reset « dev » aurait détruit les speedruns de la prod. Désormais :
 *
 *   - le webroot PROD (thefronthub.com) lit  secrets['games_db'] ?? secrets['mysql']
 *   - le webroot DEV  (dev.thefronthub.com) lit secrets['games_db_dev'], avec
 *     repli sur games_db ?? mysql tant que la base dédiée n'est pas créée
 *     (comportement identique à avant — aucun risque, wipe refusé si partagée).
 *
 * Le reste du site (auth, skins, likes, chat…) reste sur secrets['mysql'] :
 * seule la pile games (tfh_g_* + tfh_g_profile_*) bascule.
 *
 * Secrets attendus (~/.tfs_secrets/tfh-secrets.json) :
 *   {
 *     "mysql":        { "host": ..., "database": ..., "username": ..., "password": ... },
 *     "games_db_dev": { "host": ..., "database": "mask6607_tfh_dev", ... }   ← NOUVEAU (dev)
 *   }
 *
 * Helpers cross-base : quand dev et prod utilisent des bases distinctes mais
 * sur le MÊME serveur MySQL, les rares requêtes mixtes (tfh_g_roster JOIN
 * tfh_users, etc.) qualifient la table de l'autre base via tfh_games_ref() /
 * tfh_site_ref(). Quand les bases coïncident (prod, repli), ces helpers
 * retournent le nom de table brut — zéro changement de comportement.
 */

if (!defined('TFH_API') && PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Forbidden');
}

/** Secrets API (même résolution que api/config.php, mise en cache). */
function tfh_games_secrets(): ?array
{
    static $cache = null;
    if ($cache !== null) return $cache;
    $paths = [];
    $home = getenv('HOME');
    if (is_string($home) && $home !== '') {
        $paths[] = rtrim($home, '/') . '/.tfs_secrets/tfh-secrets.json';
    }
    /* prod : api -> thefronthub.com -> public_html -> home ; dev : api -> dev.thefronthub.com -> home */
    $paths[] = dirname(__DIR__, 3) . '/.tfs_secrets/tfh-secrets.json';
    $paths[] = dirname(__DIR__, 2) . '/.tfs_secrets/tfh-secrets.json';
    foreach ($paths as $p) {
        if (is_readable($p)) {
            $d = json_decode((string) file_get_contents($p), true);
            if (is_array($d)) { $cache = $d; return $cache; }
        }
    }
    return $cache = null;
}

/** Vrai si ce webroot est l'environnement DEV (dev.thefronthub.com). */
function tfh_games_is_dev(): bool
{
    $dir = basename(dirname(__DIR__)); // api -> webroot
    return $dir === 'dev.thefronthub.com' || str_starts_with($dir, 'dev.');
}

/**
 * Config MySQL de la base games.
 *   $which = 'auto' : webroot dev → games_db_dev (repli auto), sinon prod
 *   $which = 'dev'  : force la config dev (games_db_dev), repli auto si absente
 *   $which = 'site' : secrets['games_db'] ?? secrets['mysql'] (base « site »)
 * Retour null si la config demandée n'existe pas du tout.
 */
function tfh_games_db_conf(string $which = 'auto'): ?array
{
    $secrets = tfh_games_secrets();
    if (!is_array($secrets)) return null;
    $mysql   = is_array($secrets['mysql'] ?? null) ? $secrets['mysql'] : null;
    $gamesDb = is_array($secrets['games_db'] ?? null) ? $secrets['games_db'] : null;
    $devDb   = is_array($secrets['games_db_dev'] ?? null) ? $secrets['games_db_dev'] : null;

    if ($which === 'site') {
        return $gamesDb ?? $mysql;
    }
    if ($which === 'dev') {
        if ($devDb !== null) return $devDb;
        return tfh_games_is_dev() ? ($gamesDb ?? $mysql) : null; // hors dev : rien à forcer
    }
    /* auto */
    if (tfh_games_is_dev() && $devDb !== null) return $devDb;
    return $gamesDb ?? $mysql;
}

/** Nom de la base games résolue (null si aucune config). */
function tfh_games_db_name(string $which = 'auto'): ?string
{
    $c = tfh_games_db_conf($which);
    return is_array($c) && isset($c['database']) ? (string) $c['database'] : null;
}

/** Connexion PDO vers la base games (mise en cache par $which). */
function tfh_games_pdo(string $which = 'auto'): ?PDO
{
    static $conns = [];
    if (isset($conns[$which])) return $conns[$which];
    $c = tfh_games_db_conf($which);
    if (!is_array($c) || !isset($c['database'], $c['username'])) {
        return $conns[$which] = null;
    }
    try {
        $conns[$which] = new PDO(
            sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                (string) ($c['host'] ?? 'localhost'), (int) ($c['port'] ?? 3306), (string) $c['database']),
            (string) $c['username'],
            (string) ($c['password'] ?? ''),
            [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]
        );
    } catch (Throwable $e) {
        error_log('[tfh-games-db] PDO(' . $which . '): ' . $e->getMessage());
        return $conns[$which] = null;
    }
    return $conns[$which];
}

/**
 * Vrai si une base games DEV ISOLÉE de la base site est configurée
 * (games_db_dev ≠ mysql) — prérequis pour autoriser un reset : on ne
 * détruit jamais la base partagée ni la base prod.
 * Indépendant du webroot : le panel admin (admin.thefronthub.com) doit
 * pouvoir juger l'isolation de la base dev sans être lui-même sur dev.
 */
function tfh_games_isolated(): bool
{
    $secrets = tfh_games_secrets();
    if (!is_array($secrets)) return false;
    $devDb = is_array($secrets['games_db_dev'] ?? null) ? $secrets['games_db_dev'] : null;
    if ($devDb === null || !isset($devDb['database'])) return false;
    $site = is_array($secrets['mysql'] ?? null) ? (string) ($secrets['mysql']['database'] ?? '') : '';
    $dev  = (string) $devDb['database'];
    return $site !== '' && $dev !== '' && $dev !== $site;
}

/**
 * Qualifie une table de la base GAMES pour une requête exécutée sur la
 * connexion SITE (lobby-chat.php : tfh_g_roster JOIN tfh_users…).
 * Bases identiques (prod / repli) → nom brut, aucun changement SQL.
 */
function tfh_games_ref(string $table): string
{
    static $ref = false;
    if ($ref === false) {
        $ref = null;
        $secrets = tfh_games_secrets();
        $site = is_array($secrets['mysql'] ?? null) ? (string) ($secrets['mysql']['database'] ?? '') : '';
        $games = tfh_games_db_name('auto');
        if ($games !== null && $site !== '' && $games !== $site) {
            $ref = '`' . str_replace('`', '', $games) . '`.';
        }
    }
    return ($ref ?? '') . '`' . str_replace('`', '', $table) . '`';
}

/**
 * Qualifie une table de la base SITE pour une requête exécutée sur la
 * connexion GAMES (games-api.php : porteurs cosmétiques JOIN tfh_users…).
 * Bases identiques → nom brut.
 */
function tfh_site_ref(string $table): string
{
    static $ref = false;
    if ($ref === false) {
        $ref = null;
        $secrets = tfh_games_secrets();
        $site = is_array($secrets['mysql'] ?? null) ? (string) ($secrets['mysql']['database'] ?? '') : '';
        $games = tfh_games_db_name('auto');
        if ($games !== null && $site !== '' && $games !== $site) {
            $ref = '`' . str_replace('`', '', $site) . '`.';
        }
    }
    return ($ref ?? '') . '`' . str_replace('`', '', $table) . '`';
}
