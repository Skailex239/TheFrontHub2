-- ════════════════════════════════════════════════════════════════════
-- TheFrontHub — UPGRADE étape 6 : likes + skins + codes de récompense
-- À exécuter dans phpMyAdmin → base mask6607_thefronthub → onglet SQL
-- Idempotent : peut être ré-exécuté sans casse (DROP + CREATE des tables vides)
-- ════════════════════════════════════════════════════════════════════

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS tfh_likes, tfh_user_skins, tfh_reward_codes;
SET FOREIGN_KEY_CHECKS = 1;

-- 1) Cœurs "GG" sur les runs (remplace la collection Firestore likes/{runId})
-- Une ligne = un like d'un joueur sur un run. Le compteur = COUNT(*).
CREATE TABLE tfh_likes (
  run_id     VARCHAR(64) NOT NULL,          -- identifiant du run OpenFront
  user_id    BIGINT UNSIGNED NOT NULL,      -- joueur TFH qui like
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, user_id),            -- un like unique par joueur et par run
  KEY idx_user (user_id),
  KEY idx_run_created (run_id, created_at),
  CONSTRAINT fk_like_user FOREIGN KEY (user_id)
    REFERENCES tfh_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Skins possédés par les joueurs (remplace user-skins/{publicId_skinId})
CREATE TABLE tfh_user_skins (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id   VARCHAR(64) NOT NULL,          -- identifiant public OpenFront du joueur
  skin_id     VARCHAR(32) NOT NULL,          -- ex: gold, prism, cyberpunk...
  code_used   VARCHAR(64) DEFAULT NULL,      -- code avec lequel le skin a été obtenu
  active      TINYINT(1) NOT NULL DEFAULT 0, -- skin actuellement affiché
  redeemed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pid_skin (public_id, skin_id),  -- un skin ne peut être possédé qu'une fois
  KEY idx_pid_active (public_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) Codes de récompense (remplace reward-codes/{code})
CREATE TABLE tfh_reward_codes (
  code       VARCHAR(64) PRIMARY KEY,        -- code normalisé (majuscules A-Z0-9)
  skin_id    VARCHAR(32) NOT NULL,           -- skin accordé par ce code
  max_uses   INT UNSIGNED DEFAULT NULL,      -- NULL = illimité
  uses       INT UNSIGNED NOT NULL DEFAULT 0,
  note       VARCHAR(255) DEFAULT NULL,
  created_by VARCHAR(64) DEFAULT NULL,
  expires_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_skin (skin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) Colonne cache sessions OpenFront (équivalent du champ Firestore
--    users.openFrontSessions — lu par app.js pour la fusion des pseudos)
ALTER TABLE tfh_users
  ADD COLUMN openfront_sessions JSON DEFAULT NULL AFTER discord_created_at;
