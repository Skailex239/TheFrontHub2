/**
 * lobby-live.js — v5.19 — Bandeau LIVE du lobby TheFrontHub.
 *
 * Module compagnon de lobby.js (qui publie l'event window « tfh:lobby:update »
 * à chaque snapshot/counts). Il ajoute au-dessus des cartes :
 *
 *   1. Compteur global « parties analysées » → total accumulé 24/7 côté
 *      serveur (cron games-sync → MySQL → api/games-api.php route=maps).
 *      Le compteur tourne même quand personne ne regarde : à l'arrivée sur
 *      la page, il démarre de TOUT l'historique collecté (count-up animé),
 *      pas de zéro.
 *   2. Stats des cartes (maps) → top des cartes par parties collectées,
 *      liste défilante (top 10 visible, scroll pour la suite), filtres
 *      Toujours / 7 jours / 24 h, rafraîchie toutes les 90 s.
 *   3. Stats par mode        → chips FFA / Team / Spécial / Classé (parties + joueurs)
 *   4. Courbe d'activité     → canvas, historique 24 h en localStorage, ranges 1h/6h/24h
 *   5. Alertes (bell 18/22)  → notification navigateur + son WebAudio quand
 *                              une partie correspondant aux filtres s'ouvre,
 *                              ou quand un lobby surveillé (« préviens-moi
 *                              quand ce lobby est plein ») devient pleine.
 *   6. Suivi « ma partie »   → clic sur une carte = tu lances la partie ;
 *                              dès que le flux voit qu'elle démarre (pleine,
 *                              compte à rebours écoulé ou sortie de liste),
 *                              le chat de la partie s'ouvre (lobby-chat.js).
 *
 * Chargé en script autonome (IIFE, defer). Zéro dépendance.
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
  const LS_MINE   = "tfh_lobby_mine_v1";      // parties que JE lance (chat auto)
  const LS_MAPS_P = "tfh_lobby_maps_period_v1";
  const MAPS_API  = "api/games-api.php";
  const MAPS_POLL_MS    = 90_000;             // rafraîchissement stats cartes
  const SAMPLE_MIN_MS   = 20_000;             // 1 échantillon courbe / 20 s max
  const HIST_TTL        = 24 * 3600_000;      // fenêtre historique : 24 h
  const HIST_MAX_POINTS = 3_000;
  const WATCH_TTL       = 3 * 3600_000;       // une surveillance expire après 3 h
  const WATCH_GONE_MS   = 5 * 60_000;         // partie absente > 5 min → dé-surveillance
  const MINE_TTL        = 3 * 3600_000;       // suivi « ma partie » expire après 3 h
  const MINE_GONE_MS    = 8_000;              // absente d'un snapshot complet > 8 s → démarrée
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
  let mine    = load(LS_MINE, {});        // { gameId: { map, addedAt, lastSeen } }
  let mapsPeriod = load(LS_MAPS_P, "all"); // all | 7d | 24h
  const firedFull = new Set();            // ids déjà notifiés « pleine » (session)
  let seenIds = null;                     // ids du snapshot précédent (détection nouvelles)
  let lastSample = 0;
  let range = 6;                          // heures affichées (1 | 6 | 24)

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  let strip = null;
  let els = {};

  function cssVar(name, fb) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  }

  /* ══════════════════════════════════════════════════════════════════════
     Utilitaires
     ══════════════════════════════════════════════════════════════════════ */

  const nf = (() => {
    try { return new Intl.NumberFormat(); } catch { return null; }
  })();
  function fmtNum(n) {
    if (n == null || !isFinite(n)) return "—";
    return nf ? nf.format(Math.round(n)) : String(Math.round(n));
  }

  /** « il y a … » depuis un timestamp UTC « YYYY-MM-DD HH:MM:SS » (MySQL). */
  function agoSince(utcStamp) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(utcStamp || ""));
    if (!m) return "";
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (isNaN(d)) return "";
    const s = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (s < 60) return T("lobby.ago_s", `${s} s`, { n: s });
    if (s < 3600) { const n = Math.floor(s / 60); return T("lobby.ago_min", `${n} min`, { n }); }
    if (s < 86400) { const n = Math.floor(s / 3600); return T("lobby.ago_h", `${n} h`, { n }); }
    const n = Math.floor(s / 86400);
    return T("lobby.ago_d", `${n} j`, { n });
  }

  function fmtDuration(sec) {
    const s = Number(sec);
    if (!s || s <= 0) return null;
    if (s < 90) return Math.round(s) + " s";
    const m = Math.round(s / 60);
    return m + " min";
  }

  /* ══════════════════════════════════════════════════════════════════════
     Métriques live (chips + courbe)
     ══════════════════════════════════════════════════════════════════════ */

  function computeMetrics(games) {
    let players = 0, total = 0, ranked = 0;
    const perMode = { ffa: { g: 0, p: 0 }, team: { g: 0, p: 0 }, special: { g: 0, p: 0 } };
    for (const k of MODES) {
      for (const g of games[k] || []) {
        const cfg = g.gameConfig || {};
        const n = Number(g.numClients) || 0;
        players += n; total++;
        perMode[k].g++; perMode[k].p += n;
        if (cfg.rankedType) ranked++;
      }
    }
    return { players, total, ranked, perMode };
  }

  function animateNum(el, from, to, dur = 380) {
    if (from === to) { el.textContent = fmtNum(to); return; }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmtNum(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
     Stats des cartes — alimentées par la collecte continue du serveur
     (cron games-sync → MySQL → api/games-api.php?route=maps&scope=all).
     Le compteur cumule 24/7 : un visiteur qui arrive voit le total accumulé.
     ══════════════════════════════════════════════════════════════════════ */

  let mapsTimer = null;
  let mapsBusy = false;
  let mapsTotalShown = 0;      // dernière valeur affichée (pour le count-up)
  let mapsFirstPaint = false;

  async function fetchMaps() {
    if (mapsBusy || !els.mapsList) return;
    mapsBusy = true;
    try {
      const res = await fetch(`${MAPS_API}?route=maps&scope=all&period=${encodeURIComponent(mapsPeriod)}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => null);
      if (data && data.ok) renderMaps(data);
      else if (els.mapsSub) els.mapsSub.textContent = T("lobby.maps_err", "Stats indisponibles pour le moment — nouvelle tentative bientôt.");
    } catch {
      if (els.mapsSub) els.mapsSub.textContent = T("lobby.maps_err", "Stats indisponibles pour le moment — nouvelle tentative bientôt.");
    } finally {
      mapsBusy = false;
    }
  }

  function totalForPeriod(d) {
    if (mapsPeriod === "24h") return d.totalGames24h != null ? d.totalGames24h : d.totalGames;
    if (mapsPeriod === "7d") return d.totalGames7d != null ? d.totalGames7d : d.totalGames;
    return d.totalGames;
  }

  function renderMaps(d) {
    if (!els.mapsList) return;
    const total = totalForPeriod(d) || 0;

    // Gros compteur animé — au 1er affichage, il monte de 0 vers le total
    // accumulé côté serveur (« dès que j'arrive, c'est là où le compteur en est »)
    if (els.mapsTotal) {
      if (!mapsFirstPaint) {
        animateNum(els.mapsTotal, 0, total, 900);
        mapsFirstPaint = true;
      } else if (total !== mapsTotalShown) {
        animateNum(els.mapsTotal, mapsTotalShown, total, 600);
      }
      mapsTotalShown = total;
    }

    // Sous-ligne : preuve de collecte (dernière partie collectée il y a …)
    if (els.mapsSub) {
      const ago = agoSince(d.newestGame);
      els.mapsSub.innerHTML = ago
        ? `${esc(T("lobby.maps_sub", "Collecte en continu"))} · ${esc(T("lobby.maps_newest", "dernière partie {ago}", { ago }))}`
        : esc(T("lobby.maps_sub", "Collecte en continu"));
    }

    // Liste défilante — top cartes par parties collectées
    const maps = Array.isArray(d.maps) ? d.maps : [];
    const base = Math.max(1, d.listedGames || maps.reduce((s, m) => s + (m.games || 0), 0));
    if (!maps.length) {
      els.mapsList.innerHTML = `<li class="llive-map-empty">${esc(T("lobby.maps_empty", "Les stats arrivent avec les prochaines parties collectées…"))}</li>`;
      return;
    }
    els.mapsList.innerHTML = maps.map((m, i) => {
      const share = Math.max(2, Math.min(100, Math.round(((m.games || 0) / base) * 100)));
      const meta = [];
      if (m.players != null && m.players > 0) meta.push(`${fmtNum(m.players)} ${T("lobby.players_unit", "jrs")}`);
      const dur = fmtDuration(m.avgDurationS);
      if (dur) meta.push(dur);
      return `<li class="llive-map-row${i < 3 ? " is-top" : ""}">
        <span class="llive-map-rank">${i + 1}</span>
        <span class="llive-map-name" title="${esc(m.map)}">${esc(m.map)}</span>
        <span class="llive-map-bar" aria-hidden="true"><i style="width:${share}%"></i></span>
        <span class="llive-map-games">${fmtNum(m.games)}</span>
        <span class="llive-map-meta">${esc(meta.join(" · "))}</span>
      </li>`;
    }).join("");
  }

  function startMaps() {
    fetchMaps();
    mapsTimer = setInterval(() => {
      if (!document.hidden) fetchMaps();
    }, MAPS_POLL_MS);
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

  /* ══════════════════════════════════════════════════════════════════════
     Suivi « ma partie » — le joueur clique une carte pour lancer sa partie ;
     dès que le flux voit qu'elle démarre, on ouvre le chat de la partie.
     ══════════════════════════════════════════════════════════════════════ */

  window.addEventListener("tfh:lobby:my-game", (e) => {
    const d = e.detail || {};
    const id = d.gameId;
    if (!id) return;
    mine[id] = { map: String(d.map || ""), addedAt: Date.now(), lastSeen: Date.now() };
    save(LS_MINE, mine);
  });

  function fireMyGameStarted(id, g, reason) {
    const map = (g && gameLabel(g)) || (mine[id] && mine[id].map) || "";
    delete mine[id];
    save(LS_MINE, mine);
    beep();
    notify(
      T("lobby.mygame_title", "Ta partie démarre ! 🎮"),
      T("lobby.mygame_body", "Le chat de la partie est ouvert — les inscrits qui la rejoignent arrivent dans le salon."),
      "tfh-mygame-" + id
    );
    window.dispatchEvent(new CustomEvent("tfh:lobby:my-game-started", {
      detail: { gameId: id, map, reason },
    }));
  }

  function runMyGameEngine(detail) {
    const games = detail.games || {};
    const ids = Object.keys(mine);
    if (!ids.length) return;
    let dirty = false;
    const now = Date.now();
    for (const id of ids) {
      const m = mine[id];
      if (!m) continue;
      if (now - (m.addedAt || now) > MINE_TTL) { delete mine[id]; dirty = true; continue; }
      const g = findGameById(games, id);
      if (g) {
        m.lastSeen = now;
        const cap = Number((g.gameConfig || {}).maxPlayers) || 0;
        const n = Number(g.numClients) || 0;
        // OpenFront lance automatiquement un lobby public dès qu'il est plein,
        // ou quand le compte à rebours (startsAt) tombe à zéro.
        if (cap > 0 && n >= cap) { dirty = true; fireMyGameStarted(id, g, "full"); }
        else if (Number(g.startsAt) > 0 && Number(g.startsAt) <= now + 1500) { dirty = true; fireMyGameStarted(id, g, "countdown"); }
      } else if (now - (m.lastSeen || m.addedAt) > MINE_GONE_MS) {
        // Plus vue depuis > 8 s (sur N'IMPORTE QUEL événement — les counts
        // patchent les parties existantes, ils ne retirent jamais une partie
        // de la liste) → le lobby a démarré (il quitte la liste) ou s'est
        // terminé. On ouvre le chat : le salon reste utile dans les deux cas.
        dirty = true;
        fireMyGameStarted(id, null, "gone");
      }
    }
    if (dirty) save(LS_MINE, mine);
  }

  /* ══════════════════════════════════════════════════════════════════════
     Moteur d'alertes
     ══════════════════════════════════════════════════════════════════════ */

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

    // 3) Suivi « ma partie » → ouverture du chat au lancement
    runMyGameEngine(detail);
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
        <div class="llive-tile llive-tile-total">
          <span class="llive-tile-num" data-role="maps-total">0</span>
          <span class="llive-tile-label">
            <span class="llive-live-dot" aria-hidden="true"></span>
            ${esc(T("lobby.maps_total_label", "Parties analysées"))}
          </span>
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
      <section class="llive-maps" aria-label="${esc(T("lobby.maps_title", "Stats des cartes"))}">
        <div class="llive-maps-head">
          <h3>${esc(T("lobby.maps_title", "Stats des cartes"))}</h3>
          <div class="llive-curve-range llive-maps-range" role="group" aria-label="${esc(T("lobby.maps_range_aria", "Période des stats cartes"))}">
            <button type="button" data-period="all" class="${mapsPeriod === "all" ? "is-active" : ""}">${esc(T("lobby.maps_period_all", "Toujours"))}</button>
            <button type="button" data-period="7d" class="${mapsPeriod === "7d" ? "is-active" : ""}">${esc(T("lobby.maps_period_7d", "7 jours"))}</button>
            <button type="button" data-period="24h" class="${mapsPeriod === "24h" ? "is-active" : ""}">${esc(T("lobby.maps_period_24h", "24 h"))}</button>
          </div>
        </div>
        <p class="llive-maps-sub" data-role="maps-sub">${esc(T("lobby.maps_sub", "Collecte en continu"))}</p>
        <ol class="llive-maps-list" data-role="maps-list">
          <li class="llive-map-empty">${esc(T("lobby.maps_loading", "Chargement des stats des cartes…"))}</li>
        </ol>
      </section>
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
      mapsTotal: strip.querySelector("[data-role=maps-total]"),
      mapsSub:   strip.querySelector("[data-role=maps-sub]"),
      mapsList:  strip.querySelector("[data-role=maps-list]"),
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
    strip.querySelector(".llive-curve-range:not(.llive-maps-range)").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-range]");
      if (!btn) return;
      range = Number(btn.dataset.range) || 6;
      strip.querySelectorAll(".llive-curve-range:not(.llive-maps-range) button").forEach((b) =>
        b.classList.toggle("is-active", b === btn));
      drawCurve();
    });
    strip.querySelector(".llive-maps-range").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-period]");
      if (!btn) return;
      mapsPeriod = btn.dataset.period;
      if (!["all", "7d", "24h"].includes(mapsPeriod)) mapsPeriod = "all";
      save(LS_MAPS_P, mapsPeriod);
      strip.querySelectorAll(".llive-maps-range button").forEach((b) =>
        b.classList.toggle("is-active", b === btn));
      if (els.mapsList) {
        els.mapsList.innerHTML = `<li class="llive-map-empty">${esc(T("lobby.maps_loading", "Chargement des stats des cartes…"))}</li>`;
      }
      fetchMaps();
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
    startMaps();
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
    renderModes(m);
    sampleHistory(m);
    runAlertEngine({ games: currentGames, full: !!detail.full });
  }

  function boot() {
    buildStrip();
    window.addEventListener("tfh:lobby:update", onUpdate);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
