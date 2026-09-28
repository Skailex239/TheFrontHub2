# STAGING — dev.thefronthub.com

Environnement de **pré-production** de TheFrontHub : chaque nouvelle feature
atterrit d'abord ici (branche `dev`), est vérifiée en conditions réelles
(captures d'écran, tests), puis seulement **ensuite** part en production.

```
branche feature ──PR──▶ dev ──(vérif dev.thefronthub.com)──PR──▶ main ──▶ thefronthub.com
```

## Architecture (100 % automatique)

| | PROD | DEV |
|---|---|---|
| Branche déployée | `main` | `dev` |
| URL | https://thefronthub.com | https://dev.thefronthub.com |
| Dossier source git | `/home2/mask6607/thefronthub-src` | `/home2/mask6607/thefronthub-dev` |
| Webroot | `/home2/mask6607/public_html/thefronthub.com` | `/home2/mask6607/dev.thefronthub.com` |
| Base MySQL | la même (lecture côté front) | **la même** |
| Secrets | `~/.tfs_secrets/tfh-secrets.json` | **les mêmes** (hors webroot) |
| JSON de sync (ranked.json, runs_public…) | fichiers réels | **symlinks vers prod** |
| Cron | `deploy.sh` toutes les 5 min | **le même tick** (section 6 du script) |
| Indexation moteurs | normale | **noindex** (robots.txt + X-Robots-Tag) |

Le déploiement dev est **inclus dans le deploy.sh existant** : si la branche
`dev` existe sur GitHub, elle est clonée/resetée puis rsyncée vers le webroot
dev à chaque tick de 5 min. Si la branche n'existe pas, l'étape est ignorée
(aucun impact prod). **Aucun cron supplémentaire à créer.**

## Mise en place — LE SEUL geste manuel (1 min, une fois)

1. Se connecter à **cPanel o2switch** (https://109-234-167-89.o2switch.net/… ou votre favori).
2. Chercher **« Domaines »** (section Domaines) → bouton **« Créer un nouveau domaine »**.
3. Champ domaine : saisir exactement `dev.thefronthub.com`.
4. **Décocher** « Partager le dossier du document root » (si proposé) pour que
   le champ document root devienne : `/home2/mask6607/dev.thefronthub.com`
   (c'est le chemin attendu par deploy.sh — sinon adapter `DEV_DEST`).
5. Valider. Le DNS (zone o2switch : ns1/ns2.o2switch.net) et le certificat
   **AutoSSL/Let's Encrypt** sont émis automatiquement.
6. C'est tout. ≤ 5 min après la création de la branche `dev` sur GitHub, le
   site de pré-production est servi sur https://dev.thefronthub.com.

> Si le domaine était un jour géré hors d'o2switch (ex. Cloudflare), il faudrait
> ajouter à la main un enregistrement DNS `dev` → `109.234.167.89` (A).
> Aujourd'hui le DNS est chez o2switch : **rien à faire**.

## Workflow d'une feature (fait par l'agent)

1. Branche `feature/…` créée depuis `dev` → commits.
2. Pull Request **base `dev`** ← `feature/…` → merge.
3. ≤ 5 min : déploiement automatique sur dev.thefronthub.com.
4. Vérifications agent : curl des API + captures d'écran des pages
   (boucle « si cassé → fix → re-vérif » jusqu'à zéro défaut).
5. PR **base `main`** ← `dev` → merge → prod à jour en ≤ 5 min.
6. Nouvelles captures prod pour confirmer.

## Vérifications post-déploiement dev

⚠️ Depuis la porte d'accès (ci-dessous), la dev exige une session : sans
cookie, toute page renvoie la page de connexion et l'API renvoie 401.

```bash
curl -s "https://dev.thefronthub.com/api/games-api.php?route=status" | head -c 200
curl -sI "https://dev.thefronthub.com/" | head -3
curl -s "https://dev.thefronthub.com/robots.txt"
```

Attendu sans session : API → `{"ok":false,"error":"dev_gate"}` (401),
pages → HTML de connexion (200, no-store), robots.txt → `Disallow: /`.
Avec session (cookie `tfh_dev_gate`) : `ok:true` en status, pages réelles.

## Porte d'accès dev (gate.php)

La pré-production est **verrouillée par un code** (connu du propriétaire seul).

- **Activation** : uniquement sur `dev.thefronthub.com` (condition
  `HTTP_HOST` dans `.htaccess` + `api/.htaccess`). La prod `thefronthub.com`
  reste 100 % publique, même si les fichiers du gate y sont un jour rsyncés :
  `gate.php` répond 404 hors host dev et les règles rewrite ne s'y appliquent pas.
- **Connexion** : formulaire `gate.php` → `password_verify` (bcrypt, coût 12)
  contre `secure/auth-config.php`. Le code en clair n'existe **nulle part**
  (ni repo, ni HTML, ni JS, ni logs). Session = cookie `tfh_dev_gate` signé
  HMAC-SHA256 (30 jours, HttpOnly, Secure en https, SameSite=Lax).
- **Anti force brute** : 5 échecs / 15 min par IP → verrou 5 → 10 → 20 → 40
  → 60 min (compteurs dans `/tmp/tfh-dev-gate/`, hors webroot).
- **Couverture** : pages statiques ET `/api/*.php` (inclus par `gate.php`
  après vérification — aucun fichier API modifié). Jamais servis : `secure/`,
  dotfiles, `.git`, `config.php`/`helpers.php` de l'API.
- **Service worker** : la page de connexion désenregistre le SW et purge les
  caches (un visiteur non authentifié ne peut rien servir depuis le cache).
- **Changer le code** : générer un nouveau hash
  `php -r "echo password_hash('NOUVEAU_CODE', PASSWORD_BCRYPT), PHP_EOL;"`,
  remplacer `'hash'` dans `secure/auth-config.php` et bump `'v'` (purge toutes
  les sessions).
- **Désactivation d'urgence (rollback)** : `git push origin <commit-avant>:dev`
  (re-déploiement ≤ 5 min) — ou retirer le bloc « 1ter. DEV » du `.htaccess`.

## Rollback

- dev : `git push origin <commit-avant>:dev` (force avec lease) — re-déploiement ≤ 5 min.
- prod : `git push origin <commit-avant>:main` — idem.

## Garde-fous déjà en place

- `--exclude='/.htaccess'` : le `.htaccess` **prod** reste géré à la main, jamais écrasé ;
  dev reçoit la version du repo (safe : redirection `https://%{HTTP_HOST}`).
- JSON de sync exclus du rsync → jamais écrasés, jamais supprimés par `--delete`.
- `STAGING.md`, `worklog.md`, `GUIDE_*.md` exclus du webroot dev.
- La prod ne dépend d'aucune étape dev (tout est guardé par l'existence de la branche).
