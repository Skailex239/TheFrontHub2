# GUIDE — Support TheFrontHub : email support@, chat en direct, admin

Tout ce qu'il faut savoir pour exploiter la nouvelle catégorie **Support**
(page publique) et l'espace **admin** (Tickets, Chat support, Mails).

---

## 1. Créer la boîte mail `support@thefronthub.com` (cPanel o2switch)

1. Connecte-toi à ton cPanel o2switch → **Email → Comptes de messagerie (Email Accounts)**.
2. **Créer** :
   - Domaine : `thefronthub.com`
   - Identifiant : `support`
   - Mot de passe : un mot de passe solide (garde-le précieusement, il servira à l'étape 3)
   - Quota : 1 Go suffisent au départ
3. (Recommandé) **Redirection** : Email → Redirecteurs → ajoute
   `support@thefronthub.com` → ton adresse personnelle, pour recevoir une copie
   de chaque mail même sans ouvrir l'admin.
4. (Recommandé, anti-spam) Vérifie que les enregistrements DNS **SPF/DKIM/DMARC**
   du domaine incluent l'envoi depuis o2switch (cPanel → Zone Editor / Email Deliverability →
   activer DKIM + SPF pour thefronthub.com). C'est en général déjà configuré par o2switch.

Envoi de test : depuis Webmail (https://mail.thefronthub.com ou cPanel → Email →
« + » → Webmail), envoie un mail vers une adresse externe et vérifie la réception.

---

## 2. Activer la section « Mails » dans l'admin (lecteur IMAP)

Le lecteur de mails de l'admin lit la boîte `support@` en **IMAP** côté serveur.

1. Sur le serveur (gestionnaire de fichiers o2switch ou SSH), copie le gabarit :

   ```
   cp api/mail-config.example.php api/mail-config.php
   ```

2. Édite `api/mail-config.php` :
   - `'pass' => 'TON_MOT_DE_PASSE'` (celui de l'étape 1)
   - Laisse `'dsn' => '{localhost:143/notls}INBOX'` : le PHP et le serveur mail
     sont sur la même machine chez o2switch (pas de TLS nécessaire en local).
     Si ça ne se connecte pas, essaie `'{localhost:993/ssl/novalidate-cert}INBOX'`.
3. C'est tout — le fichier est **ignoré par Git** (jamais commité) et protégé
   par le même garde-fou que le reste de l'API (`TFH_API`).
4. Dans l'admin → catégorie **Mails** → Actualiser. Tu vois la boîte.
   - « extension IMAP indisponible » → cPanel → **Select PHP Version → Extensions** →
     coche `imap` puis recharge.

**Répondre à un mail depuis l'admin** : bouton « Répondre » → le formulaire est
prérempli (destinataire + « Re: sujet ») → Envoyer. Le mail part en
`From: TheFrontHub Support <support@thefronthub.com>` avec les en-têtes
`In-Reply-To/References` → il se thread proprement dans n'importe quel client mail.
Tu peux aussi répondre depuis le **webmail o2switch** (identique pour le joueur).

---

## 3. La page Support (site public)

`https://thefronthub.com/support.html` propose désormais :

- **Rejoindre le Discord TheFrontHub** → https://discord.gg/AZhmqRvbNh
- **Email support@thefronthub.com** → mailto prérempli
- **Chat en direct** → ouvre le widget (bulle en bas à droite, présente sur
  toutes les pages du site)
- **FAQ** (8 questions) → filtre la majorité des demandes récurrentes
- **Tickets** : le système existant (catégorie, sujet, fil, réponses, « résolu »)

Un joueur doit être **connecté avec Discord** pour le chat et les tickets
(anti-spam, on connaît l'auteur).

---

## 4. Le chat en direct (joueur ↔ équipe)

- **Côté joueur** : bulle flottante en bas à droite sur toutes les pages.
  Non connecté → bouton « Se connecter avec Discord ». Connecté → conversation
  persistante identifiée par son ID Discord. Badge point = réponses non lues.
  Rafraîchissement : 2,5 s panneau ouvert, 20 s fermé (quasi temps réel).
- **Côté équipe** : admin → **Chat support** → liste des conversations (badge
  non-lus rouges) → clic → fil → réponse. Le joueur voit la réponse arriver
  en direct sur le site, avec ton **pseudo Discord**.
- Table MySQL : `tfh_support_chat` (auto-créée au premier message ; schéma
  complet dans `api/sql-chat.sql` si tu veux la créer manuellement en cPanel).
- Un mail part vers `support@` **au premier message d'une conversation**
  (les suivants sont signalés par les badges dans l'admin).

---

## 5. L'espace admin (admin.thefronthub.com)

Nouvelle **barre latérale** à 5 catégories :

| Catégorie | Rôle |
|---|---|
| **Tâches** | le tableau kanban de l'équipe (inchangé) |
| **Chat équipe** | discussion interne (inchangée) |
| **Tickets support** | tous les tickets des joueurs : fil, **Répondre** (le joueur reçoit un mail), **Fermer** ; filtre Ouverts/Tous/Fermés + badge d'attente |
| **Chat support** | les conversations en direct avec les joueurs (badge non-lus) |
| **Mails** | la boîte `support@thefronthub.com` (lecture + réponse) — nécessite l'étape 2 |

Mobile (<900px) : la sidebar devient un menu hamburger.

---

## 6. Résumé du circuit d'une demande joueur

```
Joueur                      TheFrontHub                          Équipe (admin)
──────                      ───────────                          ──────────────
Ticket   ──────────────────→ tfh_support_* + mail vers support@ → onglet Tickets → Répondre
                                                          ←──── mail au joueur + fil sur le site
Chat     ──────────────────→ tfh_support_chat + badge admin ──→ onglet Chat support → Réponse en direct
                                                          ←──── bulle du joueur se met à jour (2,5 s)
Email    ── support@ ──────→ boîte IMAP ─────────────────────→ onglet Mails → Répondre (threadé)
```

---

## 7. Réglages utiles / maintenance

- **Changer l'adresse de notification équipe** (tickets) : constante
  `SUPPORT_NOTIFY_EMAIL` en tête de `api/support.php`.
- **Changer l'adresse de notification chat** : constante `CHAT_NOTIFY_EMAIL`
  en tête de `api/chat.php`.
- **Re-diffuser la banderole** avec un nouveau message : éditer `BANNER_TEXT`
  (et/ou `BANNER_ID`) dans `update-banner.js`, puis bump `?v=` du script.
- La banderole **descend la sidebar** sous elle (`html.tfh-ub-open` +
  `--tfh-ub-h`) : le logo est toujours visible, tout revient en place à la
  fermeture. Aucun réglage nécessaire.
