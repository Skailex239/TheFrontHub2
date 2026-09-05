-- ════════════════════════════════════════════════════════════════════
-- TheFrontHub — UPGRADE langue du compte (FR/EN)
-- À exécuter dans phpMyAdmin → base mask6607_thefronthub → onglet SQL
-- Idempotent : peut être ré-exécuté sans casse (IF NOT EXISTS).
--
-- Ajoute la préférence de langue du joueur :
--   'fr' par défaut ; 'en' si le joueur a choisi l'anglais.
-- Écrite par /api/language.php (choix à l'inscription + switch drapeaux),
-- lue par /api/me.php (champ "language") pour appliquer la langue du
-- compte sur un nouvel appareil.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE tfh_users
  ADD COLUMN IF NOT EXISTS language VARCHAR(5) NOT NULL DEFAULT 'fr'
  AFTER locale;
