# GUIDE — Support TheFrontHub : email support@, chat en direct, admin

Tout ce qu'il faut savoir pour exploiter la catégorie **Support**
(page publique) et l'espace **admin** (Tickets, Chat support).

---

## 1. Créer la boîte mail `support@thefronthub.com` (cPanel o2switch)

1. Connecte-toi à ton cPanel o2switch → **Email → Comptes de messagerie (Email Accounts)**.
2. **Créer** :
   - Domaine : `thefronthub.com`
   - Identifiant : `support`
   - Mot de passe : un mot de passe solide (garde-le précieusement, il sert à te connecter au webmail — cf. étape 2)
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

## 2. Consulter la boîte `support@thefronthub.com` (webmail o2switch)

L'onglet « Mails » de l'admin a été **retiré** : la boîte se consulte
directement dans le **webmail o2switch** → https://mail.thefronthub.com
(identifiants = adresse `support@thefronthub.com` + son mot de passe, cf. étape 1).

- Tu y reçois les **notifications** : nouveaux tickets, premiers messages de
  chat, réponses de joueurs — tout part vers `support@`.
- Pour **répondre à un joueur par mail**, réponds depuis le webmail : le message
  part en `From: TheFrontHub Support <support@thefronthub.com>`.
- (Optionnel) Redirection `support@` → ton adresse perso : cPanel → Email →
  **Redirecteurs**, pour recevoir une copie de chaque mail sans ouvrir le webmail.

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

La **barre latérale** à 4 catégories :

| Catégorie | Rôle |
|---|---|
| **Tâches** | le tableau kanban de l'équipe (inchangé) |
| **Chat équipe** | discussion interne (inchangée) |
| **Tickets support** | tous les tickets des joueurs : fil, **Répondre** (le joueur reçoit un mail), **Fermer** ; filtre Ouverts/Tous/Fermés + badge d'attente |
| **Chat support** | les conversations en direct avec les joueurs (badge non-lus) |

> La boîte mail `support@` se consulte hors admin, via le webmail (étape 2).

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
Email    ── support@ ──────→ boîte support@ ────────────────→ webmail o2switch (mail.thefronthub.com)
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
