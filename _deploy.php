<?php
/**
 * _deploy.php — Webhook GitHub pour déploiement INSTANTANÉ du code
 *
 * ⚡ Quand tu fais `git push` sur GitHub, ce script est appelé en ~2 sec
 *    par GitHub Webhooks. Il met à jour le code sur o2switch instantanément.
 *
 * Comment ça marche :
 *   1. GitHub envoie un POST avec le payload du push + signature HMAC
 *   2. Ce script vérifie la signature (sécurité)
 *   3. Si c'est un push sur `main`, il lance git pull + rsync
 *   4. Le code est mis à jour sur le site
 *
 * ⚠️ Ce script ne touche PAS aux fichiers de données (lobby_state.json, etc.)
 *    qui sont gérés séparément par la sync HTTP GitHub Actions → _upload.php
 *
 * Installation :
 *   1. Uploade ce fichier dans /home/USER/public_html/thefronthub.com/_deploy.php
 *   2. Change $SECRET ci-dessous (génère un secret aléatoire de 64 chars)
 *   3. Configure le webhook sur GitHub :
 *      - URL : https://thefronthub.com/_deploy.php
 *      - Content type : application/json
 *      - Secret : le même que $SECRET
 *      - Events : "Just the push event"
 *
 * Test :
 *   curl -X POST -H "X-Hub-Signature-256: sha256=..." \
 *     -H "Content-Type: application/json" \
 *     -d '{"ref":"refs/heads/main"}' \
 *     https://thefronthub.com/_deploy.php
 */

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════

// ⚠️ REMPLACE CETTE VALEUR par un secret aléatoire de 64 caractères hex
// Génère-le avec : openssl rand -hex 32
// ⚠️ Ce secret DOIT ÊTRE DIFFÉRENT du secret de _upload.php !
$SECRET = 'CHANGE_MOI_PAR_UN_SECRET_WEBHOOK_DIFFERENT_DE_UPLOAD';

// Chemin du repo Git cloné sur o2switch
$REPO_PATH = '/home/USER/thefronthub-src';

// Document root du site (où les fichiers doivent être servis)
$WEB_ROOT = '/home/USER/public_html/thefronthub.com';

// Logs (pour debug — visible dans cPanel → Erreurs)
$LOG_FILE = '/home/USER/logs/deploy.log';

// ═══════════════════════════════════════════════════════════
//  EXÉCUTION
// ═══════════════════════════════════════════════════════════

// Only accept POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    die('Method Not Allowed');
}

// Récupérer le body brut
$body = file_get_contents('php://input');

// Vérifier la signature HMAC-SHA256 (sécurité obligatoire)
$signature = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
$expected = 'sha256=' . hash_hmac('sha256', $body, $SECRET);

if (!hash_equals($expected, $signature)) {
    http_response_code(403);
    logMsg('❌ Forbidden: bad signature from IP ' . ($_SERVER['REMOTE_ADDR'] ?? '?'));
    die('Forbidden');
}

// Parser le payload JSON
$payload = json_decode($body, true);
if (!$payload) {
    http_response_code(400);
    logMsg('❌ Bad JSON payload');
    die('Bad payload');
}

// Vérifier que c'est un push sur la branche main
$ref = $payload['ref'] ?? '';
if ($ref !== 'refs/heads/main') {
    http_response_code(200);
    logMsg('ℹ️ Ignored push on ' . $ref);
    die('Ignored (not main)');
}

// Récupérer les infos utiles pour le log
$headCommit = $payload['head_commit'] ?? [];
$commitId = $headCommit['id'] ?? '?';
$commitMsg = $headCommit['message'] ?? '(no message)';
$pusher = $payload['pusher']['name'] ?? '?';

logMsg("🚀 Deploy started by $pusher — commit: $commitId");
logMsg("   Message: $commitMsg");

// Vérifier que le repo existe
if (!is_dir($REPO_PATH . '/.git')) {
    http_response_code(500);
    logMsg("❌ Repo not found at $REPO_PATH");
    die('Repo not found');
}

// Vérifier que le document root existe
if (!is_dir($WEB_ROOT)) {
    http_response_code(500);
    logMsg("❌ Web root not found at $WEB_ROOT");
    die('Web root not found');
}

// ── Commandes de déploiement ──
//
// 1. git fetch + reset --hard : récupère la dernière version du main
// 2. rsync : copie les fichiers vers le document root
//    ⚠️ EXCLUDES importants :
//    - .git           → ne pas copier le dossier git dans le web root
//    - .htaccess      → config o2switch (ne pas écraser)
//    - _upload.php    → endpoint sync données (contient un secret)
//    - _deploy.php    → ce fichier (ne pas s'auto-écraser)
//    - _archives/     → archives horodatées des données
//    - *.json         → fichiers de données (gérés par sync HTTP)
//    - *.json.gz      → archives de données
//    - player-data/   → données joueurs (sync HTTP)
//    - player-stats/  → stats joueurs (sync HTTP)
//    - node_modules/  → dépendances npm
//    - .github/       → workflows GitHub Actions
//    - scripts/       → scripts de sync (pas besoin côté serveur)
//    - src/           → code Next.js (pas utilisé en prod)
//    - tests/         → tests unitaires
//
$commands = [
    // Récupère les derniers changements
    "cd $REPO_PATH && git fetch origin main 2>&1",
    "cd $REPO_PATH && git reset --hard origin/main 2>&1",
    // Nettoie les éventuels fichiers non trackés (npm, etc.)
    "cd $REPO_PATH && git clean -fd --exclude=node_modules 2>&1",
    // Rsync vers le document root avec excludes de sécurité
    "rsync -a --delete " .
    "--exclude='.git' " .
    "--exclude='.htaccess' " .
    "--exclude='_upload.php' " .
    "--exclude='_deploy.php' " .
    "--exclude='_archives' " .
    "--exclude='*.json' " .
    "--exclude='*.json.gz' " .
    "--exclude='player-data' " .
    "--exclude='player-stats' " .
    "--exclude='node_modules' " .
    "--exclude='.github' " .
    "--exclude='scripts' " .
    "--exclude='src' " .
    "--exclude='tests' " .
    "--exclude='.gitignore' " .
    "--exclude='dev.log' " .
    "--exclude='server.log' " .
    "$REPO_PATH/ $WEB_ROOT/ 2>&1",
];

// Exécuter les commandes
foreach ($commands as $i => $cmd) {
    $output = shell_exec($cmd);
    if ($output) {
        logMsg("   [cmd " . ($i + 1) . "] " . trim($output));
    }
}

// Vérifier que le déploiement a marché (index.html doit exister)
if (!file_exists($WEB_ROOT . '/index.html')) {
    http_response_code(500);
    logMsg('❌ Deploy failed: index.html missing');
    die('Deploy failed');
}

logMsg('✅ Deploy successful — ' . date('Y-m-d H:i:s'));

// Répondre à GitHub
http_response_code(200);
header('Content-Type: application/json');
echo json_encode([
    'ok' => true,
    'deployed_at' => date('c'),
    'commit' => $commitId,
    'message' => $commitMsg,
    'pusher' => $pusher,
]);


// ═══════════════════════════════════════════════════════════
//  FONCTIONS UTILITAIRES
// ═══════════════════════════════════════════════════════════

function logMsg($msg) {
    global $LOG_FILE;
    $line = '[' . date('Y-m-d H:i:s') . '] ' . $msg . "\n";
    // Crée le dossier logs/ si nécessaire
    $logDir = dirname($LOG_FILE);
    if (!is_dir($logDir)) {
        @mkdir($logDir, 0755, true);
    }
    @file_put_contents($LOG_FILE, $line, FILE_APPEND);
}
