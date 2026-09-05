<?php
declare(strict_types=1);

/**
 * POST /api/language.php   { language: "fr" | "en" }
 * GET  /api/language.php   → { ok, language }
 *
 * Préférence de langue du compte (colonne tfh_users.language).
 * Endpoint dédié et volontairement minimal : changer la langue ne doit
 * PAS passer par profile.php (qui gère username/publicId + tables
 * publiques) — on ne touche qu'à la colonne language.
 *
 * Non connecté : POST renvoie 401 (le front garde localStorage), GET
 * renvoie ok:false + language:null (jamais une erreur bloquante).
 */

define('TFH_API', true);
require __DIR__ . '/config.php';

/* ── Lecture ─────────────────────────────────────────────────────────── */
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    $user = current_user($pdo);
    if ($user === null) {
        json_out(['ok' => false, 'language' => null]);
    }
    $lang = $user['language'] ?? null;
    if ($lang !== 'fr' && $lang !== 'en') {
        $lang = null;
    }
    json_out(['ok' => true, 'language' => $lang]);
}

/* ── Écriture ────────────────────────────────────────────────────────── */
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'method_not_allowed', 'POST ou GET uniquement.');
}

rate_limit($pdo, 'language:' . client_ip(), 30, 60);

$user = current_user($pdo);
if ($user === null) {
    fail(401, 'not_authenticated', 'Non connecte.');
}

$in = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($in)) {
    $in = [];
}

$language = isset($in['language']) ? trim((string) $in['language']) : '';
if (!in_array($language, ['fr', 'en'], true)) {
    fail(400, 'invalid_language', 'Langue invalide (fr ou en).');
}

try {
    $st = $pdo->prepare('UPDATE tfh_users SET language = ? WHERE id = ?');
    $st->execute([$language, $user['id']]);
} catch (PDOException $e) {
    error_log('[tfh-api] language: ' . $e->getMessage());
    fail(500, 'db_error', 'Erreur inattendue, reessaie.');
}

json_out(['ok' => true, 'language' => $language]);
