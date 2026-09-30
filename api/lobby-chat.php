<?php
declare(strict_types=1);

/**
 * /api/lobby-chat.php — Chat communautaire du Lobby (MySQL).
 *
 * Salons :
 *   - « global »            → #général, ouvert à tous les inscrits.
 *   - « g<gameID> »         → salon d'une partie OpenFront (le gameID vient
 *                             du flux lobby temps réel). Le salon s'ouvre
 *                             automatiquement quand un joueur lance/rejoint
 *                             la partie depuis le lobby.
 *
 * ACCÈS RÉSERVÉ AUX COMPTES (session Discord requise — api/me.php) :
 * c'est le « déblocage » demandé — seuls les joueurs enregistrés sur
 * TheFrontHub peuvent lire/écrire. Les visiteurs reçoivent 401
 * auth_required et le client affiche l'encart « Connecte-toi ».
 *
 * GET  ?action=state&room=X       → { ok, me:{name,avatar}, last_id }
 * GET  ?action=history&room=X     → { ok, me, messages:[…50 derniers…], last_id }
 * GET  ?action=poll&room=X&since=N→ { ok, me, messages:[…nouveaux…], last_id }
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
