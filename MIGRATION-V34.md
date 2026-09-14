# Migration API v34 — TheFrontHub × OpenFrontIO

> **Statut : PRÊT — commit local, push volontairement NON effectué (attente de la sortie officielle v34).**
> Architecture **dual-stack** : le site fonctionne AVANT et APRÈS la bascule OpenFront, sans redéploiement.

---

## 1. Verdict des sondages live (2026-09-14, UTC)

| Sondage | Résultat | Interprétation |
|---|---|---|
| `GET api.openfront.io/cluster.json?site=openfront.io` | **404 `{"error":"Not found","reason":"Unknown site"}`** | Endpoint Server list v2 **déployé mais dormant** — site pas encore enregistré |
| `GET openfront.io/api/health` | `{"status":"ok"}` | Jeu en ligne |
| `openfront.io/commit.txt` | `577819b…` (≠ `blue` = `8b45be5…`) | Blue/green actifs, builds private-fork absents du repo public (normal) |
| Bundles client blue + green (cdn.ofedge.io) | **117 maps, SANS** Yangtze River / Cape Cod / Central America / Channel Islands / Gulf Of Mexico / Qing China ; **pas** de `trusted` ni `gitCommit`/`active` lobby | **La prod n'est PAS encore en schéma v34** |
| `/public/games`, `/public/player/{id}`, `/public/player/{id}/games?filter=ranked` | 200/400 Zod, chemins inchangés | **API HTTP publique inchangée** |
| `/leaderboard/ranked?page=N` | 200 | Inchangé |
| Game IDs | 8 caractères (`iG65yGyg`) | Élargissement 8→10 (v34) pas encore actif |
| Tag git OpenFrontIO | `v0.34.0-beta2` uniquement | **v0.34.0 finale pas encore taguée** |

**Conclusion : ni le jeu, ni les games, ni l'API ne sont encore en mode v34.**
Le schéma v34 est déjà dans `openfrontio/OpenFrontIO@main` (commit `f02d746` du 2026-09-12 + `99b23ae` Channel Islands), prêt à basculer.

### ⚠️ Bug découvert au passage (corrigé)
Le décodeur du site v5.14 contenait **118 maps AVEC « Yangtze River »** alors que la prod live n'en a que **117 SANS**. Les lobbies Yellow Sea / Yenisei étaient donc décalés d'un cran à l'affichage (et les lobbies China et au-delà l'auraient été si Yangtze était au milieu — il est en fin d'enum). Corrigé par la table legacy exacte 117.

---

## 2. Ce que change la v34 (repo `openfrontio/OpenFrontIO@1fdd75a`)

### 2.1 Schéma zbin (WebSockets lobbies `wss://<hôte>/w{N}/lobbies`)
| Élément | Legacy (prod actuelle) | V34 |
|---|---|---|
| `PublicLobbyFull` | `type`, `serverTime`, `games` | + `gitCommit: string.opt`, `active: bool.opt` (header de présence 0 → 1 octet) |
| `GameConfig` | …sans `trusted` | + `trusted: bool.opt` entre `allowedPublicIds` et `maxTimerValue` (+2 bits, décale la suite) |
| `GameMapType` | **117** maps | **123** maps : insérations AU MILIEU — Cape Cod (après Britannia Classic), Central America + Channel Islands (après Caucasus), Gulf Of Mexico (après Gulf Of Guinea), Qing China (après Pluto), Yangtze River (après World Inverted) |
| `PublicLobbyCounts` | identique | identique |

### 2.2 Server list v2 (découverte des hôtes)
- Client : `GET api.<domain>/cluster.json?site=<host>` toutes les 30 s → `{ latest, servers: { lettre: { host, numWorkers, version, state } } }`.
- Serveurs de jeu : `POST api.<domain>/cluster/checkin` toutes les 10 s.
- Pages statiques versionnées `/v/<commit>/`, flag `latest`.
- Switch effectif quand `CLUSTER_STATE_SOURCE=api` + site enregistré (aujourd'hui 404 → fallback).

### 2.3 API HTTP publique
- **Chemins inchangés** (`/public/*`, `/leaderboard/ranked`).
- Le champ `games` de `/public/player/{id}` **n'existe plus** → historique via `/public/player/{id}/games?filter=ffa|team|hvn|ranked&type=…&cursor=…` (10/page, `results[]`, `nextCursor`, `result` ∈ victory/defeat/incomplete, `username` = identité du joueur interrogé dans la partie).

### 2.4 Divers
- Game IDs 8 → 10 caractères.
- Matchmaking WS : `wss://api.<domain>/matchmaking/join` (sur l'**API**, pas le master) ; close codes 4100-4102 (+ legacy 1008/1011 en transition).

---

## 3. Correctifs appliqués (fichiers modifiés)

| # | Fichier | Changement |
|---|---|---|
| 1 | `lobby-wire.js` → **v6.0 dual-stack** | 2 variantes de schéma (legacy 117 maps / v34 123 maps + trusted + gitCommit/active). Détection **déterministe** par frame : dans un `full`, l'octet après le tag est le 1ᵉʳ octet du varint `serverTime` (Date.now() ms ⇒ MSB=1) en legacy, ou le header de présence (≤ 0x07, MSB=0) en v34. Décodage avec la variante détectée, retente l'autre en cas d'échec, sanity-check `serverTime`. Exporte `GAME_MAP_LEGACY`, `GAME_MAP_V34`, `SCHEMA_VARIANTS`. Les messages v34 exposent `msg.gitCommit`, `msg.active`, `msg._schema`. |
| 2 | `scripts/test-lobby-wire-v34.js` | Encodeur zbin spec-driven (miroir du décodeur) + **9 tests round-trip** (legacy, v34 avec/sans gitCommit/active, counts, maps Yenisei/Channel Islands, configs réalistes FFA/team/hosted, hosted featured v34, cohérence des tables). `node scripts/test-lobby-wire-v34.js` → 9/9. |
| 3 | `lobby.js` | Résolution dynamique des hôtes WS : `fetchClusterJson()` (proxy CF → proxy Next → API directe), `refreshLobbyHosts()` (TTL 5 min, fallback legacy si 404/vide), `pickLobbyWsUrl()` au lieu de l'URL codée en dur. Log du build serveur (`gitCommit`/`active`) quand présent. |
| 4 | `cloudflare-worker/openfront-proxy.js` | `/lobby-ws` : upstream résolu via `cluster.json?site=` (cache mémoire 30 s, param `?site=`), fallback legacy **w0-w19** (aligné sur le front, l'ancien pool w0-w4 était périmé). `/matchmaking-ws` : host corrigé → `wss://api.openfront.io/matchmaking/join`. |
| 5 | `sync-lobby-state.js` | `resolveLobbyWsUrl()` (timeout 4 s) avant la connexion WS de l'Action ; fallback legacy `wss://openfront.io/w0/lobbies`. |
| 6 | `app.js` `showRankedPlayerModal` | `pData.games` (champ mort) → `/public/player/{id}/games?filter=ranked` + curseur (≤ 6 pages). W/L via `result` (plus de `hasWon`/`clientId`/`winner[1]`). Adversaire identifié par pseudo ≠ identité de la partie. |
| 7 | `sync-ranked.js` `enrichStreaks` | Même migration (≤ 4 pages), filtre `rankedType === mode`, streak sur `result`. |
| 8 | `lobby.html` | Bumps cache : `lobby-wire.min.js?v=5`, `lobby.min.js?v=9`. |
| 9 | `index.html` | Bump cache : `app.min.js?v=33`. |
| 10 | `dist/` | Rebuild complet (`node scripts/build.js`) ; bundle minifié validé en sandbox VM (identique à la source). |

---

## 4. Checklist post-bascule v34 (quand OpenFront aura switché)

1. **Surveiller** `GET https://api.openfront.io/cluster.json?site=openfront.io` :
   - 404 → rien à faire (dormant) ;
   - 200 avec `servers` → le site bascule automatiquement (lobby.js + worker + sync-lobby-state lisent cluster.json).
2. **Vérifier le lobby** (thefronthub.com/lobby.html) : cartes visibles, noms de cartes corrects (notamment les nouvelles), compteurs joueurs qui bougent (`counts`).
3. **Console navigateur** : `[lobby] Server list v2 : N hôte(s)` + `[lobby] serveur build=xxxxxxx` = bascule confirmée côté site.
4. **Modal ranked** (index) : ouvrir un joueur du top, vérifier les 10 dernières parties + la série.
5. **GitHub Action** sync (`sync.yml`) : run vert, `lobby_state.json` rafraîchi (`lobbyGames > 0` aux heures de pointe).
6. **Worker Cloudflare** : redéployer le Worker (Dashboard → Quick edit → coller `cloudflare-worker/openfront-proxy.js` → Deploy). **C'est la seule action manuelle requise** (le Worker ne se redéploie pas tout seul).
7. Si un nouveau champ zbin apparaît encore (v35+) : refaire la passe « dériver les tables de Schemas.ts / Maps.gen.ts » (voir §5).

### Déploiement o2switch (après push)
```bash
# deploy.sh (cron o2switch) fait : git pull + rsync
# déclencher manuellement si besoin :
bash deploy.sh
```
Puis bump des versions de cache si de nouveaux fichiers front sont touchés.

---

## 5. Guide « re-dérivation » du schéma zbin (pour les futures versions)

1. `src/core/Schemas.ts` → `PublicLobbyMessageSchema`, `PublicLobbyFullSchema`, `PublicLobbyCountsSchema`, `PublicGameInfoSchema`, `GameConfigSchema` (ordre des champs = ordre wire).
2. `src/core/game/Maps.gen.ts` → enum `GameMapType` (ordinal = position de déclaration).
3. `src/core/game/Game.ts` → enums `Difficulty`, `GameType`, `GameMode`, `RankedType`, `GameMapSize`, `UnitType`.
4. Règles zbin (`zbin/README.md`) : pas de version byte, pas de tags ; header de présence `ceil(bits/8)` octets, bits alloués par champ dans l'ordre : (présence si opt, null si nullable, valeur si bool) — LSB d'abord ; bools et littéraux n'écrivent pas d'octets de corps.
5. Tester : `node scripts/test-lobby-wire-v34.js` + capturer une frame live (`wss://…/w0/lobbies`) et la décoder.

---

## 6. Risques résiduels / notes

- **Le push est volontairement en attente** (consigne Skailex : attendre la sortie officielle v34). Le commit local est prêt : `git push` quand bon vous semble.
- Si OpenFront déploie v34 SANS enregistrer le site dans la Server list (404 persistant), le site reste en legacy — mais les frames passeront en schéma v34 : le décodeur dual-stack gère les deux, **sans action requise**.
- Le proxy WS du Worker vers `openfront.io` peut être 403/502 depuis certains réseaux (Cloudflare gère les IP datacenter) : le front a déjà 3 niveaux (direct → proxy → lobby_state.json).
- `sync-player-games.js` / `compute-player-stats.js` utilisent déjà `/public/player/{id}/games` (curseur) : compatibles tels quels ; surveiller `durationSeconds`/`rankedType` en cas de changement de schéma côté API.
- Le champ `map: "?"` de `recentHistory` dans `lobby_state.json` est une limite V1 connue (l'API `/public/games` ne renvoie pas `gameMap`) — non lié à la v34.
