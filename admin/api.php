<?php
declare(strict_types=1);

/**
 * task/api.php — API JSON du panel (même origine que la page).
 *
 * GET  ?action=state  → état complet (moi, personnes autorisées, tâches,
 *                       commentaires, activité, réglages, csrf)
 * GET  ?action=chat.list&task_id=…[&after=…&changed_since=…]
 *                     → messages de discussion d'une tâche
 * POST { action: ... } (JSON + en-tête X-CSRF-Token)
 *      task.create / task.status / task.edit / task.delete
 *      task.pin    / task.unarchive
 *      task.comment / comment.delete
 *      checklist.add / checklist.toggle / checklist.delete
 *      chat.send / chat.edit / chat.delete (discussion de tâche)
 *      POST multipart (form-data + X-CSRF-Token)
 *      chat.upload → message avec fichiers joints (images, vidéos, …)
 *      settings.save / webhook.test
 *      admin.add   / admin.remove
 *
 * Toute erreur non capturée renvoie du JSON lisible (voir le handler
 * d'exceptions ci-dessous) — jamais de page HTML ni de réponse vide.
 */

define('TFH_API', true);

require __DIR__ . '/lib.php';

task_security_headers();

set_exception_handler(static function (Throwable $e): void {
    error_log('[tfh-task] ' . get_class($e) . ': ' . $e->getMessage()
        . ' @ ' . basename($e->getFile()) . ':' . $e->getLine());
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(
        ['ok' => false, 'error' => 'server_error', 'message' => 'Erreur serveur : ' . $e->getMessage()],
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
});

$user = current_user($pdo);
if ($user === null) {
    fail(401, 'not_logged', 'Non connecté.');
}

task_ensure_schema($pdo);

$access = task_access($pdo, $user);
if (!$access['granted'] || $access['discord_id'] === null) {
    fail(403, 'forbidden', 'Accès au panel retiré.');
}

$meId   = (string) $access['discord_id'];
$meName = task_display_name(
    isset($user['username']) ? (string) $user['username'] : null,
    isset($user['global_name']) ? (string) $user['global_name'] : null,
    'Discord ' . substr($meId, -4)
);

/* ------------------------------------------------------------------ */
/* GET : état complet                                                  */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    $getAction = (string) ($_GET['action'] ?? '');
    $getAllowed = ['state', 'chat.list',
        /* Support : tickets + chat joueur (barre latérale de l'admin) */
        'support.tickets', 'support.thread', 'supchat.convs', 'supchat.poll'];
    if (!in_array($getAction, $getAllowed, true)) {
        fail(404, 'unknown_action', 'Action inconnue.');
    }

    if ($getAction === 'chat.list') {
        $chatTaskId = (int) ($_GET['task_id'] ?? 0);
        if ($chatTaskId < 0) {
            fail(422, 'bad_input', 'Tâche invalide.');
        }
        /* task_id = 0 → chat général de l'espace admin (pas de tâche associée). */
        if ($chatTaskId > 0) {
            $st = $pdo->prepare('SELECT id, title FROM tfh_task_tasks WHERE id = ? LIMIT 1');
            $st->execute([$chatTaskId]);
            if ($st->fetch() === false) {
                fail(404, 'not_found', 'Tâche introuvable.');
            }
        }

        /* Purge des fichiers expirés (throttlée, best-effort). */
        task_chat_prune_files($pdo);

        $after = (int) ($_GET['after'] ?? 0);
        $changedSince = (int) ($_GET['changed_since'] ?? 0);

        $params = [$chatTaskId];
        $where = 'task_id = ?';
        if ($after > 0) {
            $where .= ' AND (id > ?';
            $params[] = $after;
            if ($changedSince > 0) {
                $where .= ' OR (updated_at IS NOT NULL AND updated_at >= FROM_UNIXTIME(?))';
                $params[] = $changedSince;
            }
            $where .= ')';
        }

        $rows = [];
        try {
            $st = $pdo->prepare(
                'SELECT id, task_id, author_id, author_name, body, attachments,
                        UNIX_TIMESTAMP(created_at) AS ts,
                        UNIX_TIMESTAMP(edited_at) AS edited_ts,
                        deleted_at IS NOT NULL AS deleted
                 FROM tfh_task_chat
                 WHERE ' . $where . '
                 ORDER BY id DESC
                 LIMIT 400'
            );
            $st->execute($params);
            $rows = $st->fetchAll();
        } catch (Throwable $e) {
            error_log('[tfh-task] chat.list: ' . $e->getMessage());
        }
        $messages = [];
        foreach (array_reverse($rows) as $row) {
            $messages[] = task_chat_shape($row);
        }

        $count = 0;
        try {
            $st = $pdo->prepare(
                'SELECT COUNT(*) AS n FROM tfh_task_chat WHERE task_id = ? AND deleted_at IS NULL'
            );
            $st->execute([$chatTaskId]);
            $count = (int) ($st->fetch()['n'] ?? 0);
        } catch (Throwable $e) {
            /* compte indisponible : 0 */
        }

        json_out([
            'ok'       => true,
            'messages' => $messages,
            'count'    => $count,
            'ttl_days' => TASK_CHAT_FILE_TTL_DAYS,
        ] + ($chatTaskId === 0 ? ['people' => task_people_map($pdo)] : []));
    }

    /* ═══════════════════════════════════════════════════════════════════
       SUPPORT — tickets + chat joueur ↔ équipe (section barre latérale)
       Réutilise les tables tfh_support_* de api/support.php (auto-créées)
       et tfh_support_chat de api/chat.php.
       ═══════════════════════════════════════════════════════════════════ */

    /** Pseudo affiché d'un joueur (id site) — cache mémoire de la requête. */
    function sup_user_map(PDO $pdo, array $userIds): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $userIds))));
        if ($ids === []) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $st = $pdo->prepare(
            "SELECT id, username, global_name, avatar_url FROM tfh_users WHERE id IN ($placeholders)"
        );
        $st->execute($ids);
        $out = [];
        foreach ($st->fetchAll() as $row) {
            $g = trim((string) ($row['global_name'] ?? ''));
            $u = trim((string) ($row['username'] ?? ''));
            $out[(int) $row['id']] = [
                'name'   => $g !== '' ? $g : ($u !== '' ? $u : 'Joueur'),
                'avatar' => (string) ($row['avatar_url'] ?? ''),
            ];
        }
        return $out;
    }

    /* ── Liste de tous les tickets ── */
    if ($getAction === 'support.tickets') {
        $statusFilter = (string) ($_GET['status'] ?? '');
        $sql = 'SELECT t.id, t.user_id, t.category, t.subject, t.status, t.created_at, t.updated_at
                FROM tfh_support_tickets t';
        $params = [];
        if ($statusFilter === 'open') {
            $sql .= ' WHERE t.status IN ("open", "answered")';
        } elseif (in_array($statusFilter, ['closed'], true)) {
            $sql .= ' WHERE t.status = "closed"';
        }
        $sql .= ' ORDER BY t.updated_at DESC, t.id DESC LIMIT 200';
        $st = $pdo->prepare($sql);
        $st->execute($params);
        $rows = $st->fetchAll();
        $users = sup_user_map($pdo, array_map(static fn ($r) => (int) $r['user_id'], $rows));
        $tickets = [];
        foreach ($rows as $row) {
            $uid = (int) $row['user_id'];
            $cst = $pdo->prepare(
                'SELECT body, author_role FROM tfh_support_messages WHERE ticket_id = ? ORDER BY id DESC LIMIT 1'
            );
            $cst->execute([(int) $row['id']]);
            $last = $cst->fetch();
            $cst2 = $pdo->prepare('SELECT COUNT(*) AS n FROM tfh_support_messages WHERE ticket_id = ?');
            $cst2->execute([(int) $row['id']]);
            $tickets[] = [
                'id'          => (int) $row['id'],
                'user_id'     => $uid,
                'user_name'   => $users[$uid]['name'] ?? null,
                'user_avatar' => $users[$uid]['avatar'] ?? '',
                'category'    => (string) $row['category'],
                'subject'     => (string) $row['subject'],
                'status'      => (string) $row['status'],
                'messages'    => (int) ($cst2->fetch()['n'] ?? 0),
                'last_role'   => $last !== false ? (string) $last['author_role'] : 'user',
                'preview'     => $last !== false ? mb_substr((string) $last['body'], 0, 120) : '',
                'created_at'  => (string) $row['created_at'],
                'updated_at'  => (string) $row['updated_at'],
            ];
        }
        json_out([
            'ok'      => true,
            'tickets' => $tickets,
            'open_count' => count(array_filter($tickets, static fn ($t) => $t['status'] === 'open')),
        ]);
    }

    /* ── Fil complet d'un ticket ── */
    if ($getAction === 'support.thread') {
        $id = (int) ($_GET['id'] ?? 0);
        if ($id <= 0) {
            fail(422, 'bad_id', 'Ticket invalide.');
        }
        $st = $pdo->prepare('SELECT * FROM tfh_support_tickets WHERE id = ? LIMIT 1');
        $st->execute([$id]);
        $ticket = $st->fetch();
        if ($ticket === false) {
            fail(404, 'ticket_not_found', 'Ticket introuvable.');
        }
        $mst = $pdo->prepare(
            'SELECT id, author_role, user_id, body, created_at
             FROM tfh_support_messages WHERE ticket_id = ? ORDER BY id ASC LIMIT 500'
        );
        $mst->execute([$id]);
        $rows = $mst->fetchAll();
        $users = sup_user_map($pdo, array_map(
            static fn ($r) => $r['user_id'] !== null ? (int) $r['user_id'] : 0,
            $rows
        ));
        $owner = $users[(int) $ticket['user_id']] ?? ['name' => 'Joueur #' . (int) $ticket['user_id'], 'avatar' => ''];
        $messages = [];
        foreach ($rows as $row) {
            $uid = $row['user_id'] !== null ? (int) $row['user_id'] : null;
            $messages[] = [
                'id'          => (int) $row['id'],
                'author_role' => (string) $row['author_role'],
                'author_name' => $uid !== null ? ($users[$uid]['name'] ?? null) : 'Équipe',
                'author_avatar' => $uid !== null ? ($users[$uid]['avatar'] ?? '') : '',
                'body'        => (string) $row['body'],
                'created_at'  => (string) $row['created_at'],
            ];
        }
        json_out([
            'ok' => true,
            'ticket' => [
                'id'         => (int) $ticket['id'],
                'user_id'    => (int) $ticket['user_id'],
                'user_name'  => $owner['name'],
                'category'   => (string) $ticket['category'],
                'subject'    => (string) $ticket['subject'],
                'status'     => (string) $ticket['status'],
                'created_at' => (string) $ticket['created_at'],
                'updated_at' => (string) $ticket['updated_at'],
            ],
            'messages' => $messages,
        ]);
    }

    /* ── Conversations du chat joueur ↔ équipe ── */
    if ($getAction === 'supchat.convs') {
        try {
            $st = $pdo->prepare(
                'SELECT conv_id,
                        MAX(id) AS last_id,
                        SUM(CASE WHEN author_role = "user" AND read_by_admin = 0 THEN 1 ELSE 0 END) AS unread,
                        COUNT(*) AS total
                 FROM tfh_support_chat
                 GROUP BY conv_id
                 ORDER BY last_id DESC
                 LIMIT 100'
            );
            $st->execute();
        } catch (PDOException $e) {
            /* Table chat absente (errno 1146) → aucune conversation. */
            if ((int) ($e->errorInfo[1] ?? 0) === 1146) {
                json_out(['ok' => true, 'convs' => []]);
            }
            throw $e;
        }
        $rows = $st->fetchAll();
        $convs = [];
        foreach ($rows as $row) {
            $convId = (string) $row['conv_id'];
            $ust = $pdo->prepare(
                'SELECT u.username, u.global_name, u.avatar_url
                 FROM tfh_users u
                 JOIN tfh_user_identities i ON i.user_id = u.id AND i.provider = "discord"
                 WHERE i.provider_uid = ? COLLATE utf8mb4_unicode_ci
                 LIMIT 1'
            );
            $ust->execute([$convId]);
            $urow = $ust->fetch();
            $lst = $pdo->prepare(
                'SELECT author_role, author_name, body, created_at FROM tfh_support_chat WHERE id = ? LIMIT 1'
            );
            $lst->execute([(int) $row['last_id']]);
            $last = $lst->fetch();
            $g = $urow !== false ? trim((string) ($urow['global_name'] ?? '')) : '';
            $u = $urow !== false ? trim((string) ($urow['username'] ?? '')) : '';
            $name = $g !== '' ? $g : ($u !== '' ? $u : 'Discord …' . substr($convId, -4));
            $convs[] = [
                'conv_id'    => $convId,
                'name'       => $name,
                'avatar'     => $urow !== false ? (string) ($urow['avatar_url'] ?? '') : '',
                'unread'     => (int) ($row['unread'] ?? 0),
                'total'      => (int) ($row['total'] ?? 0),
                'last_role'  => $last !== false ? (string) $last['author_role'] : 'user',
                'last_body'  => $last !== false ? mb_substr((string) $last['body'], 0, 120) : '',
                'last_at'    => $last !== false ? (string) $last['created_at'] : '',
            ];
        }
        json_out(['ok' => true, 'convs' => $convs]);
    }

    /* ── Messages d'une conversation chat (poll, marque lus) ── */
    if ($getAction === 'supchat.poll') {
        $convId = (string) ($_GET['conv'] ?? '');
        if (!preg_match('/^\d{15,21}$/', $convId)) {
            fail(422, 'bad_conv', 'Conversation invalide.');
        }
        $after = max(0, (int) ($_GET['after'] ?? 0));
        $st = $pdo->prepare(
            'SELECT id, author_role, author_name, body, created_at
             FROM tfh_support_chat
             WHERE conv_id = ? AND id > ?
             ORDER BY id ASC LIMIT 300'
        );
        $st->execute([$convId, $after]);
        $messages = [];
        $lastId = $after;
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
        if ($messages !== []) {
            $pdo->prepare(
                'UPDATE tfh_support_chat SET read_by_admin = 1 WHERE conv_id = ? AND author_role = "user" AND read_by_admin = 0'
            )->execute([$convId]);
        }
        json_out(['ok' => true, 'messages' => $messages, 'last_id' => $lastId]);
    }

    /* Archive automatique : les tâches terminées depuis plus de 14 jours
       quittent le tableau et rejoignent l'archive (consultable à part). */
    try {
        $pdo->exec(
            "UPDATE tfh_task_tasks
             SET archived_at = NOW()
             WHERE status = 'done' AND archived_at IS NULL
               AND completed_at IS NOT NULL
               AND completed_at < (NOW() - INTERVAL 14 DAY)"
        );
    } catch (Throwable $e) {
        error_log('[tfh-task] auto-archive: ' . $e->getMessage());
    }

    /* Personnes autorisées = whitelist du panel + admins du site */
    $people = [];

    $st = $pdo->prepare(
        "SELECT ta.discord_id, ta.role AS panel_role, u.username, u.global_name, u.avatar_url
         FROM tfh_task_admins ta
         LEFT JOIN tfh_user_identities i ON i.provider = 'discord'
              AND i.provider_uid = ta.discord_id COLLATE utf8mb4_unicode_ci
         LEFT JOIN tfh_users u ON u.id = i.user_id
         ORDER BY CASE ta.role WHEN 'owner' THEN 0 ELSE 1 END, u.global_name, u.username"
    );
    $st->execute();
    foreach ($st->fetchAll() as $row) {
        $people[(string) $row['discord_id']] = [
            'id'         => (string) $row['discord_id'],
            'name'       => task_display_name(
                isset($row['username']) ? (string) $row['username'] : null,
                isset($row['global_name']) ? (string) $row['global_name'] : null,
                ''
            ),
            'avatar'     => (string) ($row['avatar_url'] ?? ''),
            'source'     => 'whitelist',
            'panel_role' => (string) $row['panel_role'],
        ];
    }

    $st = $pdo->prepare(
        "SELECT i.provider_uid AS discord_id, u.username, u.global_name, u.avatar_url
         FROM tfh_users u
         JOIN tfh_user_identities i ON i.user_id = u.id AND i.provider = 'discord'
         WHERE u.role = 'admin'"
    );
    $st->execute();
    foreach ($st->fetchAll() as $row) {
        $id = (string) $row['discord_id'];
        if (isset($people[$id])) {
            continue;
        }
        $people[$id] = [
            'id'         => $id,
            'name'       => task_display_name(
                isset($row['username']) ? (string) $row['username'] : null,
                isset($row['global_name']) ? (string) $row['global_name'] : null,
                ''
            ),
            'avatar'     => (string) ($row['avatar_url'] ?? ''),
            'source'     => 'site',
            'panel_role' => '',
        ];
    }

    $tasks = [];
    $st = $pdo->query(
        "SELECT id, title, description, status, priority, assignee_id,
                labels, pinned, milestone,
                created_by, created_by_name,
                UNIX_TIMESTAMP(created_at) AS created_ts,
                completed_by, completed_by_name,
                UNIX_TIMESTAMP(completed_at) AS completed_ts,
                UNIX_TIMESTAMP(due_at) AS due_ts,
                UNIX_TIMESTAMP(archived_at) AS archived_ts
         FROM tfh_task_tasks
         ORDER BY pinned DESC,
                  FIELD(status,'todo','in_progress','done'),
                  FIELD(priority,'high','normal','low'),
                  created_at DESC"
    );
    foreach ($st->fetchAll() as $row) {
        $tasks[] = [
            'id'                => (int) $row['id'],
            'title'             => (string) $row['title'],
            'description'       => $row['description'] !== null ? (string) $row['description'] : '',
            'status'            => (string) $row['status'],
            'priority'          => (string) $row['priority'],
            'assignee_id'       => $row['assignee_id'] !== null ? (string) $row['assignee_id'] : '',
            'labels'            => (string) $row['labels'],
            'pinned'            => (bool) $row['pinned'],
            'milestone'         => (string) ($row['milestone'] ?? ''),
            'created_by'        => (string) $row['created_by'],
            'created_by_name'   => (string) $row['created_by_name'],
            'created_ts'        => $row['created_ts'] !== null ? (int) $row['created_ts'] : null,
            'completed_by'      => $row['completed_by'] !== null ? (string) $row['completed_by'] : '',
            'completed_by_name' => $row['completed_by_name'] !== null ? (string) $row['completed_by_name'] : '',
            'completed_ts'      => $row['completed_ts'] !== null ? (int) $row['completed_ts'] : null,
            'due_ts'            => $row['due_ts'] !== null ? (int) $row['due_ts'] : null,
            'archived_ts'       => $row['archived_ts'] !== null ? (int) $row['archived_ts'] : null,
        ];
    }

    /* Sous-tâches / checklist (petite équipe : tout est renvoyé). */
    $checklist = [];
    try {
        $st = $pdo->query(
            'SELECT id, task_id, body, done
             FROM tfh_task_checklist
             ORDER BY task_id, id
             LIMIT 3000'
        );
        foreach ($st->fetchAll() as $row) {
            $checklist[] = [
                'id'      => (int) $row['id'],
                'task_id' => (int) $row['task_id'],
                'body'    => (string) $row['body'],
                'done'    => (bool) $row['done'],
            ];
        }
    } catch (Throwable $e) {
        error_log('[tfh-task] checklist: ' . $e->getMessage());
    }

    /* Commentaires (petite équipe : tout est renvoyé, filtré côté client). */
    $comments = [];
    try {
        $st = $pdo->query(
            "SELECT id, task_id, author_id, author_name, body,
                    UNIX_TIMESTAMP(created_at) AS ts
             FROM tfh_task_comments
             ORDER BY task_id, created_at, id
             LIMIT 2000"
        );
        foreach ($st->fetchAll() as $row) {
            $comments[] = [
                'id'          => (int) $row['id'],
                'task_id'     => (int) $row['task_id'],
                'author_id'   => (string) $row['author_id'],
                'author_name' => (string) $row['author_name'],
                'body'        => (string) $row['body'],
                'ts'          => $row['ts'] !== null ? (int) $row['ts'] : null,
            ];
        }
    } catch (Throwable $e) {
        error_log('[tfh-task] comments: ' . $e->getMessage());
    }

    /* Historique d'activité (120 dernières entrées). */
    $activity = [];
    try {
        $st = $pdo->query(
            "SELECT id, task_id, task_title, actor_name, action, detail,
                    UNIX_TIMESTAMP(created_at) AS ts
             FROM tfh_task_activity
             ORDER BY id DESC
             LIMIT 120"
        );
        foreach ($st->fetchAll() as $row) {
            $activity[] = [
                'id'         => (int) $row['id'],
                'task_id'    => $row['task_id'] !== null ? (int) $row['task_id'] : null,
                'task_title' => (string) $row['task_title'],
                'actor_name' => (string) $row['actor_name'],
                'action'     => (string) $row['action'],
                'detail'     => (string) $row['detail'],
                'ts'         => $row['ts'] !== null ? (int) $row['ts'] : null,
            ];
        }
    } catch (Throwable $e) {
        error_log('[tfh-task] activity: ' . $e->getMessage());
    }

    /* Discussion : nombre de messages par tâche (badges des cartes). */
    $chatCounts = [];
    try {
        $st = $pdo->query(
            'SELECT task_id, COUNT(*) AS n FROM tfh_task_chat
             WHERE deleted_at IS NULL GROUP BY task_id'
        );
        foreach ($st->fetchAll() as $row) {
            $chatCounts[(string) (int) $row['task_id']] = (int) $row['n'];
        }
    } catch (Throwable $e) {
        error_log('[tfh-task] chat_counts: ' . $e->getMessage());
    }

    /* Réglages des notifications — exposés uniquement aux gestionnaires.
       Le token du bot n'est JAMAIS renvoyé en clair (masque + 4 derniers chars). */
    $settings = null;
    if ($access['can_manage']) {
        $settings = ['webhook' => null];
        $raw = task_settings_get($pdo, 'webhook');
        if ($raw !== null) {
            $cfg = json_decode($raw, true);
            if (is_array($cfg)) {
                $hasToken = !empty($cfg['bot_token']);
                $settings['webhook'] = [
                    'mode'       => (($cfg['mode'] ?? 'webhook') === 'bot') ? 'bot' : 'webhook',
                    'url'        => (string) ($cfg['url'] ?? ''),
                    'events'     => is_array($cfg['events'] ?? null) ? $cfg['events'] : [],
                    'channel_id' => (string) ($cfg['channel_id'] ?? ''),
                    'has_token'  => $hasToken,
                    'token_hint' => $hasToken ? '••••' . substr((string) $cfg['bot_token'], -4) : '',
                    'here'       => !empty($cfg['here']),
                ];
            }
        }
    }

    json_out([
        'ok'       => true,
        'me'       => [
            'id'         => $meId,
            'name'       => $meName,
            'avatar'     => (string) ($user['avatar_url'] ?? ''),
            'site_admin' => $access['site_admin'],
            'panel_role' => $access['panel_role'],
            'can_manage' => $access['can_manage'],
        ],
        'people'    => array_values($people),
        'tasks'     => $tasks,
        'checklist' => $checklist,
        'comments'  => $comments,
        'activity'  => $activity,
        'chat_counts' => $chatCounts,
        'chat_ttl_days' => TASK_CHAT_FILE_TTL_DAYS,
        'settings'  => $settings,
        'csrf'      => task_csrf_token(),
    ]);
}

/* ------------------------------------------------------------------ */
/* POST : actions                                                      */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    fail(405, 'method_not_allowed', 'Méthode non autorisée.');
}

$ctype = (string) ($_SERVER['CONTENT_TYPE'] ?? '');
if (strpos($ctype, 'multipart/form-data') === 0) {
    /* Requête d'upload (discussion) : corps multipart/form-data.          */
    task_csrf_verify();
    $in = $_POST;
    $action = (string) ($in['action'] ?? '');
    if ($action !== 'chat.upload') {
        fail(415, 'bad_content_type', 'Cette action n\'accepte pas de fichiers.');
    }
} else {
    if (strpos($ctype, 'application/json') === false) {
        fail(415, 'bad_content_type', 'Type de contenu non autorisé.');
    }
    task_csrf_verify();
    $in = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($in)) {
        fail(400, 'bad_json', 'Requête invalide.');
    }
    $action = (string) ($in['action'] ?? '');
}

/**
 * Met en forme un message de discussion pour le client
 * (décodage des pièces jointes, horodatages). Attend un row SQL.
 */
function task_chat_shape(array $row): array
{
    $atts = [];
    $raw = (string) ($row['attachments'] ?? '');
    if ($raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            foreach ($decoded as $a) {
                if (!is_array($a) || !isset($a['id'])) {
                    continue;
                }
                $atts[] = [
                    'id'      => (string) $a['id'],
                    'name'    => (string) ($a['name'] ?? 'fichier'),
                    'size'    => (int) ($a['size'] ?? 0),
                    'mime'    => (string) ($a['mime'] ?? ''),
                    'ext'     => (string) ($a['ext'] ?? ''),
                    'width'   => isset($a['width']) ? (int) $a['width'] : null,
                    'height'  => isset($a['height']) ? (int) $a['height'] : null,
                    'expires' => isset($a['expires']) ? (int) $a['expires'] : null,
                ];
            }
        }
    }
    return [
        'id'          => (int) $row['id'],
        'task_id'     => (int) $row['task_id'],
        'author_id'   => (string) $row['author_id'],
        'author_name' => (string) $row['author_name'],
        'body'        => (string) ($row['body'] ?? ''),
        'attachments' => $atts,
        'ts'          => isset($row['ts']) && $row['ts'] !== null ? (int) $row['ts'] : null,
        'edited_ts'   => isset($row['edited_ts']) && $row['edited_ts'] !== null ? (int) $row['edited_ts'] : null,
        'deleted'     => !empty($row['deleted']),
    ];
}

/** Nombre de messages actifs d'une discussion (0 si la table est indispo). */
function task_chat_count(PDO $pdo, int $taskId): int
{
    try {
        $st = $pdo->prepare(
            'SELECT COUNT(*) AS n FROM tfh_task_chat WHERE task_id = ? AND deleted_at IS NULL'
        );
        $st->execute([$taskId]);
        return (int) ($st->fetch()['n'] ?? 0);
    } catch (Throwable $e) {
        return 0;
    }
}

/** Recharge un message SQL complet (pour renvoyer sa forme au client). */
function task_chat_fetch_row(PDO $pdo, int $msgId): ?array
{
    $st = $pdo->prepare(
        'SELECT id, task_id, author_id, author_name, body, attachments,
                UNIX_TIMESTAMP(created_at) AS ts,
                UNIX_TIMESTAMP(edited_at) AS edited_ts,
                deleted_at IS NOT NULL AS deleted
         FROM tfh_task_chat WHERE id = ? LIMIT 1'
    );
    $st->execute([$msgId]);
    $row = $st->fetch();
    return $row !== false ? $row : null;
}

/** Insère un message de discussion et renvoie sa forme client. */
function task_chat_insert(PDO $pdo, int $taskId, string $authorId, string $authorName, string $body, array $atts): array
{
    $pdo->prepare(
        'INSERT INTO tfh_task_chat (task_id, author_id, author_name, body, attachments)
         VALUES (?, ?, ?, ?, ?)'
    )->execute([
        $taskId,
        $authorId,
        task_mb_truncate($authorName, 64),
        $body !== '' ? $body : null,
        $atts !== [] ? (string) json_encode($atts, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
    ]);
    $mid = (int) $pdo->lastInsertId();
    $row = task_chat_fetch_row($pdo, $mid);
    if ($row !== null) {
        return task_chat_shape($row);
    }
    return [
        'id' => $mid, 'task_id' => $taskId, 'author_id' => $authorId,
        'author_name' => $authorName, 'body' => $body, 'attachments' => $atts,
        'ts' => time(), 'edited_ts' => null, 'deleted' => false,
    ];
}

/** Anti-spam léger : 30 messages/minute/personne (best-effort, jamais bloquant si indispo). */
function task_chat_rate_limit(PDO $pdo, string $meId): void
{
    try {
        rate_limit($pdo, 'task-chat-' . $meId, 30, 60);
    } catch (Throwable $e) {
        /* table de rate-limit absente : la discussion continue de fonctionner */
    }
}

/** Champ texte nettoyé et borné. */
function task_req_str(array $in, string $key, int $max, bool $required): string
{
    $v = trim((string) ($in[$key] ?? ''));
    if ($required && $v === '') {
        fail(422, 'missing_' . $key, 'Le champ est obligatoire.');
    }
    if (function_exists('mb_substr') ? mb_strlen($v, 'UTF-8') > $max : strlen($v) > $max) {
        fail(422, 'too_long_' . $key, 'Texte trop long (' . $max . ' caractères maximum).');
    }
    return $v;
}

/** Assignee valide (whitelist ou admin du site) ou null. */
function task_req_assignee(PDO $pdo, array $in): ?string
{
    $id = trim((string) ($in['assignee_id'] ?? ''));
    if ($id === '') {
        return null;
    }
    if (!preg_match('/^\d{15,21}$/', $id) || !task_is_person($pdo, $id)) {
        fail(422, 'bad_assignee', 'La personne assignée est inconnue.');
    }
    return $id;
}

/** Liste d'étiquettes validée (clés connus, sans doublon, 4 max) → CSV. */
function task_req_labels(array $in): string
{
    $keys = $in['labels'] ?? [];
    if (!is_array($keys)) {
        return '';
    }
    $out = [];
    foreach ($keys as $k) {
        $k = trim((string) $k);
        if ($k !== '' && in_array($k, TASK_LABEL_KEYS, true) && !in_array($k, $out, true)) {
            $out[] = $k;
        }
        if (count($out) >= 4) {
            break;
        }
    }
    return implode(',', $out);
}

/** Date d'échéance validée (YYYY-MM-DD) ou null. */
function task_req_due(array $in): ?string
{
    $d = trim((string) ($in['due'] ?? ''));
    if ($d === '') {
        return null;
    }
    $dt = DateTime::createFromFormat('Y-m-d', $d);
    if ($dt === false || $dt->format('Y-m-d') !== $d) {
        fail(422, 'bad_due', 'Date d\'échéance invalide.');
    }
    return $d;
}

/** Version / jalon (texte libre court) ou chaîne vide. */
function task_req_milestone(array $in): string
{
    $m = trim((string) ($in['milestone'] ?? ''));
    $m = preg_replace('/\s+/u', ' ', $m);
    if (function_exists('mb_substr') ? mb_strlen($m, 'UTF-8') > 80 : strlen($m) > 80) {
        $m = function_exists('mb_substr') ? mb_substr($m, 0, 80, 'UTF-8') : substr($m, 0, 80);
    }
    return $m;
}

/** Mail UTF-8 générique côté admin — best-effort, jamais bloquant. */
function sup_admin_mail(string $to, string $subject, string $body, string $from, string $inReplyTo = ''): bool
{
    if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
        return false;
    }
    $headers = implode("\r\n", array_filter([
        'From: ' . ($from !== '' ? $from : 'TheFrontHub <no-reply@thefronthub.com>'),
        $inReplyTo !== '' ? 'In-Reply-To: ' . $inReplyTo : '',
        $inReplyTo !== '' ? 'References: ' . $inReplyTo : '',
        'Content-Type: text/plain; charset=UTF-8',
        'X-Mailer: TheFrontHub-Admin',
    ]));
    try {
        $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
        return @mail($to, $encodedSubject, $body, $headers) === true;
    } catch (Throwable $e) {
        error_log('[tfh-task] mail() indisponible : ' . $e->getMessage());
        return false;
    }
}

switch ($action) {

    case 'task.create': {
        $title      = task_req_str($in, 'title', 180, true);
        $desc       = task_req_str($in, 'description', 4000, false);
        $priority   = (string) ($in['priority'] ?? 'normal');
        $assigneeId = task_req_assignee($pdo, $in);
        $labels     = task_req_labels($in);
        $due        = task_req_due($in);
        $milestone  = task_req_milestone($in);

        if (!in_array($priority, ['low', 'normal', 'high'], true)) {
            $priority = 'normal';
        }

        $pdo->prepare(
            'INSERT INTO tfh_task_tasks
             (title, description, status, priority, assignee_id, labels, pinned, milestone,
              created_by, created_by_name, due_at, created_at)
             VALUES (?, ?, \'todo\', ?, ?, ?, 0, ?, ?, ?, ?, NOW())'
        )->execute([
            $title,
            $desc !== '' ? $desc : null,
            $priority,
            $assigneeId,
            $labels,
            $milestone,
            $meId,
            $meName,
            $due,
        ]);

        $newId = (int) $pdo->lastInsertId();

        task_log_activity($pdo, $newId, $title, $meId, $meName, 'create');

        task_webhook_send($pdo, 'create', [
            'id'           => $newId,
            'title'        => $title,
            'description'  => $desc,
            'priority'     => $priority,
            'assignee_id'  => (string) $assigneeId,
            'assignee_name' => $assigneeId !== null ? task_person_name($pdo, $assigneeId) : '',
            'due'          => $due,
            'milestone'    => $milestone,
            'created_by_name' => $meName,
        ]);

        json_out(['ok' => true, 'id' => $newId]);
    }

    case 'task.status': {
        $id     = (int) ($in['id'] ?? 0);
        $status = (string) ($in['status'] ?? '');
        if ($id <= 0 || !in_array($status, ['todo', 'in_progress', 'done'], true)) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }

        $old = null;
        $st  = $pdo->prepare(
            'SELECT title, description, priority, assignee_id, milestone, status, due_at FROM tfh_task_tasks WHERE id = ? LIMIT 1'
        );
        $st->execute([$id]);
        $old = $st->fetch();
        if ($old === false) {
            fail(404, 'not_found', 'Tâche introuvable.');
        }

        /* Aucun changement : ne renvoie pas de notification Discord en double. */
        if ((string) $old['status'] === $status) {
            json_out(['ok' => true]);
        }

        $ms = trim((string) ($old['milestone'] ?? ''));

        if ($status === 'done') {
            $pdo->prepare(
                "UPDATE tfh_task_tasks
                 SET status = 'done', completed_by = ?, completed_by_name = ?, completed_at = NOW()
                 WHERE id = ?"
            )->execute([$meId, $meName, $id]);
        } else {
            $pdo->prepare(
                'UPDATE tfh_task_tasks
                 SET status = ?, completed_by = NULL, completed_by_name = NULL, completed_at = NULL
                 WHERE id = ?'
            )->execute([$status, $id]);
        }

        $statusLabels = ['todo' => 'À faire', 'in_progress' => 'En cours', 'done' => 'Terminé'];
        task_log_activity($pdo, $id, (string) $old['title'], $meId, $meName, 'status',
            '→ ' . ($statusLabels[$status] ?? $status));

        $whBase = [
            'id'           => $id,
            'title'        => (string) $old['title'],
            'description'  => (string) $old['description'],
            'priority'     => (string) $old['priority'],
            'assignee_id'  => (string) ($old['assignee_id'] ?? ''),
            'assignee_name' => (string) $old['assignee_id'] !== '' ? task_person_name($pdo, (string) $old['assignee_id']) : '',
            'due'          => $old['due_at'] !== null ? substr((string) $old['due_at'], 0, 10) : '',
            'milestone'    => $ms,
        ];

        if ($status === 'in_progress') {
            task_webhook_send($pdo, 'start', $whBase + ['started_by_name' => $meName]);
        }

        if ($status === 'done') {
            task_webhook_send($pdo, 'done', $whBase + ['completed_by_name' => $meName]);
        }

        json_out(['ok' => true]);
    }

    case 'task.edit': {
        $id         = (int) ($in['id'] ?? 0);
        $title      = task_req_str($in, 'title', 180, true);
        $desc       = task_req_str($in, 'description', 4000, false);
        $priority   = (string) ($in['priority'] ?? 'normal');
        $assigneeId = task_req_assignee($pdo, $in);
        $labels     = task_req_labels($in);
        $due        = task_req_due($in);
        $milestone  = task_req_milestone($in);

        if ($id <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        if (!in_array($priority, ['low', 'normal', 'high'], true)) {
            $priority = 'normal';
        }

        $st = $pdo->prepare(
            'SELECT title, description, priority, assignee_id, labels, milestone, due_at FROM tfh_task_tasks WHERE id = ? LIMIT 1'
        );
        $st->execute([$id]);
        $old = $st->fetch();
        if ($old === false) {
            fail(404, 'not_found', 'Tâche introuvable.');
        }

        $pdo->prepare(
            'UPDATE tfh_task_tasks
             SET title = ?, description = ?, priority = ?, assignee_id = ?, labels = ?, milestone = ?, due_at = ?
             WHERE id = ?'
        )->execute([
            $title,
            $desc !== '' ? $desc : null,
            $priority,
            $assigneeId,
            $labels,
            $milestone,
            $due,
            $id,
        ]);

        /* Historique : liste concise des champs modifiés. */
        $oldDue   = $old['due_at'] !== null ? substr((string) $old['due_at'], 0, 10) : '';
        $changes  = [];
        if ((string) $old['title'] !== $title) {
            $changes[] = 'titre';
        }
        if ((string) ($old['description'] ?? '') !== ($desc !== '' ? $desc : '')) {
            $changes[] = 'description';
        }
        if ((string) $old['priority'] !== $priority) {
            $changes[] = 'priorité';
        }
        $oldAssignee = $old['assignee_id'] !== null ? (string) $old['assignee_id'] : '';
        $newAssignee = $assigneeId ?? '';
        if ($oldAssignee !== $newAssignee) {
            $changes[] = 'responsable';
        }
        if ((string) ($old['labels'] ?? '') !== $labels) {
            $changes[] = 'étiquettes';
        }
        if ((string) ($old['milestone'] ?? '') !== $milestone) {
            $changes[] = 'version';
        }
        if ($oldDue !== (string) ($due ?? '')) {
            $changes[] = 'échéance';
        }
        if ($changes !== []) {
            task_log_activity($pdo, $id, $title, $meId, $meName, 'edit', 'Modifié : ' . implode(', ', $changes));
        }

        /* Notification d'assignation uniquement quand le responsable change. */
        if ($newAssignee !== '' && $oldAssignee !== $newAssignee) {
            task_webhook_send($pdo, 'assign', [
                'id'           => $id,
                'title'        => $title,
                'description'  => $desc,
                'priority'     => $priority,
                'assignee_id'  => $newAssignee,
                'assignee_name' => task_person_name($pdo, $newAssignee),
                'due'          => $due,
                'milestone'    => $milestone,
                'created_by_name' => $meName,
            ]);
        }

        json_out(['ok' => true]);
    }

    case 'task.delete': {
        $id = (int) ($in['id'] ?? 0);
        if ($id <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $st = $pdo->prepare('SELECT title FROM tfh_task_tasks WHERE id = ? LIMIT 1');
        $st->execute([$id]);
        $row = $st->fetch();
        if ($row !== false) {
            task_log_activity($pdo, $id, (string) $row['title'], $meId, $meName, 'delete');
        }
        $pdo->prepare('DELETE FROM tfh_task_tasks WHERE id = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM tfh_task_comments WHERE task_id = ?')->execute([$id]);
        try {
            $pdo->prepare('DELETE FROM tfh_task_checklist WHERE task_id = ?')->execute([$id]);
        } catch (Throwable $e) {
            error_log('[tfh-task] checklist cleanup: ' . $e->getMessage());
        }
        json_out(['ok' => true]);
    }

    case 'task.pin': {
        $id     = (int) ($in['id'] ?? 0);
        $pinned = !empty($in['pinned']);
        if ($id <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $pdo->prepare('UPDATE tfh_task_tasks SET pinned = ? WHERE id = ?')
            ->execute([$pinned ? 1 : 0, $id]);
        $st = $pdo->prepare('SELECT title FROM tfh_task_tasks WHERE id = ? LIMIT 1');
        $st->execute([$id]);
        $row = $st->fetch();
        if ($row !== false) {
            task_log_activity($pdo, $id, (string) $row['title'], $meId, $meName, $pinned ? 'pin' : 'unpin');
        }
        json_out(['ok' => true, 'pinned' => $pinned]);
    }

    case 'task.unarchive': {
        $id = (int) ($in['id'] ?? 0);
        if ($id <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $st = $pdo->prepare('SELECT title FROM tfh_task_tasks WHERE id = ? LIMIT 1');
        $st->execute([$id]);
        $row = $st->fetch();
        if ($row === false) {
            fail(404, 'not_found', 'Tâche introuvable.');
        }
        $pdo->prepare(
            "UPDATE tfh_task_tasks
             SET archived_at = NULL, status = 'todo',
                 completed_by = NULL, completed_by_name = NULL, completed_at = NULL
             WHERE id = ?"
        )->execute([$id]);
        task_log_activity($pdo, $id, (string) $row['title'], $meId, $meName, 'unarchive');
        json_out(['ok' => true]);
    }

    case 'task.comment': {
        $id   = (int) ($in['id'] ?? 0);
        $body = task_req_str($in, 'body', 2000, true);
        if ($id <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $st = $pdo->prepare('SELECT title FROM tfh_task_tasks WHERE id = ? LIMIT 1');
        $st->execute([$id]);
        $row = $st->fetch();
        if ($row === false) {
            fail(404, 'not_found', 'Tâche introuvable.');
        }
        $pdo->prepare(
            'INSERT INTO tfh_task_comments (task_id, author_id, author_name, body) VALUES (?, ?, ?, ?)'
        )->execute([$id, $meId, $meName, $body]);
        $cid = (int) $pdo->lastInsertId();
        task_log_activity($pdo, $id, (string) $row['title'], $meId, $meName, 'comment',
            task_mb_truncate($body, 80));
        json_out([
            'ok' => true,
            'comment' => [
                'id'          => $cid,
                'task_id'     => $id,
                'author_id'   => $meId,
                'author_name' => $meName,
                'body'        => $body,
                'ts'          => time(),
            ],
        ]);
    }

    case 'comment.delete': {
        $cid = (int) ($in['comment_id'] ?? 0);
        if ($cid <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $st = $pdo->prepare('SELECT task_id, author_id, author_name, body FROM tfh_task_comments WHERE id = ? LIMIT 1');
        $st->execute([$cid]);
        $row = $st->fetch();
        if ($row === false) {
            fail(404, 'not_found', 'Commentaire introuvable.');
        }
        if ((string) $row['author_id'] !== $meId && !$access['can_manage']) {
            fail(403, 'forbidden', 'Ce commentaire n\'est pas le tien.');
        }
        $pdo->prepare('DELETE FROM tfh_task_comments WHERE id = ?')->execute([$cid]);
        json_out(['ok' => true]);
    }

    /* ── Sous-tâches / checklist ─────────────────────────────────────────── */

    case 'checklist.add': {
        $id   = (int) ($in['id'] ?? 0);
        $body = task_req_str($in, 'body', 200, true);
        if ($id <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $st = $pdo->prepare('SELECT 1 FROM tfh_task_tasks WHERE id = ? LIMIT 1');
        $st->execute([$id]);
        if ($st->fetch() === false) {
            fail(404, 'not_found', 'Tâche introuvable.');
        }
        $pdo->prepare('INSERT INTO tfh_task_checklist (task_id, body, done) VALUES (?, ?, 0)')
            ->execute([$id, $body]);
        json_out([
            'ok'   => true,
            'item' => [
                'id'      => (int) $pdo->lastInsertId(),
                'task_id' => $id,
                'body'    => $body,
                'done'    => false,
            ],
        ]);
    }

    case 'checklist.toggle': {
        $itemId = (int) ($in['item_id'] ?? 0);
        $done   = !empty($in['done']);
        if ($itemId <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $pdo->prepare('UPDATE tfh_task_checklist SET done = ? WHERE id = ?')
            ->execute([$done ? 1 : 0, $itemId]);
        json_out(['ok' => true, 'done' => $done]);
    }

    case 'checklist.delete': {
        $itemId = (int) ($in['item_id'] ?? 0);
        if ($itemId <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $pdo->prepare('DELETE FROM tfh_task_checklist WHERE id = ?')->execute([$itemId]);
        json_out(['ok' => true]);
    }

    /* ── Discussion de tâche (style Discord) ─────────────────────────────── */

    case 'chat.send': {
        $id   = (int) ($in['id'] ?? 0);
        $body = task_req_str($in, 'body', 4000, true);
        if ($id < 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        /* id = 0 → chat général de l'espace admin. */
        if ($id > 0) {
            $st = $pdo->prepare('SELECT id, title FROM tfh_task_tasks WHERE id = ? LIMIT 1');
            $st->execute([$id]);
            if ($st->fetch() === false) {
                fail(404, 'not_found', 'Tâche introuvable.');
            }
        }
        task_chat_rate_limit($pdo, $meId);
        $msg = task_chat_insert($pdo, $id, $meId, $meName, $body, []);
        json_out(['ok' => true, 'message' => $msg, 'count' => task_chat_count($pdo, $id)]);
    }

    case 'chat.upload': {
        $id = (int) ($in['id'] ?? 0);
        if ($id < 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        /* id = 0 → chat général de l'espace admin. */
        if ($id > 0) {
            $st = $pdo->prepare('SELECT id, title FROM tfh_task_tasks WHERE id = ? LIMIT 1');
            $st->execute([$id]);
            if ($st->fetch() === false) {
                fail(404, 'not_found', 'Tâche introuvable.');
            }
        }

        $body = trim((string) ($in['body'] ?? ''));
        if ((function_exists('mb_strlen') ? mb_strlen($body, 'UTF-8') : strlen($body)) > 4000) {
            fail(422, 'too_long_body', 'Message trop long (4000 caractères maximum).');
        }

        $files = $_FILES['files'] ?? null;
        if (!is_array($files) || !is_array($files['name'] ?? null) || count($files['name']) === 0) {
            fail(422, 'no_files', 'Aucun fichier reçu.');
        }
        $n = count($files['name']);
        if ($n > TASK_CHAT_MAX_FILES) {
            fail(422, 'too_many_files', TASK_CHAT_MAX_FILES . ' fichiers maximum par message.');
        }

        task_chat_rate_limit($pdo, $meId);

        $dir = task_upload_files_dir();
        if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
            fail(500, 'storage', 'Stockage des fichiers indisponible sur le serveur.');
        }

        $expiresTs = time() + TASK_CHAT_FILE_TTL_DAYS * 86400;
        $expires   = date('Y-m-d H:i:s', $expiresTs);
        $atts      = [];
        $fileRows  = []; /* [id, path, name, mime, ext, size, w, h] */

        for ($i = 0; $i < $n; $i++) {
            $err  = (int) ($files['error'][$i] ?? UPLOAD_ERR_NO_FILE);
            $orig = (string) ($files['name'][$i] ?? '');
            $tmp  = (string) ($files['tmp_name'][$i] ?? '');
            $size = (int) ($files['size'][$i] ?? 0);

            if ($err === UPLOAD_ERR_NO_FILE) {
                continue;
            }
            if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
                fail(422, 'file_too_big', '« ' . $orig . ' » dépasse la limite d\'upload du serveur.');
            }
            if ($err !== UPLOAD_ERR_OK || $tmp === '' || !is_uploaded_file($tmp)) {
                fail(500, 'upload_failed', 'Envoi impossible pour « ' . $orig . ' » — réessaie.');
            }
            if ($size > TASK_CHAT_MAX_BYTES) {
                fail(422, 'file_too_big', '« ' . $orig . ' » dépasse 10 Mo.');
            }
            $ext = strtolower((string) pathinfo($orig, PATHINFO_EXTENSION));
            $ext = preg_replace('/[^a-z0-9]/', '', substr($ext, 0, 10));
            if ($ext === '' || !task_chat_ext_allowed($ext)) {
                fail(422, 'bad_file_type', 'Type de fichier non autorisé : « ' . $orig . ' ».');
            }
            $orig = preg_replace('/[\x00-\x1F\x7F]+/', '', $orig);
            $orig = trim((string) $orig);
            if ($orig === '') {
                $orig = 'fichier.' . $ext;
            }
            $orig = task_mb_truncate($orig, 150);

            /* Type MIME réel détecté (jamais celui annoncé par le navigateur). */
            $mime = '';
            if (function_exists('finfo_open')) {
                $fi = finfo_open(FILEINFO_MIME_TYPE);
                if ($fi) {
                    $mime = (string) finfo_file($fi, $tmp);
                    finfo_close($fi);
                }
            }
            if ($mime === '' || $mime === 'application/octet-stream') {
                $map = [
                    'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
                    'gif' => 'image/gif', 'webp' => 'image/webp', 'pdf' => 'application/pdf',
                    'mp4' => 'video/mp4', 'webm' => 'video/webm', 'mp3' => 'audio/mpeg',
                    'txt' => 'text/plain', 'md' => 'text/plain', 'csv' => 'text/plain',
                    'json' => 'application/json', 'zip' => 'application/zip',
                ];
                $mime = $map[$ext] ?? 'application/octet-stream';
            }

            $fid  = bin2hex(random_bytes(8));
            $disk = date('Ymd') . '_' . $fid . '.' . $ext;
            $dest = $dir . '/' . $disk;
            if (!@move_uploaded_file($tmp, $dest)) {
                fail(500, 'storage', 'Écriture impossible pour « ' . $orig . ' ».');
            }
            @chmod($dest, 0644);

            $w = null;
            $h = null;
            if (in_array($ext, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'], true)) {
                $info = @getimagesize($dest);
                if (is_array($info)) {
                    $w = (int) $info[0];
                    $h = (int) $info[1];
                }
            }

            $fileRows[] = [$fid, 'files/' . $disk, $orig, $mime, $ext, $size, $w, $h];
            $atts[] = [
                'id'      => $fid,
                'name'    => $orig,
                'size'    => $size,
                'mime'    => $mime,
                'ext'     => $ext,
                'width'   => $w,
                'height'  => $h,
                'expires' => $expiresTs,
            ];
        }

        if ($fileRows === []) {
            fail(422, 'no_files', 'Aucun fichier reçu.');
        }

        $msg = task_chat_insert($pdo, $id, $meId, $meName, $body, $atts);
        $ins = $pdo->prepare(
            'INSERT INTO tfh_task_chat_files
             (id, task_id, msg_id, path, name, mime, ext, size, width, height, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        foreach ($fileRows as $r) {
            try {
                $ins->execute([$r[0], $id, $msg['id'], $r[1], $r[2], $r[3], $r[4], $r[5], $r[6], $r[7], $expires]);
            } catch (Throwable $e) {
                error_log('[tfh-task] chat file row: ' . $e->getMessage());
            }
        }

        json_out(['ok' => true, 'message' => $msg, 'count' => task_chat_count($pdo, $id)]);
    }

    case 'chat.edit': {
        $mid  = (int) ($in['message_id'] ?? 0);
        $body = task_req_str($in, 'body', 4000, true);
        if ($mid <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $row = task_chat_fetch_row($pdo, $mid);
        if ($row === null) {
            fail(404, 'not_found', 'Message introuvable.');
        }
        if ((string) $row['author_id'] !== $meId) {
            fail(403, 'forbidden', 'Seul l\'auteur peut modifier son message.');
        }
        if (!empty($row['deleted'])) {
            fail(410, 'deleted', 'Ce message a été supprimé.');
        }
        $pdo->prepare('UPDATE tfh_task_chat SET body = ?, edited_at = NOW(), updated_at = NOW() WHERE id = ?')
            ->execute([$body, $mid]);
        $row = task_chat_fetch_row($pdo, $mid);
        json_out(['ok' => true, 'message' => task_chat_shape($row)]);
    }

    case 'chat.delete': {
        $mid = (int) ($in['message_id'] ?? 0);
        if ($mid <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $row = task_chat_fetch_row($pdo, $mid);
        if ($row === null) {
            fail(404, 'not_found', 'Message introuvable.');
        }
        if ((string) $row['author_id'] !== $meId && !$access['can_manage']) {
            fail(403, 'forbidden', 'Tu ne peux supprimer que tes propres messages.');
        }
        if (empty($row['deleted'])) {
            $pdo->prepare(
                'UPDATE tfh_task_chat
                 SET deleted_at = NOW(), updated_at = NOW(), body = NULL, attachments = NULL
                 WHERE id = ?'
            )->execute([$mid]);
            try {
                $st = $pdo->prepare('SELECT id, path FROM tfh_task_chat_files WHERE msg_id = ?');
                $st->execute([$mid]);
                $del = $pdo->prepare('DELETE FROM tfh_task_chat_files WHERE id = ?');
                foreach ($st->fetchAll() as $f) {
                    $abs = task_upload_dir() . '/' . ltrim((string) $f['path'], '/');
                    if (strpos($abs, task_upload_dir()) === 0 && is_file($abs)) {
                        @unlink($abs);
                    }
                    $del->execute([(string) $f['id']]);
                }
            } catch (Throwable $e) {
                error_log('[tfh-task] chat.delete files: ' . $e->getMessage());
            }
        }
        json_out(['ok' => true, 'count' => task_chat_count($pdo, (int) $row['task_id'])]);
    }

    case 'settings.save': {
        if (!$access['can_manage']) {
            fail(403, 'forbidden', 'Réservé aux gestionnaires du panel.');
        }
        $wh = $in['webhook'] ?? null;
        if (!is_array($wh)) {
            fail(422, 'bad_input', 'Réglages invalides.');
        }
        $mode    = (($wh['mode'] ?? 'webhook') === 'bot') ? 'bot' : 'webhook';
        $url     = trim((string) ($wh['url'] ?? ''));
        $channel = trim((string) ($wh['channel_id'] ?? ''));
        $tokenIn = trim((string) ($wh['bot_token'] ?? ''));
        if ($mode === 'webhook' && $url !== '' && !task_webhook_valid_url($url)) {
            fail(422, 'bad_webhook_url', 'URL de webhook invalide — colle l\'URL complète d\'un webhook Discord (https://discord.com/api/webhooks/…).');
        }
        if ($mode === 'bot') {
            if ($channel !== '' && !preg_match('/^\d{15,21}$/', $channel)) {
                fail(422, 'bad_channel', 'ID de salon invalide — chiffres uniquement (clic droit sur le salon → « Copier l\'identifiant du salon »).');
            }
            if ($tokenIn !== '' && !preg_match('/^[A-Za-z0-9_\.\-]{50,120}$/', $tokenIn)) {
                fail(422, 'bad_token', 'Token de bot invalide — copie-le depuis le Developer Portal (Bot → Reset Token) ou Render (Environment → DISCORD_TOKEN).');
            }
        }
        $events = [
            'create' => !empty($wh['events']['create']),
            'assign' => !empty($wh['events']['assign']),
            'start'  => !empty($wh['events']['start']),
            'done'   => !empty($wh['events']['done']),
        ];
        /* Token : vide = conserver celui déjà enregistré. */
        $old = [];
        $oldRaw = task_settings_get($pdo, 'webhook');
        if ($oldRaw !== null) {
            $dec = json_decode($oldRaw, true);
            if (is_array($dec)) {
                $old = $dec;
            }
        }
        $token = $tokenIn !== '' ? $tokenIn : (string) ($old['bot_token'] ?? '');
        task_settings_set($pdo, 'webhook', (string) json_encode([
            'mode'       => $mode,
            'url'        => $url,
            'events'     => $events,
            'channel_id' => $channel,
            'bot_token'  => $token,
            'here'       => !empty($wh['here']),
        ], JSON_UNESCAPED_SLASHES));
        if ($mode === 'bot') {
            $label = ($token !== '' && $channel !== '')
                ? 'Notifications Discord branchées sur le bot'
                : 'Notifications Discord reconfigurées (mode bot)';
        } else {
            $label = $url !== '' ? 'Notifications Discord configurées' : 'Notifications Discord désactivées';
        }
        task_log_activity($pdo, null, '', $meId, $meName, 'settings', $label);
        json_out(['ok' => true]);
    }

    case 'webhook.test': {
        if (!$access['can_manage']) {
            fail(403, 'forbidden', 'Réservé aux gestionnaires du panel.');
        }
        $mode = (($in['mode'] ?? 'webhook') === 'bot') ? 'bot' : 'webhook';
        $cfg  = [];
        $raw  = task_settings_get($pdo, 'webhook');
        if ($raw !== null) {
            $dec = json_decode($raw, true);
            if (is_array($dec)) {
                $cfg = $dec;
            }
        }

        if ($mode === 'bot') {
            $token   = trim((string) ($in['bot_token'] ?? ''));
            if ($token === '') {
                $token = (string) ($cfg['bot_token'] ?? '');
            }
            $channel = trim((string) ($in['channel_id'] ?? ''));
            if ($channel === '') {
                $channel = (string) ($cfg['channel_id'] ?? '');
            }
            if ($token === '' || $channel === '') {
                fail(422, 'no_bot', 'Colle d\'abord le token du bot et l\'ID du salon (ou enregistre-les) puis reteste.');
            }
            if (!preg_match('/^\d{15,21}$/', $channel)) {
                fail(422, 'bad_channel', 'ID de salon invalide — chiffres uniquement (clic droit sur le salon → « Copier l\'identifiant du salon »).');
            }
            if (!preg_match('/^[A-Za-z0-9_\.\-]{50,120}$/', $token)) {
                fail(422, 'bad_token', 'Token de bot invalide — copie-le depuis le Developer Portal (Bot → Reset Token) ou Render (Environment → DISCORD_TOKEN).');
            }
            [$ok, $code, $err] = task_bot_api_post($token, $channel, [
                'content' => '✅ Notifications branchées sur ton bot ! Test lancé par <@' . $meId . ' depuis le panel de tâches.',
                'embeds'  => [[
                    'title'       => 'Notifications connectées',
                    'url'         => 'https://task.thefronthub.com/',
                    'color'       => 0x10B981,
                    'footer'      => ['text' => 'TheFrontHub — envoyé via l\'API du bot'],
                ]],
                'allowed_mentions' => ['parse' => ['users']],
            ]);
            if (!$ok) {
                if ($code === 401) {
                    fail(502, 'bot_failed', 'Token refusé par Discord (401) — réinitialise le token dans le Developer Portal et recolle-le.');
                }
                if ($code === 403) {
                    fail(502, 'bot_failed', 'Le bot n\'a pas le droit d\'écrire dans ce salon (403) — ajoute le bot (ou son rôle) dans les permissions du salon.');
                }
                if ($code === 404) {
                    fail(502, 'bot_failed', 'Salon introuvable (404) — vérifie l\'ID du salon (mode développeur → clic droit → Copier l\'identifiant).');
                }
                if ($code === 429) {
                    fail(502, 'bot_failed', 'Trop de messages à la suite (429) — reteste dans quelques secondes.');
                }
                fail(502, 'bot_failed', 'Envoi impossible (' . ($err !== '' ? $err : 'HTTP ' . $code) . ').');
            }
            json_out(['ok' => true]);
        }

        /* Mode webhook (historique). */
        $url = trim((string) ($in['url'] ?? ''));
        if ($url === '') {
            $url = (string) ($cfg['url'] ?? '');
        }
        if ($url === '') {
            fail(422, 'no_webhook', 'Colle d\'abord une URL de webhook (ou enregistre-la) puis reteste.');
        }
        if (!task_webhook_valid_url($url)) {
            fail(422, 'bad_webhook_url', 'URL de webhook invalide — colle l\'URL complète d\'un webhook Discord.');
        }
        [$ok, $code, $err] = task_webhook_post($url, [
            'content' => 'Test du panel de tâches TheFrontHub — si tu vois ce message, les notifications fonctionnent !',
            'embeds'  => [[
                'title' => 'Notifications connectées',
                'url'   => 'https://task.thefronthub.com/',
                'color' => 0x10B981,
            ]],
            'allowed_mentions' => ['parse' => []],
        ]);
        if (!$ok) {
            fail(502, 'webhook_failed', 'Envoi impossible (' . ($err !== '' ? $err : 'HTTP ' . $code) . '). Vérifie l\'URL du webhook.');
        }
        json_out(['ok' => true]);
    }

    case 'admin.add': {
        if (!$access['can_manage']) {
            fail(403, 'forbidden', 'Réservé aux gestionnaires du panel.');
        }
        $did = trim((string) ($in['discord_id'] ?? ''));
        if (!preg_match('/^\d{15,21}$/', $did)) {
            fail(422, 'bad_id', 'ID Discord invalide (15 à 21 chiffres).');
        }
        if (task_whitelist_role($pdo, $did) !== null) {
            fail(409, 'already_in_list', 'Ce compte est déjà dans la liste.');
        }
        if (task_is_site_admin_discord($pdo, $did)) {
            fail(409, 'already_site_admin', 'Ce compte est déjà admin du site : il a déjà accès au panel.');
        }
        $pdo->prepare('INSERT INTO tfh_task_admins (discord_id, role, added_by, added_at) VALUES (?, ?, ?, NOW())')
            ->execute([$did, 'admin', $meId]);
        task_log_activity($pdo, null, '', $meId, $meName, 'admin_add', 'Admin ajouté : ' . $did);
        json_out(['ok' => true]);
    }

    case 'admin.remove': {
        if (!$access['can_manage']) {
            fail(403, 'forbidden', 'Réservé aux gestionnaires du panel.');
        }
        $did = trim((string) ($in['discord_id'] ?? ''));
        if (!preg_match('/^\d{15,21}$/', $did)) {
            fail(422, 'bad_id', 'ID Discord invalide.');
        }
        $role = task_whitelist_role($pdo, $did);
        if ($role === null) {
            fail(404, 'not_in_list', "Ce compte n'est pas dans la liste du panel.");
        }
        if ($role === 'owner') {
            fail(403, 'owner_locked', 'Le propriétaire du panel ne peut pas être retiré.');
        }
        if ($did === $meId) {
            fail(422, 'self_remove', 'Tu ne peux pas te retirer toi-même.');
        }
        $pdo->prepare('DELETE FROM tfh_task_admins WHERE discord_id = ?')->execute([$did]);
        task_log_activity($pdo, null, '', $meId, $meName, 'admin_remove', 'Admin retiré : ' . $did);
        json_out(['ok' => true]);
    }

    /* ═══════════════════════════════════════════════════════════════════
       SUPPORT — réponses de l'équipe (tickets + chat)
       ═══════════════════════════════════════════════════════════════════ */

    case 'support.reply': {
        $ticketId = (int) ($in['ticket_id'] ?? 0);
        $message  = task_req_str($in, 'message', 5000, true);
        if ($ticketId <= 0) {
            fail(422, 'bad_id', 'Ticket invalide.');
        }
        $st = $pdo->prepare('SELECT * FROM tfh_support_tickets WHERE id = ? LIMIT 1');
        $st->execute([$ticketId]);
        $ticket = $st->fetch();
        if ($ticket === false) {
            fail(404, 'ticket_not_found', 'Ticket introuvable.');
        }
        try {
            $pdo->prepare(
                'INSERT INTO tfh_support_messages (ticket_id, author_role, user_id, body) VALUES (?, "team", NULL, ?)'
            )->execute([$ticketId, $message]);
        } catch (PDOException $e) {
            if ((int) ($e->errorInfo[1] ?? 0) === 1146) {
                fail(409, 'schema_missing', 'Les tables support ne sont pas encore créées — ouvre un ticket depuis le site pour les initialiser.');
            }
            throw $e;
        }
        $pdo->prepare('UPDATE tfh_support_tickets SET status = "answered", updated_at = NOW() WHERE id = ?')
            ->execute([$ticketId]);

        /* Mail au joueur (best-effort) — même contenu que la réponse site. */
        $ust = $pdo->prepare(
            'SELECT u.email, u.username, u.global_name
             FROM tfh_users u WHERE u.id = ? LIMIT 1'
        );
        $ust->execute([(int) $ticket['user_id']]);
        $urow = $ust->fetch();
        if ($urow !== false && !empty($urow['email'])) {
            $displayName = task_display_name(
                isset($urow['username']) ? (string) $urow['username'] : null,
                isset($urow['global_name']) ? (string) $urow['global_name'] : null,
                'Joueur'
            );
            $subject = (string) $ticket['subject'];
            sup_admin_mail(
                (string) $urow['email'],
                "[TheFrontHub] L'équipe a répondu à ton ticket #{$ticketId}",
                "Bonjour {$displayName},\r\n\r\n"
                . "L'équipe TheFrontHub vient de répondre à ton ticket « {$subject} » :\r\n\r\n"
                . $message . "\r\n\r\n"
                . "→ Pour poursuivre la conversation : https://thefronthub.com/support.html",
                'TheFrontHub Support <support@thefronthub.com>'
            );
        }
        task_log_activity($pdo, null, '', $meId, $meName, 'support_reply', 'Réponse au ticket #' . $ticketId);
        json_out(['ok' => true, 'status' => 'answered']);
    }

    case 'support.close': {
        $ticketId = (int) ($in['ticket_id'] ?? 0);
        if ($ticketId <= 0) {
            fail(422, 'bad_id', 'Ticket invalide.');
        }
        $st = $pdo->prepare('SELECT id FROM tfh_support_tickets WHERE id = ? LIMIT 1');
        $st->execute([$ticketId]);
        if ($st->fetch() === false) {
            fail(404, 'ticket_not_found', 'Ticket introuvable.');
        }
        $pdo->prepare('UPDATE tfh_support_tickets SET status = "closed", updated_at = NOW() WHERE id = ?')
            ->execute([$ticketId]);
        task_log_activity($pdo, null, '', $meId, $meName, 'support_close', 'Ticket #' . $ticketId . ' fermé');
        json_out(['ok' => true, 'status' => 'closed']);
    }

    case 'supchat.reply': {
        $convId  = (string) ($in['conv'] ?? '');
        $content = task_req_str($in, 'content', 2000, true);
        if (!preg_match('/^\d{15,21}$/', $convId)) {
            fail(422, 'bad_conv', 'Conversation invalide.');
        }
        try {
            $pdo->prepare(
                'INSERT INTO tfh_support_chat (conv_id, author_role, author_name, body, read_by_user, read_by_admin)
                 VALUES (?, "admin", ?, ?, 0, 1)'
            )->execute([$convId, $meName, $content]);
        } catch (PDOException $e) {
            if ((int) ($e->errorInfo[1] ?? 0) === 1146) {
                fail(409, 'schema_missing', 'La table chat n\'existe pas encore — elle se crée dès qu\'un joueur ouvre le chat sur le site.');
            }
            throw $e;
        }
        json_out(['ok' => true, 'id' => (int) $pdo->lastInsertId()]);
    }

    default:
        fail(404, 'unknown_action', 'Action inconnue.');
}
