<?php
declare(strict_types=1);

/**
 * /api/support.php — Support & messagerie joueur ↔ équipe (MySQL).
 *
 * GET                        → { ok, is_admin, tickets: [...] }
 *                              (liste des tickets de l'utilisateur connecté ;
 *                               l'équipe peut ajouter ?scope=all)
 * GET ?action=thread&id=N    → { ok, is_admin, ticket: {...}, messages: [...] }
 * POST { action: create }    → { action:'create', category, subject, message }
 * POST { action: reply }     → { action:'reply', ticket_id, message }
 * POST { action: close }     → { action:'close', ticket_id }
 *
 * Une session Discord est OBLIGATOIRE (pas de contact anonyme : on connaît
 * ainsi l'auteur et on peut lui répondre). Les tickets vivent dans
 * tfh_support_tickets + tfh_support_messages — auto-créées au premier appel
 * (errno 1146) ; api/sql-support.sql documente le schéma pour un passage
 * manuel éventuel en cPanel.
 *
 * Notifications mail (best-effort, jamais bloquantes) :
 *   - nouveau ticket           → un mail part vers l'équipe (constante
 *                                SUPPORT_NOTIFY_EMAIL, éditable ci-dessous) ;
 *   - réponse de l'équipe      → un mail part vers l'email du joueur
 *                                (champ email Discord, s'il est renseigné).
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

const SUPPORT_NOTIFY_EMAIL = 'contact@thefronthub.com'; // → éditer ici si besoin
const SUPPORT_CATEGORIES   = ['question', 'bug', 'signalement', 'idee', 'autre'];
const SUPPORT_BODY_MAX     = 5000;
const SUPPORT_SUBJECT_MAX  = 140;

/** Longueur en caractères (mbstring optionnel — fallback substr). */
function support_len(string $v): int
{
    return function_exists('mb_strlen') ? (int) mb_strlen($v) : strlen($v);
}

/** Troncature sûre en caractères (mbstring optionnel). */
function support_cut(string $v, int $max): string
{
    return function_exists('mb_substr') ? (string) mb_substr($v, 0, $max, 'UTF-8') : substr($v, 0, $max);
}

/* ------------------------------------------------------------------ */
/* Schéma (auto-création au premier déploiement)                       */
/* ------------------------------------------------------------------ */

function support_tables_sql(): string
{
    return 'CREATE TABLE IF NOT EXISTS tfh_support_tickets (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id INT UNSIGNED NOT NULL,
        category VARCHAR(24) NOT NULL DEFAULT "autre",
        subject VARCHAR(140) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT "open",
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_user (user_id, updated_at),
        KEY idx_status (status, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS tfh_support_messages (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        ticket_id INT UNSIGNED NOT NULL,
        author_role VARCHAR(8) NOT NULL DEFAULT "user",
        user_id INT UNSIGNED DEFAULT NULL,
        body TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_ticket (ticket_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
}

/**
 * Exécute une requête ; si une table manque (errno 1146 — premier
 * déploiement), crée le schéma puis retente une fois.
 */
function support_query(PDO $pdo, string $sql, array $params = []): PDOStatement
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
        // PDO::exec() ne peut pas enchaîner deux CREATE TABLE → on split.
        foreach (explode(';', support_tables_sql()) as $ddl) {
            $ddl = trim($ddl);
            if ($ddl !== '') {
                $pdo->exec($ddl);
            }
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** L'utilisateur est-il de l'équipe (rôle admin du site ou whitelist panel) ? */
function support_is_admin(PDO $pdo, array $user): bool
{
    if ((string) ($user['role'] ?? '') === 'admin') {
        return true;
    }
    try {
        $st = $pdo->prepare(
            "SELECT provider_uid FROM tfh_user_identities WHERE user_id = ? AND provider = 'discord' LIMIT 1"
        );
        $st->execute([(int) $user['id']]);
        $row = $st->fetch();
        if ($row === false) {
            return false;
        }
        $st2 = $pdo->prepare('SELECT 1 FROM tfh_task_admins WHERE discord_id = ? LIMIT 1');
        $st2->execute([(string) $row['provider_uid']]);
        return $st2->fetch() !== false;
    } catch (PDOException $e) {
        // Tables panel absentes (pas encore déployées) : rôle seul fait foi.
        return false;
    }
}

/** Mail texte simple UTF-8 — best-effort : n'échoue JAMAIS l'action. */
function support_mail(string $to, string $subject, string $body): bool
{
    if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
        return false;
    }
    $headers = implode("\r\n", [
        'From: TheFrontHub <no-reply@thefronthub.com>',
        'Reply-To: ' . SUPPORT_NOTIFY_EMAIL,
        'Content-Type: text/plain; charset=UTF-8',
        'X-Mailer: TheFrontHub-Support',
    ]);
    try {
        $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
        return @mail($to, $encodedSubject, $body, $headers) === true;
    } catch (Throwable $e) {
        error_log('[tfh-support] mail() indisponible : ' . $e->getMessage());
        return false;
    }
}

/** Charge un ticket ; null si introuvable. */
function support_ticket(PDO $pdo, int $id): ?array
{
    $st = support_query($pdo, 'SELECT * FROM tfh_support_tickets WHERE id = ? LIMIT 1', [$id]);
    $row = $st->fetch();
    return $row !== false ? $row : null;
}

/** Met à jour le tampon « updated_at » du ticket. */
function support_touch(PDO $pdo, int $id): void
{
    support_query($pdo, 'UPDATE tfh_support_tickets SET updated_at = NOW() WHERE id = ?', [$id]);
}

/** Pseudos des auteurs des messages (pour le rendu du fil). */
function support_usernames(PDO $pdo, array $userIds): array
{
    $ids = array_values(array_unique(array_filter(array_map('intval', $userIds))));
    if ($ids === []) {
        return [];
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $st = $pdo->prepare("SELECT id, username, global_name FROM tfh_users WHERE id IN ($placeholders)");
    $st->execute($ids);
    $out = [];
    foreach ($st->fetchAll() as $row) {
        $out[(int) $row['id']] = (string) ($row['global_name'] ?: $row['username']);
    }
    return $out;
}

/* ------------------------------------------------------------------ */
/* GET                                                                 */
/* ------------------------------------------------------------------ */

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    rate_limit($pdo, 'support-get:' . client_ip(), 120, 60);

    $user = current_user($pdo);
    if ($user === null) {
        json_out(['ok' => false, 'error' => 'auth_required'], 401);
    }
    $isAdmin = support_is_admin($pdo, $user);

    /* ── Fil complet d'un ticket ── */
    $action = (string) ($_GET['action'] ?? '');
    if ($action === 'thread') {
        $id = (int) ($_GET['id'] ?? 0);
        $ticket = $id > 0 ? support_ticket($pdo, $id) : null;
        if ($ticket === null) {
            fail(404, 'ticket_not_found', 'Ticket introuvable.');
        }
        if ((int) $ticket['user_id'] !== (int) $user['id'] && !$isAdmin) {
            fail(403, 'forbidden', "Ce ticket ne t'appartient pas.");
        }

        $st = support_query(
            $pdo,
            'SELECT id, author_role, user_id, body, created_at FROM tfh_support_messages WHERE ticket_id = ? ORDER BY created_at ASC, id ASC LIMIT 500',
            [$id]
        );
        $rows = $st->fetchAll();
        $names = support_usernames($pdo, array_map(
            static fn ($r) => $r['user_id'] !== null ? (int) $r['user_id'] : 0,
            $rows
        ));
        $messages = [];
        foreach ($rows as $row) {
            $uid = $row['user_id'] !== null ? (int) $row['user_id'] : null;
            $messages[] = [
                'id'          => (int) $row['id'],
                'author_role' => (string) $row['author_role'],
                'author_name' => $uid !== null ? ($names[$uid] ?? null) : null,
                'body'        => (string) $row['body'],
                'created_at'  => (string) $row['created_at'],
            ];
        }

        json_out([
            'ok'       => true,
            'is_admin' => $isAdmin,
            'ticket'   => [
                'id'         => (int) $ticket['id'],
                'category'   => (string) $ticket['category'],
                'subject'    => (string) $ticket['subject'],
                'status'     => (string) $ticket['status'],
                'mine'       => (int) $ticket['user_id'] === (int) $user['id'],
                'created_at' => (string) $ticket['created_at'],
                'updated_at' => (string) $ticket['updated_at'],
            ],
            'messages' => $messages,
        ]);
    }

    /* ── Liste des tickets (le mien — ou tous pour l'équipe via ?scope=all) ── */
    $scopeAll = $isAdmin && (string) ($_GET['scope'] ?? '') === 'all';
    if ($scopeAll) {
        $st = support_query(
            $pdo,
            'SELECT id, user_id, category, subject, status, created_at, updated_at
             FROM tfh_support_tickets ORDER BY updated_at DESC, id DESC LIMIT 200'
        );
    } else {
        $st = support_query(
            $pdo,
            'SELECT id, user_id, category, subject, status, created_at, updated_at
             FROM tfh_support_tickets WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 100',
            [(int) $user['id']]
        );
    }

    $tickets = [];
    $rows = $st->fetchAll();
    $names = support_usernames($pdo, array_map(static fn ($r) => (int) $r['user_id'], $rows));
    foreach ($rows as $row) {
        $uid = (int) $row['user_id'];
        $cst = $pdo->prepare('SELECT body FROM tfh_support_messages WHERE ticket_id = ? ORDER BY id ASC LIMIT 1');
        $cst->execute([(int) $row['id']]);
        $first = (string) (($cst->fetch()['body'] ?? ''));
        $tickets[] = [
            'id'          => (int) $row['id'],
            'user_id'     => $uid,
            'user_name'   => $names[$uid] ?? null,
            'category'    => (string) $row['category'],
            'subject'     => (string) $row['subject'],
            'status'      => (string) $row['status'],
            'preview'     => support_cut($first, 120),
            'created_at'  => (string) $row['created_at'],
            'updated_at'  => (string) $row['updated_at'],
        ];
    }

    json_out(['ok' => true, 'is_admin' => $isAdmin, 'tickets' => $tickets]);
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
$isAdmin = support_is_admin($pdo, $user);
$action  = (string) ($data['action'] ?? '');

/* ── Créer un ticket ── */
if ($action === 'create') {
    rate_limit($pdo, 'support-create:' . (int) $user['id'], 5, 3600);

    $category = tfh_cut((string) ($data['category'] ?? 'autre'), 24);
    if (!in_array($category, SUPPORT_CATEGORIES, true)) {
        $category = 'autre';
    }
    $subject = trim((string) ($data['subject'] ?? ''));
    $body    = trim((string) ($data['message'] ?? ''));
    if (support_len($subject) < 4) {
        fail(422, 'subject_too_short', 'Le sujet doit contenir au moins 4 caractères.');
    }
    if (support_len($body) < 10) {
        fail(422, 'message_too_short', 'Le message doit contenir au moins 10 caractères.');
    }

    $pdo->beginTransaction();
    support_query(
        $pdo,
        'INSERT INTO tfh_support_tickets (user_id, category, subject, status) VALUES (?, ?, ?, "open")',
        [(int) $user['id'], $category, tfh_cut($subject, SUPPORT_SUBJECT_MAX)]
    );
    $ticketId = (int) $pdo->lastInsertId();
    support_query(
        $pdo,
        'INSERT INTO tfh_support_messages (ticket_id, author_role, user_id, body) VALUES (?, "user", ?, ?)',
        [$ticketId, (int) $user['id'], tfh_cut($body, SUPPORT_BODY_MAX)]
    );
    $pdo->commit();

    // Notification équipe (best-effort — ne casse rien si le mail est off)
    $displayName = (string) ($user['global_name'] ?: $user['username']);
    support_mail(
        SUPPORT_NOTIFY_EMAIL,
        '[TheFrontHub] Nouveau ticket support #' . $ticketId . ' — ' . $subject,
        "Nouveau ticket de support sur TheFrontHub.\r\n\r\n"
        . "Ticket : #{$ticketId}\r\n"
        . "Joueur : {$displayName} (id {$user['id']})\r\n"
        . "Catégorie : {$category}\r\n"
        . "Sujet : {$subject}\r\n\r\n"
        . "Message :\r\n{$body}\r\n\r\n"
        . "→ Répondre : https://thefronthub.com/support.html"
    );

    json_out(['ok' => true, 'ticket_id' => $ticketId]);
}

/* ── Répondre à un ticket ── */
if ($action === 'reply') {
    rate_limit($pdo, 'support-reply:' . (int) $user['id'], 30, 3600);

    $ticketId = (int) ($data['ticket_id'] ?? 0);
    $body     = trim((string) ($data['message'] ?? ''));
    if (support_len($body) < 2) {
        fail(422, 'message_too_short', 'Le message est trop court.');
    }
    $ticket = $ticketId > 0 ? support_ticket($pdo, $ticketId) : null;
    if ($ticket === null) {
        fail(404, 'ticket_not_found', 'Ticket introuvable.');
    }
    $mine    = (int) $ticket['user_id'] === (int) $user['id'];
    $isOwner = $mine || $isAdmin;
    if (!$isOwner) {
        fail(403, 'forbidden', "Ce ticket ne t'appartient pas.");
    }
    if ((string) $ticket['status'] === 'closed' && !$isAdmin) {
        fail(409, 'ticket_closed', 'Ce ticket est fermé — ouvre-en un nouveau si besoin.');
    }

    $role = $isAdmin && !$mine ? 'team' : 'user';
    support_query(
        $pdo,
        'INSERT INTO tfh_support_messages (ticket_id, author_role, user_id, body) VALUES (?, ?, ?, ?)',
        [$ticketId, $role, (int) $user['id'], tfh_cut($body, SUPPORT_BODY_MAX)]
    );
    // Réponse équipe → « answered » ; relance joueur sur ticket répondu → « open »
    $newStatus = $role === 'team' ? 'answered' : ((string) $ticket['status'] === 'answered' ? 'open' : (string) $ticket['status']);
    $pdo->prepare('UPDATE tfh_support_tickets SET status = ?, updated_at = NOW() WHERE id = ?')
        ->execute([$newStatus, $ticketId]);

    // Notification joueur (best-effort) quand l'équipe répond
    if ($role === 'team') {
        $ust = $pdo->prepare('SELECT email, username, global_name FROM tfh_users WHERE id = ? LIMIT 1');
        $ust->execute([(int) $ticket['user_id']]);
        $urow = $ust->fetch();
        if ($urow !== false && !empty($urow['email'])) {
            $displayName = (string) ($urow['global_name'] ?: $urow['username']);
            support_mail(
                (string) $urow['email'],
                '[TheFrontHub] L\'équipe a répondu à ton ticket #' . $ticketId,
                "Bonjour {$displayName},\r\n\r\n"
                . "L'équipe TheFrontHub vient de répondre à ton ticket « {$ticket['subject']} » :\r\n\r\n"
                . tfh_cut($body, 1500) . "\r\n\r\n"
                . "→ Pour poursuivre la conversation : https://thefronthub.com/support.html"
            );
        }
    }

    json_out(['ok' => true, 'status' => $newStatus, 'author_role' => $role]);
}

/* ── Fermer un ticket (propriétaire ou équipe) ── */
if ($action === 'close') {
    $ticketId = (int) ($data['ticket_id'] ?? 0);
    $ticket   = $ticketId > 0 ? support_ticket($pdo, $ticketId) : null;
    if ($ticket === null) {
        fail(404, 'ticket_not_found', 'Ticket introuvable.');
    }
    if ((int) $ticket['user_id'] !== (int) $user['id'] && !$isAdmin) {
        fail(403, 'forbidden', "Ce ticket ne t'appartient pas.");
    }
    $pdo->prepare('UPDATE tfh_support_tickets SET status = "closed", updated_at = NOW() WHERE id = ?')
        ->execute([$ticketId]);
    json_out(['ok' => true, 'status' => 'closed']);
}

fail(400, 'unknown_action', 'Action inconnue.');
