-- ════════════════════════════════════════════════════════════════════
-- TheFrontHub — Codes de récompense : LANCEMENT des 5 skins de texte
-- À exécuter dans phpMyAdmin → base mask6607_thefronthub → onglet SQL
--
-- Catalogue concerné (skins.js / SKINS.md) :
--   lagon   = Lagon       (rare)       — dégradé marin cyan/bleu/indigo
--   aurora  = Aurore      (épique)     — dégradé boréal turquoise/émeraude/violet
--   braise  = Braise      (épique)     — braises ambre/orange/rouge
--   dusk    = Crépuscule  (légendaire) — coucher de soleil ambre/rose/violet
--   prisme  = Prisme      (mythique)   — spectre prismatique 6 couleurs
--
-- ⚠️ RÈGLE CRITIQUE — CODES SANS TIRET :
--   Le serveur (api/skins.php, normalize_code) supprime TOUT caractère
--   non alphanumérique avant la recherche en base. Un code stocké
--   « AURORA-2026 » ne serait JAMAIS trouvé (le serveur cherche
--   « AURORA2026 »). Les codes en base doivent donc être en MAJUSCULES
--   A-Z 0-9 UNIQUEMENT, sans tirets ni espaces.
--   L'utilisateur, lui, peut taper « aurora 2026 », « AURORA-2026 » ou
--   « aurora2026 » : toutes les variantes fonctionnent.
--
-- Idempotent : INSERT IGNORE → peut être ré-exécuté sans erreur ni
-- doublon (les codes existants ne sont PAS modifiés, leur compteur
-- d'utilisations est préservé).
-- ════════════════════════════════════════════════════════════════════

-- 1) Les 5 codes de lancement (illimités, sans expiration)
INSERT IGNORE INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by) VALUES
  ('LAGON2026',   'lagon',   NULL, 'Lancement skins 2026 — Lagon (rare)',       'admin'),
  ('AURORA2026',  'aurora',  NULL, 'Lancement skins 2026 — Aurore (épique)',    'admin'),
  ('BRAISE2026',  'braise',  NULL, 'Lancement skins 2026 — Braise (épique)',    'admin'),
  ('DUSK2026',    'dusk',    NULL, 'Lancement skins 2026 — Crépuscule (légendaire)', 'admin'),
  ('PRISME2026',  'prisme',  NULL, 'Lancement skins 2026 — Prisme (mythique)',  'admin');

-- 2) Vérification : état des codes après insertion
SELECT code, skin_id, uses, max_uses, expires_at, note, created_at
FROM tfh_reward_codes
ORDER BY created_at DESC;

-- 3) Suivi des rachats joueurs (optionnel — à lancer quand tu veux)
-- SELECT public_id, skin_id, code_used, active, redeemed_at
-- FROM tfh_user_skins ORDER BY redeemed_at DESC;

-- ════════════════════════════════════════════════════════════════════
-- VARIANTES (à adapter selon tes campagnes futures)
-- ════════════════════════════════════════════════════════════════════
--
-- Code à usage LIMITÉ (ex. 100 rachats max, drop communauté) :
-- INSERT IGNORE INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by)
-- VALUES ('PRISMEDROP100', 'prisme', 100, 'Drop communauté — 100 premiers', 'admin');
--
-- Code TEMPORAIRE (ex. expire fin 2026) :
-- INSERT IGNORE INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by, expires_at)
-- VALUES ('DUSKFIN2026', 'dusk', NULL, 'Campagne de fin d’année', 'admin', '2026-12-31 23:59:59');
--
-- Désactiver un code sans le supprimer (le faire expirer immédiatement) :
-- UPDATE tfh_reward_codes SET expires_at = NOW() WHERE code = 'LAGON2026';
--
-- Supprimer définitivement un code (les skins déjà rachetés restent acquis) :
-- DELETE FROM tfh_reward_codes WHERE code = 'LAGON2026';
-- ════════════════════════════════════════════════════════════════════
