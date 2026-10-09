<?php
declare(strict_types=1);

/**
 * /api/lobby-chat.php — Chat communautaire du Lobby (MySQL).
 *
 * Salons :
 *   - « global »            → #général, ouvert à tous les inscrits.
 *   - « g<gameID> »         → salon d'une partie OpenFront. Deux sources :
 *     • le flux lobby temps réel (le joueur lance/rejoint la partie),
 *     • la collecte continue du serveur (cron games-sync → tfh_g_games /
 *       tfh_g_roster) : v5.20 « salons des parties du jour » — les
 *       dernières parties PUBLIQUES lancées (24 h) avec TOUS leurs
 *       joueurs (vus via l'API OpenFront), et la mise en avant des
 *       inscrits TheFrontHub (public_id reconnu).
 *
 * ACCÈS RÉSERVÉ AUX COMPTES (session Discord requise — api/me.php) :
 * seuls les joueurs enregistrés sur TheFrontHub peuvent lire/écrire. Les
 * visiteurs reçoivent 401 auth_required et le client affiche l'encart
 * « Connecte-toi ».
 *
 * v5.20 — salons de partie : l'écriture est réservée aux JOUEURS DE LA
 * PARTIE (roster collecté par l'API : public_id du compte relié présent
 * dans tfh_g_roster). Si la partie n'est pas encore en base (à peine
 * lancée), l'envoi reste ouvert — elle sera ingérée quelques minutes
 * plus tard et la règle s'appliquera. #général reste ouvert à tous les
 * inscrits.
 *
 * GET  ?action=state&room=X       → { ok, me:{name,avatar}, last_id }
 * GET  ?action=history&room=X     → { ok, me, messages:[…50 derniers…], last_id }
 * GET  ?action=poll&room=X&since=N→ { ok, me, messages:[…nouveaux…], last_id }
 * GET  ?action=rooms              → { ok, linked, rooms:[…parties du jour… (mine:true si j'y ai joué)] }
 * GET  ?action=players&room=gX    → { ok, players:[…], canPost, game:{…} }
 * POST { action:'send', room, content } → { ok, message }
 *
 * Les deux côtés rafraîchissent par polling (~3 s panneau ouvert, ~25 s
 * fond pour le badge non-lus). Historique éphémère : les messages de plus
 * de 24 h sont purgés (2 % de chance par envoi — nettoyage opportuniste).
 *
 * Table tfh_lobby_chat auto-créée au premier appel (errno 1146), même
 * mécanique que api/chat.php (chat support).
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

const LC_BODY_MAX    = 500;
const LC_HISTORY     = 50;    // messages renvoyés à l'ouverture d'un salon
const LC_POLL_LIMIT  = 100;   // messages max par poll
const LC_MAX_AGE     = '24 HOUR';
const LC_ROOMS_WINDOW = '24 HOUR'; // fenêtre « parties du jour »
const LC_ROOMS_LIMIT  = 40;        // nb max de salons renvoyés
const LC_PLAYERS_MAX  = 80;        // garde-fou roster affichable

/* ------------------------------------------------------------------ */
/* Schéma (auto-création au premier déploiement)                       */
/* ------------------------------------------------------------------ */

function lobby_chat_table_sql(): string
{
    return 'CREATE TABLE IF NOT EXISTS tfh_lobby_chat (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        room VARCHAR(72) NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        author_name VARCHAR(64) NOT NULL DEFAULT "",
        avatar_url VARCHAR(255) NOT NULL DEFAULT "",
        body VARCHAR(600) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_room (room, id),
        KEY idx_user (user_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
}

/** Requête avec auto-création de table si absente (errno 1146). */
function lobby_chat_query(PDO $pdo, string $sql, array $params = []): PDOStatement
{
    try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    } catch (PDOException $e) {
        $driverErrno = (int) ($e->errorInfo[1] ?? 0);
        if ($driverErrno !== 1146) {
            throw $e;
        }
        $pdo->exec(lobby_chat_table_sql());
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Valide et normalise un identifiant de salon :
 *   - « global »                  → #général
 *   - « g » + gameID OpenFront    → salon d'une partie (alphanumérique,
 *                                   tirets/underscores, 1–64 chars).
 * Retourne le room canonique, ou null si invalide.
 */
function lobby_chat_room(string $raw): ?string
{
    if ($raw === 'global') {
        return 'global';
    }
    if (preg_match('/^g[A-Za-z0-9_-]{1,64}$/', $raw)) {
        return $raw;
    }
    return null;
}

/** Identité affichée du joueur connecté (nom + avatar Discord). */
function lobby_chat_me(PDO $pdo, array $user): array
{
    $discordId = null;
    try {
        $st = $pdo->prepare(
            "SELECT provider_uid FROM tfh_user_identities WHERE user_id = ? AND provider = 'discord' LIMIT 1"
        );
        $st->execute([(int) $user['id']]);
        $row = $st->fetch();
        if ($row !== false) {
            $discordId = (string) $row['provider_uid'];
        }
    } catch (PDOException $e) {
        /* pas d'identité Discord → avatar par défaut */
    }

    $g = trim((string) ($user['global_name'] ?? ''));
    $name = $g !== '' ? $g : trim((string) ($user['username'] ?? ''));
    if ($name === '') {
        $name = 'Joueur';
    }

    $avatar = (isset($user['avatar_url']) && (string) $user['avatar_url'] !== '')
        ? (string) $user['avatar_url']
        : ($discordId !== null ? discord_avatar_url($discordId, null) : '');

    return ['name' => $name, 'avatar' => $avatar];
}

/**
 * Public IDs liés au compte connecté (tfh_users.public_id + alias).
 * Retourne [] si le compte n'a aucun compte OpenFront relié.
 */
function lobby_chat_my_pids(PDO $pdo, int $userId): array
{
    $pids = [];
    try {
        $st = $pdo->prepare(
            'SELECT public_id FROM tfh_users WHERE id = ? AND public_id IS NOT NULL AND public_id <> ""
             UNION
             SELECT public_id FROM tfh_public_aliases WHERE user_id = ? AND public_id IS NOT NULL AND public_id <> ""'
        );
        $st->execute([$userId, $userId]);
        foreach ($st->fetchAll() as $r) {
            $pid = (string) $r['public_id'];
            if ($pid !== '') {
                $pids[] = $pid;
            }
        }
    } catch (PDOException $e) {
        error_log('[tfh-lobby-chat] my_pids: ' . $e->getMessage());
    }
    return $pids;
}

/**
 * Le compte connecté est-il un joueur de la partie (roster collecté) ?
 * NB : partie absente de tfh_g_games → null (« inconnu » — le salon reste
 * ouvert, la partie vient d'être lancée et sera ingérée d'ici peu).
 */
/* v5.43 — bases séparées : les tables tfh_g_* vivent dans la base GAMES
 * (isolée sur dev). tfh_games_ref() qualifie la table (`base`.`table`) quand
 * les bases diffèrent — no-op (nom brut) sur la prod inchangée. */
require_once __DIR__ . '/games-db.php';

function lobby_chat_membership(PDO $pdo, string $gameId, int $userId): ?bool
{
    $st = $pdo->prepare('SELECT 1 FROM ' . tfh_games_ref('tfh_g_games') . ' WHERE game_id = ? LIMIT 1');
    $st->execute([$gameId]);
    if ($st->fetch() === false) {
        return null; // partie pas encore ingérée → fail-open côté envoi
    }
    $pids = lobby_chat_my_pids($pdo, $userId);
    if (!$pids) {
        return false; // partie connue, mais aucun compte OpenFront relié
    }
    $marks = implode(',', array_fill(0, count($pids), '?'));
    $st = $pdo->prepare(
        "SELECT 1 FROM " . tfh_games_ref('tfh_g_roster') . "
         WHERE game_id = ? AND public_id IN ($marks)
         LIMIT 1"
    );
    $st->execute(array_merge([$gameId], $pids));
    return $st->fetch() !== false;
}

/**
 * Roster d'une partie (tous les joueurs vus par l'API OpenFront), avec
 * mise en avant des inscrits TheFrontHub (public_id reconnu).
 */
function lobby_chat_players(PDO $pdo, string $gameId, array $myPids): array
{
    $st = $pdo->prepare(
        'SELECT r.client_id, r.public_id, r.won, r.is_lobby_creator,
                u.username AS name,
                (tu.id IS NOT NULL OR pa.user_id IS NOT NULL) AS is_member
         FROM ' . tfh_games_ref('tfh_g_roster') . ' r
         JOIN ' . tfh_games_ref('tfh_g_usernames') . ' u ON u.id = r.username_id
         LEFT JOIN tfh_users tu          ON tu.public_id = r.public_id
         LEFT JOIN tfh_public_aliases pa ON pa.public_id = r.public_id
         WHERE r.game_id = ?
         ORDER BY r.won DESC, is_member DESC, u.username ASC
         LIMIT ' . LC_PLAYERS_MAX
    );
    $st->execute([$gameId]);
    $players = [];
    foreach ($st->fetchAll() as $row) {
        $pid  = (string) ($row['public_id'] ?? '');
        $name = (string) $row['name'];
        if ($name === '') {
            continue;
        }
        $players[] = [
            'name'    => $name,
            'member'  => (int) $row['is_member'] === 1,
            'you'     => $pid !== '' && in_array($pid, $myPids, true),
            'creator' => (int) ($row['is_lobby_creator'] ?? 0) === 1,
            'won'     => (int) ($row['won'] ?? 0) === 1,
        ];
    }
    return $players;
}

/**
 * Dernières parties publiques lancées (fenêtre 24 h) — « salons du jour ».
 * Source : collecte continue du serveur (cron games-sync), donc les salons
 * existent même si personne ne regarde le site.
 */
function lobby_chat_rooms(PDO $pdo, int $userId, array $myPids): array
{
    $st = $pdo->prepare(
        'SELECT game_id, game_map, game_mode, ranked_type, started_at,
                num_players, max_players
         FROM ' . tfh_games_ref('tfh_g_games') . '
         WHERE game_type = "Public"
           AND started_at >= (UTC_TIMESTAMP() - INTERVAL ' . LC_ROOMS_WINDOW . ')
           AND num_players >= 2
         ORDER BY started_at DESC
         LIMIT ' . LC_ROOMS_LIMIT
    );
    $st->execute();
    $rows   = $st->fetchAll();
    $ids    = array_column($rows, 'game_id');

    // Comptage des inscrits TheFrontHub par partie (1 requête groupée).
    $memberCounts = [];
    $myGameIds    = [];
    if ($ids) {
        $marks = implode(',', array_fill(0, count($ids), '?'));
        try {
            $mc = $pdo->prepare(
                "SELECT r.game_id,
                        COUNT(DISTINCT CASE WHEN tu.id IS NOT NULL THEN tu.id
                                            WHEN pa.user_id IS NOT NULL THEN pa.user_id END) AS members
                 FROM " . tfh_games_ref('tfh_g_roster') . " r
                 LEFT JOIN tfh_users tu          ON tu.public_id = r.public_id
                 LEFT JOIN tfh_public_aliases pa ON pa.public_id = r.public_id
                 WHERE r.game_id IN ($marks) AND r.public_id IS NOT NULL
                 GROUP BY r.game_id"
            );
            $mc->execute($ids);
            foreach ($mc->fetchAll() as $r) {
                $memberCounts[(string) $r['game_id']] = (int) $r['members'];
            }
        } catch (PDOException $e) {
            error_log('[tfh-lobby-chat] rooms members: ' . $e->getMessage());
        }
        if ($myPids) {
            $pm = implode(',', array_fill(0, count($myPids), '?'));
            $me = $pdo->prepare(
                "SELECT DISTINCT game_id FROM " . tfh_games_ref('tfh_g_roster') . "
                 WHERE game_id IN ($marks) AND public_id IN ($pm)"
            );
            $me->execute(array_merge($ids, $myPids));
            foreach ($me->fetchAll() as $r) {
                $myGameIds[] = (string) $r['game_id'];
            }
        }
    }

    $rooms = [];
    foreach ($rows as $g) {
        $gid = (string) $g['game_id'];
        $rt  = (string) ($g['ranked_type'] ?? '');
        $rooms[] = [
            'id'         => 'g' . $gid,
            'gameId'     => $gid,
            'map'        => (string) ($g['game_map'] ?? ''),
            'mode'       => (string) ($g['game_mode'] ?? ''),
            'ranked'     => ($rt !== '' && $rt !== 'unranked') ? $rt : null,
            'startedAt'  => (string) $g['started_at'],   // UTC « YYYY-MM-DD HH:MM:SS »
            'numPlayers' => (int) ($g['num_players'] ?? 0),
            'maxPlayers' => (int) ($g['max_players'] ?? 0),
            'members'    => $memberCounts[$gid] ?? 0,
            'mine'       => in_array($gid, $myGameIds, true),
        ];
    }
    return $rooms;
}

/** Purge opportuniste : 2 % des envois déclenchent le nettoyage > 24 h. */
function lobby_chat_maybe_cleanup(PDO $pdo): void
{
    if (random_int(1, 50) !== 1) {
        return;
    }
    try {
        lobby_chat_query(
            $pdo,
            'DELETE FROM tfh_lobby_chat WHERE created_at < (NOW() - INTERVAL ' . LC_MAX_AGE . ')'
        );
    } catch (PDOException $e) {
        error_log('[tfh-lobby-chat] cleanup: ' . $e->getMessage());
    }
}

/* ------------------------------------------------------------------ */
/* Accès : session Discord OBLIGATOIRE (comptes inscrits)              */
/* ------------------------------------------------------------------ */

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$user   = current_user($pdo);
if ($user === null) {
    /* 401 volontairement identique à api/chat.php → le client sait qu'il
     * doit afficher l'encart « Connecte-toi avec Discord ». */
    json_out(['ok' => false, 'error' => 'auth_required'], 401);
}

$me       = lobby_chat_me($pdo, $user);
$userId   = (int) $user['id'];

/* ------------------------------------------------------------------ */
/* GET                                                                 */
/* ------------------------------------------------------------------ */

if ($method === 'GET') {
    rate_limit($pdo, 'lobbychat-get:' . client_ip(), 300, 60);

    $room = lobby_chat_room((string) ($_GET['room'] ?? 'global'));
    if ($room === null) {
        fail(422, 'bad_room', 'Salon invalide.');
    }
    $action = (string) ($_GET['action'] ?? 'state');

    /* ── État initial (dernier id du salon) ── */
    if ($action === 'state') {
        $st = lobby_chat_query(
            $pdo,
            'SELECT COALESCE(MAX(id), 0) AS last_id FROM tfh_lobby_chat WHERE room = ?',
            [$room]
        );
        $row = $st->fetch();
        json_out([
            'ok'      => true,
            'me'      => $me,
            'room'    => $room,
            'last_id' => (int) ($row['last_id'] ?? 0),
        ]);
    }

    /* ── Historique : 50 derniers messages (à l'ouverture du salon) ── */
    if ($action === 'history') {
        $st = lobby_chat_query(
            $pdo,
            'SELECT id, user_id, author_name, avatar_url, body, created_at
             FROM tfh_lobby_chat
             WHERE room = ?
             ORDER BY id DESC
             LIMIT ' . LC_HISTORY,
            [$room]
        );
        $rows = array_reverse($st->fetchAll() ?: []);
        $messages = [];
        $lastId   = 0;
        foreach ($rows as $row) {
            $id = (int) $row['id'];
            $messages[] = [
                'id'         => $id,
                'user_id'    => (int) $row['user_id'],
                'name'       => (string) $row['author_name'],
                'avatar'     => (string) $row['avatar_url'],
                'body'       => (string) $row['body'],
                'created_at' => (string) $row['created_at'],
            ];
            $lastId = $id;
        }
        json_out([
            'ok'       => true,
            'me'       => $me,
            'room'     => $room,
            'messages' => $messages,
            'last_id'  => $lastId,
        ]);
    }

    /* ── v5.20 : salons des parties du jour (collecte serveur) ── */
    if ($action === 'rooms') {
        $myPids = lobby_chat_my_pids($pdo, $userId);
        json_out([
            'ok'      => true,
            'me'      => $me,
            'linked'  => $myPids !== [],
            'rooms'   => lobby_chat_rooms($pdo, $userId, $myPids),
        ]);
    }

    /* ── v5.20 : joueurs d'une partie (roster API, inscrits mis en avant) ── */
    if ($action === 'players') {
        if ($room === 'global' || !preg_match('/^g([A-Za-z0-9_-]{1,64})$/', $room, $m)) {
            fail(422, 'bad_room', 'Salon de partie attendu.');
        }
        $gameId  = $m[1];
        $myPids  = lobby_chat_my_pids($pdo, $userId);
        $players = lobby_chat_players($pdo, $gameId, $myPids);
        $gst = $pdo->prepare(
            'SELECT game_map, game_mode, ranked_type, started_at, num_players, max_players
             FROM ' . tfh_games_ref('tfh_g_games') . ' WHERE game_id = ? LIMIT 1'
        );
        $gst->execute([$gameId]);
        $grow = $gst->fetch();
        $membership = lobby_chat_membership($pdo, $gameId, $userId);
        json_out([
            'ok'      => true,
            'me'      => $me,
            'linked'  => $myPids !== [],
            'game'    => $grow === false ? null : [
                'map'        => (string) ($grow['game_map'] ?? ''),
                'mode'       => (string) ($grow['game_mode'] ?? ''),
                'ranked'     => (string) ($grow['ranked_type'] ?? ''),
                'startedAt'  => (string) $grow['started_at'],
                'numPlayers' => (int) ($grow['num_players'] ?? 0),
                'maxPlayers' => (int) ($grow['max_players'] ?? 0),
            ],
            'players' => $players,
            'canPost' => $membership !== false, // null = partie inconnue → ouvert
        ]);
    }

    /* ── Poll : messages plus récents que « since » ── */
    if ($action === 'poll') {
        $since = (int) ($_GET['since'] ?? 0);
        if ($since < 0) {
            $since = 0;
        }
        $st = lobby_chat_query(
            $pdo,
            'SELECT id, user_id, author_name, avatar_url, body, created_at
             FROM tfh_lobby_chat
             WHERE room = ? AND id > ?
             ORDER BY id ASC
             LIMIT ' . LC_POLL_LIMIT,
            [$room, $since]
        );
        $messages = [];
        $lastId   = $since;
        foreach ($st->fetchAll() as $row) {
            $id = (int) $row['id'];
            $messages[] = [
                'id'         => $id,
                'user_id'    => (int) $row['user_id'],
                'name'       => (string) $row['author_name'],
                'avatar'     => (string) $row['avatar_url'],
                'body'       => (string) $row['body'],
                'created_at' => (string) $row['created_at'],
            ];
            $lastId = $id;
        }
        json_out([
            'ok'       => true,
            'me'       => $me,
            'room'     => $room,
            'messages' => $messages,
            'last_id'  => $lastId,
        ]);
    }

    fail(404, 'unknown_action', 'Action inconnue.');
}

/* ------------------------------------------------------------------ */
/* POST                                                                */
/* ------------------------------------------------------------------ */

if ($method !== 'POST') {
    fail(405, 'method_not_allowed', 'Méthode non autorisée.');
}

$raw  = file_get_contents('php://input');
$data = json_decode((string) $raw, true);
if (!is_array($data)) {
    fail(400, 'bad_json', 'Corps JSON invalide.');
}

if ((string) ($data['action'] ?? '') !== 'send') {
    fail(404, 'unknown_action', 'Action inconnue.');
}

$room = lobby_chat_room((string) ($data['room'] ?? ''));
if ($room === null) {
    fail(422, 'bad_room', 'Salon invalide.');
}

/* Anti-spam : 15 messages / minute / compte (les salons partent du principe
 * qu'on discute avec des inscrits connus — pas d'anonymat, pas de flood). */
rate_limit($pdo, 'lobbychat-send:' . $userId, 15, 60);

/* v5.20 — salon de partie : réservé aux joueurs de la partie (comptes
 * reliés reconnus dans le roster collecté par l'API). Partie pas encore
 * en base → salon encore ouvert (elle sera ingérée d'ici quelques min). */
if ($room !== 'global') {
    $gameId = substr($room, 1);
    if (lobby_chat_membership($pdo, $gameId, $userId) === false) {
        json_out(['ok' => false, 'error' => 'not_in_game'], 403);
    }
}

$body = trim((string) ($data['content'] ?? ''));
if ($body === '') {
    fail(422, 'empty_message', 'Le message est vide.');
}
if (function_exists('mb_strlen') ? mb_strlen($body, 'UTF-8') > LC_BODY_MAX : strlen($body) > LC_BODY_MAX) {
    $body = function_exists('mb_substr') ? mb_substr($body, 0, LC_BODY_MAX, 'UTF-8') : substr($body, 0, LC_BODY_MAX);
}

lobby_chat_query(
    $pdo,
    'INSERT INTO tfh_lobby_chat (room, user_id, author_name, avatar_url, body)
     VALUES (?, ?, ?, ?, ?)',
    [
        $room,
        $userId,
        (string) tfh_cut($me['name'], 64),
        (string) tfh_cut($me['avatar'], 255),
        $body,
    ]
);
$messageId = (int) $pdo->lastInsertId();

lobby_chat_maybe_cleanup($pdo);

json_out([
    'ok' => true,
    'message' => [
        'id'         => $messageId,
        'user_id'    => $userId,
        'name'       => $me['name'],
        'avatar'     => $me['avatar'],
        'body'       => $body,
        'created_at' => gmdate('Y-m-d H:i:s'),
    ],
]);
