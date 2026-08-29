<?php
declare(strict_types=1);

/**
 * GET /api/openfront-proxy.php?path=/public/...
 *
 * Proxy de secours vers l'API OpenFront (api.openfront.io), en SAME-ORIGIN.
 *
 * Rôle (réduction du SPOF Cloudflare Worker) :
 *   Le navigateur appelle normalement le Worker Cloudflare
 *   (openfront-proxy.diofortnite3.workers.dev) car api.openfront.io
 *   n'autorise CORS que depuis openfront.io. Si le Worker tombe (ou est
 *   bloqué), openfront-client.js retombe sur CE proxy, hébergé sur
 *   o2switch en same-origin : aucune dépendance externe.
 *
 * Sécurité :
 *   - GET uniquement, whitelist stricte des préfixes de chemins publics
 *     (public/*, leaderboard/*, game/<8>, news.json, streams.json, jwks).
 *     Aucun endpoint authentifié (/auth/*, /users/*, /matchmaking/*...)
 *     n'est accessible via ce proxy.
 *   - Rate-limit SQL partagé avec le reste de l'API (30 req/min/IP).
 *   - Pas d'en-tête CORS : seul thefronthub.com peut lire la réponse.
 *   - Header x-skailex-access (exemption rate-limit OpenFront) injecté
 *     CÔTÉ SERVEUR depuis ~/.tfs_secrets/tfh-secrets.json (clé
 *     "openfront_access", optionnelle). Jamais exposé au navigateur.
 *
 * Sans la clé "openfront_access", le proxy fonctionne quand même
 * (simplement soumis au rate-limit public d'OpenFront).
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

/* ── Méthode : GET uniquement ─────────────────────────────────────── */

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    header('Allow: GET');
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'method_not_allowed']);
    exit;
}

/* ── Rate limit (protège o2switch et OpenFront) ───────────────────── */

rate_limit($pdo, 'ofproxy:' . client_ip(), 30, 60);

/* ── Paramètre path + whitelist stricte ───────────────────────────── */

$path = (string) ($_GET['path'] ?? '');
$path = '/' . ltrim($path, '/');

$allowed = '/^(\/public\/|\/leaderboard\/|\/game\/[A-Za-z0-9]{8}$|\/news\.json$|\/streams\.json$|\/\.well-known\/jwks\.json$)/';
// Autoriser aussi les query strings déjà parsés (start, end, limit, page…)
$clean = strtok($path, '?') ?: $path;

if (!preg_match($allowed, $clean)) {
    http_response_code(403);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'path_not_allowed']);
    exit;
}

/* ── Requête cible ─────────────────────────────────────────────────── */

$target = 'https://api.openfront.io' . $path;

$ch = curl_init($target);
if ($ch === false) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'proxy_init_failed']);
    exit;
}

$headers = [
    'Accept: application/json',
    'User-Agent: TheFrontHub-Proxy/1.0',
];

// Header d'exemption de rate-limit OpenFront (côté serveur uniquement).
$ofAccess = trim((string) ($secrets['openfront_access'] ?? ''));
if ($ofAccess !== '') {
    $headers[] = 'x-skailex-access: ' . $ofAccess;
}

curl_setopt_array($ch, [
    CURLOPT_HTTPHEADER     => $headers,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER         => false,
    CURLOPT_FOLLOWLOCATION => false,   // pas de redirection : on renvoie le statut tel quel
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_TIMEOUT        => 20,
    CURLOPT_SSL_VERIFYPEER => true,
]);

$body   = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$ctype  = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
$err    = curl_error($ch);
curl_close($ch);

if ($body === false) {
    http_response_code(502);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'upstream_unreachable', 'detail' => $err]);
    exit;
}

/* ── Réponse miroir (le client distingue 404 JSON d'une route absente) ── */

http_response_code($status !== 0 ? $status : 502);
header('Content-Type: ' . (str_contains($ctype, 'json') || $ctype === '' ? 'application/json; charset=utf-8' : $ctype));
header('Cache-Control: no-store');
header('X-OpenFront-Proxy: o2switch-fallback');
echo $body;
