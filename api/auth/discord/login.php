<?php
declare(strict_types=1);

/**
 * GET /api/auth/discord/login.php
 * Demarre le login Discord : genere un state anti-CSRF a usage unique
 * (valide 15 min) puis redirige vers l'ecran d'autorisation Discord.
 */

define('TFH_API', true);
require __DIR__ . '/../../config.php';

rate_limit($pdo, 'oauth-start:' . client_ip(), 10, 600);

/* Nettoyage des vieux states, vieilles sessions expirees, vieux buckets */
$pdo->exec('DELETE FROM tfh_oauth_states WHERE created_at < DATE_SUB(NOW(), INTERVAL ' . TFH_STATE_TTL . ' SECOND)');
$pdo->exec('DELETE FROM tfh_sessions WHERE expires_at < NOW()');
$pdo->exec('DELETE FROM tfh_rate_limits WHERE window_start < DATE_SUB(NOW(), INTERVAL 1 DAY)');

$state = bin2hex(random_bytes(32));
$pdo->prepare('INSERT INTO tfh_oauth_states (state, created_at) VALUES (?, NOW())')
    ->execute([$state]);

$params = http_build_query([
    'client_id'    => TFH_DISCORD_CLIENT_ID,
    'redirect_uri' => TFH_DISCORD_REDIRECT_URI,
    'response_type' => 'code',
    'scope'        => 'identify email',
    'state'        => $state,
]);

/* %20 plutot que + pour le scope (format attendu par Discord) */
$params = str_replace('+', '%20', $params);

header('Location: ' . TFH_DISCORD_AUTHORIZE_URL . '?' . $params, true, 302);
exit;
