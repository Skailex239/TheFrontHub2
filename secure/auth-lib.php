<?php
declare(strict_types=1);

/**
 * secure/auth-lib.php — Mécanique de la porte d'accès DEV (dev.thefronthub.com).
 *
 * Principe :
 *   - Vérification 100 % serveur (aucun indice côté client).
 *   - Session = cookie signé HMAC-SHA256 (payload base64url JSON : version,
 *     iat, exp, nonce). Forgery impossible sans 'secret'.
 *   - ⚠️ SECRET & HASH JAMAIS DANS LE REPO (v5.16.5 — le repo GitHub est
 *     PUBLIC : toute valeur versionnée est lisible par tout le monde).
 *     La config vit dans <home>/.tfs_secrets/gate-config.json (HORS webroot,
 *     hors repo, survivant aux rsync de déploiement) :
 *       {"v":2,"hash":"$2y$...","secret":"<64 hex>"}
 *     Au premier appel sans config, AMORÇAGE AUTOMATIQUE :
 *       'secret' → NOUVEAU, généré sur le serveur (random_bytes, 0600) ;
 *       'hash'   → seed de migration TFH_GATE_HASH_SEED (déjà public dans
 *                  l'historique git : ne révèle RIEN de nouveau ; sert une
 *                  seule fois, le temps que le serveur écrive sa config).
 *     Pour CHANGER le code d'accès : générer un hash
 *       php -r "echo password_hash('NOUVEAU_CODE', PASSWORD_BCRYPT), PHP_EOL;"
 *     puis éditer <home>/.tfs_secrets/gate-config.json (cPanel) et bump 'v'.
 *   - Anti force brute : compteur d'échecs par IP (fenêtre 15 min, 5 essais),
 *     puis verrouillage croissant 5 → 10 → 20 → 40 → 60 min. Les compteurs
 *     vivent dans sys_get_temp_dir() (HORS webroot → jamais écrasés par le
 *     rsync de déploiement, jamais servis en HTTP).
 *   - Dégradation sûre : si l'anti brute-force n'arrive pas à écrire
 *     (permissions…), la connexion légitime reste possible (jamais de
 *     verrouillage faux-positif du propriétaire).
 */

const TFH_GATE_COOKIE = 'tfh_dev_gate';
const TFH_GATE_TTL    = 30 * 86400; // session 30 jours

/**
 * Seed de migration (UNIQUE AMORÇAGE serveur) : hash bcrypt du code actuel.
 * ⚠️ Déjà présent dans l'historique public du repo (ancien auth-config.php) :
 *    l'embarquer ici n'expose donc RIEN de nouveau. Il ne sert qu'à écrire la
 *    config initiale sur le serveur ; ensuite le serveur n'utilise plus que
 *    <home>/.tfs_secrets/gate-config.json (hors repo). Le secret, lui, n'a
 *    JAMAIS été public dans cette version : il est régénéré à l'amorçage.
 */
const TFH_GATE_HASH_SEED = '$2y$12$56sfEPt9gwune.sY6Sq/BueL7.ClHXij6PkRXAntPsC5BNcE/poAu';

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

/**
 * Répertoires candidats pour la config hors webroot (ordre de préférence) :
 *   1. <home>/.tfs_secrets            — convention _deploy.php / _upload.php
 *   2. <public_html>/.tfs_secrets     — repli si le home n'est pas déductible
 *   3. <parent(home)>/.tfs_secrets    — repli
 *   4. <tmp système>/tfh-gate-secrets — dernier repli (toujours inscriptible)
 * Le __DIR__ ici est <webroot>/secure → 3 niveaux au-dessus = /home/USER.
 */
function tfh_secrets_dir_candidates(): array
{
    $cands = [];
    foreach ([3, 2, 4] as $levels) {
        $dir = __DIR__;
        for ($i = 0; $i < $levels; $i++) {
            $parent = dirname($dir);
            if ($parent === $dir || $parent === '/' || $parent === '') {
                $dir = '';
                break;
            }
            $dir = $parent;
        }
        if ($dir !== '' && $dir !== '/' && $dir !== '.') {
            $cands[] = $dir . '/.tfs_secrets';
        }
    }
    $cands[] = rtrim((string) (sys_get_temp_dir() ?: '/tmp'), '/') . '/tfh-gate-secrets';
    return array_values(array_unique($cands));
}

/** JSON de config valide ? */
function tfh_parse_gate_config(string $raw): ?array
{
    $j = json_decode($raw, true);
    if (is_array($j)
        && isset($j['hash'], $j['secret'], $j['v'])
        && is_string($j['hash']) && str_starts_with($j['hash'], '$2')
        && is_string($j['secret']) && strlen($j['secret']) >= 32) {
        return $j;
    }
    return null;
}

/**
 * Charge <home>/.tfs_secrets/gate-config.json ; l'amorce si absente
 * (nouveau secret généré sur le serveur + hash seed) ; null si impossible.
 */
function tfh_load_or_bootstrap_gate_config(): ?array
{
    $candidates = tfh_secrets_dir_candidates();

    /* 1) Config existante : premier fichier lisible et valide gagne. */
    foreach ($candidates as $dir) {
        $file = $dir . '/gate-config.json';
        if (is_readable($file)) {
            $cfg = tfh_parse_gate_config((string) file_get_contents($file));
            if ($cfg !== null) {
                return $cfg;
            }
        }
    }

    /* 2) Amorçage : premier répertoire inscriptible gagne. */
    foreach ($candidates as $dir) {
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            continue;
        }
        $file = $dir . '/gate-config.json';
        if (is_readable($file)) {
            // Une requête concurrente a déjà amorcé : on réutilise.
            $cfg = tfh_parse_gate_config((string) file_get_contents($file));
            if ($cfg !== null) {
                return $cfg;
            }
        }
        $cfg = [
            'v'      => 2, // v2 : invalide tous les cookies forgés avec l'ancien secret public
            'hash'   => TFH_GATE_HASH_SEED,
            'secret' => bin2hex(random_bytes(32)), // 64 hex, généré ICI, jamais dans le repo
        ];
        $tmp = $file . '.tmp' . getmypid();
        if (@file_put_contents($tmp, (string) json_encode($cfg), LOCK_EX) !== false) {
            @chmod($tmp, 0600);
            if (@rename($tmp, $file)) {
                error_log('[tfh-gate] config serveur amorcée (nouveau secret hors repo) : ' . $file);
                return $cfg;
            }
        }
        @unlink($tmp);
    }
    return null;
}

/** Config (hash + secret) lue une seule fois par requête. Fail-closed. */
function tfh_gate_config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        $cfg = tfh_load_or_bootstrap_gate_config();
        if ($cfg === null) {
            error_log('[tfh-gate] config indisponible (aucun stockage inscriptible) — porte verrouillée');
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
