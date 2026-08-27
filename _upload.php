<?php
/**
 * _upload.php — Endpoint sécurisé pour recevoir les fichiers de données
 * depuis GitHub Actions (workflow sync.yml).
 *
 * Sécurité (v2 — audit 2026) :
 *   - Authentification par secret partagé (header X-Upload-Secret) résolu par couches :
 *       1. Variable d'environnement O2SWITCH_UPLOAD_SECRET (SetEnv .htaccess / panel)
 *       2. Fichier hors webroot : <home>/.tfs_secrets/upload_secret.txt
 *       3. Constante $SECRET_FALLBACK ci-dessous (à remplir sur le serveur uniquement)
 *   - Refus de démarrer (fail-closed) si le secret est vide ou resté au placeholder
 *   - Vérification de la signature HMAC-SHA256 du contenu (header X-Upload-Signature)
 *     dès qu'elle est fournie ; passage en mode obligatoire via REQUIRE_SIGNATURE
 *   - Whitelist stricte des noms de fichiers autorisés + patterns
 *   - Refus de tout chemin contenant "..", confinement realpath() dans le webroot
 *   - Validation du contenu (magic bytes gzip / premier octet JSON)
 *   - Limite de taille d'upload (MAX_UPLOAD_BYTES)
 *   - Anti-bruteforce : compteur d'échecs par IP (rate-limit sur les 403 uniquement)
 *   - Rotation d'archives protégée par flock (anti-course)
 *
 * Usage côté GitHub Actions (scripts/upload-to-o2switch.sh fait tout seul) :
 *   curl -X POST \
 *     -H "X-Upload-Secret: $SECRET" \
 *     -H "X-Upload-Signature: sha256=$(openssl dgst -sha256 -hmac "$SECRET" -binary fichier | xxd -p -c 256)" \
 *     -F "file=@runs.json.gz" \
 *     -F "filename=runs.json.gz" \
 *     -F "mode=snapshot" \
 *     https://thefronthub.com/_upload.php
 *
 * Modes :
 *   - snapshot : écrase le fichier existant (default)
 *   - archive  : sauvegarde avec date dans le nom (runs_2026-08-26_143000.json.gz)
 *                + rotation auto (delete > 30 jours)
 *
 * Installation :
 *   1. Uploade ce fichier dans /home/USER/public_html/thefronthub.com/_upload.php
 *   2. Configure le secret (UNE seule de ces méthodes suffit) :
 *      a) Génère un secret : openssl rand -hex 32
 *      b) Option recommandée : crée /home/USER/.tfs_secrets/upload_secret.txt
 *         contenant le secret (chmod 600) — hors du webroot, jamais dans le repo
 *      c) Ou remplis $SECRET_FALLBACK ci-dessous (copie serveur uniquement)
 *      d) Ou SetEnv O2SWITCH_UPLOAD_SECRET dans .htaccess
 *   3. Mets la même valeur dans le secret GitHub O2SWITCH_UPLOAD_SECRET
 *   4. Une fois upload-to-o2switch.sh v2 déployé, passe REQUIRE_SIGNATURE à true
 *
 * ⚠️ Ce fichier ne doit JAMAIS être committé avec un vrai secret à l'intérieur.
 */

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════

// Secret de secours (copie serveur uniquement — laisse vide dans le repo).
// En shared hosting, préfère le fichier <home>/.tfs_secrets/upload_secret.txt.
$SECRET_FALLBACK = '';

// Mettre à true UNIQUEMENT après avoir déployé upload-to-o2switch.sh v2
// (qui signe chaque upload). Tant que false : signature vérifiée si fournie,
// acceptée sans si absente (compatibilité ascendante pendant la migration).
$REQUIRE_SIGNATURE = false;

// Taille max acceptée par fichier (octets). runs.json.gz ≈ 16-20 Mo.
// .user.ini autorise 100M — on borne un peu en dessous.
$MAX_UPLOAD_BYTES = 96 * 1024 * 1024;

// Dossier racine où stocker les fichiers (document root du site)
$WEB_ROOT = realpath(__DIR__);

// Dossier d'archive (mode "archive")
$ARCHIVE_DIR = $WEB_ROOT . '/_archives';

// Durée de rétention des archives en jours
$ARCHIVE_RETENTION_DAYS = 30;

// Anti-bruteforce : nb max d'échecs d'auth par IP sur la fenêtre glissante
$AUTH_FAIL_LIMIT = 20;          // échecs
$AUTH_FAIL_WINDOW = 600;        // secondes (10 min)

// Liste des fichiers autorisés (whitelist stricte)
$ALLOWED_FILES = [
    // Snapshots (écrasés à chaque sync)
    'lobby_state.json',
    'ranked.json',
    'ranked.json.gz',
    'ranked_history.json.gz',
    'ranked_2v2_history.json.gz',
    'teams.json',
    'teams_runs.json',
    'teams_seen.json',
    'teams_checkpoint.json',
    'teams_public.json',
    'teams_public.json.gz',
    'dashboard_scores.json',
    'dashboard_scores.json.gz',
    'dashboard_ranking.json',
    'dashboard_player_games.json',
    'checkpoint.json',
    'checkpoint_compact.json',
    'seen.json',
    'seen_compact.json',
    'maps_list.json',
    'sync-players.json',

    // Données publiques allégées
    'runs_public.json',
    'runs_public.json.gz',
    'runs_compact_public.json',
    'runs_compact_public.json.gz',

    // Archives (mode archive, noms avec date)
    'runs.json.gz',
    'runs_compact.json.gz',
    'clans.json',
    'clans.json.gz',
    'news.json',
    'news.json.gz',
];

// Patterns de fichiers joueurs (player-data/* et player-stats/*)
$ALLOWED_PATTERNS = [
    '#^player-data/[A-Za-z0-9_-]+\.json$#',
    '#^player-data/_sync-summary\.json$#',
    '#^player-stats/[A-Za-z0-9_-]+\.json$#',
    '#^player-stats/_stats-summary\.json$#',
];

// ═══════════════════════════════════════════════════════════
//  FONCTIONS UTILITAIRES
// ═══════════════════════════════════════════════════════════

/** Réponses JSON uniformes (jamais de chemins internes dans les messages). */
function json_response($code, $payload) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload);
    exit;
}

/** Chemin du compteur d'échecs d'auth pour cette IP (tmp système). */
function auth_fail_file($ip) {
    $safe = preg_replace('/[^A-Fa-f0-9.:]/', '_', $ip);
    return sys_get_temp_dir() . '/tfs_upload_fail_' . hash('sha256', $safe) . '.json';
}

/** Enregistre un échec d'auth et bloque si l'IP dépasse la limite. */
function register_auth_failure($ip, $limit, $window) {
    $file = auth_fail_file($ip);
    $now = time();
    $state = ['fails' => [], 'blocked_until' => 0];
    if (is_file($file)) {
        $decoded = json_decode((string) file_get_contents($file), true);
        if (is_array($decoded) && isset($decoded['fails']) && is_array($decoded['fails'])) {
            $state = $decoded + ['blocked_until' => 0];
        }
    }
    // Purge les échecs hors fenêtre
    $state['fails'] = array_values(array_filter($state['fails'], function ($t) use ($now, $window) {
        return is_int($t) && ($now - $t) < $window;
    }));
    $state['fails'][] = $now;

    if (count($state['fails']) > $limit) {
        $state['blocked_until'] = $now + $window;
        file_put_contents($file, json_encode($state), LOCK_EX);
        error_log("[_upload.php] Rate-limited IP $ip (" . count($state['fails']) . " fails)");
        sleep(1); // ralentit le bruteforce
        json_response(429, ['ok' => false, 'error' => 'Too many failed attempts. Try again later.']);
    }
    file_put_contents($file, json_encode($state), LOCK_EX);
}

/** Réinitialise le compteur d'échecs après une authentification réussie. */
function clear_auth_failures($ip) {
    $file = auth_fail_file($ip);
    if (is_file($file)) {
        @unlink($file);
    }
}

/** Résolution du secret par couches : env → fichier hors webroot → constante. */
function resolve_secret($fallback) {
    // 1. Variable d'environnement (SetEnv .htaccess / panel o2switch)
    $env = getenv('O2SWITCH_UPLOAD_SECRET');
    if ($env === false) {
        $env = $_SERVER['O2SWITCH_UPLOAD_SECRET'] ?? '';
    }
    if (is_string($env) && strlen(trim($env)) >= 16) {
        return trim($env);
    }
    // 2. Fichier hors webroot : <home>/.tfs_secrets/upload_secret.txt
    //    (2 niveaux au-dessus du document root = /home/USER sur o2switch)
    $home = dirname(__DIR__, 2);
    $secretFile = $home . '/.tfs_secrets/upload_secret.txt';
    if (is_file($secretFile) && is_readable($secretFile)) {
        $value = trim((string) file_get_contents($secretFile));
        if (strlen($value) >= 16) {
            return $value;
        }
    }
    // 3. Constante définie dans la copie serveur
    if (is_string($fallback) && strlen(trim($fallback)) >= 16) {
        return trim($fallback);
    }
    return '';
}

/** Valide le contenu du fichier selon son extension (magic bytes). */
function content_matches_extension($tmpPath, $filename) {
    $size = filesize($tmpPath);
    if ($size === 0) {
        return true; // fichiers vides tolérés (sync peut générer un résultat vide)
    }
    $fh = fopen($tmpPath, 'rb');
    if (!$fh) {
        return false;
    }
    $head = (string) fread($fh, 512);
    fclose($fh);

    if (preg_match('/\.gz$/i', $filename)) {
        // gzip magic : 1f 8b
        return (strlen($head) >= 2 && $head[0] === "\x1f" && $head[1] === "\x8b");
    }
    if (preg_match('/\.json$/i', $filename)) {
        // JSON : premier octet non-blanc = { ou [ (après BOM éventuel)
        $trimmed = ltrim($head, " \t\r\n\0\x0B\xEF\xBB\xBF");
        if ($trimmed === '') {
            return true; // fichier < 512 octets tout blanc : toléré (cas limite)
        }
        return $trimmed[0] === '{' || $trimmed[0] === '[';
    }
    return false; // extension inconnue → refus par défaut
}

// ═══════════════════════════════════════════════════════════
//  EXÉCUTION
// ═══════════════════════════════════════════════════════════

header('X-Content-Type-Options: nosniff');

// Only accept POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    die('Method Not Allowed');
}

// ── Résolution du secret + fail-closed sur placeholder ──
$SECRET = resolve_secret($SECRET_FALLBACK);
$placeholders = [
    'change_moi_par_un_secret_de_64_chars_hex',
];
if ($SECRET === '' || in_array(strtolower($SECRET), $placeholders, true)) {
    error_log('[_upload.php] SECRET non configure (placeholder ou vide) — acces refuse');
    json_response(403, [
        'ok' => false,
        'error' => 'Endpoint not configured. Set the upload secret (see SECURITE_CORRECTIONS.md).',
    ]);
}

$ip = $_SERVER['REMOTE_ADDR'] ?? '?';

// ── Vérifier le secret partagé (hash_equals, timing-safe) ──
$providedSecret = (string) ($_SERVER['HTTP_X_UPLOAD_SECRET'] ?? '');
if ($providedSecret === '' || !hash_equals($SECRET, $providedSecret)) {
    register_auth_failure($ip, $AUTH_FAIL_LIMIT, $AUTH_FAIL_WINDOW);
    error_log("[_upload.php] Forbidden: bad secret from IP $ip");
    json_response(403, ['ok' => false, 'error' => 'Forbidden']);
}
clear_auth_failures($ip);

// ── Détection du transport : raw-body (v3, WAF-safe) ou multipart ──
// ⚠️ Depuis le 26/08/2026, le WAF o2switch bloque en 406 (ModSecurity) tout
// POST multipart CONTENANT un fichier — même de 118 octets — ce qui cassait
// tout le pipeline de données (curl error 56 côté GitHub Actions).
// Le body brut (Content-Type: application/octet-stream + filename en query)
// passe le WAF : on l'accepte comme transport principal.
$contentType = strtolower(trim((string) ($_SERVER['CONTENT_TYPE'] ?? '')));
$rawBodyMode = (isset($_GET['filename']) && strpos($contentType, 'application/octet-stream') === 0);

$tmpPath = '';
$uploadSize = 0;
$isUploadedFile = false;

if ($rawBodyMode) {
    $filename = (string) ($_GET['filename'] ?? '');
    $mode = (string) ($_GET['mode'] ?? 'snapshot');
    // Materialiser le corps de la requête dans un fichier temporaire
    $tmpPath = (string) tempnam(sys_get_temp_dir(), 'upraw_');
    if ($tmpPath === '') {
        json_response(500, ['ok' => false, 'error' => 'Cannot create temp file']);
    }
    // Nettoyage garanti du temp file (même en cas d'erreur fatale/die)
    register_shutdown_function(function () use (&$tmpPath) {
        if (is_string($tmpPath) && $tmpPath !== '' && is_file($tmpPath)) {
            @unlink($tmpPath);
        }
    });
    $in = fopen('php://input', 'rb');
    $out = fopen($tmpPath, 'wb');
    if ($in === false || $out === false) {
        json_response(500, ['ok' => false, 'error' => 'Cannot read body']);
    }
    $copied = stream_copy_to_stream($in, $out);
    fclose($in);
    fclose($out);
    if ($copied === false || $copied < 0) {
        json_response(500, ['ok' => false, 'error' => 'Cannot read body']);
    }
    $uploadSize = (int) $copied;
} else {
    $filename = (string) ($_POST['filename'] ?? '');
    $mode = (string) ($_POST['mode'] ?? 'snapshot');
    $tmpPath = (string) ($_FILES['file']['tmp_name'] ?? '');
    $uploadSize = (int) ($_FILES['file']['size'] ?? 0);
    $isUploadedFile = true;
}

// ── Vérifier la signature HMAC-SHA256 du contenu (si fournie) ──
$signatureHeader = trim((string) ($_SERVER['HTTP_X_UPLOAD_SIGNATURE'] ?? ''));

if ($signatureHeader !== '' || $REQUIRE_SIGNATURE) {
    if ($signatureHeader === '' || $tmpPath === '' || !is_file($tmpPath)) {
        json_response(403, ['ok' => false, 'error' => 'Missing signature']);
    }
    $providedSig = strtolower($signatureHeader);
    if (strpos($providedSig, 'sha256=') === 0) {
        $providedSig = substr($providedSig, 7);
    }
    if (!preg_match('/^[a-f0-9]{64}$/', $providedSig)) {
        json_response(403, ['ok' => false, 'error' => 'Malformed signature']);
    }
    $expectedSig = hash_hmac('sha256', (string) file_get_contents($tmpPath), $SECRET);
    if (!hash_equals($expectedSig, $providedSig)) {
        register_auth_failure($ip, $AUTH_FAIL_LIMIT, $AUTH_FAIL_WINDOW);
        error_log("[_upload.php] Forbidden: bad HMAC signature from IP $ip");
        json_response(403, ['ok' => false, 'error' => 'Forbidden']);
    }
}

// ── Validations ──
if ($filename === '') {
    json_response(400, ['ok' => false, 'error' => 'Missing filename']);
}
if ($tmpPath === '' || !is_file($tmpPath) || ($isUploadedFile && !is_uploaded_file($tmpPath))) {
    json_response(400, ['ok' => false, 'error' => 'Missing file']);
}
if (!in_array($mode, ['snapshot', 'archive'], true)) {
    json_response(400, ['ok' => false, 'error' => 'Invalid mode']);
}
if (strlen($filename) > 255) {
    json_response(400, ['ok' => false, 'error' => 'Filename too long']);
}

// ── Whitelist stricte (noms exacts puis patterns) ──
$isAllowed = in_array($filename, $ALLOWED_FILES, true);
if (!$isAllowed) {
    foreach ($ALLOWED_PATTERNS as $pattern) {
        if (preg_match($pattern, $filename)) {
            $isAllowed = true;
            break;
        }
    }
}
if (!$isAllowed) {
    error_log("[_upload.php] Rejected filename: $filename");
    json_response(400, ['ok' => false, 'error' => 'Filename not in whitelist']);
}

// ── Sécurité chemin : pas de "..", pas de chemin absolu, caractères sûrs ──
if (strpos($filename, '..') !== false
    || strpos($filename, '/') === 0
    || strpos($filename, '\\') !== false
    || strpos($filename, "\0") !== false
) {
    json_response(400, ['ok' => false, 'error' => 'Invalid path']);
}

// ── Limite de taille ──
if ($rawBodyMode) {
    $uploadSize = (int) filesize($tmpPath); // taille réelle du body materialisé
}
if ($uploadSize < 0 || $uploadSize > $MAX_UPLOAD_BYTES) {
    json_response(413, ['ok' => false, 'error' => 'File too large']);
}

// ── Validation du contenu (magic bytes) ──
if (!content_matches_extension($tmpPath, $filename)) {
    error_log("[_upload.php] Content/extension mismatch: $filename");
    json_response(400, ['ok' => false, 'error' => 'Content does not match file type']);
}

// ── Construire le chemin cible + containment realpath ──
$targetPath = $WEB_ROOT . '/' . $filename;
$targetDir = dirname($targetPath);

if (!is_dir($targetDir)) {
    if (!mkdir($targetDir, 0755, true)) {
        error_log("[_upload.php] Cannot mkdir: $targetDir");
        json_response(500, ['ok' => false, 'error' => 'Cannot create directory']);
    }
}
$realDir = realpath($targetDir);
if ($realDir === false || strpos($realDir, $WEB_ROOT . DIRECTORY_SEPARATOR) !== 0) {
    error_log("[_upload.php] Path escapes web root: $filename");
    json_response(400, ['ok' => false, 'error' => 'Invalid path']);
}

// ── Mode snapshot : écrase ──
if ($mode === 'snapshot') {
    // Écriture atomique : tmp + rename pour éviter qu'un visiteur lise un
    // fichier à moitié écrit pendant la sync.
    $atomicTmp = $targetPath . '.tmp' . getmypid();
    $moved = $isUploadedFile
        ? move_uploaded_file($tmpPath, $atomicTmp)
        : rename($tmpPath, $atomicTmp);
    if (!$moved) {
        error_log("[_upload.php] move failed: $targetPath");
        json_response(500, ['ok' => false, 'error' => 'Upload failed']);
    }
    chmod($atomicTmp, 0644);
    if (!rename($atomicTmp, $targetPath)) {
        @unlink($atomicTmp);
        error_log("[_upload.php] rename failed: $targetPath");
        json_response(500, ['ok' => false, 'error' => 'Upload failed']);
    }
    json_response(200, [
        'ok' => true,
        'mode' => 'snapshot',
        'filename' => $filename,
        'bytes' => filesize($targetPath),
        'path' => $filename,
    ]);
}

// ── Mode archive : sauvegarde avec date + rotation ──
if (!is_dir($ARCHIVE_DIR)) {
    if (!mkdir($ARCHIVE_DIR, 0755, true)) {
        error_log("[_upload.php] Cannot mkdir archive: $ARCHIVE_DIR");
        json_response(500, ['ok' => false, 'error' => 'Cannot create archive directory']);
    }
}

// Construire le nom archivé : runs_2026-08-26_143000.json.gz
$baseInfo = pathinfo($filename);
$basename = $baseInfo['filename'];
$extension = isset($baseInfo['extension']) ? '.' . $baseInfo['extension'] : '';
$dateStr = date('Y-m-d_His');
$archiveName = $basename . '_' . $dateStr . $extension;

// Préfixer par le sous-dossier si présent (ex: player-data/)
if (strpos($filename, '/') !== false) {
    $subDir = explode('/', $filename)[0];
    $archiveSubDir = $ARCHIVE_DIR . '/' . $subDir;
    if (!is_dir($archiveSubDir) && !mkdir($archiveSubDir, 0755, true)) {
        json_response(500, ['ok' => false, 'error' => 'Cannot create archive directory']);
    }
    $archivePath = $archiveSubDir . '/' . $archiveName;
} else {
    $archivePath = $ARCHIVE_DIR . '/' . $archiveName;
}

// Containment de l'archive également
$realArchiveDir = realpath(dirname($archivePath));
if ($realArchiveDir === false || strpos($realArchiveDir, $WEB_ROOT . DIRECTORY_SEPARATOR) !== 0) {
    json_response(400, ['ok' => false, 'error' => 'Invalid path']);
}

if (!($isUploadedFile ? move_uploaded_file($tmpPath, $archivePath) : rename($tmpPath, $archivePath))) {
    error_log("[_upload.php] move failed (archive): $archivePath");
    json_response(500, ['ok' => false, 'error' => 'Upload failed']);
}
chmod($archivePath, 0644);

// ── Rotation protégée par verrou (anti-course entre syncs parallèles) ──
$deleted = [];
$cutoff = time() - ($ARCHIVE_RETENTION_DAYS * 86400);

$lockFile = $ARCHIVE_DIR . '/.rotation.lock';
$lockFh = fopen($lockFile, 'c');
if ($lockFh) {
    if (flock($lockFh, LOCK_EX)) {
        $basenameEscaped = preg_quote($basename, '/');
        $pattern = '#^' . $basenameEscaped . '_\d{4}-\d{2}-\d{2}_\d{6}' . preg_quote($extension, '/') . '$#';

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($ARCHIVE_DIR, RecursiveDirectoryIterator::SKIP_DOTS)
        );
        foreach ($iterator as $file) {
            if (!$file->isFile()) {
                continue;
            }
            if ($file->getFilename() === '.rotation.lock') {
                continue;
            }
            if (!preg_match($pattern, $file->getFilename())) {
                continue;
            }
            if ($file->getMTime() < $cutoff) {
                if (unlink($file->getPathname())) {
                    $deleted[] = $file->getFilename();
                }
            }
        }
        flock($lockFh, LOCK_UN);
    }
    fclose($lockFh);
}

json_response(200, [
    'ok' => true,
    'mode' => 'archive',
    'filename' => $filename,
    'archived_as' => basename($archivePath),
    'bytes' => filesize($archivePath),
    'rotation_deleted' => count($deleted),
    'retention_days' => $ARCHIVE_RETENTION_DAYS,
]);
