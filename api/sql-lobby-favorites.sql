-- api/sql-lobby-favorites.sql — Cartes favorites du Lobby
-- ──────────────────────────────────────────────────────────────────────
-- La table est auto-créée à la première requête par api/favorites.php
-- (CREATE TABLE IF NOT EXISTS). Ce script existe pour un passage manuel
-- éventuel via phpMyAdmin (cPanel o2switch) — l'exécuter est donc
-- OPTIONNEL, il est idempotent.

CREATE TABLE IF NOT EXISTS tfh_fav_maps (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    map_slug VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_user_map (user_id, map_slug),
    KEY idx_map_slug (map_slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
