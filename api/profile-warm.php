<?php
declare(strict_types=1);

/**
 * api/profile-warm.php — PRÉ-GÉNÉRATION des profils (cache fichier) — v5.36.
 *
 * « Les profils doivent s'afficher INSTANTANÉMENT » : ce script pré-construit
 * les payloads route=profile (api/profile-payload.php) des joueurs pertinents
 * et les écrit dans profile-cache/{publicId}.json. La route API lit ensuite ce
 * fichier en quelques millisecondes (au lieu de ~10 requêtes SQL dont des
 * GROUP BY sur le roster) → un clic sur un joueur affiche son profil quasi
 * immédiatement, et le dossier cockpit client se construit sans le moindre
 * appel OpenFront lent (l'arbre de carrière officiel est dans le payload).
 *
 * Qui est pré-généré (union, par priorité) :
 *   1. les profils LES PLUS CONSULTÉS  (tfh_g_profile_views, posé par la route) ;
 *   2. le top hebdo                    (tfh_g_weekly, semaine courante) ;
 *   3. le ladder officiel 1v1/2v2      (tfh_g_ladder) ;
 *   4. les comptes liés/vérifiés hub   (tfh_users + tfh_public_aliases) ;
 *   5. les joueurs ACTIFS récents (7 j) (roster × games).
 *
 * Déclencheurs :
 *   - AUTOMATIQUE : api/games-sync.php lance ce script en fin de tick
 *     (--budget=25) → les joueurs actifs restent chauds en continu ;
 *   - OPTIONNEL (recommandé), passe complète quotidienne — cron cPanel :
 *       37 4 * * * php /home2/mask6607/public_html/thefronthub.com/api/profile-warm.php --budget=1200 >> /home2/mask6607/logs/profile-warm.log 2>&1
 *
 * Usage CLI :
 *   php profile-warm.php                  # tick court (budget 50 s, 300 joueurs max)
 *   php profile-warm.php --budget=1200    # passe longue quotidienne
 *   php profile-warm.php --full           # ignore la fraîcheur du cache (rebuild)
 *   php profile-warm.php --pid=XXXXXXXX   # un seul joueur (debug)
 *
 * Idempotent et budgeté : jamais plus de --budget secondes de travail, jamais
 * deux écritures simultanées du même fichier (tmp + rename atomique).
 */

define('TFH_API', true); // cf. config.php : garde d'accès aux points d'entrée API
require __DIR__ . '/config.php';
require_once __DIR__ . '/profile-schema.php';
require_once __DIR__ . '/profile-payload.php';
/* v5.43 — bases séparées : $pdo = GAMES (tfh_g_*), $sitePdo = SITE (comptes hub). */
require_once __DIR__ . '/games-db.php';
$sitePdo = $pdo;
$pdo = tfh_games_pdo('auto') ?? $sitePdo;

/** Tronque un message (mb si dispo) — local au warm. */
function cut_warm(string $s, int $n): string {
    return function_exists('mb_substr') ? mb_substr($s, 0, $n, 'UTF-8') : substr($s, 0, $n);
}

/* ── Options CLI ─────────────────────────────────────────────────────────── */
$opts = getopt('', ['budget::', 'full', 'pid::', 'max::']) ?: [];
$budgetS  = max(5, min(3600, (int)($opts['budget'] ?? 50)));
$maxBuild = max(1, min(20000, (int)($opts['max'] ?? 300)));
$full     = isset($opts['full']);
$onlyPid  = isset($opts['pid']) ? preg_replace('/[^A-Za-z0-9]/', '', (string)$opts['pid']) : '';
$started  = microtime(true);
$deadline = $started + $budgetS;

function warm_log(string $s): void {
    $line = '[' . gmdate('Y-m-d H:i:s') . 'Z] [profile-warm] ' . $s . "\n";
    fwrite(STDOUT, $line);
    @file_put_contents(__DIR__ . '/games-sync.log', $line, FILE_APPEND);
}

warm_log("début — budget {$budgetS}s, max {$maxBuild} joueurs" . ($full ? ' — FULL' : ''));

/* ── 1) Liste des joueurs à pré-générer (par priorité) ──────────────────── */
$pids = [];
try {
    if ($onlyPid !== '') {
        $pids[] = $onlyPid;
    } else {
        $add = static function (array $rows) use (&$pids): void {
            foreach ($rows as $r) {
                $q = (string)($r['public_id'] ?? '');
                if (preg_match('/^[A-Za-z0-9]{6,16}$/', $q)) {
                    $pids[$q] = true;
                }
            }
        };

        /* 1. Les plus consultés (la route route=profile incrémente le compteur) */
        try {
            $st = $pdo->query('SELECT public_id FROM tfh_g_profile_views ORDER BY views DESC, last_view DESC LIMIT 500');
            $add($st->fetchAll() ?: []);
        } catch (Throwable $e) { /* table pas encore créée — aucune visite comptée */ }

        /* 2. Top hebdo (semaine courante + précédente) */
        try {
            $st = $pdo->query('SELECT DISTINCT public_id FROM tfh_g_weekly WHERE public_id IS NOT NULL AND pts_all > 0
                               ORDER BY pts_all DESC LIMIT 400');
            $add($st->fetchAll() ?: []);
        } catch (Throwable $e) { /* table absente */ }

        /* 3. Ladder officiel (1v1/2v2 — pages joueurs avec public_id) */
        try {
            $st = $pdo->query('SELECT DISTINCT public_id FROM tfh_g_ladder WHERE public_id IS NOT NULL AND public_id <> \'\' LIMIT 300');
            $add($st->fetchAll() ?: []);
        } catch (Throwable $e) { /* table absente */ }

        /* 4. Comptes hub liés/vérifiés (profils revendiqués — bio/cosmétiques)
         *    v5.43 : tables SITE → connexion $sitePdo (base site). */
        try {
            $st = $sitePdo->query('SELECT DISTINCT u.public_id FROM tfh_users u WHERE u.public_id IS NOT NULL AND u.public_id <> \'\'
                               UNION DISTINCT
                               SELECT DISTINCT pa.public_id FROM tfh_public_aliases pa WHERE pa.public_id IS NOT NULL LIMIT 500');
            $add($st->fetchAll() ?: []);
        } catch (Throwable $e) { /* tables site absentes */ }

        /* 5. Joueurs actifs récents (7 jours — les visiteurs du moment) */
        try {
            $st = $pdo->query('SELECT DISTINCT r.public_id
                               FROM tfh_g_roster r JOIN tfh_g_games g ON g.game_id = r.game_id
                               WHERE r.public_id IS NOT NULL AND g.started_at >= (NOW() - INTERVAL 7 DAY)
                               LIMIT 3000');
            $add($st->fetchAll() ?: []);
        } catch (Throwable $e) { /* tables absentes */ }
    }
} catch (Throwable $e) {
    warm_log('⚠️ liste joueurs: ' . cut_warm($e->getMessage(), 140));
}

$pids = array_keys($pids);
warm_log(count($pids) . ' joueur(s) candidat(s)');

/* ── 2) Boucle de pré-génération (budgetée) ─────────────────────────────── */
$built = 0; $skipped = 0; $missing = 0; $failed = 0;
foreach ($pids as $i => $pid) {
    if (microtime(true) >= $deadline || $built >= $maxBuild) {
        warm_log("⏹ stop budget/jauge — " . ($i) . '/' . count($pids) . ' candidats vus');
        break;
    }

    /* Cache déjà frais → rien à faire (sauf --full). */
    if (!$full && tfh_profile_cache_read($pid) !== null) {
        $skipped++;
        continue;
    }

    try {
        /* allowOfficialRefresh=false : le warm ne fait JAMAIS d'appel réseau
         * OpenFront (l'arbre officiel vient de tfh_g_profiles, rempli par le
         * tick games-sync) → pré-génération rapide et sans risque de 429. */
        $payload = tfh_profile_payload($pdo, $pid, 100, false, $sitePdo);
        tfh_profile_cache_write($pid, $payload);
        $built++;
    } catch (TfhProfileNotFound $e) {
        $missing++; // joueur absent de la DB locale (id non archivé) — normal
    } catch (Throwable $e) {
        $failed++;
        if ($failed <= 3) {
            warm_log('⚠️ ' . $pid . ' : ' . cut_warm($e->getMessage(), 140));
        }
    }
}

warm_log("fin — générés: {$built}, déjà frais: {$skipped}, absents DB: {$missing}, échecs: {$failed} — " .
         round(microtime(true) - $started, 1) . 's');
