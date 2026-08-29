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
│ Apache + LiteSpeed + PHP 8                                   │
│ Document root: /home2/mask6607/public_html/thefronthub.com/ │
│                                                              │
│ Sert :                                                       │
│   • HTML/CSS/JS vanilla (+ dist/*.min.js, build esbuild)    │
│   • Images, fonts, favicons                                  │
│   • api/*.php (auth Discord, profils, skins, likes, proxy)  │
│                                                              │
│ Cron (toutes les 5 min) :                                    │
│   1. deploy.sh    → git fetch + rsync clone → webroot        │
│   2. pull-data.sh → télécharge les données depuis la         │
│      release GitHub « data-latest » (GET, jamais bloqués)    │
└─────────────────────────────────────────────────────────────┘
        ▲                           ▲
        │ fetch (CORS)              │ publication (assets release)
        │                           │
┌───────┴───────────┐      ┌────────┴────────────────────────────┐
│ Proxies OpenFront │      │ GitHub Actions sync.yml (toutes 5min)│
│                   │      │                                       │
│ 1. Cloudflare     │      │ 1. Appelle api.openfront.io (avec     │
│    Worker (main)  │      │    header x-skailex-access)           │
│ 2. api/openfront- │      │ 2. Génère les payloads JSON           │
│    proxy.php      │      │ 3. Publie en assets de la release     │
│    (secours,      │      │    « data-latest »                    │
│    same-origin)   │      │    → le repo ne stocke AUCUNE donnée  │
│ 3. CORS publics   │      └───────────────────────────────────────┘
└───────────────────┘
        ▲
        │
        │ fetch (CORS)
        │
┌───────┴────────────────────────────────────────────────────┐
│ api.openfront.io (API officielle OpenFront)                │
└─────────────────────────────────────────────────────────────┘
```

**Cascade des proxies OpenFront côté navigateur** (`openfront-client.js`) :
1. `/api/openfront/...` — proxy Next.js (dev uniquement)
2. Cloudflare Worker — proxy principal en prod (injecte `x-skailex-access`)
3. `/api/openfront-proxy.php?path=...` — **secours same-origin o2switch** (réduit le SPOF Worker ; whitelist stricte des chemins publics)
4. Proxies CORS publics (codetabs, allorigins, thingproxy)

---

## 🛠 Stack technique

- **Frontend** : HTML/CSS/JS vanilla, bundles esbuild (`npm run build` → `dist/*.min.js`)
- **Versionnement cache** : **automatique** — `scripts/build.js` réécrit les `?v=` des HTML et les `CACHE_NAME` du Service Worker à partir de hash du contenu (plus de bump manuel)
- **Backend** : PHP 8 + MySQL (o2switch) — voir `api/` (sessions, OAuth Discord, skins, likes, récompenses)
- **Auth** : Discord OAuth2 côté PHP (`api/auth/discord/`) ; `auth.js` est une couche de compatibilité qui émule l'API Firebase au-dessus de `/api/*.php` (migration Firestore → MySQL terminée)
- **Hébergement** : o2switch (cPanel shared hosting)
- **CI/CD** : GitHub Actions (`sync.yml` données, `deploy-pages.yml` miroir Pages) + cron o2switch (code)
- **Pubs** : Google AdSense (`pub-2991878097014222`)
- **SEO** : robots.txt + sitemap.xml + JSON-LD + Search Console

---

## 📁 Structure du repo

```
TheFrontHub2/
├── index.html              # Leaderboard (page d'accueil)
├── lobby.html              # Lobby temps réel
├── dashboard.html          # Tableau de bord (classement par points)
├── atlas.html              # Atlas des cartes
├── tournois.html           # Tournois + Power Ranking
├── profile.html            # Profil joueur
├── runs.html               # Speedruns
│
├── app.js, profile.js, dashboard.js, lobby.js, atlas.js, tournois.js, runs.js
├── auth.js                 # Couche compat MySQL (émule l'API Firebase)
├── auth-ui.js, reward-codes.js, skins.js, i18n.js, icons.js, toast.js,
│   animations.js, lenis.js, lobby-wire.js (décodeur zbin), tutorial.js
├── openfront-client.js     # Cascade de proxies API OpenFront
├── openfront-api.js        # Client API OpenFront (scripts sync Node)
├── openfront-parse.js, shared/
│
├── dist/                   # Bundles minifiés (commités — Pages et o2switch
│                           #   n'exécutent pas de build ; run `npm run build`)
│
├── atlas-data/             # Images cartes + drapeaux
├── data/                   # Données manuelles : scoring.config.json, players.json,
│   └── tournaments/        #   calendrier, fichiers de tournois
│
├── api/                    # Backend PHP (MySQL o2switch)
│   ├── config.php, helpers.php
│   ├── me.php, profile.php, logout.php, ping.php
│   ├── skins.php, likes.php, rewards.php, public-rewards.php, public-aliases.php
│   ├── openfront-proxy.php # Proxy de secours OpenFront (same-origin)
│   ├── auth/discord/       # OAuth2 Discord (login + callback)
│   └── sql-*.sql           # Migrations SQL
│
├── sync.js, sync-teams.js, sync-ranked.js, sync-dashboard.js,      # Scripts sync
│   sync-player-games.js, compute-player-stats.js, sync-lobby-state.js,
│   detect-new-players.js, generate-code.js                          # (tous ESM)
│
├── sw.js                   # Service Worker (v8 — SWR, cache auto-versionné)
├── deploy.sh               # Script cron o2switch : git → webroot (rsync)
├── pull-data.sh            # Script cron o2switch : release → webroot (données)
├── scripts/                # build.js (esbuild + auto-versionnement), data-release.sh
├── cloudflare-worker/      # Code du Worker Cloudflare (proxy HTTP + WS)
├── package.json            # UNIFIÉ : build (esbuild) + deps sync (node-fetch, ws)
└── .github/workflows/
    ├── sync.yml            # 7 jobs en série → release data-latest
    └── deploy-pages.yml    # Miroir GitHub Pages (rsync sécurisé)
```

---

## 🚀 Déploiement

### Code (HTML/CSS/JS)

Le déploiement passe par `deploy.sh` (versionné dans le repo, auto-mis-à-jour, log horodaté).

**Commande cron dans cPanel :**
```bash
bash /home2/mask6607/thefronthub-src/deploy.sh
```

**Installation initiale (une seule fois, Terminal cPanel) :**
```bash
cd /home2/mask6607/thefronthub-src && git fetch origin main && git reset --hard origin/main
bash /home2/mask6607/thefronthub-src/deploy.sh
```

**Vérification :** `tail -8 /home2/mask6607/logs/deploy.log` → doit montrer `[…] SUCCES deploiement <commit>` à chaque passage du cron.

Ce que fait `deploy.sh` : `git fetch` + `reset --hard origin/main` → `rsync` clone→webroot (exclut `src/`, `scripts/`, `.github/`, `*.json` de données, guides, etc.) → permissions 755/644 → `pull-data.sh`.

> ⚠️ **Rappel** : `.htaccess`, `_upload.php` et `_deploy.php` sont volontairement exclus du rsync — leurs mises à jour doivent être copiées **manuellement** sur le serveur.

> 📝 **Avant chaque push** : lancer `npm run build` (les bundles `dist/` sont commités ; le build recalcule aussi les `?v=` et le cache du SW automatiquement).

### Données (JSON) — transport par GitHub Release (v3)

> 🔴 **Pourquoi (audit 2026-08-27)** : le WAF o2switch (Tiger Protect / ModSecurity) coupe tout POST depuis les IP GitHub/Azure. Le flux est donc INVERSÉ : GitHub **publie**, le serveur **télécharge** (GET publics, jamais bloqués).

Workflow GitHub Actions `sync.yml` (toutes les 5 min) :
1. Récupère les données via l'API OpenFront + ses fichiers d'état (depuis la release)
2. Génère les payloads (`runs_public.json.gz`, `lobby_state.json`, etc.)
3. Publie tout en ASSETS de la release publique [`data-latest`](https://github.com/Skailex239/TheFrontHub2/releases/tag/data-latest)
4. Le cron o2switch exécute `pull-data.sh` qui télécharge ces assets dans le webroot (téléchargements atomiques, flock, `runs.json.gz` max 1×/24 h)

### Variables d'environnement GitHub Actions

Dans Settings → Secrets → Actions :
- `OPENFRONT_SKAILEX_ACCESS` : token API OpenFront (requis)

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

Chaque job retire son état du cycle précédent depuis la release au démarrage (boucle d'état sans commit git — le repo ne gonfle pas). Les joueurs suivis proviennent de `data/players.json` (circuit), du classement ranked, et des comptes connectés via **l'API MySQL** (`/api/public-aliases.php`).

---

## 💻 Développement local

### Prérequis
- Node.js 20+
- Git

### Lancer en local
```bash
git clone https://github.com/Skailex239/TheFrontHub2.git
cd TheFrontHub2
npm install
npm run build        # génère dist/ + met à jour les ?v= et le cache du SW
npm run dev          # node server.js — serveur de dev (port 3000)
```

> Les données JSON (`runs_public.json.gz`, `ranked.json`…) ne sont pas dans Git :
> les récupérer via `./scripts/data-release.sh pull <fichiers>` si besoin.

### Tester le worker Cloudflare en local
```bash
npm install -g wrangler
cd cloudflare-worker
wrangler dev
```

---

## ✨ Fonctionnalités

### Pages publiques
- 🏠 **Leaderboard** (`/`) — classement FFA, par carte, par joueur
- ⚡ **Lobby** (`/lobby.html`) — parties temps réel (WebSocket zbin)
- 📊 **Tableau de bord** (`/dashboard.html`) — classement par points (all-time + hebdo)
- 🗺️ **Atlas** (`/atlas.html`) — atlas interactif des cartes
- 🏆 **Tournois** (`/tournois.html`) — circuit compétitif + Power Ranking
- 👤 **Profil** (`/profile.html`) — stats joueur (nécessite connexion)
- 🏃 **Speedruns** (`/runs.html`) — records par carte

### Authentification
- Connexion Discord (OAuth2 PHP — `api/auth/discord/`)
- Lier son compte OpenFront via Public ID (challenge de vérification)
- ~~Connexion Google (Firebase)~~ désactivée (migration MySQL)

---

## 🔒 Sécurité

### Fichiers protégés
- `.htaccess` : force HTTPS + cache + compression brotli/gzip + bloque dossiers/scripts internes
- `api/.htaccess` : durcissement du dossier API (deny config/helpers, deny data)
- `_upload.php` / `_deploy.php` : secret HMAC, POST-only, **exclus du rsync** (copies serveur gérées manuellement)
- `api/openfront-proxy.php` : GET-only, whitelist stricte des chemins publics, rate-limit SQL, pas de CORS

### Secrets
- `OPENFRONT_SKAILEX_ACCESS` → GitHub Actions + Worker Cloudflare + (`openfront_access` dans `~/.tfs_secrets/tfh-secrets.json` pour le proxy PHP — optionnel)
- Secrets Discord/MySQL → `~/.tfs_secrets/tfh-secrets.json` (hors webroot)
- Webhook secret → GitHub + `_deploy.php` (si activé)

### WAF o2switch
- Tiger Protect bloque les POST externes (webhook GitHub) → solution : cron toutes les 5 min + release GitHub

---

## 📞 Liens utiles

| Ressource | URL |
|---|---|
| Site en prod | https://thefronthub.com |
| Repo GitHub | https://github.com/Skailex239/TheFrontHub2 |
| Workflow sync | https://github.com/Skailex239/TheFrontHub2/actions/workflows/sync.yml |
| Release données | https://github.com/Skailex239/TheFrontHub2/releases/tag/data-latest |
| Cloudflare Worker | https://openfront-proxy.diofortnite3.workers.dev |
| cPanel o2switch | https://mask6607.o2switch.fr/cpanel |
| Google AdSense | https://apps.google.com/adsense (pub-2991878097014222) |

---

## 📝 Notes

- **Migration Firestore → MySQL terminée** : `auth.js` (couche compat), `sync-dashboard.js`, `detect-new-players.js` (API `public-aliases.php`), `generate-code.js` (générateur SQL `tfh_reward_codes`). Firebase ne sert plus qu'aux comptes legacy historiques.
- **Repo léger** : les données de sync vivent dans la release `data-latest`, plus dans Git. Un seul commit d'historique (le gros historique peut être purgé via `git filter-repo` si besoin — voir `GUIDE_NETTOYAGE.md`).
- Le cron o2switch déploie le code toutes les 5 min ; les données suivent via `pull-data.sh`.
- Pubs Google AdSense actives sur toutes les pages sauf `/profile.html`.

---

## 📜 Licence

Projet privé — tous droits réservés.
