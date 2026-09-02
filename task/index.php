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
    <div class="toolbar-left">
      <div class="search-box">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        <input type="search" id="f-search" placeholder="Rechercher… (touche /)" aria-label="Rechercher une tâche" autocomplete="off">
      </div>
      <select id="f-prio" aria-label="Filtrer par priorité">
        <option value="">Toutes priorités</option>
        <option value="high">Priorité haute</option>
        <option value="normal">Priorité normale</option>
        <option value="low">Priorité basse</option>
      </select>
      <select id="f-assignee" aria-label="Filtrer par personne">
        <option value="">Tout le monde</option>
        <option value="__me__">Mes tâches</option>
        <option value="__none__">Non assignées</option>
      </select>
      <select id="f-sort" aria-label="Trier les tâches">
        <option value="priority">Tri : priorité</option>
        <option value="due">Tri : échéance</option>
        <option value="recent">Tri : plus récentes</option>
        <option value="assignee">Tri : personne</option>
      </select>
    </div>
    <div class="counts" id="counts" aria-live="polite"></div>
    <div class="toolbar-actions">
      <button type="button" id="btn-compact" class="icon-btn" title="Vue compacte" aria-pressed="false" aria-label="Basculer la vue compacte">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 5h18M3 12h18M3 19h18"/></svg>
      </button>
      <button type="button" id="btn-csv" class="icon-btn" title="Exporter en CSV (Excel)" aria-label="Exporter en CSV">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
      </button>
      <button type="button" id="btn-activity" class="icon-btn" title="Historique d'activité" aria-label="Historique d'activité">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
      </button>
      <button type="button" id="btn-archive" class="btn ghost small" title="Voir les tâches archivées">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/></svg>
        <span id="btn-archive-label">Archive</span>
      </button>
      <button type="button" id="btn-settings" class="icon-btn" hidden title="Réglages (notifications Discord)" aria-label="Réglages">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
      </button>
      <button type="button" id="btn-admins" class="btn ghost small" hidden>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
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
          <span class="field-label">Pour le</span>
          <input type="date" id="f-due" name="due">
        </label>
      </div>
      <label class="field">
        <span class="field-label">Assigner à</span>
        <select id="f-assignee-dialog" name="assignee_id">
          <option value="">Personne</option>
        </select>
      </label>
      <div class="field">
        <span class="field-label">Étiquettes <span class="field-hint">(4 maximum)</span></span>
        <div class="label-picks" id="f-labels" role="group" aria-label="Étiquettes de la tâche"></div>
      </div>
      <p class="form-error" id="form-task-error" role="alert" hidden></p>
    </div>
    <div class="dlg-actions">
      <button type="button" class="btn ghost" id="dlg-task-cancel">Annuler</button>
      <button type="submit" class="btn primary" id="dlg-task-save">Créer</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-detail" class="dlg dlg-wide" aria-labelledby="detail-title">
  <div class="dlg-body">
    <div class="detail-top">
      <span class="prio" id="detail-prio"></span>
      <span class="task-num" id="detail-num"></span>
      <span class="detail-status" id="detail-status"></span>
    </div>
    <h2 id="detail-title"></h2>
    <div class="label-chips" id="detail-labels" hidden></div>
    <p class="detail-desc" id="detail-desc" hidden></p>
    <div class="detail-meta" id="detail-meta"></div>
    <div class="detail-actions" id="detail-actions"></div>
    <div class="detail-comments">
      <h3 class="dc-title">Commentaires <span class="dc-count" id="detail-cnum"></span></h3>
      <ul class="dc-list" id="detail-comments"></ul>
      <form id="form-comment" class="dc-form">
        <textarea id="f-comment" rows="2" maxlength="2000" placeholder="Écrire un commentaire… (Entrée pour envoyer)" aria-label="Nouveau commentaire"></textarea>
        <button type="submit" class="btn primary small" id="btn-comment-send">Envoyer</button>
      </form>
    </div>
  </div>
  <div class="dlg-actions">
    <button type="button" class="btn ghost" data-close-dialog>Fermer</button>
  </div>
</dialog>

<dialog id="dlg-activity" class="dlg" aria-labelledby="dlg-activity-title">
  <div class="dlg-body">
    <h2 id="dlg-activity-title">Historique d'activité</h2>
    <p class="dlg-hint">Les 120 dernières actions sur le panel.</p>
    <ul class="act-list" id="activity-list"></ul>
  </div>
  <div class="dlg-actions">
    <button type="button" class="btn ghost" data-close-dialog>Fermer</button>
  </div>
</dialog>

<dialog id="dlg-settings" class="dlg" aria-labelledby="dlg-settings-title">
  <div class="dlg-body">
    <h2 id="dlg-settings-title">Notifications Discord</h2>
    <p class="dlg-hint">Reçois un message dans ton serveur Discord à chaque création, assignation ou terminaison de tâche.<br>Pour créer le webhook : sur ton serveur Discord, <strong>Paramètres du salon → Intégrations → Webhooks → Nouveau webhook → Copier l'URL</strong>.</p>
    <label class="field">
      <span class="field-label">URL du webhook</span>
      <input type="url" id="f-webhook" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" spellcheck="false">
    </label>
    <div class="check-row" role="group" aria-label="Événements notifiés">
      <label class="check">
        <input type="checkbox" id="s-wh-create" checked>
        <span>Nouvelle tâche</span>
      </label>
      <label class="check">
        <input type="checkbox" id="s-wh-assign" checked>
        <span>Assignation</span>
      </label>
      <label class="check">
        <input type="checkbox" id="s-wh-done" checked>
        <span>Tâche terminée</span>
      </label>
    </div>
    <div class="set-test-row">
      <button type="button" class="btn ghost small" id="btn-webhook-test">Envoyer un message de test</button>
    </div>
    <p class="form-error" id="form-settings-error" role="alert" hidden></p>
  </div>
  <div class="dlg-actions">
    <button type="button" class="btn ghost" data-close-dialog>Fermer</button>
    <button type="button" class="btn primary" id="btn-settings-save">Enregistrer</button>
  </div>
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
