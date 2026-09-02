/* ─────────────────────────────────────────────────────────────────────────────
   task/assets/app.js — Panel de tâches TheFrontHub (v4)
   Vanilla JS, sans dépendance.
   Pages auth : thème + boutons copier.
   Page applicative (TASK_BOOT présent) : tableau + recherche/filtres/tri,
   drag & drop, échéances, étiquettes, épinglage, détail + commentaires,
   historique d'activité, notifications Discord (webhook), export CSV,
   raccourcis clavier, PWA.
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

  /* PWA : service worker minimal (installabilité, jamais de contenu périmé). */
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try { navigator.serviceWorker.register(BASE + '/sw.js').catch(() => {}); } catch (e) { /* ignore */ }
  }

  const STATUSES = [
    { key: 'todo', label: 'À faire' },
    { key: 'in_progress', label: 'En cours' },
    { key: 'done', label: 'Terminé' }
  ];
  const STATUS_LABEL = { todo: 'À faire', in_progress: 'En cours', done: 'Terminé' };
  const PRIORITY = { high: 'Haute', normal: 'Normale', low: 'Basse' };
  const PRIO_RANK = { high: 0, normal: 1, low: 2 };

  /* Catalogue des étiquettes — dupliqué côté serveur (lib.php) pour la validation. */
  const LABELS = {
    tournoi: { label: 'Tournoi', color: '#F59E0B' },
    site:    { label: 'Site', color: '#10B981' },
    discord: { label: 'Discord', color: '#5865F2' },
    staff:   { label: 'Staff', color: '#8B5CF6' },
    urgence: { label: 'Urgence', color: '#EF4444' },
    idee:    { label: 'Idée', color: '#EAB308' },
    bug:     { label: 'Bug', color: '#F97316' },
    divers:  { label: 'Divers', color: '#71717A' }
  };

  const ICONS = {
    play: 'M5 3l14 9-14 9V3z',
    check: 'M20 6L9 17l-5-5',
    back: 'M9 14L4 9l5-5M4 9h16',
    pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z',
    trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14',
    pin: 'M9 3h6m-5 0v5.6L6.8 12a4.2 4.2 0 003 7.17h4.4a4.2 4.2 0 003-7.17L14 8.6V3',
    comment: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
    cal: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
    box: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
    rotate: 'M1 4v6h6M3.51 15a9 9 0 102.13-9.36L1 10',
    plus: 'M12 5v14M5 12h14',
    gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z'
  };

  const ACT_META = {
    create:       { icon: 'plus',    cls: 'a-create',  verb: 'a créé' },
    edit:         { icon: 'pencil',  cls: 'a-edit',    verb: 'a modifié' },
    status:       { icon: 'play',    cls: 'a-status',  verb: 'a déplacé' },
    pin:          { icon: 'pin',     cls: 'a-pin',     verb: 'a épinglé' },
    unpin:        { icon: 'pin',     cls: 'a-pin',     verb: 'a désépinglé' },
    comment:      { icon: 'comment', cls: 'a-comment', verb: 'a commenté' },
    comment_del:  { icon: 'trash',   cls: 'a-del',     verb: 'a retiré un commentaire de' },
    delete:       { icon: 'trash',   cls: 'a-del',     verb: 'a supprimé' },
    unarchive:    { icon: 'rotate',  cls: 'a-unarch',  verb: 'a restauré' },
    admin_add:    { icon: 'plus',    cls: 'a-admin',   verb: 'a ajouté un administrateur' },
    admin_remove: { icon: 'trash',   cls: 'a-admin',   verb: 'a retiré un administrateur' },
    settings:     { icon: 'gear',    cls: 'a-admin',   verb: 'a modifié les réglages' }
  };

  const state = {
    me: BOOT.me,
    people: [],
    tasks: [],
    comments: [],
    activity: [],
    settings: null,
    loaded: false,
    filters: { q: '', prio: '', assignee: '', sort: 'priority', archived: false },
    detailId: null
  };
  let editingId = null;
  let editingLabels = [];
  const pending = new Set();
  let dragId = null;
  let dragOverEl = null;

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

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function anyDialogOpen() {
    return !!document.querySelector('dialog[open]');
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
    if (!id) return null;
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

  function fmtDay(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        .format(new Date(ts * 1000));
    } catch (e) { return ''; }
  }

  function fmtRel(ts) {
    if (!ts) return '';
    const s = Date.now() / 1000 - ts;
    if (s < 45) return "à l'instant";
    if (s < 3600) return 'il y a ' + Math.max(1, Math.round(s / 60)) + ' min';
    if (s < 7200) return 'il y a 1 h';
    if (s < 86400) return 'il y a ' + Math.round(s / 3600) + ' h';
    if (s < 172800) return 'hier';
    return 'le ' + fmtDay(ts);
  }

  function startOfDayMs(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function isoDate(ts) {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function labelKeys(t) {
    return String((t && t.labels) || '').split(',').filter(Boolean).slice(0, 4);
  }

  function dueInfo(t) {
    if (!t || !t.due_ts) return null;
    const dueMs = startOfDayMs(t.due_ts * 1000);
    const todayMs = startOfDayMs(Date.now());
    const diffDays = Math.round((dueMs - todayMs) / 86400000);
    const dayTxt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' })
      .format(new Date(t.due_ts * 1000));
    const active = t.status !== 'done' && !t.archived_ts;
    if (active && diffDays < 0) return { cls: 'overdue', label: 'En retard · ' + dayTxt };
    if (active && diffDays === 0) return { cls: 'today', label: "Aujourd'hui" };
    return { cls: '', label: 'Pour le ' + dayTxt };
  }

  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /(https?:\/\/[^\s<>"')\]]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[1];
      a.textContent = m[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      frag.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  async function refresh() {
    const j = await apiState();
    state.people = j.people || [];
    state.tasks = j.tasks || [];
    state.comments = j.comments || [];
    state.activity = j.activity || [];
    state.settings = j.settings || null;
    state.me = j.me || state.me;
    state.loaded = true;
    renderAll();
  }

  /* ── Filtrage / tri ─────────────────────────────────────────────────────── */

  function visibleTasks() {
    const f = state.filters;
    let list = state.tasks.filter((t) => (f.archived ? !!t.archived_ts : !t.archived_ts));
    if (f.q) {
      const q = f.q.toLowerCase();
      list = list.filter((t) =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q));
    }
    if (f.prio) list = list.filter((t) => t.priority === f.prio);
    if (f.assignee === '__me__') list = list.filter((t) => t.assignee_id === state.me.id);
    else if (f.assignee === '__none__') list = list.filter((t) => !t.assignee_id);
    else if (f.assignee) list = list.filter((t) => t.assignee_id === f.assignee);
    return list;
  }

  function sortList(list) {
    const s = state.filters.sort;
    const arr = list.slice();
    arr.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      if (s === 'due') {
        const ad = a.due_ts || Infinity;
        const bd = b.due_ts || Infinity;
        if (ad !== bd) return ad - bd;
      } else if (s === 'recent') {
        if ((b.created_ts || 0) !== (a.created_ts || 0)) return (b.created_ts || 0) - (a.created_ts || 0);
      } else if (s === 'assignee') {
        const pa = a.assignee_id ? (personById(a.assignee_id) || {}).name || 'zz' : 'zzz';
        const pb = b.assignee_id ? (personById(b.assignee_id) || {}).name || 'zz' : 'zzz';
        const an = String(pa).toLowerCase();
        const bn = String(pb).toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
      }
      const pr = (PRIO_RANK[a.priority] !== undefined ? PRIO_RANK[a.priority] : 1)
        - (PRIO_RANK[b.priority] !== undefined ? PRIO_RANK[b.priority] : 1);
      if (pr !== 0) return pr;
      return (b.created_ts || 0) - (a.created_ts || 0);
    });
    return arr;
  }

  /* ── Rendu ──────────────────────────────────────────────────────────────── */

  function renderAll() {
    renderMe();
    fillAssigneeFilter();
    renderCounts();
    renderBoard();
    renderDetail();
    updateTabTitle();
  }

  function updateTabTitle() {
    const n = state.tasks.filter((t) => !t.archived_ts && t.status !== 'done').length;
    document.title = (n > 0 ? '(' + n + ') ' : '') + 'Tâches — TheFrontHub';
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
    const st = $('#btn-settings');
    if (st && state.me.can_manage) st.hidden = false;
  }

  function renderCounts() {
    const box = $('#counts');
    if (!box) return;
    const live = state.tasks.filter((t) => !t.archived_ts);
    const open = live.filter((t) => t.status !== 'done').length;
    const todayMs = startOfDayMs(Date.now());
    const late = live.filter((t) => t.status !== 'done' && t.due_ts && startOfDayMs(t.due_ts * 1000) < todayMs).length;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const weekMs = d.getTime() - ((d.getDay() + 6) % 7) * 86400000;
    const doneWeek = state.tasks.filter((t) => t.completed_ts && t.completed_ts * 1000 >= weekMs).length;

    box.textContent = '';
    const parts = [
      [el('b', '', String(open)), el('span', '', open === 1 ? ' ouverte' : ' ouvertes')]
    ];
    if (late > 0) parts.push([el('b', 'late', String(late)), el('span', '', ' en retard')]);
    parts.push([
      el('b', '', String(doneWeek)),
      el('span', '', doneWeek === 1 ? ' terminée cette semaine' : ' terminées cette semaine')
    ]);
    parts.forEach((pair, i) => {
      if (i > 0) box.appendChild(el('span', 'dot', '·'));
      box.appendChild(pair[0]);
      box.appendChild(pair[1]);
    });
  }

  function fillAssigneeFilter() {
    const sel = $('#f-assignee');
    if (!sel) return;
    const cur = state.filters.assignee;
    while (sel.options.length > 3) sel.remove(3);
    for (const p of state.people) {
      const o = el('option', '', p.name || ('ID ' + p.id));
      o.value = p.id;
      sel.appendChild(o);
    }
    const has = Array.from(sel.options).some((o) => o.value === cur);
    sel.value = has ? cur : '';
  }

  function labelChip(key) {
    const meta = LABELS[key];
    if (!meta) return null;
    const s = el('span', 'lchip');
    s.style.setProperty('--lc', meta.color);
    s.appendChild(el('span', 'lchip-dot'));
    s.appendChild(el('span', '', meta.label));
    return s;
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
    const card = el('article', 'task' + (t.pinned ? ' pinned' : ''));
    card.dataset.status = t.status;
    card.dataset.id = String(t.id);
    card.draggable = !t.archived_ts;

    const top = el('div', 'task-top');
    top.appendChild(el('span', 'prio prio-' + t.priority, PRIORITY[t.priority] || 'Normale'));
    if (t.pinned) {
      const pin = svg(ICONS.pin, 12);
      pin.classList.add('pin-ico');
      top.appendChild(pin);
    }
    top.appendChild(el('span', 'task-num', '#' + t.id));
    const pb = el('button', 'task-pin-btn');
    pb.type = 'button';
    pb.dataset.act = 'pin';
    pb.dataset.id = String(t.id);
    pb.title = t.pinned ? 'Désépingler' : 'Épingler';
    pb.setAttribute('aria-label', pb.title);
    pb.appendChild(svg(ICONS.pin, 13));
    top.appendChild(pb);
    card.appendChild(top);

    card.appendChild(el('h3', 'task-title', t.title));

    if (t.description) {
      const d = el('p', 'task-desc', t.description);
      d.title = t.description;
      card.appendChild(d);
    }

    const labels = labelKeys(t);
    if (labels.length) {
      const lc = el('div', 'label-chips');
      for (const k of labels) {
        const c = labelChip(k);
        if (c) lc.appendChild(c);
      }
      card.appendChild(lc);
    }

    const due = dueInfo(t);
    const cCount = state.comments.filter((c) => c.task_id === t.id).length;
    if (due || cCount > 0 || t.archived_ts) {
      const flags = el('div', 'task-flags');
      if (due) {
        const f = el('span', 'due ' + due.cls);
        f.appendChild(svg(ICONS.cal, 12));
        f.appendChild(el('span', '', due.label));
        flags.appendChild(f);
      }
      if (cCount > 0) {
        const cb = el('span', 'due cm');
        cb.appendChild(svg(ICONS.comment, 12));
        cb.appendChild(el('span', '', String(cCount)));
        flags.appendChild(cb);
      }
      if (t.archived_ts) {
        const ab = el('span', 'due arch');
        ab.appendChild(svg(ICONS.box, 12));
        ab.appendChild(el('span', '', 'Archivée'));
        flags.appendChild(ab);
      }
      card.appendChild(flags);
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
    if (t.archived_ts) {
      b = actBtn('go', ICONS.rotate, 'Restaurer dans le tableau', 'Restaurer');
      b.dataset.act = 'unarchive'; b.dataset.id = String(t.id);
      actions.appendChild(b);
      b = actBtn('', ICONS.pencil, 'Modifier la tâche', 'Modifier');
      b.dataset.act = 'edit'; b.dataset.id = String(t.id);
      actions.appendChild(b);
    } else if (t.status === 'todo') {
      b = actBtn('go', ICONS.play, 'Démarrer la tâche', 'En cours');
      b.dataset.act = 'move'; b.dataset.to = 'in_progress'; b.dataset.id = String(t.id);
      actions.appendChild(b);
      b = actBtn('done', ICONS.check, 'Marquer comme terminée', 'Terminée');
      b.dataset.act = 'move'; b.dataset.to = 'done'; b.dataset.id = String(t.id);
      actions.appendChild(b);
      b = actBtn('', ICONS.pencil, 'Modifier la tâche', 'Modifier');
      b.dataset.act = 'edit'; b.dataset.id = String(t.id);
      actions.appendChild(b);
    } else if (t.status === 'in_progress') {
      b = actBtn('', ICONS.back, 'Remettre à faire', 'À faire');
      b.dataset.act = 'move'; b.dataset.to = 'todo'; b.dataset.id = String(t.id);
      actions.appendChild(b);
      b = actBtn('done', ICONS.check, 'Marquer comme terminée', 'Terminée');
      b.dataset.act = 'move'; b.dataset.to = 'done'; b.dataset.id = String(t.id);
      actions.appendChild(b);
      b = actBtn('', ICONS.pencil, 'Modifier la tâche', 'Modifier');
      b.dataset.act = 'edit'; b.dataset.id = String(t.id);
      actions.appendChild(b);
    } else {
      b = actBtn('', ICONS.back, 'Réouvrir la tâche', 'Réouvrir');
      b.dataset.act = 'move'; b.dataset.to = 'todo'; b.dataset.id = String(t.id);
      actions.appendChild(b);
      b = actBtn('', ICONS.pencil, 'Modifier la tâche', 'Modifier');
      b.dataset.act = 'edit'; b.dataset.id = String(t.id);
      actions.appendChild(b);
    }

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
      visibleTasks().filter((t) => t.status === s.key).length
    )));
    col.appendChild(head);

    const body = el('div', 'col-body');
    const list = sortList(visibleTasks().filter((t) => t.status === s.key));
    if (list.length === 0) {
      body.appendChild(el('div', 'col-empty', state.filters.archived
        ? 'Aucune tâche archivée.'
        : (s.key === 'todo'
          ? 'Aucune tâche — clique sur « Nouvelle tâche » ou appuie sur N.'
          : 'Aucune tâche ici.')));
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

  async function doPin(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    const j = await apiAction('task.pin', { id: id, pinned: !t.pinned });
    if (!j.ok) {
      toast(j.message || 'Action impossible', 'error');
      return;
    }
    refresh().catch(() => {});
  }

  async function doUnarchive(id) {
    const j = await apiAction('task.unarchive', { id: id });
    if (!j.ok) {
      toast(j.message || 'Action impossible', 'error');
      return;
    }
    toast('Tâche restaurée dans le tableau', 'success');
    refresh().catch(() => {});
  }

  async function doDelete(id) {
    if (!window.confirm('Supprimer définitivement cette tâche ?')) return;
    const j = await apiAction('task.delete', { id: id });
    if (!j.ok) {
      toast(j.message || 'Suppression impossible', 'error');
      return;
    }
    toast('Tâche supprimée', 'success');
    if (state.detailId === id) {
      const dlg = $('#dlg-detail');
      if (dlg && dlg.open) dlg.close();
      state.detailId = null;
    }
    refresh().catch(() => {});
  }

  /* ── Drag & drop ────────────────────────────────────────────────────────── */

  const board = $('#board');
  if (board) {
    board.addEventListener('dragstart', (ev) => {
      const card = ev.target && ev.target.closest ? ev.target.closest('.task') : null;
      if (!card) return;
      dragId = card.dataset.id;
      card.classList.add('dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', dragId); } catch (e) { /* ignore */ }
      }
    });

    board.addEventListener('dragend', () => {
      dragId = null;
      if (board) {
        board.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging'));
      }
      if (dragOverEl) {
        dragOverEl.classList.remove('drag-over');
        dragOverEl = null;
      }
    });

    board.addEventListener('dragover', (ev) => {
      const col = ev.target && ev.target.closest ? ev.target.closest('.col') : null;
      if (!col || !dragId) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      if (dragOverEl !== col) {
        if (dragOverEl) dragOverEl.classList.remove('drag-over');
        col.classList.add('drag-over');
        dragOverEl = col;
      }
    });

    board.addEventListener('dragleave', (ev) => {
      if (!ev.relatedTarget && dragOverEl) {
        dragOverEl.classList.remove('drag-over');
        dragOverEl = null;
      }
    });

    board.addEventListener('drop', (ev) => {
      const col = ev.target && ev.target.closest ? ev.target.closest('.col') : null;
      if (!col || !dragId) return;
      ev.preventDefault();
      const to = col.dataset.status;
      const t = state.tasks.find((x) => String(x.id) === dragId);
      dragId = null;
      board.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging'));
      if (dragOverEl) {
        dragOverEl.classList.remove('drag-over');
        dragOverEl = null;
      }
      if (t && to && t.status !== to && !t.archived_ts) doStatus(t.id, to);
    });

    /* Clics sur les cartes (actions + ouverture du détail). */
    board.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (btn) {
        const id = parseInt(btn.dataset.id, 10);
        if (!id) return;
        if (btn.dataset.act === 'move') doStatus(id, btn.dataset.to);
        else if (btn.dataset.act === 'edit') {
          const t = state.tasks.find((x) => x.id === id);
          if (t) openTaskDialog(t);
        } else if (btn.dataset.act === 'del') doDelete(id);
        else if (btn.dataset.act === 'pin') doPin(id);
        else if (btn.dataset.act === 'unarchive') doUnarchive(id);
        return;
      }
      const card = ev.target.closest('.task[data-id]');
      if (card) {
        const t = state.tasks.find((x) => x.id === parseInt(card.dataset.id, 10));
        if (t) openDetail(t);
      }
    });
  }

  /* ── Dialogue tâche (création / édition) ────────────────────────────────── */

  const dlgTask = $('#dlg-task');

  function fillAssigneesDialog(selected) {
    const sel = $('#f-assignee-dialog');
    if (!sel || selected === undefined) return;
    sel.textContent = '';
    const none = el('option', '', 'Personne');
    none.value = '';
    sel.appendChild(none);
    for (const p of state.people) {
      const o = el('option', '', p.name || ('ID ' + p.id));
      o.value = p.id;
      sel.appendChild(o);
    }
    if (selected) {
      const has = Array.from(sel.options).some((o) => o.value === selected);
      if (!has) {
        const o = el('option', '', 'ID ' + selected);
        o.value = selected;
        sel.appendChild(o);
      }
      sel.value = selected;
    }
  }

  function buildLabelPicks(selected) {
    const box = $('#f-labels');
    if (!box) return;
    box.textContent = '';
    for (const key of Object.keys(LABELS)) {
      const meta = LABELS[key];
      const on = selected.indexOf(key) >= 0;
      const b = el('button', 'lchip-pick' + (on ? ' on' : ''));
      b.type = 'button';
      b.dataset.key = key;
      b.style.setProperty('--lc', meta.color);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.appendChild(el('span', 'lchip-dot'));
      b.appendChild(el('span', '', meta.label));
      b.addEventListener('click', () => {
        const i = editingLabels.indexOf(key);
        if (i >= 0) {
          editingLabels.splice(i, 1);
          b.classList.remove('on');
          b.setAttribute('aria-pressed', 'false');
        } else if (editingLabels.length < 4) {
          editingLabels.push(key);
          b.classList.add('on');
          b.setAttribute('aria-pressed', 'true');
        } else {
          toast('4 étiquettes maximum par tâche', 'error');
        }
      });
      box.appendChild(b);
    }
  }

  function openTaskDialog(task) {
    if (!dlgTask) return;
    editingId = task ? task.id : null;
    editingLabels = task ? labelKeys(task).slice() : [];
    $('#dlg-task-title').textContent = task ? 'Modifier la tâche #' + task.id : 'Nouvelle tâche';
    $('#dlg-task-save').textContent = task ? 'Enregistrer' : 'Créer';
    $('#f-title').value = task ? task.title : '';
    $('#f-desc').value = task ? (task.description || '') : '';
    $('#f-priority').value = task ? task.priority : 'normal';
    $('#f-due').value = task && task.due_ts ? isoDate(task.due_ts) : '';
    fillAssigneesDialog(task ? (task.assignee_id || '') : '');
    buildLabelPicks(editingLabels);
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
        assignee_id: $('#f-assignee-dialog') ? ($('#f-assignee-dialog').value || '') : '',
        labels: editingLabels.slice(),
        due: $('#f-due') ? $('#f-due').value : ''
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

  /* ── Détail d'une tâche + commentaires ──────────────────────────────────── */

  const dlgDetail = $('#dlg-detail');
  if (dlgDetail) {
    dlgDetail.addEventListener('close', () => { state.detailId = null; });

    dlgDetail.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      if (!id) return;
      if (btn.dataset.act === 'move') doStatus(id, btn.dataset.to);
      else if (btn.dataset.act === 'edit') {
        const t = state.tasks.find((x) => x.id === id);
        if (t) openTaskDialog(t);
      } else if (btn.dataset.act === 'del') doDelete(id);
      else if (btn.dataset.act === 'pin') doPin(id);
      else if (btn.dataset.act === 'unarchive') doUnarchive(id);
      else if (btn.dataset.act === 'cdel') {
        const cid = parseInt(btn.dataset.cid, 10);
        if (cid) deleteComment(cid);
      }
    });
  }

  function detailStatusInfo(t) {
    if (t.archived_ts) return { label: 'Archivée', cls: 'archived' };
    return { label: STATUS_LABEL[t.status] || t.status, cls: t.status };
  }

  function metaRow(labelText, valueNode) {
    const row = el('div', 'meta-row');
    row.appendChild(el('span', 'meta-label', labelText));
    const v = el('span', 'meta-value');
    v.appendChild(valueNode);
    row.appendChild(v);
    return row;
  }

  function renderDetail() {
    if (!dlgDetail || state.detailId === null || !dlgDetail.open) return;
    const t = state.tasks.find((x) => x.id === state.detailId);
    if (!t) {
      dlgDetail.close();
      state.detailId = null;
      return;
    }

    const prio = $('#detail-prio');
    prio.textContent = PRIORITY[t.priority] || 'Normale';
    prio.className = 'prio prio-' + t.priority;

    $('#detail-num').textContent = '#' + t.id;

    const st = detailStatusInfo(t);
    const stEl = $('#detail-status');
    stEl.textContent = st.label;
    stEl.className = 'detail-status st-' + st.cls;

    $('#detail-title').textContent = t.title;

    const labels = labelKeys(t);
    const lcBox = $('#detail-labels');
    lcBox.textContent = '';
    lcBox.hidden = labels.length === 0;
    for (const k of labels) {
      const c = labelChip(k);
      if (c) lcBox.appendChild(c);
    }

    const descEl = $('#detail-desc');
    if (t.description) {
      descEl.textContent = '';
      descEl.appendChild(linkify(t.description));
      descEl.hidden = false;
    } else {
      descEl.hidden = true;
    }

    const meta = $('#detail-meta');
    meta.textContent = '';

    const p = t.assignee_id ? personById(t.assignee_id) : null;
    if (t.assignee_id) {
      const wrap = el('span', 'meta-person');
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = avatarUrl(p) || defaultAvatar(t.assignee_id);
      img.onerror = () => { img.style.visibility = 'hidden'; };
      wrap.appendChild(img);
      wrap.appendChild(document.createTextNode(p && p.name ? p.name : 'ID ' + t.assignee_id));
      meta.appendChild(metaRow('Responsable', wrap));
    } else {
      meta.appendChild(metaRow('Responsable', document.createTextNode('Personne')));
    }
    meta.appendChild(metaRow('Créée par',
      document.createTextNode((t.created_by_name || '—') + (t.created_ts ? ' · ' + fmtDate(t.created_ts) : ''))));
    const due = dueInfo(t);
    if (due) {
      const dEl = el('span', 'due inline ' + due.cls);
      dEl.appendChild(svg(ICONS.cal, 12));
      dEl.appendChild(el('span', '', due.label));
      meta.appendChild(metaRow('Échéance', dEl));
    }
    if (t.status === 'done' && (t.completed_by_name || t.completed_ts)) {
      meta.appendChild(metaRow('Terminée par',
        document.createTextNode((t.completed_by_name || '—') + (t.completed_ts ? ' · ' + fmtDate(t.completed_ts) : ''))));
    }
    if (t.archived_ts) {
      meta.appendChild(metaRow('Archivée le',
        document.createTextNode(t.archived_ts ? fmtDate(t.archived_ts) : '—')));
    }

    const actions = $('#detail-actions');
    actions.textContent = '';
    let b;
    if (t.archived_ts) {
      b = actBtn('go', ICONS.rotate, 'Restaurer dans le tableau', 'Restaurer');
      b.dataset.act = 'unarchive'; b.dataset.id = String(t.id);
      actions.appendChild(b);
    } else if (t.status === 'todo') {
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
    b = actBtn('', ICONS.pin, t.pinned ? 'Désépingler la tâche' : 'Épingler la tâche', t.pinned ? 'Désépingler' : 'Épingler');
    b.dataset.act = 'pin'; b.dataset.id = String(t.id);
    actions.appendChild(b);
    b = actBtn('danger', ICONS.trash, 'Supprimer la tâche', 'Supprimer');
    b.dataset.act = 'del'; b.dataset.id = String(t.id);
    actions.appendChild(b);

    /* Commentaires */
    const list = $('#detail-comments');
    const all = state.comments.filter((c) => c.task_id === t.id);
    $('#detail-cnum').textContent = '(' + all.length + ')';
    list.textContent = '';
    if (all.length === 0) {
      list.appendChild(el('li', 'dc-empty', 'Aucun commentaire — écris le premier !'));
    } else {
      for (const c of all) {
        const li = el('li', 'dc-item');
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = avatarUrl(personById(c.author_id)) || defaultAvatar(c.author_id);
        img.onerror = () => { img.style.visibility = 'hidden'; };
        li.appendChild(img);

        const body = el('div', 'dc-body');
        const head = el('div', 'dc-head');
        head.appendChild(el('span', 'dc-name', c.author_name || 'Discord'));
        head.appendChild(el('span', 'dc-time', fmtRel(c.ts)));
        if ((c.author_id === state.me.id) || state.me.can_manage) {
          const rm = el('button', 'dc-del');
          rm.type = 'button';
          rm.dataset.act = 'cdel';
          rm.dataset.cid = String(c.id);
          rm.title = 'Supprimer ce commentaire';
          rm.setAttribute('aria-label', 'Supprimer ce commentaire');
          rm.appendChild(svg(ICONS.trash, 12));
          head.appendChild(rm);
        }
        body.appendChild(head);
        const txt = el('div', 'dc-text');
        txt.appendChild(linkify(c.body));
        body.appendChild(txt);
        li.appendChild(body);
        list.appendChild(li);
      }
    }
  }

  function openDetail(t) {
    if (!dlgDetail) return;
    state.detailId = t.id;
    renderDetail();
    dlgDetail.showModal();
  }

  async function deleteComment(cid) {
    if (!window.confirm('Supprimer ce commentaire ?')) return;
    const j = await apiAction('comment.delete', { comment_id: cid });
    if (!j.ok) {
      toast(j.message || 'Suppression impossible', 'error');
      return;
    }
    refresh().catch(() => {});
  }

  const formComment = $('#form-comment');
  if (formComment) {
    formComment.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!state.detailId) return;
      const ta = $('#f-comment');
      const body = ta.value.trim();
      if (!body) return;
      const btn = $('#btn-comment-send');
      btn.disabled = true;
      const j = await apiAction('task.comment', { id: state.detailId, body: body });
      btn.disabled = false;
      if (!j.ok) {
        toast(j.message || 'Envoi impossible', 'error');
        return;
      }
      ta.value = '';
      refresh().catch(() => {});
    });

    const ta = $('#f-comment');
    if (ta) {
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          formComment.requestSubmit();
        }
      });
    }
  }

  /* ── Historique d'activité ──────────────────────────────────────────────── */

  const dlgActivity = $('#dlg-activity');

  function renderActivity() {
    const ul = $('#activity-list');
    if (!ul) return;
    ul.textContent = '';
    if (!state.activity.length) {
      ul.appendChild(el('li', 'act-empty', 'Aucune activité pour le moment.'));
      return;
    }
    for (const a of state.activity) {
      const meta = ACT_META[a.action] || { icon: 'pencil', cls: '', verb: 'agit sur' };
      const li = el('li', 'act-row');

      const ico = el('span', 'act-ico ' + meta.cls);
      ico.appendChild(svg(ICONS[meta.icon] || ICONS.pencil, 13));
      li.appendChild(ico);

      const body = el('div', 'act-body');
      const line = el('div', 'act-line');
      line.appendChild(el('b', '', a.actor_name || 'Quelqu\u2019un'));
      line.appendChild(document.createTextNode(' ' + meta.verb));
      if (a.task_title) line.appendChild(document.createTextNode(' « ' + a.task_title + ' »'));
      body.appendChild(line);
      if (a.detail) body.appendChild(el('div', 'act-detail', a.detail));
      li.appendChild(body);

      li.appendChild(el('span', 'act-time', fmtRel(a.ts)));
      ul.appendChild(li);
    }
  }

  const btnActivity = $('#btn-activity');
  if (btnActivity) {
    btnActivity.addEventListener('click', () => {
      renderActivity();
      if (dlgActivity) dlgActivity.showModal();
    });
  }

  /* ── Réglages (webhook Discord) ─────────────────────────────────────────── */

  const dlgSettings = $('#dlg-settings');

  function openSettings() {
    if (!dlgSettings) return;
    const cfg = (state.settings && state.settings.webhook) || null;
    $('#f-webhook').value = cfg && cfg.url ? cfg.url : '';
    const ev = cfg && cfg.events ? cfg.events : { create: true, assign: true, done: true };
    $('#s-wh-create').checked = ev.create !== false;
    $('#s-wh-assign').checked = ev.assign !== false;
    $('#s-wh-done').checked = ev.done !== false;
    const err = $('#form-settings-error');
    if (err) err.hidden = true;
    dlgSettings.showModal();
  }

  const btnSettings = $('#btn-settings');
  if (btnSettings) btnSettings.addEventListener('click', openSettings);

  const btnSettingsSave = $('#btn-settings-save');
  if (btnSettingsSave) {
    btnSettingsSave.addEventListener('click', async () => {
      const err = $('#form-settings-error');
      if (err) err.hidden = true;
      const j = await apiAction('settings.save', {
        webhook: {
          url: $('#f-webhook').value.trim(),
          events: {
            create: $('#s-wh-create').checked,
            assign: $('#s-wh-assign').checked,
            done: $('#s-wh-done').checked
          }
        }
      });
      if (!j.ok) {
        if (err) {
          err.textContent = j.message || 'Erreur — réessaie.';
          err.hidden = false;
        }
        return;
      }
      dlgSettings.close();
      toast('Réglages enregistrés', 'success');
      refresh().catch(() => {});
    });
  }

  const btnWebhookTest = $('#btn-webhook-test');
  if (btnWebhookTest) {
    btnWebhookTest.addEventListener('click', async () => {
      const err = $('#form-settings-error');
      if (err) err.hidden = true;
      btnWebhookTest.disabled = true;
      const j = await apiAction('webhook.test', { url: $('#f-webhook').value.trim() });
      btnWebhookTest.disabled = false;
      if (!j.ok) {
        if (err) {
          err.textContent = j.message || 'Envoi impossible.';
          err.hidden = false;
        }
        return;
      }
      toast('Message de test envoyé — regarde ton salon !', 'success');
    });
  }

  /* ── Toolbar : recherche, filtres, tri, compact, archive, CSV ───────────── */

  const fSearch = $('#f-search');
  if (fSearch) {
    fSearch.addEventListener('input', debounce(() => {
      state.filters.q = fSearch.value.trim();
      renderBoard();
    }, 150));
    fSearch.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        fSearch.value = '';
        state.filters.q = '';
        renderBoard();
        fSearch.blur();
      }
    });
  }

  const fPrio = $('#f-prio');
  if (fPrio) fPrio.addEventListener('change', () => { state.filters.prio = fPrio.value; renderBoard(); });

  const fAssignee = $('#f-assignee');
  if (fAssignee) fAssignee.addEventListener('change', () => { state.filters.assignee = fAssignee.value; renderBoard(); });

  const fSort = $('#f-sort');
  if (fSort) fSort.addEventListener('change', () => { state.filters.sort = fSort.value; renderBoard(); });

  const btnCompact = $('#btn-compact');
  if (btnCompact) {
    try { state.compact = localStorage.getItem('tfh-task-compact') === '1'; } catch (e) { state.compact = false; }
    const applyCompact = () => {
      const b = $('#board');
      if (b) b.classList.toggle('compact', !!state.compact);
      btnCompact.classList.toggle('active', !!state.compact);
      btnCompact.setAttribute('aria-pressed', state.compact ? 'true' : 'false');
    };
    applyCompact();
    btnCompact.addEventListener('click', () => {
      state.compact = !state.compact;
      try { localStorage.setItem('tfh-task-compact', state.compact ? '1' : '0'); } catch (e) { /* ignore */ }
      applyCompact();
    });
  }

  const btnArchive = $('#btn-archive');
  if (btnArchive) {
    btnArchive.addEventListener('click', () => {
      state.filters.archived = !state.filters.archived;
      btnArchive.classList.toggle('active', state.filters.archived);
      const lbl = $('#btn-archive-label');
      if (lbl) lbl.textContent = state.filters.archived ? 'Retour au tableau' : 'Archive';
      renderBoard();
    });
  }

  function exportCsv() {
    const rows = [[
      'ID', 'Titre', 'Statut', 'Priorité', 'Étiquettes', 'Responsable', 'Échéance',
      'Créée par', 'Créée le', 'Terminée par', 'Terminée le', 'Archivée', 'Description'
    ]];
    for (const t of state.tasks) {
      const p = t.assignee_id ? personById(t.assignee_id) : null;
      rows.push([
        t.id,
        t.title || '',
        (t.archived_ts ? 'Archivée — ' : '') + (STATUS_LABEL[t.status] || t.status),
        PRIORITY[t.priority] || 'Normale',
        labelKeys(t).map((k) => (LABELS[k] ? LABELS[k].label : k)).join(' + '),
        p && p.name ? p.name : (t.assignee_id ? 'ID ' + t.assignee_id : ''),
        t.due_ts ? fmtDay(t.due_ts) : '',
        t.created_by_name || '',
        t.created_ts ? fmtDay(t.created_ts) : '',
        t.completed_by_name || '',
        t.completed_ts ? fmtDay(t.completed_ts) : '',
        t.archived_ts ? 'oui' : 'non',
        t.description || ''
      ]);
    }
    const csv = '\uFEFF' + rows
      .map((r) => r.map((v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"').join(';'))
      .join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'thefronthub-taches-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Export CSV téléchargé', 'success');
  }

  const btnCsv = $('#btn-csv');
  if (btnCsv) btnCsv.addEventListener('click', exportCsv);

  /* ── Raccourcis clavier ─────────────────────────────────────────────────── */

  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (anyDialogOpen()) return;
    if (ev.key === 'n' || ev.key === 'N') {
      ev.preventDefault();
      openTaskDialog(null);
    } else if (ev.key === '/') {
      ev.preventDefault();
      const s = $('#f-search');
      if (s) s.focus();
    }
  });

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

  setInterval(() => {
    if (!document.hidden && !anyDialogOpen() && !dragId) {
      refresh().catch(() => { /* silencieux : réseau momentanément indisponible */ });
    }
  }, 30000);

  /* ── Démarrage ──────────────────────────────────────────────────────────── */

  refresh().catch((e) => {
    if (e && e.message === 'reload') return;
    const detail = e && e.message ? ' (' + e.message + ')' : '';
    const bl = $('.board-loading');
    if (bl) bl.textContent = 'Impossible de charger le tableau' + detail + ' — recharge la page.';
    toast('Chargement impossible', 'error');
  });
})();
