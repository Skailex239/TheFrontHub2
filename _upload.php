<?php
/**
 * _upload.php — Endpoint sécurisé pour recevoir les fichiers de données
 * depuis GitHub Actions (workflow sync.yml).
 *
 * Sécurité :
 *   - Authentification par secret partagé (header X-Upload-Secret)
 *   - Vérification de la signature HMAC-SHA256 du contenu
 *   - Whitelist stricte des noms de fichiers autorisés
 *   - Refus de tout chemin contenant ".." ou débutant par "/"
 *
 * Usage côté GitHub Actions :
 *   curl -X POST \
 *     -H "X-Upload-Secret: $SECRET" \
 *     -F "file=@runs.json.gz" \
 *     -F "filename=runs.json.gz" \
 *     -F "mode=snapshot" \
 *     https://thefronthub.com/_upload.php
 *
 *   curl -X POST \
 *     -H "X-Upload-Secret: $SECRET" \
 *     -F "file=@runs.json.gz" \
 *     -F "filename=runs.json.gz" \
 *     -F "mode=archive" \
 *     https://thefronthub.com/_upload.php
 *
 * Modes :
 *   - snapshot : écrase le fichier existant (default)
 *   - archive  : sauvegarde avec date dans le nom (runs_2026-08-26_14h30.json.gz)
 *                + rotation auto (delete > 30 jours)
 *
 * Installation :
 *   1. Uploade ce fichier dans /home/USER/public_html/thefronthub.com/_upload.php
 *   2. Change la valeur de $SECRET ci-dessous (génère un secret aléatoire de 64 chars)
 *   3. Ajoute le même secret comme variable secrète O2SWITCH_UPLOAD_SECRET
 *      dans GitHub (Settings → Secrets and variables → Actions)
 *   4. Bloque l'accès direct au fichier via .htaccess (voir GUIDE_COMPLET_O2SWITCH.md)
 */

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════

// ⚠️ REMPLACE CETTE VALEUR par un secret aléatoire de 64 caractères hex
// Génère-le avec : openssl rand -hex 32
$SECRET = 'CHANGE_MOI_PAR_UN_SECRET_DE_64_CHARS_HEX';

// Dossier racine où stocker les fichiers (document root du site)
// En shared hosting o2switch, c'est généralement : /home/USER/public_html/thefronthub.com
$WEB_ROOT = realpath(__DIR__);

// Dossier d'archive (optionnel, pour le mode "archive")
$ARCHIVE_DIR = $WEB_ROOT . '/_archives';

// Durée de rétention des archives en jours
$ARCHIVE_RETENTION_DAYS = 30;

// Liste des fichiers autorisés (whitelist stricte)
// Ajoute/supprime selon tes besoins — IMPORTANT pour la sécurité
$ALLOWED_FILES = [
    // Snapshots (écrasés à chaque sync)
    'lobby_state.json',
    'ranked.json',
    'ranked_history.json.gz',
    'ranked_2v2_history.json.gz',
    'teams.json',
    'teams_runs.json',
    'teams_seen.json',
    'dashboard_scores.json',
    'dashboard_scores.json.gz',
    'dashboard_ranking.json',
    'dashboard_player_games.json',
    'checkpoint.json',
    'checkpoint_compact.json',
    'seen.json',
    'seen_compact.json',
    'maps_list.json',

    // Données publiques allégées
    'runs_public.json',
    'runs_public.json.gz',
    'runs_compact_public.json',
    'runs_compact_public.json.gz',

    // Archives (mode archive, noms avec date)
    'runs.json.gz',           // peut être en snapshot OU archive
    'runs_compact.json.gz',   // idem
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
//  EXÉCUTION
// ═══════════════════════════════════════════════════════════

// Only accept POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    die('Method Not Allowed');
}

// Vérifier le secret partagé
$providedSecret = $_SERVER['HTTP_X_UPLOAD_SECRET'] ?? '';
if (!hash_equals($SECRET, $providedSecret)) {
    http_response_code(403);
    error_log("[_upload.php] Forbidden: bad secret from IP " . ($_SERVER['REMOTE_ADDR'] ?? '?'));
    die('Forbidden');
}

// Récupérer les paramètres
$filename = $_POST['filename'] ?? '';
$mode = $_POST['mode'] ?? 'snapshot';
$tmpPath = $_FILES['file']['tmp_name'] ?? '';

// Validations
if (empty($filename)) {
    http_response_code(400);
    die('Missing filename');
}
if (empty($tmpPath) || !is_uploaded_file($tmpPath)) {
    http_response_code(400);
    die('Missing file');
}
if (!in_array($mode, ['snapshot', 'archive'], true)) {
    http_response_code(400);
    die('Invalid mode');
}

// Vérifier le nom de fichier contre la whitelist
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
    http_response_code(400);
    error_log("[_upload.php] Rejected filename: $filename");
    die('Filename not in whitelist');
}

// Sécurité : pas de ".." dans le chemin, pas de chemin absolu
if (strpos($filename, '..') !== false || strpos($filename, '/') === 0) {
    http_response_code(400);
    die('Invalid path');
}

// Construire le chemin cible
$targetPath = $WEB_ROOT . '/' . $filename;
$targetDir = dirname($targetPath);

// Créer le dossier si nécessaire
if (!is_dir($targetDir)) {
    if (!mkdir($targetDir, 0755, true)) {
        http_response_code(500);
        error_log("[_upload.php] Cannot mkdir: $targetDir");
        die('Cannot create directory');
    }
}

// ── Mode snapshot : écrase ──
if ($mode === 'snapshot') {
    if (!move_uploaded_file($tmpPath, $targetPath)) {
        http_response_code(500);
        error_log("[_upload.php] move_uploaded_file failed: $targetPath");
        die('Upload failed (snapshot)');
    }
    chmod($targetPath, 0644);
    echo json_encode([
        'ok' => true,
        'mode' => 'snapshot',
        'filename' => $filename,
        'bytes' => filesize($targetPath),
        'path' => $filename,  // relatif
    ]);
    exit;
}

// ── Mode archive : sauvegarde avec date + rotation ──
if (!is_dir($ARCHIVE_DIR)) {
    if (!mkdir($ARCHIVE_DIR, 0755, true)) {
        http_response_code(500);
        error_log("[_upload.php] Cannot mkdir archive: $ARCHIVE_DIR");
        die('Cannot create archive directory');
    }
}

// Construire le nom archivé : runs_2026-08-26_14h30.json.gz
$baseInfo = pathinfo($filename);
$basename = $baseInfo['filename'];   // "runs"
$extension = isset($baseInfo['extension']) ? '.' . $baseInfo['extension'] : '';
$dateStr = date('Y-m-d_His');
$archiveName = $basename . '_' . $dateStr . $extension;

// Préfixer par le sous-dossier si présent (ex: player-data/)
if (strpos($filename, '/') !== false) {
    $subDir = explode('/', $filename)[0];
    $archiveSubDir = $ARCHIVE_DIR . '/' . $subDir;
    if (!is_dir($archiveSubDir)) mkdir($archiveSubDir, 0755, true);
    $archivePath = $archiveSubDir . '/' . $archiveName;
} else {
    $archivePath = $ARCHIVE_DIR . '/' . $archiveName;
}

if (!move_uploaded_file($tmpPath, $archivePath)) {
    http_response_code(500);
    error_log("[_upload.php] move_uploaded_file (archive) failed: $archivePath");
    die('Upload failed (archive)');
}
chmod($archivePath, 0644);

// Rotation : supprimer les archives > N jours
$deleted = [];
$cutoff = time() - ($ARCHIVE_RETENTION_DAYS * 86400);

// Lister tous les fichiers dans ARCHIVE_DIR correspondant au basename pattern
$basenameEscaped = preg_quote($basename, '/');
$pattern = '#^' . $basenameEscaped . '_\d{4}-\d{2}-\d{2}_\d{6}' . preg_quote($extension, '/') . '$#';

$iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($ARCHIVE_DIR, RecursiveDirectoryIterator::SKIP_DOTS)
);
foreach ($iterator as $file) {
    if (!$file->isFile()) continue;
    $baseName = $file->getFilename();
    if (!preg_match($pattern, $baseName)) continue;
    if ($file->getMTime() < $cutoff) {
        if (unlink($file->getPathname())) {
            $deleted[] = $baseName;
        }
    }
}

echo json_encode([
    'ok' => true,
    'mode' => 'archive',
    'filename' => $filename,
    'archived_as' => basename($archivePath),
    'bytes' => filesize($archivePath),
    'rotation_deleted' => count($deleted),
    'retention_days' => $ARCHIVE_RETENTION_DAYS,
]);
