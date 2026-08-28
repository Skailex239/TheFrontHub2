# Cosmétiques & codes de récompense — TheFrontHub

> Documentation technique du système de skins (génération 2026-08).
> Catalogue frontend : `skins.js` + `skins.css` · Backend : `/api/skins.php`
> Tables MySQL : `tfh_reward_codes`, `tfh_user_skins` (voir `api/sql-upgrade-etape6.sql`)

## Catalogue actif

| id (DB)    | Nom        | Rareté     | Classe CSS      | Effet                                                   |
|------------|------------|------------|-----------------|---------------------------------------------------------|
| `default`  | Standard   | Commun     | `.skin-default` | Texte normal (jamais déblocable par code)               |
| `lagon`    | Lagon      | Rare       | `.skin-lagon`   | Eaux turquoise animées (cyan → bleu → indigo), 5 s      |
| `aurora`   | Aurore     | Épique     | `.skin-aurora`  | Dégradé boréal animé (turquoise → émeraude → violet), balayage 4,5 s |
| `braise`   | Braise     | Épique     | `.skin-braise`  | Braises animées (ambre → orange → rouge), balayage 5,5 s |
| `dusk`     | Crépuscule | Légendaire | `.skin-dusk`    | Coucher de soleil animé (ambre → rose → violet), balayage 6 s |
| `prisme`   | Prisme     | Mythique   | `.skin-prisme`  | Spectre prismatique complet (6 couleurs pures), balayage 7 s |

Règles :
- `skin_id` doit matcher `^[a-z0-9_-]{1,32}$` (validé côté serveur ET frontend).
- Le pseudo skinné s'affiche **partout** où un pseudo de compte apparaît :
  profil (hero + profil public), index (leaderboards speedruns, classement
  global, feed, Hall of Fame, ranked 1v1/2v2, modal joueur, carte « mon
  rang »), dashboard (leaderboard) et page speedruns (runs). Les classes
  `.skin-*` vivent dans `styles.css` (chargé sur toutes les pages) ; la
  map publique `publicId/username → skin actif` est chargée en UNE
  requête via `GET /api/skins.php?activeMap=1` (cache 60 s côté client,
  poll 60 s sur l'index). Les ids hérités de l'ancien catalogue (`gold`,
  `rainbow`, `fire`, … lignes `tfh_user_skins` antérieures à la refonte)
  sont **ignorés** par le frontend : fallback Standard, aucune erreur.
- Les animations respectent `prefers-reduced-motion` (arrêt du dégradé).

## Flux utilisateur (page profil)

1. La carte **« Code de récompense »** affiche *uniquement* le champ de saisie.
2. Saisie → normalisation auto (MAJUSCULES, A-Z 0-9 et tirets).
3. `POST /api/skins.php {action:'redeem', code, publicId}` — transaction
   serveur : code existant, non expiré, usage < max, pas déjà possédé.
4. **Auto-activation** : le skin est immédiatement appliqué au pseudo
   (`action:'activate'`), la ligne « Mes cosmétiques » apparaît avec les
   chips (Standard + skins possédés). Cliquer une chip change le skin actif.
5. Un re-saisie d'un code déjà possédé → message « déjà dans ta collection —
   réactivé » + réactivation.

## Créer des codes (admin)

### Option A — API (recommandé)

```bash
curl -X POST https://thefronthub.com/api/skins.php \
  -H 'Content-Type: application/json' \
  -b "<cookie de session admin>" \
  -d '{"action":"createCode","code":"AURORALANCEMENT","skinId":"aurora","maxUses":null,"note":"Lancement skins v3"}'
```

Champs : `code` (min 3 car.), `skinId`, `maxUses` (null = illimité),
`note` (255 max), `expiresAt` (optionnel, ex. `"2026-12-31 23:59:59"`).
Nécessite un compte `role='admin'` dans `tfh_users`.
L'API normalise automatiquement le code (majuscules, tirets supprimés) :
`AURORA-LANCEMENT` est stocké `AURORALANCEMENT`.

### Option B — SQL direct (phpMyAdmin)

> 📄 Fichier prêt à l'emploi : **`api/sql-skins-lancement-2026.sql`**
> (les 5 codes de lancement + variantes commentées).

> ⚠️ **CODES SANS TIRET EN BASE** : le serveur (`normalize_code` dans
> `api/skins.php`) supprime tout caractère non alphanumérique avant la
> recherche. Un code stocké `AURORA-2026` ne serait **jamais** trouvé
> (le serveur cherche `AURORA2026`). En base : MAJUSCULES A-Z 0-9
> uniquement. Les joueurs, eux, peuvent taper `aurora 2026`,
> `AURORA-2026` ou `aurora2026` — toutes les variantes fonctionnent.

```sql
-- Code illimité pour Aurore (code SANS tiret en base !)
INSERT IGNORE INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by)
VALUES ('AURORALANCEMENT', 'aurora', NULL, 'Lancement skins v3', 'admin');

-- Code 50 usages, expirable, pour Crépuscule
INSERT IGNORE INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by, expires_at)
VALUES ('DUSKDROP50', 'dusk', 50, 'Drop communauté', 'admin', '2026-12-31 23:59:59');

-- Suivi des rachats
SELECT code, skin_id, uses, max_uses, expires_at FROM tfh_reward_codes ORDER BY created_at DESC;
SELECT public_id, skin_id, code_used, active, redeemed_at FROM tfh_user_skins ORDER BY redeemed_at DESC;
```

### Codes de lancement 2026

`LAGON2026`, `AURORA2026`, `BRAISE2026`, `DUSK2026`, `PRISME2026`
(voir `api/sql-skins-lancement-2026.sql`). Codes des tests de validation
locale = les mêmes, simulés par le harnais mock, pas d'effet en base.

## Ajouter un nouveau skin (checklist)

1. `skins.js` → entrée dans `SKINS` (`id`, `name`, `description`, `rarity`,
   `cssClass`).
2. `skins.css` n'héberge PLUS les classes `.skin-*` : elles vivent dans
   `styles.css` (fin de fichier, section « Skins de pseudo ») pour être
   chargées sur toutes les pages. Penser à `prefers-reduced-motion`.
3. Rebuild : `node scripts/build.js` + bump les versions référencées :
   `styles.css?v=N` (toutes les pages), `dist/profile.min.js?v=N` et
   `dist/app.min.js?v=N` / `dist/dashboard.min.js?v=N` (catalogue bundlé),
   `CACHE_NAME` dans `sw.js`.
4. Créer au moins un code (Option A ou B ci-dessus).
5. Aucune migration SQL : le catalogue vit côté frontend, la DB ne stocke
   que les ids référencés par les tables ci-dessus.
