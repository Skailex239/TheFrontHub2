<?php
declare(strict_types=1);

/**
 * TheFrontHub API - configuration centrale
 *
 * - Charge les secrets depuis ~/.tfs_secrets/tfh-secrets.json (hors webroot,
 *   jamais dans Git, jamais servi par Apache).
 * - Ouvre la connexion PDO (MySQL o2switch).
 * - Definit les constantes partagees, puis inclut helpers.php.
 *
 * Ce fichier doit etre inclus uniquement par les points d'entree de l'API
 * (ils definissent TFH_API avant l'inclusion).
 */

if (!defined('TFH_API')) {
    http_response_code(403);
    exit('Forbidden');
}

/* ------------------------------------------------------------------ */
/* Secrets (chemins tentes dans l'ordre, premier lisible qui gagne)   */
/* ------------------------------------------------------------------ */

$secretPaths = [];

$home = getenv('HOME');
if (is_string($home) && $home !== '') {
    $secretPaths[] = rtrim($home, '/') . '/.tfs_secrets/tfh-secrets.json';
}

/* Chemin relatif au webroot : api -> thefronthub.com -> public_html -> home */
$secretPaths[] = dirname(__DIR__, 3) . '/.tfs_secrets/tfh-secrets.json';

$secrets = null;
foreach ($secretPaths as $path) {
    if (is_readable($path)) {
        $decoded = json_decode((string) file_get_contents($path), true);
        if (is_array($decoded)) {
            $secrets = $decoded;
            break;
        }
    }
}

$mysqlConfig   = is_array($secrets['mysql'] ?? null)   ? $secrets['mysql']   : null;
$discordConfig = is_array($secrets['discord'] ?? null) ? $secrets['discord'] : null;

if ($mysqlConfig === null || $discordConfig === null) {
    error_log('[tfh-api] fichier de secrets introuvable ou structure invalide');
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'config_unavailable']);
    exit;
}

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

define('TFH_BASE_URL', 'https://thefronthub.com');

define('TFH_SESSION_COOKIE', 'tfh_session');
define('TFH_SESSION_TTL', 30 * 86400); // 30 jours glissants
define('TFH_STATE_TTL', 15 * 60);      // etats OAuth valides 15 min

define('TFH_DISCORD_AUTHORIZE_URL', 'https://discord.com/oauth2/authorize');
define('TFH_DISCORD_TOKEN_URL', 'https://discord.com/api/oauth2/token');
define('TFH_DISCORD_ME_URL', 'https://discord.com/api/users/@me');

define('TFH_DISCORD_CLIENT_ID', (string) ($discordConfig['client_id'] ?? ''));
define('TFH_DISCORD_CLIENT_SECRET', (string) ($discordConfig['client_secret'] ?? ''));
define(
    'TFH_DISCORD_REDIRECT_URI',
    (string) ($discordConfig['redirect_uri'] ?? TFH_BASE_URL . '/api/auth/discord/callback.php')
);

/* ------------------------------------------------------------------ */
/* PDO                                                                 */
/* ------------------------------------------------------------------ */

try {
    $pdo = new PDO(
        sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            (string) ($mysqlConfig['host'] ?? 'localhost'),
            (int) ($mysqlConfig['port'] ?? 3306),
            (string) ($mysqlConfig['database'] ?? '')
        ),
        (string) ($mysqlConfig['username'] ?? ''),
        (string) ($mysqlConfig['password'] ?? ''),
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]
    );
} catch (Throwable $e) {
    error_log('[tfh-api] PDO: ' . $e->getMessage());
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'db_unavailable']);
    exit;
}

require __DIR__ . '/helpers.php';
