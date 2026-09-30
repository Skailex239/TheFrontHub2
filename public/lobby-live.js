/**
 * lobby-live.js — v5.18 — Bandeau LIVE du lobby TheFrontHub.
 *
 * Module compagnon de lobby.js (qui publie l'event window « tfh:lobby:update »
 * à chaque snapshot/counts). Il ajoute au-dessus des cartes :
 *
 *   1. Compteurs animés      → joueurs en lobby, parties ouvertes, presque pleines
 *   2. Stats par mode        → chips FFA / Team / Spécial / Classé (parties + joueurs)
 *   3. Courbe d'activité     → canvas, historique 24 h en localStorage, ranges 1h/6h/24h
 *   4. Alertes (bell 18/22)  → notification navigateur + son WebAudio quand
 *                              une partie correspondant aux filtres s'ouvre,
 *                              ou quand un lobby surveillé (« préviens-moi
 *                              quand ce lobby est plein ») devient pleine.
 *
 * Tout est client-side : aucune dépendance serveur, aucune lib. Les réglages
 * persistent dans localStorage. Chargé en script autonome (IIFE, defer).
 */
(function () {
  "use strict";

  /* ── i18n (même convention que lobby.js) ─────────────────────────────── */
  const T = (k, fb, params) => (typeof window.t === "function" ? window.t(k, params) : fb);
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  /* ── Constantes ──────────────────────────────────────────────────────── */
  const LS_ALERTS = "tfh_lobby_alerts_v1";
  const LS_WATCH  = "tfh_lobby_watch_v1";
  const LS_HIST   = "tfh_lobby_hist_v1";
  const SAMPLE_MIN_MS   = 20_000;          // 1 échantillon courbe / 20 s max
  const HIST_TTL        = 24 * 3600_000;   // fenêtre historique : 24 h
  const HIST_MAX_POINTS = 3_000;
  const WATCH_TTL       = 3 * 3600_000;    // une surveillance expire après 3 h
  const WATCH_GONE_MS   = 5 * 60_000;      // partie absente > 5 min → dé-surveillance
  const MODES = ["ffa", "team", "special"];

  /* ── État persistant ─────────────────────────────────────────────────── */
  const load = (k, fb) => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; }
    catch { return fb; }
  };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };

  const settings = Object.assign({ enabled: false, mode: "all", minPlayers: 0 }, load(LS_ALERTS, {}));
  let watch   = load(LS_WATCH, {});       // { gameId: { map, mode, addedAt, lastSeen } }
  let history = load(LS_HIST, []);        // [[ts, players, games], …]
  const firedFull = new Set();            // ids déjà notifiés « pleine » (session)
  let seenIds = null;                     // ids du snapshot précédent (détection nouvelles)
  let lastSample = 0;
  let range = 6;                          // heures affichées (1 | 6 | 24)

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  let strip = null;
  let els = {};
  let anim = { players: 0, games: 0, almost: 0, started: false };

  function cssVar(name, fb) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  }

  /* ══════════════════════════════════════════════════════════════════════
     Métriques
     ══════════════════════════════════════════════════════════════════════ */

  function computeMetrics(games) {
    let players = 0, total = 0, almost = 0, ranked = 0;
    const perMode = { ffa: { g: 0, p: 0 }, team: { g: 0, p: 0 }, special: { g: 0, p: 0 } };
    for (const k of MODES) {
      for (const g of games[k] || []) {
        const cfg = g.gameConfig || {};
        const cap = Number(cfg.maxPlayers) || 0;
        const n = Number(g.numClients) || 0;
        players += n; total++;
        perMode[k].g++; perMode[k].p += n;
        if (cfg.rankedType) ranked++;
        if (cap > 0 && n < cap && n / cap >= 0.8) almost++;
      }
    }
    return { players, total, almost, ranked, perMode };
  }

  /* ══════════════════════════════════════════════════════════════════════
     Compteurs animés
     ══════════════════════════════════════════════════════════════════════ */

  function animateNum(el, from, to) {
    if (from === to) { el.textContent = String(to); return; }
    const t0 = performance.now(), dur = 380;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(from + (to - from) * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderCounters(m) {
    if (!els.players) return;
    if (!anim.started) {
      anim = { players: m.players, games: m.total, almost: m.almost, started: true };
      els.players.textContent = String(m.players);
      els.games.textContent = String(m.total);
      els.almost.textContent = String(m.almost);
      return;
    }
    animateNum(els.players, anim.players, m.players);
    animateNum(els.games, anim.games, m.total);
    animateNum(els.almost, anim.almost, m.almost);
    anim = { players: m.players, games: m.total, almost: m.almost, started: true };
  }

  /* ══════════════════════════════════════════════════════════════════════
     Stats par mode (chips)
     ══════════════════════════════════════════════════════════════════════ */

  const MODE_LABEL = {
    ffa: () => T("lobby.filter_ffa", "FFA"),
    team: () => T("lobby.filter_team", "Team"),
    special: () => T("lobby.filter_special", "Spécial"),
    ranked: () => T("lobby.ranked_short", "Classé"),
  };

  function renderModes(m) {
    if (!els.modes) return;
    const parts = [];
    for (const k of MODES) {
      if (m.perMode[k].g > 0) {
        parts.push(`<span class="llive-chip"><b>${esc(MODE_LABEL[k]())}</b> ${m.perMode[k].g} · ${m.perMode[k].p} <span class="llive-chip-p">${esc(T("lobby.players_unit", "jrs"))}</span></span>`);
      }
    }
    if (m.ranked > 0) {
      parts.push(`<span class="llive-chip is-ranked"><b>${esc(MODE_LABEL.ranked())}</b> ${m.ranked}</span>`);
    }
    els.modes.innerHTML = parts.join("");
  }

  /* ══════════════════════════════════════════════════════════════════════
     Courbe d'activité (canvas)
     ══════════════════════════════════════════════════════════════════════ */

  function sampleHistory(m) {
    const now = Date.now();
    if (now - lastSample < SAMPLE_MIN_MS) return;
    lastSample = now;
    history.push([now, m.players, m.total]);
    const cutoff = now - HIST_TTL;
    while (history.length && history[0][0] < cutoff) history.shift();
    if (history.length > HIST_MAX_POINTS) history = history.slice(-HIST_MAX_POINTS);
    save(LS_HIST, history);
    drawCurve();
  }

  function drawCurve() {
    const cv = els.curve;
    if (!cv || !cv.isConnected) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const wCss = cv.clientWidth || cv.parentElement.clientWidth || 600;
    const hCss = 150;
    if (cv.width !== Math.round(wCss * dpr) || cv.height !== Math.round(hCss * dpr)) {
      cv.width = Math.round(wCss * dpr);
      cv.height = Math.round(hCss * dpr);
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wCss, hCss);

    const now = Date.now();
    const from = now - range * 3600_000;
    const pts = history.filter((p) => p[0] >= from);
    const fgMuted = cssVar("--fg-muted", "#71717A");
    const border = cssVar("--border", "#E4E4E7");
    const accent = cssVar("--accent", "#FF6B00");
    const accentSubtle = cssVar("--accent-subtle", "#FFF4ED");
    const fg = cssVar("--fg", "#18181B");

    ctx.font = "11px " + cssVar("--f", "Inter, sans-serif");

    if (pts.length < 2) {
      ctx.fillStyle = fgMuted;
      ctx.textAlign = "center";
      ctx.fillText(T("lobby.curve_warmup", "Les données s'accumulent — la courbe se dessine dans quelques minutes."), wCss / 2, hCss / 2);
      if (els.curveEmpty) els.curveEmpty.hidden = true;
      return;
    }
    if (els.curveEmpty) els.curveEmpty.hidden = true;

    let maxY = 0;
    for (const p of pts) maxY = Math.max(maxY, p[1]);
    maxY = Math.max(8, Math.ceil((maxY * 1.15) / 8) * 8);
    const padL = 30, padR = 10, padT = 12, padB = 20;
    const iw = wCss - padL - padR, ih = hCss - padT - padB;
    const x = (t) => padL + ((t - from) / (now - from)) * iw;
    const y = (v) => padT + ih - (v / maxY) * ih;

    // Grille + labels Y
    ctx.strokeStyle = border;
    ctx.fillStyle = fgMuted;
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = Math.round((maxY / steps) * i);
      const yy = y(v);
      ctx.beginPath();
      ctx.moveTo(padL, yy); ctx.lineTo(wCss - padR, yy);
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(String(v), padL - 6, yy + 3);
    }

    // Aire + ligne
    ctx.beginPath();
    ctx.moveTo(x(pts[0][0]), y(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(x(pts[i][0]), y(pts[i][1]));
    const last = pts[pts.length - 1];
    ctx.lineTo(x(last[0]), padT + ih);
    ctx.lineTo(x(pts[0][0]), padT + ih);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, accentSubtle);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x(pts[0][0]), y(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(x(pts[i][0]), y(pts[i][1]));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Point « maintenant »
    ctx.beginPath();
    ctx.arc(x(last[0]), y(last[1]), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x(last[0]), y(last[1]), 6.5, 0, Math.PI * 2);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Labels X (il y a « range » h / maintenant)
    ctx.fillStyle = fgMuted;
    ctx.textAlign = "left";
    ctx.fillText(`-${range}h`, padL, hCss - 6);
    ctx.textAlign = "right";
    ctx.fillStyle = fg;
    ctx.fillText(T("lobby.curve_now", "maintenant"), wCss - padR, hCss - 6);
  }

  /* ══════════════════════════════════════════════════════════════════════
     Son (WebAudio — deux notes douces, pas de fichier)
     ══════════════════════════════════════════════════════════════════════ */

  let audioCtx = null;
  function ensureAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    } catch { return null; }
  }

  function beep() {
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
      const t0 = ctx.currentTime + 0.01;
      [[880, 0.00, 0.14], [1318.5, 0.16, 0.24]].forEach(([freq, off, dur]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + off);
        gain.gain.exponentialRampToValueAtTime(0.16, t0 + off + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + off);
        osc.stop(t0 + off + dur + 0.05);
      });
    } catch { /* audio indisponible : silencieux */ }
  }

  /* ══════════════════════════════════════════════════════════════════════
     Alertes — notifications + moteur
     ══════════════════════════════════════════════════════════════════════ */

  function notify(title, body, tag) {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification(title, { body, tag, icon: "favicon-180x180.png" });
        setTimeout(() => { try { n.close(); } catch { /* ignore */ } }, 10_000);
      }
    } catch { /* ignore */ }
    window.showToast?.(title + (body ? " — " + body : ""), "info", 7000, "bell");
  }

  function gameLabel(g) {
    const cfg = g.gameConfig || {};
    return String(cfg.gameMap || "?").slice(0, 24);
  }

  /** Une partie passe-t-elle les filtres d'alerte (mode, joueurs min) ? */
  function matchesFilters(g) {
    if (settings.minPlayers > 0 && (Number(g.numClients) || 0) < settings.minPlayers) return false;
    if (settings.mode === "all") return true;
    if (settings.mode === "ranked") return !!(g.gameConfig || {}).rankedType;
    return (g.publicGameType !== "special") === false
      ? settings.mode === "special"
      : settings.mode === (isTeam(g) ? "team" : "ffa");
  }

  function isTeam(g) {
    // catégorie portée par le tableau source : ffa | team | special
    return g.__tfhBucket === "team";
  }

  function annotateBuckets(games) {
    for (const k of MODES) for (const g of games[k] || []) g.__tfhBucket = k;
  }

  function findGameById(games, id) {
    for (const k of MODES) {
      const found = (games[k] || []).find((g) => String(g.gameID || g.id) === String(id));
      if (found) return found;
    }
    return null;
  }

  function allGames(games) {
    return [...(games.ffa || []), ...(games.team || []), ...(games.special || [])];
  }

  /** Moteur d'alertes — exécuté à CHAQUE event (counts compris). */
  function runAlertEngine(detail) {
    const games = detail.games || {};
    annotateBuckets(games);
    const now = Date.now();

    // 1) Surveillances : pleine ? expirée ? partie disparue ?
    let watchDirty = false;
    for (const id of Object.keys(watch)) {
      const w = watch[id];
      const g = findGameById(games, id);
      if (g) {
        w.lastSeen = now;
        const cap = Number((g.gameConfig || {}).maxPlayers) || 0;
        const n = Number(g.numClients) || 0;
        if (cap > 0 && n >= cap && !firedFull.has(id)) {
          firedFull.add(id);
          beep();
          notify(
            T("lobby.alert_full_title", "Lobby plein ! 🔔"),
            T("lobby.alert_full_body", `${gameLabel(g)} est complète (${n}/${cap}) — file rejoindre !`, { map: gameLabel(g), n, cap }),
            "tfh-full-" + id
          );
          delete watch[id];
          watchDirty = true;
        }
      } else if (now - (w.lastSeen || w.addedAt || now) > WATCH_GONE_MS) {
        delete watch[id]; // partie terminée / démarrée : nettoyage silencieux
        watchDirty = true;
      } else if (now - (w.addedAt || now) > WATCH_TTL) {
        delete watch[id]; // expiration douce
        watchDirty = true;
      }
    }
    if (watchDirty) { save(LS_WATCH, watch); renderWatchList(); }
    syncCardBells();

    // 2) Nouvelles parties → filtres (uniquement sur snapshot complet)
    if (detail.full) {
      const ids = new Set(allGames(games).map((g) => String(g.gameID || g.id)));
      if (seenIds) {
        const fresh = allGames(games).filter((g) => {
          const id = String(g.gameID || g.id);
          return !seenIds.has(id) && matchesFilters(g);
        });
        if (fresh.length && settings.enabled) {
          beep();
          const g0 = fresh[0];
          notify(
            T("lobby.alert_new_title", "Nouvelle partie ! 🎮"),
            T("lobby.alert_new_body", `${gameLabel(g0)} — ${modeLabelOf(g0)} (${fresh.length > 1 ? "+" + (fresh.length - 1) + " autre" + (fresh.length > 2 ? "s" : "") : ""})`, { map: gameLabel(g0) }),
            "tfh-new-" + (g0.gameID || g0.id)
          );
        }
      }
      seenIds = ids;
    }
  }

  function modeLabelOf(g) {
    const cfg = g.gameConfig || {};
    if (g.__tfhBucket === "special") return T("lobby.sec_special", "Spécial");
    if (cfg.rankedType) return cfg.rankedType === "2v2" ? T("lobby.ranked_2v2", "Classé 2v2") : T("lobby.ranked_1v1", "Classé 1v1");
    return g.__tfhBucket === "team" ? T("lobby.filter_team", "Team") : T("lobby.filter_ffa", "FFA");
  }

  /* ══════════════════════════════════════════════════════════════════════
     UI — construction du bandeau
     ══════════════════════════════════════════════════════════════════════ */

  const bellSvg = (fill) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;

  function buildStrip() {
    const viewEl = document.getElementById("lobby-view");
    if (!viewEl || document.getElementById("lobby-live-strip")) return;

    strip = document.createElement("section");
    strip.id = "lobby-live-strip";
    strip.className = "llive-strip";
    strip.setAttribute("aria-label", T("lobby.ll_aria", "Statistiques du lobby en direct"));
    strip.innerHTML = `
      <div class="llive-row">
        <div class="llive-tile">
          <span class="llive-tile-num" data-role="ll-players">—</span>
          <span class="llive-tile-label">${esc(T("lobby.ll_players", "Joueurs en lobby"))}</span>
        </div>
        <div class="llive-tile">
          <span class="llive-tile-num" data-role="ll-games">—</span>
          <span class="llive-tile-label">${esc(T("lobby.ll_games", "Parties ouvertes"))}</span>
        </div>
        <div class="llive-tile">
          <span class="llive-tile-num" data-role="ll-almost">—</span>
          <span class="llive-tile-label">${esc(T("lobby.ll_almost", "Presque pleines"))}</span>
        </div>
        <div class="llive-tile llive-tile-bell">
          <button type="button" class="llive-bell" data-role="ll-bell" aria-expanded="false"
                  title="${esc(T("lobby.alert_title", "Alertes parties"))}" aria-label="${esc(T("lobby.alert_title", "Alertes parties"))}">
            ${bellSvg(false)}
            <span class="llive-bell-badge" data-role="ll-badge" hidden>0</span>
          </button>
          <span class="llive-tile-label">${esc(T("lobby.alert_tile_label", "Alertes"))}</span>
        </div>
      </div>
      <div class="llive-panel" data-role="ll-panel" hidden>
        <label class="llive-toggle">
          <input type="checkbox" data-role="ll-enabled">
          <span class="llive-toggle-track" aria-hidden="true"></span>
          <span>${esc(T("lobby.alert_enable", "Alertes actives (notification + son)"))}</span>
        </label>
        <div class="llive-panel-row">
          <label>
            <span>${esc(T("lobby.alert_mode", "Mode"))}</span>
            <select data-role="ll-mode">
              <option value="all">${esc(T("lobby.filter_all", "Toutes"))}</option>
              <option value="ffa">${esc(T("lobby.filter_ffa", "FFA"))}</option>
              <option value="team">${esc(T("lobby.filter_team", "Team"))}</option>
              <option value="special">${esc(T("lobby.filter_special", "Spécial"))}</option>
              <option value="ranked">${esc(T("lobby.ranked_short", "Classé"))}</option>
            </select>
          </label>
          <label>
            <span>${esc(T("lobby.alert_min", "Joueurs min."))}</span>
            <input type="number" min="0" max="60" data-role="ll-min">
          </label>
        </div>
        <p class="llive-panel-hint">${esc(T("lobby.alert_hint", "Tu seras prévenu dès qu'une partie correspondante s'ouvre. Garde cet onglet ouvert."))}</p>
        <div class="llive-watch-list" data-role="ll-watch"></div>
      </div>
      <div class="llive-modes" data-role="ll-modes" aria-live="off"></div>
      <div class="llive-curve-card">
        <div class="llive-curve-head">
          <h3>${esc(T("lobby.curve_title", "Joueurs dans le lobby"))}</h3>
          <div class="llive-curve-range" role="group" aria-label="${esc(T("lobby.curve_range_aria", "Période affichée"))}">
            <button type="button" data-range="1">1h</button>
            <button type="button" data-range="6" class="is-active">6h</button>
            <button type="button" data-range="24">24h</button>
          </div>
        </div>
        <canvas data-role="ll-curve" aria-label="${esc(T("lobby.curve_canvas_aria", "Courbe du nombre de joueurs dans le lobby"))}" role="img"></canvas>
        <div class="llive-curve-empty" data-role="ll-curve-empty" hidden></div>
      </div>`;

    viewEl.parentNode.insertBefore(strip, viewEl);

    els = {
      players:   strip.querySelector("[data-role=ll-players]"),
      games:     strip.querySelector("[data-role=ll-games]"),
      almost:    strip.querySelector("[data-role=ll-almost]"),
      badge:     strip.querySelector("[data-role=ll-badge]"),
      bell:      strip.querySelector("[data-role=ll-bell]"),
      panel:     strip.querySelector("[data-role=ll-panel]"),
      enabled:   strip.querySelector("[data-role=ll-enabled]"),
      mode:      strip.querySelector("[data-role=ll-mode]"),
      min:       strip.querySelector("[data-role=ll-min]"),
      watchList: strip.querySelector("[data-role=ll-watch]"),
      modes:     strip.querySelector("[data-role=ll-modes]"),
      curve:     strip.querySelector("[data-role=ll-curve]"),
      curveEmpty: strip.querySelector("[data-role=ll-curve-empty]"),
    };

    // État initial des contrôles
    els.enabled.checked = !!settings.enabled;
    els.mode.value = settings.mode || "all";
    els.min.value = String(settings.minPlayers || 0);

    // ── Interactions ──
    els.bell.addEventListener("click", () => {
      const open = els.panel.hidden;
      els.panel.hidden = !open;
      els.bell.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", (e) => {
      if (!els.panel.hidden && !e.target.closest(".llive-tile-bell") && !e.target.closest(".llive-panel")) {
        els.panel.hidden = true;
        els.bell.setAttribute("aria-expanded", "false");
      }
    });

    els.enabled.addEventListener("change", () => {
      settings.enabled = els.enabled.checked;
      save(LS_ALERTS, settings);
      if (settings.enabled) {
        ensureAudio(); // geste utilisateur : débloque l'audio
        if ("Notification" in window && Notification.permission === "default") {
          Notification.requestPermission().catch(() => { /* ignore */ });
        }
        window.showToast?.(T("lobby.alert_on_toast", "Alertes activées — notification + son"), "success", 3500, "bell");
      } else {
        window.showToast?.(T("lobby.alert_off_toast", "Alertes désactivées"), "info", 2500);
      }
      renderBell();
    });
    els.mode.addEventListener("change", () => {
      settings.mode = els.mode.value;
      save(LS_ALERTS, settings);
    });
    els.min.addEventListener("change", () => {
      const v = Math.max(0, Math.min(60, Math.round(Number(els.min.value) || 0)));
      els.min.value = String(v);
      settings.minPlayers = v;
      save(LS_ALERTS, settings);
    });
    strip.querySelector(".llive-curve-range").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-range]");
      if (!btn) return;
      range = Number(btn.dataset.range) || 6;
      strip.querySelectorAll(".llive-curve-range button").forEach((b) =>
        b.classList.toggle("is-active", b === btn));
      drawCurve();
    });

    // Ouverture/fermeture de surveillance depuis les cartes (lobby.js émet)
    window.addEventListener("tfh:lobby:watch-toggle", (e) => {
      const id = e.detail && e.detail.gameId;
      if (!id) return;
      toggleWatch(id);
    });

    // Thème → redessine (couleurs lues des CSS vars)
    const themeObserver = new MutationObserver(() => drawCurve());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });
    window.addEventListener("resize", () => drawCurve());

    renderBell();
    renderWatchList();
    drawCurve();
  }

  function renderBell() {
    if (!els.badge) return;
    const n = Object.keys(watch).length;
    els.badge.hidden = n === 0;
    els.badge.textContent = String(n);
    els.bell.classList.toggle("has-alerts", settings.enabled);
    els.bell.innerHTML = bellSvg(settings.enabled || n > 0);
    if (els.badge.parentNode !== els.bell) els.bell.appendChild(els.badge);
  }

  function renderWatchList() {
    if (!els.watchList) return;
    const ids = Object.keys(watch);
    els.watchList.innerHTML = ids.length
      ? `<p class="llive-watch-title">${esc(T("lobby.alert_watching", "Lobbies surveillés (prévenir quand pleins)"))}</p>` +
        ids.map((id) => {
          const w = watch[id];
          return `<span class="llive-watch-chip" title="${esc(id)}">
            ${esc(w.map || id)}
            <button type="button" data-unwatch="${esc(id)}" aria-label="${esc(T("lobby.watch_remove_aria", "Ne plus surveiller"))}">&times;</button>
          </span>`;
        }).join("")
      : `<p class="llive-watch-hint">${esc(T("lobby.alert_watch_hint", "Astuce : clique la cloche d'une carte pour être prévenu quand le lobby est plein."))}</p>`;
    els.watchList.querySelectorAll("[data-unwatch]").forEach((btn) => {
      btn.addEventListener("click", () => toggleWatch(btn.dataset.unwatch));
    });
    renderBell();
  }

  function toggleWatch(id) {
    if (watch[id]) {
      delete watch[id];
      window.showToast?.(T("lobby.watch_off_toast", "Surveillance retirée"), "info", 2500);
    } else {
      const g = findGameById(currentGames, id);
      watch[id] = {
        map: g ? gameLabel(g) : "",
        mode: g ? modeLabelOf(g) : "",
        addedAt: Date.now(),
        lastSeen: Date.now(),
      };
      ensureAudio(); // geste utilisateur : audio prêt pour le bip « pleine »
      window.showToast?.(
        T("lobby.watch_on_toast", "OK ! Je te préviens dès que ce lobby est plein 🔔"),
        "success", 4000, "bell"
      );
    }
    save(LS_WATCH, watch);
    renderWatchList();
    syncCardBells();
  }

  /** Répercute l'état de surveillance sur les cloches des cartes. */
  function syncCardBells() {
    const setBtn = window._lobbyDebug && window._lobbyDebug.setWatchBtn;
    document.querySelectorAll(".lobby-card[data-game-id]").forEach((card) => {
      const btn = card.querySelector("[data-role=watch]");
      if (btn && setBtn) setBtn(btn, !!watch[card.dataset.gameId]);
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     Écoute du flux live
     ══════════════════════════════════════════════════════════════════════ */

  let currentGames = { ffa: [], team: [], special: [] };

  function onUpdate(e) {
    const detail = e.detail || {};
    currentGames = detail.games || currentGames;
    buildStrip();
    const m = computeMetrics(currentGames);
    renderCounters(m);
    renderModes(m);
    sampleHistory(m);
    runAlertEngine({ games: currentGames, full: !!detail.full });
  }

  function boot() {
    buildStrip();
    window.addEventListener("tfh:lobby:update", onUpdate);
    // Un premier état « 0 » propre même avant le 1er snapshot
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
