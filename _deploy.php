<?php
/**
 * _deploy.php — Webhook GitHub pour déploiement INSTANTANÉ du code
 *
 * ⚡ Quand tu fais `git push` sur GitHub, ce script est appelé en ~2 sec
 *    par GitHub Webhooks. Il met à jour le code sur o2switch instantanément.
 *
 * Sécurité (v2 — audit 2026) :
 *   - Vérification OBLIGATOIRE de la signature HMAC-SHA256 du webhook GitHub
 *     (header X-Hub-Signature-256) avec secret résolu par couches :
 *       1. Variable d'environnement O2SWITCH_DEPLOY_SECRET
 *       2. Fichier hors webroot : <home>/.tfs_secrets/deploy_secret.txt
 *       3. Constante $SECRET_FALLBACK ci-dessous (copie serveur uniquement)
 *   - Fail-closed : refuse de s'exécuter si le secret est vide/placeholder
 *   - Désactivable instantanément : créer un fichier _deploy.disabled
 *   - Valeurs du payload assainies avant écriture dans les logs
 *     (anti log-injection via pusher/commit message)
 *   - Contrôles realpath() des chemins configurés
 *   - Aucune donnée du payload n'est interpolée dans les commandes shell
 *
 * Installation :
 *   1. Uploade ce fichier dans /home/USER/public_html/thefronthub.com/_deploy.php
 *   2. Génère un secret : openssl rand -hex 32 (DIFFÉRENT de celui de _upload.php)
 *   3. Configure-le (une seule méthode) :
 *      a) /home/USER/.tfs_secrets/deploy_secret.txt (chmod 600) — recommandé
 *      b) Ou remplis $SECRET_FALLBACK ci-dessous (copie serveur uniquement)
 *   4. Configure le webhook GitHub :
 *      - URL : https://thefronthub.com/_deploy.php
 *      - Content type : application/json
 *      - Secret : le même secret
 *      - Events : "Just the push event"
 *
 * ⚠️ Ce fichier ne doit JAMAIS être committé avec un vrai secret à l'intérieur.
 */

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════

// Secret de secours (copie serveur uniquement — laisse vide dans le repo).
$SECRET_FALLBACK = '';

// Chemin du repo Git cloné sur o2switch
$REPO_PATH = '/home/USER/thefronthub-src';

// Document root du site (où les fichiers doivent être servis)
$WEB_ROOT = '/home/USER/public_html/thefronthub.com';

// Logs (pour debug — visible dans cPanel → Erreurs)
$LOG_FILE = '/home/USER/logs/deploy.log';

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

// ── Kill-switch : un fichier _deploy.disabled à côté du script désactive tout ──
if (is_file(__DIR__ . '/_deploy.disabled')) {
    http_response_code(503);
    die('Deploy endpoint disabled');
}

/** Assainit une valeur pour les logs (anti log-injection, une ligne propre). */
function logSafe($value, $maxLen = 200) {
    $clean = preg_replace('/[\x00-\x1F\x7F]+/', ' ', (string) $value);
    $clean = str_replace(["\r", "\n"], ' ', $clean);
    if (strlen($clean) > $maxLen) {
        $clean = substr($clean, 0, $maxLen) . '…';
    }
    return $clean;
}

function logMsg($msg) {
    global $LOG_FILE;
    $line = '[' . date('Y-m-d H:i:s') . '] ' . logSafe($msg, 500) . "\n";
    $logDir = dirname($LOG_FILE);
    if (!is_dir($logDir)) {
        @mkdir($logDir, 0755, true);
    }
    @file_put_contents($LOG_FILE, $line, FILE_APPEND);
}

/** Résolution du secret par couches : env → fichier hors webroot → constante. */
function resolve_secret($fallback) {
    $env = getenv('O2SWITCH_DEPLOY_SECRET');
    if ($env === false) {
        $env = $_SERVER['O2SWITCH_DEPLOY_SECRET'] ?? '';
    }
    if (is_string($env) && strlen(trim($env)) >= 16) {
        return trim($env);
    }
    $home = dirname(__DIR__, 2);
    $secretFile = $home . '/.tfs_secrets/deploy_secret.txt';
    if (is_file($secretFile) && is_readable($secretFile)) {
        $value = trim((string) file_get_contents($secretFile));
        if (strlen($value) >= 16) {
            return $value;
        }
    }
    if (is_string($fallback) && strlen(trim($fallback)) >= 16) {
        return trim($fallback);
    }
    return '';
}

// ── Résolution du secret + fail-closed sur placeholder ──
$SECRET = resolve_secret($SECRET_FALLBACK);
$placeholders = [
    'change_moi_par_un_secret_webhook_different_de_upload',
];
if ($SECRET === '' || in_array(strtolower($SECRET), $placeholders, true)) {
    error_log('[_deploy.php] SECRET non configure (placeholder ou vide) — acces refuse');
    http_response_code(403);
    die('Forbidden');
}

// ── Récupérer le body brut ──
$body = file_get_contents('php://input');

// ── Vérifier la signature HMAC-SHA256 du webhook GitHub (obligatoire) ──
$signature = (string) ($_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '');
$expected = 'sha256=' . hash_hmac('sha256', $body, $SECRET);

if ($signature === '' || !hash_equals($expected, $signature)) {
    http_response_code(403);
    logMsg('Forbidden: bad signature from IP ' . ($_SERVER['REMOTE_ADDR'] ?? '?'));
    die('Forbidden');
}

// ── Parser le payload JSON ──
$payload = json_decode($body, true);
if (!is_array($payload)) {
    http_response_code(400);
    logMsg('Bad JSON payload');
    die('Bad payload');
}

// ── Vérifier que c'est un push sur la branche main ──
$ref = (string) ($payload['ref'] ?? '');
if ($ref !== 'refs/heads/main') {
    http_response_code(200);
    logMsg('Ignored push on ' . logSafe($ref, 100));
    die('Ignored (not main)');
}

// ── Infos utiles pour le log (assainies — jamais de retour à la ligne) ──
$headCommit = $payload['head_commit'] ?? [];
$commitId = logSafe($headCommit['id'] ?? '?', 40);
$commitMsg = logSafe($headCommit['message'] ?? '(no message)', 200);
$pusher = logSafe($payload['pusher']['name'] ?? '?', 100);

logMsg("Deploy started by $pusher — commit: $commitId");
logMsg("   Message: $commitMsg");

// ── Contrôles des chemins configurés (realpath) ──
if ($REPO_PATH === '' || !is_dir($REPO_PATH . '/.git')) {
    http_response_code(500);
    logMsg("Repo not found at $REPO_PATH");
    die('Repo not found');
}
if ($WEB_ROOT === '' || !is_dir($WEB_ROOT)) {
    http_response_code(500);
    logMsg("Web root not found at $WEB_ROOT");
    die('Web root not found');
}
$realRepo = realpath($REPO_PATH);
$realWeb = realpath($WEB_ROOT);
if ($realRepo === false || $realWeb === false || $realRepo === $realWeb) {
    http_response_code(500);
    logMsg('Invalid repo/web root configuration');
    die('Invalid configuration');
}

// ── Commandes de déploiement ──
//
// ⚠️ AUCUNE donnée du payload n'est interpolée ici (seules les constantes
//    realpath-contrôlées ci-dessus). Le payload ne sert qu'aux logs.
//
$commands = [
    // Récupère les derniers changements
    "cd " . escapeshellarg($realRepo) . " && git fetch origin main 2>&1",
    "cd " . escapeshellarg($realRepo) . " && git reset --hard origin/main 2>&1",
    // Nettoie les éventuels fichiers non trackés (npm, etc.)
    "cd " . escapeshellarg($realRepo) . " && git clean -fd --exclude=node_modules 2>&1",
    // Rsync vers le document root avec excludes de sécurité
    "rsync -a --delete " .
    "--exclude='.git' " .
    "--exclude='.htaccess' " .
    "--exclude='_upload.php' " .
    "--exclude='_deploy.php' " .
    "--exclude='_deploy.disabled' " .
    "--exclude='_archives' " .
    "--exclude='*.json' " .
    "--exclude='*.json.gz' " .
    "--exclude='player-data' " .
    "--exclude='player-stats' " .
    "--exclude='node_modules' " .
    "--exclude='.github' " .
    "--exclude='.tfs_secrets' " .
    "--exclude='scripts' " .
    "--exclude='src' " .
    "--exclude='tests' " .
    "--exclude='worklog.md' " .
    "--exclude='agent-ctx' " .
    "--exclude='_wip-auth-mysql' " .
    "--exclude='.gitignore' " .
    "--exclude='dev.log' " .
    "--exclude='server.log' " .
    escapeshellarg($realRepo . '/') . " " . escapeshellarg($realWeb . '/') . " 2>&1",
];

// Exécuter les commandes
foreach ($commands as $i => $cmd) {
    $output = shell_exec($cmd);
    if ($output) {
        logMsg("   [cmd " . ($i + 1) . "] " . trim((string) $output));
    }
}

// Vérifier que le déploiement a marché (index.html doit exister)
if (!file_exists($realWeb . '/index.html')) {
    http_response_code(500);
    logMsg('Deploy failed: index.html missing');
    die('Deploy failed');
}

logMsg('Deploy successful — ' . date('Y-m-d H:i:s'));

// Répondre à GitHub
http_response_code(200);
header('Content-Type: application/json; charset=utf-8');
echo json_encode([
    'ok' => true,
    'deployed_at' => date('c'),
    'commit' => $commitId,
]);
