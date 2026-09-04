/* ─────────────────────────────────────────────────────────────────────────────
   admin/assets/chat.js — Chat général de l'espace admin TheFrontHub (v1)
   Vanilla JS, sans dépendance. Complète app.js (qui gère la section Tâches).

   Discussion d'équipe style Discord sur toute la hauteur :
   texte (markdown léger), liens, images, vidéos, audio, fichiers joints
   (6 × 10 Mo, conservés 30 jours), édition/suppression, groupement des
   messages, séparateurs de jour, drag & drop, collage de fichiers,
   polling incrémental (4 s) et badge de messages non lus.

   Le chat général vit dans tfh_task_chat avec task_id = 0 (voir api.php).
   ───────────────────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  const BOOT = window.TASK_BOOT;
  if (!BOOT) return; /* pages connexion / refusé : rien à faire */

  const BASE = BOOT.base || '';
  const GENERAL_ID = 0;

  /* ── Mini helpers ────────────────────────────────────────────────────────── */

  const $ = (sel, root) => (root || document).querySelector(sel);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function svg(paths, size) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 14);
    s.setAttribute('height', size || 14);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    for (const d of String(paths).split('|')) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    }
    return s;
  }

  const ICONS = {
    copy: 'M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
    pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z',
    trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14',
    download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  };

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

  /* ── Rendu riche (markdown minimal, aligné sur app.js) ──────────────────── */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inlineRich(line) {
    /* liens cliquables puis **gras**, *italique*, `code` — entrées échappées. */
    let out = escapeHtml(line);
    out = out.replace(/(https?:\/\/[^\s<>"')\]]+)/g, (m) => {
      const trailing = /[.,;:!?]$/.test(m) ? m.slice(-1) : '';
      const url = trailing ? m.slice(0, -1) : m;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' + trailing;
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    return out;
  }

  function renderRich(text) {
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
        i++;
        const pre = el('pre', 'md-pre');
        pre.appendChild(el('code', '', buf.join('\n')));
        frag.appendChild(pre);
        continue;
      }
      if (/^\s*-\s+/.test(line)) {
        const ul = el('ul', 'md-ul');
        while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
          const li = el('li');
          li.innerHTML = inlineRich(lines[i].replace(/^\s*-\s+/, ''));
          ul.appendChild(li);
          i++;
        }
        frag.appendChild(ul);
        continue;
      }
      if (line.trim() === '') { i++; continue; }
      const p = el('p', 'md-p');
      p.innerHTML = inlineRich(line);
      frag.appendChild(p);
      i++;
    }
    return frag;
  }

  /* ── État ────────────────────────────────────────────────────────────────── */

  const scroll  = $('#gchat-scroll');
  const wrap    = $('#gchat-wrap');
  const newPill = $('#gchat-newpill');
  const chips   = $('#gchat-chips');
  const form    = $('#gchat-form');
  const input   = $('#f-gchat');
  const fileIn  = $('#f-gchat-files');
  const btnAtt  = $('#btn-gchat-attach');
  const btnSend = $('#btn-gchat-send');
  const tabChat = $('#tab-chat');
  const tabTasks = $('#tab-tasks');
  const viewChat = $('#view-chat');
  const viewTasks = $('#view-tasks');
  const unreadBadge = $('#gchat-unread');

  if (!scroll || !form || !input) return;

  const state = {
    messages: [],
    people: {},
    lastId: 0,
    pollTs: 0,
    pending: [],
    editId: null,
    sending: false,
    loaded: false,
    unread: 0,
    timer: null,
  };

  const GROUP_SECONDS = 420;
  const COLORS = ['#E5598C', '#F2A33C', '#3BA55D', '#3E9CD9', '#8B5CF6', '#EB6A4B', '#4FA8C7', '#C878C9'];

  const startOfDayMs = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function color(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  function personName(m) {
    const p = state.people[m.author_id];
    return (p && p.name) || m.author_name || 'Discord';
  }

  function personAvatar(m) {
    const p = state.people[m.author_id];
    return (p && p.avatar) || '';
  }

  function defaultAvatar(id) {
    /* cercle coloré avec initiale — utilisé si l'avatar Discord est absent */
    const c = color(id);
    const d = document.createElement('div');
    d.className = 'chat-avatar chat-avatar-fallback';
    d.style.background = c;
    const p = state.people[id];
    const name = (p && p.name) || '';
    d.textContent = (name ? name.charAt(0).toUpperCase() : '?');
    return d;
  }

  function fmtSize(n) {
    if (n === null || n === undefined) return '';
    const u = ['o', 'Ko', 'Mo', 'Go'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i ? (v >= 10 || i > 1 ? Math.round(v) : v.toFixed(1)) : v) + ' ' + u[i];
  }

  function dayLabel(ts) {
    const t = startOfDayMs(ts * 1000);
    const today = startOfDayMs(Date.now());
    if (t === today) return "Aujourd'hui";
    if (t === today - 86400000) return 'Hier';
    try {
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
        .format(new Date(ts * 1000));
    } catch (e) { return ''; }
  }

  function fullTime(ts) {
    try {
      const today = startOfDayMs(Date.now());
      const t = startOfDayMs(ts * 1000);
      const hm = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
      if (t === today) return "Aujourd'hui à " + hm;
      if (t === today - 86400000) return 'Hier à ' + hm;
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        .format(new Date(ts * 1000)) + ' à ' + hm;
    } catch (e) { return ''; }
  }

  function fileUrl(att, dl) {
    return BASE + '/file.php?id=' + encodeURIComponent(att.id) + (dl ? '&dl=1' : '');
  }

  function attExpired(att) {
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

  /* ── Défilement ──────────────────────────────────────────────────────────── */

  function nearBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  }

  function scrollBottom() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  /* ── Chargement / polling ────────────────────────────────────────────────── */

  async function load() {
    try {
      const r = await fetch(BASE + '/api.php?action=chat.list&task_id=' + GENERAL_ID, {
        headers: { Accept: 'application/json' }, cache: 'no-store'
      });
      const j = await r.json();
      if (!j || !j.ok) throw new Error(j && j.message ? j.message : 'erreur');
      state.messages = j.messages || [];
      state.people = j.people || {};
      state.lastId = state.messages.reduce((mx, m) => Math.max(mx, m.id), 0);
      state.loaded = true;
      render(true);
    } catch (e) {
      scroll.textContent = '';
      scroll.appendChild(el('div', 'chat-loading', 'Chat indisponible — recharge la page.'));
    }
  }

  function applyMessage(m) {
    if (!m || !m.id) return false;
    const idx = state.messages.findIndex((x) => x.id === m.id);
    if (idx >= 0) {
      state.messages[idx] = m;
      return false; /* mise à jour, pas un nouveau */
    }
    state.messages.push(m);
    if (m.id > state.lastId) state.lastId = m.id;
    return true;
  }

  async function poll() {
    if (!state.loaded || state.sending || state.editId !== null) return;
    const qs = BASE + '/api.php?action=chat.list&task_id=' + GENERAL_ID
      + '&after=' + state.lastId
      + (state.pollTs > 0 ? '&changed_since=' + state.pollTs : '');
    const reqTs = Math.floor(Date.now() / 1000);
    let j = null;
    try {
      const r = await fetch(qs, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      j = await r.json();
    } catch (e) { state.pollTs = reqTs; return; }
    state.pollTs = reqTs;
    if (!j || !j.ok) return;
    if (j.people && Object.keys(j.people).length > 0) state.people = j.people;
    let added = 0;
    let updated = 0;
    for (const m of (j.messages || [])) {
      if (applyMessage(m)) added++; else updated++;
    }
    if (added || updated) {
      const isActive = !viewChat.hidden;
      const wasNear = nearBottom();
      render(wasNear);
      if (added && !isActive) {
        state.unread += added;
        renderUnread();
      }
      if (added && !wasNear && isActive && newPill) newPill.hidden = false;
    }
  }

  function renderUnread() {
    if (!unreadBadge) return;
    if (state.unread > 0) {
      unreadBadge.textContent = state.unread > 99 ? '99+' : String(state.unread);
      unreadBadge.hidden = false;
    } else {
      unreadBadge.hidden = true;
    }
    try {
      document.title = state.unread > 0
        ? '(' + state.unread + ') Chat — TheFrontHub Admin'
        : 'Admin — TheFrontHub';
    } catch (e) { /* ignore */ }
  }

  /* ── Rendu ───────────────────────────────────────────────────────────────── */

  function attNode(atts) {
    const box = el('div', 'chat-atts');
    for (const att of atts) {
      if (attExpired(att)) {
        box.appendChild(fileCard(att, true));
        continue;
      }
      if (isImageAtt(att)) {
        const a = el('a', 'chat-imglink');
        a.href = fileUrl(att, false);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = (att.name || 'Image') + ' — cliquer pour agrandir';
        const im = el('img', 'chat-att-img');
        im.alt = att.name || 'Image partagée';
        im.loading = 'lazy';
        im.src = fileUrl(att, false);
        a.appendChild(im);
        box.appendChild(a);
      } else if (isVideoAtt(att)) {
        const v = el('video', 'chat-att-video');
        v.controls = true;
        v.preload = 'metadata';
        v.src = fileUrl(att, false);
        box.appendChild(v);
      } else if (isAudioAtt(att)) {
        const au = el('audio', 'chat-att-audio');
        au.controls = true;
        au.preload = 'metadata';
        au.src = fileUrl(att, false);
        box.appendChild(au);
      } else {
        box.appendChild(fileCard(att, false));
      }
    }
    return box;
  }

  function fileCard(att, expired) {
    const a = el('a', 'chat-filecard' + (expired ? ' expired' : ''));
    if (expired) {
      a.href = '#';
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        toast('Fichier expiré — les fichiers sont conservés 30 jours', 'error');
      });
    } else {
      a.href = fileUrl(att, true);
      a.title = 'Télécharger ' + (att.name || 'fichier');
    }
    const ico = el('span', 'chat-fc-ico', (att.ext || '?').toUpperCase().slice(0, 4));
    a.appendChild(ico);
    const meta = el('span', 'chat-fc-meta');
    meta.appendChild(el('span', 'chat-fc-name', att.name || 'fichier'));
    meta.appendChild(el('span', 'chat-fc-size', expired
      ? 'Fichier expiré — conservé 30 jours'
      : [fmtSize(att.size), att.width && att.height ? att.width + '×' + att.height : ''].filter(Boolean).join(' · ')));
    a.appendChild(meta);
    if (!expired) {
      const dl = el('span', 'chat-fc-dl');
      dl.appendChild(svg(ICONS.download, 15));
      a.appendChild(dl);
    }
    return a;
  }

  function editForm(m) {
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
      state.editId = null;
      render(false);
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
      state.editId = null;
      applyMessage(j.message);
      render(false);
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        ef.requestSubmit();
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        state.editId = null;
        render(false);
      }
    });
    setTimeout(() => {
      try { ta.focus(); ta.selectionStart = ta.value.length; } catch (e) { /* ignore */ }
    }, 0);
    return ef;
  }

  function msgNode(m, grouped) {
    const node = el('div', 'chat-msg' + (grouped ? ' grouped' : '') + (m.deleted ? ' deleted' : ''));
    if (m.ts) node.title = fullTime(m.ts);

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
    if (!m.deleted && m.author_id === BOOT.me.id) {
      const ed = el('button', 'chat-tool');
      ed.type = 'button';
      ed.title = 'Modifier';
      ed.setAttribute('aria-label', 'Modifier le message');
      ed.appendChild(svg(ICONS.pencil, 13));
      ed.addEventListener('click', () => {
        state.editId = m.id;
        render(false);
      });
      tools.appendChild(ed);
    }
    if (!m.deleted && (m.author_id === BOOT.me.id || BOOT.me.can_manage)) {
      const rm = el('button', 'chat-tool danger');
      rm.type = 'button';
      rm.title = 'Supprimer';
      rm.setAttribute('aria-label', 'Supprimer le message');
      rm.appendChild(svg(ICONS.trash, 13));
      rm.addEventListener('click', async () => {
        if (!window.confirm('Supprimer ce message ?')) return;
        const j = await apiAction('chat.delete', { message_id: m.id });
        if (!j || !j.ok) {
          toast((j && j.message) || 'Suppression impossible', 'error');
          return;
        }
        const idx = state.messages.findIndex((x) => x.id === m.id);
        if (idx >= 0) {
          state.messages[idx] = Object.assign({}, state.messages[idx], {
            deleted: true, body: '', attachments: []
          });
        }
        render(false);
      });
      tools.appendChild(rm);
    }
    if (tools.childElementCount > 0) node.appendChild(tools);

    const av = personAvatar(m);
    if (av) {
      const img = el('img', 'chat-avatar');
      img.alt = '';
      img.loading = 'lazy';
      img.src = av;
      img.onerror = () => { img.replaceWith(defaultAvatar(m.author_id)); };
      node.appendChild(img);
    } else {
      node.appendChild(defaultAvatar(m.author_id));
    }

    const main = el('div', 'chat-main');

    if (!grouped) {
      const head = el('div', 'chat-head');
      const name = el('span', 'chat-name', personName(m));
      name.style.color = color(m.author_id);
      head.appendChild(name);
      if (m.edited_ts) head.appendChild(el('span', 'chat-edited', '(modifié)'));
      if (m.ts) head.appendChild(el('span', 'chat-time', fullTime(m.ts)));
      main.appendChild(head);
    }

    if (m.deleted) {
      main.appendChild(el('div', 'chat-text chat-deleted', 'Message supprimé'));
    } else if (state.editId === m.id) {
      main.appendChild(editForm(m));
    } else {
      if (m.body) {
        const txt = el('div', 'chat-text');
        txt.appendChild(renderRich(m.body));
        if (m.edited_ts && grouped) txt.appendChild(el('span', 'chat-edited', ' (modifié)'));
        main.appendChild(txt);
      }
      if (m.attachments && m.attachments.length > 0) {
        main.appendChild(attNode(m.attachments));
      }
      if (!m.body && (!m.attachments || m.attachments.length === 0)) {
        main.appendChild(el('div', 'chat-text chat-deleted', '—'));
      }
    }

    node.appendChild(main);
    return node;
  }

  function render(scrollDown) {
    const stick = scrollDown === true || nearBottom();
    const prevTop = scroll.scrollTop;
    const prevHeight = scroll.scrollHeight;

    scroll.textContent = '';

    if (state.messages.length === 0) {
      const empty = el('div', 'chat-empty');
      empty.appendChild(el('div', 'chat-empty-title', 'Aucun message pour l\u2019instant'));
      empty.appendChild(el('div', 'chat-empty-sub', 'Lance la discussion : écris, colle ou dépose des fichiers.'));
      scroll.appendChild(empty);
    }

    let prev = null;
    for (const m of state.messages) {
      if (!prev || startOfDayMs((m.ts || 0) * 1000) !== startOfDayMs((prev.ts || 0) * 1000)) {
        scroll.appendChild(el('div', 'chat-day', dayLabel(m.ts || 0)));
        prev = null;
      }
      const grouped = !!(prev
        && !m.deleted && !prev.deleted
        && prev.author_id === m.author_id
        && Math.abs((m.ts || 0) - (prev.ts || 0)) < GROUP_SECONDS);
      scroll.appendChild(msgNode(m, grouped));
      prev = m;
    }

    if (stick) {
      scrollBottom();
      if (newPill) newPill.hidden = true;
    } else {
      scroll.scrollTop = prevTop + (scroll.scrollHeight - prevHeight);
    }
  }

  /* ── Envoi ───────────────────────────────────────────────────────────────── */

  function stageFiles(fileList) {
    for (const f of Array.from(fileList || [])) {
      if (state.pending.length >= 6) {
        toast('6 fichiers maximum par message', 'error');
        break;
      }
      if (f.size > 10 * 1024 * 1024) {
        toast('« ' + f.name + ' » dépasse 10 Mo', 'error');
        continue;
      }
      state.pending.push(f);
    }
    renderChips();
  }

  function renderChips() {
    if (!chips) return;
    chips.textContent = '';
    chips.hidden = state.pending.length === 0;
    state.pending.forEach((f, i) => {
      const chip = el('span', 'chat-chip');
      chip.appendChild(el('span', 'chat-chip-name', f.name));
      chip.appendChild(el('span', 'chat-chip-size', fmtSize(f.size)));
      const rm = el('button', 'chat-chip-rm');
      rm.type = 'button';
      rm.title = 'Retirer ce fichier';
      rm.setAttribute('aria-label', 'Retirer ' + f.name);
      rm.appendChild(svg(ICONS.trash, 12));
      rm.addEventListener('click', () => {
        state.pending.splice(i, 1);
        renderChips();
      });
      chip.appendChild(rm);
      chips.appendChild(chip);
    });
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  }

  async function send() {
    if (state.sending) return;
    const body = input.value.trim();
    const files = state.pending.slice();
    if (!body && files.length === 0) return;

    state.sending = true;
    if (btnSend) btnSend.disabled = true;
    try {
      let j = null;
      if (files.length > 0) {
        const fd = new FormData();
        fd.append('action', 'chat.upload');
        fd.append('id', String(GENERAL_ID));
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
        j = await apiAction('chat.send', { id: GENERAL_ID, body: body });
      }
      if (!j || !j.ok) {
        toast((j && j.message) || 'Envoi impossible', 'error');
        return;
      }
      input.value = '';
      autoGrow();
      state.pending = [];
      renderChips();
      applyMessage(j.message);
      render(true);
    } catch (e) {
      toast('Envoi impossible — réessaie', 'error');
    } finally {
      state.sending = false;
      if (btnSend) btnSend.disabled = false;
      if (!viewChat.hidden) input.focus();
    }
  }

  /* ── Événements ──────────────────────────────────────────────────────────── */

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    send();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', autoGrow);
  input.addEventListener('paste', (ev) => {
    const files = ev.clipboardData && ev.clipboardData.files;
    if (files && files.length > 0) {
      ev.preventDefault();
      stageFiles(files);
      toast('Fichier collé — vérifie puis clique Envoyer', 'success');
    }
  });

  if (btnAtt && fileIn) {
    btnAtt.addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', () => {
      stageFiles(fileIn.files);
      fileIn.value = '';
    });
  }

  if (wrap) {
    let dragDepth = 0;
    const hasFiles = (ev) => !!(ev.dataTransfer && Array.from(ev.dataTransfer.types || []).indexOf('Files') !== -1);
    wrap.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragDepth++;
      wrap.classList.add('dragging');
    });
    wrap.addEventListener('dragover', (ev) => {
      if (dragDepth > 0) ev.preventDefault();
    });
    wrap.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) wrap.classList.remove('dragging');
    });
    wrap.addEventListener('drop', (ev) => {
      dragDepth = 0;
      wrap.classList.remove('dragging');
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length > 0) {
        ev.preventDefault();
        stageFiles(ev.dataTransfer.files);
        input.focus();
      }
    });
  }

  scroll.addEventListener('scroll', () => {
    if (newPill && nearBottom()) newPill.hidden = true;
  });

  if (newPill) {
    newPill.addEventListener('click', () => {
      newPill.hidden = true;
      scrollBottom();
    });
  }

  /* ── Onglets Tâches / Chat ───────────────────────────────────────────────── */

  function setView(view) {
    const isChat = view === 'chat';
    if (viewChat) viewChat.hidden = !isChat;
    if (viewTasks) viewTasks.hidden = isChat;
    if (tabChat) {
      tabChat.classList.toggle('is-active', isChat);
      tabChat.setAttribute('aria-selected', isChat ? 'true' : 'false');
    }
    if (tabTasks) {
      tabTasks.classList.toggle('is-active', !isChat);
      tabTasks.setAttribute('aria-selected', isChat ? 'false' : 'true');
    }
    if (isChat) {
      state.unread = 0;
      renderUnread();
      if (!state.loaded) load(); else render(true);
      setTimeout(() => input.focus(), 0);
    }
    try { localStorage.setItem('tfh-admin-view', isChat ? 'chat' : 'tasks'); } catch (e) { /* ignore */ }
  }

  if (tabChat) tabChat.addEventListener('click', () => setView('chat'));
  if (tabTasks) tabTasks.addEventListener('click', () => setView('tasks'));

  /* Reprise du polling quand l'onglet redevient visible */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !viewChat.hidden) {
      poll().catch(() => {});
      render(true);
      state.unread = 0;
      renderUnread();
    }
  });

  /* Restaure la dernière section ouverte */
  let saved = 'tasks';
  try { saved = localStorage.getItem('tfh-admin-view') || 'tasks'; } catch (e) { /* ignore */ }
  if (saved === 'chat') setView('chat');
  else { /* polling léger même en section Tâches, pour le badge non-lu */ }

  /* ── Démarrage ───────────────────────────────────────────────────────────── */

  /* Charge la discussion dès le boot si la section Chat est ouverte,
     sinon au premier clic sur l'onglet (voir setView). Le polling tourne
     en continu pour alimenter le badge de messages non lus. */
  if (!viewChat.hidden) {
    load();
  } else {
    /* premier état des non-lus : léger — une requête au boot, puis polling */
    fetch(BASE + '/api.php?action=chat.list&task_id=' + GENERAL_ID, {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    })
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.ok) return;
        state.messages = j.messages || [];
        state.people = j.people || {};
        state.lastId = state.messages.reduce((mx, m) => Math.max(mx, m.id), 0);
        state.loaded = true;
      })
      .catch(() => { /* le chat se chargera à l'ouverture de l'onglet */ });
  }

  state.timer = setInterval(() => {
    if (document.hidden) return;
    poll().catch(() => {});
  }, 4000);
})();
