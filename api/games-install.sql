-- ─────────────────────────────────────────────────────────────────────────────
-- api/games-install.sql — Base "parties & pré-profils" TheFrontHub (o2switch)
--
-- Stocke TOUTES les parties publiques OpenFront (depuis l'ère publicID :
-- ~2025-09-10 06:00 UTC) avec leur roster complet lié par publicId, et les
-- pré-profils joueurs (agrégats par publicId).
--
-- ⚙️ Auto-install : le script api/games-sync.php crée ces tables tout seul au
-- premier lancement (CREATE TABLE IF NOT EXISTS). Ce fichier n'est utile que
-- si tu veux les créer à la main : phpMyAdmin (cPanel → Bases de données →
-- phpMyAdmin → onglet SQL → coller → Exécuter).
--
-- Volume estimé : ~1,5-2 M parties/an, ~40-50 M lignes roster/an (~3-5 Go/an).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pré-profils : un joueur = un publicId ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tfh_g_players (
    public_id     VARCHAR(16)  NOT NULL PRIMARY KEY,
    last_username VARCHAR(64)  NULL,                -- dernier pseudo en jeu vu
    first_seen    DATETIME     NOT NULL,
    last_seen     DATETIME     NOT NULL,
    last_game_id  VARCHAR(16)  NULL,
    games_count   INT UNSIGNED NOT NULL DEFAULT 0,  -- parties rosterées
    wins_count    INT UNSIGNED NOT NULL DEFAULT 0,
    deleted_at    DATETIME     NULL,                -- /public/players/recently-deleted
    INDEX idx_gplayers_seen (last_seen),
    INDEX idx_gplayers_games (games_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Dictionnaire de pseudos (chaque pseudo stocké UNE seule fois) ────────────
CREATE TABLE IF NOT EXISTS tfh_g_usernames (
    id       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64)  NOT NULL,
    norm     VARCHAR(64)  NOT NULL,                -- minuscule, sans [TAG]/suffixe (recherche)
    UNIQUE KEY uq_gusername (username),
    INDEX idx_gusername_norm (norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Pseudos utilisés par chaque joueur (historique d'identité) ───────────────
CREATE TABLE IF NOT EXISTS tfh_g_aliases (
    public_id  VARCHAR(16)  NOT NULL,
    username_id INT UNSIGNED NOT NULL,
    first_seen DATETIME     NOT NULL,
    last_seen  DATETIME     NOT NULL,
    times_used INT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (public_id, username_id),
    INDEX idx_galias_uname (username_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Parties : métadonnées complètes + speedrun pré-calculé ───────────────────
CREATE TABLE IF NOT EXISTS tfh_g_games (
    game_id            VARCHAR(16)     NOT NULL PRIMARY KEY,
    started_at         DATETIME(3)     NOT NULL,
    ended_at           DATETIME(3)     NULL,
    duration_s         SMALLINT UNSIGNED NULL,
    game_type          VARCHAR(16)     NULL,       -- Public | Private | Singleplayer
    game_mode          VARCHAR(20)     NULL,       -- 'Free For All' | 'Team'
    ranked_type        VARCHAR(12)     NULL,       -- unranked | 1v1 | 2v2
    player_teams       VARCHAR(16)     NULL,       -- brut API : 'Duos', '4', ...
    game_map           VARCHAR(48)     NULL,
    map_size           VARCHAR(16)     NULL,       -- Normal | Compact | ...
    difficulty         VARCHAR(16)     NULL,
    bots               SMALLINT UNSIGNED NULL,
    num_players        SMALLINT UNSIGNED NULL,     -- humains (liste API)
    max_players        SMALLINT UNSIGNED NULL,
    lobby_fill_time    INT UNSIGNED    NULL,
    winner_kind        VARCHAR(8)      NULL,       -- player | team | nation
    winner_public_id   VARCHAR(16)     NULL,
    winner_username_id INT UNSIGNED    NULL,
    -- Speedrun pré-calculé à l'ingestion (mêmes règles que extract-speedrun.js,
    -- offset 32s inclus) : NULL si la partie n'est pas un speedrun valide.
    speedrun_category  VARCHAR(10)     NULL,       -- normal | compact
    speedrun_duration_s SMALLINT UNSIGNED NULL,     -- durée - 32s
    mods               VARCHAR(128)    NULL,       -- modificateurs actifs (CSV)
    git_commit         VARCHAR(16)     NULL,
    ingested_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ggames_started (started_at),
    INDEX idx_ggames_sr (speedrun_category, game_map, speedrun_duration_s),
    INDEX idx_ggames_winner (winner_public_id),
    INDEX idx_ggames_ranked (ranked_type, started_at),
    INDEX idx_ggames_mode (game_mode, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Roster : qui a joué chaque partie (lien game ↔ publicId) ─────────────────
CREATE TABLE IF NOT EXISTS tfh_g_roster (
    game_id    VARCHAR(16)  NOT NULL,
    client_id  VARCHAR(16)  NOT NULL,               -- sessionId de la partie
    public_id  VARCHAR(16)  NULL,                   -- NULL = partie pré-ère publicID
    username_id INT UNSIGNED NOT NULL,
    won        TINYINT(1)   NOT NULL DEFAULT 0,
    -- Stats détaillées du joueur dans la partie (JSON compact). Rempli selon
    -- GAMES_PLAYER_STATS_MODE (subset = candidats speedrun + ranked uniquement).
    stats_json MEDIUMTEXT   NULL,
    PRIMARY KEY (game_id, client_id),
    INDEX idx_groster_pid (public_id, game_id),
    INDEX idx_groster_uname (username_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── État de la sync (curseurs) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tfh_g_state (
    skey   VARCHAR(40) NOT NULL PRIMARY KEY,
    svalue TEXT        NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
