<?php
declare(strict_types=1);

/**
 * api/mail-config.example.php — gabarit de configuration de la boîte mail
 * support@thefronthub.com pour la section « Mails » de l'espace admin.
 *
 * MISE EN PLACE (sur le serveur o2switch, via le gestionnaire de fichiers) :
 *   1. Copie ce fichier :  cp api/mail-config.example.php api/mail-config.php
 *   2. Remplis le mot de passe de la boîte support@thefronthub.com.
 *   3. Le fichier api/mail-config.php est IGNORÉ PAR GIT (jamais commité)
 *      et n'est lisible que par le PHP du serveur.
 *
 * Sans ce fichier, la section « Mails » de l'admin affiche un message
 * d'aide au lieu des mails — le reste du site fonctionne normalement.
 */

return [
    /* true = lecteur IMAP activé dans l'admin */
    'enabled' => true,

    /* Boîte créée dans cPanel o2switch (Comptes e-mail). */
    'user'    => 'support@thefronthub.com',
    'pass'    => 'MOT_DE_PASSE_ICI',

    /* Sur o2switch, le PHP tourne sur le serveur mail lui-même :
     * localhost (pas de TLS requis en local, rapide et fiable).
     * Alternative distante : 'imap.thefronthub.com:993/ssl' */
    'dsn'     => '{localhost:143/notls}INBOX',

    /* Adresse affichée comme expéditeur quand l'équipe répond depuis l'admin. */
    'from'    => 'TheFrontHub Support <support@thefronthub.com>',

    /* Nombre maximum de mails listés dans l'admin. */
    'limit'   => 30,
];
