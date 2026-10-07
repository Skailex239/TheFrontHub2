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
