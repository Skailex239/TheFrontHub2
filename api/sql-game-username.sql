-- ════════════════════════════════════════════════════════════════════
-- TheFrontHub — UPGRADE « pseudo en jeu » (fusion des pseudos partout)
-- À exécuter dans phpMyAdmin → base mask6607_thefronthub → onglet SQL
-- Idempotent : peut être ré-exécuté sans casse (IF NOT EXISTS).
--
-- PROBLÈME : depuis la migration Firestore → MySQL, la table
-- tfh_public_aliases ne conserve plus que le pseudo hub (choisi dans les
-- paramètres). Les leaderboards (speedruns, dashboard…) affichent le
-- pseudo EN JEU (OpenFront) : sans la correspondance pseudo en jeu →
-- publicId, le pseudo hub ne peut plus être affiché à la place.
--
-- SOLUTION : nouvelle colonne game_username = pseudo OpenFront actuel
-- du joueur, récupéré automatiquement côté serveur
-- (api.openfront.io/public/player/{publicId}) par /api/public-aliases.php
-- et exposé dans le champ "aliases" → toutes les pages refusionnent.
--
-- ⚠️ À exécuter AVANT de déployer le code (comme sql-language.sql).
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE tfh_public_aliases
  ADD COLUMN IF NOT EXISTS game_username VARCHAR(64) NULL DEFAULT NULL
  AFTER public_id;
