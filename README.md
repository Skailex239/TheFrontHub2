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
├── lobby-wire.js          # Décodeur zbin binaire OpenFront
├── styles.css             # Styles globaux
├── lobby.css              # Styles lobby
├── auth.js + auth.css     # Auth Google/Discord
├── icons.js, i18n.js      # UI helpers
│
├── shared/                # Modules JS partagés
├── atlas-data/            # Images cartes + drapeaux
├── data/                  # Données tournois, calendrier
│
├── cloudflare-worker/     # Code du Worker Cloudflare
│   └── openfront-proxy.js
│
├── scripts/
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
Commande cron dans cPanel :
```bash
cd /home2/mask6607/thefronthub-src && git fetch origin main --quiet && git reset --hard origin/main --quiet && rsync -a --delete --exclude='.git' --exclude='.htaccess' --exclude='_upload.php' --exclude='_deploy.php' --exclude='_archives' --exclude='*.json' --exclude='*.json.gz' --exclude='player-data' --exclude='player-stats' --exclude='src' --exclude='tests' --exclude='scripts' --exclude='.github' --exclude='.trae' --exclude='.windsurf' --exclude='.zscripts' --exclude='prisma' --exclude='db' --exclude='examples' --exclude='mini-services' --exclude='cloudflare-worker' --exclude='agent-ctx' --exclude='dist' --exclude='public' --exclude='node_modules' --exclude='package.json' --exclude='package-lock.json' --exclude='bun.lock' --exclude='tsconfig.json' --exclude='next.config.ts' --exclude='tailwind.config.ts' --exclude='postcss.config.mjs' --exclude='eslint.config.mjs' ./ /home2/mask6607/public_html/thefronthub.com/ && find /home2/mask6607/public_html/thefronthub.com/ -type d -exec chmod 755 {} \; && find /home2/mask6607/public_html/thefronthub.com/ -type f -exec chmod 644 {} \;
```

#### 2. Webhook GitHub → `_deploy.php` (BLOQUÉ par Tiger Protect WAF)
Le WAF d'o2switch bloque les POST de GitHub. À débloquer via cPanel → Tiger Protect → Whitelist `/_deploy.php`.

### Données (JSON)

Workflow GitHub Actions `sync.yml` (toutes les 5 min) :
1. Récupère les données via WebSocket OpenFront (depuis datacenter GitHub)
2. Décode le binaire zbin via `lobby-wire.js`
3. Upload via `scripts/upload-to-o2switch.sh` → `_upload.php` (HTTP POST + secret HMAC)
4. Stocke sur o2switch dans `public_html/thefronthub.com/`

### Variables d'environnement GitHub Actions

Dans Settings → Secrets → Actions :
- `O2SWITCH_UPLOAD_URL` : `https://thefronthub.com/_upload.php`
- `O2SWITCH_UPLOAD_SECRET` : secret partagé avec `_upload.php`
- `OPENFRONT_SKAILEX_ACCESS` : token API OpenFront

---

## 🔄 Synchronisation automatique

### Workflow `sync.yml` (7 jobs en série)

| Job | Rôle | Fichiers générés |
|---|---|---|
| `sync-standard` | Historique complet des parties | `runs.json.gz` (archive), `seen.json`, `checkpoint.json` |
| `sync-compact` | Version compacte | `runs_compact.json.gz` (archive) |
| `sync-teams` | Stats par équipe | `teams_runs.json`, `teams_seen.json` |
| `sync-ranked` | Classements 1v1/2v2 | `ranked.json` (snapshot), `ranked_history.json.gz` (archive) |
| `sync-dashboard` | Scores dashboard | `dashboard_scores.json` |
| `sync-player-games` | Données par joueur | `player-data/*.json`, `player-stats/*.json` |
| `sync-lobby-state` | État lobby temps réel | `lobby_state.json` |

### Modes de stockage

- **Snapshot** : écrase le fichier à chaque sync (données temps réel)
- **Archive** : sauvegarde horodatée + rotation auto 30 jours (historique)

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
- Connexion Google (Firebase Auth)
- Connexion Discord (Firebase Auth)
- Lier son compte OpenFront via Public ID

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

## 📝 Notes

- Le repo GitHub reste léger (~3 Mo) — les fichiers de données sont stockés sur o2switch, pas dans Git
- Historique Git purgé régulièrement pour éviter l'explosion (les fichiers JSON ne sont plus commités)
- Le `lobby_state.json` est alimenté toutes les 5 min par GitHub Actions
- Le cron o2switch déploie le code toutes les 5 min
- Pubs Google AdSense actives sur toutes les pages sauf `/profile.html`

---

## 📜 Licence

Projet privé — tous droits réservés.
