<?php
declare(strict_types=1);

/**
 * api/profile-cache.php — Cache FICHIER des payloads « pré-profil » (v5.36).
 *
 * « Les profils doivent s'afficher instantanément » : la route
 * /api/games-api.php?route=profile coûte ~10 requêtes SQL (dont des GROUP BY
 * sur le roster complet). Ce cache stocke le payload JSON calculé dans
 * profile-cache/{publicId}.json (webroot, exclu du rsync de deploy.sh) :
 *
 *   - lecture  : si le fichier a moins de TFH_PROFILE_CACHE_TTL secondes, la
 *     route le sert directement (lecture fichier ≈ qq millisecondes) ;
 *   - écriture : chaque calcul (route en miss ou profile-warm.php) met le
 *     fichier à jour ATOMIQUEMENT (tmp + rename) ;
 *   - invalidation : les actions qui mutent les données hub (profile.php :
 *     pseudo/publicId/vérif/bio/liens, rewards/banners/skins : VIP et
 *     cosmétiques actifs) appellent tfh_profile_cache_invalidate() ;
 *   - pré-génération : api/profile-warm.php (cron) remplit le cache pour les
 *     joueurs pertinents → la quasi-totalité des visites lit un fichier chaud.
 *
 * Fraîcheur : TTL 15 min (aligné sur le tick games-sync) — les données de jeu
 * du site s'actualisent de toute façon au rythme du cron. Tout est défensif :
 * un cache indisponible = comportement d'avant (calcul direct), jamais d'erreur.
 */

const TFH_PROFILE_CACHE_TTL = 900; // 15 min

/** Répertoire du cache (webroot/profile-cache, surchargeable pour les tests). */
function tfh_profile_cache_dir(): string
{
    $env = getenv('TFH_PROFILE_CACHE_DIR');
    if (is_string($env) && $env !== '') {
        return rtrim($env, '/') ;
    }
    return __DIR__ . '/../profile-cache';
}

/** Chemin du fichier cache d'un publicId (pid déjà validé [A-Za-z0-9]{6,16}). */
function tfh_profile_cache_file(string $pid): string
{
    return tfh_profile_cache_dir() . '/' . preg_replace('/[^A-Za-z0-9]/', '', $pid) . '.json';
}

/** Payload en cache si frais, sinon null (jamais d'exception). */
function tfh_profile_cache_read(string $pid, int $ttl = TFH_PROFILE_CACHE_TTL): ?array
{
    $file = tfh_profile_cache_file($pid);
    if (!is_readable($file)) {
        return null;
    }
    $mtime = @filemtime($file);
    if ($mtime === false || (time() - $mtime) > $ttl) {
        return null;
    }
    $raw = @file_get_contents($file);
    if (!is_string($raw) || $raw === '') {
        return null;
    }
    $j = json_decode($raw, true);
    if (!is_array($j) || empty($j['ok'])) {
        return null;
    }
    return $j;
}

/** Écriture atomique (tmp + rename). Best-effort : un échec n'est jamais fatal. */
function tfh_profile_cache_write(string $pid, array $payload): void
{
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false || $json === '') {
        return;
    }
    $dir = tfh_profile_cache_dir();
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    if (is_dir($dir)) {
        /* .htaccess défensif : le cache n'a pas à être servi en direct (la
         * route API porte les bons en-têtes) — un dossier webroot ne doit
         * jamais être un dump indexable. */
        $ht = $dir . '/.htaccess';
        if (!file_exists($ht)) {
            @file_put_contents($ht, "Require all denied\n");
        }
    }
    $file = tfh_profile_cache_file($pid);
    $tmp  = $file . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
        @unlink($tmp);
        return;
    }
    @rename($tmp, $file); // atomique : un lecteur ne voit jamais un fichier à moitié écrit
}

/** Invalidation (profil muté côté hub : pseudo, bio, liens, VIP, cosmétiques…). */
function tfh_profile_cache_invalidate(string $pid): void
{
    if ($pid === '') {
        return;
    }
    @unlink(tfh_profile_cache_file($pid));
}

/** Compteur de popularité : alimente la liste de pré-génération (warm). */
function tfh_profile_count_view(PDO $pdo, string $pid): void
{
    static $ready = null;
    if ($ready === null) {
        try {
            $pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_profile_views (
                public_id VARCHAR(16)     NOT NULL PRIMARY KEY,
                views     BIGINT UNSIGNED NOT NULL DEFAULT 0,
                last_view DATETIME        NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            $ready = true;
        } catch (Throwable $e) {
            $ready = false;
        }
    }
    if ($ready !== true) {
        return;
    }
    try {
        $pdo->prepare('INSERT INTO tfh_g_profile_views (public_id, views, last_view)
            VALUES (?, 1, NOW())
            ON DUPLICATE KEY UPDATE views = views + 1, last_view = NOW()')
            ->execute([$pid]);
    } catch (Throwable $e) {
        /* jamais bloquant */
    }
}

/* ══ v5.42 — Compteur PUBLIC « vues » du profil : 1 par visite du site ═════
 * L'ancien compteur (colonne views ci-dessus) compte CHAQUE appel API — y
 * compris le pré-chargement au survol (pf-prefetch) et les rechargements :
 * il reste un indicateur interne de popularité (priorité de warm). Le
 * compteur PUBLIC (colonne public_views) n'incrémente QUE via la route
 * POST route=profile-view, dédoublonnée côté serveur :
 *   - le navigateur produit un visitId par VISITE (sessionStorage, vit tant
 *     que l'onglet est ouvert) ;
 *   - la table tfh_g_profile_visit_seen retient les couples (profil, visite)
 *     déjà comptés → recharger la page, y revenir, la re-rendre = toujours
 *     1 seule vue dans la même visite ;
 *   - garde anti-spam : max 10 vues comptées / jour / IP / profil ;
 *   - rétention des dédoublonnages 7 jours (purge paresseuse 1 % des appels).
 * Tout est défensif : un échec SQL ne casse jamais l'affichage du profil. */

const TFH_PROFILE_VISIT_MAX_PER_DAY = 10;

function tfh_profile_views_ensure(PDO $pdo): bool
{
    static $ready = null;
    if ($ready !== null) {
        return $ready;
    }
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS tfh_g_profile_visit_seen (
            public_id  VARCHAR(16) NOT NULL,
            visit_hash CHAR(32)    NOT NULL,
            ip_hash    CHAR(32)    NOT NULL DEFAULT '',
            seen_at    DATETIME    NOT NULL,
            PRIMARY KEY (public_id, visit_hash),
            INDEX idx_gpvseen_ip (public_id, ip_hash, seen_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
        /* Colonne public_views sur la table compteur existante (idempotent). */
        $st = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = "tfh_g_profile_views"
               AND COLUMN_NAME = "public_views"'
        );
        $st->execute();
        if ((int) $st->fetchColumn() === 0) {
            $pdo->exec('ALTER TABLE tfh_g_profile_views
                ADD COLUMN public_views BIGINT UNSIGNED NOT NULL DEFAULT 0');
        }
        $ready = true;
    } catch (Throwable $e) {
        error_log('[tfh-api] profile_views schema: ' . $e->getMessage());
        $ready = false;
    }
    return $ready;
}

/** Compteur « vues » public courant (0 si absent de la base). Jamais bloquant. */
function tfh_profile_views_get(PDO $pdo, string $pid): int
{
    if (!tfh_profile_views_ensure($pdo)) {
        return 0;
    }
    try {
        $st = $pdo->prepare('SELECT public_views FROM tfh_g_profile_views WHERE public_id = ?');
        $st->execute([$pid]);
        $v = $st->fetchColumn();
        return $v === false ? 0 : (int) $v;
    } catch (Throwable $e) {
        return 0;
    }
}

/**
 * Dédoublonne la visite puis incrémente si nécessaire.
 * Retourne le compteur public après coup (valeur à afficher).
 */
function tfh_profile_count_visit(PDO $pdo, string $pid, string $visitHash, string $ipHash): int
{
    if (tfh_profile_views_ensure($pdo)) {
        try {
            /* 1) Visite déjà comptée pour ce profil ? (PK = dédoublonnage) */
            $st = $pdo->prepare(
                'INSERT IGNORE INTO tfh_g_profile_visit_seen (public_id, visit_hash, ip_hash, seen_at)
                 VALUES (?, ?, ?, NOW())'
            );
            $st->execute([$pid, $visitHash, $ipHash]);
            if ($st->rowCount() > 0) {
                /* 2) Nouvelle visite : garde anti-spam par IP. */
                $c = $pdo->prepare(
                    'SELECT COUNT(*) FROM tfh_g_profile_visit_seen
                     WHERE public_id = ? AND ip_hash = ? AND seen_at >= CURDATE()'
                );
                $c->execute([$pid, $ipHash]);
                if ((int) $c->fetchColumn() <= TFH_PROFILE_VISIT_MAX_PER_DAY) {
                    $pdo->prepare(
                        'INSERT INTO tfh_g_profile_views (public_id, views, public_views, last_view)
                         VALUES (?, 0, 1, NOW())
                         ON DUPLICATE KEY UPDATE public_views = public_views + 1, last_view = NOW()'
                    )->execute([$pid]);
                }
            }
            /* 3) Purge paresseuse : les visites > 7 jours ne servent plus. */
            if (mt_rand(1, 100) === 1) {
                $pdo->exec('DELETE FROM tfh_g_profile_visit_seen
                    WHERE seen_at < NOW() - INTERVAL 7 DAY');
            }
        } catch (Throwable $e) {
            error_log('[tfh-api] profile_count_visit: ' . $e->getMessage());
        }
    }
    return tfh_profile_views_get($pdo, $pid);
}
