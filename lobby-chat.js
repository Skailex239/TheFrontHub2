/**
 * lobby-chat.js — v5.20 — Chat communautaire du Lobby TheFrontHub.
 *
 * Backend : api/lobby-chat.php (MySQL, polling ~3 s). ACCÈS RÉSERVÉ AUX
 * COMPTES (session Discord — « inscrits sur le site ») : le visiteur
 * déconnecté voit l'encart « Connecte-toi avec Discord ».
 *
 * Salons :
 *   - global       → #Général (tous les inscrits).
 *   - Parties du jour → v5.20 : les DERNIÈRES PARTIES PUBLIQUES LANCÉES
 *     (fenêtre 24 h) sont listées automatiquement depuis la collecte
 *     serveur (action=rooms → tfh_g_games, cron games-sync) — avec TOUS
 *     leurs joueurs vus via l'API OpenFront (action=players → roster),
 *     et la mise en avant des inscrits TheFrontHub (compte relié). Les
 *     salons de partie que JE suis (bulle d'une carte / ma partie qui
 *     démarre) restent suivis en local et sont fusionnés dans la liste.
 *   - Écriture dans un salon de partie : réservée aux JOUEURS DE LA
 *     PARTIE (roster API ∩ compte relié) — le serveur répond 403
 *     not_in_game sinon ; #Général reste ouvert à tous les inscrits.
 *
 * UI : bouton « Chat » DANS la page (topbar, à côté du titre Lobby — il
 * n'existe QUE sur la page lobby), drawer latéral (desktop) / bottom-sheet
 * (mobile), onglets de salons avec badges non-lus, bandeau joueurs du
 * salon, historique 50 messages, polling 3 s panneau ouvert + 25 s en fond
 * pour les badges. Zéro dépendance, IIFE autonome.
 */
(function () {
  "use strict";

  const T = (k, fb, params) => (typeof window.t === "function" ? window.t(k, params) : fb);
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  /* ── Constantes ──────────────────────────────────────────────────────── */
  const API = "api/lobby-chat.php";
  const LS_ROOMS = "tfh_lobbychat_rooms_v1";   // salons de parties suivis
  const LS_LAST  = "tfh_lobbychat_last_v1";    // dernier salon actif
  const POLL_OPEN_MS = 3000;                   // panneau ouvert + visible
  const POLL_BG_MS   = 25000;                  // fond (badges non-lus)
  const MAX_GAME_ROOMS = 8;                    // salons LOCAUX suivis max
  const ROOMS_REFRESH_MS = 90_000;             // rafraîchit « parties du jour »

  /* ── État ────────────────────────────────────────────────────────────── */
  const load = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };

  let me = null;                                // { name, avatar } si connecté
  let linked = false;                           // compte OpenFront relié (public_id)
  let activeRoom = "global";
  let gameRooms = load(LS_ROOMS, []);           // salons LOCAUX suivis ["gAb12…", …]
  let serverRooms = [];                         // v5.20 : parties du jour (serveur)
  let playersCache = {};                        // room → { players, canPost, game, at }
  let since = {};                               // room → dernier id reçu
  let unread = {};                              // room → nb non lus
  let roomMeta = load("tfh_lobbychat_meta_v1", {}); // room → { map }
  let canPostHere = true;                       // salon actif : droit d'écrire
  let pollTimer = null;
  let roomsTimer = null;
  let bgTick = 0;
  let sending = false;
  let stickBottom = true;
  const visitedRooms = new Set();   // salons de partie visités (badges fond)

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  let drawer = null, headerBtn = null, els = {};

  const svgSend = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  const svgClose = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  function roomLabel(room) {
    if (room === "global") return T("lobby.chat_room_global", "#Général");
    const sr = serverRooms.find((r) => r.id === room);
    if (sr && sr.map) return sr.map;
    const meta = roomMeta[room];
    if (meta && meta.map) return meta.map;
    return "Partie " + String(room).replace(/^g/, "").slice(0, 8);
  }

  function rememberGameRoom(room) {
    if (room === "global" || gameRooms.includes(room)) return;
    gameRooms.unshift(room);
    gameRooms = gameRooms.slice(0, MAX_GAME_ROOMS);
    save(LS_ROOMS, gameRooms);
  }

  function resolveGameMeta(gameId) {
    try {
      const st = window._lobbyDebug && window._lobbyDebug.state;
      if (!st) return;
      for (const k of ["ffa", "team", "special"]) {
        const g = (st.games[k] || []).find((x) => String(x.gameID || x.id) === String(gameId));
        if (g) {
          roomMeta["g" + gameId] = { map: String((g.gameConfig || {}).gameMap || "") };
          save("tfh_lobbychat_meta_v1", roomMeta);
          return;
        }
      }
    } catch { /* ignore */ }
  }

  function hhmm(utcStamp) {
    // created_at du serveur = « YYYY-MM-DD HH:MM:SS » en UTC (gmdate)
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(utcStamp || ""));
    if (!m) return "";
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /** « il y a … » depuis un horodatage UTC « YYYY-MM-DD HH:MM:SS » (MySQL). */
  function agoSince(utcStamp) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(utcStamp || ""));
    if (!m) return "";
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (isNaN(d)) return "";
    const s = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (s < 60) return T("lobby.ago_s", `${s} s`, { n: s });
    if (s < 3600) { const n = Math.floor(s / 60); return T("lobby.ago_min", `${n} min`, { n }); }
    const n = Math.floor(s / 3600);
    return T("lobby.ago_h", `${n} h`, { n });
  }

  function safeAvatar(url) {
    return /^https:\/\//.test(String(url || "")) ? String(url) : "";
  }

  /* ── API ─────────────────────────────────────────────────────────────── */

  async function apiGet(params) {
    const res = await fetch(`${API}?${new URLSearchParams(params)}`, {
      credentials: "same-origin", cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async function fetchMe() {
    try {
      const res = await fetch("api/me.php", { credentials: "same-origin", cache: "no-store" });
      me = res.ok ? ((await res.json()).user || null) : null;
    } catch { me = null; }
  }

  /* ── v5.20 : parties du jour (serveur) + joueurs d'un salon ───────── */

  async function fetchRooms() {
    if (!me) return;
    try {
      const r = await apiGet({ action: "rooms" });
      if (r.status === 401) { me = null; renderAuthZone(); return; }
      if (!r.data || !r.data.ok) return;
      linked = !!r.data.linked;
      serverRooms = Array.isArray(r.data.rooms) ? r.data.rooms : [];
      // Les libellés serveur enrichissent aussi les salons locaux.
      for (const sr of serverRooms) {
        if (sr.map) roomMeta[sr.id] = { map: sr.map };
      }
      save("tfh_lobbychat_meta_v1", roomMeta);
      renderTabs();
      if (activeRoom !== "global") renderRoomPlayers();
    } catch { /* réseau : on garde l'état courant */ }
  }

  async function fetchPlayers(room, force) {
    if (!room || room === "global") return;
    const c = playersCache[room];
    if (!force && c && Date.now() - c.at < 60_000) { renderRoomPlayers(); return; }
    try {
      const r = await apiGet({ action: "players", room });
      if (r.status === 401) return;
      if (!r.data || !r.data.ok) return;
      playersCache[room] = {
        players: Array.isArray(r.data.players) ? r.data.players : [],
        canPost: r.data.canPost !== false,
        game: r.data.game || null,
        at: Date.now(),
      };
      if (r.data.game && r.data.game.map) {
        roomMeta[room] = { map: r.data.game.map };
        save("tfh_lobbychat_meta_v1", roomMeta);
      }
      renderTabs();
      if (room === activeRoom) renderRoomPlayers();
    } catch { /* ignore */ }
  }

  async function loadHistory(room) {
    const r = await apiGet({ action: "history", room });
    if (r.status === 401) {
      me = null;
      // Non inscrit : on vide le spinner, l'encart connexion s'affiche
      if (room === activeRoom) els.msgs.innerHTML = "";
      return { auth: true };
    }
    if (!r.data || !r.data.ok) {
      // API indisponible (réseau / maintenance) → état vide explicite
      if (room === activeRoom) {
        els.msgs.innerHTML = "";
        const err = document.createElement("div");
        err.className = "lchat-sys";
        err.textContent = T("lobby.chat_unavailable", "Chat indisponible pour le moment — réessaie dans un instant.");
        els.msgs.appendChild(err);
      }
      return { ok: false };
    }
    since[room] = r.data.last_id || 0;
    unread[room] = 0;
    renderMessages(room, r.data.messages || [], true);
    return { ok: true };
  }

  async function pollRoom(room) {
    const r = await apiGet({ action: "poll", room, since: String(since[room] || 0) });
    if (r.status === 401) { me = null; renderAuthZone(); return; }
    if (!r.data || !r.data.ok) return;
    since[room] = r.data.last_id != null ? r.data.last_id : (since[room] || 0);
    const msgs = r.data.messages || [];
    if (msgs.length) {
      if (room === activeRoom && isOpen() && !document.hidden) {
        unread[room] = 0;
        renderMessages(room, msgs, false);
      } else {
        unread[room] = (unread[room] || 0) + msgs.length;
        renderTabs();
        renderHeaderBadge();
      }
    }
  }

  async function sendMessage(content) {
    if (sending || !me) return;
    sending = true;
    els.sendBtn.disabled = true;
    try {
      const res = await fetch(API, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", room: activeRoom, content }),
      });
      if (res.status === 401) {
        me = null;
        renderAuthZone();
        window.showToast?.(T("lobby.chat_toast_login", "Connecte-toi pour chatter"), "warning", 4000);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        if (res.status === 403 && data.error === "not_in_game") {
          // v5.20 : salon réservé aux joueurs de la partie (compte relié).
          canPostHere = false;
          renderRoomPlayers();
          window.showToast?.(T("lobby.chat_not_in_game", "Ce salon est réservé aux joueurs de cette partie — relie ton compte OpenFront depuis ton profil pour être reconnu."), "warning", 6000);
          return;
        }
        if (res.status === 429) {
          window.showToast?.(T("lobby.chat_toast_slow", "Doucement ! Trop de messages d'un coup 🐢"), "warning", 4000);
        } else {
          window.showToast?.(T("lobby.chat_toast_error", "Message non envoyé, réessaie"), "error", 4000);
        }
        return;
      }
      appendMessage(data.message, false);
      since[activeRoom] = Math.max(since[activeRoom] || 0, data.message.id || 0);
    } catch {
      window.showToast?.(T("lobby.chat_toast_offline", "Réseau indisponible — message non envoyé"), "error", 4000);
    } finally {
      sending = false;
      els.sendBtn.disabled = false;
    }
  }

  /* ── Rendu ───────────────────────────────────────────────────────────── */

  function isOpen() { return drawer && !drawer.hidden; }

  function openDrawer(room, sysText) {
    if (room) {
      // Le message système est posé APRÈS le rendu de l'historique (sinon
      // switchRoom → loadHistory remplace le contenu et l'efface).
      switchRoom(room).then(() => { if (sysText && me) sysMessage(sysText); });
    }
    drawer.hidden = false;
    if (headerBtn) {
      headerBtn.setAttribute("aria-expanded", "true");
      headerBtn.classList.add("is-open");
    }
    renderHeaderBadge();
    if (me) setTimeout(() => els.input.focus(), 120);
    startPolling();
  }

  function closeDrawer() {
    drawer.hidden = true;
    if (headerBtn) {
      headerBtn.setAttribute("aria-expanded", "false");
      headerBtn.classList.remove("is-open");
    }
    renderHeaderBadge();
  }

  async function switchRoom(room) {
    if (room !== "global") {
      visitedRooms.add(room);
      // Salon SERVEUR (partie du jour) → pas besoin de suivi local.
      if (!serverRooms.some((r) => r.id === room)) rememberGameRoom(room);
      resolveGameMeta(String(room).slice(1));
      fetchPlayers(room, false);
    }
    activeRoom = room;
    canPostHere = room === "global" ? true : (playersCache[room] ? playersCache[room].canPost !== false : true);
    save(LS_LAST, room);
    unread[room] = 0;
    renderTabs();
    renderRoomHeader();
    renderRoomPlayers();
    els.msgs.innerHTML = `<div class="lchat-loading"><div class="spinner"></div></div>`;
    const r = await loadHistory(room);
    if (r && r.auth) renderAuthZone();
    scrollBottom(true);
    renderHeaderBadge();
  }

  function renderRoomHeader() {
    els.roomLabel.textContent = roomLabel(activeRoom);
    if (activeRoom === "global") {
      els.roomDesc.textContent = T("lobby.chat_desc_global", "Le salon de toute la communauté TheFrontHub");
      return;
    }
    const sr = serverRooms.find((r) => r.id === activeRoom);
    const when = sr && sr.startedAt ? agoSince(sr.startedAt) : "";
    els.roomDesc.textContent =
      T("lobby.chat_desc_game", "Salon des joueurs de cette partie — inscrits TheFrontHub mis en avant.") +
      (when ? " · " + T("lobby.chat_started_ago", "lancée {ago}", { ago: when }) : "");
  }

  /** Bandeau « joueurs de la partie » (roster API, inscrits mis en avant). */
  function renderRoomPlayers() {
    if (!els.players) return;
    if (activeRoom === "global") { els.players.hidden = true; els.players.innerHTML = ""; syncComposer(); return; }
    els.players.hidden = false;
    const cache = playersCache[activeRoom];
    if (!cache) {
      els.players.innerHTML = `<span class="lchat-players-hint">${esc(T("lobby.chat_players_loading", "Joueurs de la partie…"))}</span>`;
      syncComposer();
      return;
    }
    const ps = cache.players || [];
    if (!ps.length) {
      els.players.innerHTML = `<span class="lchat-players-hint">${esc(T("lobby.chat_players_none", "Liste des joueurs pas encore disponible — la partie est peut-être encore en cours."))}</span>`;
      syncComposer();
      return;
    }
    const chips = ps.map((p) => {
      const cls = "lchat-player" + (p.member ? " is-member" : "") + (p.you ? " is-you" : "");
      const badges =
        (p.you ? `<em class="lchat-player-badge is-you">${esc(T("lobby.chat_you_badge", "toi"))}</em>` : "") +
        (p.member ? `<em class="lchat-player-badge" title="${esc(T("lobby.chat_member_title", "Inscrit TheFrontHub"))}">★</em>` : "");
      return `<span class="${cls}">${esc(p.name)}${badges}</span>`;
    }).join("");
    els.players.innerHTML =
      `<span class="lchat-players-title">${esc(T("lobby.chat_players_title", "Joueurs"))} <b>${ps.length}</b></span>` + chips;
    syncComposer();
  }

  /** Composer grisé si l'envoi est refusé dans ce salon (403 not_in_game). */
  function syncComposer() {
    if (!els.input || !els.sendBtn) return;
    const blocked = activeRoom !== "global" && !!me && canPostHere === false;
    els.input.disabled = blocked;
    els.sendBtn.disabled = blocked || sending;
    els.input.placeholder = blocked
      ? T("lobby.chat_blocked_placeholder", "Réservé aux joueurs de cette partie")
      : T("lobby.chat_placeholder", "Écris un message…");
  }

  function renderTabs() {
    // v5.20 : salons SERVEUR (parties du jour, « mine » en tête) + salons LOCAUX suivis.
    const localRooms = gameRooms.filter((r) => !serverRooms.some((s) => s.id === r));
    const srvSorted = serverRooms.slice().sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0));
    const tabs = [["global", roomLabel("global"), unread.global || 0, false, false]]
      .concat(srvSorted.map((r) => [r.id, r.map || roomLabel(r.id), unread[r.id] || 0, false, !!r.mine]))
      .concat(localRooms.map((r) => [r, roomLabel(r), unread[r] || 0, true, false]));
    els.tabs.innerHTML = tabs.map(([room, label, n, closable, mineTag], i) => `
      ${(i === 1) ? `<span class="lchat-tabs-sep" title="${esc(T("lobby.chat_recent_title", "Dernières parties publiques lancées (24 h)"))}">${esc(T("lobby.chat_recent_label", "Parties du jour"))}</span>` : ""}
      <span class="lchat-tab-wrap">
        <button type="button" class="lchat-tab ${room === activeRoom ? "is-active" : ""} ${mineTag ? "is-mine" : ""}"
                data-room="${esc(room)}" title="${esc(label)}">
          <span class="lchat-tab-label">${esc(label)}</span>
          ${mineTag ? `<span class="lchat-tab-mine" title="${esc(T("lobby.chat_mine_title", "Tu as joué dans cette partie"))}" aria-hidden="true"></span>` : ""}
          ${n > 0 ? `<span class="lchat-tab-badge">${n > 99 ? "99+" : n}</span>` : ""}
        </button>
        ${closable ? `<button type="button" class="lchat-tab-close" data-close="${esc(room)}" aria-label="${esc(T("lobby.chat_close_room", "Fermer ce salon"))}">${svgClose}</button>` : ""}
      </span>`).join("");
    els.tabs.querySelectorAll("[data-room]").forEach((b) =>
      b.addEventListener("click", () => switchRoom(b.dataset.room)));
    els.tabs.querySelectorAll("[data-close]").forEach((b) =>
      b.addEventListener("click", () => {
        gameRooms = gameRooms.filter((r) => r !== b.dataset.close);
        save(LS_ROOMS, gameRooms);
        if (activeRoom === b.dataset.close) switchRoom("global");
        else renderTabs();
      }));
  }

  function renderHeaderBadge() {
    if (!headerBtn) return;
    const badge = headerBtn.querySelector("[data-role=header-badge]");
    if (!badge) return;
    const total = Object.entries(unread)
      .filter(([room]) => !(room === activeRoom && isOpen()))
      .reduce((s, [, n]) => s + (n || 0), 0);
    badge.hidden = total === 0;
    badge.textContent = total > 99 ? "99+" : String(total);
  }

  function messageRow(msg, isHistory) {
    const mine = me && Number(msg.user_id) === Number((me && me.id) || -1);
    const row = document.createElement("div");
    row.className = "lchat-msg" + (mine ? " is-mine" : "");
    if (isHistory) row.classList.add("is-history");

    const av = document.createElement("span");
    av.className = "lchat-msg-avatar";
    const url = safeAvatar(msg.avatar);
    if (url) {
      const img = document.createElement("img");
      img.src = url; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      av.appendChild(img);
    } else {
      av.textContent = String(msg.name || "?").slice(0, 1).toUpperCase();
    }

    const bubble = document.createElement("div");
    bubble.className = "lchat-msg-bubble";
    const head = document.createElement("span");
    head.className = "lchat-msg-head";
    head.textContent = String(msg.name || "?");
    const time = document.createElement("span");
    time.className = "lchat-msg-time";
    time.textContent = hhmm(msg.created_at);
    head.appendChild(time);
    const body = document.createElement("p");
    body.className = "lchat-msg-body";
    body.textContent = String(msg.body || "");
    bubble.appendChild(head);
    bubble.appendChild(body);

    row.appendChild(av);
    row.appendChild(bubble);
    return row;
  }

  function appendMessage(msg, isHistory) {
    // remplace l'état loading / marqueur « salon vide » si présents
    const loading = els.msgs.querySelector(".lchat-loading");
    if (loading) loading.remove();
    const emptyHint = els.msgs.querySelector(".lchat-sys.is-empty");
    if (emptyHint) emptyHint.remove();
    const nearBottom = els.msgs.scrollHeight - els.msgs.scrollTop - els.msgs.clientHeight < 80;
    els.msgs.appendChild(messageRow(msg, isHistory));
    // limite mémoire : 250 messages affichés max
    while (els.msgs.children.length > 250) els.msgs.removeChild(els.msgs.firstChild);
    if (nearBottom || isHistory) scrollBottom(false);
  }

  function renderMessages(room, msgs, replace) {
    if (room !== activeRoom) return;
    if (replace) {
      els.msgs.innerHTML = "";
      if (!msgs.length) {
        const empty = document.createElement("div");
        empty.className = "lchat-sys is-empty";
        empty.textContent = T("lobby.chat_empty", "Aucun message pour l'instant — lance la conversation ! 💬");
        els.msgs.appendChild(empty);
      }
    } else {
      const empty = els.msgs.querySelector(".lchat-sys.is-empty");
      if (empty) empty.remove();
    }
    for (const m of msgs) appendMessage(m, replace);
  }

  function sysMessage(text) {
    const el = document.createElement("div");
    el.className = "lchat-sys";
    el.textContent = text;
    els.msgs.appendChild(el);
    scrollBottom(false);
  }

  function scrollBottom(force) {
    if (!force && !stickBottom) return;
    els.msgs.scrollTop = els.msgs.scrollHeight;
  }

  function renderAuthZone() {
    const logged = !!me;
    els.login.hidden = logged;
    els.form.hidden = !logged;
    if (!logged) {
      els.loginText.textContent = T("lobby.chat_login_text", "Le chat est réservé aux joueurs inscrits sur TheFrontHub. Connecte-toi avec Discord en 1 clic pour rejoindre la discussion !");
    }
  }

  /* ── Polling ─────────────────────────────────────────────────────────── */

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      if (isOpen()) {
        pollRoom(activeRoom);
        bgTick = 0;
      } else {
        // fond : badges non-lus, moins fréquent — #général + salons suivis
        // + salons visités (plafonnés pour ne pas marteler l'API).
        if (++bgTick % 8 === 0) {
          const rooms = ["global", ...gameRooms];
          for (const r of visitedRooms) {
            if (r !== "global" && !rooms.includes(r) && rooms.length < 16) rooms.push(r);
          }
          (async () => { for (const r of rooms) await pollRoom(r); })();
        }
      }
    }, POLL_OPEN_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isOpen()) pollRoom(activeRoom);
  });

  /* ── Construction UI ─────────────────────────────────────────────────── */

  function buildUI() {
    if (document.getElementById("lobby-chat-drawer")) return;

    // Bouton « Chat » de la topbar (statique dans lobby.html — démasqué ici).
    // v5.19 : le chat vit DANS la page, à côté du titre Lobby ; plus de bulle
    // flottante (le widget support garde la sienne, en bas à droite).
    headerBtn = document.getElementById("lobby-chat-toggle");
    if (headerBtn) {
      headerBtn.hidden = false;
      headerBtn.addEventListener("click", () => (isOpen() ? closeDrawer() : openDrawer()));
    }

    drawer = document.createElement("section");
    drawer.id = "lobby-chat-drawer";
    drawer.className = "lchat-drawer";
    drawer.hidden = true;
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-label", T("lobby.chat_aria", "Chat communautaire TheFrontHub"));
    drawer.innerHTML = `
      <header class="lchat-head">
        <div class="lchat-head-text">
          <div class="lchat-title">${esc(T("lobby.chat_title", "Chat"))} <span class="lchat-room-label" data-role="room-label"></span></div>
          <div class="lchat-room-desc" data-role="room-desc"></div>
        </div>
        <button type="button" class="lchat-close" aria-label="${esc(T("lobby.chat_close", "Fermer le chat"))}">${svgClose}</button>
      </header>
      <nav class="lchat-tabs" data-role="tabs" aria-label="${esc(T("lobby.chat_tabs_aria", "Salons"))}"></nav>
      <div class="lchat-players" data-role="players" data-lenis-prevent hidden></div>
      <div class="lchat-msgs" data-role="msgs" data-lenis-prevent aria-live="polite"></div>
      <div class="lchat-login" data-role="login" hidden>
        <p data-role="login-text"></p>
        <button type="button" class="lchat-login-btn" data-role="login-btn">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028 14.09 14.09 0 001.226-1.994.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
          ${esc(T("lobby.chat_login_btn", "Connexion Discord"))}
        </button>
      </div>
      <form class="lchat-composer" data-role="form">
        <input type="text" data-role="input" maxlength="500" autocomplete="off"
               placeholder="${esc(T("lobby.chat_placeholder", "Écris un message…"))}"
               aria-label="${esc(T("lobby.chat_input_aria", "Ton message"))}">
        <button type="submit" data-role="send" aria-label="${esc(T("lobby.chat_send_aria", "Envoyer"))}">${svgSend}</button>
      </form>`;

    document.body.appendChild(drawer);

    els = {
      tabs: drawer.querySelector("[data-role=tabs]"),
      players: drawer.querySelector("[data-role=players]"),
      msgs: drawer.querySelector("[data-role=msgs]"),
      login: drawer.querySelector("[data-role=login]"),
      loginText: drawer.querySelector("[data-role=login-text]"),
      loginBtn: drawer.querySelector("[data-role=login-btn]"),
      form: drawer.querySelector("[data-role=form]"),
      input: drawer.querySelector("[data-role=input]"),
      sendBtn: drawer.querySelector("[data-role=send]"),
      roomLabel: drawer.querySelector("[data-role=room-label]"),
      roomDesc: drawer.querySelector("[data-role=room-desc]"),
    };

    drawer.querySelector(".lchat-close").addEventListener("click", closeDrawer);
    els.loginBtn.addEventListener("click", () => {
      if (typeof window.toggleAuthModal === "function") window.toggleAuthModal();
    });
    els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = els.input.value.trim();
      if (!v) return;
      els.input.value = "";
      sendMessage(v);
    });
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        els.form.requestSubmit();
      }
    });

    //Stick-to-bottom : l'utilisateur remonte → on ne scrolle plus auto
    els.msgs.addEventListener("scroll", () => {
      stickBottom = els.msgs.scrollHeight - els.msgs.scrollTop - els.msgs.clientHeight < 80;
    });

    // Salon de partie demandé par lobby.js (bulle chat d'une carte)
    window.addEventListener("tfh:lobby:open-chat", (e) => {
      const gameId = e.detail && e.detail.gameId;
      if (!gameId) return;
      openDrawer("g" + gameId, T("lobby.chat_sys_game", "Salon de la partie — les joueurs inscrits TheFrontHub y sont mis en avant 💬"));
    });

    // v5.19 — démarrage d'une partie que le joueur a lancée : le salon s'ouvre
    // AUTOMATIQUEMENT (lobby-live.js détecte le lancement côté flux OpenFront).
    window.addEventListener("tfh:lobby:my-game-started", (e) => {
      const gameId = e.detail && e.detail.gameId;
      if (!gameId) return;
      const map = e.detail && e.detail.map;
      if (map) {
        // La partie peut avoir déjà quitté la liste : on mémorise le nom de
        // la carte transmis par lobby-live pour un libellé de salon propre.
        roomMeta["g" + gameId] = { map };
        save("tfh_lobbychat_meta_v1", roomMeta);
      }
      openDrawer("g" + gameId, T("lobby.chat_sys_started", "Ta partie démarre — ce salon réunit ses joueurs (les inscrits TheFrontHub y sont mis en avant). Bonne chance ! 🎮"));
    });
  }

  /* ── Boot ────────────────────────────────────────────────────────────── */

  async function boot() {
    buildUI();
    await fetchMe();
    renderAuthZone();
    const last = load(LS_LAST, "global");
    await switchRoom(gameRooms.includes(last) || last === "global" ? last : "global");
    startPolling();
    renderHeaderBadge();
    // v5.20 : salons « parties du jour » — au chargement, puis régulièrement.
    fetchRooms();
    roomsTimer = setInterval(() => {
      if (!document.hidden) fetchRooms();
    }, ROOMS_REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
