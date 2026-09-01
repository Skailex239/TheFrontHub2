/* ─────────────────────────────────────────────────────────────────────────────
   task/assets/app.js — Panel de tâches TheFrontHub
   Vanilla JS, sans dépendance. Pages auth : thème + boutons copier.
   Page applicative (TASK_BOOT présent) : tableau des tâches + actions.
   ───────────────────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);

  /* ── Communs (toutes pages) ─────────────────────────────────────────────── */

  function wireTheme() {
    const b = $('#btn-theme');
    if (!b) return;
    b.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('tfh-task-theme', next); } catch (e) { /* stockage indisponible */ }
    });
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function copyText(text) {
    return new Promise((resolve) => {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => resolve(true), () => resolve(fallbackCopy(text)));
      } else {
        resolve(fallbackCopy(text));
      }
    });
  }

  function wireCopy() {
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-copy],[data-copy-static]');
      if (!b) return;
      const ref = b.getAttribute('data-copy');
      const value = b.getAttribute('data-copy-static') ||
        (ref && document.getElementById(ref) ? document.getElementById(ref).textContent : '');
      if (!value) return;
      copyText(value).then((ok) => {
        const label = b.querySelector('span') || b;
        const old = label.textContent;
        label.textContent = ok ? 'Copié' : 'Erreur';
        setTimeout(() => { label.textContent = old; }, 1500);
      });
    });
  }

  wireTheme();
  wireCopy();

  const BOOT = window.TASK_BOOT;
  if (!BOOT) return; /* pages connexion / refusé : rien d'autre à faire */

  /* ── Constantes applicatives ────────────────────────────────────────────── */

  const BASE = BOOT.base || '';
  const STATUSES = [
    { key: 'todo', label: 'À faire' },
    { key: 'in_progress', label: 'En cours' },
    { key: 'done', label: 'Terminé' }
  ];
  const PRIORITY = { high: 'Haute', normal: 'Normale', low: 'Basse' };
  const ICONS = {
    play: 'M5 3l14 9-14 9V3z',
    check: 'M20 6L9 17l-5-5',
    back: 'M9 14L4 9l5-5M4 9h16',
    pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z',
    trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14'
  };

  const state = { me: BOOT.me, people: [], tasks: [], loaded: false };
  let editingId = null;
  const pending = new Set();

  /* ── Helpers DOM ────────────────────────────────────────────────────────── */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function svg(path, size) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 13);
    s.setAttribute('height', size || 13);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    return s;
  }

  /* ── API ────────────────────────────────────────────────────────────────── */

  function csrf() {
    const m = document.cookie.match(/(?:^|;\s*)tfh_task_csrf=([a-f0-9]{32})/);
    return m ? m[1] : (BOOT.csrf || '');
  }

  async function apiState() {
    const r = await fetch(BASE + '/api.php?action=state', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (r.status === 401) {
      window.location.reload();
      throw new Error('reload');
    }
    let j = null;
    try { j = await r.json(); } catch (e) { /* réponse non JSON */ }
    if (!j) throw new Error('réponse invalide du serveur (HTTP ' + r.status + ')');
    if (r.status === 403 && (j.error === 'forbidden' || j.error === 'not_logged')) {
      window.location.reload();
      throw new Error('reload');
    }
    if (!j.ok) throw new Error(j.message || j.error || 'Erreur de chargement (HTTP ' + r.status + ')');
    return j;
  }

  async function apiAction(action, payload) {
    let r;
    try {
      r = await fetch(BASE + '/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf(), Accept: 'application/json' },
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
        cache: 'no-store'
      });
    } catch (e) {
      return { ok: false, error: 'network', message: 'Réseau indisponible — réessaie.' };
    }
    let j = null;
    try { j = await r.json(); } catch (e) { /* réponse non JSON */ }
    if (!j) j = { ok: false, error: 'bad_response', message: 'Réponse invalide du serveur' };
    return j;
  }

  /* ── Toasts ─────────────────────────────────────────────────────────────── */

  function toast(message, kind) {
    const box = $('#toasts');
    if (!box) return;
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), message);
    box.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s ease';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 260);
    }, 3200);
  }

  /* ── Données ────────────────────────────────────────────────────────────── */

  function personById(id) {
    for (const p of state.people) if (p.id === id) return p;
    return null;
  }

  function defaultAvatar(id) {
    let idx = 0;
    try { idx = Number((BigInt(id) >> BigInt(22)) % BigInt(6)); } catch (e) { idx = 0; }
    return 'https://cdn.discordapp.com/embed/avatars/' + idx + '.png';
  }

  function avatarUrl(p) {
    if (p && p.avatar) return p.avatar;
    if (p && p.id) return defaultAvatar(p.id);
    return '';
  }

  function fmtDate(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      }).format(new Date(ts * 1000));
    } catch (e) { return ''; }
  }

  async function refresh() {
    const j = await apiState();
    state.people = j.people || [];
    state.tasks = j.tasks || [];
    state.me = j.me || state.me;
    state.loaded = true;
    renderAll();
  }

  /* ── Rendu ──────────────────────────────────────────────────────────────── */

  function renderAll() {
    renderMe();
    renderCounts();
    renderBoard();
  }

  function renderMe() {
    const img = $('#me-avatar');
    if (img) {
      if (state.me.avatar) {
        img.src = state.me.avatar;
        img.onerror = () => { img.style.visibility = 'hidden'; };
      }
      img.alt = '';
    }
    const nm = $('#me-name');
    if (nm) nm.textContent = state.me.name || '';
    const btn = $('#btn-admins');
    if (btn && state.me.can_manage) btn.hidden = false;
  }

  function renderCounts() {
    const box = $('#counts');
    if (!box) return;
    const c = { todo: 0, in_progress: 0, done: 0 };
    for (const t of state.tasks) if (c[t.status] !== undefined) c[t.status] += 1;
    box.textContent = '';
    const parts = [
      [el('b', '', String(c.todo)), el('span', '', ' à faire')],
      [el('b', '', String(c.in_progress)), el('span', '', ' en cours')],
      [el('b', '', String(c.done)), el('span', '', ' terminé' + (c.done > 1 ? 'es' : ''))]
    ];
    parts.forEach((pair, i) => {
      if (i > 0) box.appendChild(el('span', 'dot', '·'));
      box.appendChild(pair[0]);
      box.appendChild(pair[1]);
    });
  }

  function actBtn(cls, icon, title, label) {
    const b = el('button', 'tbtn' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.appendChild(svg(icon));
    b.appendChild(el('span', '', label));
    return b;
  }

  function taskCard(t) {
    const card = el('article', 'task');
    card.dataset.status = t.status;
    card.dataset.id = String(t.id);

    const top = el('div', 'task-top');
    top.appendChild(el('span', 'prio prio-' + t.priority, PRIORITY[t.priority] || 'Normale'));
    top.appendChild(el('span', 'task-num', '#' + t.id));
    card.appendChild(top);

    card.appendChild(el('h3', 'task-title', t.title));

    if (t.description) {
      const d = el('p', 'task-desc', t.description);
      d.title = t.description;
      card.appendChild(d);
    }

    if (t.assignee_id) {
      const p = personById(t.assignee_id);
      const a = el('div', 'task-assignee');
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = avatarUrl(p) || defaultAvatar(t.assignee_id);
      img.onerror = () => { img.style.visibility = 'hidden'; };
      a.appendChild(img);
      a.appendChild(el('span', 'as-label', 'Assignée à'));
      a.appendChild(el('span', '', p && p.name ? p.name : 'ID ' + t.assignee_id));
      card.appendChild(a);
    }

    card.appendChild(el('div', 'task-meta',
      'Créée par ' + (t.created_by_name || '—') + (t.created_ts ? ' · ' + fmtDate(t.created_ts) : '')));

    if (t.status === 'done' && (t.completed_by_name || t.completed_ts)) {
      card.appendChild(el('div', 'task-doneby',
        'Terminée par ' + (t.completed_by_name || '—') + (t.completed_ts ? ' · ' + fmtDate(t.completed_ts) : '')));
    }

    const actions = el('div', 'task-actions');
    let b;
    if (t.status === 'todo') {
      b = actBtn('go', ICONS.play, 'Démarrer la tâche', 'En cours');
      b.dataset.act = 'move'; b.dataset.to = 'in_progress'; b.dataset.id = String(t.id);
      actions.appendChild(b);
      b = actBtn('done', ICONS.check, 'Marquer comme terminée', 'Terminée');
      b.dataset.act = 'move'; b.dataset.to = 'done'; b.dataset.id = String(t.id);
      actions.appendChild(b);
    } else if (t.status === 'in_progress') {
      b = actBtn('', ICONS.back, 'Remettre à faire', 'À faire');
      b.dataset.act = 'move'; b.dataset.to = 'todo'; b.dataset.id = String(t.id);
      actions.appendChild(b);
      b = actBtn('done', ICONS.check, 'Marquer comme terminée', 'Terminée');
      b.dataset.act = 'move'; b.dataset.to = 'done'; b.dataset.id = String(t.id);
      actions.appendChild(b);
    } else {
      b = actBtn('', ICONS.back, 'Réouvrir la tâche', 'Réouvrir');
      b.dataset.act = 'move'; b.dataset.to = 'todo'; b.dataset.id = String(t.id);
      actions.appendChild(b);
    }

    b = actBtn('', ICONS.pencil, 'Modifier la tâche', 'Modifier');
    b.dataset.act = 'edit'; b.dataset.id = String(t.id);
    actions.appendChild(b);

    b = actBtn('danger', ICONS.trash, 'Supprimer la tâche', 'Supprimer');
    b.dataset.act = 'del'; b.dataset.id = String(t.id);
    actions.appendChild(b);

    card.appendChild(actions);
    return card;
  }

  function column(s) {
    const col = el('section', 'col');
    col.dataset.status = s.key;
    col.setAttribute('aria-label', s.label);

    const head = el('div', 'col-head');
    head.appendChild(el('span', 'col-dot'));
    head.appendChild(el('span', 'col-title', s.label));
    head.appendChild(el('span', 'col-count', String(
      state.tasks.filter((t) => t.status === s.key).length
    )));
    col.appendChild(head);

    const body = el('div', 'col-body');
    const list = state.tasks.filter((t) => t.status === s.key);
    if (list.length === 0) {
      body.appendChild(el('div', 'col-empty', s.key === 'todo'
        ? 'Aucune tâche — clique sur « Nouvelle tâche ».'
        : 'Aucune tâche ici.'));
    } else {
      for (const t of list) body.appendChild(taskCard(t));
    }
    col.appendChild(body);
    return col;
  }

  function renderBoard() {
    const board = $('#board');
    if (!board) return;
    board.setAttribute('aria-busy', 'false');
    board.textContent = '';
    for (const s of STATUSES) board.appendChild(column(s));
  }

  /* ── Actions ────────────────────────────────────────────────────────────── */

  async function doStatus(id, to) {
    if (pending.has(id)) return;
    pending.add(id);
    const j = await apiAction('task.status', { id: id, status: to });
    pending.delete(id);
    if (!j.ok) {
      toast(j.message || 'Action impossible', 'error');
      return;
    }
    refresh().catch(() => {});
  }

  const board = $('#board');
  if (board) {
    board.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      if (!id) return;
      if (btn.dataset.act === 'move') {
        doStatus(id, btn.dataset.to);
      } else if (btn.dataset.act === 'edit') {
        const t = state.tasks.find((x) => x.id === id);
        if (t) openTaskDialog(t);
      } else if (btn.dataset.act === 'del') {
        if (!window.confirm('Supprimer définitivement cette tâche ?')) return;
        const j = await apiAction('task.delete', { id: id });
        if (!j.ok) {
          toast(j.message || 'Suppression impossible', 'error');
          return;
        }
        toast('Tâche supprimée', 'success');
        refresh().catch(() => {});
      }
    });
  }

  /* ── Dialogue tâche (création / édition) ────────────────────────────────── */

  const dlgTask = $('#dlg-task');

  function fillAssignees(selected) {
    const sel = $('#f-assignee');
    if (!sel) return;
    sel.textContent = '';
    const none = el('option', '', 'Personne');
    none.value = '';
    sel.appendChild(none);
    for (const p of state.people) {
      const o = el('option', '', p.name || ('ID ' + p.id));
      o.value = p.id;
      if (selected && selected === p.id) o.selected = true;
      sel.appendChild(o);
    }
    if (selected && sel.value !== selected) {
      const o = el('option', '', 'ID ' + selected);
      o.value = selected;
      o.selected = true;
      sel.appendChild(o);
    }
  }

  function openTaskDialog(task) {
    if (!dlgTask) return;
    editingId = task ? task.id : null;
    $('#dlg-task-title').textContent = task ? 'Modifier la tâche #' + task.id : 'Nouvelle tâche';
    $('#dlg-task-save').textContent = task ? 'Enregistrer' : 'Créer';
    $('#f-title').value = task ? task.title : '';
    $('#f-desc').value = task ? (task.description || '') : '';
    $('#f-priority').value = task ? task.priority : 'normal';
    fillAssignees(task ? (task.assignee_id || '') : '');
    $('#form-task-error').hidden = true;
    dlgTask.showModal();
    $('#f-title').focus();
  }

  const btnNew = $('#btn-new');
  if (btnNew) btnNew.addEventListener('click', () => openTaskDialog(null));

  const btnCancel = $('#dlg-task-cancel');
  if (btnCancel) btnCancel.addEventListener('click', () => dlgTask.close());

  const formTask = $('#form-task');
  if (formTask) {
    formTask.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('#form-task-error');
      const title = $('#f-title').value.trim();
      if (!title) {
        err.textContent = 'Le titre est obligatoire.';
        err.hidden = false;
        return;
      }
      const save = $('#dlg-task-save');
      save.disabled = true;
      const payload = {
        title: title,
        description: $('#f-desc').value.trim(),
        priority: $('#f-priority').value,
        assignee_id: $('#f-assignee') ? ($('#f-assignee').value || '') : ''
      };
      const j = await apiAction(editingId ? 'task.edit' : 'task.create',
        editingId ? Object.assign({ id: editingId }, payload) : payload);
      save.disabled = false;
      if (!j.ok) {
        err.textContent = j.message || 'Erreur — réessaie.';
        err.hidden = false;
        return;
      }
      dlgTask.close();
      toast(editingId ? 'Tâche mise à jour' : 'Tâche créée', 'success');
      refresh().catch(() => {});
    });
  }

  /* ── Dialogue administrateurs ───────────────────────────────────────────── */

  const dlgAdmins = $('#dlg-admins');

  function renderAdmins() {
    const ul = $('#admins-list');
    if (!ul) return;
    ul.textContent = '';
    if (state.people.length === 0) {
      const li = el('li', 'admin-row');
      li.appendChild(el('div', 'admin-info', 'Aucun compte dans la liste.'));
      ul.appendChild(li);
      return;
    }
    for (const p of state.people) {
      const li = el('li', 'admin-row');

      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = avatarUrl(p) || defaultAvatar(p.id);
      img.onerror = () => { img.style.visibility = 'hidden'; };
      li.appendChild(img);

      const info = el('div', 'admin-info');
      info.appendChild(p.name
        ? el('div', 'admin-name', p.name)
        : el('div', 'admin-name pending', 'En attente de première connexion'));
      info.appendChild(el('div', 'admin-id', p.id));
      li.appendChild(info);

      li.appendChild(el('span',
        'admin-chip' + (p.panel_role === 'owner' ? ' owner' : (p.source === 'site' ? ' site' : '')),
        p.panel_role === 'owner' ? 'Propriétaire' : (p.source === 'site' ? 'Admin site' : 'Admin')));

      if (state.me.can_manage && p.source === 'whitelist' && p.panel_role !== 'owner' && p.id !== state.me.id) {
        const rm = el('button', 'admin-remove');
        rm.type = 'button';
        rm.title = 'Retirer de la liste';
        rm.setAttribute('aria-label', 'Retirer ' + (p.name || p.id) + ' de la liste');
        rm.appendChild(svg(ICONS.trash, 14));
        rm.addEventListener('click', async () => {
          if (!window.confirm('Retirer ce compte de la liste du panel ?')) return;
          const j = await apiAction('admin.remove', { discord_id: p.id });
          if (!j.ok) {
            toast(j.message || 'Erreur', 'error');
            return;
          }
          toast('Compte retiré de la liste', 'success');
          await refresh();
          renderAdmins();
        });
        li.appendChild(rm);
      }

      ul.appendChild(li);
    }
  }

  const btnAdmins = $('#btn-admins');
  if (btnAdmins) {
    btnAdmins.addEventListener('click', () => {
      renderAdmins();
      if (dlgAdmins) dlgAdmins.showModal();
    });
  }

  document.querySelectorAll('[data-close-dialog]').forEach((b) => {
    b.addEventListener('click', () => {
      const d = b.closest('dialog');
      if (d) d.close();
    });
  });

  const formAdd = $('#form-add');
  if (formAdd) {
    formAdd.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = $('#f-discord-id');
      const err = $('#form-add-error');
      err.hidden = true;
      const j = await apiAction('admin.add', { discord_id: input.value.trim() });
      if (!j.ok) {
        err.textContent = j.message || 'Erreur — réessaie.';
        err.hidden = false;
        return;
      }
      input.value = '';
      toast('Compte ajouté à la liste', 'success');
      await refresh();
      renderAdmins();
    });
  }

  /* ── Rafraîchissement automatique ───────────────────────────────────────── */

  function anyDialogOpen() {
    return !!document.querySelector('dialog[open]');
  }

  setInterval(() => {
    if (!document.hidden && !anyDialogOpen()) {
      refresh().catch(() => { /* silencieux : réseau momentanément indisponible */ });
    }
  }, 30000);

  /* ── Démarrage ──────────────────────────────────────────────────────────── */

  refresh().catch((e) => {
    if (e && e.message === 'reload') return;
    const detail = e && e.message ? ' (' + e.message + ')' : '';
    const bl = $('#board-loading');
    if (bl) bl.textContent = 'Impossible de charger le tableau' + detail + ' — recharge la page.';
    toast('Chargement impossible', 'error');
  });
})();
