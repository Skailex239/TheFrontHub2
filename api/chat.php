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
 * Deux modes d'accès :
 *  1. Session Discord (compte complet)  → conv_id = ID Discord du joueur.
 *  2. Invité (sans compte)              → le client appelle d'abord
 *     POST { action:'guest_start', name:'Pseudo' } → { ok, conv_id, token }.
 *     Le token (64 hex) n'est stocké qu'en hash SHA-256 et doit être
 *     renvoyé par le client sur chaque appel : &guest=<conv_id>&gtok=<token>
 *     (GET) / { guest, gtok } (POST send). La conversation persiste côté
 *     client via localStorage — rien de dépendant d'une session PHP.
 * Tables tfh_support_chat + tfh_support_chat_guests auto-créées au premier
 * appel (errno 1146).
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

const CHAT_BODY_MAX     = 2000;
const CHAT_POLL_LIMIT   = 200;
const GUEST_NAME_MIN    = 2;
const GUEST_NAME_MAX    = 32;
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

/** Conversations invitées : conv_id 'g' + 24 hex, token stocké hashé. */
function chat_guest_table_sql(): string
{
    return 'CREATE TABLE IF NOT EXISTS tfh_support_chat_guests (
        conv_id VARCHAR(32) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        name VARCHAR(64) NOT NULL,
        ip VARCHAR(45) NOT NULL DEFAULT "",
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (conv_id),
        KEY idx_token (token_hash(12))
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

/* Exécute une requête ; si LA TABLE INVITÉS manque (errno 1146), crée le
 * schéma puis retente une fois (même mécanique que chat_query). */
function chat_guest_query(PDO $pdo, string $sql, array $params = []): PDOStatement
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
        $pdo->exec(chat_guest_table_sql());
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Authentifie une conversation invitée : conv_id 'g…' + token hex 64.
 * Retourne [conv_id, name] si le couple correspond en base, sinon null.
 * Table absente (jamais déployée) → null également.
 */
function chat_guest(PDO $pdo, string $convId, string $token): ?array
{
    if (!preg_match('/^g[0-9a-f]{24}$/', $convId) || !preg_match('/^[a-f0-9]{64}$/', $token)) {
        return null;
    }
    try {
        $st = $pdo->prepare(
            'SELECT conv_id, name FROM tfh_support_chat_guests WHERE conv_id = ? AND token_hash = ? LIMIT 1'
        );
        $st->execute([$convId, hash('sha256', $token)]);
        $row = $st->fetch();
        return $row !== false ? ['conv_id' => (string) $row['conv_id'], 'name' => (string) $row['name']] : null;
    } catch (PDOException $e) {
        return null;
    }
}

/** Pseudo invité : retire les caractères de contrôle, normalise les espaces, 2–32 chars. */
function chat_guest_name(string $raw): ?string
{
    $name = preg_replace('/[\x00-\x1F\x7F]/u', '', $raw);
    $name = trim((string) preg_replace('/\s+/u', ' ', $name));
    $len  = function_exists('mb_strlen') ? mb_strlen($name, 'UTF-8') : strlen($name);
    if ($len < GUEST_NAME_MIN || $len > GUEST_NAME_MAX) {
        return null;
    }
    return $name;
}

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

    $user   = current_user($pdo);
    $convId = null;

    if ($user !== null) {
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
    } else {
        /* Invité : conversation + token (renvoyés par guest_start au client). */
        $guest = chat_guest($pdo, (string) ($_GET['guest'] ?? ''), (string) ($_GET['gtok'] ?? ''));
        if ($guest === null) {
            json_out(['ok' => false, 'error' => 'auth_required'], 401);
        }
        $convId = $guest['conv_id'];
        $me     = ['name' => $guest['name'], 'avatar' => ''];
    }

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

$action = (string) ($data['action'] ?? '');

/* ── Ouverture d'un ticket INVITÉ (sans session Discord) ──
 * Rate-limit strict par IP : 5 ouvertures / 10 min — l'objectif est de
 * permettre à un vrai visiteur d'écrire, pas de remplir la base. */
if ($action === 'guest_start') {
    rate_limit($pdo, 'chat-guest:' . client_ip(), 5, 600);

    $name = chat_guest_name((string) ($data['name'] ?? ''));
    if ($name === null) {
        fail(422, 'bad_name', 'Le pseudo doit contenir entre 2 et 32 caractères.');
    }

    $convId = 'g' . bin2hex(random_bytes(12));   // 25 caractères ≤ 32
    $token  = bin2hex(random_bytes(32));          // 64 hex — seul le hash part en base

    try {
        chat_guest_query(
            $pdo,
            'INSERT INTO tfh_support_chat_guests (conv_id, token_hash, name, ip) VALUES (?, ?, ?, ?)',
            [$convId, hash('sha256', $token), tfh_cut($name, 64), client_ip()]
        );
    } catch (PDOException $e) {
        error_log('[tfh-chat] guest_start: ' . $e->getMessage());
        fail(500, 'guest_start_failed', 'Ouverture du ticket impossible pour le moment.');
    }

    json_out(['ok' => true, 'conv_id' => $convId, 'token' => $token, 'name' => $name]);
}

if ($action !== 'send') {
    fail(404, 'unknown_action', 'Action inconnue.');
}

$user   = current_user($pdo);
$guest  = null;

if ($user !== null) {
    $convId = chat_discord_id($pdo, $user);
    if ($convId === null || $convId === '') {
        json_out(['ok' => false, 'error' => 'no_identity'], 403);
    }
} else {
    $guest = chat_guest($pdo, (string) ($data['guest'] ?? ''), (string) ($data['gtok'] ?? ''));
    if ($guest === null) {
        json_out(['ok' => false, 'error' => 'auth_required'], 401);
    }
    $convId = $guest['conv_id'];
}

/* Anti-spam : 20 messages / minute / conversation, et pour les invités
 * 10 / minute / IP (une même IP peut multiplier les conversations). */
rate_limit($pdo, 'chat-send:' . $convId, 20, 60);
if ($guest !== null) {
    rate_limit($pdo, 'chat-send-g:' . client_ip(), 10, 60);
}

$body = trim((string) ($data['content'] ?? ''));
if ($body === '') {
    fail(422, 'empty_message', 'Le message est vide.');
}
if (function_exists('mb_strlen') ? mb_strlen($body, 'UTF-8') > CHAT_BODY_MAX : strlen($body) > CHAT_BODY_MAX) {
    $body = function_exists('mb_substr') ? mb_substr($body, 0, CHAT_BODY_MAX, 'UTF-8') : substr($body, 0, CHAT_BODY_MAX);
}

$displayName = $guest !== null ? $guest['name'] : chat_display_name($user);
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
    $kind = ($convId !== '' && $convId[0] === 'g') ? 'invité' : 'Discord ' . $convId;
    chat_mail(
        CHAT_NOTIFY_EMAIL,
        '[TheFrontHub] Nouveau chat — ' . $displayName,
        "Un joueur ouvre le chat en direct sur TheFrontHub.\r\n\r\n"
        . "Joueur : {$displayName} ({$kind})\r\n"
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
