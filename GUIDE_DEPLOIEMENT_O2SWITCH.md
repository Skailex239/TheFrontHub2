# 🚀 Guide de déploiement o2switch — TheFrontHub.com

Guide complet, étape par étape, pour héberger ton site sur o2switch avec le nom de domaine `thefronthub.com`.

> **Bonne nouvelle** : ton site est **100% statique** (HTML/CSS/JS + images). Pas besoin de Node.js ni de Phusion Passenger. Le déploiement est donc ultra-simple : on copie les fichiers dans le dossier web d'o2switch.

---

## 📋 Prérequis

- ✅ Un abonnement o2switch actif (Grow, Cloud ou Pro — tous marchent)
- ✅ Le nom de domaine `thefronthub.com` enregistré (sur o2switch ou ailleurs)
- ✅ Ton repo GitHub `Skailex239/TheFrontHub2` à jour
- ✅ Le worker Cloudflare déployé (`openfront-proxy.diofortnite3.workers.dev`) — déjà fait ✅

---

## 🎯 Architecture finale

```
┌─────────────────────────────────────────────────────────────┐
│ Navigateur visite https://thefronthub.com                   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ o2switch (Apache + LiteSpeed)                               │
│ Sert les fichiers statiques (lobby.html, dashboard.html…)   │
│ Document root: /home/USER/public_html/thefronthub.com/      │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Cloudflare Worker (openfront-proxy.diofortnite3.workers.dev)│
│ • HTTP proxy → api.openfront.io (CORS + token x-skailex)    │
│ • WS proxy → wss://openfront.io/w0..4/lobbies               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenFront.io (api.openfront.io + wss://openfront.io/...)    │
└─────────────────────────────────────────────────────────────┘
```

---

## ÉTAPE 1 — Configurer le domaine sur o2switch (10 min)

### 1.1 — Vérifier où est enregistré ton domaine

- **Si tu l'as enregistré chez o2switch** : passe directement à l'étape 1.2
- **Si tu l'as enregistré ailleurs** (Cloudflare, Namecheap, OVH, Gandi…) : modifie les nameservers du domaine pour pointer vers o2switch :
  - Connecte-toi à ton registrar externe
  - Change les nameservers pour :
    ```
    ns1.o2switch.fr
    ns2.o2switch.fr
    ```
  - Attends la propagation DNS (15 min à 24h selon le TLD)

### 1.2 — Ajouter le domaine dans cPanel

1. Connecte-toi à **cPanel** : `https://ton-compte.o2switch.fr/cpanel` (ou via l'Espace Client o2switch)
2. Cherche la section **Domaines** → clique sur **Domaines configurés** (ou "Addon Domains")
3. Clique sur **Créer un domaine** (ou "Add Domain")
4. Remplis :
   - **Domaine** : `thefronthub.com`
   - **Sous-domaine** : laisse par défaut (`thefronthub.ton-compte.o2switch.fr`)
   - **Document Root (Racine du document)** : `public_html/thefronthub.com`
   - ⚠️ Coche **"Créer un répertoire pour ce domaine"** si proposé
5. Clique **Ajouter le domaine** / **Submit**

### 1.3 — Répéter pour `www.thefronthub.com` (optionnel mais recommandé)

Dans cPanel → **Domaines → Domaines configurés** → crée aussi `www.thefronthub.com` pointant vers le même document root `public_html/thefronthub.com`.

---

## ÉTAPE 2 — Activer le SSL Let's Encrypt (5 min)

### 2.1 — Générer le certificat

1. cPanel → **Sécurité** → **Let's Encrypt SSL** (ou "SSL/TLS Status")
2. Tu vois une liste de tes domaines. Trouve `thefronthub.com` (et `www.thefronthub.com`)
3. ⚠️ **ÉTAPE CRITIQUE** : clique d'abord sur **"Générer la simulation"** (bouton gris/smoke test) — ça teste sans count Let's Encrypt
4. Si la simulation passe → clique sur **"Générer"** (bouton vert) pour le vrai certificat
5. Attends 30-60s, tu devrais voir ✅ à côté du domaine

### 2.2 — Forcer la redirection HTTPS

1. cPanel → **Domaines** → **Domaines configurés**
2. Clique sur **"Gérer la redirection"** (ou "Force HTTPS Redirect") à côté de `thefronthub.com`
3. Active **"Forcer la redirection HTTPS"** (toggle ON)

### 2.3 — Vérifier

Ouvre `https://thefronthub.com` dans ton navigateur → tu dois voir le cadenas 🔒 vert (pas de warning certificat).

> ⚠️ **Note** : à ce stade, le site affiche une page par défaut cPanel ou une erreur 404 — c'est normal, on n'a pas encore uploadé les fichiers (étape 4).

---

## ÉTAPE 3 — Configurer l'accès SSH + Git (15 min)

Pour pouvoir faire `git pull` depuis o2switch vers ton repo GitHub, il faut autoriser SSH + déployer une clé publique sur GitHub.

### 3.1 — Whitelister ton IP pour SSH

1. cPanel → **Sécurité** → **Autorisation SSH** (ou "Exception parefeu")
2. Clique **"Ajouter une exception"**
3. Remplis :
   - **Type** : `IPv4`
   - **IP / dyndns** : tape ton IP publique (cherche "what is my ip" sur Google) — ou un hostname noip.com si IP dynamique
   - **Port** : `22`
4. Clique **Ajouter**

### 3.2 — Créer une clé SSH sur o2switch

1. cPanel → **Accès avancé** → **Terminal** (bouton noir dans cPanel directement, plus rapide que SSH externe)
2. Dans le terminal, génère une clé SSH :
   ```bash
   ssh-keygen -t ed25519 -C "o2switch-deploy" -f ~/.ssh/id_ed25519 -N ""
   ```
3. Affiche la clé publique :
   ```bash
   cat ~/.ssh/id_ed25519.pub
   ```
4. **Copie la sortie** (commence par `ssh-ed25519 AAAA...`)

### 3.3 — Ajouter la clé SSH sur GitHub comme Deploy Key

1. Va sur https://github.com/Skailex239/TheFrontHub2/settings/keys
2. Clique **"Add deploy key"**
3. Remplis :
   - **Title** : `o2switch deploy`
   - **Key** : colle la clé publique copiée à l'étape 3.2
   - ⚠️ Coche **"Allow write access"** (NON — on veut juste pull, pas push depuis o2switch)
4. Clique **"Add key"**

### 3.4 — Tester la connexion SSH GitHub

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

### 4.1 — Cloner via cPanel Git Version Control (méthode GUI)

1. cPanel → **Fichiers** → **Git Version Control** (ou "Gitweb")
2. Clique **"Créer"** (ou "Create")
3. Remplis :
   - **Clone URL** : `git@github.com:Skailex239/TheFrontHub2.git` (SSH, pas HTTPS — sinon il faudra entrer un token GitHub)
   - **Repository Name** : `thefronthub-src`
   - **Repository Path** : `/home/USER/thefronthub-src` (remplace `USER` par ton user o2switch)
   - ⚠️ Coche **"Private repository"**
4. Clique **"Créer"** (ou "Create")
5. Une fois cloné, tu verras la liste des fichiers + bouton **"Pull or Deploy"**

### 4.2 — Alternative : cloner en SSH CLI

Si tu préfères la CLI :
```bash
cd /home/USER
git clone git@github.com:Skailex239/TheFrontHub2.git thefronthub-src
```

---

## ÉTAPE 5 — Synchroniser les fichiers vers le document root (5 min)

Le repo est dans `/home/USER/thefronthub-src` mais ton site doit être servi depuis `/home/USER/public_html/thefronthub.com/`. Deux options :

### 5.1 — Option A : copie simple (recommandé pour commencer)

Dans le terminal cPanel :
```bash
# Va à la racine du site
cd /home/USER/public_html/thefronthub.com

# Vide le dossier (au cas où il y a la page par défaut cPanel)
rm -f default.html default.html.bak

# Copie tout le contenu du repo
cp -r /home/USER/thefronthub-src/* .
cp -r /home/USER/thefronthub-src/.git* . 2>/dev/null

# Cache les fichiers sensibles (.git, src/, etc.)
mv .git /home/USER/.thefronthub-git-backup
mv src /home/USER/.thefronthub-src-backup
```

### 5.2 — Option B : symlink (avancé, plus élégant)

```bash
# Supprime le document root créé par cPanel
rmdir /home/USER/public_html/thefronthub.com

# Crée un symlink du repo vers le document root
ln -s /home/USER/thefronthub-src /home/USER/public_html/thefronthub.com
```
> ⚠️ **Attention** : avec un symlink, le dossier `.git/` sera accessible publiquement. Ajoute une règle `.htaccess` (voir étape 6).

---

## ÉTAPE 6 — Créer le fichier `.htaccess` (5 min)

Crée le fichier `/home/USER/public_html/thefronthub.com/.htaccess` avec ce contenu :

```apache
# ── Sécurité : bloquer accès aux fichiers sensibles ──
<FilesMatch "(^\.|\.(json|gz|db|sqlite|env|md|yml|yaml|lock)$)">
  Require all denied
</FilesMatch>

# Cacher .git/ et autres dossiers cachés
RedirectMatch 404 /\..*$

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

# ── Cache navigateur (1 an pour les assets statiques) ──
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/png "access plus 1 year"
  ExpiresByType image/jpeg "access plus 1 year"
  ExpiresByType image/webp "access plus 1 year"
  ExpiresByType text/css "access plus 1 month"
  ExpiresByType application/javascript "access plus 1 month"
  ExpiresByType text/html "access plus 5 minutes"
</IfModule>

# ── UTF-8 par défaut ──
AddDefaultCharset UTF-8
```

> ⚠️ **Note sur `lobby_state.json` et `ranked.json`** : ces fichiers doivent être **accessibles** par le navigateur (ton lobby les fetch). Le blocage `\.json$` ci-dessus va les bloquer. **Solution** : ajoute une exception juste après le `<FilesMatch>` :
>
> ```apache
> # Exception : les fichiers JSON utilisés par le frontend sont publics
> <FilesMatch "^(lobby_state|ranked|teams|maps_list|seen|seen_compact)\.json$">
>   Require all granted
> </FilesMatch>
> ```

---

## ÉTAPE 7 — Tester le site (2 min)

1. Ouvre `https://thefronthub.com` dans ton navigateur
2. Tu dois voir le leaderboard TheFrontHub (page `index.html`)
3. Teste les pages :
   - `https://thefronthub.com/lobby.html` → lobby avec les parties OpenFront
   - `https://thefronthub.com/dashboard.html` → dashboard
   - `https://thefronthub.com/atlas.html` → atlas
   - `https://thefronthub.com/tournois.html` → tournois
   - `https://thefronthub.com/profile.html` → profil
4. Ouvre la console (F12) → il ne doit y avoir aucune erreur rouge bloquante

> ⚠️ Si tu vois des erreurs 404 sur des fichiers (`lobby.js`, `styles.css`, etc.), vérifie qu'ils sont bien copiés dans le document root.

---

## ÉTAPE 8 — Configurer le déploiement automatique via GitHub (10 min)

Pour que chaque `git push` sur ton repo GitHub mette à jour automatiquement le site o2switch, tu as deux options :

### 8.1 — Option A : Cron job toutes les 5 min (LE PLUS SIMPLE)

1. cPanel → **Avancé** → **Tâches Cron** (ou "Cron Jobs")
2. Configure une tâche qui tourne toutes les 5 minutes :
   - **Minute** : `*/5`
   - **Heure** : `*`
   - **Jour** : `*`
   - **Mois** : `*`
   - **Jour de la semaine** : `*`
3. **Commande** :
   ```bash
   cd /home/USER/thefronthub-src && git pull origin main --quiet && rsync -a --delete --exclude='.git' --exclude='.htaccess' ./ /home/USER/public_html/thefronthub.com/
   ```
   Remplace `USER` par ton user o2switch.

4. Clique **"Ajouter une nouvelle tâche cron"**

✅ **Avantage** : ultra simple, pas de webhook à configurer
⚠️ **Inconvénient** : latence max 5 min entre le push GitHub et la mise à jour du site

### 8.2 — Option B : Webhook GitHub → script PHP (temps réel)

Pour un déploiement instantané quand tu pousses sur GitHub :

1. Crée un fichier `/home/USER/public_html/thefronthub.com/_deploy.php` :

```php
<?php
// _deploy.php — webhook GitHub pour déployer le site
// Sécurité : secret partagé avec GitHub

$SECRET = 'change-moi-avec-un-secret-aleatoire-32-chars';
$REPO_PATH = '/home/USER/thefronthub-src';
$WEB_ROOT = '/home/USER/public_html/thefronthub.com';

// Vérifier le header X-Hub-Signature-256
$signature = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
$body = file_get_contents('php://input');
$expected = 'sha256=' . hash_hmac('sha256', $body, $SECRET);

if (!hash_equals($expected, $signature)) {
  http_response_code(403);
  die('Forbidden');
}

// Vérifier que c'est un push sur main
$payload = json_decode($body, true);
if (($payload['ref'] ?? '') !== 'refs/heads/main') {
  http_response_code(200);
  die('Ignored (not main)');
}

// Pull + rsync vers le document root
$commands = [
  "cd $REPO_PATH && git fetch origin main --quiet",
  "cd $REPO_PATH && git reset --hard origin/main --quiet",
  "rsync -a --delete --exclude='.git' --exclude='.htaccess' --exclude='_deploy.php' $REPO_PATH/ $WEB_ROOT/",
];

foreach ($commands as $cmd) {
  shell_exec($cmd . ' 2>&1');
}

http_response_code(200);
echo "Deployed: " . date('Y-m-d H:i:s');
```

2. **Génère un secret aléatoire** : dans le terminal cPanel, tape :
   ```bash
   openssl rand -hex 32
   ```
   Remplace `change-moi-avec-un-secret-aleatoire-32-chars` dans `_deploy.php` par ce secret.

3. **Sur GitHub** : va sur https://github.com/Skailex239/TheFrontHub2/settings/hooks
   - Clique **"Add webhook"**
   - **Payload URL** : `https://thefronthub.com/_deploy.php`
   - **Content type** : `application/json`
   - **Secret** : colle le même secret que dans `_deploy.php`
   - **Events** : cocher "Just the push event"
   - Clique **"Add webhook"**

4. **Test** : fais un petit commit sur ton repo (`git push`), puis dans GitHub webhook settings, vérifie que tu as un ✅ "Last delivery was successful"

5. ⚠️ **Sécurité** : le fichier `_deploy.php` ne doit PAS être accessible publiquement. Ajoute dans `.htaccess` :
   ```apache
   # Bloquer accès direct à _deploy.php (sauf webhook GitHub)
   <Files "_deploy.php">
     Require all denied
   </Files>
   ```
   ⚠️ Mais ça bloquera aussi GitHub. **Solution alternative** : ne pas le bloquer (le secret HMAC protège déjà), MAIS le cacher en le déplaçant dans `/home/USER/.deploy/` (hors web root) et en faisant un symlink ou un appel interne. Le plus simple : laisser accessible, le secret HMAC suffit.

---

## ÉTAPE 9 — (Optionnel) Vérifier la connexion WS du lobby

Le lobby utilise le worker Cloudflare `wss://openfront-proxy.diofortnite3.workers.dev/lobby-ws`. Comme vu dans l'analyse, ce worker a un souci d'upgrade WS cross-Cloudflare.

Pour tester si ça marche quand même :

1. Ouvre `https://thefronthub.com/lobby.html`
2. F12 → onglet **Console**
3. Tu dois voir :
   - `[lobby] Connecting to wss://openfront-proxy.diofortnite3.workers.dev/lobby-ws…`
   - Soit `[lobby] ✅ WS open` (ça marche) → les parties vont s'afficher dans les 3 carrousels
   - Soit `Reconnecting… (N)` (ça ne marche pas) → on garde WS pour le moment, on verra plus tard

---

## 🆘 Dépannage

### Problème : "Erreur 404 sur la page d'accueil"
- Cause : `index.html` n'est pas dans le document root
- Solution : vérifie avec `ls /home/USER/public_html/thefronthub.com/` que tu vois `index.html`

### Problème : "Page blanche avec erreurs CORS dans la console"
- Cause : la meta `<meta name="openfront-api-proxy">` n'est pas dans le HTML
- Solution : toutes les pages HTML du repo l'ont maintenant (commit fait). Si tu en as une ancienne version, ajoute-la manuellement après le `<meta name="viewport">` :
  ```html
  <meta name="openfront-api-proxy" content="https://openfront-proxy.diofortnite3.workers.dev">
  ```

### Problème : "Le SSL ne s'installe pas"
- Cause 1 : le domaine ne pointe pas encore vers o2switch (DNS pas propagés)
- Solution : vérifie avec `dig thefronthub.com` que l'IP correspond à ton serveur o2switch
- Cause 2 : tu as inclus `.odns.fr` ou `.o2switch.net` dans la demande de certificat
- Solution : ne coche QUE `thefronthub.com` et `www.thefronthub.com`

### Problème : "SSH connection refused"
- Cause : ton IP n'est pas whitelistée
- Solution : cPanel → **Sécurité → Autorisation SSH** → ajoute ton IP

### Problème : "git pull permission denied (publickey)"
- Cause : la clé SSH o2switch n'est pas ajoutée comme Deploy Key sur GitHub
- Solution : refais l'étape 3.3

### Problème : "Le cron ne marche pas"
- Cause 1 : erreur de syntaxe dans la commande cron
- Solution : reçois les logs par email (cPanel configure ça dans Cron Jobs)
- Cause 2 : le user cron n'a pas les permissions sur le dossier
- Solution : utilise des chemins absolus, vérifie les droits avec `ls -la`

---

## ✅ Checklist finale

- [ ] Domaine `thefronthub.com` pointe vers o2switch (dig OK)
- [ ] Domaine ajouté dans cPanel (public_html/thefronthub.com existe)
- [ ] SSL Let's Encrypt généré (cadenas 🔒 vert)
- [ ] HTTPS forcé
- [ ] IP whitelistée pour SSH
- [ ] Clé SSH o2switch ajoutée comme Deploy Key GitHub
- [ ] Repo cloné sur o2switch (`/home/USER/thefronthub-src`)
- [ ] Fichiers copiés vers `public_html/thefronthub.com/`
- [ ] `.htaccess` créé avec le bon contenu (n'oublie pas l'exception JSON)
- [ ] Site accessible sur `https://thefronthub.com`
- [ ] Toutes les pages marchent (`/lobby.html`, `/dashboard.html`, etc.)
- [ ] Cron job OU webhook GitHub configuré pour auto-deploy
- [ ] Console navigateur sans erreur rouge

---

## 📞 Liens utiles

| Ressource | URL |
|---|---|
| Espace client o2switch | https://www.o2switch.fr/mon-compte/ |
| Documentation o2switch | https://faq.o2switch.fr/ |
| Ton cPanel | https://TON-USER.o2switch.fr/cpanel |
| Repo GitHub | https://github.com/Skailex239/TheFrontHub2 |
| Worker Cloudflare | https://openfront-proxy.diofortnite3.workers.dev |
| Cloudflare Dashboard | https://dash.cloudflare.com |

---

## 🎯 Une fois tout déployé

Tu pourras :
- Visiter `https://thefronthub.com` → page d'accueil (leaderboard)
- Visiter `https://thefronthub.com/lobby.html` → lobby temps réel
- Faire un `git push` sur GitHub → le site se met à jour automatiquement (cron 5 min ou webhook temps réel)
- Gérer ta DB MySQL dans cPanel → **phpMyAdmin** (si tu en as besoin un jour)

Si tu rencontres un souci pendant le déploiement, copie-colle moi l'erreur exacte et je t'aide à debugger.
