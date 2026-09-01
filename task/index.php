<?php
declare(strict_types=1);

/**
 * task/index.php — page unique du panel.
 *
 * Sans session             → écran de connexion Discord.
 * Session sans accès      → écran d'accès refusé.
 * Session autorisée        → application (tableau des tâches).
 */

define('TFH_API', true);
require __DIR__ . '/lib.php';

task_security_headers();
task_ensure_schema($pdo);

$user = current_user($pdo);

if ($user === null) {
    task_render_login([
        'error' => isset($_GET['login']) ? 'La connexion a échoué — réessaie.' : '',
    ]);
    exit;
}

$access = task_access($pdo, $user);
if (!$access['granted'] || $access['discord_id'] === null) {
    task_render_denied([
        'id'     => (string) ($access['discord_id'] ?? ''),
        'name'   => task_display_name(
            isset($user['username']) ? (string) $user['username'] : null,
            isset($user['global_name']) ? (string) $user['global_name'] : null,
            ''
        ),
        'avatar' => (string) ($user['avatar_url'] ?? ''),
    ]);
    exit;
}

$meName = task_display_name(
    isset($user['username']) ? (string) $user['username'] : null,
    isset($user['global_name']) ? (string) $user['global_name'] : null,
    'Discord ' . substr((string) $access['discord_id'], -4)
);

$base = task_base_path();
$boot = [
    'base' => $base,
    'csrf' => task_csrf_token(),
    'me'   => [
        'id'         => (string) $access['discord_id'],
        'name'       => $meName,
        'avatar'     => (string) ($user['avatar_url'] ?? ''),
        'can_manage' => $access['can_manage'],
    ],
];

task_page_head('Tâches — TheFrontHub');
?>
<body class="app-body">
<header class="topbar">
  <div class="brand">
    <img class="brand-logo" src="<?= task_e($base) ?>/assets/logo.png?v=<?= TASK_ASSET_VER ?>" alt="Logo TheFrontHub">
    <span class="brand-name">TheFrontHub</span>
    <span class="brand-chip">Espace admin</span>
  </div>
  <div class="topbar-right">
    <button type="button" id="btn-theme" class="icon-btn" title="Basculer le thème clair/sombre" aria-label="Basculer le thème clair/sombre">
      <svg class="ico-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
      <svg class="ico-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>
    <div class="me">
      <img id="me-avatar" src="<?= task_e($boot['me']['avatar']) ?>" alt="" onerror="this.style.visibility='hidden'">
      <span id="me-name"><?= task_e($boot['me']['name']) ?></span>
    </div>
    <a class="btn ghost small" href="<?= task_e($base) ?>/logout.php">Déconnexion</a>
  </div>
</header>

<main class="wrap">
  <div class="toolbar">
    <div class="counts" id="counts" aria-live="polite"></div>
    <div class="toolbar-actions">
      <button type="button" id="btn-admins" class="btn ghost" hidden>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        <span>Administrateurs</span>
      </button>
      <button type="button" id="btn-new" class="btn primary">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        <span>Nouvelle tâche</span>
      </button>
    </div>
  </div>

  <div class="board" id="board" aria-busy="true">
    <div class="board-loading">Chargement du tableau…</div>
  </div>
</main>

<div class="toasts" id="toasts" aria-live="polite"></div>

<dialog id="dlg-task" class="dlg" aria-labelledby="dlg-task-title">
  <form id="form-task" method="dialog" novalidate>
    <div class="dlg-body">
      <h2 id="dlg-task-title">Nouvelle tâche</h2>
      <label class="field">
        <span class="field-label">Titre <em>*</em></span>
        <input type="text" id="f-title" name="title" maxlength="180" required autocomplete="off" placeholder="Ex. Préparer la page tournoi de samedi">
      </label>
      <label class="field">
        <span class="field-label">Description</span>
        <textarea id="f-desc" name="description" maxlength="4000" rows="4" placeholder="Détails, liens, contexte… (facultatif)"></textarea>
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Priorité</span>
          <select id="f-priority" name="priority">
            <option value="low">Basse</option>
            <option value="normal" selected>Normale</option>
            <option value="high">Haute</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">Assigner à</span>
          <select id="f-assignee" name="assignee_id">
            <option value="">Personne</option>
          </select>
        </label>
      </div>
      <p class="form-error" id="form-task-error" role="alert" hidden></p>
    </div>
    <div class="dlg-actions">
      <button type="button" class="btn ghost" id="dlg-task-cancel">Annuler</button>
      <button type="submit" class="btn primary" id="dlg-task-save">Créer</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-admins" class="dlg" aria-labelledby="dlg-admins-title">
  <div class="dlg-body">
    <h2 id="dlg-admins-title">Administrateurs du panel</h2>
    <p class="dlg-hint">Ces comptes peuvent se connecter et gérer les tâches. Les <strong>admins du site</strong> ont toujours accès. Le nom et l'avatar s'affichent dès la première connexion de la personne.</p>
    <form id="form-add" class="add-row">
      <input type="text" id="f-discord-id" inputmode="numeric" pattern="[0-9]{15,21}" maxlength="21" autocomplete="off" placeholder="ID Discord (ex. 123456789012345678)" aria-label="ID Discord à ajouter" required>
      <button type="submit" class="btn primary">Ajouter</button>
    </form>
    <p class="form-error" id="form-add-error" role="alert" hidden></p>
    <ul class="admins-list" id="admins-list"></ul>
  </div>
  <div class="dlg-actions">
    <button type="button" class="btn ghost" data-close-dialog>Fermer</button>
  </div>
</dialog>

<script>
window.TASK_BOOT = <?= json_encode($boot, JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
</script>
<script src="<?= task_e($base) ?>/assets/app.js?v=<?= TASK_ASSET_VER ?>"></script>
</body>
</html>
