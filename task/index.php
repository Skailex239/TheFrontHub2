<?php
declare(strict_types=1);

/**
 * task/index.php — redirection de compatibilité.
 *
 * Le panel vit désormais sur admin.thefronthub.com (dossier admin/ du repo).
 * Ce stub garde l'ancien sous-domaine thefronthub.com/task/ et le sous-domaine
 * task.thefronthub.com vivants : tout est renvoyé vers le nouvel espace admin.
 *
 * NB : on ne redirige PAS en préservant le chemin pour /auth/callback.php —
 * la session (cookie) est liée à l'hôte, un callback traversé par redirection
 * perdrait son cookie. Le flux OAuth doit donc toujours DÉMARRER côté admin.
 */

header('Location: https://admin.thefronthub.com/', true, 301);
exit;
