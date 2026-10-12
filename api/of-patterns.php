<?php
declare(strict_types=1);

/**
 * api/of-patterns.php — Bitmaps des MOTIFS (patterns) OpenFront (v5.36).
 *
 * Extrait VERBATIM de api/games-api.php (v5.15) pour être partagé avec
 * api/profile-payload.php (pré-génération des profils par profile-warm.php).
 * Aucun changement de comportement : même fonction, même signature.
 *
 * Le catalogue officiel (api.openfront.io/cosmetics.json) porte, pour chaque
 * motif, un champ `pattern` = bitmap base64url (cf. PatternDecoder.ts côté
 * OpenFrontIO). Le site stocke le catalogue en BDD SANS ce base64 (volume) ;
 * ce helper le résout via TROIS sources en cascade :
 *   1) cache fichier 24 h HORS webroot (~/.tfs_cache — même philosophie que
 *      les secrets) ;
 *   2) fetch direct du catalogue officiel avec en-têtes navigateur ;
 *   3) snapshot embarqué data/of-patterns.json (relevé du 2026-09-28) —
 *      indispensable car Cloudflare 403-ise /cosmetics.json depuis certaines
 *      IP datacenter (o2switch inclus, cf. catalog_phase dans games-sync.php).
 * Échec total = tableau vide : la vitrine retombe proprement sur l'icône de
 * catégorie (comportement d'avant la v5.15), la route ne doit JAMAIS échouer
 * pour un motif. Cache négatif 1 h (patterns:[]) : jamais d'appel réseau par
 * requête quand l'API est bloquée, tout en se ré-healisant tout seul.
 */

function tfh_patterns_map(): array
{
    static $map = null;
    if ($map !== null) return $map;
    $map = [];

    $cacheDir = (getenv('HOME') ?: sys_get_temp_dir()) . '/.tfs_cache';
    if (!is_dir($cacheDir)) { @mkdir($cacheDir, 0700, true); }
    $cacheFile = $cacheDir . '/tfh-of-patterns.json';

    /* 1) Cache frais ? (24 h plein, 1 h si cache négatif vide) */
    if (is_readable($cacheFile)) {
        $dec = json_decode((string) @file_get_contents($cacheFile), true);
        if (is_array($dec) && isset($dec['fetched_at'], $dec['patterns']) && is_array($dec['patterns'])) {
            $ttl = $dec['patterns'] !== [] ? 24 * 3600 : 3600;
            if (time() - (int) $dec['fetched_at'] < $ttl) {
                $map = $dec['patterns'];
                return $map;
            }
        }
    }

    /* 2) Catalogue officiel (en-têtes navigateur — cf. of_fetch_browser). */
    $fetched = time();
    $ch = curl_init('https://api.openfront.io/cosmetics.json');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_ENCODING       => '',
        CURLOPT_HTTPHEADER     => [
            'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept: application/json, text/plain, */*',
            'Accept-Language: en-US,en;q=0.9',
            'Referer: https://openfront.io/',
        ],
    ]);
    $body   = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    if ($status === 200 && is_string($body) && $body !== '') {
        $dec = json_decode($body, true);
        if (is_array($dec) && isset($dec['patterns']) && is_array($dec['patterns'])) {
            foreach ($dec['patterns'] as $name => $item) {
                if (is_string($name) && is_array($item) && isset($item['pattern']) && is_string($item['pattern'])) {
                    // garde-fou volume : le schéma OpenFront limite patternData à 1403 chars
                    if (strlen($item['pattern']) <= 1500) {
                        $map[$name] = $item['pattern'];
                    }
                }
            }
        }
    }

    /* 3) Snapshot embarqué (filet de sécurité déterministe). */
    if ($map === []) {
        $snap = @file_get_contents(__DIR__ . '/../data/of-patterns.json');
        if (is_string($snap) && $snap !== '') {
            $dec = json_decode($snap, true);
            if (is_array($dec) && isset($dec['patterns']) && is_array($dec['patterns'])) {
                foreach ($dec['patterns'] as $name => $b64) {
                    if (is_string($name) && is_string($b64) && $b64 !== '') {
                        $map[$name] = $b64;
                    }
                }
            }
        }
    }

    /* Écriture du cache : 24 h si API OK, 1 h sinon (auto-ré-heal). */
    @file_put_contents(
        $cacheFile,
        json_encode(['fetched_at' => $fetched, 'patterns' => $map], JSON_UNESCAPED_SLASHES),
        LOCK_EX
    );
    return $map;
}
