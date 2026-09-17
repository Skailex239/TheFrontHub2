# Archive TheFrontHub — stockage définitif de TOUTES les parties (Task 12)

Système de stockage **additif, autonome et réutilisable** : capture l'intégralité
des parties OpenFront (tous types) en métadonnées, plus les parties **complètes**
(avec tous les `turns`) pour les types choisis, en fichiers **JSONL compressés
gzip -9** auto-décrits. Objectif : pouvoir **reconstruire un site de stats
(ofstats-like) complet** à partir des seuls fichiers de l'archive, et s'étendre
aux **speedruns** plus tard sans rien changer à la structure.

- **Zéro impact sur le site** : ce dossier est exclu du webroot par `deploy.sh`
  (`--exclude='scripts'`). Aucun fichier existant du site n'est modifié.
- **Zéro dépendance npm** : Node 18+ natif uniquement (fetch, zlib, fs).
- **Zéro base de données** : les fichiers sont la source de vérité (repartout).
- **Reprise exacte après crash** : états atomiques + journaux append-only.
- **Stockage hors repo/webroot** : données dans `~/thefronthub-archive/`
  (jamais touchées par le déploiement rsync).

---

## 1. Ce que l'archive contient

```
~/thefronthub-archive/
├── index/
│   ├── raw/YYYY-MM-DD.jsonl        listing BRUT, 1 ligne = 1 partie (TOUS types)
│   ├── gz/YYYY-MM.jsonl.gz         compacté mensuel (dédupliqué, gzip -9)
│   └── manifest/YYYY-MM.json       comptes par jour, trace de compactage
├── games/
│   └── <Type>/                     ex. Public/
│       ├── raw/YYYY-MM-DD.jsonl    parties COMPLÈTES (info + players + tous les turns)
│       ├── gz/YYYY-MM-DD.jsonl.gz  compacté journalier (dédupliqué, gzip -9)
│       └── manifest/YYYY-MM-DD.json count + md5 + taille
├── state/                          états de reprise, journaux, verrous
└── logs/                           (vos redirections cron)
```

Une ligne d'index = le record complet renvoyé par `GET /public/games`
(gameID, start, end, type, mode, difficulty, numPlayers, maxPlayers,
lobbyFillTime, playerTeams, rankedType...).
Une ligne de `games/` = la réponse complète de `GET /public/game/:id`
(version, gitCommit, info{config, players[username, clanTag, publicID,
cosmetics, stats], winner, duration, num_turns}, turns[intents]).

> Les fichiers JSONL.gz se relisent ligne à ligne dans n'importe quel langage :
> c'est ce qui garantit le côté "réutilisable si je refais ofstats et plus".

## 2. Configuration (variables d'environnement / .env du repo)

| Variable | Défaut | Rôle |
|---|---|---|
| `ARCHIVE_DATA_DIR` | `~/thefronthub-archive` | dossier de stockage des données |
| `OPENFRONT_API_BASE` | `https://api.openfront.io` | API |
| `OPENFRONT_SKAILEX_ACCESS` | — | header d'exemption rate-limit (`x-skailex-access`) |
| `ARCHIVE_INDEX_START` | `2025-06-01T00:00:00.000Z` | début de l'historique (dispo du listing) |
| `ARCHIVE_INDEX_LAG_MIN` | `60` | marge : on n'indexe pas les parts démarrées < 60 min |
| `ARCHIVE_TURNS_ENABLED` | `true` | stocker les parties complètes ? |
| `ARCHIVE_TURNS_TYPES` | `Public` | types stockés avec turns (`Public,Private,...`) |
| `ARCHIVE_TURNS_MODES` | *(tous)* | filtre optionnel (ex. `Free For All`) — utile speedruns |
| `ARCHIVE_TURNS_ONLY_RANKED` | `false` | ne garder que les ranked |
| `ARCHIVE_TURNS_CONCURRENCY` | `3` | téléchargements parallèles |
| `ARCHIVE_HTTP_TIMEOUT_MS` / `ARCHIVE_HTTP_RETRIES` | `45000` / `6` | robustesse HTTP |

Le `.env` est chargé automatiquement (même mécanique que `openfront-api.js`),
sans jamais écraser l'environnement réel. `.env` est gitignoré : aucun token
ne finit dans le repo.

## 3. Scripts

| Script | Rôle |
|---|---|
| `index-backfill.js` | **ONE-SHOT initial** : indexe TOUT depuis le 01/06/2025. Reprend seul après interruption. |
| `index-sync.js` | **CRON horaire** : rattrape les nouvelles parties + rafraîchit les parties "en cours" (`end:null` → complètes). |
| `turns-fetch.js` | Télécharge les parties complètes des types configurés (défaut : hier). Auto-compacte une journée à 100 %. |
| `compact.js` | Compactage manuel/rattrapage (raw → gz + manifest). |
| `stats.js` | Santé : couverture, gaps, volumes disque. |
| `query.js` | Exploration : `count`, `games`, `full` (filtres type/mode/joueur/durée). |

Verrous anti-chevauchement intégrés : deux crons du même type ne peuvent pas
tourner en parallèle ; un verrou expiré (> 3 h) est automatiquement repris.

## 4. Mise en place sur o2switch (une seule fois)

```bash
# 1. Récupérer le code (deploy.sh le fait déjà chaque 5 min dans le webroot ;
#    pour les SCRIPTS on travaille dans la copie git) :
cd /home2/mask6607/thefronthub-src
git pull origin main

# 2. Ajouter la clé d'exemption rate-limit dans le .env du repo
#    (gitignoré, jamais commité) :
echo 'OPENFRONT_SKAILEX_ACCESS=<votre_token>' >> /home2/mask6607/thefronthub-src/.env

# 3. Créer les dossiers de logs :
mkdir -p /home2/mask6607/logs

# 4. Backfill initial (plusieurs heures -> lancer dans tmux/screen ou nohup) :
node scripts/archive/index-backfill.js >> /home2/mask6607/logs/archive-index.log 2>&1

# 5. Backfill des turns (Public) — long, par plages de jours :
node scripts/archive/turns-fetch.js --from-day=2025-06-01 --to-day=2026-09-19 \
  >> /home2/mask6607/logs/archive-turns.log 2>&1

# 6. Vérifier :
node scripts/archive/stats.js
node scripts/archive/query.js games --day=2026-09-19 --type=Public --limit=5
```

## 5. Crons à ajouter (cPanel o2switch → Cron Jobs)

```
# Index : rattrapage horaire (nouvelles parties + parties en cours)
0 * * * * cd /home2/mask6607/thefronthub-src && /usr/local/bin/node scripts/archive/index-sync.js >> /home2/mask6607/logs/archive-index.log 2>&1

# Turns : fetch horaire de la journée (complète les trous, auto-compacte)
15 * * * * cd /home2/mask6607/thefronthub-src && /usr/local/bin/node scripts/archive/turns-fetch.js >> /home2/mask6607/logs/archive-turns.log 2>&1

# Compactage des raw d'index restants, chaque nuit
30 3 * * * cd /home2/mask6607/thefronthub-src && /usr/local/bin/node scripts/archive/compact.js --all-index >> /home2/mask6607/logs/archive-compact.log 2>&1
```
> Adapter le chemin de node (`which node`) selon la config o2switch.

## 6. Volumes attendus (mesures Task 6-11)

| Donnée | Volume | Disque (gz) |
|---|---|---|
| Index tous types | ~170 000 parties/jour | ~1,5-4 Go/an |
| Turns `Public` | ~2 900 → 8 700 parties/jour (croissance) | ~150-220 Go/an |
| Turns `Private`/`Singleplayer` | possible via `ARCHIVE_TURNS_TYPES` | +des centaines de Go/an |

Par défaut, seul `Public` est stocké avec turns (volume maîtrisé).
Pour élargir : `ARCHIVE_TURNS_TYPES=Public,Private` dans le `.env`.

## 7. Reconstruire un site de stats depuis l'archive (le "refaire ofstats")

Tout est là :
1. **Liste des parties** (filtres type/mode/ranked/dates) → `index/gz/*.jsonl.gz`.
2. **Détail complet d'une partie** (joueurs, publicIDs, config, cartes,
   chaque tour : intents, attaques, alliances) → `games/<Type>/gz/*.jsonl.gz`.
3. **Statistiques joueurs** : agréger `info.players[].stats` sur les parties
   où le `publicID` apparaît (publicIDs publics par design depuis le
   10/09/2025 — mesure Task 10).
4. **Classements / historiques** : dérivés de 1-3 par des jobs arbitraires.

Outils fournis : `query.js count|games|full` pour explorer,
`stats.js` pour l'état. Un script de rebuild arbitraire ne lit que du
JSONL : réimportable dans MySQL, SQLite, Elasticsearch, S3, etc.

## 8. Speedruns (extension prévue)

Les speedruns = parties avec `mode`/config précis et durée minimale.
Rien à changer côté structure :
- identification : requête sur `index` (`query.js games --mode="Free For All" --min-players=10` + tri `duration`) ;
- stockage des turns pour elles : ajouter le filtre dans le `.env` :
  `ARCHIVE_TURNS_MODES="Free For All"` (ou élargir `ARCHIVE_TURNS_TYPES`) ;
- le site extrait déjà les temps via `shared/extract-speedrun.js` — le même
  parsing s'applique aux parties de l'archive (mêmes JSON que l'API).

## 9. Garanties techniques

- **Fenêtres 47 h 59** (limite API 48 h pile mesurée), pagination `limit=1000`,
  dédup par `gameID` au compactage → aucune duplication en base finale.
- **Parties en cours** : records `end:null` mis en file `pending` puis
  rafraîchis automatiquement (1 requête/partie/passe) jusqu'à complétion.
- **Crash-safe** : états écrits atomiquement (tmp+rename), journaux append-only,
  fenêtres cochées une à une → reprise exacte, jamais de doublon.
- **Intégrité** : manifestes avec md5 + nombre de parties par fichier gz.
- **Rate limit** : aucune limite officielle depuis le 06/09/2026 (mesure Task 9)
  ; retries avec backoff sur 429/5xx ; exemption `x-skailex-access` si fournie.
- **Site intact** : scripts non servis par le webroot, aucune modification des
  fichiers existants, aucun changement de schéma/base, aucune dépendance npm.
