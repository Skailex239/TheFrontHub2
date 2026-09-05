-- ════════════════════════════════════════════════════════════════════
-- TheFrontHub — Skin « Gerbe » (vert blé + gris) : 2 codes PERSO
-- À exécuter dans phpMyAdmin → base mask6607_thefronthub → onglet SQL
--
-- Catalogue concerné (skins.js / SKINS.md) :
--   gerbe = Gerbe (rare) — moisson animée : vert blé → vert gerbe →
--           gris pierre → gris sauge, balayage 5 s (classe .skin-gerbe)
--
-- ⚠️ RÈGLE CRITIQUE — CODES SANS TIRET :
--   Le serveur (api/skins.php, normalize_code) supprime TOUT caractère
--   non alphanumérique avant la recherche en base. Les codes en base
--   doivent être en MAJUSCULES A-Z 0-9 UNIQUEMENT.
--   L'utilisateur peut taper « gerbe 2026 », « GERBE-2026 » ou
--   « gerbe2026 » : toutes les variantes fonctionnent.
--
-- max_uses = 1 : chaque code est STRICTEMENT PERSONNEL (1 seul rachat).
-- Idempotent : INSERT IGNORE → ré-exécutable sans erreur ni doublon.
-- ════════════════════════════════════════════════════════════════════

-- Les 2 codes personnels (1 usage chacun)
INSERT IGNORE INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by) VALUES
  ('GERBE2026',   'gerbe', 1, 'Skin Gerbe — code perso (boss)',   'admin'),
  ('GLOBIGERBE',  'gerbe', 1, 'Skin Gerbe — code perso de Globi', 'admin');

-- Vérification : état des codes après insertion
SELECT code, skin_id, uses, max_uses, note, created_at
FROM tfh_reward_codes
WHERE skin_id = 'gerbe'
ORDER BY created_at DESC;

-- Suivi : qui a racheté le skin (à lancer quand tu veux)
-- SELECT public_id, skin_id, code_used, active, redeemed_at
-- FROM tfh_user_skins WHERE skin_id = 'gerbe' ORDER BY redeemed_at DESC;

-- ════════════════════════════════════════════════════════════════════
-- UTILITAIRES (si besoin)
-- ════════════════════════════════════════════════════════════════════
-- Repasser le compteur d'un code à zéro (ex. rachat de test à annuler) :
-- UPDATE tfh_reward_codes SET uses = 0 WHERE code = 'GERBE2026';
--
-- Désactiver un code immédiatement (il expire sur-le-champ) :
-- UPDATE tfh_reward_codes SET expires_at = NOW() WHERE code = 'GLOBIGERBE';
--
-- Supprimer un code non utilisé (les skins déjà rachetés restent acquis) :
-- DELETE FROM tfh_reward_codes WHERE code = 'GLOBIGERBE';
-- ════════════════════════════════════════════════════════════════════
