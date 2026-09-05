/* ─────────────────────────────────────────────────────────────────────────────
   admin/assets/support.js — Sidebar catégories + Support 2026 (v1)
   Vanilla JS, sans dépendance. Complète app.js (Tâches) et chat.js (Chat équipe).

   Contenu :
   1. Routing de la sidebar (5 vues : tasks / chat / support / supchat / mails),
      drawer mobile (<900px) avec hamburger + backdrop.
   2. Vue « Tickets support »  : liste + fil + réponse + fermeture (+ poll 30 s).
   3. Vue « Chat support »     : conversations + fil en direct (poll 2,5 s).
   4. Vue « Mails »            : boîte support@thefronthub.com + réponse.
   5. Badges de la sidebar (tickets ouverts, unread chat, mails non lus).

   Endpoints backend : voir agent-ctx/CONTRAT-SUPPORT-2026.md (FIGÉ).
   ───────────────────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  const BOOT = window.TASK_BOOT;
  if (!BOOT) return; /* pages connexion / refusé : rien à faire */

  const BASE = BOOT.base || '';

  /* ── Mini helpers (dupliqués volontairement de app.js, ~25 lignes) ───────── */

  const $ = (sel, root) => (root || document).querySelector(sel);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

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

  function csrf() {
    const m = document.cookie.match(/(?:^|;\s*)tfh_task_csrf=([a-f0-9]{32})/);
    return m ? m[1] : (BOOT.csrf || '');
  }

  async function apiGet(action, params) {
    const qs = new URLSearchParams(Object.assign({ action }, params || {}));
    let r;
    try {
      r = await fetch(BASE + '/api.php?' + qs.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    } catch (e) {
      return { ok: false, error: 'network' };
    }
    if (r.status === 401) {
      window.location.reload();
      return { ok: false, error: 'reload' };
    }
    let j = null;
    try { j = await r.json(); } catch (e) { /* réponse non JSON */ }
    return j || { ok: false, error: 'bad_response' };
  }

  async function apiPost(action, payload) {
    let r;
    try {
      r = await fetch(BASE + '/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf(), Accept: 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
        cache: 'no-store'
      });
    } catch (e) {
      return { ok: false, error: 'network', message: 'Réseau indisponible — réessaie.' };
    }
    if (r.status === 401) {
      window.location.reload();
      return { ok: false, error: 'reload' };
    }
    let j = null;
    try { j = await r.json(); } catch (e) { /* réponse non JSON */ }
    return j || { ok: false, error: 'bad_response' };
  }

  /* ── Dates : accepte timestamp (s|ms), « YYYY-MM-DD HH:MM:SS », RFC822 ───── */

  function parseTs(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
    const s = String(v);
    let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (m) {
      return Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() / 1000);
    }
    const t = Date.parse(s);
    return isNaN(t) ? 0 : Math.floor(t / 1000);
  }

  function fmtHm(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
    } catch (e) { return ''; }
  }

  function fmtDayShort(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' }).format(new Date(ts * 1000));
    } catch (e) { return ''; }
  }

  function fmtDateTime(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      }).format(new Date(ts * 1000));
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
    return 'le ' + fmtDayShort(ts);
  }

  /* Heure courte pour les listes : HH:MM aujourd'hui, sinon jj/mm */
  function fmtListTime(ts) {
    if (!ts) return '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0);
    return d.getTime() === today.getTime() ? fmtHm(ts) : fmtDayShort(ts);
  }

  /* ── Avatars / puces / divers ────────────────────────────────────────────── */

  const FALLBACK_COLORS = ['#E5598C', '#F2A33C', '#3BA55D', '#3E9CD9', '#8B5CF6', '#EB6A4B', '#4FA8C7', '#C878C9'];

  function colorFor(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
  }

  function avatarNode(url, name, id, cls) {
    if (url) {
      const img = el('img', cls);
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        const f = el('span', cls + ' avatar-fallback', (name || '?').charAt(0).toUpperCase());
        f.style.background = colorFor(id || name);
        img.replaceWith(f);
      };
      return img;
    }
    const f = el('span', cls + ' avatar-fallback', (name || '?').charAt(0).toUpperCase());
    f.style.background = colorFor(id || name);
    return f;
  }

  const CATS = {
    bug:      { label: 'Bug',       emoji: '🐛' },
    question: { label: 'Question',  emoji: '❓' },
    paiement: { label: 'Paiement',  emoji: '💳' },
    compte:   { label: 'Compte',    emoji: '👤' },
    suggestion: { label: 'Suggestion', emoji: '💡' },
    autre:    { label: 'Autre',     emoji: '💬' }
  };

  function catNode(cat) {
    const c = CATS[String(cat || '').toLowerCase()] || { label: cat || 'Autre', emoji: '💬' };
    return el('span', 'chip chip-cat', c.emoji + ' ' + c.label);
  }

  const STATUS_LABEL = { open: 'Ouvert', answered: 'Répondu', closed: 'Fermé' };

  function statusNode(status) {
    const s = String(status || 'open');
    return el('span', 'tstatus st-' + s, STATUS_LABEL[s] || s);
  }

  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }

  /* Entrée = envoyer, Maj+Entrée = nouvelle ligne (comme le chat admin) */
  function wireComposer(ta, form) {
    if (!ta || !form) return;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
    ta.addEventListener('input', () => autoGrow(ta));
  }

  function setBadge(node, n) {
    if (!node) return;
    if (n > 0) {
      node.textContent = n > 99 ? '99+' : String(n);
      node.hidden = false;
    } else {
      node.hidden = true;
    }
  }

  /* ── Routing sidebar ─────────────────────────────────────────────────────── */

  const VIEWS = ['tasks', 'chat', 'support', 'supchat', 'mails'];
  const viewEls = {
    tasks: $('#view-tasks'),
    chat: $('#view-chat'),
    support: $('#view-support'),
    supchat: $('#view-supchat'),
    mails: $('#view-mails')
  };
  const sideEls = {
    tasks: $('#side-tasks'),
    chat: $('#side-chat'),
    support: $('#side-support'),
    supchat: $('#side-supchat'),
    mails: $('#side-mails')
  };
  const badgeEls = {
    support: $('#side-badge-support'),
    supchat: $('#side-badge-supchat'),
    mails: $('#side-badge-mails')
  };

  let currentView = 'tasks';

  const sidebar = $('#admin-sidebar');
  const backdrop = $('#side-backdrop');
  const burger = $('#btn-sidebar');

  function openDrawer() {
    if (!sidebar) return;
    sidebar.classList.add('open');
    if (backdrop) backdrop.hidden = false;
    if (burger) burger.setAttribute('aria-expanded', 'true');
  }

  function closeDrawer() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    if (backdrop) backdrop.hidden = true;
    if (burger) burger.setAttribute('aria-expanded', 'false');
  }

  function isDrawerOpen() {
    return !!(sidebar && sidebar.classList.contains('open'));
  }

  if (burger) {
    burger.addEventListener('click', () => {
      if (isDrawerOpen()) closeDrawer(); else openDrawer();
    });
  }
  if (backdrop) backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDrawerOpen()) closeDrawer();
  });

  function setView(name) {
    if (!viewEls[name]) return;
    VIEWS.forEach((v) => {
      if (viewEls[v]) viewEls[v].hidden = v !== name;
      const side = sideEls[v];
      if (side) {
        side.classList.toggle('is-active', v === name);
        if (v === name) side.setAttribute('aria-current', 'page');
        else side.removeAttribute('aria-current');
      }
    });
    currentView = name;
    closeDrawer();

    if (name === 'chat') {
      /* chat.js gère sa vue ; on réplique sa remise à zéro du badge non-lu
         (l'ancien bouton #tab-chat n'existe plus, chat.js est null-safe). */
      const badge = $('#gchat-unread');
      if (badge) badge.hidden = true;
      const inp = $('#f-gchat');
      if (inp) setTimeout(() => inp.focus(), 0);
    } else if (name === 'support') {
      Support.activate();
    } else if (name === 'supchat') {
      Supchat.activate();
    } else if (name === 'mails') {
      Mails.activate();
    }
    if (name !== 'supchat') Supchat.stopPoll();

    try { localStorage.setItem('tfh-admin-view', name); } catch (e) { /* ignore */ }
  }

  VIEWS.forEach((v) => {
    const side = sideEls[v];
    if (side) side.addEventListener('click', () => setView(v));
  });

  /* ── Badges de la sidebar (rafraîchis au boot + toutes les 30 s) ─────────── */

  function sumUnread(convs) {
    return (convs || []).reduce((n, c) => n + (Number(c.unread) || 0), 0);
  }

  async function refreshBadges() {
    if (document.hidden) return;
    const jobs = [];
    /* Tickets : sautés quand la vue est active (Support.refresh() s'en charge
       pour éviter un double GET — onListData met aussi à jour le badge). */
    if (currentView !== 'support') {
      jobs.push(apiGet('support.tickets').then((j) => {
        if (j && j.ok) {
          setBadge(badgeEls.support, Number(j.open_count) || 0);
          Support.onListData(j);
        }
      }).catch(() => {}));
    }
    jobs.push(apiGet('supchat.convs').then((j) => {
      if (j && j.ok) {
        Supchat.onConvsData(j.convs);
      }
    }).catch(() => {}));
    await Promise.all(jobs);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     Vue « Tickets support »
     ═══════════════════════════════════════════════════════════════════════════ */

  const Support = (() => {
    const listEl = $('#ticket-list');
    const paneEl = $('#view-support');
    const emptyEl = $('#support-empty');
    const threadEl = $('#support-thread');
    const msgsEl = $('#support-msgs');
    const formEl = $('#support-form');
    const taEl = $('#f-support-msg');

    const S = {
      loaded: false, loading: false,
      tickets: [], filter: 'open',
      openId: null, thread: null, messages: [],
      sending: false
    };

    if (!listEl) return { activate() {}, onListData() {}, refresh() {} };

    function visibleTickets() {
      const all = S.tickets.slice().sort((a, b) => parseTs(b.updated_at) - parseTs(a.updated_at));
      if (S.filter === 'closed') return all.filter((t) => t.status === 'closed');
      if (S.filter === 'open') return all.filter((t) => t.status !== 'closed');
      return all;
    }

    function renderList() {
      const items = visibleTickets();
      listEl.textContent = '';
      if (!items.length) {
        listEl.appendChild(el('div', 'split-empty',
          S.filter === 'closed' ? 'Aucun ticket fermé.' : 'Aucun ticket ouvert 🎉'));
        return;
      }
      for (const t of items) {
        const b = el('button', 'tkt' + (t.id === S.openId ? ' is-active' : ''));
        b.type = 'button';
        b.setAttribute('role', 'listitem');
        b.appendChild(avatarNode(t.user_avatar, t.user_name, t.user_id, 'tkt-avatar'));

        const main = el('div', 'tkt-main');
        const top = el('div', 'tkt-top');
        top.appendChild(el('span', 'tkt-subject', t.subject || '(sans sujet)'));
        top.appendChild(el('span', 'tkt-date', fmtRel(parseTs(t.updated_at))));
        main.appendChild(top);

        const mid = el('div', 'tkt-mid');
        mid.appendChild(catNode(t.category));
        mid.appendChild(el('span', 'tkt-user', t.user_name || ''));
        mid.appendChild(statusNode(t.status));
        main.appendChild(mid);

        main.appendChild(el('p', 'tkt-preview', t.preview || ''));
        b.appendChild(main);

        b.addEventListener('click', () => openTicket(t.id));
        listEl.appendChild(b);
      }
    }

    function renderHeader() {
      const t = S.thread;
      if (!t) return;
      $('#support-subject').textContent = t.subject || '(sans sujet)';
      const cat = $('#support-cat');
      const c = CATS[String(t.category || '').toLowerCase()] || { label: t.category || 'Autre', emoji: '💬' };
      cat.textContent = c.emoji + ' ' + c.label;
      const nMsg = (S.messages || []).length;
      $('#support-meta').textContent =
        (t.user_name ? t.user_name + ' · ' : '') + nMsg + ' message' + (nMsg > 1 ? 's' : '') +
        ' · créé ' + fmtRel(parseTs(t.created_at));
      const st = $('#support-status');
      const cls = 'tstatus st-' + String(t.status || 'open');
      st.className = cls;
      st.textContent = STATUS_LABEL[t.status] || t.status;
      const closed = t.status === 'closed';
      const btnClose = $('#btn-support-close');
      if (btnClose) btnClose.hidden = closed;
      taEl.disabled = closed;
      const send = $('#btn-support-send');
      if (send) send.disabled = closed;
      formEl.classList.toggle('is-closed', closed);
    }

    function bubble(m) {
      const isTeam = m.author_role === 'team';
      const b = el('div', 'bub ' + (isTeam ? 'bub-team' : 'bub-user'));
      const head = el('div', 'bub-head');
      head.appendChild(el('span', 'bub-name', m.author_name || (isTeam ? 'L\u2019équipe' : 'Joueur')));
      head.appendChild(el('span', 'bub-time', fmtHm(parseTs(m.created_at))));
      b.appendChild(head);
      b.appendChild(el('div', 'bub-body', m.body || ''));
      return b;
    }

    function renderMessages() {
      msgsEl.textContent = '';
      if (!S.messages.length) {
        msgsEl.appendChild(el('div', 'chat-loading', 'Aucun message dans ce ticket.'));
        return;
      }
      for (const m of S.messages) msgsEl.appendChild(bubble(m));
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    function showThread(on) {
      emptyEl.hidden = on;
      threadEl.hidden = !on;
      paneEl.classList.toggle('show-thread', on);
    }

    async function loadList() {
      if (S.loading) return;
      S.loading = true;
      try {
        const j = await apiGet('support.tickets');
        S.loading = false;
        if (j && j.ok) Support.onListData(j);
        else listEl.replaceChildren(el('div', 'split-empty', 'Liste indisponible — réessaie plus tard.'));
      } catch (e) {
        S.loading = false;
        listEl.replaceChildren(el('div', 'split-empty', 'Liste indisponible — réessaie plus tard.'));
      }
    }

    async function loadThread() {
      if (!S.openId) return;
      const j = await apiGet('support.thread', { id: S.openId });
      if (j && j.ok) {
        S.thread = j.ticket;
        S.messages = j.messages || [];
        renderHeader();
        renderMessages();
      } else if (j && j.error !== 'reload') {
        toast('Impossible de charger le fil du ticket.', 'error');
      }
    }

    async function openTicket(id) {
      S.openId = id;
      renderList();
      showThread(true);
      msgsEl.replaceChildren(el('div', 'chat-loading', 'Chargement du fil…'));
      $('#support-subject').textContent = '…';
      await loadThread();
    }

    wireComposer(taEl, formEl);
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = (taEl.value || '').trim();
      if (!text || S.sending || !S.openId) return;
      S.sending = true;
      const btn = $('#btn-support-send');
      if (btn) btn.disabled = true;
      const j = await apiPost('support.reply', { ticket_id: S.openId, message: text });
      S.sending = false;
      if (btn) btn.disabled = taEl.disabled;
      if (j && j.ok) {
        taEl.value = '';
        autoGrow(taEl);
        toast('Réponse envoyée — le joueur reçoit un mail.', 'success');
        await Promise.all([loadThread(), loadList()]);
      } else {
        toast((j && j.message) || 'Envoi impossible — réessaie.', 'error');
      }
    });

    $('#btn-support-close').addEventListener('click', async () => {
      const t = S.thread;
      if (!t || t.status === 'closed') return;
      if (!window.confirm('Fermer le ticket « ' + (t.subject || '#' + t.id) + ' » ? Le joueur ne pourra plus y répondre.')) return;
      const j = await apiPost('support.close', { ticket_id: t.id });
      if (j && j.ok) {
        toast('Ticket fermé.', 'success');
        await Promise.all([loadThread(), loadList()]);
      } else {
        toast((j && j.message) || 'Impossible de fermer le ticket.', 'error');
      }
    });

    /* Filtre Ouverts / Tous / Fermés */
    document.querySelectorAll('.seg-btn[data-tfilter]').forEach((b) => {
      b.addEventListener('click', () => {
        S.filter = b.getAttribute('data-tfilter') || 'open';
        document.querySelectorAll('.seg-btn[data-tfilter]').forEach((x) =>
          x.classList.toggle('is-active', x === b));
        renderList();
      });
    });

    /* Retour liste (mobile) */
    $('#btn-support-back').addEventListener('click', () => showThread(false));

    return {
      activate() {
        if (S.tickets.length) {
          renderList(); /* données déjà là via le refresh des badges */
          S.loaded = true;
        } else if (!S.loaded) {
          loadList();
          S.loaded = true;
        }
      },
      onListData(j) {
        S.tickets = (j && j.tickets) || [];
        S.loaded = true;
        setBadge(badgeEls.support, Number(j && j.open_count) || 0);
        if (currentView === 'support' || S.openId) renderList();
      },
      refresh() {
        loadList();
        if (S.openId) loadThread(); /* fil ouvert : resynchronisation légère */
      }
    };
  })();

  /* ═══════════════════════════════════════════════════════════════════════════
     Vue « Chat support » — conversations joueurs ↔ équipe, en direct (2,5 s)
     ═══════════════════════════════════════════════════════════════════════════ */

  const Supchat = (() => {
    const listEl = $('#conv-list');
    const paneEl = $('#view-supchat');
    const emptyEl = $('#supchat-empty');
    const threadEl = $('#supchat-thread');
    const msgsEl = $('#supchat-msgs');
    const formEl = $('#supchat-form');
    const taEl = $('#f-supchat-msg');

    const S = {
      loaded: false, loading: false,
      convs: [], openConv: null,
      messages: [], lastId: 0,
      sending: false, timer: null
    };

    if (!listEl) return { activate() {}, stopPoll() {}, onConvsData() {} };

    function convById(id) {
      return S.convs.find((c) => String(c.conv_id) === String(id)) || null;
    }

    function renderList() {
      const items = S.convs.slice().sort((a, b) => parseTs(b.last_at) - parseTs(a.last_at));
      listEl.textContent = '';
      if (!items.length) {
        listEl.appendChild(el('div', 'split-empty',
          'Aucune conversation. Les joueurs t\u2019écrivent depuis la bulle de chat du site.'));
        return;
      }
      for (const c of items) {
        const b = el('button', 'cv' + (String(c.conv_id) === String(S.openConv) ? ' is-active' : ''));
        b.type = 'button';
        b.setAttribute('role', 'listitem');
        b.appendChild(avatarNode(c.avatar, c.name, c.conv_id, 'cv-avatar'));

        const main = el('div', 'cv-main');
        const top = el('div', 'cv-top');
        top.appendChild(el('span', 'cv-name', c.name || 'Joueur'));
        top.appendChild(el('span', 'cv-time', fmtListTime(parseTs(c.last_at))));
        main.appendChild(top);

        const bottom = el('div', 'cv-bottom');
        const preview = el('span', 'cv-preview',
          (c.last_role === 'admin' ? 'Toi : ' : '') + (c.last_body || ''));
        bottom.appendChild(preview);
        if (Number(c.unread) > 0) bottom.appendChild(el('span', 'cv-unread', String(c.unread)));
        main.appendChild(bottom);
        b.appendChild(main);

        b.addEventListener('click', () => openConv(c.conv_id));
        listEl.appendChild(b);
      }
    }

    function bubble(m) {
      const isTeam = m.role === 'admin';
      const b = el('div', 'bub ' + (isTeam ? 'bub-team' : 'bub-user') + (m.pending ? ' bub-pending' : '') + (m.failed ? ' bub-failed' : ''));
      const head = el('div', 'bub-head');
      head.appendChild(el('span', 'bub-name', m.name || (isTeam ? 'L\u2019équipe' : 'Joueur')));
      head.appendChild(el('span', 'bub-time', m.pending ? 'envoi…' : fmtHm(parseTs(m.created_at))));
      b.appendChild(head);
      b.appendChild(el('div', 'bub-body', m.body || ''));
      return b;
    }

    function renderMessages() {
      msgsEl.textContent = '';
      if (!S.messages.length) {
        msgsEl.appendChild(el('div', 'chat-loading', 'Aucun message — écris en premier !'));
        return;
      }
      for (const m of S.messages) msgsEl.appendChild(bubble(m));
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    function applyMessage(m) {
      if (!m || m.id === undefined || m.id === null) return false;
      const idx = S.messages.findIndex((x) => String(x.id) === String(m.id));
      if (idx >= 0) {
        S.messages[idx] = Object.assign({}, S.messages[idx], m, { pending: false, failed: false });
        return false;
      }
      S.messages.push(m);
      if (Number(m.id) > S.lastId) S.lastId = Number(m.id);
      return true;
    }

    function showThread(on) {
      emptyEl.hidden = on;
      threadEl.hidden = !on;
      paneEl.classList.toggle('show-thread', on);
    }

    async function loadConvs() {
      if (S.loading) return;
      S.loading = true;
      try {
        const j = await apiGet('supchat.convs');
        S.loading = false;
        if (j && j.ok) Supchat.onConvsData(j.convs);
        else listEl.replaceChildren(el('div', 'split-empty', 'Conversations indisponibles.'));
      } catch (e) {
        S.loading = false;
        listEl.replaceChildren(el('div', 'split-empty', 'Conversations indisponibles.'));
      }
    }

    function startPoll() {
      stopPoll();
      S.timer = setInterval(() => {
        if (document.hidden || S.sending || !S.openConv) return;
        poll();
      }, 2500);
    }

    function stopPoll() {
      if (S.timer) { clearInterval(S.timer); S.timer = null; }
    }

    async function poll() {
      if (!S.openConv) return;
      const j = await apiGet('supchat.poll', { conv: S.openConv, after: S.lastId });
      if (!j || !j.ok || j.error === 'reload') return;
      let added = 0;
      for (const m of (j.messages || [])) {
        if (applyMessage(m)) added++;
      }
      if (j.last_id !== undefined && Number(j.last_id) > S.lastId) S.lastId = Number(j.last_id);
      if (added) renderMessages();
    }

    async function openConv(id) {
      S.openConv = id;
      const c = convById(id);
      /* le backend marque lu au poll ; on reflète localement tout de suite */
      if (c) c.unread = 0;
      renderList();
      setBadge(badgeEls.supchat, sumUnread(S.convs));
      showThread(true);

      $('#supchat-name').textContent = (c && c.name) || 'Joueur';
      const av = $('#supchat-avatar');
      if (av) {
        if (c && c.avatar) { av.style.visibility = 'visible'; av.src = c.avatar; }
        else if (c) { av.removeAttribute('src'); av.style.visibility = 'hidden'; }
      }

      S.messages = [];
      S.lastId = 0;
      msgsEl.replaceChildren(el('div', 'chat-loading', 'Chargement de la conversation…'));
      await poll();
      renderMessages();
      taEl.value = '';
      autoGrow(taEl);
      setTimeout(() => taEl.focus(), 0);
      startPoll();
    }

    wireComposer(taEl, formEl);
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = (taEl.value || '').trim();
      if (!text || S.sending || !S.openConv) return;
      S.sending = true;

      /* Message optimiste : affiché immédiatement, le poll resynchronise. */
      const temp = {
        id: 'tmp-' + Date.now(), role: 'admin',
        name: (BOOT.me && BOOT.me.name) || 'L\u2019équipe',
        body: text, created_at: Math.floor(Date.now() / 1000),
        pending: true
      };
      S.messages.push(temp);
      renderMessages();
      taEl.value = '';
      autoGrow(taEl);

      const j = await apiPost('supchat.reply', { conv: S.openConv, content: text });
      S.sending = false;

      const idx = S.messages.indexOf(temp);
      if (j && j.ok) {
        if (idx >= 0) {
          if (S.messages.some((m) => String(m.id) === String(j.id))) {
            S.messages.splice(idx, 1); /* le poll a déjà ramené le vrai message */
          } else {
            temp.id = j.id;
            temp.pending = false;
          }
        }
        if (Number(j.id) > S.lastId) S.lastId = Number(j.id);
      } else if (idx >= 0) {
        temp.pending = false;
        temp.failed = true;
      }
      renderMessages();
      if (!j || !j.ok) toast((j && j.message) || 'Envoi impossible — réessaie.', 'error');
    });

    $('#btn-supchat-back').addEventListener('click', () => showThread(false));

    return {
      activate() {
        if (S.convs.length) {
          renderList(); /* données déjà là via le refresh des badges */
          S.loaded = true;
        } else if (!S.loaded) {
          loadConvs();
          S.loaded = true;
        }
      },
      stopPoll,
      onConvsData(convs) {
        S.convs = convs || [];
        S.loaded = true;
        if (currentView === 'supchat') renderList();
        setBadge(badgeEls.supchat, sumUnread(S.convs));
      }
    };
  })();

  /* ═══════════════════════════════════════════════════════════════════════════
     Vue « Mails » — boîte support@thefronthub.com
     ═══════════════════════════════════════════════════════════════════════════ */

  const Mails = (() => {
    const listEl = $('#mails-list');
    const paneEl = $('#view-mails');
    const splitEl = $('#mails-split');
    const stateEl = $('#mails-state');
    const emptyEl = $('#mails-empty');
    const viewEl = $('#mails-view');
    const WEBMAIL = 'https://mail.thefronthub.com';

    const S = {
      loaded: false, loading: false,
      data: null,        /* réponse mails.list */
      openUid: null, mail: null,
      replyOpen: false, sending: false
    };

    if (!listEl) return { activate() {}, onListData() {}, refresh() {} };

    function updateBadge() {
      const n = (S.data && S.data.available && S.data.mails || [])
        .filter((m) => !m.seen).length;
      setBadge(badgeEls.mails, n);
    }

    function renderList() {
      const mails = (S.data && S.data.mails) || [];
      listEl.textContent = '';
      if (!mails.length) {
        listEl.appendChild(el('div', 'split-empty', 'Boîte vide — aucun mail.'));
        return;
      }
      for (const m of mails) {
        const b = el('button', 'ml' + (m.uid === S.openUid ? ' is-active' : '') + (!m.seen ? ' is-unread' : ''));
        b.type = 'button';
        b.setAttribute('role', 'listitem');

        const dot = el('span', 'ml-dot');
        dot.hidden = !!m.seen;
        dot.setAttribute('title', 'Non lu');
        b.appendChild(dot);

        const main = el('div', 'ml-main');
        const top = el('div', 'ml-top');
        top.appendChild(el('span', 'ml-from', m.from || '(expéditeur inconnu)'));
        top.appendChild(el('span', 'ml-date', fmtListTime(parseTs(m.ts || m.date))));
        main.appendChild(top);

        const mid = el('div', 'ml-mid');
        mid.appendChild(el('span', 'ml-subject', m.subject || '(sans objet)'));
        if (m.answered) mid.appendChild(el('span', 'ml-ans', '↩ Répondu'));
        main.appendChild(mid);
        b.appendChild(main);

        b.addEventListener('click', () => openMail(m.uid));
        listEl.appendChild(b);
      }
    }

    function fmtFrom(from) {
      const mm = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(String(from || ''));
      return mm ? (mm[1] || mm[2]) : String(from || '');
    }

    function renderMail() {
      const m = S.mail;
      if (!m) return;
      viewEl.textContent = '';

      const head = el('div', 'mail-head');
      const hrow = el('div', 'mail-head-row');
      hrow.appendChild(el('h2', 'mail-subject', m.subject || '(sans objet)'));
      const actions = el('div', 'mail-actions');
      const btnReply = el('button', 'btn primary small', 'Répondre');
      btnReply.type = 'button';
      const btnClose = el('button', 'btn ghost small', 'Fermer');
      btnClose.type = 'button';
      actions.appendChild(btnReply);
      actions.appendChild(btnClose);
      hrow.appendChild(actions);
      head.appendChild(hrow);
      head.appendChild(el('p', 'mail-meta', 'De : ' + (m.from || '?') + ' · ' + fmtDateTime(parseTs(m.date))));
      viewEl.appendChild(head);

      const pre = el('pre', 'mail-body', m.body || '');
      viewEl.appendChild(pre);

      /* Formulaire de réponse inline */
      const form = el('form', 'mail-reply');
      form.hidden = true;

      const fTo = el('label', 'field');
      fTo.appendChild(el('span', 'field-label', 'À'));
      const inTo = el('input');
      inTo.type = 'email';
      inTo.value = m.from || '';
      inTo.required = true;
      fTo.appendChild(inTo);

      const fSub = el('label', 'field');
      fSub.appendChild(el('span', 'field-label', 'Objet'));
      const inSub = el('input');
      inSub.type = 'text';
      inSub.value = /^re:/i.test(String(m.subject || '')) ? m.subject : 'Re: ' + (m.subject || '');
      fSub.appendChild(inSub);

      const fBody = el('label', 'field');
      fBody.appendChild(el('span', 'field-label', 'Message'));
      const taBody = el('textarea');
      taBody.rows = 6;
      taBody.maxLength = 20000;
      fBody.appendChild(taBody);

      const fActions = el('div', 'mail-reply-actions');
      const btnSend = el('button', 'btn primary small', 'Envoyer');
      btnSend.type = 'submit';
      const btnCancel = el('button', 'btn ghost small', 'Annuler');
      btnCancel.type = 'button';
      fActions.appendChild(btnCancel);
      fActions.appendChild(btnSend);

      form.appendChild(fTo);
      form.appendChild(fSub);
      form.appendChild(fBody);
      form.appendChild(fActions);
      viewEl.appendChild(form);

      btnReply.addEventListener('click', () => {
        S.replyOpen = true;
        form.hidden = false;
        btnReply.hidden = true;
        inTo.focus();
        inTo.setSelectionRange(inTo.value.length, inTo.value.length);
      });
      btnClose.addEventListener('click', () => {
        S.openUid = null;
        S.mail = null;
        S.replyOpen = false;
        viewEl.hidden = true;
        emptyEl.hidden = false;
        paneEl.classList.remove('show-thread'); /* mobile : retour à la liste */
        renderList();
      });
      btnCancel.addEventListener('click', () => {
        S.replyOpen = false;
        form.hidden = true;
        btnReply.hidden = false;
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const to = inTo.value.trim();
        const subject = inSub.value.trim();
        const body = taBody.value;
        if (!to || S.sending) return;
        S.sending = true;
        btnSend.disabled = true;
        const j = await apiPost('mails.reply', {
          to, subject: subject || '(sans objet)', body,
          in_reply_to: m.message_id || undefined
        });
        S.sending = false;
        btnSend.disabled = false;
        if (j && j.ok) {
          toast('Réponse envoyée à ' + (fmtFrom(to) || to) + '.', 'success');
          S.replyOpen = false;
          form.hidden = true;
          btnReply.hidden = false;
          taBody.value = '';
          /* marque « répondu » dans la liste */
          const item = ((S.data && S.data.mails) || []).find((x) => x.uid === m.uid);
          if (item) item.answered = true;
          renderList();
        } else {
          toast((j && j.message) || 'Envoi impossible — réessaie.', 'error');
        }
      });

      if (S.replyOpen) { form.hidden = false; btnReply.hidden = true; }
      viewEl.hidden = false;
      emptyEl.hidden = true;
    }

    function renderState(d) {
      splitEl.hidden = true;
      stateEl.hidden = false;
      stateEl.textContent = '';

      const card = el('div', 'mails-state-card');
      if (d && d.reason === 'not_configured') {
        card.appendChild(el('h2', '', '📮 Boîte mail non configurée'));
        card.appendChild(el('p', 'mails-state-lead',
          'La boîte ' + ((S.data && S.data.mailbox) || 'support@thefronthub.com') +
          ' n\u2019est pas encore branchée sur le panel. 3 étapes (5 minutes) :'));
        const ol = el('ol', 'mails-steps');

        const li1 = el('li');
        li1.appendChild(el('span', '', 'Copie le fichier d\u2019exemple à la racine du site : '));
        li1.appendChild(el('code', '', 'cp api/mail-config.example.php api/mail-config.php'));
        ol.appendChild(li1);

        const li2 = el('li');
        li2.appendChild(el('span', '', 'Édite '));
        li2.appendChild(el('code', '', 'api/mail-config.php'));
        li2.appendChild(el('span', '', ' et renseigne le mot de passe de la boîte (laisse le reste tel quel).'));
        ol.appendChild(li2);

        const li3 = el('li');
        li3.appendChild(el('span', '', 'La boîte elle-même se crée dans cPanel o2switch → '));
        li3.appendChild(el('strong', '', 'Comptes e-mail'));
        li3.appendChild(el('span', '', ' (adresse ' + ((S.data && S.data.mailbox) || 'support@thefronthub.com') + ' + mot de passe).'));
        ol.appendChild(li3);

        card.appendChild(ol);
      } else {
        card.appendChild(el('h2', '', '📮 Boîte mail indisponible'));
        if (d && d.reason === 'imap_unavailable') {
          card.appendChild(el('p', 'mails-state-lead', 'L\u2019extension IMAP de PHP est inactive sur l\u2019hébergement.'));
        } else if (d && d.reason === 'login_failed') {
          card.appendChild(el('p', 'mails-state-lead', 'La connexion à la boîte a échoué — vérifie le mot de passe dans api/mail-config.php.'));
        } else {
          card.appendChild(el('p', 'mails-state-lead', (d && d.hint) ? String(d.hint) : 'Raison inconnue.'));
        }
        if (d && d.hint && d.reason !== 'imap_unavailable' && d.reason !== 'login_failed') {
          /* hint déjà affiché ci-dessus */
        } else if (d && d.hint && (d.reason === 'imap_unavailable' || d.reason === 'login_failed')) {
          card.appendChild(el('p', 'mails-state-hint', String(d.hint)));
        }
      }

      const row = el('div', 'mails-state-actions');
      const aWeb = el('a', 'btn ghost small', 'Ouvrir le webmail');
      aWeb.href = WEBMAIL;
      aWeb.target = '_blank';
      aWeb.rel = 'noopener';
      row.appendChild(aWeb);
      const btnRetry = el('button', 'btn primary small', 'Réessayer');
      btnRetry.type = 'button';
      btnRetry.addEventListener('click', () => load());
      row.appendChild(btnRetry);
      card.appendChild(row);

      stateEl.appendChild(card);
    }

    async function load() {
      if (S.loading) return;
      S.loading = true;
      listEl.replaceChildren(el('div', 'split-loading', 'Chargement de la boîte…'));
      const j = await apiGet('mails.list');
      S.loading = false;
      S.data = j && j.ok ? j : null;
      if (S.data && S.data.available) {
        splitEl.hidden = false;
        stateEl.hidden = true;
        S.openUid = null;
        S.mail = null;
        viewEl.hidden = true;
        emptyEl.hidden = false;
        renderList();
      } else {
        renderState(S.data || { available: false });
      }
      updateBadge();
      S.loaded = true;
    }

    async function openMail(uid) {
      S.openUid = uid;
      renderList();
      viewEl.hidden = false;
      emptyEl.hidden = true;
      viewEl.replaceChildren(el('div', 'chat-loading', 'Chargement du mail…'));
      const j = await apiGet('mails.view', { uid });
      if (j && j.ok && j.mail) {
        S.mail = j.mail;
        /* marque lu localement (badge + liste) */
        const item = ((S.data && S.data.mails) || []).find((x) => x.uid === uid);
        if (item) item.seen = true;
        renderList();
        updateBadge();
        renderMail();
        if (paneEl.classList.contains('show-thread') === false && window.innerWidth < 900) {
          paneEl.classList.add('show-thread');
        }
      } else if (j && j.error !== 'reload') {
        viewEl.hidden = true;
        emptyEl.hidden = false;
        toast('Impossible de charger ce mail.', 'error');
      }
    }

    $('#btn-mails-refresh').addEventListener('click', () => load());

    return {
      activate() {
        if (S.data && S.data.available) {
          renderList(); /* données déjà là via le badge du boot */
          S.loaded = true;
        } else if (!S.loaded) {
          load();
        }
      },
      onListData(j) {
        /* appelé au boot pour le badge sans ouvrir la vue */
        if (!j || !j.ok || !j.available) return;
        S.data = j;
        S.loaded = true;
        updateBadge();
      },
      refresh() { load(); }
    };
  })();

  /* ── Restauration de la dernière section ouverte ──────────────────────────
     Après la définition des 3 vues (Support/Supchat/Mails) pour éviter la TDZ.
     Même clé localStorage que chat.js : chat.js a déjà réaffiché #view-chat
     si saved==='chat' ; on harmonise badges/aria-current/hidden ici. */
  let savedView = 'tasks';
  try { savedView = localStorage.getItem('tfh-admin-view') || 'tasks'; } catch (e) { /* ignore */ }
  if (VIEWS.indexOf(savedView) >= 0) setView(savedView);

  /* ── Horloges globales ───────────────────────────────────────────────────── */

  /* Badges toutes les 30 s + rafraîchissement de la liste des tickets
     (et du fil ouvert) quand la vue est active. */
  setInterval(() => {
    if (document.hidden) return;
    refreshBadges();
    if (currentView === 'support') Support.refresh();
  }, 30000);

  refreshBadges();
  /* premier badge mails (une seule requête au boot, puis à l'ouverture/refresh) */
  apiGet('mails.list').then((j) => {
    Mails.onListData(j);
  }).catch(() => {});

  /* Expose le routage pour debug / futur usage */
  window.TfhAdminViews = { setView, Support, Supchat, Mails };
})();
