<?php
declare(strict_types=1);

/**
 * gate.php — Porte d'accès à code pour dev.thefronthub.com.
 *
 * Fonctionnement :
 *   - Actif UNIQUEMENT sur dev.thefronthub.com : sur tout autre host
 *     (thefronthub.com compris) ce fichier répond 404 et ne sert rien.
 *   - Sans session valide, TOUT est redirigé ici par le .htaccess racine
 *     (condition host dev) : pages statiques, /api/, données.
 *   - Avec session valide : sert les fichiers statiques (with cache/304) et
 *     EXÉCUTE les scripts api/*.php par require (tous leurs require sont en
 *     __DIR__ : l'inclusion est transparente, zéro fichier API modifié).
 *   - Connexion : POST du code → password_verify contre le hash bcrypt de
 *     secure/auth-config.php (le code en clair n'existe NULLE PART : ni repo,
 *     ni HTML, ni JS) → cookie signé HMAC 30 jours.
 *   - Anti force brute : 5 échecs / 15 min par IP → verrou 5→10→20→40→60 min.
 *
 * Jamais servis via le gate : secure/ (config), dotfiles, .php hors /api/,
 * gate.php lui-même, fichiers inexistants (404).
 */

require_once __DIR__ . '/secure/auth-lib.php';

/* ── 0) Hors host dev : inerte (la prod ne doit jamais voir ce fichier) ── */
if (!tfh_is_dev_host()) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    exit('Not Found');
}

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$uri    = tfh_request_path();

header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');

/* ── 1) Session valide → on sert le site ─────────────────────────────── */
if (tfh_has_access()) {
    if ($uri === '/gate.php' || $uri === '/login') {
        header('Location: /', true, 303);
        exit;
    }
    if ($method !== 'GET' && $method !== 'HEAD') {
        http_response_code(405);
        header('Allow: GET, HEAD');
        header('Content-Type: text/plain; charset=utf-8');
        exit('Method Not Allowed');
    }
    tfh_serve_path($uri, $method === 'HEAD');
    exit;
}

/* ── 2) API appelée sans session → 401 JSON (jamais le HTML de login) ── */
if (str_starts_with($uri, '/api/')) {
    http_response_code(401);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');
    echo (string) json_encode([
        'ok'      => false,
        'error'   => 'dev_gate',
        'message' => 'Pre-production protégée — accès refusé',
    ]);
    exit;
}

/* ── 3) Tentative de connexion (POST du code) ────────────────────────── */
if ($method === 'POST' && ($uri === '/gate.php' || $uri === '/login')) {
    $lockedFor = tfh_rl_locked_for();
    if ($lockedFor > 0) {
        tfh_render_login($uri, null, $lockedFor);
        exit;
    }

    $code = isset($_POST['code']) && is_string($_POST['code']) ? trim($_POST['code']) : '';
    $cfg  = tfh_gate_config();

    if ($code !== '' && password_verify($code, (string) $cfg['hash'])) {
        tfh_rl_clear();
        tfh_send_auth_cookie();
        $next = isset($_POST['next']) && is_string($_POST['next']) ? $_POST['next'] : '/';
        header('Location: ' . tfh_safe_next($next), true, 303);
        exit;
    }

    usleep(random_int(250000, 700000)); // freine les essais automatisés
    tfh_rl_register_fail();
    $lockedFor = tfh_rl_locked_for();
    tfh_render_login(
        $uri,
        $lockedFor > 0 ? null : 'Code incorrect — réessaie.',
        $lockedFor
    );
    exit;
}

/* ── 4) Toute autre requête sans session → page de connexion ─────────── */
tfh_render_login($uri, null, tfh_rl_locked_for());

/* ════════════════════════════════════════════════════════════════════ */
/*  Helpers locaux                                                       */
/* ════════════════════════════════════════════════════════════════════ */

/** Chemin de la requête décodé et assaini (sans query string). */
function tfh_request_path(): string
{
    $req  = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    $path = parse_url($req, PHP_URL_PATH);
    if (!is_string($path) || $path === '') {
        $path = '/';
    }
    $path = rawurldecode($path);
    if (str_contains($path, "\0") || str_contains($path, '\\')) {
        return '/__invalide__';
    }
    return $path;
}

/** Cible post-login : uniquement des chemins locaux sûrs. */
function tfh_safe_next(string $next): string
{
    if ($next === '' || $next[0] !== '/' || str_starts_with($next, '//')) {
        return '/';
    }
    if (str_contains($next, '\\') || str_contains($next, '"') || str_contains($next, "\0")) {
        return '/';
    }
    return $next;
}

/**
 * Normalise un chemin en chemin relatif sûr (segments sans dotfile ni
 * traversal). Retourne null si invalide.
 */
function tfh_normalize_rel(string $path): ?string
{
    $raw = trim($path, '/');
    if ($raw === '') {
        return 'index.html';
    }
    $parts = explode('/', $raw);
    foreach ($parts as $seg) {
        if ($seg === '' || $seg === '.' || $seg === '..' || str_starts_with($seg, '.')) {
            return null;
        }
    }
    return implode('/', $parts);
}

/** Sert un fichier statique ou exécute un script /api/*.php. */
function tfh_serve_path(string $path, bool $headOnly): void
{
    $rel = tfh_normalize_rel($path);
    if ($rel === null) {
        tfh_render_404();
        return;
    }
    $ext = strtolower(pathinfo($rel, PATHINFO_EXTENSION));

    /* — /api/*.php : exécution après authentification — */
    if (str_starts_with($rel, 'api/')) {
        $basename = basename($rel);
        $file     = __DIR__ . '/' . $rel;
        if (
            $ext !== 'php'
            || $basename === 'config.php'
            || $basename === 'helpers.php'
            || str_starts_with($basename, '_')
            || !is_file($file)
        ) {
            tfh_render_404();
            return;
        }
        // Les scripts de l'API envoient eux-mêmes leurs en-têtes JSON.
        require $file;
        return;
    }

    /* — Refus explicites — */
    if (
        $ext === 'php'
        || $rel === 'gate.php'
        || str_starts_with($rel, 'secure/')
    ) {
        tfh_render_404();
        return;
    }

    $file = __DIR__ . '/' . $rel;
    if (!is_file($file)) {
        tfh_render_404();
        return;
    }

    $mtime  = (int) filemtime($file);
    $lastMod = gmdate('D, d M Y H:i:s', $mtime) . ' GMT';

    /* — Politique de cache (miroir du .htaccess prod) — */
    $isHtml   = ($ext === 'html' || $ext === 'htm');
    $isSw     = ($rel === 'sw.js');
    $isData   = in_array($ext, ['json', 'gz', 'webmanifest', 'txt', 'xml'], true);
    $isAsset  = in_array($ext, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf'], true);
    $cache    = $isHtml || $isSw
        ? 'no-cache, must-revalidate'
        : ($isData
            ? 'public, max-age=300, must-revalidate'
            : ($isAsset
                ? 'public, max-age=31536000, immutable'
                : 'public, max-age=3600, must-revalidate'));

    /* — 304 si le client a déjà cette version — */
    $ims = (string) ($_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '');
    if ($ims !== '' && ($ts = strtotime($ims)) !== false && $ts >= $mtime) {
        header('Cache-Control: ' . $cache);
        header('Last-Modified: ' . $lastMod);
        http_response_code(304);
        return;
    }

    $types = [
        'html' => 'text/html; charset=utf-8',
        'htm'  => 'text/html; charset=utf-8',
        'css'  => 'text/css; charset=utf-8',
        'js'   => 'text/javascript; charset=utf-8',
        'mjs'  => 'text/javascript; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'map'  => 'application/json; charset=utf-8',
        'webmanifest' => 'application/manifest+json; charset=utf-8',
        'xml'  => 'application/xml; charset=utf-8',
        'txt'  => 'text/plain; charset=utf-8',
        'gz'   => 'application/gzip',
        'png'  => 'image/png',
        'jpg'  => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'gif'  => 'image/gif',
        'webp' => 'image/webp',
        'avif' => 'image/avif',
        'svg'  => 'image/svg+xml',
        'ico'  => 'image/x-icon',
        'woff' => 'font/woff',
        'woff2' => 'font/woff2',
        'ttf'  => 'font/ttf',
        'otf'  => 'font/otf',
        'mp4'  => 'video/mp4',
    ];
    header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
    header('Cache-Control: ' . $cache);
    header('Last-Modified: ' . $lastMod);
    header('Accept-Ranges: none');
    header('Content-Length: ' . (string) filesize($file));

    if ($headOnly) {
        return;
    }
    readfile($file);
}

/* ════════════════════════════════════════════════════════════════════ */
/*  Pages HTML autonomes (zéro ressource externe : servibles sans accès) */
/* ════════════════════════════════════════════════════════════════════ */

function tfh_render_404(): void
{
    http_response_code(404);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');
    echo '<!doctype html><html lang="fr"><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<meta name="robots" content="noindex">'
        . '<title>404 — TheFrontHub</title>'
        . '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
        . 'background:#0b0e14;color:#8b93a3;font-family:system-ui,-apple-system,sans-serif">'
        . '<div style="text-align:center"><div style="font-size:44px;font-weight:800;color:#ff6b00">404</div>'
        . '<div>Introuvable</div></div></body></html>';
}

/**
 * Page de connexion. $error : message d'échec. $lockedFor : secondes restantes.
 * Aucune information sur le code n'y figure (ni longueur, ni indice).
 */
function tfh_render_login(string $next, ?string $error = null, int $lockedFor = 0): void
{
    http_response_code($lockedFor > 0 ? 429 : 200);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');

    $nextHtml = htmlspecialchars(tfh_safe_next($next), ENT_QUOTES, 'UTF-8');
    $errorHtml = $error !== null
        ? '<div class="msg-err" role="alert">' . htmlspecialchars($error, ENT_QUOTES, 'UTF-8') . '</div>'
        : '';
    $lockBlock = '';
    if ($lockedFor > 0) {
        $lockBlock = '<div class="msg-lock" role="alert">Trop d\'essais. Nouvelle tentative dans '
            . '<span id="lock-left">' . max(1, (int) ceil($lockedFor / 60)) . '</span>&nbsp;min.'
            . ' La page se rafraîchira automatiquement.</div>'
            . '<script>window.setTimeout(function(){location.reload()},'
            . (max(1, $lockedFor) * 1000) . ');</script>';
    }

    echo '<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0b0e14">
<title>TheFrontHub — Espace privé</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0b0e14;color:#e8ebf1;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    background-image:radial-gradient(700px 420px at 50% -10%,rgba(255,107,0,.14),transparent 70%);
    padding:24px;
  }
  .card{
    width:100%;max-width:380px;background:#12161f;border:1px solid #232a38;
    border-radius:18px;padding:34px 30px 28px;
    box-shadow:0 18px 50px rgba(0,0,0,.55);
  }
  .brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:6px}
  .brand .dot{width:11px;height:11px;border-radius:50%;background:#ff6b00;box-shadow:0 0 14px rgba(255,107,0,.8)}
  .brand b{font-size:20px;letter-spacing:.2px}
  .sub{text-align:center;color:#8b93a3;font-size:13.5px;margin:0 0 22px;line-height:1.5}
  .lockico{width:46px;height:46px;border-radius:13px;background:rgba(255,107,0,.12);
    display:flex;align-items:center;justify-content:center;margin:0 auto 14px}
  label{display:block;font-size:12.5px;color:#8b93a3;margin-bottom:7px}
  input[type=password]{
    width:100%;padding:13px 14px;font-size:17px;letter-spacing:6px;text-align:center;
    background:#0b0e14;border:1.5px solid #2a3244;border-radius:11px;color:#e8ebf1;
    outline:none;transition:border-color .15s;
  }
  input[type=password]:focus{border-color:#ff6b00;box-shadow:0 0 0 3px rgba(255,107,0,.15)}
  button{
    width:100%;margin-top:16px;padding:13px;border:none;border-radius:11px;cursor:pointer;
    background:#ff6b00;color:#fff;font-size:15.5px;font-weight:700;letter-spacing:.3px;
    transition:filter .15s,transform .05s;
  }
  button:hover{filter:brightness(1.1)}
  button:active{transform:translateY(1px)}
  .msg-err{
    margin-top:14px;padding:10px 12px;border-radius:9px;font-size:13.5px;text-align:center;
    background:rgba(229,72,77,.12);border:1px solid rgba(229,72,77,.35);color:#ff8a8f;
  }
  .msg-lock{
    margin-top:14px;padding:10px 12px;border-radius:9px;font-size:13.5px;text-align:center;
    background:rgba(255,167,0,.1);border:1px solid rgba(255,167,0,.35);color:#ffb84d;
  }
  .foot{margin-top:20px;text-align:center;color:#5b6272;font-size:11.5px}
</style>
</head>
<body>
<main class="card">
  <div class="lockico">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ff6b00" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
    </svg>
  </div>
  <div class="brand"><span class="dot"></span><b>TheFrontHub</b></div>
  <p class="sub">Pré-production réservée.<br>Entre le code d\'accès pour continuer.</p>
  <form method="post" action="/gate.php" autocomplete="off">
    <input type="hidden" name="next" value="' . $nextHtml . '">
    <label for="code">Code d\'accès</label>
    <input id="code" name="code" type="password" inputmode="numeric" autocomplete="off"
           spellcheck="false" required autofocus>
    <button type="submit">Entrer</button>
  </form>
  ' . $errorHtml . $lockBlock . '
  <div class="foot">dev.thefronthub.com — accès privé</div>
</main>
<script>
/* Hors accès : aucun service worker ni cache ne doit pouvoir servir le site. */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (rs) {
    rs.forEach(function (r) { r.unregister(); });
  }).catch(function () {});
}
if (window.caches && caches.keys) {
  caches.keys().then(function (ks) {
    ks.forEach(function (k) { caches.delete(k); });
  }).catch(function () {});
}
</script>
</body>
</html>';
}
