<?php
declare(strict_types=1);

/**
 * task/file.php — service sécurisé des fichiers joints à la discussion.
 *
 * Les fichiers ne sont JAMAIS servis directement par Apache : ils sont
 * stockés hors du dossier web (~/.tfh_task_uploads) et ne sortent d'ici
 * qu'après vérification de la session du panel.
 *
 * GET ?id=<16 hex>          → affichage en ligne (image, vidéo, audio, PDF)
 * GET ?id=<16 hex>&dl=1     → téléchargement forcé
 *
 * Les fichiers ont une durée de vie de TASK_CHAT_FILE_TTL_DAYS jours
 * (purge automatique) : après expiration, 410 Gone.
 */

define('TFH_API', true);

require __DIR__ . '/lib.php';

set_exception_handler(static function (Throwable $e): void {
    error_log('[tfh-task] file: ' . get_class($e) . ': ' . $e->getMessage());
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Erreur serveur — fichier indisponible.';
    exit;
});

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    header('Allow: GET');
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Méthode non autorisée.';
    exit;
}

$user = current_user($pdo);
if ($user === null) {
    http_response_code(401);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Session expirée — recharge le panel.';
    exit;
}

task_ensure_schema($pdo);

$access = task_access($pdo, $user);
if (!$access['granted']) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Accès refusé.';
    exit;
}

$fileId = (string) ($_GET['id'] ?? '');
if (!preg_match('/^[a-f0-9]{16}$/', $fileId)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Fichier introuvable.';
    exit;
}

$st = $pdo->prepare(
    'SELECT id, task_id, path, name, mime, ext, size,
            UNIX_TIMESTAMP(expires_at) AS expires_ts
     FROM tfh_task_chat_files WHERE id = ? LIMIT 1'
);
$st->execute([$fileId]);
$row = $st->fetch();
if ($row === false) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Fichier introuvable (supprimé ?).';
    exit;
}

$expiresTs = (int) ($row['expires_ts'] ?? 0);
if ($expiresTs > 0 && $expiresTs < time()) {
    http_response_code(410);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Ce fichier a expiré (conservation ' . TASK_CHAT_FILE_TTL_DAYS . ' jours).';
    exit;
}

/* Chemin : toujours reconstruit depuis la racine du stockage (l'id est
   validé en hex ci-dessus, le chemin vient de la base — jamais du client). */
$base = task_upload_dir();
$abs  = $base . '/' . ltrim((string) $row['path'], '/');
$real = @realpath($abs);
if ($real === false || strpos($real, $base) !== 0 || !is_file($real)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Fichier manquant sur le disque.';
    exit;
}

$size = (int) ($row['size'] ?? 0);
if ($size <= 0) {
    $size = (int) filesize($real);
}
$mime   = (string) ($row['mime'] ?? '');
$ext    = (string) ($row['ext'] ?? '');
$name   = (string) ($row['name'] ?? ('fichier.' . $ext));
$dl     = !empty($_GET['dl']);

/* Contenu affichable en ligne sans risque. Tout le reste
   (SVG, archives, HTML-like, inconnu) est forcé au téléchargement. */
$inlineOk = $mime !== ''
    && ($ext !== 'svg')
    && (strpos($mime, 'image/') === 0
        || strpos($mime, 'video/') === 0
        || strpos($mime, 'audio/') === 0
        || $mime === 'application/pdf'
        || $mime === 'text/plain'
        || $mime === 'application/json');

header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Cache-Control: private, max-age=86400');
header('Accept-Ranges: bytes');
header('Content-Type: ' . ($mime !== '' ? $mime : 'application/octet-stream'));

$dispoName = str_replace(['"', "\\", "\r", "\n"], '_', $name);
if ($dl || !$inlineOk) {
    header('Content-Disposition: attachment; filename="' . $dispoName . '"; filename*=UTF-8\'\'' . rawurlencode($name));
} else {
    header('Content-Disposition: inline; filename="' . $dispoName . '"; filename*=UTF-8\'\'' . rawurlencode($name));
}

/* Requêtes Range : indispensable pour le déplacement dans une vidéo. */
$start = 0;
$end   = $size - 1;
$range = (string) ($_SERVER['HTTP_RANGE'] ?? '');
if ($range !== '' && preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $m)) {
    if ($m[1] !== '') {
        /* "x-y" : tranche explicite */
        $start = (int) $m[1];
        if ($m[2] !== '') {
            $end = (int) $m[2];
        }
    } elseif ($m[2] !== '') {
        /* "-N" : les N derniers octets */
        $suffix = (int) $m[2];
        $start  = max(0, $size - $suffix);
        $end    = $size - 1;
    }
    if ($end >= $size) {
        $end = $size - 1;
    }
    if ($start > $end || $start >= $size) {
        http_response_code(416);
        header('Content-Range: bytes */' . $size);
        exit;
    }
    http_response_code(206);
    header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
}

$length = $end - $start + 1;
header('Content-Length: ' . $length);

if ($length <= 0) {
    exit;
}

$fh = @fopen($real, 'rb');
if ($fh === false) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Lecture impossible.';
    exit;
}
fseek($fh, $start);
$remaining = $length;
while ($remaining > 0 && !feof($fh)) {
    $chunk = fread($fh, min(8192, $remaining));
    if ($chunk === false || $chunk === '') {
        break;
    }
    echo $chunk;
    $remaining -= strlen($chunk);
    flush();
}
fclose($fh);
