/**
 * lobby-chat.js — v5.18 — Chat communautaire du Lobby TheFrontHub.
 *
 * Backend : api/lobby-chat.php (MySQL, polling ~3 s). ACCÈS RÉSERVÉ AUX
 * COMPTES (session Discord — « inscrits sur le site ») : le visiteur
 * déconnecté voit l'encart « Connecte-toi avec Discord ».
 *
 * Salons :
 *   - global     → #Général (tout le monde)
 *   - g<gameID>  → salon d'une partie.lobby.js émet « tfh:lobby:open-chat »
 *                  quand le joueur clique une carte (lancement de partie) ou
 *                  la bulle chat d'une carte → le drawer s'ouvre sur le salon
 *                  de la partie : « un chat s'ouvre avec les gens de la partie ».
 *
 * UI : bouton flottant en bas à GAUCHE (le chat support occupe la droite),
 * drawer latéral (desktop) / bottom-sheet (mobile), onglets de salons avec
 * badges non-lus, historique 50 messages, polling 3 s panneau ouvert +
 * 25 s en fond pour les badges. Zéro dépendance, IIFE autonome.
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
  const MAX_GAME_ROOMS = 8;

  /* ── État ────────────────────────────────────────────────────────────── */
  const load = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };

  let me = null;                                // { name, avatar } si connecté
  let activeRoom = "global";
  let gameRooms = load(LS_ROOMS, []);           // ["gAb12…", …]
  let since = {};                               // room → dernier id reçu
  let unread = {};                              // room → nb non lus
  let roomMeta = load("tfh_lobbychat_meta_v1", {}); // room → { map }
  let pollTimer = null;
  let bgTick = 0;
  let sending = false;
  let stickBottom = true;

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  let fab = null, drawer = null, els = {};

  const svgChat = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  const svgSend = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  const svgClose = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  function roomLabel(room) {
    if (room === "global") return T("lobby.chat_room_global", "#Général");
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
        renderFabBadge();
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

  function openDrawer(room) {
    if (room) switchRoom(room);
    drawer.hidden = false;
    fab.classList.add("is-open");
    renderFabBadge();
    if (me) setTimeout(() => els.input.focus(), 120);
    startPolling();
  }

  function closeDrawer() {
    drawer.hidden = true;
    fab.classList.remove("is-open");
    renderFabBadge();
  }

  async function switchRoom(room) {
    if (room !== "global") { rememberGameRoom(room); resolveGameMeta(String(room).slice(1)); }
    activeRoom = room;
    save(LS_LAST, room);
    unread[room] = 0;
    renderTabs();
    renderRoomHeader();
    els.msgs.innerHTML = `<div class="lchat-loading"><div class="spinner"></div></div>`;
    const r = await loadHistory(room);
    if (r && r.auth) renderAuthZone();
    scrollBottom(true);
    renderFabBadge();
  }

  function renderRoomHeader() {
    els.roomLabel.textContent = roomLabel(activeRoom);
    els.roomDesc.textContent = activeRoom === "global"
      ? T("lobby.chat_desc_global", "Le salon de toute la communauté TheFrontHub")
      : T("lobby.chat_desc_game", "Le chat des inscrits qui lancent cette partie — discutez stratégie avant de commencer !");
  }

  function renderTabs() {
    const tabs = [["global", roomLabel("global"), unread.global || 0, false]]
      .concat(gameRooms.map((r) => [r, roomLabel(r), unread[r] || 0, true]));
    els.tabs.innerHTML = tabs.map(([room, label, n, closable]) => `
      <span class="lchat-tab-wrap">
        <button type="button" class="lchat-tab ${room === activeRoom ? "is-active" : ""}" data-room="${esc(room)}">
          <span class="lchat-tab-label">${esc(label)}</span>
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

  function renderFabBadge() {
    const total = Object.entries(unread)
      .filter(([room]) => !(room === activeRoom && isOpen()))
      .reduce((s, [, n]) => s + (n || 0), 0);
    let badge = fab.querySelector(".lchat-fab-badge");
    if (total > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "lchat-fab-badge";
        fab.appendChild(badge);
      }
      badge.textContent = total > 99 ? "99+" : String(total);
    } else if (badge) {
      badge.remove();
    }
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
    // remplace l'état loading si présent
    const loading = els.msgs.querySelector(".lchat-loading");
    if (loading) loading.remove();
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
        empty.className = "lchat-sys";
        empty.textContent = T("lobby.chat_empty", "Aucun message pour l'instant — lance la conversation ! 💬");
        els.msgs.appendChild(empty);
      }
    } else {
      const empty = els.msgs.querySelector(".lchat-sys");
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
        // fond : badges non-lus, moins fréquent
        if (++bgTick % 8 === 0) {
          const rooms = ["global", ...gameRooms];
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
    if (document.getElementById("lobby-chat-fab")) return;

    fab = document.createElement("button");
    fab.type = "button";
    fab.id = "lobby-chat-fab";
    fab.className = "lchat-fab";
    fab.setAttribute("aria-label", T("lobby.chat_fab_aria", "Ouvrir le chat communautaire"));
    fab.title = T("lobby.chat_fab_title", "Chat communautaire");
    fab.innerHTML = svgChat;
    fab.addEventListener("click", () => (isOpen() ? closeDrawer() : openDrawer()));

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
      <div class="lchat-msgs" data-role="msgs" aria-live="polite"></div>
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

    document.body.appendChild(fab);
    document.body.appendChild(drawer);

    els = {
      tabs: drawer.querySelector("[data-role=tabs]"),
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

    // Salon de partie demandé par lobby.js (clic carte / bulle chat)
    window.addEventListener("tfh:lobby:open-chat", (e) => {
      const gameId = e.detail && e.detail.gameId;
      if (!gameId) return;
      openDrawer("g" + gameId);
      if (me) sysMessage(T("lobby.chat_sys_game", "Salon de la partie — les inscrits TheFrontHub qui la rejoignent arrivent ici 💬"));
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
    renderFabBadge();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
