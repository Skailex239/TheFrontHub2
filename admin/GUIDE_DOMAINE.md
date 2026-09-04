# Guide — Passer de `task.thefronthub.com` à `admin.thefronthub.com`

> ⏱️ **10 minutes au total.** Aucune donnée ne bouge (même base MySQL, mêmes
> tâches, mêmes admins) — on ne fait que déclarer la nouvelle adresse.

## Étape 1 — Créer le sous-domaine (cPanel, ~2 min)

1. Connecte-toi à **cPanel o2switch** → **Domaines** (ou *Sous-domaines*).
2. *Créer un nouveau domaine* :
   - **Sous-domaine** : `admin`
   - **Domaine** : `thefronthub.com`
   - **Racine du document** : `public_html/thefronthub.com/admin`
     ⚠️ c'est bien le dossier `admin` (le nouveau), pas `task`.
3. Valide. Le DNS est immédiat (même serveur) ; le certificat **AutoSSL**
   arrive en quelques minutes à quelques heures.

## Étape 2 — Autoriser la connexion Discord (~1 min)

1. Ouvre <https://discord.com/developers/applications> → ton application.
2. Menu **OAuth2** → section **Redirects** → *Add Redirect* :
   - `https://admin.thefronthub.com/auth/callback.php`
3. **Garde** l'ancienne URL `https://task.thefronthub.com/auth/callback.php`
   pendant la transition (tu pourras la retirer plus tard).
4. **Save Changes**.

## Étape 3 — Tester (~1 min)

1. Ouvre **https://admin.thefronthub.com** → *Se connecter avec Discord*.
2. Tu retrouves **toutes tes tâches** (même base de données).
3. En haut : deux onglets — **📋 Tâches** et **💬 Chat**. Le chat général
   fonctionne dès le premier message.
4. (Re)connecte-toi une fois : la session est liée au domaine, c'est normal.

## Ce qui se passe pour l'ancienne adresse

- `task.thefronthub.com` et `thefronthub.com/task/` **redirigent
  automatiquement (301)** vers `admin.thefronthub.com` — c'est déjà en place
  dans le repo (dossier `task/` réduit à un stub de redirection).
- Quand tu veux, tu peux **supprimer le sous-domaine** `task` dans cPanel :
  la redirection `thefronthub.com/task/` continuera de fonctionner.
- Retire l'URL `task…` des Redirects Discord quand tu veux aussi (étape 2).

## Ajouter un futur outil dans l'espace admin

Tout est prévu pour empiler : chaque nouvel outil devient un onglet
(`index.php` → nouveau bouton dans `nav.view-tabs` + une vue `#view-…`),
avec son fichier JS dans `assets/` et ses actions dans `api.php`.
Les sections existantes (Tâches, Chat) sont des exemples du pattern.

## Résumé des URLs

| URL                                        | Statut                                    |
| ------------------------------------------ | ----------------------------------------- |
| `https://admin.thefronthub.com`            | ✅ nouvel espace admin (après étapes 1-2) |
| `https://thefronthub.com/admin/`           | ✅ même app par chemin (secours)          |
| `https://task.thefronthub.com`             | ↪️ redirection 301 vers admin             |
| `https://thefronthub.com/task/`            | ↪️ redirection 301 vers admin             |
