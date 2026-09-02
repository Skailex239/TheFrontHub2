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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tâches
CREATE TABLE IF NOT EXISTS tfh_task_tasks (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    title             VARCHAR(180) NOT NULL,
    description       TEXT NULL,
    status            VARCHAR(16) NOT NULL DEFAULT 'todo',      -- todo | in_progress | done
    priority          VARCHAR(16) NOT NULL DEFAULT 'normal',    -- low | normal | high
    assignee_id       VARCHAR(32) NULL,
    labels            VARCHAR(250) NOT NULL DEFAULT '',         -- clés d'étiquettes en CSV
    pinned            TINYINT(1) NOT NULL DEFAULT 0,
    milestone         VARCHAR(80) NOT NULL DEFAULT '',          -- version / jalon (texte libre)
    due_at            DATE NULL,
    archived_at       DATETIME NULL,
    created_by        VARCHAR(32) NOT NULL,
    created_by_name   VARCHAR(64) NOT NULL DEFAULT '',
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_by      VARCHAR(32) NULL,
    completed_by_name VARCHAR(64) NULL,
    completed_at      DATETIME NULL,
    PRIMARY KEY (id),
    INDEX idx_task_status (status),
    INDEX idx_task_assignee (assignee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sous-tâches / checklists des tâches
CREATE TABLE IF NOT EXISTS tfh_task_checklist (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    task_id    INT UNSIGNED NOT NULL,
    body       VARCHAR(200) NOT NULL,
    done       TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_ck_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Commentaires sur les tâches
CREATE TABLE IF NOT EXISTS tfh_task_comments (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    task_id     INT UNSIGNED NOT NULL,
    author_id   VARCHAR(32) NOT NULL,
    author_name VARCHAR(64) NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_c_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historique d'activité
CREATE TABLE IF NOT EXISTS tfh_task_activity (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    task_id    INT UNSIGNED NULL,
    task_title VARCHAR(180) NOT NULL DEFAULT '',
    actor_id   VARCHAR(32) NOT NULL DEFAULT '',
    actor_name VARCHAR(64) NOT NULL DEFAULT '',
    action     VARCHAR(24) NOT NULL,
    detail     VARCHAR(500) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_a_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Réglages du panel (webhook Discord, etc.)
CREATE TABLE IF NOT EXISTS tfh_task_settings (
    skey   VARCHAR(64) NOT NULL PRIMARY KEY,
    svalue TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
