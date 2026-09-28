<?php
declare(strict_types=1);

/**
 * secure/auth-lib.php — Mécanique de la porte d'accès DEV (dev.thefronthub.com).
 *
 * Principe :
 *   - Vérification 100 % serveur (aucun indice côté client).
 *   - Session = cookie signé HMAC-SHA256 (payload base64url JSON : version,
 *     iat, exp, nonce). Forgery impossible sans 'secret' (auth-config.php).
 *   - Anti force brute : compteur d'échecs par IP (fenêtre 15 min, 5 essais),
 *     puis verrouillage croissant 5 → 10 → 20 → 40 → 60 min. Les compteurs
 *     vivent dans sys_get_temp_dir() (HORS webroot → jamais écrasés par le
 *     rsync de deploy.sh, jamais servis en HTTP).
 *   - Dégradation sûre : si l'anti brute-force n'arrive pas à écrire
 *     (permissions…), la connexion légitime reste possible (jamais de
 *     verrouillage faux-positif du propriétaire).
 */

const TFH_GATE_COOKIE = 'tfh_dev_gate';
const TFH_GATE_TTL    = 30 * 86400; // session 30 jours

const TFH_RL_WINDOW    = 900; // fenêtre d'échecs : 15 min
const TFH_RL_MAX_FAILS = 5;   // essais avant verrouillage

/* ------------------------------------------------------------------ */
/* Host                                                               */
/* ------------------------------------------------------------------ */

/** Vrai uniquement sur dev.thefronthub.com (jamais sur la prod). */
function tfh_is_dev_host(): bool
{
    $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
    $host = preg_replace('/:\d+$/', '', $host) ?? '';
    return $host === 'dev.thefronthub.com';
}

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

/** Config (hash + secret) lue une seule fois par requête. Fail-closed. */
function tfh_gate_config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        $cfg = require __DIR__ . '/auth-config.php';
        $ok  = is_array($cfg)
            && isset($cfg['hash'], $cfg['secret'], $cfg['v'])
            && is_string($cfg['hash']) && str_starts_with($cfg['hash'], '$2')
            && is_string($cfg['secret']) && strlen($cfg['secret']) >= 32;
        if (!$ok) {
            error_log('[tfh-gate] secure/auth-config.php invalide — porte verrouillée');
            http_response_code(500);
            header('Content-Type: text/plain; charset=utf-8');
            exit('Configuration indisponible');
        }
    }
    return $cfg;
}

/* ------------------------------------------------------------------ */
/* Token / cookie signé                                               */
/* ------------------------------------------------------------------ */

function tfh_b64url_encode(string $bin): string
{
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function tfh_b64url_decode(string $str): string
{
    $pad = (4 - (strlen($str) % 4)) % 4;
    $dec = base64_decode(strtr($str, '-_', '+/') . str_repeat('=', $pad), true);
    return $dec === false ? '' : $dec;
}

/** Fabrique un cookie de session signé (HMAC-SHA256, 30 jours). */
function tfh_make_token(): string
{
    $cfg     = tfh_gate_config();
    $payload = [
        'v'   => (int) $cfg['v'],
        'iat' => time(),
        'exp' => time() + TFH_GATE_TTL,
        'n'   => bin2hex(random_bytes(12)),
    ];
    $p = tfh_b64url_encode((string) json_encode($payload));
    return $p . '.' . hash_hmac('sha256', $p, (string) $cfg['secret']);
}

/** Vérifie signature + version + expiration (constant-time). */
function tfh_verify_token(?string $token): bool
{
    if (!is_string($token) || substr_count($token, '.') !== 1) {
        return false;
    }
    [$p, $sig] = explode('.', $token, 2);
    if ($p === '' || $sig === '' || strlen($sig) !== 64) {
        return false;
    }
    $cfg = tfh_gate_config();
    if (!hash_equals(hash_hmac('sha256', $p, (string) $cfg['secret']), $sig)) {
        return false;
    }
    $json = json_decode(tfh_b64url_decode($p), true);
    if (!is_array($json)) {
        return false;
    }
    if ((int) ($json['v'] ?? -1) !== (int) $cfg['v']) {
        return false;
    }
    return (int) ($json['exp'] ?? 0) > time();
}

/** Session valide ? */
function tfh_has_access(): bool
{
    return tfh_verify_token($_COOKIE[TFH_GATE_COOKIE] ?? null);
}

/** Pose le cookie d'accès (HttpOnly, Secure si HTTPS, SameSite=Lax). */
function tfh_send_auth_cookie(): void
{
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
    setcookie(TFH_GATE_COOKIE, tfh_make_token(), [
        'expires'  => time() + TFH_GATE_TTL,
        'path'     => '/',
        'secure'   => $https,
        'httponly' => true,
        'samesite' => 'Lax', // Lax : les retours OAuth (navigation top-level) gardent le cookie
    ]);
}

/* ------------------------------------------------------------------ */
/* Anti force brute (stockage HORS webroot)                           */
/* ------------------------------------------------------------------ */

function tfh_rl_dir(): string
{
    $dir = rtrim((string) (sys_get_temp_dir() ?: '/tmp'), '/') . '/tfh-dev-gate';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    return $dir;
}

/** Un fichier par IP (clé hachée avec le secret : non devinable). */
function tfh_rl_file(): string
{
    $cfg = tfh_gate_config();
    $ip  = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    return tfh_rl_dir() . '/rl_' . hash('sha256', $ip . '|' . (string) $cfg['secret']);
}

function tfh_rl_state(): array
{
    $s = ['n' => 0, 'win' => time(), 'lock_until' => 0, 'locks' => 0];
    $f = tfh_rl_file();
    if (is_readable($f)) {
        $d = json_decode((string) file_get_contents($f), true);
        if (is_array($d)) {
            $s = array_merge($s, $d);
        }
    }
    return $s;
}

function tfh_rl_save(array $s): void
{
    @file_put_contents(tfh_rl_file(), (string) json_encode($s), LOCK_EX);
    // GC opportuniste : purge des compteurs de plus de 48 h
    if (random_int(0, 40) === 0) {
        foreach (glob(tfh_rl_dir() . '/rl_*') ?: [] as $f) {
            if (is_file($f) && (time() - (int) filemtime($f)) > 48 * 3600) {
                @unlink($f);
            }
        }
    }
}

/** Secondes de verrouillage restantes (0 = aucun). */
function tfh_rl_locked_for(): int
{
    $s = tfh_rl_state();
    return max(0, (int) $s['lock_until'] - time());
}

/** Enregistre un échec ; déclenche le verrou au 5e (durées croissantes). */
function tfh_rl_register_fail(): void
{
    $s = tfh_rl_state();
    if ((time() - (int) $s['win']) > TFH_RL_WINDOW) {
        $s['n']   = 0;
        $s['win'] = time();
    }
    $s['n'] = (int) $s['n'] + 1;
    if ((int) $s['n'] >= TFH_RL_MAX_FAILS) {
        $s['locks']      = (int) $s['locks'] + 1;
        $minutes         = min(60, 5 * (2 ** max(0, (int) $s['locks'] - 1))); // 5,10,20,40,60
        $s['lock_until'] = time() + $minutes * 60;
        $s['n']          = 0;
        $s['win']        = time();
    }
    tfh_rl_save($s);
}

/** Succès : remise à zéro du compteur. */
function tfh_rl_clear(): void
{
    $f = tfh_rl_file();
    if (is_file($f)) {
        @unlink($f);
    }
}
