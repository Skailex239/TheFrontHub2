# 🚀 Guide complet o2switch — TheFrontHub.com

Guide détaillé pour héberger `thefronthub.com` sur o2switch avec **sync automatique depuis GitHub vers o2switch** (sans polluer le repo GitHub).

> **Architecture finale** :
> - **Site (HTML/CSS/JS)** → o2switch
> - **Données temps réel (snapshots)** → uploadées depuis GitHub Actions vers o2switch via HTTP
> - **Données historique (archives)** → uploadées + rotation 30 jours sur o2switch
> - **Repo GitHub** → reste léger (code seul, ~3 Mo au lieu de ~45 Mo)
> - **Worker Cloudflare** → proxy API OpenFront + (essaie) WS lobby

---

## 📋 Prérequis

- ✅ Abonnement o2switch actif (Grow minimum)
- ✅ Domaine `thefronthub.com` enregistré (o2switch ou ailleurs)
- ✅ Repo GitHub `Skailex239/TheFrontHub2` à jour
- ✅ Worker Cloudflare déployé (`openfront-proxy.diofortnite3.workers.dev`) ✅ déjà fait

---

## 🎯 Vue d'ensemble du système de sync

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub Actions (toutes les 5 min)                            │
│                                                               │
│   sync.yml génère les fichiers en local :                    │
│   • lobby_state.json (snapshot)                              │
│   • runs.json.gz (archive)                                    │
│   • ranked.json (snapshot)                                    │
│   • player-data/*.json (snapshot)                            │
│   • ...                                                       │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ HTTP POST (curl + secret HMAC)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ o2switch — https://thefronthub.com/_upload.php              │
│                                                               │
│   Mode "snapshot" :                                          │
│     écrase lobby_state.json                                  │
│     écrase ranked.json                                       │
│     écrase player-data/*.json                                │
│                                                               │
│   Mode "archive" :                                            │
│     sauve runs_2026-08-26_143012.json.gz                     │
│     supprime archives > 30 jours                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Visiteur https://thefronthub.com/lobby.html                 │
│   fetch('lobby_state.json') → données temps réel ✅          │
└─────────────────────────────────────────────────────────────┘
```

---

## ÉTAPE 1 — Configurer le domaine sur o2switch (10 min)

### 1.1 — Si ton domaine est chez o2switch

Passe à l'étape 1.2.

### 1.2 — Si ton domaine est ailleurs (Cloudflare, Namecheap, OVH…)

1. Connecte-toi à ton registrar externe
2. Change les nameservers pour :
   ```
   ns1.o2switch.fr
   ns2.o2switch.fr
   ```
3. Attends la propagation DNS (15 min à 24h selon le TLD)

### 1.3 — Ajouter le domaine dans cPanel

1. Connecte-toi à **cPanel** (URL fournie dans ton email o2switch, généralement `https://TON-USER.o2switch.fr/cpanel`)
2. Section **Domaines** → clique **Domaines configurés** (ou "Addon Domains")
3. Clique **Créer un domaine** (ou "Add Domain")
4. Remplis :
   - **Domaine** : `thefronthub.com`
   - **Sous-domaine** : laisse par défaut
   - **Document Root** : `public_html/thefronthub.com`
5. Clique **Ajouter le domaine**

### 1.4 — Ajouter aussi `www.thefronthub.com` (optionnel mais recommandé)

Répète l'étape 1.3 avec `www.thefronthub.com` pointant vers le même `public_html/thefronthub.com`.

---

## ÉTAPE 2 — Activer le SSL Let's Encrypt (5 min)

### 2.1 — Générer le certificat

1. cPanel → **Sécurité** → **Let's Encrypt SSL**
2. Trouve `thefronthub.com` (et `www.thefronthub.com`) dans la liste
3. ⚠️ **Important** : clique d'abord sur **"Générer la simulation"** (bouton gris) — ça teste sans compter Let's Encrypt
4. Si la simulation passe → clique **"Générer"** (bouton vert) pour le vrai certificat
5. Attends 30-60s, tu dois voir ✅ à côté du domaine

### 2.2 — Forcer la redirection HTTPS

1. cPanel → **Domaines** → **Domaines configurés**
2. Clique sur **"Gérer la redirection"** à côté de `thefronthub.com`
3. Active **"Forcer la redirection HTTPS"** (toggle ON)

### 2.3 — Vérifier

Ouvre `https://thefronthub.com` dans ton navigateur → tu dois voir le cadenas 🔒 vert.

> ⚠️ À ce stade, le site affiche une page cPanel par défaut — c'est normal, on n'a pas encore uploadé les fichiers.

---

## ÉTAPE 3 — Configurer SSH + Git (15 min)

### 3.1 — Whitelister ton IP pour SSH

1. Trouve ton IP publique : va sur https://whatismyip.com (depuis chez toi)
2. cPanel → **Sécurité** → **Autorisation SSH** (ou "Exception parefeu")
3. Clique **Ajouter une exception**
4. Remplis :
   - **Type** : `IPv4`
   - **IP / dyndns** : ton IP publique
   - **Port** : `22`
5. Clique **Ajouter**

> ⚠️ Si ton IP est dynamique, crée un compte gratuit sur https://www.noip.com/ et utilise le hostname (ex: `monip.ddns.net`) à la place de l'IP.

### 3.2 — Générer une clé SSH sur o2switch

1. cPanel → **Accès avancé** → **Terminal** (bouton noir directement dans cPanel)
2. Dans le terminal, tape :
   ```bash
   ssh-keygen -t ed25519 -C "o2switch-deploy" -f ~/.ssh/id_ed25519 -N ""
   ```
3. Affiche la clé publique :
   ```bash
   cat ~/.ssh/id_ed25519.pub
   ```
4. **Copie la sortie** (commence par `ssh-ed25519 AAAA...`)

### 3.3 — Ajouter la clé SSH comme Deploy Key sur GitHub

1. Va sur https://github.com/Skailex239/TheFrontHub2/settings/keys
2. Clique **"Add deploy key"**
3. Remplis :
   - **Title** : `o2switch deploy`
   - **Key** : colle la clé publique
   - ⚠️ NE coche PAS "Allow write access" (on veut juste pull)
4. Clique **"Add key"**

### 3.4 — Tester la connexion SSH

Dans le terminal cPanel :
```bash
ssh -T git@github.com
```
Tu dois voir :
```
Hi Skailex239/TheFrontHub2! You've successfully authenticated, but GitHub does not provide shell access.
```

---

## ÉTAPE 4 — Cloner le repo sur o2switch (5 min)

### 4.1 — Via cPanel Git Version Control

1. cPanel → **Fichiers** → **Git Version Control**
2. Clique **"Créer"** (ou "Create")
3. Remplis :
   - **Clone URL** : `git@github.com:Skailex239/TheFrontHub2.git`
   - **Repository Name** : `thefronthub-src`
   - **Repository Path** : `/home/TON-USER/thefronthub-src`
   - ⚠️ Coche **"Private repository"**
4. Clique **"Créer"**

### 4.2 — Vérifier

Tu dois voir la liste des fichiers du repo + bouton **"Pull or Deploy"**.

---

## ÉTAPE 5 — Copier les fichiers vers le document root (5 min)

Dans le terminal cPanel :

```bash
# Va à la racine du site
cd /home/TON-USER/public_html/thefronthub.com

# Vide le dossier (page par défaut cPanel)
rm -f default.html default.html.bak 2>/dev/null

# Copie tout le contenu du repo
cp -r /home/TON-USER/thefronthub-src/* .
cp -r /home/TON-USER/thefronthub-src/.htaccess . 2>/dev/null || true
cp -r /home/TON-USER/thefronthub-src/.gitignore . 2>/dev/null || true

# Cache les fichiers/dossiers qui ne doivent pas être servis publiquement
mv .git /home/TON-USER/.thefronthub-git-backup 2>/dev/null || true
mv src /home/TON-USER/.thefronthub-src-backup 2>/dev/null || true
mv scripts /home/TON-USER/.thefronthub-scripts-backup 2>/dev/null || true
mv tests /home/TON-USER/.thefronthub-tests-backup 2>/dev/null || true
mv .github /home/TON-USER/.thefronthub-github-backup 2>/dev/null || true
```

> ⚠️ Remplace `TON-USER` par ton user o2switch réel (visible en haut à gauche de cPanel).

---

## ÉTAPE 6 — Créer le fichier `.htaccess` (5 min)

Dans le terminal cPanel :

```bash
cat > /home/TON-USER/public_html/thefronthub.com/.htaccess << 'EOF'
# ── Sécurité : bloquer accès aux fichiers sensibles ──
<FilesMatch "(^\.|\.(env|md|yml|yaml|lock|sh)$)">
  Require all denied
</FilesMatch>

# Cacher .git, .github, scripts, tests, src, _archives
RedirectMatch 404 /(\.git|\.github|scripts|tests|src|_archives)(/.*)?$

# ── Bloquer accès à _upload.php sauf requêtes POST authentifiées ──
# Le secret HMAC protège déjà, mais on bloque l'accès direct GET pour éviter
# que quelqu'un ne le télécharge et lise le code PHP
<Files "_upload.php">
  <If "%{REQUEST_METHOD} != 'POST'">
    Require all denied
  </If>
</Files>

# ── Forcer HTTPS ──
RewriteEngine On
RewriteCond %{HTTPS} !=on
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]

# ── Page par défaut ──
DirectoryIndex index.html

# ── Compression GZIP ──
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/css text/javascript application/javascript application/json image/svg+xml
</IfModule>

# ── Cache navigateur ──
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/png "access plus 1 year"
  ExpiresByType image/jpeg "access plus 1 year"
  ExpiresByType image/webp "access plus 1 year"
  ExpiresByType text/css "access plus 1 month"
  ExpiresByType application/javascript "access plus 1 month"
  ExpiresByType text/html "access plus 5 minutes"
  ExpiresByType application/json "access plus 5 minutes"
</IfModule>

# ── UTF-8 par défaut ──
AddDefaultCharset UTF-8
EOF
```

> ✅ Note : les fichiers `.json` et `.json.gz` sont accessibles publiquement (le lobby en a besoin pour fonctionner). Le seul fichier protégé est `_upload.php` (POST-only).

---

## ÉTAPE 7 — Déployer le script `_upload.php` (10 min)

### 7.1 — Copier le fichier `_upload.php`

Le fichier `_upload.php` est déjà dans ton repo GitHub. Tu peux le copier depuis le repo cloné :

```bash
cp /home/TON-USER/thefronthub-src/_upload.php /home/TON-USER/public_html/thefronthub.com/_upload.php
chmod 644 /home/TON-USER/public_html/thefronthub.com/_upload.php
```

### 7.2 — Générer un secret aléatoire de 64 caractères

Dans le terminal cPanel :
```bash
openssl rand -hex 32
```
**Copie la sortie** (64 caractères hex, ex: `a3f8b2c1d4e5f6...`).

### 7.3 — Modifier `_upload.php` pour y mettre le secret

Édite le fichier avec `nano` :
```bash
nano /home/TON-USER/public_html/thefronthub.com/_upload.php
```

Trouve la ligne (~ligne 50) :
```php
$SECRET = 'CHANGE_MOI_PAR_UN_SECRET_DE_64_CHARS_HEX';
```

Remplace par ton secret généré :
```php
$SECRET = 'a3f8b2c1d4e5f6...'; // ton secret réel
```

Sauvegarde : `Ctrl+O`, `Enter`, `Ctrl+X` pour quitter nano.

### 7.4 — Tester que `_upload.php` répond correctement

Dans le terminal cPanel :
```bash
# Test 1 : GET doit être bloqué (405)
curl -i https://thefronthub.com/_upload.php 2>&1 | head -5
# Doit retourner : HTTP/1.1 405 Method Not Allowed

# Test 2 : POST sans secret doit être refusé (403)
curl -i -X POST https://thefronthub.com/_upload.php 2>&1 | head -5
# Doit retourner : HTTP/1.1 403 Forbidden

# Test 3 : POST avec secret mais sans fichier doit retourner 400
curl -i -X POST -H "X-Upload-Secret: TON_SECRET" https://thefronthub.com/_upload.php 2>&1 | head -5
# Doit retourner : HTTP/1.1 400 Missing file
```

✅ Si les 3 tests passent, `_upload.php` est bien déployé.

---

## ÉTAPE 8 — Configurer les secrets GitHub (5 min)

### 8.1 — Aller sur les settings GitHub

1. Va sur https://github.com/Skailex239/TheFrontHub2/settings/secrets/actions
2. Clique **"New repository secret"**

### 8.2 — Ajouter le secret `O2SWITCH_UPLOAD_URL`

- **Name** : `O2SWITCH_UPLOAD_URL`
- **Secret** : `https://thefronthub.com/_upload.php`
- Clique **"Add secret"**

### 8.3 — Ajouter le secret `O2SWITCH_UPLOAD_SECRET`

- **Name** : `O2SWITCH_UPLOAD_SECRET`
- **Secret** : colle le même secret que dans `_upload.php` (les 64 caractères hex)
- Clique **"Add secret"**

### 8.4 — Vérifier que `OPENFRONT_SKAILEX_ACCESS` est bien présent

Tu dois déjà l'avoir. Vérifie qu'il existe dans la liste des secrets. Si non, ajoute-le avec la valeur de ton token Skailex.

---

## ÉTAPE 9 — Tester le workflow GitHub (5 min)

### 9.1 — Lancer manuellement la sync

1. Va sur https://github.com/Skailex239/TheFrontHub2/actions/workflows/sync.yml
2. Clique **"Run workflow"** (bouton en haut à droite)
3. Sélectionne la branche `main`
4. Clique **"Run workflow"** (bouton vert)

### 9.2 — Suivre l'exécution

1. Clique sur le run qui vient de démarrer (en haut de la liste)
2. Tu vois les 7 jobs s'enchaîner :
   - sync-standard → ✅ upload runs.json.gz (archive), seen.json, ...
   - sync-compact → ✅ upload runs_compact.json.gz (archive)
   - sync-teams → ✅ upload teams_runs.json, ...
   - sync-ranked → ✅ upload ranked.json, ranked_history.json.gz (archive)
   - sync-dashboard → ✅ upload dashboard_scores.json
   - sync-player-games → ✅ upload player-data/*.json
   - sync-lobby-state → ✅ upload lobby_state.json
3. Si un job échoue, clique dessus pour voir les logs et corriger

### 9.3 — Vérifier que les fichiers sont bien arrivés sur o2switch

Dans le terminal cPanel :
```bash
# Lister les fichiers à la racine du site
ls -la /home/TON-USER/public_html/thefronthub.com/*.json /home/TON-USER/public_html/thefronthub.com/*.json.gz 2>/dev/null | head -20

# Tu dois voir :
# - lobby_state.json
# - ranked.json
# - teams_runs.json
# - dashboard_scores.json
# - runs_public.json.gz
# - ... (tous les fichiers de données)

# Vérifier les archives horodatées
ls -la /home/TON-USER/public_html/thefronthub.com/_archives/ 2>/dev/null

# Tu dois voir :
# - runs_2026-08-26_HHMMSS.json.gz
# - runs_compact_2026-08-26_HHMMSS.json.gz
# - ranked_history_2026-08-26_HHMMSS.json.gz
# - ranked_2v2_history_2026-08-26_HHMMSS.json.gz
```

---

## ÉTAPE 10 — Tester le site en direct (2 min)

1. Ouvre `https://thefronthub.com` dans ton navigateur
2. Tu dois voir la page d'accueil TheFrontHub (leaderboard)
3. Teste les pages :
   - `https://thefronthub.com/lobby.html` → lobby avec les parties OpenFront
   - `https://thefronthub.com/dashboard.html` → dashboard
   - `https://thefronthub.com/atlas.html` → atlas
   - `https://thefronthub.com/tournois.html` → tournois
   - `https://thefronthub.com/profile.html` → profil
4. Ouvre la console (F12) → il ne doit y avoir aucune erreur rouge bloquante

### 10.1 — Tester spécifiquement le lobby

1. Va sur `https://thefronthub.com/lobby.html`
2. Ouvre F12 → Console
3. Tu dois voir :
   - `[lobby] Connecting to wss://openfront-proxy.diofortnite3.workers.dev/lobby-ws…`
   - Soit `✅ WS open` (ça marche), soit `Reconnecting… (N)` (le WS a un souci mais les données arrivent quand même via `lobby_state.json`)
4. Tu dois voir :
   - Les 3 carrousels FFA/Team/Special avec des cartes
   - La section "Queue classée" avec les stats 1v1/2v2
   - L'historique des 25 dernières parties
   - La heatmap 24h

---

## ÉTAPE 11 — Déploiement automatique du CODE via Webhook GitHub (Option B)

> ✅ **Option choisie : Option B (Webhook temps réel)**
>
> Quand tu fais `git push`, GitHub appelle `https://thefronthub.com/_deploy.php`
> qui met à jour le code sur o2switch en ~2 secondes.

### 11.1 — Copier le fichier `_deploy.php` sur o2switch

Le fichier `_deploy.php` est déjà dans ton repo GitHub (à la racine). Copie-le dans le document root :

```bash
cp /home/TON-USER/thefronthub-src/_deploy.php /home/TON-USER/public_html/thefronthub.com/_deploy.php
chmod 644 /home/TON-USER/public_html/thefronthub.com/_deploy.php
```

### 11.2 — Générer un secret webhook (DIFFÉRENT du secret _upload.php)

Dans le terminal cPanel :
```bash
openssl rand -hex 32
```

**Copie la sortie** (64 caractères hex). ⚠️ Ce secret doit être **différent** du secret `_upload.php` (sécurité — séparation des préoccupations).

### 11.3 — Modifier `_deploy.php` avec ton secret + chemins

Édite le fichier :
```bash
nano /home/TON-USER/public_html/thefronthub.com/_deploy.php
```

Modifie ces 4 lignes (autour de la ligne 35) :
```php
$SECRET = 'CHANGE_MOI_PAR_UN_SECRET_WEBHOOK_DIFFERENT_DE_UPLOAD';  // ← ton secret
$REPO_PATH = '/home/USER/thefronthub-src';      // ← remplace USER par ton user o2switch
$WEB_ROOT = '/home/USER/public_html/thefronthub.com';  // ← idem
$LOG_FILE = '/home/USER/logs/deploy.log';        // ← idem
```

Sauvegarde : `Ctrl+O`, `Enter`, `Ctrl+X`.

### 11.4 — Créer le dossier logs (pour le debug)

```bash
mkdir -p /home/TON-USER/logs
chmod 755 /home/TON-USER/logs
```

### 11.5 — Configurer le webhook sur GitHub

1. Va sur https://github.com/Skailex239/TheFrontHub2/settings/hooks
2. Clique **"Add webhook"** (bouton vert)
3. Remplis :
   - **Payload URL** : `https://thefronthub.com/_deploy.php`
   - **Content type** : `application/json`
   - **Secret** : colle le même secret que dans `_deploy.php`
   - **SSL verification** : laisse "Enable SSL verification"
   - **Which events would you like to trigger this webhook?** : choisis **"Just the push event"**
4. Clique **"Add webhook"** (bouton vert en bas)

### 11.6 — Tester le webhook

1. Sur GitHub, dans la page https://github.com/Skailex239/TheFrontHub2/settings/hooks
2. Tu vois ton webhook avec une icône ✅ ou ❌
3. Clique sur le webhook → **"Recent Deliveries"**
4. Tu dois voir au moins 1 entrée (le webhook envoie un ping auto à la création)
5. Clique dessus → vérifie que **Response** est `200 OK` et le body contient `{"ok":true,...}`

Si ça échoue :
- Clique sur la delivery → **"Redeliver"** pour réessayer
- Vérifie les logs o2switch : `cat /home/TON-USER/logs/deploy.log`

### 11.7 — Tester le workflow complet

1. Sur ton PC, fais un petit changement dans le repo (ex: ajoute un commentaire dans `lobby.html`)
2. `git add`, `git commit -m "test deploy"`, `git push`
3. Va sur https://github.com/Skailex239/TheFrontHub2/settings/hooks
4. Tu dois voir une nouvelle delivery avec ✅ "Last delivery was successful"
5. Ouvre `https://thefronthub.com/lobby.html` → ta modif est déjà en ligne (~2 sec)

### 11.8 — Sécurité supplémentaire (optionnel)

Pour éviter que quelqu'un ne lise le code PHP de `_deploy.php` (même si c'est impossible car PHP l'exécute et ne l'affiche jamais), ajoute ceci au `.htaccess` :

```apache
# _deploy.php et _upload.php : seulement en POST (pas de GET)
<FilesMatch "^_(deploy|upload)\.php$">
  <If "%{REQUEST_METHOD} != 'POST'">
    Require all denied
  </If>
</Files>
```

---

## 🎯 AVERTISSEMENT IMPORTANT sur l'Option B

L'Option B déploie **UNIQUEMENT le code** (HTML/CSS/JS/PHP). Les **fichiers de données** (`lobby_state.json`, `ranked.json`, etc.) sont gérés par un système **séparé et automatique** :

- **GitHub Actions `sync.yml`** tourne tout seul toutes les 5 min
- Elle génère les fichiers JSON en local
- Elle les upload via `scripts/upload-to-o2switch.sh` vers `_upload.php`
- `_upload.php` les stocke sur o2switch

✅ Donc tu n'as **RIEN à faire** pour les données — c'est déjà automatique.

Tu n'as à configurer que **l'Option B pour le code** (cette étape 11).

---

## 📊 Rétention des données

### Snapshots (données temps réel — écrasées à chaque sync)
- `lobby_state.json` — dernières parties OpenFront
- `ranked.json` — classement actuel
- `teams.json` — stats équipes actuelles
- `dashboard_scores.json` — scores dashboard actuels
- `player-data/*.json` — données par joueur (dernier snapshot)
- `player-stats/*.json` — stats par joueur (dernier snapshot)

✅ **Garde tout le temps le dernier état** — écrasé à chaque sync.

### Archives (historique — rotation 30 jours automatique)
- `runs.json.gz` — historique complet des parties (16 Mo / sync)
- `runs_compact.json.gz` — version compacte (4.4 Mo / sync)
- `ranked_history.json.gz` — historique classé
- `ranked_2v2_history.json.gz` — historique 2v2 classé

Les archives sont stockées dans `/home/TON-USER/public_html/thefronthub.com/_archives/` avec un nom horodaté :
```
runs_2026-08-26_143012.json.gz
runs_2026-08-26_143512.json.gz  (5 min plus tard)
...
```

✅ **Rotation auto** : à chaque upload en mode "archive", le script `_upload.php` supprime automatiquement les archives > 30 jours.

### Vérifier l'espace disque utilisé

Dans le terminal cPanel :
```bash
# Taille totale des snapshots
du -sh /home/TON-USER/public_html/thefronthub.com/*.json /home/TON-USER/public_html/thefronthub.com/*.json.gz 2>/dev/null | tail -1

# Taille totale des archives
du -sh /home/TON-USER/public_html/thefronthub.com/_archives/

# Nombre d'archives > 25 jours (bientôt supprimées)
find /home/TON-USER/public_html/thefronthub.com/_archives/ -type f -mtime +25 | wc -l
```

---

## 🆘 Dépannage

### "Erreur 404 sur la page d'accueil"
- Cause : `index.html` pas dans le document root
- Solution : `ls /home/TON-USER/public_html/thefronthub.com/` pour vérifier

### "Erreur CORS dans la console navigateur"
- Cause : meta proxy manquante
- Solution : vérifie que `<meta name="openfront-api-proxy" content="https://openfront-proxy.diofortnite3.workers.dev">` est dans le `<head>` de chaque page HTML (déjà fait ✅)

### "SSL ne s'installe pas"
- Cause 1 : DNS pas propagés → vérifie `dig thefronthub.com`
- Cause 2 : tu as inclus `.odns.fr` dans le certificat → décoche-le

### "SSH connection refused"
- Cause : IP pas whitelistée
- Solution : cPanel → **Sécurité → Autorisation SSH** → ajoute ton IP

### "git pull permission denied (publickey)"
- Cause : clé SSH o2switch pas ajoutée comme Deploy Key
- Solution : refais l'étape 3.3

### "Le cron ne marche pas"
- Reçois les logs par email (cPanel Cron Jobs → "Please send an email to")

### "Upload vers o2switch échoue dans GitHub Actions"
1. Vérifie que `O2SWITCH_UPLOAD_URL` et `O2SWITCH_UPLOAD_SECRET` sont bien définis comme secrets GitHub
2. Vérifie que le secret dans GitHub = secret dans `_upload.php`
3. Test manuellement depuis ton PC :
   ```bash
   curl -X POST -H "X-Upload-Secret: TON_SECRET" \
     -F "file=@test.json" -F "filename=test.json" -F "mode=snapshot" \
     https://thefronthub.com/_upload.php
   ```
4. Si 403 → secret incorrect
5. Si 400 → filename pas dans whitelist
6. Si 500 → check les logs PHP dans cPanel → **Erreurs** ou `/home/TON-USER/logs/`

### "Les données du lobby ne se mettent pas à jour"
1. Vérifie le workflow : https://github.com/Skailex239/TheFrontHub2/actions
2. Vérifie que les fichiers sont bien présents sur o2switch :
   ```bash
   ls -la /home/TON-USER/public_html/thefronthub.com/lobby_state.json
   ```
3. Force un refresh navigateur : `Ctrl+Shift+R`

---

## ✅ Checklist finale

### Configuration o2switch
- [ ] Domaine `thefronthub.com` pointe vers o2switch
- [ ] Domaine ajouté dans cPanel (public_html/thefronthub.com)
- [ ] SSL Let's Encrypt généré (cadenas 🔒 vert)
- [ ] HTTPS forcé
- [ ] `.htaccess` créé

### Accès + Git
- [ ] IP whitelistée pour SSH
- [ ] Clé SSH o2switch ajoutée comme Deploy Key GitHub
- [ ] Repo cloné sur o2switch (`/home/TON-USER/thefronthub-src`)

### Fichiers + sync
- [ ] Fichiers copiés vers `public_html/thefronthub.com/`
- [ ] `_upload.php` déployé avec secret généré
- [ ] Secrets GitHub `O2SWITCH_UPLOAD_URL` et `O2SWITCH_UPLOAD_SECRET` configurés
- [ ] Workflow `sync.yml` testé manuellement → tous les jobs ✅
- [ ] Fichiers présents sur o2switch après sync

### Auto-deploy code
- [ ] Cron job 5 min configuré (option A) OU webhook GitHub (option B)

### Tests
- [ ] Site accessible sur `https://thefronthub.com`
- [ ] Toutes les pages marchent (`/lobby.html`, `/dashboard.html`, etc.)
- [ ] Console navigateur sans erreur rouge
- [ ] Lobby affiche des données temps réel
- [ ] Archives bien créées dans `_archives/`

---

## 📞 Liens utiles

| Ressource | URL |
|---|---|
| Espace client o2switch | https://www.o2switch.fr/mon-compte/ |
| Documentation o2switch | https://faq.o2switch.fr/ |
| Ton cPanel | https://TON-USER.o2switch.fr/cpanel |
| Repo GitHub | https://github.com/Skailex239/TheFrontHub2 |
| Secrets GitHub Actions | https://github.com/Skailex239/TheFrontHub2/settings/secrets/actions |
| Webhooks GitHub | https://github.com/Skailex239/TheFrontHub2/settings/hooks |
| Worker Cloudflare | https://openfront-proxy.diofortnite3.workers.dev |
| Cloudflare Dashboard | https://dash.cloudflare.com |
| Workflow sync.yml | https://github.com/Skailex239/TheFrontHub2/actions/workflows/sync.yml |

---

## 📝 Notes importantes

1. **Le repo GitHub reste léger** : ~3 Mo (code seul) au lieu de ~45 Mo avec données. L'historique Git ne grossit plus.

2. **Si tu veux purger l'historique Git des fichiers déjà commités** (optionnel, mais recommandé) :
   ```bash
   # Sur ta machine, clone propre
   git clone https://github.com/Skailex239/TheFrontHub2.git clean
   cd clean
   # Garde uniquement le dernier commit de chaque fichier de données
   git filter-repo --path runs.json.gz --path runs_compact.json.gz --path seen.json --path checkpoint.json --invert-paths
   # Force push
   git push origin main --force
   ```
   ⚠️ **Backup avant !** Ça réécrit l'historique.

3. **Si tu veux arrêter le worker Cloudflare WS** (qui ne marche pas bien) et basculer en HTTP polling : dis-moi, je modifierai `lobby.js` pour qu'il fetch `lobby_state.json` toutes les 5s si le WS échoue.

4. **Pense à renouveler ton abonnement o2switch** — sans abonnement actif, les fichiers seront supprimés après un délai de grâce (généralement 7-15 jours).
