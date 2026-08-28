# Cosmétiques & codes de récompense — TheFrontHub

> Documentation technique du système de skins (génération 2026-08).
> Catalogue frontend : `skins.js` + `skins.css` · Backend : `/api/skins.php`
> Tables MySQL : `tfh_reward_codes`, `tfh_user_skins` (voir `api/sql-upgrade-etape6.sql`)

## Catalogue actif

| id (DB)    | Nom        | Rareté     | Classe CSS      | Effet                                                   |
|------------|------------|------------|-----------------|---------------------------------------------------------|
| `default`  | Standard   | Commun     | `.skin-default` | Texte normal (jamais déblocable par code)               |
| `aurora`   | Aurore     | Épique     | `.skin-aurora`  | Dégradé boréal animé (turquoise → émeraude → violet), balayage 4,5 s |
| `dusk`     | Crépuscule | Légendaire | `.skin-dusk`    | Coucher de soleil animé (ambre → rose → violet), balayage 6 s |

Règles :
- `skin_id` doit matcher `^[a-z0-9_-]{1,32}$` (validé côté serveur ET frontend).
- Le pseudo skinné s'affiche sur le **profil** (hero). Les ids hérités de
  l'ancien catalogue (`gold`, `rainbow`, `fire`, … lignes `tfh_user_skins`
  antérieures à la refonte) sont **ignorés** par le frontend : fallback
  Standard, aucune erreur.
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
  -d '{"action":"createCode","code":"AURORA-LANCEMENT","skinId":"aurora","maxUses":null,"note":"Lancement skins v3"}'
```

Champs : `code` (min 3 car.), `skinId`, `maxUses` (null = illimité),
`note` (255 max), `expiresAt` (optionnel, ex. `"2026-12-31 23:59:59"`).
Nécessite un compte `role='admin'` dans `tfh_users`.

### Option B — SQL direct (phpMyAdmin)

```sql
-- Code illimité pour Aurore
INSERT INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by)
VALUES ('AURORA-LANCEMENT', 'aurora', NULL, 'Lancement skins v3', 'admin');

-- Code 50 usages, expirable, pour Crépuscule
INSERT INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by, expires_at)
VALUES ('DUSK-DROP-50', 'dusk', 50, 'Drop communauté', 'admin', '2026-12-31 23:59:59');

-- Suivi des rachats
SELECT code, skin_id, uses, max_uses, expires_at FROM tfh_reward_codes ORDER BY created_at DESC;
SELECT public_id, skin_id, code_used, active, redeemed_at FROM tfh_user_skins ORDER BY redeemed_at DESC;
```

### Codes de test utilisés en validation locale

`AURORA-2026` (aurora) et `DUSK-2026` (dusk) — codes factices du harnais de
test, **non insérés en base**.

## Ajouter un nouveau skin (checklist)

1. `skins.js` → entrée dans `SKINS` (`id`, `name`, `description`, `rarity`,
   `cssClass`).
2. `skins.css` → classe `.skin-<id>` + `@keyframes` dédiées (penser à
   `prefers-reduced-motion`).
3. Rebuild : `node scripts/build.js` + bump `dist/profile.min.js?v=N` dans
   `profile.html`, bump `skins.css?v=N`, bump `CACHE_NAME` dans `sw.js`.
4. Créer au moins un code (Option A ou B ci-dessus).
5. Aucune migration SQL : le catalogue vit côté frontend, la DB ne stocke
   que les ids référencés par les tables ci-dessus.
