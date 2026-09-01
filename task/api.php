<?php
declare(strict_types=1);

/**
 * task/api.php — API JSON du panel (même origine que la page).
 *
 * GET  ?action=state  → état complet (moi, personnes autorisées, tâches, csrf)
 * POST { action: ... } (JSON + en-tête X-CSRF-Token)
 *      task.create / task.status / task.edit / task.delete
 *      admin.add   / admin.remove
 */

define('TFH_API', true);
require __DIR__ . '/lib.php';

task_security_headers();

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
    if ((string) ($_GET['action'] ?? '') !== 'state') {
        fail(404, 'unknown_action', 'Action inconnue.');
    }

    /* Personnes autorisées = whitelist du panel + admins du site */
    $people = [];

    $st = $pdo->prepare(
        "SELECT ta.discord_id, ta.role AS panel_role, u.username, u.global_name, u.avatar_url
         FROM tfh_task_admins ta
         LEFT JOIN tfh_user_identities i ON i.provider = 'discord' AND i.provider_uid = ta.discord_id
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
                created_by, created_by_name,
                UNIX_TIMESTAMP(created_at) AS created_ts,
                completed_by, completed_by_name,
                UNIX_TIMESTAMP(completed_at) AS completed_ts
         FROM tfh_task_tasks
         ORDER BY FIELD(status,'todo','in_progress','done'),
                  FIELD(priority,'high','normal','low'),
                  created_at DESC"
    );
    foreach ($st->fetchAll() as $row) {
        $row['id']           = (int) $row['id'];
        $row['created_ts']   = $row['created_ts'] !== null ? (int) $row['created_ts'] : null;
        $row['completed_ts'] = $row['completed_ts'] !== null ? (int) $row['completed_ts'] : null;
        $tasks[] = $row;
    }

    json_out([
        'ok'     => true,
        'me'     => [
            'id'         => $meId,
            'name'       => $meName,
            'avatar'     => (string) ($user['avatar_url'] ?? ''),
            'site_admin' => $access['site_admin'],
            'panel_role' => $access['panel_role'],
            'can_manage' => $access['can_manage'],
        ],
        'people' => array_values($people),
        'tasks'  => $tasks,
        'csrf'   => task_csrf_token(),
    ]);
}

/* ------------------------------------------------------------------ */
/* POST : actions                                                      */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    fail(405, 'method_not_allowed', 'Méthode non autorisée.');
}

$ctype = (string) ($_SERVER['CONTENT_TYPE'] ?? '');
if (strpos($ctype, 'application/json') === false) {
    fail(415, 'bad_content_type', 'Type de contenu non autorisé.');
}

task_csrf_verify();

$in = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($in)) {
    fail(400, 'bad_json', 'Requête invalide.');
}

$action = (string) ($in['action'] ?? '');

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

switch ($action) {

    case 'task.create': {
        $title      = task_req_str($in, 'title', 180, true);
        $desc       = task_req_str($in, 'description', 4000, false);
        $priority   = (string) ($in['priority'] ?? 'normal');
        $assigneeId = task_req_assignee($pdo, $in);

        if (!in_array($priority, ['low', 'normal', 'high'], true)) {
            $priority = 'normal';
        }

        $pdo->prepare(
            'INSERT INTO tfh_task_tasks
             (title, description, status, priority, assignee_id, created_by, created_by_name, created_at)
             VALUES (?, ?, \'todo\', ?, ?, ?, ?, NOW())'
        )->execute([$title, $desc !== '' ? $desc : null, $priority, $assigneeId, $meId, $meName]);

        json_out(['ok' => true, 'id' => (int) $pdo->lastInsertId()]);
    }

    case 'task.status': {
        $id     = (int) ($in['id'] ?? 0);
        $status = (string) ($in['status'] ?? '');
        if ($id <= 0 || !in_array($status, ['todo', 'in_progress', 'done'], true)) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
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
        json_out(['ok' => true]);
    }

    case 'task.edit': {
        $id         = (int) ($in['id'] ?? 0);
        $title      = task_req_str($in, 'title', 180, true);
        $desc       = task_req_str($in, 'description', 4000, false);
        $priority   = (string) ($in['priority'] ?? 'normal');
        $assigneeId = task_req_assignee($pdo, $in);

        if ($id <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        if (!in_array($priority, ['low', 'normal', 'high'], true)) {
            $priority = 'normal';
        }

        $pdo->prepare(
            'UPDATE tfh_task_tasks
             SET title = ?, description = ?, priority = ?, assignee_id = ?
             WHERE id = ?'
        )->execute([$title, $desc !== '' ? $desc : null, $priority, $assigneeId, $id]);

        json_out(['ok' => true]);
    }

    case 'task.delete': {
        $id = (int) ($in['id'] ?? 0);
        if ($id <= 0) {
            fail(422, 'bad_input', 'Paramètres invalides.');
        }
        $pdo->prepare('DELETE FROM tfh_task_tasks WHERE id = ?')->execute([$id]);
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
        json_out(['ok' => true]);
    }

    default:
        fail(404, 'unknown_action', 'Action inconnue.');
}
