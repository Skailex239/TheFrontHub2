# TheFrontHub — Guide de finition & versions de test
> Dernière mise à jour : session « site fini + bilingue FR/EN »

---

## 1. Ce qui vient d'être fait (récapitulatif)

| # | Élément | Détail |
|---|---------|--------|
| 1 | **Zoom Atlas corrigé** | Lenis (scroll-smooth) scollait la page pendant le zoom molette. Fix : `data-lenis-prevent-wheel` sur la carte du monde + la modale détail, listener molette remonté au bloc carte entier. Testé : la page ne bouge plus. |
| 2 | **Crédit minhkarl** | Footer du Lobby : « Lobby inspiré du projet minhkarl.github.io » + badge GitHub (lien https://github.com/minhkarl). |
| 3 | **Cartes Lobby agrandies** | 224→276px (desktop), miniatures 112→140px, textes plus grands, hover avec surélévation. Mobile/tablette agrandies aussi. |
| 4 | **Publicités retirées** | `ads.js` : interrupteur global `ADS_ENABLED = false` → plus aucun cadre « Publicité » vide qui clignote au chargement. Quand tu auras de vraies pubs : `true` + l'anti-flash CSS n'affichera un slot QUE quand une vraie annonce est servie. |
| 5 | **Site bilingue FR/EN complet** | Voir détail ci-dessous. |

### 5. Le bilinguisme (comment ça marche)

- **Drapeaux FR/EN** dans la sidebar de toutes les pages (desktop : bloc « Langue » ; mobile : drapeaux compacts dans la barre du bas).
- **À l'inscription** (après connexion Discord) : le formulaire « Finaliser votre profil » demande **la langue (2 drapeaux)** + pseudo OpenFront + Public ID. La vérification de propriété (code en jeu) est inchangée.
- **Dans le compte** : panneau « Langue » sur la page Profil (modifiable à tout moment).
- **Stockage** : le choix est enregistré **en base MySQL** (`tfh_users.language`) via `/api/language.php` **et** en local (localStorage). Sur un nouvel appareil, la langue du compte s'applique automatiquement.
- **Couverture** : les 8 pages (Accueil/Speedruns/Classé, Tableau de bord, Lobby, Atlas, Tournois, Profil, Support, Runs) + widgets globaux (bandeau d'annonce, tutoriel d'accueil, chat flottant, modale de connexion) + menus/footers. Vérifié écran par écran en FR et EN, desktop et mobile : **aucun texte FR restant en mode EN**.
- Architecture : `i18n.js` (moteur + clés communes) + `i18n-dict-<page>.js` (un dictionnaire par page) + `i18n-dict-widgets.js` (widgets globaux) + `lang-switcher.js` (drapeaux). Build : `node scripts/build.js`.

---

## 2. Mise en production — ÉTAPES À FAIRE (dans l'ordre)

### Étape A — Base de données (2 minutes, obligatoire)
1. cPanel o2switch → **phpMyAdmin** → base `mask6607_thefronthub` → onglet **SQL**.
2. Colle le contenu de **`api/sql-language.sql`** et exécute :
   ```sql
   ALTER TABLE tfh_users
     ADD COLUMN IF NOT EXISTS language VARCHAR(5) NOT NULL DEFAULT 'fr'
     AFTER locale;
   ```
   (Si MySQL refuse `IF NOT EXISTS` sur ta version : `ALTER TABLE tfh_users ADD COLUMN language VARCHAR(5) NOT NULL DEFAULT 'fr' AFTER locale;` — si l'erreur dit que la colonne existe déjà, c'est bon, passe à la suite.)
3. Vérification : table `tfh_users` → nouvelle colonne `language` avec `fr` partout.

### Étape B — Déployer le code
```bash
# En local (ta machine) :
git add -A && git commit -m "Site bilingue FR/EN + fix zoom atlas + cartes lobby + credit minhkarl + pubs off" && git push
# Sur le serveur (cPanel Terminal) :
cd ~/thefronthub-src && git pull
# → le cron rsync pousse vers public_html sous ~5 minutes
```
Le fichier `mail-config.php` (gitignored) reste en place — non affecté.

### Étape C — Vérifier en ligne (5 minutes)
1. Ouvre https://thefronthub.com → vide le cache si besoin (Ctrl+Shift+R) → **les drapeaux apparaissent dans la sidebar**.
2. Clique le drapeau EN → toute la page passe en anglais (elle recharge : normal).
3. Clique le drapeau FR → retour au français.
4. Connecte-toi avec Discord → le formulaire propose **Langue + pseudo + Public ID**.
5. Atlas : zoome à la molette → **la page ne bouge plus**.
6. Lobby : cartes plus grandes + crédit minhkarl en bas.
7. Aucun cadre « Publicité » n'apparaît sur aucune page.
8. (Optionnel) En phpMyAdmin : `SELECT id, username, language FROM tfh_users WHERE id = <ton id>;` → la langue choisie est bien enregistrée.

---

## 3. Checklist « finition » — ce qu'il reste avant le grand lancement

### Bloquant Google Ads (à faire en premier si tu veux les pubs un jour)
- [ ] **Pages légales** : Mentions légales + **Politique de confidentialité** (OBLIGATOIRE pour Google Ads/AdSense) + Conditions d'utilisation. 3 pages statiques simples suffisent (`legal.html` / `privacy.html` / `terms.html`) + liens dans le footer.
- [ ] Page « À propos » (qui fait le site, contact).
- [ ] Ensuite seulement : retour dans la console Google Ads pour redemander l'examen.

### Solidité / SEO
- [ ] Baliser les guides/textes d'accompagnement (l'idée des pages de contenu de la liste précédente — les profils EN/FR indexables, guides, glossaire).
- [ ] Vérifier `robots.txt` et `sitemap.xml` (ils existent — y ajouter les futures pages légales).
- [ ] Changer le **mot de passe du mail support** (il est passé en clair dans une conversation ; passe par cPanel → Email Accounts → mot de passe) puis mettre à jour `~/thefronthub-src/api/mail-config.php` si tu le gardes.

### Divers constatés en passant
- [ ] `sw.js` : pense à bump la version du Service Worker (`?v=`) ou à incrémenter `CACHE_NAME` au prochain déploiement, sinon les visiteurs peuvent garder l'ancien site en cache quelques minutes.
- [ ] Tutoriel : il y a un vieux sélecteur cassé dans `tutorial.js` (`.nav-itemref` au lieu de `.nav-item ref`) — pré-existant, volontairement non corrigé pour ne rien casser à la dernière minute. À corriger dans une bêta.
- [ ] Les `<title>` et meta descriptions des pages restent en français (SEO FR). Si tu veux un SEO bilingue, ce sera : `<html lang>` déjà dynamique ✓ + `<title>`/`og:` localisés (grosse décision SEO, à faire tranquillement plus tard).

---

## 4. Version de test (bêta) — `dev.thefronthub.com`

### Pourquoi un sous-domaine (et pas un dossier)
Le site appelle l'API avec des chemins absolus (`/api/...`). Un dossier `thefronthub.com/dev` casserait tous les appels (ils iraient sur le site principal). Un **sous-domaine avec sa propre racine** = zéro conflit, et la prod reste intacte pendant que tu testes.

### Mise en place (une seule fois, ~20 minutes)

1. **Sous-domaine** : cPanel → **Domaines → Create A New Domain** → `dev.thefronthub.com`
   - Document Root : `/home/USER/dev.thefronthub.com` (proposition automatique, garde-la).
2. **Clone de la branche de dev** (cPanel Terminal) :
   ```bash
   cd ~
   git clone -b dev git@github.com:Skailex239/TheFrontHub2.git thefronthub-dev
   # puis on sert ce dossier :
   ln -s ~/thefronthub-dev ~/dev.thefronthub.com   # si le docroot le permet
   # sinon : rsync -a --delete ~/thefronthub-dev/ ~/dev.thefronthub.com/ après chaque pull
   ```
3. **Cron de déploiement dev** (cPanel → Cron Jobs) — synchronise le sous-domaine toutes les 10 min, INDÉPENDANT du cron prod :
   ```
   */10 * * * * cd ~/thefronthub-dev && git pull --rebase >/dev/null 2>&1 && rsync -a --delete --exclude '.git' ~/thefronthub-dev/ ~/dev.thefronthub.com/ >/dev/null 2>&1
   ```
   → Tes deux environnements sont totalement séparés : `~/thefronthub-src` → prod, `~/thefronthub-dev` → bêta. Les synchros de données (GitHub Actions) poussent sur `main`, donc la bêta les reçoit quand tu merge — aucune interférence.
4. **Connexion Discord sur dev** : Discord Developer Portal → ton application → **OAuth2 → Redirects** → ajoute aussi :
   `https://dev.thefronthub.com/api/auth/discord/callback.php`
   (sinon le login sur dev renverra une erreur de redirect.)
5. **Empêcher Google d'indexer la bêta** : dans `~/thefronthub-dev/robots.txt` remplace le contenu par :
   ```
   User-agent: *
   Disallow: /
   ```
   (fichier divergent sur le serveur uniquement — le `git pull` le réécrira : pour le figer, `git update-index --skip-worktree robots.txt` sur le clone dev.)
6. **Base de données** (choix) :
   - **Simple (recommandé pour commencer)** : la bêta utilise la même base — acceptable car les écritures bêta sont bénignes (tickets, favoris, langue).
   - **Propre (plus tard)** : crée `mask6607_thefronthub_dev` dans phpMyAdmin, importe les mêmes `api/sql-*.sql`, puis sur le CLONE DEV uniquement : modifie `api/config.php` (nom de la base) et fige-le avec `git update-index --skip-worktree api/config.php`.

### Workflow de test (au quotidien)
```bash
# 1. Tu développes une fonctionnalité sur la branche dev
git checkout dev
# ... modifications ...
git add -A && git commit -m "beta: ma nouvelle feature" && git push origin dev
# 2. Le cron serveur déploie sur dev.thefronthub.com sous 10 min
#    (ou immédiat : cPanel Terminal → cd ~/thefronthub-dev && git pull)
# 3. Tu testes sur https://dev.thefronthub.com
# 4. Validé ? Tu merges en prod :
git checkout main && git merge dev && git push origin main
# 5. Serveur : cd ~/thefronthub-src && git pull
#    → le cron prod pousse vers public_html sous ~5 min
```

### Alternatives au sous-domaine (si tu ne veux pas le créer)
- **Test local avant push** : `python3 -m http.server` sur le dossier du site → test navigateur rapide (mais pas de PHP → pas de login/tickets). Déjà utilisé pendant cette session pour valider la traduction.
- **Prévisualisation GitHub** : pas applicable à du PHP (GitHub Pages n'exécute pas PHP).

---

## 5. Fichiers ajoutés/modifiés de cette session (référence)

**Nouveaux** : `lang-switcher.js`, `i18n-dict-{home,dashboard,lobby,atlas,tournois,profile,support,runs,widgets}.js`, `api/language.php`, `api/sql-language.sql`
**Modifiés** : `i18n.js`, `auth.js`, `ads.js`, `ads.css`, `atlas.js`, `atlas.html`, `lobby.html`, `lobby.css`, `lobby.js`, `index.html`, `app.js`, `dashboard.html/js`, `tournois.html/js`, `profile.html/js`, `support.html/js`, `runs.html/js`, `chat-widget.js`, `update-banner.js`, `tutorial.js`, `styles.css`, `api/me.php`, `scripts/build.js` + tout `dist/` (rebuildé).
