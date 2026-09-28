<?php
declare(strict_types=1);

/**
 * api/profile-schema.php — Migration additive « profils revendiqués » (v5.13).
 *
 * Colonnes profil sur tfh_users (bio, map préférée, liens réseaux, état de
 * vérification) + table tfh_g_weekly (top joueurs de la semaine pré-calculé
 * par api/games-sync.php).
 *
 * ⚠️ 100 % additif et idempotent : aucune donnée existante n'est modifiée ni
 * supprimée. Appelé par profile.php / me.php / public-aliases.php /
 * games-api.php (garde statique : une seule exécution par requête PHP).
 *
 * Le hash du code de vérification n'est PAS stocké : le code sert uniquement
 * de « défi en jeu » (il doit apparaître dans le pseudo d'une partie récente
 * du publicId revendiqué — seule la personne qui contrôle le compte peut le
 * faire apparaître). own_code n'est donc pas un secret d'authentification,
 * c'est un jeton de défi à durée de vie courte (48 h).
 */

if (!defined('TFH_API')) {
    http_response_code(403);
    exit('Forbidden');
}

function tfh_profile_ensure_schema(PDO $pdo): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;

    /* ── 1) Colonnes profil sur tfh_users (ADD COLUMN idempotent) ── */
    $wanted = [
        'bio'             => "VARCHAR(500) NULL",
        'fav_map'         => "VARCHAR(64) NULL",
        'link_x'          => "VARCHAR(150) NULL",
        'link_youtube'    => "VARCHAR(150) NULL",
        'link_twitch'     => "VARCHAR(150) NULL",
        'link_discord'    => "VARCHAR(150) NULL",
        'verified_at'     => "DATETIME NULL",
        'own_code'        => "VARCHAR(12) NULL",
        'own_code_expires' => "DATETIME NULL",
    ];
    try {
        $st = $pdo->prepare(
            'SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = "tfh_users"'
        );
        $st->execute();
        $existing = array_fill_keys(array_map('strval', $st->fetchAll(PDO::FETCH_COLUMN)), true);
        foreach ($wanted as $col => $ddl) {
            if (!isset($existing[$col])) {
                try {
                    $pdo->exec("ALTER TABLE `tfh_users` ADD COLUMN `{$col}` {$ddl}");
                } catch (Throwable $e) {
                    error_log('[tfh-api] schema tfh_users.' . $col . ': ' . $e->getMessage());
                }
            }
        }
    } catch (Throwable $e) {
        error_log('[tfh-api] schema probe tfh_users: ' . $e->getMessage());
        return; // table absente : rien d'autre à tenter proprement
    }

    /* ── 2) Backfill : les comptes déjà liés (public_id) gardent leur badge ── */
    try {
        $pdo->exec(
            "UPDATE tfh_users SET verified_at = NOW()
             WHERE public_id IS NOT NULL AND public_id <> '' AND verified_at IS NULL"
        );
    } catch (Throwable $e) {
        error_log('[tfh-api] schema backfill verified_at: ' . $e->getMessage());
    }

    /* ── 3) Index sur tfh_public_aliases(public_id) pour les jointures badge ── */
    try {
        $st = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = "tfh_public_aliases" AND INDEX_NAME = "idx_tpubaliases_pid"'
        );
        $st->execute();
        if ((int) $st->fetchColumn() === 0) {
            try {
                $pdo->exec('ALTER TABLE `tfh_public_aliases` ADD INDEX `idx_tpubaliases_pid` (`public_id`)');
            } catch (Throwable $e) {
                error_log('[tfh-api] schema idx_tpubaliases_pid: ' . $e->getMessage());
            }
        }
    } catch (Throwable $e) {
        error_log('[tfh-api] schema probe tfh_public_aliases: ' . $e->getMessage());
    }

    /* ── 4) Table du top hebdomadaire (remplie par games-sync.php) ── */
    try {
        $pdo->exec(
            "CREATE TABLE IF NOT EXISTS tfh_g_weekly (
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
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
        );
    } catch (Throwable $e) {
        error_log('[tfh-api] schema tfh_g_weekly: ' . $e->getMessage());
    }
}

/**
 * Lundi 00h00 Europe/Paris de la semaine courante (le même découpage que
 * sync-dashboard.js getWeekStartMs : DST géré par DateTime).
 * Retourne [curMondayMs, prevMondayMs] en millisecondes UTC.
 */
function tfh_week_bounds_ms(): array
{
    $tz  = new DateTimeZone('Europe/Paris');
    $now = new DateTime('now', $tz);
    $dow = (int) $now->format('N'); // 1 = lundi … 7 = dimanche
    $mon = new DateTime($now->format('Y-m-d') . ' 00:00:00', $tz);
    if ($dow !== 1) {
        $mon->modify('-' . ($dow - 1) . ' day');
    }
    $cur  = (int) $mon->getTimestamp() * 1000;
    $prev = $cur - 7 * 86400 * 1000;
    return [$cur, $prev];
}

/**
 * Map publicId → bool (compte revendiqué ET vérifié serveur).
 * Vérifié = lié à un compte TheFrontHub dont verified_at est posé.
 * $pids est découpé en paquets pour rester compatible avec tout MySQL.
 */
function tfh_verified_map(PDO $pdo, array $pids): array
{
    $pids = array_values(array_unique(array_filter(array_map('strval', $pids))));
    if (!$pids) {
        return [];
    }
    $out = [];
    foreach (array_chunk($pids, 100) as $chunk) {
        $ph = implode(',', array_fill(0, count($chunk), '?'));
        try {
            $st = $pdo->prepare(
                "SELECT pa.public_id
                 FROM tfh_public_aliases pa
                 JOIN tfh_users u ON u.id = pa.user_id
                 WHERE pa.public_id IN ($ph) AND u.verified_at IS NOT NULL"
            );
            $st->execute($chunk);
            foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $pid) {
                $out[(string) $pid] = true;
            }
        } catch (Throwable $e) {
            error_log('[tfh-api] verified_map: ' . $e->getMessage());
            return $out;
        }
    }
    return $out;
}

/** Champs profil publics d'un publicId (bio, map préférée, liens) ou null. */
function tfh_profile_extras(PDO $pdo, string $pid): ?array
{
    try {
        $st = $pdo->prepare(
            'SELECT u.bio, u.fav_map, u.link_x, u.link_youtube, u.link_twitch, u.link_discord,
                    u.verified_at, u.username AS hub_username, UNIX_TIMESTAMP(u.verified_at) AS verified_ts
             FROM tfh_public_aliases pa JOIN tfh_users u ON u.id = pa.user_id
             WHERE pa.public_id = ? LIMIT 1'
        );
        $st->execute([$pid]);
        $r = $st->fetch();
        if ($r === false) {
            return null;
        }
        return [
            'bio'        => $r['bio'] !== null ? (string) $r['bio'] : null,
            'favMap'     => $r['fav_map'] !== null ? (string) $r['fav_map'] : null,
            'links'      => [
                'x'       => $r['link_x'] !== null ? (string) $r['link_x'] : null,
                'youtube' => $r['link_youtube'] !== null ? (string) $r['link_youtube'] : null,
                'twitch'  => $r['link_twitch'] !== null ? (string) $r['link_twitch'] : null,
                'discord' => $r['link_discord'] !== null ? (string) $r['link_discord'] : null,
            ],
            'alias'      => $r['hub_username'] !== null ? (string) $r['hub_username'] : null,
            'verified'   => $r['verified_at'] !== null,
            'verifiedAt' => $r['verified_ts'] !== null ? (int) $r['verified_ts'] : null,
        ];
    } catch (Throwable $e) {
        error_log('[tfh-api] profile_extras: ' . $e->getMessage());
        return null;
    }
}
