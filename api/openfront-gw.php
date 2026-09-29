<?php
declare(strict_types=1);

/**
 * api/openfront-gw.php — Passerelle serveur (same-origin) vers l'API
 * publique OpenFront — v5.15.1.
 *
 * POURQUOI (incident 2026-09-29) :
 *   Le profil construit son dossier depuis le NAVIGATEUR via une cascade de
 *   proxies (worker Cloudflare → codetabs → allorigins → thingproxy). Deux
 *   défaillances combinées cassaient TOUS les profils non revendiqués :
 *     1. le worker Cloudflare restreint ses origines (allowlist) —
 *        dev.thefronthub.com n'y figure pas → 403 sans en-têtes CORS →
 *        « Failed to fetch » systématique depuis la pré-production ;
 *     2. lors des fenêtres de maintenance OpenFront, l'API répond 503
 *        « Offline » et les proxies publics la relaient telle quelle.
 *   Résultat : « Chargement du dossier… » sans fin, 0 parties, pas de
 *   graphique hebdo (cf. rapport utilisateur + console HTTP 503: Offline).
 *   OR la stack PHP du site interroge DÉJÀ api.openfront.io avec succès
 *   côté serveur (profile.php, skins.php, games-sync.php cron) — cette
 *   passerelle expose ce chemin fiable au navigateur, same-origin, SANS
 *   dépendre de Cloudflare ni d'un proxy tiers.
 *
 * SÉCURITÉ (pas un open-proxy) :
 *   - GET uniquement ;
 *   - chemin whitelisté : UNIQUEMENT /public/player/… (+ query cursor) ;
 *   - rate-limit 60 req/min/IP (table tfh_rate_limits) ;
 *   - pas d'en-têtes CORS ouverts : same-origin seulement ;
 *   - secrets jamais exposés (x-skailex-access lu côté serveur, cf. infra).
 *
 * CACHE (~/.tfs_cache, HORS webroot — même philosophie que les secrets) :
 *   - hit frais (< 60 s)        → servi immédiatement, X-OF-GW: fresh ;
 *   - upstream OK               → stocké + relayé,               X-OF-GW: miss ;
 *   - upstream KO (503/offline) → cache périmé servi jusqu'à 15 min
 *     (stale-while-error : absorbe les fenêtres « Offline » d'OpenFront),
 *     X-OF-GW: stale. Passé 15 min → erreur upstream relayée telle quelle
 *     (le client tente alors ses proxies de secours).
 *   - 404 (joueur inconnu) mis en cache 10 min : réponse API officielle,
 *     le client la distingue (isNotFound) et ne cascadera pas inutilement.
 *
 * Réponse : le corps JSON OpenFront est relayé TEL QUEL avec son statut
 * HTTP (le client openfront-client.js analyse déjà ces réponses).
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    header('Allow: GET');
    fail(405, 'method_not_allowed', 'GET uniquement.');
}

/* Chaque IP : 60 requêtes/min (une page profil ≈ 2-12 appels, tous cachés) */
rate_limit($pdo, 'ofgw:' . client_ip(), 60, 60);

/* ── 1) Chemin cible : whitelist stricte ─────────────────────────────── */
/* NB : $_GET['path'] est DÉJÀ décodé par PHP (une seule fois). Ne PAS
 * re-décoder : un curseur contenant « %2B » serait corrompu, et un chemin
 * double-encodé (%252F) resterait littéral → rejeté par la regex. */
$path = (string) ($_GET['path'] ?? '');
if ($path === '' || strlen($path) > 500) {
    fail(400, 'bad_path', 'Chemin manquant ou trop long.');
}
/* Caractères autorisés : l'API ne sert ici que /public/player/{publicId}
 * (8-16 alphanum.) et /public/player/{publicId}/games?cursor=…
 * La query (cursor) accepte tout caractère imprimable non-fragment — le
 * client l'encodera déjà via encodeURIComponent, cURL transmet tel quel. */
if (!str_starts_with($path, '/public/player/')) {
    fail(400, 'path_not_allowed', 'Chemin non autorisé.');
}
if (!preg_match('#^/public/player/[A-Za-z0-9_-]{1,64}(/games)?(\?[^\#\s\x00-\x1F]{0,300})?$#', $path)) {
    fail(400, 'bad_path_format', 'Format de chemin invalide.');
}
if (str_contains($path, '..')) {
    fail(400, 'bad_path_format', 'Format de chemin invalide.');
}

/* ── 2) Cache fichier (~/.tfs_cache — hors webroot) ──────────────────── */
const OFGW_FRESH_TTL  = 60;       // s — réponse fraîche servie sans réseau
const OFGW_STALE_TTL  = 15 * 60;  // s — périmé servi si l'upstream est KO
const OFGW_404_TTL    = 10 * 60;  // s — « joueur inconnu » (réponse officielle)
const OFGW_UPSTREAM_TIMEOUT = 9;  // s — total cURL (profil = page unique)

$cacheDir = (getenv('HOME') ?: sys_get_temp_dir()) . '/.tfs_cache';
if (!is_dir($cacheDir)) { @mkdir($cacheDir, 0700, true); }
$cacheFile = $cacheDir . '/ofgw-' . hash('sha1', $path) . '.json';

$cacheRead = static function (string $file): ?array {
    if (!is_readable($file)) return null;
    $j = json_decode((string) @file_get_contents($file), true);
    return (is_array($j) && isset($j['t'], $j['code'], $j['body'])) ? $j : null;
};

$emit = static function (int $code, string $body, string $state) use ($cacheFile): never {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-OF-Gateway: ' . $state);
    http_response_code($code);
    echo $body;
    exit;
};

/* 2a) Frais → sans réseau */
$entry = $cacheRead($cacheFile);
if ($entry !== null) {
    $age = time() - (int) $entry['t'];
    $ttl = ((int) $entry['code'] === 404) ? OFGW_404_TTL : OFGW_FRESH_TTL;
    if ($age < $ttl) {
        $emit((int) $entry['code'], (string) $entry['body'], 'fresh');
    }
}

/* ── 3) Upstream OpenFront (même signature que profile.php/skins.php) ──
 * NB : $secrets peut être une variable locale du contexte d'inclusion
 * (gate.php requiert api/*.php depuis une fonction sur la pré-production)
 * OU une vraie globale (Apache/prod) — on teste les deux sans écraser.   */
$headers = ['Accept: application/json'];
$ofSecrets = (isset($secrets) && is_array($secrets)) ? $secrets : ($GLOBALS['secrets'] ?? null);
$ofKey = is_array($ofSecrets) ? (string) ($ofSecrets['openfront_access'] ?? '') : '';
if ($ofKey !== '') {
    $headers[] = 'x-skailex-access: ' . $ofKey;
}

$ch = curl_init('https://api.openfront.io' . $path);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 4,
    CURLOPT_TIMEOUT        => OFGW_UPSTREAM_TIMEOUT,
    CURLOPT_USERAGENT      => 'TheFrontHub/1.0 (+https://thefronthub.com)',
    CURLOPT_HTTPHEADER     => $headers,
    CURLOPT_ENCODING       => '',
]);
$upBody = curl_exec($ch);
$upCode = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$upErr  = curl_error($ch);
curl_close($ch);

$upOk  = is_string($upBody) && $upBody !== '' && $upErr === '' && $upCode >= 200 && $upCode < 500 && $upCode !== 429;
/* NB : un 4xx JSON autre que 404/429 (ex. 400) est aussi une réponse API
 * légitime à relayer ; 429/5xx/timeout/réseau = « upstream KO ». */

if ($upOk) {
    $body = (string) $upBody;
    $code = $upCode;
    @file_put_contents(
        $cacheFile,
        (string) json_encode(['t' => time(), 'code' => $code, 'body' => $body]),
        LOCK_EX
    );
    $emit($code, $body, 'miss');
}

/* ── 4) Upstream KO → stale-while-error ──────────────────────────────── */
if ($entry !== null && (time() - (int) $entry['t']) < OFGW_STALE_TTL) {
    $emit((int) $entry['code'], (string) $entry['body'], 'stale');
}

fail(502, 'of_gateway_unavailable', 'API OpenFront injoignable depuis le serveur.');
