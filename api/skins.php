<?php
declare(strict_types=1);

/**
 * /api/skins.php — Skins + codes de récompense
 * (remplace les collections Firestore user-skins et reward-codes).
 *
 * GET  ?publicId=XXXX          → { ok, ownedSkins: [...], activeSkinId }  (public)
 * GET  ?activeMap=1            → { ok, count, active: [{publicId, username, skinId}] } (bulk leaderboards)
 * GET  ?codes=1                → liste des codes (admin uniquement)
 * POST { action:'redeem', code, publicId }       → rachat d'un code (session requise)
 * POST { action:'activate', skinId, publicId }   → active un skin possédé (session requise)
 * POST { action:'createCode', code, skinId, maxUses, note, expiresAt } (admin)
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

function normalize_code(string $raw): string
{
    $raw = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $raw) ?? '');
    return substr($raw, 0, 64);
}

function valid_skin_id(string $id): bool
{
    return (bool) preg_match('/^[a-z0-9_-]{1,32}$/', $id);
}

/* ------------------------------------------------------------------ */
/* GET                                                                 */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    rate_limit($pdo, 'skins-get:' . client_ip(), 120, 60);

    /* Liste des codes (admin) */
    if (isset($_GET['codes'])) {
        $user = current_user($pdo);
        if ($user === null || $user['role'] !== 'admin') {
            fail(403, 'forbidden', 'Réservé aux administrateurs.');
        }
        $rows = $pdo->query('SELECT * FROM tfh_reward_codes ORDER BY created_at DESC LIMIT 500')->fetchAll();
        $codes = array_map(static fn(array $r): array => [
            'code'      => $r['code'],
            'skinId'    => $r['skin_id'],
            'maxUses'   => $r['max_uses'] !== null ? (int) $r['max_uses'] : null,
            'uses'      => (int) $r['uses'],
            'note'      => $r['note'],
            'expiresAt' => $r['expires_at'],
            'createdAt' => $r['created_at'],
        ], $rows);
        json_out(['ok' => true, 'codes' => $codes]);
    }

    /* Carte publique des skins ACTIFS — bulk pour les leaderboards.
     * Une seule requête pour toute la page (au lieu d'une requête par
     * ligne de classement). Info publique : équivalent de l'ancien
     * /api/public-rewards.php (seul le skin ACTIF est exposé, jamais
     * la collection complète d'un joueur).
     *
     * Enrichissement openfrontUsername : username ACTUEL côté OpenFront
     * (sans tag de clan ni discriminateur) de chaque joueur cosmétique,
     * résolu côté serveur (l'API OpenFront est CORS-restreinte à
     * openfront.io — impossible depuis le navigateur). C'est lui qui
     * permet au frontend de matcher "[LBU] Skailex" (nom en partie) ou
     * "VarXard.9236" avec le compte du joueur. Cache fichier 5 min :
     * 0 requête OpenFront dans ~toutes les réponses. */
    if (isset($_GET['activeMap'])) {
        $rows = $pdo->query(
            'SELECT s.public_id, s.skin_id, u.username
             FROM tfh_user_skins s
             LEFT JOIN tfh_users u ON u.public_id = s.public_id
             WHERE s.active = 1
             ORDER BY s.redeemed_at DESC
             LIMIT 1000'
        )->fetchAll();
        $active = array_map(static fn(array $r): array => [
            'publicId' => $r['public_id'],
            'username' => $r['username'],
            'skinId'   => $r['skin_id'],
        ], $rows);

        /* Cache fichier des usernames OpenFront (publicId → username). */
        $ofCacheFile = sys_get_temp_dir() . '/tfh_of_usernames.json';
        $ofCache = [];
        if (is_file($ofCacheFile)) {
            $ofCache = json_decode((string) file_get_contents($ofCacheFile), true) ?: [];
        }
        $ofTtl = 300; // 5 min
        $dirty = false;
        foreach ($active as &$a) {
            $pid = $a['publicId'];
            $fresh = isset($ofCache[$pid]['at']) && $ofCache[$pid]['at'] >= time() - $ofTtl;
            if (!$fresh) {
                $uname = null;
                $url = 'https://api.openfront.io/public/player/' . rawurlencode($pid);
                $ctx = stream_context_create(['http' => ['timeout' => 3, 'ignore_errors' => true]]);
                $raw = @file_get_contents($url, false, $ctx);
                if (is_string($raw) && $raw !== '') {
                    $j = json_decode($raw, true);
                    if (is_array($j) && !empty($j['username'])) {
                        $uname = (string) $j['username'];
                    }
                }
                $ofCache[$pid] = ['at' => time(), 'username' => $uname];
                $dirty = true;
            }
            $a['openfrontUsername'] = $ofCache[$pid]['username'] ?? null;
        }
        unset($a);
        if ($dirty) {
            @file_put_contents($ofCacheFile, json_encode($ofCache), LOCK_EX);
        }

        json_out(['ok' => true, 'count' => count($active), 'active' => $active]);
    }

    /* Skins d'un joueur (public — nécessaire pour afficher les pseudos skinnés) */
    $publicId = (string) ($_GET['publicId'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{3,64}$/', $publicId)) {
        fail(400, 'invalid_public_id', 'Identifiant public invalide.');
    }

    $stmt = $pdo->prepare(
        'SELECT skin_id, code_used, active, redeemed_at FROM tfh_user_skins
         WHERE public_id = ? ORDER BY redeemed_at DESC LIMIT 200'
    );
    $stmt->execute([$publicId]);
    $rows = $stmt->fetchAll();

    $owned = [];
    $activeSkinId = null;
    foreach ($rows as $r) {
        $owned[] = [
            'skinId'     => $r['skin_id'],
            'codeUsed'   => $r['code_used'],
            'redeemedAt' => $r['redeemed_at'],
            'active'     => (bool) $r['active'],
        ];
        if ($r['active']) {
            $activeSkinId = $r['skin_id'];
        }
    }

    json_out(['ok' => true, 'ownedSkins' => $owned, 'activeSkinId' => $activeSkinId]);
}

/* ------------------------------------------------------------------ */
/* POST                                                                */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'method_not_allowed', 'GET ou POST uniquement.');
}

rate_limit($pdo, 'skins-post:' . client_ip(), 30, 60);

$user = current_user($pdo);
if ($user === null) {
    fail(401, 'not_authenticated', 'Connecte-toi d\'abord.');
}

$in = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($in)) {
    fail(400, 'bad_request', 'Corps JSON invalide.');
}

$action = (string) ($in['action'] ?? '');

/* ---------- Le publicId fourni doit être celui du compte connecté ---------- */

$ownPublicId = $user['public_id'];

try {
    switch ($action) {

        /* ---------- Rachat de code ---------- */
        case 'redeem': {
            $code = normalize_code((string) ($in['code'] ?? ''));
            $publicId = (string) ($in['publicId'] ?? '');
            if (strlen($code) < 3) {
                fail(400, 'invalid_code', 'Code invalide.');
            }
            if ($ownPublicId === null || $ownPublicId === '' || $publicId !== $ownPublicId) {
                fail(403, 'public_id_mismatch', 'Ce compte n\'est pas lié à cet identifiant public.');
            }

            $pdo->beginTransaction();

            $stmt = $pdo->prepare('SELECT * FROM tfh_reward_codes WHERE code = ? FOR UPDATE');
            $stmt->execute([$code]);
            $codeRow = $stmt->fetch();
            if ($codeRow === false) {
                $pdo->rollBack();
                fail(404, 'code_not_found', 'Code "' . $code . '" introuvable');
            }

            $skinId = (string) $codeRow['skin_id'];
            if (!valid_skin_id($skinId)) {
                $pdo->rollBack();
                fail(400, 'invalid_skin', 'Code invalide (skin inconnu)');
            }

            if ($codeRow['expires_at'] !== null && strtotime((string) $codeRow['expires_at']) < time()) {
                $pdo->rollBack();
                fail(410, 'code_expired', 'Ce code a expiré');
            }

            if ($codeRow['max_uses'] !== null && (int) $codeRow['uses'] >= (int) $codeRow['max_uses']) {
                $pdo->rollBack();
                fail(409, 'code_exhausted', 'Ce code a atteint sa limite d\'utilisations');
            }

            /* Déjà possédé ? */
            $own = $pdo->prepare('SELECT 1 FROM tfh_user_skins WHERE public_id = ? AND skin_id = ?');
            $own->execute([$publicId, $skinId]);
            if ($own->fetch() !== false) {
                $pdo->rollBack();
                json_out(['ok' => true, 'alreadyOwned' => true, 'skinId' => $skinId]);
            }

            $pdo->prepare('UPDATE tfh_reward_codes SET uses = uses + 1 WHERE code = ?')->execute([$code]);
            $pdo->prepare(
                'INSERT INTO tfh_user_skins (public_id, skin_id, code_used, active) VALUES (?, ?, ?, 0)'
            )->execute([$publicId, $skinId, $code]);

            $pdo->commit();

            json_out(['ok' => true, 'alreadyOwned' => false, 'skinId' => $skinId]);
        }

        /* ---------- Activation de skin ---------- */
        case 'activate': {
            $skinId = (string) ($in['skinId'] ?? '');
            $publicId = (string) ($in['publicId'] ?? '');
            if ($ownPublicId === null || $ownPublicId === '' || $publicId !== $ownPublicId) {
                fail(403, 'public_id_mismatch', 'Ce compte n\'est pas lié à cet identifiant public.');
            }
            if ($skinId !== 'default' && !valid_skin_id($skinId)) {
                fail(400, 'invalid_skin', 'skinId invalide');
            }

            $pdo->beginTransaction();

            if ($skinId !== 'default') {
                $own = $pdo->prepare('SELECT 1 FROM tfh_user_skins WHERE public_id = ? AND skin_id = ?');
                $own->execute([$publicId, $skinId]);
                if ($own->fetch() === false) {
                    $pdo->rollBack();
                    fail(403, 'not_owned', 'Tu ne possèdes pas ce skin');
                }
            }

            $pdo->prepare('UPDATE tfh_user_skins SET active = 0 WHERE public_id = ?')->execute([$publicId]);
            if ($skinId !== 'default') {
                $pdo->prepare('UPDATE tfh_user_skins SET active = 1 WHERE public_id = ? AND skin_id = ?')
                    ->execute([$publicId, $skinId]);
            }

            $pdo->commit();

            json_out(['ok' => true, 'activeSkinId' => $skinId]);
        }

        /* ---------- Création de code (admin) ---------- */
        case 'createCode': {
            if ($user['role'] !== 'admin') {
                fail(403, 'forbidden', 'Réservé aux administrateurs.');
            }
            $code = normalize_code((string) ($in['code'] ?? ''));
            $skinId = (string) ($in['skinId'] ?? '');
            $maxUses = isset($in['maxUses']) && $in['maxUses'] !== null ? max(1, (int) $in['maxUses']) : null;
            $note = tfh_cut((string) ($in['note'] ?? ''), 255);
            $expiresAt = null;
            if (!empty($in['expiresAt'])) {
                $ts = strtotime((string) $in['expiresAt']);
                if ($ts !== false) {
                    $expiresAt = gmdate('Y-m-d H:i:s', $ts);
                }
            }
            if (strlen($code) < 3) {
                fail(400, 'invalid_code', 'Code trop court');
            }
            if (!valid_skin_id($skinId)) {
                fail(400, 'invalid_skin', 'skinId invalide');
            }

            $exists = $pdo->prepare('SELECT 1 FROM tfh_reward_codes WHERE code = ?');
            $exists->execute([$code]);
            if ($exists->fetch() !== false) {
                fail(409, 'code_exists', 'Code "' . $code . '" existe déjà');
            }

            $pdo->prepare(
                'INSERT INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)'
            )->execute([$code, $skinId, $maxUses, $note, $user['username'], $expiresAt]);

            json_out(['ok' => true, 'code' => $code, 'skinId' => $skinId]);
        }

        default:
            fail(400, 'invalid_action', 'Action inconnue.');
    }
} catch (PDOException $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    if ((int) $e->getCode() === 23000) {
        fail(409, 'already_owned', 'Tu possèdes déjà ce skin.');
    }
    error_log('[tfh-api] skins: ' . $e->getMessage());
    fail(500, 'db_error', 'Erreur inattendue, réessaie.');
}
