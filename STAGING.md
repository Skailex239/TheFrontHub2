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

```bash
curl -s "https://dev.thefronthub.com/api/games-api.php?route=status" | head -c 400
curl -sI "https://dev.thefronthub.com/" | head -3
curl -s "https://dev.thefronthub.com/robots.txt"
```
Attendu : `ok:true` en status, HTTP 200, `Disallow: /`.

## Rollback

- dev : `git push origin <commit-avant>:dev` (force avec lease) — re-déploiement ≤ 5 min.
- prod : `git push origin <commit-avant>:main` — idem.

## Garde-fous déjà en place

- `--exclude='/.htaccess'` : le `.htaccess` **prod** reste géré à la main, jamais écrasé ;
  dev reçoit la version du repo (safe : redirection `https://%{HTTP_HOST}`).
- JSON de sync exclus du rsync → jamais écrasés, jamais supprimés par `--delete`.
- `STAGING.md`, `worklog.md`, `GUIDE_*.md` exclus du webroot dev.
- La prod ne dépend d'aucune étape dev (tout est guardé par l'existence de la branche).
