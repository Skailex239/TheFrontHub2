-- ─────────────────────────────────────────────────────────────────────────────
-- task/install.sql — Panel de tâches TheFrontHub
--
-- En temps normal, le panel crée ces tables TOUT SEUL au premier chargement
-- (CREATE TABLE IF NOT EXISTS). Ce fichier n'est utile que si le compte MySQL
-- de o2switch n'a pas le droit de créer des tables : exécute-le alors dans
-- phpMyAdmin (cPanel → Bases de données → phpMyAdmin → onglet SQL).
-- ─────────────────────────────────────────────────────────────────────────────

-- Comptes autorisés à ouvrir le panel
CREATE TABLE IF NOT EXISTS tfh_task_admins (
    discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
    role       VARCHAR(16) NOT NULL DEFAULT 'admin',   -- 'owner' | 'admin'
    added_by   VARCHAR(32) NOT NULL DEFAULT '',
    added_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tâches
CREATE TABLE IF NOT EXISTS tfh_task_tasks (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    title             VARCHAR(180) NOT NULL,
    description       TEXT NULL,
    status            VARCHAR(16) NOT NULL DEFAULT 'todo',      -- todo | in_progress | done
    priority          VARCHAR(16) NOT NULL DEFAULT 'normal',    -- low | normal | high
    assignee_id       VARCHAR(32) NULL,
    created_by        VARCHAR(32) NOT NULL,
    created_by_name   VARCHAR(64) NOT NULL DEFAULT '',
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_by      VARCHAR(32) NULL,
    completed_by_name VARCHAR(64) NULL,
    completed_at      DATETIME NULL,
    PRIMARY KEY (id),
    INDEX idx_task_status (status),
    INDEX idx_task_assignee (assignee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
