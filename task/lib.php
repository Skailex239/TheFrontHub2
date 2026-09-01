<?php
declare(strict_types=1);

/**
 * TheFrontHub — Panel de tâches (task.thefronthub.com)
 *
 * Charge la configuration API commune (secrets hors webroot, PDO MySQL,
 * helpers sessions/Discord depuis api/), puis définit les utilitaires
 * propres au panel : schéma, droits d'accès, CSRF, rendu des écrans.
 *
 * Inclus par tous les points d'entrée du panel (task/*.php).
 */

if (!defined('TFH_API')) {
    define('TFH_API', true);
}

require_once __DIR__ . '/../api/config.php';

/* ------------------------------------------------------------------ */
/* Constantes du panel                                                 */
/* ------------------------------------------------------------------ */

define('TASK_CSRF_COOKIE', 'tfh_task_csrf');
define('TASK_ASSET_VER', '3');

/* ------------------------------------------------------------------ */
/* Divers                                                              */
/* ------------------------------------------------------------------ */

function task_e(?string $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

/**
 * Nom affiché : global_name s'il existe, sinon username.
 */
function task_display_name(?string $username, ?string $globalName, string $fallback = ''): string
{
    $g = trim((string) $globalName);
    if ($g !== '') {
        return $g;
    }
    $u = trim((string) $username);
    if ($u !== '') {
        return $u;
    }
    return $fallback;
}

/**
 * URI de retour Discord du panel : task.thefronthub.com en priorité,
 * ou https://thefronthub.com/task/auth/callback.php en secours.
 * Les deux doivent être enregistrées dans le portail Discord (OAuth2).
 */
function task_redirect_uri(): string
{
    $host = (string) ($_SERVER['HTTP_HOST'] ?? 'task.thefronthub.com');
    $host = preg_replace('/[^a-z0-9.\-]/i', '', $host);
    if ($host === '' ) {
        $host = 'task.thefronthub.com';
    }
    $dir = str_replace('\\', '/', (string) dirname($_SERVER['SCRIPT_NAME'] ?? '/auth/login.php'));
    return 'https://' . $host . rtrim($dir, '/') . '/callback.php';
}

/**
 * Préfixe de chemin du panel : '' sur le sous-domaine,
 * '/task' quand il est servi via thefronthub.com/task/.
 */
function task_base_path(): string
{
    $dir = str_replace('\\', '/', (string) dirname($_SERVER['SCRIPT_NAME'] ?? '/'));
    if (substr($dir, -5) === '/auth') {
        $dir = (string) dirname($dir);
    }
    $dir = rtrim($dir, '/');
    return ($dir === '/' || $dir === '') ? '' : $dir;
}

function task_redirect(string $target = 'index.php'): never
{
    header('Location: ' . task_base_path() . '/' . $target, true, 302);
    exit;
}

function task_fatal(string $title, string $detail): never
{
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: text/html; charset=utf-8');
    }
    echo '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<meta name="robots" content="noindex, nofollow">'
        . '<title>Erreur — TheFrontHub</title>'
        . '<style>body{font-family:system-ui,sans-serif;background:#0F0F11;color:#F4F4F5;'
        . 'display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}'
        . '.card{max-width:600px;background:#1A1A1E;border:1px solid #2A2A2E;border-radius:14px;padding:28px}'
        . 'h1{font-size:20px;margin:0 0 10px}.d{color:#9CA3AF;font-size:14px;line-height:1.6;'
        . 'word-break:break-word;margin:0 0 10px}</style></head><body><div class="card">'
        . '<h1>' . task_e($title) . '</h1><p class="d">' . task_e($detail) . '</p>'
        . '<p class="d" style="opacity:.6;margin:0">TheFrontHub — panel de tâches</p>'
        . '</div></body></html>';
    exit;
}

function task_security_headers(): void
{
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    header('X-Robots-Tag: noindex, nofollow');
    header('Cache-Control: no-store, max-age=0');
}

/* ------------------------------------------------------------------ */
/* Schéma MySQL (tables dédiées au panel, préfixe tfh_task_)           */
/* ------------------------------------------------------------------ */

function task_ensure_schema(PDO $pdo): void
{
    static $checked = false;
    if ($checked) {
        return;
    }
    $checked = true;

    try {
        $pdo->query('SELECT 1 FROM tfh_task_admins LIMIT 1');
        $pdo->query('SELECT 1 FROM tfh_task_tasks LIMIT 1');
        return;
    } catch (Throwable $e) {
        /* Tables absentes : tentative de création automatique ci-dessous. */
    }

    try {
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS tfh_task_admins (
                discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
                role       VARCHAR(16) NOT NULL DEFAULT \'admin\',
                added_by   VARCHAR(32) NOT NULL DEFAULT \'\',
                added_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS tfh_task_tasks (
                id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
                title            VARCHAR(180) NOT NULL,
                description      TEXT NULL,
                status           VARCHAR(16) NOT NULL DEFAULT \'todo\',
                priority         VARCHAR(16) NOT NULL DEFAULT \'normal\',
                assignee_id      VARCHAR(32) NULL,
                created_by       VARCHAR(32) NOT NULL,
                created_by_name  VARCHAR(64) NOT NULL DEFAULT \'\',
                created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_by     VARCHAR(32) NULL,
                completed_by_name VARCHAR(64) NULL,
                completed_at     DATETIME NULL,
                PRIMARY KEY (id),
                INDEX idx_task_status (status),
                INDEX idx_task_assignee (assignee_id)
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
    } catch (Throwable $e) {
        error_log('[tfh-task] schema: ' . $e->getMessage());
        task_fatal(
            'Initialisation impossible',
            'Les tables MySQL du panel n\'ont pas pu être créées. '
            . 'Exécute le fichier task/install.sql dans phpMyAdmin (o2switch), puis recharge cette page. '
            . 'Détail technique : ' . $e->getMessage()
        );
    }
}

/* ------------------------------------------------------------------ */
/* Droits d'accès                                                      */
/*                                                                     */
/* - Accès au panel  : rôle "admin" du site (tfh_users.role)           */
/*                     OU ligne dans la whitelist tfh_task_admins.     */
/* - Gestion liste   : propriétaire (bootstrap premier login)          */
/*                     OU admin du site.                               */
/* ------------------------------------------------------------------ */

function task_discord_id_of(PDO $pdo, int $userId): ?string
{
    $st = $pdo->prepare("SELECT provider_uid FROM tfh_user_identities WHERE user_id = ? AND provider = 'discord' LIMIT 1");
    $st->execute([$userId]);
    $row = $st->fetch();
    return $row !== false ? (string) $row['provider_uid'] : null;
}

function task_whitelist_role(PDO $pdo, string $discordId): ?string
{
    $st = $pdo->prepare('SELECT role FROM tfh_task_admins WHERE discord_id = ? LIMIT 1');
    $st->execute([$discordId]);
    $row = $st->fetch();
    return $row !== false ? (string) $row['role'] : null;
}

function task_access(PDO $pdo, array $user): array
{
    $discordId = task_discord_id_of($pdo, (int) $user['id']);
    $siteAdmin = (string) ($user['role'] ?? '') === 'admin';
    $panelRole = $discordId !== null ? task_whitelist_role($pdo, $discordId) : null;
    return [
        'discord_id' => $discordId,
        'site_admin' => $siteAdmin,
        'panel_role' => $panelRole,
        'granted'    => $siteAdmin || $panelRole !== null,
        'can_manage' => $siteAdmin || $panelRole === 'owner',
    ];
}

/**
 * Le compte Discord donné (whitelist OU admin du site) est-il une
 * personne assignable ?
 */
function task_is_person(PDO $pdo, string $discordId): bool
{
    $st = $pdo->prepare('SELECT 1 FROM tfh_task_admins WHERE discord_id = ? LIMIT 1');
    $st->execute([$discordId]);
    if ($st->fetch() !== false) {
        return true;
    }
    $st = $pdo->prepare(
        "SELECT 1 FROM tfh_user_identities i
         JOIN tfh_users u ON u.id = i.user_id
         WHERE i.provider = 'discord' AND i.provider_uid = ? AND u.role = 'admin' LIMIT 1"
    );
    $st->execute([$discordId]);
    return $st->fetch() !== false;
}

function task_is_site_admin_discord(PDO $pdo, string $discordId): bool
{
    $st = $pdo->prepare(
        "SELECT 1 FROM tfh_user_identities i
         JOIN tfh_users u ON u.id = i.user_id
         WHERE i.provider = 'discord' AND i.provider_uid = ? AND u.role = 'admin' LIMIT 1"
    );
    $st->execute([$discordId]);
    return $st->fetch() !== false;
}

/* ------------------------------------------------------------------ */
/* CSRF (double-submit cookie : cookie lisible + en-tête X-CSRF-Token) */
/* ------------------------------------------------------------------ */

function task_csrf_token(): string
{
    $token = (string) ($_COOKIE[TASK_CSRF_COOKIE] ?? '');
    if (!preg_match('/^[a-f0-9]{32}$/', $token)) {
        $token = bin2hex(random_bytes(16));
        if (!headers_sent()) {
            setcookie(TASK_CSRF_COOKIE, $token, [
                'expires'  => time() + 30 * 86400,
                'path'     => '/',
                'secure'   => true,
                'httponly' => false, /* lu par le JS du panel (double submit) */
                'samesite' => 'Lax',
            ]);
        }
    }
    return $token;
}

function task_csrf_verify(): void
{
    $cookie = (string) ($_COOKIE[TASK_CSRF_COOKIE] ?? '');
    $header = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    if ($cookie === '' || $header === '' || !hash_equals($cookie, $header)) {
        fail(403, 'csrf', 'Session sécurisée expirée — recharge la page.');
    }
    $site = (string) ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? 'same-origin');
    if (!in_array($site, ['same-origin', 'none'], true)) {
        fail(403, 'csrf', 'Origine de requête non autorisée.');
    }
}

/* ------------------------------------------------------------------ */
/* Rendu : tête de page commune                                        */
/* ------------------------------------------------------------------ */

function task_page_head(string $title): void
{
    $base = task_base_path();
    ?><!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title><?= task_e($title) ?></title>
<link rel="icon" type="image/png" href="https://thefronthub.com/favicon-32x32.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="<?= task_e($base) ?>/assets/style.css?v=<?= TASK_ASSET_VER ?>">
<script>
(function () {
  try {
    var t = localStorage.getItem('tfh-task-theme');
    if (t !== 'dark' && t !== 'light') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
</script>
</head>
<?php
}

/* ------------------------------------------------------------------ */
/* Rendu : écran de connexion                                          */
/* ------------------------------------------------------------------ */

const TASK_DISCORD_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>';

function task_render_login(array $opts = []): never
{
    $base  = task_base_path();
    $error = trim((string) ($opts['error'] ?? ''));
    task_page_head('Connexion — TheFrontHub');
    ?>
<body class="auth-body">
<main class="auth-wrap">
  <section class="auth-card">
    <img class="auth-logo" src="<?= task_e($base) ?>/assets/logo.png?v=<?= TASK_ASSET_VER ?>" alt="TheFrontHub">
    <h1 class="auth-title">TheFrontHub</h1>
    <p class="auth-sub">Espace administrateur — gestion des tâches</p>
    <?php if ($error !== '') { ?>
    <div class="alert alert-error" role="alert"><?= task_e($error) ?></div>
    <?php } ?>
    <a class="btn-discord" href="<?= task_e($base) ?>/auth/login.php">
      <?= TASK_DISCORD_SVG ?>
      <span>Se connecter avec Discord</span>
    </a>
    <p class="auth-note">Connexion réservée aux comptes autorisés.</p>
  </section>
</main>
<script src="<?= task_e($base) ?>/assets/app.js?v=<?= TASK_ASSET_VER ?>"></script>
</body>
</html>
<?php
    exit;
}

/* ------------------------------------------------------------------ */
/* Rendu : écran d'accès refusé                                        */
/* ------------------------------------------------------------------ */

function task_render_denied(array $profile): never
{
    $base = task_base_path();
    $name = trim((string) ($profile['name'] ?? ''));
    task_page_head('Accès refusé — TheFrontHub');
    ?>
<body class="auth-body">
<main class="auth-wrap">
  <section class="auth-card auth-card-denied">
    <?php if ((string) ($profile['avatar'] ?? '') !== '') { ?>
    <img class="auth-avatar" src="<?= task_e((string) $profile['avatar']) ?>" alt="" onerror="this.style.display='none'">
    <?php } ?>
    <h1 class="auth-title">Accès refusé</h1>
    <p class="auth-sub"><?= $name !== '' ? task_e($name) . ', ton compte Discord' : 'Ton compte Discord' ?> n'est pas autorisé à ouvrir ce panel.</p>
    <div class="denied-id">
      <span class="denied-id-label">Ton ID Discord</span>
      <div class="copy-row">
        <code id="discord-id"><?= task_e((string) ($profile['id'] ?? '')) ?></code>
        <button type="button" class="btn ghost small" data-copy="discord-id">Copier</button>
      </div>
    </div>
    <p class="auth-note">Un gestionnaire du panel peut ajouter cet ID dans «&nbsp;Administrateurs&nbsp;». Une fois fait, clique sur «&nbsp;Réessayer&nbsp;».</p>
    <div class="auth-actions">
      <a class="btn primary" href="index.php">Réessayer</a>
      <a class="btn ghost" href="<?= task_e($base) ?>/logout.php">Se déconnecter</a>
    </div>
  </section>
</main>
<script src="<?= task_e($base) ?>/assets/app.js?v=<?= TASK_ASSET_VER ?>"></script>
</body>
</html>
<?php
    exit;
}
