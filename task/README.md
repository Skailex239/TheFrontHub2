# Panel de tâches TheFrontHub — `task.thefronthub.com`

Espace d'administration réservé : connexion par **Discord uniquement**,
tableau des tâches partagé entre admins (à faire / en cours / terminé),
liste des comptes autorisés gérée depuis l'interface.

- Backend : PHP + MySQL (réutilise la config de `api/` — secrets hors webroot,
  sessions `tfh_sessions`, comptes `tfh_users`).
- Front : HTML/CSS/JS statique dans `assets/` (aucun build).
- Accès autorisé si : le compte Discord a le rôle `admin` sur le site
  **ou** figure dans la whitelist du panel (`tfh_task_admins`).
- Le **premier compte à se connecter** devient **propriétaire** du panel.

## Installation (une seule fois)

1. **Sous-domaine (cPanel o2switch)** — Domaines → *Créer un nouveau domaine* :
   - Sous-domaine : `task.thefronthub.com`
   - Racine du document : `public_html/thefronthub.com/task`
   - Le DNS et le certificat AutoSSL sont provisionnés automatiquement
     (quelques minutes à quelques heures).
2. **Portail Discord** — <https://discord.com/developers/applications> →
   l'application utilisée par le site → *OAuth2* → *Redirects* → ajouter :
   - `https://task.thefronthub.com/auth/callback.php` (principal)
   - `https://thefronthub.com/task/auth/callback.php` (secours) → *Save Changes*.
3. **Première connexion** — ouvrir `https://task.thefronthub.com` →
   *Se connecter avec Discord* → le compte devient propriétaire.
4. **Ajouter d'autres admins** — bouton *Administrateurs* du panel →
   coller l'ID Discord de la personne (15–21 chiffres). La personne trouve
   son ID sur l'écran « Accès refusé » du panel (bouton *Copier*).

Tant que le sous-domaine n'existe pas, le panel répond déjà sur
`https://thefronthub.com/task/` (même code, même base).

## Fichiers

| Fichier             | Rôle                                                        |
| ------------------- | ----------------------------------------------------------- |
| `index.php`         | Page unique (connexion / refusé / tableau)                   |
| `api.php`           | API JSON (état, CRUD tâches, gestion whitelist)              |
| `auth/login.php`    | Démarre l'OAuth Discord du panel                             |
| `auth/callback.php` | Reçoit le retour Discord, contrôle l'accès, ouvre la session |
| `logout.php`        | Ferme la session                                             |
| `lib.php`           | Config partagée + droits + CSRF + écrans communs             |
| `install.sql`       | Création manuelle des tables (uniquement si DDL refusé)      |
| `assets/`           | CSS / JS / logo (versionnés par `?v=` dans le code)          |

## Notes techniques

- Tables MySQL dédiées : `tfh_task_admins`, `tfh_task_tasks` (créées
  automatiquement au premier chargement si le compte MySQL le permet).
- CSRF : double-submit cookie (`tfh_task_csrf`) + vérification `Sec-Fetch-Site`.
- Déploiement : le cron o2switch rsync ce dossier toutes les 5 min
  (aucune donnée n'est écrite dans le dossier : tout vit en MySQL).
- Sécurité : pages `noindex`, sessions cookie `Secure`/`HttpOnly`/`SameSite=Lax`,
  en-têtes `X-Frame-Options: DENY`, validation stricte des entrées.
