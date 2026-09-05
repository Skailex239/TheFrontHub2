-- ════════════════════════════════════════════════════════════════════
-- TheFrontHub — Support & messagerie (tickets joueur ↔ équipe)
-- À exécuter dans phpMyAdmin → base mask6607_thefronthub → onglet SQL
-- NOTE : api/support.php auto-crée ces tables au premier appel (errno 1146).
--        Ce script n'est utile que pour un passage MANUEL éventuel.
-- Idempotent : peut être ré-exécuté sans casse (CREATE TABLE IF NOT EXISTS)
-- ════════════════════════════════════════════════════════════════════

-- 1) Tickets de support — une ligne = une conversation
CREATE TABLE IF NOT EXISTS tfh_support_tickets (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,             -- joueur (tfh_users.id)
  category   VARCHAR(24) NOT NULL DEFAULT 'autre', -- question|bug|signalement|idee|autre
  subject    VARCHAR(140) NOT NULL,             -- sujet court du ticket
  status     VARCHAR(16) NOT NULL DEFAULT 'open',  -- open|answered|closed
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user (user_id, updated_at),
  KEY idx_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Messages d'un ticket — le 1er message = le message d'ouverture
CREATE TABLE IF NOT EXISTS tfh_support_messages (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id   INT UNSIGNED NOT NULL,
  author_role VARCHAR(8) NOT NULL DEFAULT 'user', -- user|team
  user_id     INT UNSIGNED DEFAULT NULL,          -- auteur (joueur ou admin)
  body        TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ticket (ticket_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
