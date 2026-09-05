<?php
declare(strict_types=1);

/**
 * /api/chat.php — Chat en direct joueur ↔ équipe (MySQL).
 *
 * Le joueur discute avec l'équipe TheFrontHub depuis n'importe quelle page
 * (widget bulle en bas à droite). L'équipe répond depuis l'espace admin
 * (admin/api.php actions supchat.*) ; les deux côtés rafraîchissent en
 * « quasi temps réel » par polling (~2-3 s).
 *
 * GET  ?action=state          → { ok, me:{name,avatar}, last_id }
 * GET  ?action=poll&since=N   → { ok, me:{...}, messages:[...], last_id }
 *                               (messages de MA conversation ; since = dernier
 *                                id reçu → renvoie uniquement ce qui est plus
 *                                récent ; marque les réponses de l'équipe lues)
 * POST { action:'send', content } → { ok, message }
 *
 * Une session Discord est OBLIGATOIRE (pas d'anonymat : on connaît l'auteur).
 * La conversation est identifiée par l'ID Discord du joueur (conv_id).
 * Table tfh_support_chat auto-créée au premier appel (errno 1146) ; schéma
 * documenté dans api/sql-chat.sql pour un passage manuel éventuel en cPanel.
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

const CHAT_BODY_MAX     = 2000;
const CHAT_POLL_LIMIT   = 200;
/* Notification équipe par mail uniquement au PREMIER message d'une
 * conversation (les suivants : badge « non lus » dans le panel). */
const CHAT_NOTIFY_EMAIL = 'support@thefronthub.com';

/* ------------------------------------------------------------------ */
/* Schéma (auto-création au premier déploiement)                       */
/* ------------------------------------------------------------------ */

function chat_table_sql(): string
{
    return 'CREATE TABLE IF NOT EXISTS tfh_support_chat (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        conv_id VARCHAR(32) NOT NULL,
        author_role VARCHAR(8) NOT NULL DEFAULT "user",
        author_name VARCHAR(64) NOT NULL DEFAULT "",
        body TEXT NOT NULL,
        read_by_user TINYINT(1) NOT NULL DEFAULT 0,
        read_by_admin TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_conv (conv_id, id),
        KEY idx_admin_unread (read_by_admin, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
}

/**
 * Exécute une requête ; si la table manque (errno 1146 — premier
 * déploiement), crée le schéma puis retente une fois.
 */
function chat_query(PDO $pdo, string $sql, array $params = []): PDOStatement
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
        $pdo->exec(chat_table_sql());
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** ID Discord (conv_id) du joueur connecté, via tfh_user_identities. */
function chat_discord_id(PDO $pdo, array $user): ?string
{
    try {
        $st = $pdo->prepare(
            "SELECT provider_uid FROM tfh_user_identities WHERE user_id = ? AND provider = 'discord' LIMIT 1"
        );
        $st->execute([(int) $user['id']]);
        $row = $st->fetch();
        return $row !== false ? (string) $row['provider_uid'] : null;
    } catch (PDOException $e) {
        return null;
    }
}

/** Nom affiché du joueur. */
function chat_display_name(array $user): string
{
    $g = trim((string) ($user['global_name'] ?? ''));
    if ($g !== '') {
        return $g;
    }
    $u = trim((string) ($user['username'] ?? ''));
    return $u !== '' ? $u : 'Joueur';
}

/** Mail texte simple UTF-8 — best-effort : n'échoue JAMAIS l'action. */
function chat_mail(string $to, string $subject, string $body): bool
{
    if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
        return false;
    }
    $headers = implode("\r\n", [
        'From: TheFrontHub <no-reply@thefronthub.com>',
        'Reply-To: ' . CHAT_NOTIFY_EMAIL,
        'Content-Type: text/plain; charset=UTF-8',
        'X-Mailer: TheFrontHub-Chat',
    ]);
    try {
        $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
        return @mail($to, $encodedSubject, $body, $headers) === true;
    } catch (Throwable $e) {
        error_log('[tfh-chat] mail() indisponible : ' . $e->getMessage());
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* GET                                                                 */
/* ------------------------------------------------------------------ */

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    rate_limit($pdo, 'chat-get:' . client_ip(), 240, 60);

    $user = current_user($pdo);
    if ($user === null) {
        json_out(['ok' => false, 'error' => 'auth_required'], 401);
    }
    $convId = chat_discord_id($pdo, $user);
    if ($convId === null || $convId === '') {
        json_out(['ok' => false, 'error' => 'no_identity'], 403);
    }

    $me = [
        'name'   => chat_display_name($user),
        /* tfh_users.avatar_url = URL CDN complète (posée au callback Discord) ;
         * fallback : avatar par défaut déduit du snowflake. */
        'avatar' => (isset($user['avatar_url']) && (string) $user['avatar_url'] !== '')
            ? (string) $user['avatar_url']
            : discord_avatar_url($convId, null),
    ];

    /* ── État initial (sans messages) ── */
    $action = (string) ($_GET['action'] ?? '');
    if ($action === 'state') {
        $st = chat_query(
            $pdo,
            'SELECT COALESCE(MAX(id), 0) AS last_id FROM tfh_support_chat WHERE conv_id = ?',
            [$convId]
        );
        $row = $st->fetch();
        json_out([
            'ok'      => true,
            'me'      => $me,
            'last_id' => (int) ($row['last_id'] ?? 0),
        ]);
    }

    /* ── Poll : nouveaux messages depuis l'id « since » ── */
    if ($action === 'poll') {
        $since = (int) ($_GET['since'] ?? 0);
        if ($since < 0) {
            $since = 0;
        }
        $st = chat_query(
            $pdo,
            'SELECT id, author_role, author_name, body, created_at
             FROM tfh_support_chat
             WHERE conv_id = ? AND id > ?
             ORDER BY id ASC
             LIMIT ' . CHAT_POLL_LIMIT,
            [$convId, $since]
        );
        $messages = [];
        $lastId   = $since;
        foreach ($st->fetchAll() as $row) {
            $id = (int) $row['id'];
            $messages[] = [
                'id'         => $id,
                'role'       => (string) $row['author_role'],
                'name'       => (string) $row['author_name'],
                'body'       => (string) $row['body'],
                'created_at' => (string) $row['created_at'],
            ];
            $lastId = $id;
        }
        /* Les réponses de l'équipe affichées → marquées lues côté joueur. */
        if ($messages !== []) {
            chat_query(
                $pdo,
                'UPDATE tfh_support_chat SET read_by_user = 1 WHERE conv_id = ? AND author_role = "admin" AND read_by_user = 0',
                [$convId]
            );
        }
        json_out([
            'ok'       => true,
            'me'       => $me,
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

$user = current_user($pdo);
if ($user === null) {
    json_out(['ok' => false, 'error' => 'auth_required'], 401);
}
$convId = chat_discord_id($pdo, $user);
if ($convId === null || $convId === '') {
    json_out(['ok' => false, 'error' => 'no_identity'], 403);
}

$action = (string) ($data['action'] ?? '');
if ($action !== 'send') {
    fail(404, 'unknown_action', 'Action inconnue.');
}

/* Anti-spam : 20 messages / minute / joueur. */
rate_limit($pdo, 'chat-send:' . $convId, 20, 60);

$body = trim((string) ($data['content'] ?? ''));
if ($body === '') {
    fail(422, 'empty_message', 'Le message est vide.');
}
if (function_exists('mb_strlen') ? mb_strlen($body, 'UTF-8') > CHAT_BODY_MAX : strlen($body) > CHAT_BODY_MAX) {
    $body = function_exists('mb_substr') ? mb_substr($body, 0, CHAT_BODY_MAX, 'UTF-8') : substr($body, 0, CHAT_BODY_MAX);
}

$displayName = chat_display_name($user);
chat_query(
    $pdo,
    'INSERT INTO tfh_support_chat (conv_id, author_role, author_name, body, read_by_user, read_by_admin)
     VALUES (?, "user", ?, ?, 1, 0)',
    [$convId, (string) tfh_cut($displayName, 64), $body]
);
$messageId = (int) $pdo->lastInsertId();

/* Première conversation → petit mail à l'équipe (best-effort). */
$st = chat_query(
    $pdo,
    'SELECT COUNT(*) AS n FROM tfh_support_chat WHERE conv_id = ?',
    [$convId]
);
$countRow = $st->fetch();
if ($countRow !== false && (int) $countRow['n'] === 1) {
    chat_mail(
        CHAT_NOTIFY_EMAIL,
        '[TheFrontHub] Nouveau chat — ' . $displayName,
        "Un joueur ouvre le chat en direct sur TheFrontHub.\r\n\r\n"
        . "Joueur : {$displayName} (Discord {$convId})\r\n"
        . "Message :\r\n{$body}\r\n\r\n"
        . "→ Répondre : https://admin.thefronthub.com (section Chat support)"
    );
}

json_out([
    'ok' => true,
    'message' => [
        'id'         => $messageId,
        'role'       => 'user',
        'name'       => $displayName,
        'body'       => $body,
        'created_at' => gmdate('Y-m-d H:i:s'),
    ],
]);
