# 🎮 TheFrontHub

> Plateforme de statistiques pour OpenFront.io — leaderboard, classements, profils joueurs, lobby temps réel, atlas des cartes, tournois.

🌐 **Site en production** : [thefronthub.com](https://thefronthub.com)

---

## 📋 Table des matières

- [Architecture](#-architecture)
- [Stack technique](#-stack-technique)
- [Structure du repo](#-structure-du-repo)
- [Déploiement](#-déploiement)
- [Synchronisation automatique](#-synchronisation-automatique)
- [Développement local](#-développement-local)
- [Fonctionnalités](#-fonctionnalités)
- [Sécurité](#-sécurité)
- [Corrections récentes](#-corrections-récentes-2026-08-29)

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Visiteur navigateur                                          │
│   https://thefronthub.com                                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ o2switch (hébergement mutualisé cPanel)                      │
│ Apache + LiteSpeed + PHP                                    │
│ Document root: /home2/mask6607/public_html/thefronthub.com/ │
│                                                              │
│ Sert les fichiers statiques :                               │
│   • HTML/CSS/JS vanilla                                     │
│   • Images, fonts, favicons                                 │
│   • _upload.php (endpoint sync données)                      │
│   • _deploy.php (webhook déploiement — bloqué par WAF)       │
└─────────────────────────────────────────────────────────────┘
        ▲                           ▲
        │                           │
        │ HTTP polling              │ HTTP POST + secret HMAC
        │ (visiteur)                │ (GitHub Actions → upload données)
        │                           │
┌───────┴───────────┐      ┌────────┴────────────────────────────┐
│ Cloudflare Worker │      │ GitHub Actions sync.yml (toutes 5min)│
│ (proxy API)       │      │                                       │
│                   │      │ 1. Récupère données OpenFront via WS │
│ api.openfront.io  │      │    (depuis datacenter GitHub — pas    │
│   + CORS headers  │      │    de souci cross-origin)            │
│   + token Skailex │      │ 2. Décode zbin via lobby-wire.js     │
│                   │      │ 3. Upload vers o2switch via _upload │
└───────────────────┘      └───────────────────────────────────────┘
        ▲
        │
        │ fetch (CORS)
        │
┌───────┴────────────────────────────────────────────────────┐
│ api.openfront.io (API officielle OpenFront)                │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛠 Stack technique

- **Frontend** : HTML/CSS/JS vanilla (pas de framework)
- **Backend** : PHP 8 + MySQL (API `api/`, hébergée sur o2switch)
- **Hébergement** : o2switch (cPanel shared hosting, offre Grow)
- **Domaine** : thefronthub.com (enregistré chez o2switch)
- **SSL** : Let's Encrypt (auto-renouvelé via cPanel AutoSSL)
- **CI/CD** : GitHub Actions
- **Proxy API** : Cloudflare Worker (`openfront-proxy.diofortnite3.workers.dev`)
- **Sync données** : HTTP POST avec secret HMAC SHA-256
- **Déploiement code** : Cron job o2switch (toutes les 5 min) + Webhook GitHub (bloqué par WAF Tiger Protect)
- **Pubs** : Google AdSense (`pub-2991878097014222`)
- **SEO** : robots.txt + sitemap.xml + JSON-LD + Search Console

---

## 📁 Structure du repo

```
TheFrontHub2/
├── index.html              # Leaderboard (page d'accueil)
├── lobby.html              # Lobby (en cours de refonte)
├── dashboard.html         # Tableau de bord
├── atlas.html             # Atlas des cartes
├── tournois.html          # Tournois + classements
├── profile.html           # Profil joueur
├── runs.html              # Speedruns
├── ads.txt                # Google AdSense
├── ads.js + ads.css       # Gestion des pubs
├── robots.txt + sitemap.xml
│
├── _upload.php            # Endpoint sync données (avec secret)
├── _deploy.php            # Webhook déploiement (bloqué par WAF)
├── .htaccess              # Config Apache (HTTPS, cache, GZIP)
├── .user.ini              # Limites PHP (100M upload)
│
├── api/                   # API PHP + MySQL (o2switch) — auth Discord, profils, cosmétiques
│   ├── auth/discord/      # login.php + callback.php (OAuth2 Discord)
│   ├── .htaccess          # Config Apache dédiée API
│   └── *.php              # me, logout, ping, profile, likes, public-aliases, public-rewards, rewards, skins (+ config.php, helpers.php)
│
├── lobby-wire.js          # Décodeur zbin binaire OpenFront
├── styles.css             # Styles globaux
├── lobby.css              # Styles lobby
├── auth.js + auth.css     # Shim de compat API MySQL (remplace Firebase Auth/Firestore)
├── icons.js, i18n.js      # UI helpers
│
├── shared/                # Modules JS partagés (firebase-config.js = vestige Firebase, non chargé par le front racine)
├── atlas-data/            # Images cartes + drapeaux
├── data/                  # Données tournois, calendrier
│
├── deploy.sh              # Déploiement cron git → webroot (rsync + permissions)
├── pull-data.sh           # Télécharge les données JSON depuis la release data-latest
│
├── cloudflare-worker/     # Code du Worker Cloudflare
│   └── openfront-proxy.js
│
├── dist/                  # Bundles *.min.js (esbuild, commités)
│
├── scripts/
│   ├── build.js               # Build esbuild → dist/*.min.js
│   ├── data-release.sh        # Publication des données en release GitHub data-latest
│   └── upload-to-o2switch.sh  # Bash script appelé par GitHub Actions
│
└── .github/workflows/
    └── sync.yml            # 7 jobs parallèles → upload HTTP vers o2switch
```

---

## 🚀 Déploiement

### Code (HTML/CSS/JS)

2 mécanismes en parallèle :

#### 1. Cron job o2switch (toutes les 5 min — RECOMMANDÉ)
Le déploiement du code **ET** des données passe par `deploy.sh` (versionné dans le repo, auto-mis-à-jour, log horodaté — remplace la longue commande historique).

**Commande cron dans cPanel (courte et incassable) :**
```bash
bash /home2/mask6607/thefronthub-src/deploy.sh
```

**Installation initiale (une seule fois, Terminal cPanel) :**
```bash
cd /home2/mask6607/thefronthub-src && git fetch origin main && git reset --hard origin/main
bash /home2/mask6607/thefronthub-src/deploy.sh
```

**Vérification :** `tail -8 /home2/mask6607/logs/deploy.log` → doit montrer `[…] SUCCES deploiement <commit>` à chaque passage du cron.

Ce que fait `deploy.sh` : `git fetch` + `reset --hard origin/main` → `rsync` clone→webroot (mêmes exclusions qu'avant + `deploy.sh` lui-même, jamais servi) → permissions 755/644 → `pull-data.sh` (données JSON, log dédié). Avantages : PATH explicite (le cron cPanel a un PATH minimal, cause n°1 d'échec), échecs **visibles** dans `deploy.log` (l'ancienne commande `--quiet` échouait en silence), garde-fou d'auto-mise-à-jour (exécution depuis une copie figée dans /tmp), corrigeable à distance par simple push git.

> ⚠️ **Historique du cron** :
> - 2026-08-28 : remplacement de la commande monolithique (~1 200 caractères, échecs silencieux) par `deploy.sh`. Le `/.htaccess` est ancré à la racine — protège le `.htaccess` racine **et** `api/.htaccess`, tous deux gérés manuellement sur le serveur.
> - 2026-08-27 : `--exclude='dist'` **retiré** : les 6 pages (index/dashboard/tournois/atlas/profile/auth) chargent `dist/*.min.js` — l'exclusion empêchait tout déploiement de bundle (le fix `lenis.min.js` et les correctifs XSS n'atteignaient jamais la prod). `dist/` ne contient que 15 fichiers `.min.js` (364 Ko), sans risque.
>
> ⚠️ **Rappel** : `.htaccess`, `_upload.php` et `_deploy.php` sont volontairement exclus du rsync — leurs mises à jour doivent être copiées **manuellement** sur le serveur (voir `SECURITE_CORRECTIONS.md` pour la procédure et l'ordre des étapes).

#### 2. Webhook GitHub → `_deploy.php` (BLOQUÉ par Tiger Protect WAF)
Le WAF d'o2switch bloque les POST de GitHub. À débloquer via cPanel → Tiger Protect → Whitelist `/_deploy.php`.

### Données (JSON) — transport par GitHub Release (v3)

> 🔴 **Pourquoi ce changement (audit 2026-08-27)** : le WAF o2switch (Tiger
> Protect / ModSecurity) coupe TOUT POST depuis les IP GitHub Actions / Azure
> — même de 118 octets, même en raw-body (curl error 56) — y compris vers
> `_upload.php`. Résultat : aucune donnée n'atteignait le serveur depuis le
> 26/08, le site retombait sur `runs.json.gz` (16 Mo) à chaque visite
> (chargement 12-14 s au lieu de 164 ms). Le flux est donc INVERSÉ :
> GitHub **publie**, le serveur **télécharge** (GET publics, jamais bloqués).

Workflow GitHub Actions `sync.yml` (toutes les 5 min) :
1. Récupère les données via l'API OpenFront + ses fichiers d'état (depuis la release)
2. Génère les payloads (`runs_public.json.gz` 107 Ko, `lobby_state.json`, etc.)
3. Publie tout en ASSETS de la release publique [`data-latest`](https://github.com/Skailex239/TheFrontHub2/releases/tag/data-latest)
4. Le cron o2switch exécute `pull-data.sh` qui télécharge ces assets dans le webroot (atomique, `runs.json.gz` 16 Mo max 1×/24 h)

Installation serveur : **RIEN à copier** — le script est dans le repo et le cron (commande ci-dessus) l'exécute depuis `/home2/mask6607/thefronthub-src/pull-data.sh` (auto-mis-à-jour par le git reset du cron). Logs : `/home2/mask6607/logs/pull-data.log`.

### Variables d'environnement GitHub Actions

Dans Settings → Secrets → Actions :
- `OPENFRONT_SKAILEX_ACCESS` : token API OpenFront (requis)
- `O2SWITCH_UPLOAD_URL` / `O2SWITCH_UPLOAD_SECRET` : **obsolètes** (le push HTTP est bloqué par le WAF ; conservés pour si Tiger Protect whiteliste un jour `_upload.php`)

---

## 🔄 Synchronisation automatique

### Workflow `sync.yml` (7 jobs en série)

| Job | Rôle | Fichiers publiés (assets release) |
|---|---|---|
| `sync-standard` | Historique complet des parties | `runs_public.json.gz` (payload accueil), `runs.json.gz` (fallback), `seen.json`, `checkpoint.json` |
| `sync-compact` | Version compacte | `runs_compact_public.json.gz`, `runs_compact.json.gz`, `seen_compact.json` |
| `sync-teams` | Stats par équipe | `teams_public.json.gz`, `teams_runs.json`, état teams |
| `sync-ranked` | Classements 1v1/2v2 | `ranked.json`, `ranked_history.json.gz`, `ranked_2v2_history.json.gz` |
| `sync-dashboard` | Scores dashboard | `dashboard_scores.json`, `dashboard_ranking.json` |
| `sync-player-games` | Données par joueur | `player-files.tar.gz` (player-data + player-stats) |
| `sync-lobby-state` | État lobby temps réel | `lobby_state.json` |

Chaque job retire son état du cycle précédent depuis la release au démarrage
(boucle d'état sans commit git — le repo ne gonfle pas).

---

## 💻 Développement local

### Prérequis
- Node.js 20+
- Git

### Lancer en local
```bash
git clone https://github.com/Skailex239/TheFrontHub2.git
cd TheFrontHub2
python3 -m http.server 8000
# Ouvrir http://localhost:8000/lobby.html
```

### Régénérer les bundles (dist/)
Les pages chargent les bundles commités `dist/*.min.js`. Après modification des sources JS, les régénérer (esbuild requis) :
```bash
npm install esbuild
node scripts/build.js
```

### Tester le worker Cloudflare en local
Le worker `cloudflare-worker/openfront-proxy.js` peut être testé avec `wrangler` :
```bash
npm install -g wrangler
cd cloudflare-worker
wrangler dev
```

---

## ✨ Fonctionnalités

### Pages publiques
- 🏠 **Leaderboard** (`/`) — classement FFA, par carte, par joueur
- ⚡ **Lobby** (`/lobby.html`) — parties temps réel (en refonte)
- 📊 **Tableau de bord** (`/dashboard.html`) — classement par points
- 🗺️ **Atlas** (`/atlas.html`) — atlas interactif des cartes
- 🏆 **Tournois** (`/tournois.html`) — circuit compétitif + Power Ranking
- 👤 **Profil** (`/profile.html`) — stats joueur (nécessite connexion)
- 🏃 **Speedruns** (`/runs.html`) — records par carte

### Authentification
- Connexion Discord (OAuth2, API PHP MySQL) — sessions cookie HttpOnly 30 j (jetons hashés SHA-256, tables MySQL `tfh_*`)
- Lier son compte OpenFront via Public ID (immuable après liaison)

---

## 🔒 Sécurité

### Fichiers protégés
- `.htaccess` : force HTTPS + cache + GZIP + bloque fichiers sensibles
- `.user.ini` : limites PHP (100M upload, 5 min timeout)
- `_upload.php` : secret HMAC + whitelist filenames + POST-only
- `_deploy.php` : secret HMAC + signature GitHub + POST-only

### Secrets
- `O2SWITCH_UPLOAD_SECRET` → GitHub Actions + `_upload.php`
- Webhook secret → GitHub + `_deploy.php` (si activé)
- `OPENFRONT_SKAILEX_ACCESS` → token API OpenFront (GitHub Actions)

### WAF o2switch
- Tiger Protect bloque les POST externes (webhook GitHub)
- Solution de contournement : cron job toutes les 5 min

---

## 📞 Liens utiles

| Ressource | URL |
|---|---|
| Site en prod | https://thefronthub.com |
| Repo GitHub | https://github.com/Skailex239/TheFrontHub2 |
| Workflow sync | https://github.com/Skailex239/TheFrontHub2/actions/workflows/sync.yml |
| Secrets GitHub | https://github.com/Skailex239/TheFrontHub2/settings/secrets/actions |
| Cloudflare Worker | https://openfront-proxy.diofortnite3.workers.dev |
| cPanel o2switch | https://mask6607.o2switch.fr/cpanel |
| Google AdSense | https://apps.google.com/adsense (pub-2991878097014222) |
| Google Search Console | https://search.google.com/search-console |

---

## 🩹 Corrections récentes (2026-08-29)

Branche `fix/auto-bugfixes` (commits `5bfef46..e30a556`) :

- **deploy.sh** : `--include data/` + `atlas-data/maps_data.json` — le `--exclude='*.json'` global empêchait le déploiement des JSON du site (rétabli)
- **profile.js** : check d'unicité du Public ID rétabli via `/api/public-aliases.php` (l'ancien code appelait une constante `FIRESTORE_BASE` undefined → check mort avalé par le catch)
- **sync-dashboard.js + detect-new-players.js** : bascule Firestore → API MySQL `public-aliases` (fin de la migration étape 6/8)
- **Untrack des données de sync** (~51 Mo retirés de l'index) : l'état courant vit dans la release [`data-latest`](https://github.com/Skailex239/TheFrontHub2/releases/tag/data-latest)

---

## 📝 Notes

- Les données de sync (`runs.json.gz`, `lobby_state.json`, etc.) ne sont plus commitées — l'état courant est publié dans la release [`data-latest`](https://github.com/Skailex239/TheFrontHub2/releases/tag/data-latest)
- Le repo contient encore ces données dans son historique Git (~51 Mo) — un nettoyage d'historique est prévu (cf. `GUIDE_NETTOYAGE.md`)
- Le `lobby_state.json` est alimenté toutes les 5 min par GitHub Actions
- Le cron o2switch déploie le code toutes les 5 min
- Pubs Google AdSense actives sur toutes les pages sauf `/profile.html`

---

## 📜 Licence

Projet privé — tous droits réservés.
