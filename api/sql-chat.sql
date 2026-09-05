-- ─────────────────────────────────────────────────────────────────────────────
-- api/sql-chat.sql — schéma du chat en direct joueur ↔ équipe
--
-- La table est AUTO-CRÉÉE au premier appel de api/chat.php (errno 1146).
-- Ce fichier documente le schéma pour un passage manuel éventuel en cPanel
-- (phpMyAdmin → base tfh_* → SQL).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tfh_support_chat (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    conv_id VARCHAR(32) NOT NULL,                       -- ID Discord du joueur
    author_role VARCHAR(8) NOT NULL DEFAULT 'user',     -- user | admin
    author_name VARCHAR(64) NOT NULL DEFAULT '',        -- pseudo affiché
    body TEXT NOT NULL,
    read_by_user TINYINT(1) NOT NULL DEFAULT 0,         -- réponses équipe vues par le joueur
    read_by_admin TINYINT(1) NOT NULL DEFAULT 0,        -- messages joueur vus par l'équipe
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_conv (conv_id, id),
    KEY idx_admin_unread (read_by_admin, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
