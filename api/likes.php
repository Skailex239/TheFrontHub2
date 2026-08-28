<?php
declare(strict_types=1);

/**
 * /api/likes.php — Cœurs "GG" sur les runs (remplace Firestore likes/{runId}).
 *
 * GET  (aucun paramètre)  → { ok, likes: { runId: { count, users: { uid: true } } } }
 * GET  ?run=XXX            → { ok, count, liked }
 * POST { runId, action }   → like / unlike (session requise)
 *   action: 'like' | 'unlike' | 'toggle'
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/* ---------- GET ---------- */

if ($method === 'GET') {
    rate_limit($pdo, 'likes-get:' . client_ip(), 120, 60);

    $run = isset($_GET['run']) ? (string) $_GET['run'] : '';

    if ($run !== '') {
        if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $run)) {
            fail(400, 'invalid_run_id', 'Identifiant de run invalide.');
        }
        $stmt = $pdo->prepare('SELECT COUNT(*) AS c FROM tfh_likes WHERE run_id = ?');
        $stmt->execute([$run]);
        $count = (int) $stmt->fetch()['c'];

        $liked = false;
        $user = current_user($pdo);
        if ($user !== null) {
            $chk = $pdo->prepare('SELECT 1 FROM tfh_likes WHERE run_id = ? AND user_id = ?');
            $chk->execute([$run, $user['id']]);
            $liked = $chk->fetch() !== false;
        }
        json_out(['ok' => true, 'count' => $count, 'liked' => $liked]);
    }

    /* Toutes les likes récentes (pour le listener global du frontend).
       Une ligne par (run, joueur) ; on agrège en PHP. Les 20000 lignes les
       plus récentes suffisent largement pour un site communautaire. */
    $rows = $pdo->query(
        'SELECT run_id, user_id FROM tfh_likes ORDER BY created_at DESC LIMIT 20000'
    )->fetchAll();

    $likes = [];
    foreach ($rows as $r) {
        $rid = $r['run_id'];
        if (!isset($likes[$rid])) {
            $likes[$rid] = ['count' => 0, 'users' => []];
        }
        $likes[$rid]['count']++;
        $likes[$rid]['users'][(string) $r['user_id']] = true;
    }

    json_out(['ok' => true, 'likes' => $likes]);
}

/* ---------- POST ---------- */

if ($method !== 'POST') {
    fail(405, 'method_not_allowed', 'GET ou POST uniquement.');
}

rate_limit($pdo, 'likes-post:' . client_ip(), 60, 60);

$user = current_user($pdo);
if ($user === null) {
    fail(401, 'not_authenticated', 'Connecte-toi pour réagir.');
}

$in = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($in)) {
    $in = [];
}

$runId = (string) ($in['runId'] ?? $in['run'] ?? '');
$action = (string) ($in['action'] ?? 'toggle');

if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $runId)) {
    fail(400, 'invalid_run_id', 'Identifiant de run invalide.');
}
if (!in_array($action, ['like', 'unlike', 'toggle'], true)) {
    fail(400, 'invalid_action', 'Action inconnue.');
}

try {
    $exists = $pdo->prepare('SELECT 1 FROM tfh_likes WHERE run_id = ? AND user_id = ?');
    $exists->execute([$runId, $user['id']]);
    $hasLiked = $exists->fetch() !== false;

    if ($action === 'toggle') {
        $action = $hasLiked ? 'unlike' : 'like';
    }

    if ($action === 'like' && !$hasLiked) {
        $pdo->prepare('INSERT IGNORE INTO tfh_likes (run_id, user_id) VALUES (?, ?)')
            ->execute([$runId, $user['id']]);
    } elseif ($action === 'unlike' && $hasLiked) {
        $pdo->prepare('DELETE FROM tfh_likes WHERE run_id = ? AND user_id = ?')
            ->execute([$runId, $user['id']]);
    }

    $stmt = $pdo->prepare('SELECT COUNT(*) AS c FROM tfh_likes WHERE run_id = ?');
    $stmt->execute([$runId]);
    $count = (int) $stmt->fetch()['c'];

    json_out(['ok' => true, 'count' => $count, 'liked' => $action === 'like']);
} catch (PDOException $e) {
    error_log('[tfh-api] likes: ' . $e->getMessage());
    fail(500, 'db_error', 'Erreur inattendue, réessaie.');
}
