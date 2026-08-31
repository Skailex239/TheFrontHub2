<?php
declare(strict_types=1);

/**
 * /api/favorites.php — Cartes favorites du Lobby (par utilisateur, MySQL).
 *
 * GET                        → { ok, favorites: ["europe", "baikal", ...] }
 *                              (session optionnelle : non connecté → liste vide)
 * POST { map, action }       → add | remove | toggle   (session REQUISE)
 *                              → { ok, favorited: bool }
 *
 * Identifiants de carte : slug minuscule alphanumérique (cf. mapSlug() côté
 * client : "Amazon River" → "amazonriver"). 100 favoris max par compte.
 *
 * Table tfh_fav_maps — auto-créée à la première utilisation (errno 1146) ;
 * le script api/sql-lobby-favorites.sql documente le même schéma pour un
 * passage manuel éventuel en cPanel.
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

const FAV_MAX_PER_USER = 100;

function fav_table_sql(): string
{
    return 'CREATE TABLE IF NOT EXISTS tfh_fav_maps (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id INT UNSIGNED NOT NULL,
        map_slug VARCHAR(64) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_map (user_id, map_slug),
        KEY idx_map_slug (map_slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
}

/**
 * Exécute une requête sur tfh_fav_maps ; si la table n'existe pas encore
 * (premier déploiement), la crée puis retente une fois.
 */
function fav_query(PDO $pdo, string $sql, array $params = []): PDOStatement
{
    try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    } catch (PDOException $e) {
        $driverErrno = (int) ($e->errorInfo[1] ?? 0);
        if ($driverErrno !== 1146) { // 1146 = table inexistante
            throw $e;
        }
        $pdo->exec(fav_table_sql());
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/* ---------- GET : liste des favoris de l'utilisateur connecté ---------- */

if ($method === 'GET') {
    rate_limit($pdo, 'fav-get:' . client_ip(), 120, 60);

    $user = current_user($pdo);
    if ($user === null) {
        // Pas connecté : liste vide (pas d'erreur → évite le bruit console
        // pour les visiteurs non authentifiés, la fonctionnalité est cachée).
        json_out(['ok' => true, 'favorites' => []]);
    }

    $stmt = fav_query(
        $pdo,
        'SELECT map_slug FROM tfh_fav_maps WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200'
    );
    $rows = $stmt->fetchAll();

    json_out([
        'ok'        => true,
        'favorites' => array_values(array_column($rows, 'map_slug')),
    ]);
}

/* ---------- POST : add / remove / toggle (connexion requise) ---------- */

if ($method !== 'POST') {
    fail(405, 'method_not_allowed', 'GET ou POST uniquement.');
}

rate_limit($pdo, 'fav-post:' . client_ip(), 60, 60);

$user = current_user($pdo);
if ($user === null) {
    fail(401, 'not_authenticated', 'Connecte-toi pour enregistrer tes cartes favorites.');
}

$in = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($in)) {
    $in = [];
}

$map   = strtolower(trim((string) ($in['map'] ?? '')));
$action = (string) ($in['action'] ?? 'toggle');

if (!preg_match('/^[a-z0-9]{1,64}$/', $map)) {
    fail(400, 'invalid_map', 'Identifiant de carte invalide.');
}
if (!in_array($action, ['add', 'remove', 'toggle'], true)) {
    fail(400, 'invalid_action', 'Action inconnue.');
}

$userId = (int) $user['id'];

try {
    $exists = fav_query(
        $pdo,
        'SELECT 1 FROM tfh_fav_maps WHERE user_id = ? AND map_slug = ?',
        [$userId, $map]
    );
    $hasFav = $exists->fetch() !== false;

    if ($action === 'toggle') {
        $action = $hasFav ? 'remove' : 'add';
    }

    if ($action === 'add' && !$hasFav) {
        // Garde-fou : 100 favoris max par compte
        $cnt = fav_query($pdo, 'SELECT COUNT(*) AS c FROM tfh_fav_maps WHERE user_id = ?', [$userId]);
        if ((int) $cnt->fetch()['c'] >= FAV_MAX_PER_USER) {
            fail(400, 'too_many_favorites', 'Maximum de ' . FAV_MAX_PER_USER . ' cartes favorites atteint.');
        }
        fav_query(
            $pdo,
            'INSERT IGNORE INTO tfh_fav_maps (user_id, map_slug) VALUES (?, ?)',
            [$userId, $map]
        );
    } elseif ($action === 'remove' && $hasFav) {
        fav_query(
            $pdo,
            'DELETE FROM tfh_fav_maps WHERE user_id = ? AND map_slug = ?',
            [$userId, $map]
        );
    }

    json_out(['ok' => true, 'favorited' => $action === 'add']);
} catch (PDOException $e) {
    error_log('[tfh-api] favorites: ' . $e->getMessage());
    fail(500, 'db_error', 'Erreur inattendue, réessaie.');
}
