<?php
declare(strict_types=1);

/**
 * secure/auth-config.php — Configuration de la porte d'accès DEV.
 *
 * ⚠️  Ce fichier ne contient JAMAIS le code d'accès en clair :
 *     - 'hash'   : hash bcrypt du code (irréversible en pratique hors
 *                  accès disque ; le fichier n'est jamais servi en HTTP :
 *                  refusé par secure/.htaccess, par la règle RewriteRule
 *                  ^secure du .htaccess racine et par gate.php lui-même).
 *     - 'secret' : clé HMAC-SHA256 qui signe le cookie de session
 *                  (impossible de forger un cookie sans elle).
 *     - 'v'      : version — l'incrémenter déconnecte immédiatement
 *                  toutes les sessions existantes.
 *
 * Pour CHANGER le code d'accès :
 *   1. php -r "echo password_hash('NOUVEAU_CODE', PASSWORD_BCRYPT), PHP_EOL;"
 *   2. Remplacer la valeur 'hash' ci-dessous (et bump 'v' pour purger).
 *
 * Ce fichier est volontairement versionné : il ne révèle rien d'exploitable
 * sans accès disque au serveur (le code lui-même n'y figure pas).
 */

return [
    'v'      => 1,
    'hash'   => '$2y$12$56sfEPt9gwune.sY6Sq/BueL7.ClHXij6PkRXAntPsC5BNcE/poAu',
    'secret' => '88745fa6d59897bc6dfd9b5b9eee2d10edb75e886fc5fb4478f06d88dcf55546',
];
