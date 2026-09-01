<?php
declare(strict_types=1);

/**
 * GET task/auth/login.php
 * Démarre le flux OAuth Discord du panel : state à usage unique
 * (table tfh_oauth_states partagée avec le site, 15 min) puis
 * redirection vers l'écran d'autorisation Discord.
 */

define('TFH_API', true);
require __DIR__ . '/../lib.php';

task_security_headers();

if (TFH_DISCORD_CLIENT_ID === '' || TFH_DISCORD_CLIENT_SECRET === '') {
    task_fatal(
        'Discord non configuré',
        'Les identifiants Discord (client_id / client_secret) sont absents du fichier '
        . 'de secrets du serveur. Vérifie ~/.tfs_secrets/tfh-secrets.json.'
    );
}

rate_limit($pdo, 'task-oauth-start:' . client_ip(), 10, 600);

/* States expirés : nettoyage opportuniste */
$pdo->exec('DELETE FROM tfh_oauth_states WHERE created_at < DATE_SUB(NOW(), INTERVAL ' . TFH_STATE_TTL . ' SECOND)');

$state = bin2hex(random_bytes(32));
$pdo->prepare('INSERT INTO tfh_oauth_states (state, created_at) VALUES (?, NOW())')
    ->execute([$state]);

$params = http_build_query([
    'client_id'     => TFH_DISCORD_CLIENT_ID,
    'redirect_uri'  => task_redirect_uri(),
    'response_type' => 'code',
    'scope'         => 'identify',
    'state'         => $state,
]);
/* %20 plutôt que + pour le scope (format attendu par Discord) */
$params = str_replace('+', '%20', $params);

header('Location: ' . TFH_DISCORD_AUTHORIZE_URL . '?' . $params, true, 302);
exit;
