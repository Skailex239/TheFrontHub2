# Système « Parties & Pré-profils » TheFrontHub

> Stockage **MySQL o2switch** de toutes les parties OpenFront (Public **et**
> Private) depuis l'ère V34 (début : **2026-09-10 00h00 UTC** — v0.34.0-beta1),
> avec roster complet lié par publicId, speedruns pré-calculés et
> pré-profils agrégés par joueur.
>
> Périmètre v2 (2026-09-23) : Public + Private, parties gardées dès 1 joueur
> (`min_players_to_keep`). Singleplayer exclu par défaut (80 000+/jour de
> lobbies solo vides) — activable via `game_types`.

## Architecture

```
OpenFront API (api.openfront.io)
        │  cron cPanel (php api/games-sync.php, toutes les 10 min)
        ▼
MySQL o2switch ── tfh_g_games     (métadonnées + speedrun pré-calculé)
                ── tfh_g_roster   (qui a joué quoi, avec publicId !)
                ── tfh_g_players  (pré-profils : compteurs par publicId)
                ── tfh_g_aliases  (tous les pseudos connus par joueur)
                ── tfh_g_usernames (dictionnaire de pseudos)
        │  api/games-api.php (JSON, lecture seule)
        ▼
Frontend : runs.html (records par carte/temps), profile.html (bloc
« Historique TheFrontHub » par publicId), index.html (« Toutes les
dernières parties »).
```

- **Aucune donnée sensible** : uniquement les données publiques de l'API.
- L'API OpenFront **encourage officiellement** cette collecte (endpoint
  `/public/players/recently-deleted` existe précisément pour ça).
- Idempotent : re-exécuter ne duplique rien (INSERT IGNORE + guards).
- Anti-chevauchement : lock fichier (2 crons qui se croisent ne se doublent pas).

## Installation (o2switch, 15 min)

### 1. Secrets

Ajouter dans `~/.tfs_secrets/tfh-secrets.json` (le fichier existe déjà pour
l'API auth) — 2 clés nouvelles :

```json
{
  "mysql": { "host": "localhost", "port": 3306, "database": "…", "username": "…", "password": "…" },
  "openfront_access": "TON_TOKEN_SKAILEX",
  "games": {
    "game_types": "Public,Private",
    "min_players_to_keep": 1,
    "detail_concurrency": 4,
    "player_stats_mode": "subset",
    "tick_budget": 240
  }
}
```

- `openfront_access` : le token d'exemption rate-limit Skailex (celui déjà
  utilisé par les autres syncs, variable `OPENFRONT_SKAILEX_ACCESS`). Sans lui
  la sync fonctionne mais beaucoup plus lentement (429 fréquents).
- `games` est optionnel (valeurs par défaut ci-dessus).

### 2. Tables

Rien à faire : le premier lancement de `api/games-sync.php` crée les tables
tout seul (`CREATE TABLE IF NOT EXISTS`). En cas de MySQL restreint, importer
`api/games-install.sql` via phpMyAdmin.

### 3. Cron cPanel

cPanel → Cron Jobs → ajouter (toutes les 10 minutes) :

```
/usr/local/bin/php /home/USER/public_html/thefronthub.com/api/games-sync.php >> /home/USER/logs/games-sync.log 2>&1
```

(Adapte le chemin de php : `which php` en SSH, ou `php -v` ; o2switch : `/usr/local/bin/php`.)

### 4. Commandes utiles (SSH o2switch)

```bash
php api/games-sync.php --status          # état : compteurs + curseurs
php api/games-sync.php                   # tick normal (240 s max)
php api/games-sync.php --backfill=3600   # session backfill d'1 h
php api/games-sync.php --since=2026-09-10T00:00:00Z   # repositionner le curseur
php api/games-sync.php --reset-backfill  # remettre le curseur à maintenant
```

### 5. Backfill historique (depuis le 10 sept 2026)

Le backfill part de « maintenant » et remonte **newest → oldest** jusqu'à
l'epoch `2026-09-10T00:00Z`. Progression : fenêtres de 6 h par tick de
budget (420 s) ; accélère en lançant des sessions longues :

```bash
nohup php api/games-sync.php --backfill=14400 >> /home/USER/logs/games-backfill.log 2>&1 &
```

Pour tout récupérer dès le début : `--since=2026-09-10T00:00:00Z` puis des
sessions `--backfill` régulières (le cron suffit à terme).

## API JSON (frontend)

Toutes les réponses : `{ok:true,…}` / `{ok:false,error}` — cache 45-600 s.

| Endpoint | Description |
|---|---|
| `?route=recent&limit=30` | Dernières parties (Public + Private, tous modes) + gagnant lié |
| `?route=game&id=X` | Détail d'une partie + roster complet (publicId par joueur) |
| `?route=speedruns&category=normal\|compact&map=&sort=duration\|date&window=30d` | Records speedrun (offset 32 s appliqué à l'ingestion) |
| `?route=profile&publicId=X` | Pré-profil : alias, stats par mode, top cartes, meilleurs speedruns, dernières parties |
| `?route=profile&publicId=X&refresh=1` | Idem + fetch on-demand du profil officiel (cooldown 10 min) |
| `?route=search&q=` | Recherche joueur sur tous les alias connus |
| `?route=maps&category=` | Cartes + compteur de runs (filtre du front) |
| `?route=status` | Compteurs globaux (admin) |
| `?route=leaderboard&board=ffa\|team\|ranked` | Classement Glicko-2 interne (v5) |
| `?route=clans&window=all\|week\|Nd&sort=wins\|official` | Ladder des clans (agrégats roster + bloc `official` weightedWins API) |
| `?route=clan&tag=UN` | Détail d'un clan (membres, parties récentes, bloc `official`) |
| `?route=ladder` | **Ladder ranked OFFICIEL** (top 100 1v1 + 2v2 : elo, peakElo, W/L) |
| `?route=ladder&historyOf=PUBLICID` | Courbe ELO quotidienne d'un joueur du ladder |
| `?route=cosmetics...` / `?route=cosmetic...` | Catalogue cosmétiques + porteurs (v5) |
| `?route=replay&id=` | Replay turn-by-turn stocké en base (v5) |
| `?route=maps&category=` | Cartes + compteur de runs (filtre du front) |
| `?route=status` | Compteurs globaux (admin) |

Exemples :

```bash
curl "https://thefronthub.com/api/games-api.php?route=speedruns&map=Italy&limit=5"
curl "https://thefronthub.com/api/games-api.php?route=profile&publicId=syWkxQyM"
```

## v5.11 — API officielles OpenFront (clans, classé, profils)

Le cron synchronise en plus, chaque tick, les 3 API officielles restantes :

| Source | Table(s) | Rythme |
|---|---|---|
| `/leaderboard/ranked?page=1..2` (top 100 1v1/2v2) | `tfh_g_ladder` (snapshot) + `tfh_g_ladder_history` (1 ligne/joueur/jour) | 30 min |
| `/public/clans/leaderboard` (top 100 weightedWins ~90 j) | colonnes `lb_*` de `tfh_g_clans` | 1 h |
| `/public/player/:id` (stats de compte complètes) | `tfh_g_profiles` (arbre stats JSON, username, createdAt) | budget 45 s/tick (~90 profils), priorité joueurs récents, refresh 14 j |

Notes :
- Les profils officiels couvrent **Private/Singleplayer** et l'historique
  antérieur à notre ingestion — c'est la même source que ofstats.
- 404 sur `/public/player/:id` = compte supprimé → `not_found=1` + tombstone
  joueur (même signal que le poll `recently-deleted`).
- `/public/clan/:tag` et `/public/clan/:tag/sessions` sont limités à **1 jour
  par requête** côté API → pas de lifetime officiel ; nos agrégats roster
  (`tfh_g_clans.participations/wins`) comblent ça depuis l'epoch.
- Le fetch des routes « officielles » réessaie automatiquement avec des
  en-têtes navigateur si Cloudflare renvoie 403 (même contournement que le
  catalogue, v5.10c).
- Suivi : `--status` (bloc `v511`) et `route=status` (bloc `v511`).

## Volumes & quota

- ~7 000 parties publiques/jour + parties privées ; lobbies vides ignorés
  (seuil `min_players_to_keep`, défaut 1 joueur).
- ~1,5-2 M parties/an + ~40-50 M lignes roster/an ≈ **3-5 Go/an** avec index
  (dictionnaires normalisés : pseudos stockés une seule fois).
- `player_stats_mode=subset` : stats détaillées JSON par joueur stockées
  uniquement pour les candidats speedrun + classés (`all` = tout, plus lourd).

## Vérifications post-install

1. `--status` : `games` monte, `backfill_cursor` recule à chaque tick.
2. `https://thefronthub.com/api/games-api.php?route=status` répond `ok:true`.
3. runs.html : badge « DB pré-profils » en bas du tableau + filtres carte/catégorie.
4. Clic sur un joueur speedrun → profile.html avec le bloc « Historique TheFrontHub ».

## Nettoyage RGPD / demandes OpenFront

Le poll quotidien (`/public/players/recently-deleted`) marque les comptes
supprimés (`deleted_at`) — ils disparaissent de la recherche et des comptes
publics. Pour une purge réelle : passer `"games": {"hard_delete": true}` dans
les secrets (supprime roster + alias + joueur).
