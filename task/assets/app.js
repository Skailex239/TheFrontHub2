/* ─────────────────────────────────────────────────────────────────────────────
   task/assets/app.js — Panel de tâches TheFrontHub (v7)
   Vanilla JS, sans dépendance.
   Pages auth : thème + boutons copier.
   Page applicative (TASK_BOOT présent) : tableau + liste façon tableur,
   recherche/filtres/tri, drag & drop, échéances, étiquettes, versions/jalons,
   épinglage, checklists (sous-tâches), détail + discussion style Discord
   (texte, liens, images, vidéos, fichiers joints 30 j), historique d'activité,
   notifications Discord (webhook), stats de vélocité, générateur de patch
   notes, export CSV, raccourcis clavier, PWA.
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
    tournoi: { label: 'Tournois & ELO',  emoji: '🏆', color: '#F59E0B' },
    site:    { label: 'Site',            emoji: '🌐', color: '#10B981' },
    discord: { label: 'Discord',         emoji: '💬', color: '#5865F2' },
    staff:   { label: 'Staff',           emoji: '👥', color: '#8B5CF6' },
    urgence: { label: 'Urgence',         emoji: '🚨', color: '#EF4444' },
    idee:    { label: 'Idée',            emoji: '💡', color: '#EAB308' },
    bug:     { label: 'Bugfix',          emoji: '🐛', color: '#F97316' },
    design:  { label: 'Design / UI',     emoji: '🎨', color: '#EC4899' },
    backend: { label: 'Backend / API',   emoji: '⚙️', color: '#0EA5E9' },
    atlas:   { label: 'Atlas & Cartes',  emoji: '🗺️', color: '#84CC16' },
    perf:    { label: 'Performance',     emoji: '⚡', color: '#D946EF' },
    divers:  { label: 'Divers',          emoji: '📦', color: '#71717A' }
  };

  const ICONS = {
    play: 'M5 3l14 9-14 9V3z',
    check: 'M20 6L9 17l-5-5',
    back: 'M9 14L4 9l5-5M4 9h16',
    pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z',
    trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14',
    copy: 'M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
    download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
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
    checklist: [],
    comments: [],
    activity: [],
    settings: null,
    loaded: false,
    view: 'board',
    filters: { q: '', prio: '', assignee: '', milestone: '', sort: 'priority', archived: false },
    detailId: null,
    chat: { taskId: null, messages: [], lastId: 0, counts: {}, ttlDays: 30, pending: [], editId: null, sending: false }
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

  function mdInline(text) {
    /* Rendu enrichi sûr (aucun innerHTML avec l'entrée utilisateur) :
       `code`, **gras**, *italique*, liens, et images (URL .png/.jpg/…). */
    const frag = document.createDocumentFragment();
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|https?:\/\/[^\s<>"')\]]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[1];
      if (tok.length > 2 && tok[0] === '`' && tok[tok.length - 1] === '`') {
        frag.appendChild(el('code', 'md-code', tok.slice(1, -1)));
      } else if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
        frag.appendChild(el('b', '', tok.slice(2, -2)));
      } else if (tok[0] === '*' && tok[tok.length - 1] === '*' && tok.length > 2) {
        frag.appendChild(el('i', '', tok.slice(1, -1)));
      } else if (/^https?:\/\//i.test(tok) && /\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(tok)) {
        const a = el('a', 'md-imglink');
        a.href = tok;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const img = el('img', 'md-img');
        img.alt = 'Image partagée';
        img.loading = 'lazy';
        img.src = tok;
        img.onerror = () => { a.textContent = tok; };
        a.appendChild(img);
        frag.appendChild(a);
      } else if (/^https?:\/\//i.test(tok)) {
        const a = el('a', '', tok);
        a.href = tok;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        frag.appendChild(a);
      } else {
        frag.appendChild(document.createTextNode(tok));
      }
      last = m.index + tok.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function renderRich(text) {
    /* Markdown minimal multi-lignes : blocs de code ```, listes « - », paragraphes. */
    const frag = document.createDocumentFragment();
    const lines = String(text).split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; /* fermeture du bloc (ou fin de texte) */
        const pre = el('pre', 'md-pre');
        pre.appendChild(el('code', '', buf.join('\n')));
        frag.appendChild(pre);
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const ul = el('ul', 'md-ul');
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          const li = el('li');
          li.appendChild(mdInline(lines[i].replace(/^\s*[-*]\s+/, '')));
          ul.appendChild(li);
          i++;
        }
        frag.appendChild(ul);
        continue;
      }
      if (line.trim() === '') {
        i++;
        continue;
      }
      const p = el('div', 'md-p');
      p.appendChild(mdInline(line));
      frag.appendChild(p);
      i++;
    }
    return frag;
  }

  /* ── Versions / jalons & checklist ───────────────────────────────────────── */

  function taskMilestone(t) {
    return String((t && t.milestone) || '').trim();
  }

  function milestonesOf(list) {
    const seen = new Set();
    const out = [];
    for (const t of list) {
      const ms = taskMilestone(t);
      if (ms && !seen.has(ms.toLowerCase())) {
        seen.add(ms.toLowerCase());
        out.push(ms);
      }
    }
    return out.sort((a, b) => a.localeCompare(b, 'fr'));
  }

  function checklistOf(taskId) {
    return state.checklist.filter((c) => c.task_id === taskId);
  }

  function ckProgress(taskId) {
    const items = checklistOf(taskId);
    return { done: items.filter((c) => c.done).length, total: items.length };
  }

  function fmtDur(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min';
    if (s < 86400 * 2) return Math.round(s / 3600) + ' h';
    const d = s / 86400;
    return (d < 10 ? d.toFixed(1) : Math.round(d)).toString().replace('.', ',') + ' j';
  }

  async function refresh() {
    const j = await apiState();
    state.people = j.people || [];
    state.tasks = j.tasks || [];
    state.checklist = j.checklist || [];
    state.comments = j.comments || [];
    state.activity = j.activity || [];
    state.settings = j.settings || null;
    state.me = j.me || state.me;
    if (j.chat_counts && typeof j.chat_counts === 'object') state.chat.counts = j.chat_counts;
    if (j.chat_ttl_days) state.chat.ttlDays = j.chat_ttl_days;
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
    if (f.milestone === '__none__') list = list.filter((t) => !taskMilestone(t));
    else if (f.milestone) list = list.filter((t) => taskMilestone(t).toLowerCase() === f.milestone.toLowerCase());
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
    fillMilestoneFilter();
    renderCounts();
    renderBoard();
    if (state.view === 'list') renderListView();
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
    const urgent = live.filter((t) => t.status !== 'done' && t.priority === 'high').length;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const weekMs = d.getTime() - ((d.getDay() + 6) % 7) * 86400000;
    const doneWeek = state.tasks.filter((t) => t.completed_ts && t.completed_ts * 1000 >= weekMs).length;

    /* Temps moyen de résolution : tâches terminées au cours des 30 derniers jours. */
    const sinceS = Date.now() / 1000 - 30 * 86400;
    const resols = state.tasks
      .filter((t) => t.completed_ts && t.created_ts && t.completed_ts >= sinceS)
      .map((t) => t.completed_ts - t.created_ts)
      .filter((s) => s >= 0);
    const avg = resols.length ? resols.reduce((a, b) => a + b, 0) / resols.length : null;

    box.textContent = '';
    const parts = [
      [el('b', '', String(open)), el('span', '', open === 1 ? ' ouverte' : ' ouvertes')]
    ];
    if (late > 0) parts.push([el('b', 'late', String(late)), el('span', '', ' en retard')]);
    if (urgent > 0) parts.push([el('b', 'urgent', String(urgent)), el('span', '', urgent === 1 ? ' urgente' : ' urgentes')]);
    parts.push([
      el('b', '', String(doneWeek)),
      el('span', '', doneWeek === 1 ? ' terminée cette semaine' : ' terminées cette semaine')
    ]);
    if (avg !== null) parts.push([el('b', '', fmtDur(avg)), el('span', '', ' de résolution moy.')]);
    parts.forEach((pair, i) => {
      if (i > 0) box.appendChild(el('span', 'dot', '·'));
      box.appendChild(pair[0]);
      box.appendChild(pair[1]);
    });
  }

  function fillMilestoneFilter() {
    const sel = $('#f-milestone');
    if (!sel) return;
    const cur = state.filters.milestone;
    while (sel.options.length > 2) sel.remove(2);
    for (const ms of milestonesOf(state.tasks.filter((t) => !t.archived_ts))) {
      const o = el('option', '', ms);
      o.value = ms;
      sel.appendChild(o);
    }
    const has = Array.from(sel.options).some((o) => o.value === cur);
    sel.value = has ? cur : '';
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
    if (meta.emoji) s.appendChild(el('span', 'lchip-emoji', meta.emoji));
    else s.appendChild(el('span', 'lchip-dot'));
    s.appendChild(el('span', '', meta.label));
    return s;
  }

  function milestoneChip(ms) {
    const s = el('span', 'mchip', '🏷️ ' + ms);
    s.title = 'Version / jalon : ' + ms;
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
    const cCount = chatCountOf(t.id);
    const ck = ckProgress(t.id);
    const ms = taskMilestone(t);
    if (due || cCount > 0 || ck.total > 0 || ms || t.archived_ts) {
      const flags = el('div', 'task-flags');
      if (due) {
        const f = el('span', 'due ' + due.cls);
        f.appendChild(svg(ICONS.cal, 12));
        f.appendChild(el('span', '', due.label));
        flags.appendChild(f);
      }
      if (ck.total > 0) {
        const ckb = el('span', 'due ck' + (ck.done >= ck.total ? ' full' : ''));
        ckb.appendChild(svg(ICONS.check, 12));
        ckb.appendChild(el('span', '', ck.done + '/' + ck.total));
        ckb.title = 'Checklist : ' + ck.done + ' sur ' + ck.total + ' terminée(s)';
        flags.appendChild(ckb);
      }
      if (cCount > 0) {
        const cb = el('span', 'due cm');
        cb.appendChild(svg(ICONS.comment, 12));
        cb.appendChild(el('span', '', String(cCount)));
        cb.title = cCount + ' message(s) dans la discussion';
        flags.appendChild(cb);
      }
      if (ms) flags.appendChild(milestoneChip(ms));
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

  function renderCurrentView() {
    renderBoard();
    if (state.view === 'list') renderListView();
  }

  /* ── Vue liste (façon tableur) ──────────────────────────────────────────── */

  function lvStatusSelect(t) {
    const sel = el('select', 'lv-status');
    sel.setAttribute('aria-label', 'Statut de la tâche');
    for (const s of STATUSES) {
      const o = el('option', '', s.label);
      o.value = s.key;
      sel.appendChild(o);
    }
    sel.value = t.status;
    sel.disabled = !!t.archived_ts;
    sel.addEventListener('click', (ev) => ev.stopPropagation());
    sel.addEventListener('change', () => {
      if (sel.value !== t.status) doStatus(t.id, sel.value);
    });
    return sel;
  }

  function renderListView() {
    const wrap = $('#listview');
    if (!wrap) return;
    const list = sortList(visibleTasks());
    wrap.textContent = '';

    const table = el('table', 'lv-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Tâche', 'Statut', 'Priorité', 'Étiquettes', 'Version', 'Échéance', 'Checklist', '💬', 'Responsable', '']) {
      hr.appendChild(el('th', '', h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    if (list.length === 0) {
      const tr = el('tr', 'lv-empty');
      const td = el('td', '', state.filters.archived
        ? 'Aucune tâche archivée.'
        : 'Aucune tâche — clique sur « Nouvelle tâche » ou appuie sur N.');
      td.colSpan = 10;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    for (const t of list) {
      const tr = el('tr', 'lv-row' + (t.archived_ts ? ' arch' : ''));
      tr.dataset.id = String(t.id);

      const tdTitle = el('td', 'lv-title');
      const tMain = el('div', 'lv-tmain');
      tMain.appendChild(el('span', 'task-num', '#' + t.id));
      tMain.appendChild(el('b', '', t.title));
      if (t.pinned) tMain.appendChild(svg(ICONS.pin, 11));
      tdTitle.appendChild(tMain);
      if (t.description) {
        tdTitle.appendChild(el('div', 'lv-desc', t.description.split(/\r?\n/)[0]));
      }
      tr.appendChild(tdTitle);

      const tdStatus = el('td');
      tdStatus.appendChild(lvStatusSelect(t));
      tr.appendChild(tdStatus);

      tr.appendChild(el('td', 'lv-prio')).appendChild(el('span', 'prio prio-' + t.priority, PRIORITY[t.priority] || 'Normale'));

      const labels = labelKeys(t);
      const tdLabels = el('td', 'lv-labels');
      for (const k of labels.slice(0, 2)) {
        const c = labelChip(k);
        if (c) tdLabels.appendChild(c);
      }
      if (labels.length > 2) tdLabels.appendChild(el('span', 'lv-more', '+' + (labels.length - 2)));
      tr.appendChild(tdLabels);

      const ms = taskMilestone(t);
      tr.appendChild(el('td', 'lv-ms')).appendChild(ms ? milestoneChip(ms) : document.createTextNode('—'));

      const due = dueInfo(t);
      const tdDue = el('td');
      if (due) {
        const f = el('span', 'due inline ' + due.cls);
        f.appendChild(svg(ICONS.cal, 11));
        f.appendChild(el('span', '', due.label));
        tdDue.appendChild(f);
      } else {
        tdDue.appendChild(el('span', 'lv-none', '—'));
      }
      tr.appendChild(tdDue);

      const ck = ckProgress(t.id);
      const tdCk = el('td', 'lv-ck');
      if (ck.total > 0) {
        tdCk.appendChild(el('span', 'lv-ckn' + (ck.done >= ck.total ? ' full' : ''), ck.done + '/' + ck.total));
        const bar = el('div', 'ck-progress mini');
        const fill = el('div', 'ck-bar');
        fill.style.width = Math.round((ck.done / ck.total) * 100) + '%';
        bar.appendChild(fill);
        tdCk.appendChild(bar);
      } else {
        tdCk.appendChild(el('span', 'lv-none', '—'));
      }
      tr.appendChild(tdCk);

      const cCount = chatCountOf(t.id);
      tr.appendChild(el('td', 'lv-cm', cCount > 0 ? String(cCount) : '—'));

      const tdWho = el('td', 'lv-who');
      if (t.assignee_id) {
        const p = personById(t.assignee_id);
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = avatarUrl(p) || defaultAvatar(t.assignee_id);
        img.onerror = () => { img.style.visibility = 'hidden'; };
        tdWho.appendChild(img);
        tdWho.appendChild(el('span', '', p && p.name ? p.name : 'ID ' + t.assignee_id));
      } else {
        tdWho.appendChild(el('span', 'lv-none', '—'));
      }
      tr.appendChild(tdWho);

      const tdAct = el('td', 'lv-act');
      const eb = el('button', 'tbtn');
      eb.type = 'button';
      eb.title = 'Modifier la tâche';
      eb.setAttribute('aria-label', 'Modifier la tâche');
      eb.appendChild(svg(ICONS.pencil, 13));
      eb.dataset.act = 'edit';
      eb.dataset.id = String(t.id);
      tdAct.appendChild(eb);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    tbody.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act="edit"]');
      if (btn) {
        const id = parseInt(btn.dataset.id, 10);
        const t = state.tasks.find((x) => x.id === id);
        if (t) openTaskDialog(t);
        return;
      }
      const row = ev.target.closest('.lv-row[data-id]');
      if (row) {
        const t = state.tasks.find((x) => x.id === parseInt(row.dataset.id, 10));
        if (t) openDetail(t);
      }
    });
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
    const msInput = $('#f-milestone-input');
    if (msInput) msInput.value = task ? taskMilestone(task) : '';
    fillMilestoneDatalist();
    fillAssigneesDialog(task ? (task.assignee_id || '') : '');
    buildLabelPicks(editingLabels);
    $('#form-task-error').hidden = true;
    dlgTask.showModal();
    $('#f-title').focus();
  }

  function fillMilestoneDatalist() {
    const dl = $('#milestone-datalist');
    if (!dl) return;
    dl.textContent = '';
    for (const ms of milestonesOf(state.tasks)) {
      const o = el('option');
      o.value = ms;
      dl.appendChild(o);
    }
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
        due: $('#f-due') ? $('#f-due').value : '',
        milestone: $('#f-milestone-input') ? $('#f-milestone-input').value.trim() : ''
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
      descEl.appendChild(renderRich(t.description));
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
    const ms = taskMilestone(t);
    if (ms) meta.appendChild(metaRow('Version', milestoneChip(ms)));
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

    /* Discussion — le contenu est géré à part (section Discussion ci-dessous) :
       on ne touche ici qu'au compteur, pour préserver le défilement. */
    renderChatMeta();

    renderChecklist(t);
  }

  function renderChecklist(t) {
    const ul = $('#detail-checklist');
    if (!ul) return;
    const items = checklistOf(t.id);
    const doneN = items.filter((c) => c.done).length;
    const num = $('#detail-cknum');
    if (num) num.textContent = items.length ? '(' + doneN + '/' + items.length + ')' : '';
    const prog = $('#detail-ckprogress');
    if (prog) {
      if (items.length) {
        prog.hidden = false;
        const bar = $('#detail-ckbar');
        if (bar) bar.style.width = Math.round((doneN / items.length) * 100) + '%';
      } else {
        prog.hidden = true;
      }
    }
    ul.textContent = '';
    if (items.length === 0) {
      ul.appendChild(el('li', 'ck-empty', 'Aucune sous-tâche — découpe le travail si besoin.'));
      return;
    }
    for (const c of items) {
      const li = el('li', 'ck-item' + (c.done ? ' done' : ''));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!c.done;
      cb.setAttribute('aria-label', c.body);
      cb.addEventListener('change', async () => {
        const j = await apiAction('checklist.toggle', { item_id: c.id, done: cb.checked });
        if (!j.ok) {
          toast(j.message || 'Erreur', 'error');
          cb.checked = !cb.checked;
          return;
        }
        refresh().catch(() => {});
      });
      li.appendChild(cb);
      li.appendChild(el('span', 'ck-body', c.body));
      const rm = el('button', 'ck-del');
      rm.type = 'button';
      rm.title = 'Retirer cette sous-tâche';
      rm.setAttribute('aria-label', 'Retirer cette sous-tâche');
      rm.appendChild(svg(ICONS.trash, 12));
      rm.addEventListener('click', async () => {
        const j = await apiAction('checklist.delete', { item_id: c.id });
        if (!j.ok) {
          toast(j.message || 'Erreur', 'error');
          return;
        }
        refresh().catch(() => {});
      });
      li.appendChild(rm);
      ul.appendChild(li);
    }
  }

  function openDetail(t) {
    if (!dlgDetail) return;
    state.detailId = t.id;
    /* showModal d'abord : renderDetail ne remplit que si le dialogue est ouvert */
    dlgDetail.showModal();
    renderDetail();
    loadChat(t.id);
  }

  /* ── Discussion de tâche (style Discord) ───────────────────────────── */

  const chatScroll = $('#chat-scroll');
  const chatChips = $('#chat-chips');
  const chatWrap = $('#chat-wrap');
  const chatNewPill = $('#chat-newpill');
  const formChat = $('#form-chat');
  const fChat = $('#f-chat');
  const fChatFiles = $('#f-chat-files');
  const btnChatAttach = $('#btn-chat-attach');
  const btnChatSend = $('#btn-chat-send');

  const CHAT_COLORS = ['#E5598C', '#F2A33C', '#3BA55D', '#3E9CD9', '#8B5CF6', '#EB6A4B', '#4FA8C7', '#C878C9'];
  const CHAT_GROUP_SECONDS = 420; /* Discord : regroupe les messages rapprochés d'un même auteur */

  function chatCountOf(taskId) {
    return (state.chat.counts && state.chat.counts[String(taskId)]) || 0;
  }

  function chatColor(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return CHAT_COLORS[h % CHAT_COLORS.length];
  }

  function fmtSize(n) {
    if (n === null || n === undefined) return '';
    const u = ['o', 'Ko', 'Mo', 'Go'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i ? (v >= 10 || i > 1 ? Math.round(v) : v.toFixed(1)) : v) + ' ' + u[i];
  }

  function chatDayLabel(ts) {
    const t = startOfDayMs(ts * 1000);
    const today = startOfDayMs(Date.now());
    if (t === today) return "Aujourd'hui";
    if (t === today - 86400000) return 'Hier';
    try {
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
        .format(new Date(ts * 1000));
    } catch (e) { return fmtDay(ts); }
  }

  function chatFullTime(ts) {
    try {
      const today = startOfDayMs(Date.now());
      const t = startOfDayMs(ts * 1000);
      const hm = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
      if (t === today) return "Aujourd'hui à " + hm;
      if (t === today - 86400000) return 'Hier à ' + hm;
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        .format(new Date(ts * 1000)) + ' à ' + hm;
    } catch (e) { return fmtDate(ts); }
  }

  function chatFileUrl(att, dl) {
    return BASE + '/file.php?id=' + encodeURIComponent(att.id) + (dl ? '&dl=1' : '');
  }

  function chatAttExpired(att) {
    return !!att.expires && att.expires > 0 && att.expires * 1000 < Date.now();
  }

  function isImageAtt(att) {
    return att.mime
      ? (att.mime.indexOf('image/') === 0 && att.ext !== 'svg')
      : /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(att.name || '');
  }

  function isVideoAtt(att) {
    return att.mime ? att.mime.indexOf('video/') === 0 : /\.(mp4|webm|mov|m4v|mkv)$/i.test(att.name || '');
  }

  function isAudioAtt(att) {
    return att.mime ? att.mime.indexOf('audio/') === 0 : /\.(mp3|ogg|wav|m4a|flac)$/i.test(att.name || '');
  }

  function renderChatMeta() {
    if (state.chat.taskId === null) return;
    const numEl = $('#detail-chatnum');
    if (numEl) numEl.textContent = '(' + chatCountOf(state.chat.taskId) + ')';
  }

  function chatNearBottom() {
    if (!chatScroll) return true;
    return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 90;
  }

  function chatScrollBottom() {
    if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  function loadChat(taskId) {
    const tid = Number(taskId);
    if (!chatScroll || !tid) return;
    state.chat.taskId = tid;
    state.chat.pending = [];
    state.chat.editId = null;
    state.chat.lastId = 0;
    if (chatNewPill) chatNewPill.hidden = true;
    renderChatChips();
    chatScroll.textContent = '';
    chatScroll.appendChild(el('div', 'chat-loading', 'Chargement de la discussion…'));

    fetch(BASE + '/api.php?action=chat.list&task_id=' + tid, {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    })
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.ok) throw new Error(j && j.message ? j.message : 'erreur');
        if (state.chat.taskId !== tid) return; /* l'utilisateur a changé de tâche entre-temps */
        state.chat.messages = j.messages || [];
        state.chat.lastId = state.chat.messages.reduce((mx, m) => Math.max(mx, m.id), 0);
        state.chat.counts[String(tid)] = j.count || 0;
        if (j.ttl_days) state.chat.ttlDays = j.ttl_days;
        renderChatMeta();
        renderChat(true);
      })
      .catch(() => {
        if (state.chat.taskId === tid && chatScroll) {
          chatScroll.textContent = '';
          chatScroll.appendChild(el('div', 'chat-loading', 'Discussion indisponible — referme et rouvre la tâche.'));
        }
      });
  }

  /** Fusionne un message (nouveau ou mis à jour) dans la liste locale. */
  function chatApplyMessage(m) {
    if (!m || !m.id) return false;
    const idx = state.chat.messages.findIndex((x) => x.id === m.id);
    if (idx >= 0) {
      state.chat.messages[idx] = m;
      return true;
    }
    state.chat.messages.push(m);
    if (m.id > state.chat.lastId) state.chat.lastId = m.id;
    return true;
  }

  function renderChat(scrollDown) {
    if (!chatScroll || state.chat.taskId === null) return;
    const tid = state.chat.taskId;
    const msgs = state.chat.messages.filter((m) => m.task_id === tid);
    const stick = scrollDown === true || chatNearBottom();
    const prevTop = chatScroll.scrollTop;
    const prevHeight = chatScroll.scrollHeight;

    chatScroll.textContent = '';

    if (msgs.length === 0) {
      const empty = el('div', 'chat-empty');
      empty.appendChild(el('div', 'chat-empty-title', 'Aucun message pour l\'instant'));
      empty.appendChild(el('div', 'chat-empty-sub', 'Lance la discussion : écris, colle ou dépose des fichiers.'));
      chatScroll.appendChild(empty);
    }

    let prev = null;
    for (const m of msgs) {
      if (!prev || startOfDayMs((m.ts || 0) * 1000) !== startOfDayMs((prev.ts || 0) * 1000)) {
        chatScroll.appendChild(el('div', 'chat-day', chatDayLabel(m.ts || 0)));
        prev = null;
      }
      const grouped = !!(prev
        && !m.deleted && !prev.deleted
        && prev.author_id === m.author_id
        && Math.abs((m.ts || 0) - (prev.ts || 0)) < CHAT_GROUP_SECONDS);
      chatScroll.appendChild(chatMsgNode(m, grouped));
      prev = m;
    }

    if (stick) {
      chatScrollBottom();
      if (chatNewPill) chatNewPill.hidden = true;
    } else {
      /* préserve la position après une édition / suppression */
      chatScroll.scrollTop = prevTop + (chatScroll.scrollHeight - prevHeight);
    }
  }

  function chatMsgNode(m, grouped) {
    const wrap = el('div', 'chat-msg' + (grouped ? ' grouped' : '') + (m.deleted ? ' deleted' : ''));
    if (m.ts) wrap.title = chatFullTime(m.ts);

    /* Actions rapides au survol (copier / modifier / supprimer) */
    const tools = el('div', 'chat-tools');
    if (!m.deleted && m.body) {
      const cp = el('button', 'chat-tool');
      cp.type = 'button';
      cp.title = 'Copier le texte';
      cp.setAttribute('aria-label', 'Copier le texte du message');
      cp.appendChild(svg(ICONS.copy, 13));
      cp.addEventListener('click', () => {
        copyText(m.body).then((ok) => toast(ok ? 'Texte copié' : 'Copie impossible', ok ? 'success' : 'error'));
      });
      tools.appendChild(cp);
    }
    if (!m.deleted && m.author_id === state.me.id) {
      const ed = el('button', 'chat-tool');
      ed.type = 'button';
      ed.title = 'Modifier';
      ed.setAttribute('aria-label', 'Modifier le message');
      ed.appendChild(svg(ICONS.pencil, 13));
      ed.addEventListener('click', () => {
        state.chat.editId = m.id;
        renderChat(false);
      });
      tools.appendChild(ed);
    }
    if (!m.deleted && (m.author_id === state.me.id || state.me.can_manage)) {
      const rm = el('button', 'chat-tool danger');
      rm.type = 'button';
      rm.title = 'Supprimer';
      rm.setAttribute('aria-label', 'Supprimer le message');
      rm.appendChild(svg(ICONS.trash, 13));
      rm.addEventListener('click', () => chatDelete(m.id));
      tools.appendChild(rm);
    }
    if (tools.childElementCount > 0) wrap.appendChild(tools);

    const img = el('img', 'chat-avatar');
    img.alt = '';
    img.loading = 'lazy';
    img.src = avatarUrl(personById(m.author_id)) || defaultAvatar(m.author_id);
    img.onerror = () => { img.style.visibility = 'hidden'; };
    wrap.appendChild(img);

    const main = el('div', 'chat-main');

    if (!grouped) {
      const head = el('div', 'chat-head');
      const name = el('span', 'chat-name', m.author_name || 'Discord');
      name.style.color = chatColor(m.author_id);
      head.appendChild(name);
      if (m.edited_ts) head.appendChild(el('span', 'chat-edited', '(modifié)'));
      if (m.ts) head.appendChild(el('span', 'chat-time', chatFullTime(m.ts)));
      main.appendChild(head);
    }

    if (m.deleted) {
      main.appendChild(el('div', 'chat-text chat-deleted', 'Message supprimé'));
    } else if (state.chat.editId === m.id) {
      main.appendChild(chatEditForm(m));
    } else {
      if (m.body) {
        const txt = el('div', 'chat-text');
        txt.appendChild(renderRich(m.body));
        if (m.edited_ts && grouped) txt.appendChild(el('span', 'chat-edited', ' (modifié)'));
        main.appendChild(txt);
      }
      if (m.attachments && m.attachments.length > 0) {
        main.appendChild(chatAttsNode(m.attachments));
      }
      if (!m.body && (!m.attachments || m.attachments.length === 0)) {
        main.appendChild(el('div', 'chat-text chat-deleted', '—'));
      }
    }

    wrap.appendChild(main);
    return wrap;
  }

  function chatEditForm(m) {
    const ef = el('form', 'chat-editform');
    const ta = el('textarea', 'chat-edit');
    ta.value = m.body || '';
    ta.rows = Math.min(6, String(m.body || '').split('\n').length + 1);
    ta.setAttribute('aria-label', 'Modifier le message');
    const row = el('div', 'chat-editrow');
    const save = el('button', 'btn primary small', 'Enregistrer');
    save.type = 'submit';
    const cancel = el('button', 'btn ghost small', 'Annuler');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      state.chat.editId = null;
      renderChat(false);
    });
    row.appendChild(save);
    row.appendChild(cancel);
    ef.appendChild(ta);
    ef.appendChild(row);
    ef.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = ta.value.trim();
      if (!body) return;
      const j = await apiAction('chat.edit', { message_id: m.id, body: body });
      if (!j || !j.ok) {
        toast((j && j.message) || 'Modification impossible', 'error');
        return;
      }
      state.chat.editId = null;
      chatApplyMessage(j.message);
      renderChat(false);
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        ef.requestSubmit();
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        state.chat.editId = null;
        renderChat(false);
      }
    });
    setTimeout(() => {
      try { ta.focus(); ta.selectionStart = ta.value.length; } catch (e) { /* ignore */ }
    }, 0);
    return ef;
  }

  function chatAttsNode(atts) {
    const box = el('div', 'chat-atts');
    for (const att of atts) {
      if (chatAttExpired(att)) {
        box.appendChild(chatFileCard(att, true));
        continue;
      }
      if (isImageAtt(att)) {
        const a = el('a', 'chat-imglink');
        a.href = chatFileUrl(att, false);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = (att.name || 'Image') + ' — cliquer pour agrandir';
        const im = el('img', 'chat-att-img');
        im.alt = att.name || 'Image partagée';
        im.loading = 'lazy';
        im.src = chatFileUrl(att, false);
        a.appendChild(im);
        box.appendChild(a);
      } else if (isVideoAtt(att)) {
        const v = el('video', 'chat-att-video');
        v.controls = true;
        v.preload = 'metadata';
        v.src = chatFileUrl(att, false);
        box.appendChild(v);
      } else if (isAudioAtt(att)) {
        const au = el('audio', 'chat-att-audio');
        au.controls = true;
        au.preload = 'metadata';
        au.src = chatFileUrl(att, false);
        box.appendChild(au);
      } else {
        box.appendChild(chatFileCard(att, false));
      }
    }
    return box;
  }

  function chatFileCard(att, expired) {
    const a = el('a', 'chat-filecard' + (expired ? ' expired' : ''));
    if (expired) {
      a.href = '#';
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        toast('Fichier expiré — les fichiers sont conservés ' + (state.chat.ttlDays || 30) + ' jours', 'error');
      });
    } else {
      a.href = chatFileUrl(att, true);
      a.title = 'Télécharger ' + (att.name || 'fichier');
    }
    const ico = el('span', 'chat-fc-ico', (att.ext || '?').toUpperCase().slice(0, 4));
    a.appendChild(ico);
    const meta = el('span', 'chat-fc-meta');
    meta.appendChild(el('span', 'chat-fc-name', att.name || 'fichier'));
    meta.appendChild(el('span', 'chat-fc-size', expired
      ? 'Fichier expiré — conservé ' + (state.chat.ttlDays || 30) + ' jours'
      : [fmtSize(att.size), att.width && att.height ? att.width + '×' + att.height : ''].filter(Boolean).join(' · ')));
    a.appendChild(meta);
    if (!expired) {
      const dl = el('span', 'chat-fc-dl');
      dl.appendChild(svg(ICONS.download, 15));
      a.appendChild(dl);
    }
    return a;
  }

  async function chatPoll() {
    if (!chatScroll || state.chat.taskId === null || state.chat.sending || state.chat.editId !== null) return;
    const tid = state.chat.taskId;
    const qs = BASE + '/api.php?action=chat.list&task_id=' + tid
      + '&after=' + state.chat.lastId
      + (chatPollTs > 0 ? '&changed_since=' + chatPollTs : '');
    const reqTs = Math.floor(Date.now() / 1000);
    const r = await fetch(qs, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const j = await r.json().catch(() => null);
    chatPollTs = reqTs;
    if (!j || !j.ok || state.chat.taskId !== tid) return;
    let added = 0;
    let updated = 0;
    for (const m of (j.messages || [])) {
      const idx = state.chat.messages.findIndex((x) => x.id === m.id);
      if (idx >= 0) { state.chat.messages[idx] = m; updated++; }
      else if (chatApplyMessage(m)) added++;
    }
    if (added || updated) {
      state.chat.counts[String(tid)] = j.count || 0;
      renderChatMeta();
      const wasNear = chatNearBottom();
      renderChat(wasNear);
      if (added && !wasNear && chatNewPill) chatNewPill.hidden = false;
      if (added) renderCurrentView(); /* badges des cartes */
    }
  }

  let chatPollTs = 0;

  async function chatSend() {
    if (!state.chat.taskId || state.chat.sending || !formChat) return;
    const body = fChat ? fChat.value.trim() : '';
    const files = state.chat.pending.slice();
    if (!body && files.length === 0) return;

    state.chat.sending = true;
    if (btnChatSend) btnChatSend.disabled = true;
    try {
      let j = null;
      if (files.length > 0) {
        const fd = new FormData();
        fd.append('action', 'chat.upload');
        fd.append('id', String(state.chat.taskId));
        fd.append('body', body);
        for (const f of files) fd.append('files[]', f, f.name);
        const r = await fetch(BASE + '/api.php', {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrf(), Accept: 'application/json' },
          body: fd,
          cache: 'no-store'
        });
        j = await r.json().catch(() => null);
      } else {
        j = await apiAction('chat.send', { id: state.chat.taskId, body: body });
      }
      if (!j || !j.ok) {
        toast((j && j.message) || 'Envoi impossible', 'error');
        return;
      }
      if (fChat) { fChat.value = ''; chatAutoGrow(); }
      state.chat.pending = [];
      renderChatChips();
      chatApplyMessage(j.message);
      state.chat.counts[String(state.chat.taskId)] = j.count || 0;
      renderChatMeta();
      renderChat(true);
      renderCurrentView();
    } catch (e) {
      toast('Envoi impossible — réessaie', 'error');
    } finally {
      state.chat.sending = false;
      if (btnChatSend) btnChatSend.disabled = false;
    }
  }

  async function chatDelete(mid) {
    if (!window.confirm('Supprimer ce message ?')) return;
    const j = await apiAction('chat.delete', { message_id: mid });
    if (!j || !j.ok) {
      toast((j && j.message) || 'Suppression impossible', 'error');
      return;
    }
    const idx = state.chat.messages.findIndex((x) => x.id === mid);
    if (idx >= 0) {
      state.chat.messages[idx] = Object.assign({}, state.chat.messages[idx], {
        deleted: true, body: '', attachments: []
      });
    }
    if (state.chat.taskId !== null) {
      state.chat.counts[String(state.chat.taskId)] = j.count || 0;
    }
    renderChatMeta();
    renderChat(false);
    renderCurrentView();
  }

  function chatStageFiles(fileList) {
    for (const f of Array.from(fileList || [])) {
      if (state.chat.pending.length >= 6) {
        toast('6 fichiers maximum par message', 'error');
        break;
      }
      if (f.size > 10 * 1024 * 1024) {
        toast('« ' + f.name + ' » dépasse 10 Mo', 'error');
        continue;
      }
      state.chat.pending.push(f);
    }
    renderChatChips();
  }

  function renderChatChips() {
    if (!chatChips) return;
    chatChips.textContent = '';
    chatChips.hidden = state.chat.pending.length === 0;
    state.chat.pending.forEach((f, i) => {
      const chip = el('span', 'chat-chip');
      chip.appendChild(el('span', 'chat-chip-name', f.name));
      chip.appendChild(el('span', 'chat-chip-size', fmtSize(f.size)));
      const rm = el('button', 'chat-chip-rm');
      rm.type = 'button';
      rm.title = 'Retirer ce fichier';
      rm.setAttribute('aria-label', 'Retirer ' + f.name);
      rm.appendChild(svg(ICONS.trash, 12));
      rm.addEventListener('click', () => {
        state.chat.pending.splice(i, 1);
        renderChatChips();
      });
      chip.appendChild(rm);
      chatChips.appendChild(chip);
    });
  }

  function chatAutoGrow() {
    if (!fChat) return;
    fChat.style.height = 'auto';
    fChat.style.height = Math.min(fChat.scrollHeight, 132) + 'px';
  }

  if (formChat && fChat) {
    formChat.addEventListener('submit', (ev) => {
      ev.preventDefault();
      chatSend();
    });
    fChat.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        formChat.requestSubmit();
      }
    });
    fChat.addEventListener('input', chatAutoGrow);
    fChat.addEventListener('paste', (ev) => {
      const files = ev.clipboardData && ev.clipboardData.files;
      if (files && files.length > 0) {
        ev.preventDefault();
        chatStageFiles(files);
        toast('Fichier collé — vérifie puis clique Envoyer', 'success');
      }
    });
  }

  if (btnChatAttach && fChatFiles) {
    btnChatAttach.addEventListener('click', () => fChatFiles.click());
    fChatFiles.addEventListener('change', () => {
      chatStageFiles(fChatFiles.files);
      fChatFiles.value = '';
    });
  }

  if (chatWrap) {
    let dragDepth = 0;
    const hasFiles = (ev) => !!(ev.dataTransfer && Array.from(ev.dataTransfer.types || []).indexOf('Files') !== -1);
    chatWrap.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragDepth++;
      chatWrap.classList.add('dragging');
    });
    chatWrap.addEventListener('dragover', (ev) => {
      if (dragDepth > 0) ev.preventDefault();
    });
    chatWrap.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) chatWrap.classList.remove('dragging');
    });
    chatWrap.addEventListener('drop', (ev) => {
      dragDepth = 0;
      chatWrap.classList.remove('dragging');
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length > 0) {
        ev.preventDefault();
        chatStageFiles(ev.dataTransfer.files);
        if (fChat) fChat.focus();
      }
    });
  }

  if (chatScroll) {
    chatScroll.addEventListener('scroll', () => {
      if (chatNewPill && chatNearBottom()) chatNewPill.hidden = true;
    });
  }

  if (chatNewPill) {
    chatNewPill.addEventListener('click', () => {
      chatNewPill.hidden = true;
      chatScrollBottom();
    });
  }

  /* ── Sous-tâches (checklist) ────────────────────────────────────────────── */

  const formChecklist = $('#form-checklist');
  if (formChecklist) {
    formChecklist.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!state.detailId) return;
      const input = $('#f-checklist');
      const body = input.value.trim();
      if (!body) return;
      const j = await apiAction('checklist.add', { id: state.detailId, body: body });
      if (!j.ok) {
        toast(j.message || 'Ajout impossible', 'error');
        return;
      }
      input.value = '';
      refresh().catch(() => {});
    });

    const ci = $('#f-checklist');
    if (ci) {
      ci.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          formChecklist.requestSubmit();
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
    const ev = cfg && cfg.events ? cfg.events : { create: true, assign: true, start: true, done: true };
    $('#s-wh-create').checked = ev.create !== false;
    $('#s-wh-assign').checked = ev.assign !== false;
    const startEl = $('#s-wh-start');
    if (startEl) startEl.checked = ev.start !== false;
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
            start: $('#s-wh-start') ? $('#s-wh-start').checked : true,
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
      renderCurrentView();
    }, 150));
    fSearch.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        fSearch.value = '';
        state.filters.q = '';
        renderCurrentView();
        fSearch.blur();
      }
    });
  }

  const fPrio = $('#f-prio');
  if (fPrio) fPrio.addEventListener('change', () => { state.filters.prio = fPrio.value; renderCurrentView(); });

  const fAssignee = $('#f-assignee');
  if (fAssignee) fAssignee.addEventListener('change', () => { state.filters.assignee = fAssignee.value; renderCurrentView(); });

  const fMilestone = $('#f-milestone');
  if (fMilestone) fMilestone.addEventListener('change', () => { state.filters.milestone = fMilestone.value; renderCurrentView(); });

  const fSort = $('#f-sort');
  if (fSort) fSort.addEventListener('change', () => { state.filters.sort = fSort.value; renderCurrentView(); });

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

  const btnView = $('#btn-view');
  if (btnView) {
    try { state.view = localStorage.getItem('tfh-task-view') === 'list' ? 'list' : 'board'; } catch (e) { state.view = 'board'; }
    const applyView = () => {
      const isList = state.view === 'list';
      const b = $('#board');
      const l = $('#listview');
      if (b) b.hidden = isList;
      if (l) l.hidden = !isList;
      btnView.classList.toggle('active', isList);
      btnView.setAttribute('aria-pressed', isList ? 'true' : 'false');
      const lbl = $('#btn-view-label');
      if (lbl) lbl.textContent = isList ? 'Vue tableau' : 'Vue liste';
      if (isList) renderListView();
    };
    applyView();
    btnView.addEventListener('click', () => {
      state.view = state.view === 'list' ? 'board' : 'list';
      try { localStorage.setItem('tfh-task-view', state.view === 'list' ? 'list' : 'board'); } catch (e) { /* ignore */ }
      applyView();
    });
  }

  const btnArchive = $('#btn-archive');
  if (btnArchive) {
    btnArchive.addEventListener('click', () => {
      state.filters.archived = !state.filters.archived;
      btnArchive.classList.toggle('active', state.filters.archived);
      const lbl = $('#btn-archive-label');
      if (lbl) lbl.textContent = state.filters.archived ? 'Retour au tableau' : 'Archive';
      renderCurrentView();
    });
  }

  function exportCsv() {
    const rows = [[
      'ID', 'Titre', 'Statut', 'Priorité', 'Étiquettes', 'Version', 'Responsable', 'Échéance',
      'Créée par', 'Créée le', 'Terminée par', 'Terminée le', 'Archivée', 'Checklist', 'Description'
    ]];
    for (const t of state.tasks) {
      const p = t.assignee_id ? personById(t.assignee_id) : null;
      const ck = ckProgress(t.id);
      rows.push([
        t.id,
        t.title || '',
        (t.archived_ts ? 'Archivée — ' : '') + (STATUS_LABEL[t.status] || t.status),
        PRIORITY[t.priority] || 'Normale',
        labelKeys(t).map((k) => (LABELS[k] ? LABELS[k].label : k)).join(' + '),
        taskMilestone(t),
        p && p.name ? p.name : (t.assignee_id ? 'ID ' + t.assignee_id : ''),
        t.due_ts ? fmtDay(t.due_ts) : '',
        t.created_by_name || '',
        t.created_ts ? fmtDay(t.created_ts) : '',
        t.completed_by_name || '',
        t.completed_ts ? fmtDay(t.completed_ts) : '',
        t.archived_ts ? 'oui' : 'non',
        ck.total > 0 ? ck.done + '/' + ck.total : '',
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

  /* ── Patch notes / changelog ────────────────────────────────────────────── */

  const dlgChangelog = $('#dlg-changelog');

  function buildChangelog() {
    const msSel = $('#f-chg-milestone');
    const perSel = $('#f-chg-period');
    const ms = msSel ? msSel.value : '__all__';
    const period = perSel ? parseInt(perSel.value, 10) : 30;
    const nowS = Date.now() / 1000;
    let done = state.tasks.filter((t) => t.status === 'done' && t.completed_ts);
    if (period > 0) done = done.filter((t) => t.completed_ts >= nowS - period * 86400);
    if (ms === '__none__') done = done.filter((t) => !taskMilestone(t));
    else if (ms !== '__all__') done = done.filter((t) => taskMilestone(t).toLowerCase() === ms.toLowerCase());
    done = done.slice().sort((a, b) => (b.completed_ts || 0) - (a.completed_ts || 0));

    const groups = new Map();
    for (const t of done) {
      const g = taskMilestone(t) || 'Sans version';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }

    const dateStr = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date());
    const lines = ['# Patch Notes TheFrontHub — ' + dateStr, ''];
    lines.push('*' + done.length + ' ' + (done.length === 1 ? 'tâche terminée' : 'tâches terminées') + '*', '');
    for (const [g, arr] of groups) {
      lines.push('## ' + g, '');
      for (const t of arr) {
        const d = t.completed_ts
          ? new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' }).format(new Date(t.completed_ts * 1000))
          : '';
        const by = t.completed_by_name ? ' — *' + t.completed_by_name + '*' : '';
        const title = String(t.title || '').replace(/[*#]/g, '').trim();
        lines.push('- ✅ **' + title + '**' + by + (d ? ' · ' + d : ''));
      }
      lines.push('');
    }
    if (done.length === 0) lines.push('_Aucune tâche terminée sur cette période._', '');
    return lines.join('\n').trim() + '\n';
  }

  function renderChangelogPreview() {
    const p = $('#chg-preview');
    if (p) p.textContent = buildChangelog();
  }

  function openChangelog() {
    if (!dlgChangelog) return;
    const sel = $('#f-chg-milestone');
    if (sel) {
      const cur = sel.value || '__all__';
      sel.textContent = '';
      const all = el('option', '', 'Toutes les versions');
      all.value = '__all__';
      sel.appendChild(all);
      for (const m of milestonesOf(state.tasks)) {
        const o = el('option', '', m);
        o.value = m;
        sel.appendChild(o);
      }
      const none = el('option', '', '(sans version)');
      none.value = '__none__';
      sel.appendChild(none);
      const has = Array.from(sel.options).some((o) => o.value === cur);
      sel.value = has ? cur : '__all__';
    }
    renderChangelogPreview();
    dlgChangelog.showModal();
  }

  const btnChangelog = $('#btn-changelog');
  if (btnChangelog) btnChangelog.addEventListener('click', openChangelog);

  const fChgMs = $('#f-chg-milestone');
  if (fChgMs) fChgMs.addEventListener('change', renderChangelogPreview);

  const fChgPeriod = $('#f-chg-period');
  if (fChgPeriod) fChgPeriod.addEventListener('change', renderChangelogPreview);

  const btnChgCopy = $('#btn-chg-copy');
  if (btnChgCopy) {
    btnChgCopy.addEventListener('click', async () => {
      const ok = await copyText(buildChangelog());
      toast(ok ? 'Patch notes copiés — colle-les sur Discord ou le site !' : 'Copie impossible', ok ? 'success' : 'error');
    });
  }

  const btnChgDownload = $('#btn-chg-download');
  if (btnChgDownload) {
    btnChgDownload.addEventListener('click', () => {
      const blob = new Blob([buildChangelog()], { type: 'text/markdown;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'patch-notes-' + new Date().toISOString().slice(0, 10) + '.md';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
  }

  /* ── Raccourcis clavier ─────────────────────────────────────────────────── */

  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (anyDialogOpen()) return;
    if (ev.key === 'n' || ev.key === 'N' || ev.key === 'c' || ev.key === 'C') {
      ev.preventDefault();
      openTaskDialog(null);
    } else if (ev.key === '/') {
      ev.preventDefault();
      const s = $('#f-search');
      if (s) s.focus();
    } else if (ev.key === 'f' || ev.key === 'F') {
      ev.preventDefault();
      const s = $('#f-assignee');
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

  /* Discussion : nouveaux messages des autres membres (5 s, dialogue ouvert). */
  setInterval(() => {
    if (!document.hidden && dlgDetail && dlgDetail.open && state.detailId !== null) {
      chatPoll().catch(() => { /* silencieux */ });
    }
  }, 5000);

  /* ── Démarrage ──────────────────────────────────────────────────────────── */

  refresh().catch((e) => {
    if (e && e.message === 'reload') return;
    const detail = e && e.message ? ' (' + e.message + ')' : '';
    const bl = $('.board-loading');
    if (bl) bl.textContent = 'Impossible de charger le tableau' + detail + ' — recharge la page.';
    toast('Chargement impossible', 'error');
  });
})();
