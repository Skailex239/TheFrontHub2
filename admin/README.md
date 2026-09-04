# Espace admin TheFrontHub — `admin.thefronthub.com`

Espace d'administration réservé : connexion par **Discord uniquement**.
Regroupe **tous** les outils d'administration du site, aujourd'hui :

- **Tâches** — tableau partagé entre admins (à faire / en cours / terminé),
  checklists, discussion par tâche, historique, patch notes, export CSV.
- **Chat** — discussion générale de l'équipe, style Discord (texte, liens,
  images, vidéos, fichiers 6 × 10 Mo conservés 30 jours, non lus, édition).
- *(extensible — les prochains outils admin rejoindront les onglets)*

- Backend : PHP + MySQL (réutilise la config de `api/` — secrets hors webroot,
  sessions `tfh_sessions`, comptes `tfh_users`).
- Front : HTML/CSS/JS statique dans `assets/` (aucun build).
- Accès autorisé si : le compte Discord a le rôle `admin` sur le site
  **ou** figure dans la whitelist (`tfh_task_admins`).
- Le **premier compte à se connecter** devient **propriétaire**.

## Installation (une seule fois)

1. **Sous-domaine (cPanel o2switch)** — Domaines → *Créer un nouveau domaine* :
   - Sous-domaine : `admin.thefronthub.com`
   - Racine du document : `public_html/thefronthub.com/admin`
   - Le DNS et le certificat AutoSSL sont provisionnés automatiquement
     (quelques minutes à quelques heures).
2. **Portail Discord** — <https://discord.com/developers/applications> →
   l'application utilisée par le site → *OAuth2* → *Redirects* → ajouter :
   - `https://admin.thefronthub.com/auth/callback.php` (principal)
   - garder `https://task.thefronthub.com/auth/callback.php` pendant la
     transition → *Save Changes*.
3. **Première connexion** — ouvrir `https://admin.thefronthub.com` →
   *Se connecter avec Discord*.
4. **Ajouter d'autres admins** — bouton *Administrateurs* → coller l'ID
   Discord de la personne (15–21 chiffres). La personne trouve son ID sur
   l'écran « Accès refusé » (bouton *Copier*).

> **Ancienne adresse** : `task.thefronthub.com` et `thefronthub.com/task/`
> redirigent désormais (301) vers `admin.thefronthub.com` via le stub `task/`
> du repo. Même base de données : rien n'est perdu, aucune reconnexion à
> refaire côté données (la session cookie, elle, est liée à l'hôte — il faut
> se reconnecter une fois sur le nouveau domaine).

## Fichiers

| Fichier             | Rôle                                                        |
| ------------------- | ----------------------------------------------------------- |
| `index.php`         | Page unique (connexion / refusé / onglets Tâches + Chat)     |
| `api.php`           | API JSON (état, CRUD tâches, chat, gestion whitelist)        |
| `auth/login.php`    | Démarre l'OAuth Discord                                      |
| `auth/callback.php` | Reçoit le retour Discord, contrôle l'accès, ouvre la session |
| `logout.php`        | Ferme la session                                             |
| `lib.php`           | Config partagée + droits + CSRF + écrans communs             |
| `file.php`          | Sert les pièces jointes du chat (session requise)            |
| `install.sql`       | Création manuelle des tables (uniquement si DDL refusé)      |
| `assets/`           | CSS / JS (`app.js` tâches, `chat.js` chat) / logo            |

## Notes techniques

- Tables MySQL dédiées : `tfh_task_admins`, `tfh_task_tasks`, `tfh_task_chat`
  (créées automatiquement au premier chargement si le compte MySQL le permet).
  Le **chat général** vit dans `tfh_task_chat` avec `task_id = 0` — aucune
  nouvelle table nécessaire.
- CSRF : double-submit cookie (`tfh_task_csrf`) + vérification `Sec-Fetch-Site`.
- Déploiement : le cron o2switch rsync ce dossier toutes les 5 min
  (aucune donnée n'est écrite dans le dossier : tout vit en MySQL).
- Sécurité : pages `noindex`, sessions cookie `Secure`/`HttpOnly`/`SameSite=Lax`,
  en-têtes `X-Frame-Options: DENY`, validation stricte des entrées.
