<?php
declare(strict_types=1);

/**
 * TheFrontHub API - fonctions communes
 *
 * Reponses JSON, limitation de debit (rate-limit), sessions par cookie
 * HttpOnly + table tfh_sessions, utilitaires Discord (avatar, snowflake,
 * appels HTTP sortants).
 *
 * Inclus par config.php. Ne doit jamais etre appele directement.
 */

if (!defined('TFH_API')) {
    http_response_code(403);
    exit('Forbidden');
}

/* ------------------------------------------------------------------ */
/* Divers                                                              */
/* ------------------------------------------------------------------ */

function tfh_cut(?string $value, int $maxLen): ?string
{
    $value = trim((string) $value);
    if ($value === '') {
        return null;
    }
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $maxLen, 'UTF-8');
    }
    return substr($value, 0, $maxLen);
}

function client_ip(): string
{
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 45);
}

function json_out(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    /* JSON_INVALID_UTF8_SUBSTITUTE : au lieu de renvoyer une réponse VIDE
       (json_encode = false) si une donnée contient un encodage invalide,
       on substitue le caractère problematique — la réponse reste du JSON valide. */
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function fail(int $status, string $code, string $message = ''): never
{
    $payload = ['ok' => false, 'error' => $code];
    if ($message !== '') {
        $payload['message'] = $message;
    }
    json_out($payload, $status);
}

/* ------------------------------------------------------------------ */
/* Rate-limit (table tfh_rate_limits, fenetre fixe par bucket)         */
/* ------------------------------------------------------------------ */

function rate_limit(PDO $pdo, string $bucket, int $max, int $windowSecs): void
{
    $now = time();

    $stmt = $pdo->prepare('SELECT hits, UNIX_TIMESTAMP(window_start) AS ws FROM tfh_rate_limits WHERE bucket = ?');
    $stmt->execute([$bucket]);
    $row = $stmt->fetch();

    if ($row === false) {
        try {
            $pdo->prepare('INSERT INTO tfh_rate_limits (bucket, hits, window_start) VALUES (?, 1, FROM_UNIXTIME(?))')
                ->execute([$bucket, $now]);
        } catch (PDOException $e) {
            /* insertion concurrente sur le meme bucket : on continue sans bloquer */
        }
        return;
    }

    /* Fenetre expiree ? On repart a 1 */
    if ($now - (int) $row['ws'] >= $windowSecs) {
        $pdo->prepare('UPDATE tfh_rate_limits SET hits = 1, window_start = FROM_UNIXTIME(?) WHERE bucket = ?')
            ->execute([$now, $bucket]);
        return;
    }

    if ((int) $row['hits'] >= $max) {
        fail(429, 'rate_limited', 'Trop de requetes, reessaie dans quelques minutes.');
    }

    $pdo->prepare('UPDATE tfh_rate_limits SET hits = hits + 1 WHERE bucket = ?')
        ->execute([$bucket]);
}

/* ------------------------------------------------------------------ */
/* Sessions (cookie HttpOnly + ligne en base, jeton hashe SHA-256)     */
/* ------------------------------------------------------------------ */

function session_from_cookie(PDO $pdo): ?array
{
    $raw = (string) ($_COOKIE[TFH_SESSION_COOKIE] ?? '');
    if (!preg_match('/^[a-f0-9]{64}$/', $raw)) {
        return null;
    }
    $stmt = $pdo->prepare('SELECT * FROM tfh_sessions WHERE id = ? AND expires_at > NOW()');
    $stmt->execute([hash('sha256', $raw)]);
    $session = $stmt->fetch();
    return $session !== false ? $session : null;
}

function current_user(PDO $pdo): ?array
{
    $session = session_from_cookie($pdo);
    if ($session === null) {
        return null;
    }

    /* Session glissante : +30 jours a chaque visite */
    $pdo->prepare('UPDATE tfh_sessions SET last_seen = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?')
        ->execute([TFH_SESSION_TTL, $session['id']]);

    $stmt = $pdo->prepare('SELECT * FROM tfh_users WHERE id = ?');
    $stmt->execute([$session['user_id']]);
    $user = $stmt->fetch();
    return $user !== false ? $user : null;
}

function create_session(PDO $pdo, int $userId): string
{
    $rawToken = bin2hex(random_bytes(32)); // valeur mise dans le cookie
    $hash     = hash('sha256', $rawToken); // seule empreinte stockee en base

    $pdo->prepare(
        'INSERT INTO tfh_sessions (id, user_id, created_at, last_seen, expires_at, ip, user_agent)
         VALUES (?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND), ?, ?)'
    )->execute([
        $hash,
        $userId,
        TFH_SESSION_TTL,
        client_ip(),
        substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
    ]);

    if (!headers_sent()) {
        setcookie(TFH_SESSION_COOKIE, $rawToken, [
            'expires'  => time() + TFH_SESSION_TTL,
            'path'     => '/',
            'secure'   => true,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    return $rawToken;
}

function destroy_session(PDO $pdo): void
{
    $raw = (string) ($_COOKIE[TFH_SESSION_COOKIE] ?? '');
    if (preg_match('/^[a-f0-9]{64}$/', $raw)) {
        $pdo->prepare('DELETE FROM tfh_sessions WHERE id = ?')->execute([hash('sha256', $raw)]);
    }
    if (!headers_sent()) {
        setcookie(TFH_SESSION_COOKIE, '', [
            'expires'  => time() - 3600,
            'path'     => '/',
            'secure'   => true,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }
}

/* ------------------------------------------------------------------ */
/* Discord                                                             */
/* ------------------------------------------------------------------ */

/**
 * Appel HTTP sortant vers l'API Discord (cURL, timeouts courts).
 * Retourne [code HTTP, corps reponse].
 */
function discord_http(string $url, ?array $post = null, array $headers = []): array
{
    $ch = curl_init($url);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_USERAGENT      => 'TheFrontHub-Auth/1.0 (+https://thefronthub.com)',
        CURLOPT_HTTPHEADER     => $headers,
    ];
    if ($post !== null) {
        $opts[CURLOPT_POST]       = true;
        $opts[CURLOPT_POSTFIELDS] = http_build_query($post);
    }
    curl_setopt_array($ch, $opts);

    $body   = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err    = curl_error($ch);
    curl_close($ch);

    if ($body === false) {
        error_log('[tfh-api] curl error: ' . $err . ' (' . $url . ')');
        $body = '';
    }

    return [$status, (string) $body];
}

/** URL de l'avatar Discord (ou avatar par defaut calcule depuis l'ID). */
function discord_avatar_url(string $discordId, ?string $avatar): string
{
    if ($avatar !== null && $avatar !== '') {
        $ext = str_starts_with($avatar, 'a_') ? 'gif' : 'png';
        return 'https://cdn.discordapp.com/avatars/' . $discordId . '/' . $avatar . '.' . $ext . '?size=128';
    }
    $index = ((int) $discordId >> 22) % 6;
    return 'https://cdn.discordapp.com/embed/avatars/' . $index . '.png';
}

/** Date de creation du compte Discord, deduite du snowflake (ID). */
function discord_created_at(string $discordId): string
{
    $ms = ((int) $discordId >> 22) + 1420070400000; // epoch Discord : 2015-01-01
    return gmdate('Y-m-d H:i:s', intdiv($ms, 1000));
}
