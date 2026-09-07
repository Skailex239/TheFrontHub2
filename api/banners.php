<?php
declare(strict_types=1);

/**
 * /api/banners.php — Bannières pixel art de la plaquette de pseudo.
 *
 * Même philosophie que /api/skins.php (skins de pseudo) mais pour les
 * bannières : les codes vivent dans tfh_reward_codes (skin_id préfixé
 * `banner_` — le rachat est routé par skins.php), la propriété et
 * l'activation vivent dans tfh_user_banners.
 *
 * GET  ?publicId=X   → { ok, ownedBanners: [{bannerId, codeUsed, redeemedAt, active}], activeBannerId }
 * GET  ?activeMap=1  → { ok, count, active: [{publicId, bannerId, username}] }   (bulk public)
 * POST { action:'activate', bannerId:'banner_*'|'none', publicId } → active/retire (session requise)
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

function valid_banner_id(string $id): bool
{
    return (bool) preg_match('/^banner_[a-z0-9_-]{1,32}$/', $id);
}

/* ------------------------------------------------------------------ */
/* GET                                                                 */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    rate_limit($pdo, 'banners-get:' . client_ip(), 120, 60);

    /* Carte publique des bannières ACTIVES (bulk — pour de futurs affichages
     * type classements / lobby). Même contrat que skins.php?activeMap=1. */
    if (isset($_GET['activeMap'])) {
        $rows = $pdo->query(
            'SELECT b.public_id, b.banner_id, u.username
             FROM tfh_user_banners b
             LEFT JOIN tfh_users u ON u.public_id = b.public_id
             WHERE b.active = 1
             ORDER BY b.redeemed_at DESC
             LIMIT 1000'
        )->fetchAll();

        $active = array_map(static fn(array $r): array => [
            'publicId' => $r['public_id'],
            'bannerId' => $r['banner_id'],
            'username' => $r['username'],
        ], $rows);

        json_out(['ok' => true, 'count' => count($active), 'active' => $active]);
    }

    /* Bannières d'un joueur (public — nécessaire pour afficher la plaquette
     * d'un profil visité, comme skins.php?publicId). */
    $publicId = (string) ($_GET['publicId'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{3,64}$/', $publicId)) {
        fail(400, 'invalid_public_id', 'Identifiant public invalide.');
    }

    $stmt = $pdo->prepare(
        'SELECT banner_id, code_used, active, redeemed_at FROM tfh_user_banners
         WHERE public_id = ? ORDER BY redeemed_at DESC LIMIT 100'
    );
    $stmt->execute([$publicId]);
    $rows = $stmt->fetchAll();

    $owned = [];
    $activeBannerId = null;
    foreach ($rows as $r) {
        $owned[] = [
            'bannerId'   => $r['banner_id'],
            'codeUsed'   => $r['code_used'],
            'redeemedAt' => $r['redeemed_at'],
            'active'     => (bool) $r['active'],
        ];
        if ($r['active']) {
            $activeBannerId = $r['banner_id'];
        }
    }

    json_out(['ok' => true, 'ownedBanners' => $owned, 'activeBannerId' => $activeBannerId]);
}

/* ------------------------------------------------------------------ */
/* POST                                                                */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'method_not_allowed', 'GET ou POST uniquement.');
}

rate_limit($pdo, 'banners-post:' . client_ip(), 30, 60);

$user = current_user($pdo);
if ($user === null) {
    fail(401, 'not_authenticated', 'Connecte-toi d\'abord.');
}

$in = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($in)) {
    fail(400, 'bad_request', 'Corps JSON invalide.');
}

$action = (string) ($in['action'] ?? '');

try {
    if ($action === 'activate') {
        $bannerId = (string) ($in['bannerId'] ?? '');
        $publicId = (string) ($in['publicId'] ?? '');

        /* Le publicId fourni doit être celui du compte connecté. */
        if ($user['public_id'] === null || $user['public_id'] === '' || $publicId !== $user['public_id']) {
            fail(403, 'public_id_mismatch', 'Ce compte n\'est pas lié à cet identifiant public.');
        }
        if ($bannerId !== 'none' && !valid_banner_id($bannerId)) {
            fail(400, 'invalid_banner', 'Identifiant de bannière invalide.');
        }

        $pdo->beginTransaction();

        if ($bannerId !== 'none') {
            $own = $pdo->prepare('SELECT 1 FROM tfh_user_banners WHERE public_id = ? AND banner_id = ?');
            $own->execute([$publicId, $bannerId]);
            if ($own->fetch() === false) {
                $pdo->rollBack();
                fail(403, 'not_owned', 'Tu ne possèdes pas cette bannière.');
            }
        }

        /* Un seul slot actif par joueur. */
        $pdo->prepare('UPDATE tfh_user_banners SET active = 0 WHERE public_id = ?')->execute([$publicId]);
        if ($bannerId !== 'none') {
            $pdo->prepare('UPDATE tfh_user_banners SET active = 1 WHERE public_id = ? AND banner_id = ?')
                ->execute([$publicId, $bannerId]);
        }

        $pdo->commit();
        json_out(['ok' => true, 'activeBannerId' => $bannerId === 'none' ? null : $bannerId]);
    }

    fail(400, 'invalid_action', 'Action inconnue.');
} catch (PDOException $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    if ((int) $e->getCode() === 23000) {
        fail(409, 'already_owned', 'Tu possèdes déjà cette bannière.');
    }
    error_log('[tfh-api] banners: ' . $e->getMessage());
    fail(500, 'db_error', 'Erreur inattendue, réessaie.');
}
