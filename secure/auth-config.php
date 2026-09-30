<?php
declare(strict_types=1);

/**
 * secure/auth-config.php — OBSOLÈTE depuis v5.16.5.
 *
 * ⚠️ Ce fichier ne contient PLUS aucune valeur (hash ni secret) :
 *    le repo GitHub est PUBLIC — toute valeur ici serait lisible par tous.
 *
 * La configuration de la porte vit désormais UNIQUEMENT sur le serveur :
 *     <home>/.tfs_secrets/gate-config.json   (chmod 600, hors webroot)
 *     {"v":2,"hash":"$2y$...","secret":"<64 hex>"}
 * Elle y est amorcée automatiquement au premier appel (secret neuf généré
 * sur le serveur, hash migré une fois depuis le code). Voir secure/auth-lib.php.
 *
 * Pour CHANGER le code d'accès :
 *   1. php -r "echo password_hash('NOUVEAU_CODE', PASSWORD_BCRYPT), PHP_EOL;"
 *   2. Éditer <home>/.tfs_secrets/gate-config.json via cPanel :
 *      remplacer 'hash' par le nouveau hash et AUGMENTER 'v' (+1)
 *      → déconnecte immédiatement toutes les sessions existantes.
 *
 * Ce fichier n'est plus lu par auth-lib.php ; il n'est conservé que pour
 * la documentation (et n'est de toute façon jamais servi en HTTP : refusé
 * par secure/.htaccess, par la règle ^secure du .htaccess racine et par
 * gate.php lui-même).
 */

return [];
