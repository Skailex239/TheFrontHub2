// chat-widget.js — Widget chat flottant joueur ↔ équipe (toutes pages)
//
// Petite bulle ronde en bas à droite du site ; clic → panneau de discussion
// avec l'équipe TheFrontHub (API : /api/chat.php, voir agent-ctx/CONTRAT-SUPPORT-2026.md).
// - Session Discord obligatoire : si non connecté, le panneau affiche un
//   écran « Connecte-toi » (le login réutilise window.handleLogin('discord')
//   si elle existe, sinon la redirection OAuth directe).
// - Polling « quasi temps réel » : 2,5 s panneau ouvert, 20 s fermé
//   (uniquement pour le badge de messages non lus de l'équipe).
// - Envoi optimiste (id négatif temporaire) puis resynchronisé par le poll ;
//   un Set des ids rendus évite les doublons.
// - Zéro dépendance, chargé en <script defer> sur toutes les pages :
//   s'il n'existe pas (bloqueur, cache ancien), le site fonctionne normalement.
// - L'API /api/ n'est JAMAIS mise en cache (le SW la bypass déjà) : rien à faire.

(function () {
  "use strict";

  /* ── i18n (moteur global i18n.js — clés cw.* dans i18n-dict-support.js) ──
     T(k, fb) : traduit via window.t, retombe sur le texte FR si i18n absent.
     TK : retombe AUSSI sur le fallback quand la clé manque du dictionnaire
     (pages ne chargeant pas i18n-dict-support.js → window.t renverrait la clé). */
  const T = (k, fb) => (typeof window.t === "function" ? window.t(k) : fb);
  const TK = (k, fb) => {
    const v = T(k, fb);
    return v === k || v == null ? fb : v;
  };

  /* ── Réglages ─────────────────────────────────────────────────────────── */
  var API           = "/api/chat.php";
  var LS_LASTID     = "tfh:chatwidget:lastid";
  var LS_UNREAD     = "tfh:chatwidget:unread";
  var LOGIN_URL     = "/api/auth/discord/login.php";  // chemin réel (api/auth/discord/login.php)
  var POLL_OPEN_MS  = 2500;    // panneau ouvert  → quasi temps réel
  var POLL_CLOSED_MS = 20000;  // panneau fermé   → badge uniquement
  var RENDER_LIMIT  = 100;     // historique rendu au 1er open (les 100 derniers)
  var MIN_VW        = 340;     // sous cette largeur : la bulle ne s'affiche pas
  var NAV_FALLBACK  = 76;      // hauteur bottom-nav ~73px si la mesure échoue

  /* ── État ─────────────────────────────────────────────────────────────── */
  var bubble   = null;
  var panel    = null;
  var isOpen   = false;
  var authed   = false;        // state répondu OK au moins une fois
  var meName   = "";
  var lastId   = 0;
  var unread   = 0;
  var rendered = new Set();    // ids déjà affichés (anti-doublon / resync optimiste)
  var pollTimer = null;
  var sending   = false;

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* navigation privée */ } }

  var root = document.documentElement;

  /* ── Badge « messages de l'équipe non lus » ───────────────────────────── */
  function setUnread(n) {
    unread = Math.max(0, n);
    lsSet(LS_UNREAD, String(unread));
    updateBadge();
  }
  function updateBadge() {
    if (!bubble) return;
    var badge = bubble.querySelector(".tfh-cw-badge");
    if (badge) badge.hidden = !(unread > 0) || isOpen;
  }

  /* ── Bottom-nav : hauteur réelle mesurée → variable CSS (mobile) ────────
     ≤768px la sidebar devient la bottom-nav (padding 8px + items 56px ≈ 73px).
     On mesure son offsetHeight et on pose --tfh-cw-nav pour que la bulle et
     le panneau se posent juste au-dessus, quelle que soit la vraie hauteur. */
  function syncNavHeight() {
    if (!root) return;
    if (window.innerWidth > 768) { root.style.removeProperty("--tfh-cw-nav"); return; }
    var sb = document.querySelector(".sidebar");
    var h = sb ? sb.offsetHeight : 0;
    root.style.setProperty("--tfh-cw-nav", (h > 0 ? h : NAV_FALLBACK) + "px");
  }

  /* ── Bulle ────────────────────────────────────────────────────────────── */
  function injectBubble() {
    if (document.getElementById("tfh-cw-bubble")) return;

    bubble = document.createElement("button");
    bubble.type = "button";
    bubble.id = "tfh-cw-bubble";
    bubble.className = "tfh-cw-bubble";
    bubble.setAttribute("aria-label", TK("cw.bubble_aria", "Ouvrir le chat avec l'équipe"));
    bubble.setAttribute("aria-expanded", "false");
    bubble.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
      "</svg>" +
      '<span class="tfh-cw-badge" hidden></span>';

    bubble.addEventListener("click", toggle);

    document.body.appendChild(bubble);
    updateBadge();
    syncVisibility();
  }

  /* Improbable (<340px de large) : on masque la bulle proprement. */
  function syncVisibility() {
    if (!bubble) return;
    var tooNarrow = window.innerWidth < MIN_VW;
    bubble.hidden = tooNarrow;
    if (tooNarrow && isOpen) closePanel();
  }

  /* ── Panneau ──────────────────────────────────────────────────────────── */
  function buildPanel() {
    if (panel || document.getElementById("tfh-cw-panel")) return;

    panel = document.createElement("div");
    panel.id = "tfh-cw-panel";
    panel.className = "tfh-cw-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", TK("cw.panel_aria", "Chat avec l'équipe"));
    panel.hidden = true;

    panel.innerHTML =
      '<div class="tfh-cw-head">' +
        '<div class="tfh-cw-head-txt">' +
          '<div class="tfh-cw-title">' + TK("cw.title", "Chat avec l\u2019équipe") + "</div>" +
          '<div class="tfh-cw-status"><span class="tfh-cw-dot" aria-hidden="true"></span>' + TK("cw.status", "L\u2019équipe répond en direct") + "</div>" +
        "</div>" +
        '<span class="tfh-cw-me" hidden></span>' +
        '<button type="button" class="tfh-cw-min" aria-label="' + TK("cw.min_aria", "Réduire le chat") + '" title="' + TK("cw.min_title", "Réduire") + '">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>' +
        "</button>" +
      "</div>" +
      '<div class="tfh-cw-error" role="alert" hidden></div>' +
      '<div class="tfh-cw-scroll" aria-live="polite"></div>' +
      '<div class="tfh-cw-gate" hidden>' +
        '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
        "</svg>" +
        '<p class="tfh-cw-gate-txt">' + TK("cw.gate_text", "Connecte-toi avec Discord pour discuter avec l\u2019équipe") + "</p>" +
        '<button type="button" class="tfh-cw-login">' + TK("cw.login", "Se connecter") + "</button>" +
      "</div>" +
      '<form class="tfh-cw-composer">' +
        '<textarea class="tfh-cw-input" rows="1" maxlength="2000" placeholder="' + TK("cw.placeholder", "Écris ton message…") + '" aria-label="' + TK("cw.input_aria", "Ton message") + '"></textarea>' +
        '<button type="submit" class="tfh-cw-send" aria-label="' + TK("cw.send_aria", "Envoyer le message") + '">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>' +
        "</button>" +
      "</form>";

    document.body.appendChild(panel);

    panel.querySelector(".tfh-cw-min").addEventListener("click", closePanel);
    panel.querySelector(".tfh-cw-login").addEventListener("click", doLogin);
    panel.querySelector(".tfh-cw-composer").addEventListener("submit", onSubmit);

    var ta = panel.querySelector(".tfh-cw-input");
    ta.addEventListener("input", autoResize);
    ta.addEventListener("keydown", function (e) {
      // Entrée = envoyer, Shift+Entrée = saut de ligne
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit(e);
      }
    });
  }

  /* ── Connexion Discord (gate 401) ─────────────────────────────────────── */
  function doLogin() {
    if (typeof window.handleLogin === "function") {
      window.handleLogin("discord");
    } else {
      window.location.href = LOGIN_URL;
    }
  }

  /* ── UI helpers ───────────────────────────────────────────────────────── */
  function scroll() {
    if (!panel) return;
    var el = panel.querySelector(".tfh-cw-scroll");
    if (el) el.scrollTop = el.scrollHeight;
  }
  function showError(msg) {
    if (!panel) return;
    var el = panel.querySelector(".tfh-cw-error");
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else el.hidden = true;
  }
  function setLoader(msg) {
    if (!panel) return;
    var el = panel.querySelector(".tfh-cw-scroll");
    if (el && el.children.length === 0) el.innerHTML = '<p class="tfh-cw-loading">' + msg + "</p>";
  }
  function clearLoader() {
    if (!panel) return;
    var el = panel.querySelector(".tfh-cw-scroll");
    var ld = el && el.querySelector(".tfh-cw-loading");
    if (ld) ld.remove();
  }
  function setComposerEnabled(on) {
    if (!panel) return;
    var ta = panel.querySelector(".tfh-cw-input");
    var btn = panel.querySelector(".tfh-cw-send");
    if (ta) ta.disabled = !on;
    if (btn) btn.disabled = !on;
  }
  function focusComposer() {
    if (!panel || !isOpen) return;
    var ta = panel.querySelector(".tfh-cw-input");
    if (ta && !ta.disabled) setTimeout(function () { ta.focus(); }, 60);
  }

  /* ── API ──────────────────────────────────────────────────────────────── */
  function apiGet(params) {
    return fetch(API + "?" + params, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  }

  /* Premier open : état de session → historique récent. */
  function connect() {
    authed = false;
    setComposerEnabled(false);
    showError("");
    setLoader(TK("cw.connecting", "Connexion au chat…"));

    apiGet("action=state").then(function (res) {
      if (res.status === 401) { showGate(); return null; }
      return res.json();
    }).then(function (data) {
      if (!data) return;                       // gate affiché
      if (!data.ok) { showError(TK("cw.err_unavailable", "Chat indisponible pour le moment.")); setLoader(""); return; }

      authed = true;
      meName = (data.me && data.me.name) || "";
      // Le serveur fait foi (une DB réinitialisée reprend à 0).
      lastId = parseInt(data.last_id, 10) || 0;
      lsSet(LS_LASTID, String(lastId));

      clearLoader();
      showChatUI();
      setComposerEnabled(true);
      focusComposer();                 // 1er open : focus après connexion

      // Historique : tous les messages de la conversation → 100 derniers rendus.
      apiGet("action=poll&since=0").then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (d && d.ok) ingest(d, { initial: true });
      }).catch(function () { /* silencieux — retry au prochain tick */ });
    }).catch(function () {
      clearLoader();
      showError(TK("cw.err_network", "Connexion impossible — vérifie ta connexion internet."));
    });
  }

  function showGate() {
    if (!panel) return;
    clearLoader();
    showError("");
    panel.querySelector(".tfh-cw-scroll").hidden = true;
    panel.querySelector(".tfh-cw-gate").hidden = false;
    panel.querySelector(".tfh-cw-composer").hidden = true;
    panel.querySelector(".tfh-cw-me").hidden = true;
  }

  function showChatUI() {
    if (!panel) return;
    panel.querySelector(".tfh-cw-scroll").hidden = false;
    panel.querySelector(".tfh-cw-gate").hidden = true;
    panel.querySelector(".tfh-cw-composer").hidden = false;
    var me = panel.querySelector(".tfh-cw-me");
    if (meName) { me.textContent = meName; me.hidden = false; }
  }

  /* Intègre une réponse poll : rendu + anti-doublon + lastId + badge. */
  function ingest(data, opts) {
    opts = opts || {};
    var msgs = (data.messages && data.messages.length) ? data.messages : [];

    if (opts.initial) {
      // Historique complet reçu → on ne rend que les RENDER_LIMIT derniers.
      msgs = msgs.slice(-RENDER_LIMIT);
    }

    var fresh = [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m && typeof m.id === "number" && !rendered.has(m.id)) fresh.push(m);
    }

    if (fresh.length && panel) {
      var el = panel.querySelector(".tfh-cw-scroll");
      var nearBottom = el ? (el.scrollHeight - el.scrollTop - el.clientHeight < 120) : true;
      for (var j = 0; j < fresh.length; j++) appendMessage(fresh[j]);
      if (isOpen && (nearBottom || opts.forceScroll)) scroll();
    }

    // lastId : uniquement le max VRAI serveur (les ids optimistes sont négatifs).
    var serverLast = parseInt(data.last_id, 10) || 0;
    if (serverLast > lastId) { lastId = serverLast; lsSet(LS_LASTID, String(lastId)); }

    // Badge : réponses de l'équipe reçues panneau fermé → non lus.
    if (!isOpen) {
      var added = 0;
      for (var k = 0; k < fresh.length; k++) if (fresh[k].role === "admin") added++;
      if (added > 0) setUnread(unread + added);
    }
  }

  /* Un message → un nœud DOM. */
  function appendMessage(m) {
    if (!panel) return;
    var el = panel.querySelector(".tfh-cw-scroll");
    if (!el) return;
    var loading = el.querySelector(".tfh-cw-loading");
    if (loading) loading.remove();

    var isUser = m.role === "user";
    var div = document.createElement("div");
    div.className = "tfh-cw-msg" + (isUser ? " is-user" : " is-admin") + (m.pending ? " is-pending" : "");
    if (m.pending) div.__tfhTempId = m.id;   // pour retirer le bon optimiste

    var head = "";
    if (!isUser && m.name) head += '<span class="tfh-cw-msg-name"></span>';
    if (m.created_at) head += '<span class="tfh-cw-msg-time">' + esc(String(m.created_at).slice(11, 16)) + "</span>";

    var inner = document.createElement("div");
    inner.className = "tfh-cw-msg-bubble";
    if (head) {
      var h = document.createElement("div");
      h.className = "tfh-cw-msg-head";
      h.innerHTML = head;
      inner.appendChild(h);
    }
    var body = document.createElement("div");
    body.className = "tfh-cw-msg-body";
    body.textContent = m.body || "";
    inner.appendChild(body);

    div.appendChild(inner);
    el.appendChild(div);
  }

  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ── Polling (setTimeout chaîné : le délai dépend de l'état ouvert/fermé) ── */
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, isOpen ? POLL_OPEN_MS : POLL_CLOSED_MS);
  }

  function tick() {
    if (!authed) { schedulePoll(); return; }   // pas encore connecté → rien à espérer
    apiGet("action=poll&since=" + lastId).then(function (res) {
      if (res.status === 401) { authed = false; schedulePoll(); return; }
      return res.json();
    }).then(function (data) {
      if (data && data.ok) ingest(data, {});
    }).catch(function () {
      /* erreur réseau silencieuse → retry au prochain tick */
    }).then(schedulePoll);                     // toujours re-programmer
  }

  /* ── Envoi (optimiste → resync par le poll) ───────────────────────────── */
  function onSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!panel || sending || !authed) return;

    var ta = panel.querySelector(".tfh-cw-input");
    var content = (ta.value || "").trim();
    if (!content) return;

    sending = true;
    showError("");
    ta.value = "";
    autoResize();

    var tempId = -Date.now();
    rendered.add(tempId);
    appendMessage({ id: tempId, role: "user", name: meName, body: content, pending: true });
    scroll();

    fetch(API, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", content: content }),
    }).then(function (res) {
      if (res.status === 401) { authed = false; showGate(); throw new Error("auth"); }
      return res.json();
    }).then(function (data) {
      sending = false;
      // Retire l'optimiste (le poll ramènera le vrai message, id positif).
      removeTemp(tempId);
      if (data && data.ok && data.message) {
        var msg = data.message;
        msg.role = msg.role || "user";
        if (typeof msg.id === "number" && !rendered.has(msg.id)) {
          appendMessage(msg);
          rendered.add(msg.id);
          if (msg.id > lastId) { lastId = msg.id; lsSet(LS_LASTID, String(lastId)); }
        }
        scroll();
      } else {
        sendFailed(content);
      }
    }).catch(function () {
      sending = false;
      removeTemp(tempId);
      sendFailed(content);
    });
  }

  function removeTemp(tempId) {
    rendered.delete(tempId);
    if (!panel) return;
    var el = panel.querySelector(".tfh-cw-scroll");
    var nodes = el.querySelectorAll(".tfh-cw-msg.is-pending");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].__tfhTempId === tempId) nodes[i].remove();
    }
  }

  function sendFailed(content) {
    // Remets le texte dans le champ pour ne rien faire retaper.
    if (panel) {
      var ta = panel.querySelector(".tfh-cw-input");
      if (ta && !ta.value) { ta.value = content; autoResize(); }
    }
    if (typeof window.showToast === "function") {
      window.showToast(TK("cw.err_send_toast", "Message non envoyé — vérifie ta connexion."), "error");
    } else {
      showError(TK("cw.err_send_panel", "Message non envoyé — réessaie."));
    }
  }

  /* ── Textarea auto-resize (1 → 4 lignes) ──────────────────────────────── */
  function autoResize() {
    if (!panel) return;
    var ta = panel.querySelector(".tfh-cw-input");
    if (!ta) return;
    ta.style.height = "auto";
    var max = 4 * 20 + 2 * 10;                 // 4 lignes × line-height 20px + padding
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }

  /* ── Open / close / toggle ────────────────────────────────────────────── */
  function openPanel() {
    if (!bubble || bubble.hidden) return;
    buildPanel();
    isOpen = true;
    panel.hidden = false;
    bubble.setAttribute("aria-expanded", "true");
    bubble.classList.add("is-open");
    syncNavHeight();

    setUnread(0);                              // panneau ouvert → tout est lu
    if (!authed) connect();
    else { showChatUI(); scroll(); }

    schedulePoll();                            // repasse à 2,5 s
    focusComposer();
  }

  function closePanel() {
    if (!panel) { isOpen = false; return; }
    isOpen = false;
    panel.hidden = true;
    if (bubble) {
      bubble.setAttribute("aria-expanded", "false");
      bubble.classList.remove("is-open");
      updateBadge();
    }
    schedulePoll();                            // repasse à 20 s (badge)
  }

  function toggle() { isOpen ? closePanel() : openPanel(); }

  /* ── Boot ─────────────────────────────────────────────────────────────── */
  function init() {
    // Persistance reprise avant tout (surchargée par le serveur au connect()).
    var storedLast = parseInt(lsGet(LS_LASTID) || "0", 10);
    if (storedLast > 0) lastId = storedLast;
    var storedUnread = parseInt(lsGet(LS_UNREAD) || "0", 10);
    if (storedUnread > 0) unread = storedUnread;

    injectBubble();
    syncNavHeight();

    // Escape ferme le panneau.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) closePanel();
    });

    var onResize = function () { syncVisibility(); syncNavHeight(); };
    window.addEventListener("resize", onResize);
    // La bottom-nav peut changer de hauteur après polices/drawer → re-mesure.
    setTimeout(syncNavHeight, 300);
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(syncNavHeight).catch(function () {});
    }

    // Boucle de polling démarrée en mode « fermé » (20 s) dès le chargement.
    schedulePoll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* ── API publique ─────────────────────────────────────────────────────── */
  window.TfhChatWidget = { open: openPanel, close: closePanel, toggle: toggle };
})();
