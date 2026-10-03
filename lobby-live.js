/**
 * lobby-live.js — v5.22 — Alertes du lobby TheFrontHub.
 *
 * Module compagnon de lobby.js (qui publie l'event window « tfh:lobby:update »
 * à chaque snapshot/counts). v5.21 : le bandeau ne garde que l'essentiel
 * (alertes + suivi « ma partie »). v5.22 — FILTRE D'ALERTE COMPLET (demande
 * du propriétaire, inspiré du filtre de lobby d'OpenFront) :
 *
 *   1. Alertes (bell)        → notification navigateur + son WebAudio quand
 *                              une partie correspondant AUX FILTRES s'ouvre
 *                              (ou atteint le seuil « joueurs min. »), ou
 *                              quand un lobby surveillé devient pleine.
 *                              FILTRES : mode (toutes/ffa/team/spécial),
 *                              joueurs min., format (tous/compact/normal),
 *                              classé (tous/non classé/1v1/2v2) et SÉLECTION
 *                              DE CARTES multiple (132 cartes, avec recherche,
 *                              vignettes, « toutes/aucune »).
 *                              v5.20.1 anti-spam conservé : regroupement +
 *                              1 alerte « nouvelles parties » max par minute,
 *                              une partie ne sonne jamais deux fois.
 *   2. Suivi « ma partie »   → clic sur une carte = tu lances la partie ;
 *                              dès que le flux voit qu'elle démarre, le chat
 *                              de la partie s'ouvre (lobby-chat.js).
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
  const LS_ALERTS = "tfh_lobby_alerts_v2";      // v5.22 : filtres étendus
  const LS_ALERTS_V1 = "tfh_lobby_alerts_v1";   // migration depuis l'ancien format
  const LS_WATCH  = "tfh_lobby_watch_v1";
  const LS_MINE   = "tfh_lobby_mine_v1";      // parties que JE lance (chat auto)
  const WATCH_TTL       = 3 * 3600_000;       // une surveillance expire après 3 h
  const WATCH_GONE_MS   = 5 * 60_000;         // partie absente > 5 min → dé-surveillance
  const MINE_TTL        = 3 * 3600_000;       // suivi « ma partie » expire après 3 h
  const MINE_GONE_MS    = 8_000;              // absente d'un snapshot complet > 8 s → démarrée
  // v5.20.1 — anti-spam alertes : le serveur OpenFront renvoie un snapshot
  // « full » dès que quelque chose change hors des comptes de joueurs (partie
  // créée, partie lancée, startsAt qui bouge…) — souvent plusieurs fois par
  // minute. Sans garde, CHAQUE nouvelle partie sonnait : alarme continue.
  const NEW_ALERT_COOLDOWN_MS = 60_000; // 1 bip/notification « nouvelles parties » max / minute
  const ALERTED_MAX     = 400;          // plafond du Set de dédup session
  const MODES = ["ffa", "team", "special"];

  /* ── État persistant ─────────────────────────────────────────────────── */
  const load = (k, fb) => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; }
    catch { return fb; }
  };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };

  // v5.22 — migration douce depuis tfh_lobby_alerts_v1 (enabled/mode/minPlayers)
  let _alertStore = load(LS_ALERTS, null);
  if (!_alertStore) {
    const v1 = load(LS_ALERTS_V1, null);
    if (v1 && typeof v1 === "object") _alertStore = Object.assign({}, v1);
  }
  const settings = Object.assign(
    { enabled: false, mode: "all", minPlayers: 0, maps: [], compact: "any", ranked: "any" },
    _alertStore || {}
  );
  if (!Array.isArray(settings.maps)) settings.maps = [];
  let watch   = load(LS_WATCH, {});       // { gameId: { map, mode, addedAt, lastSeen } }
  for (const w of Object.values(watch)) w.armedAt = 0; // ré-armé par session (anti re-bip au rechargement)
  let mine    = load(LS_MINE, {});        // { gameId: { map, addedAt, lastSeen } }
  const firedFull = new Set();            // ids déjà notifiés « pleine » (session)
  let seenIds = null;                     // ids du snapshot complet précédent (détection nouvelles)
  // v5.20.1 — état anti-spam des alertes « nouvelles parties »
  let pendingFresh = [];                  // alertes en attente du flush (regroupées)
  let newAlertTimer = null;               // flush programmé à la fin du cooldown
  let lastNewAlert = 0;                   // ts du dernier bip « nouvelles parties »
  let alertedIds = new Set();             // une partie n'alerte JAMAIS 2 fois par session
  let lastCounts = new Map();             // id → numClients au passage précédent (détection de seuil)

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  let strip = null;
  let els = {};

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

  /** Slug de map (même règle que lobby.js mapSlug — copie locale, zéro dépendance). */
  function mapSlugOf(mapName) {
    return typeof mapName === "string"
      ? mapName.toLowerCase().replace(/[\s_]/g, "").replace(/[^\w]/g, "")
      : "";
  }

  /** La partie est-elle au format « Compact » ? (modificateur ou taille de map) */
  function isCompactGame(g) {
    const cfg = g.gameConfig || {};
    return !!(cfg.publicGameModifiers && cfg.publicGameModifiers.isCompact) ||
      cfg.gameMapSize === "Compact";
  }

  /** Une partie passe-t-elle TOUS les filtres d'alerte (mode, joueurs min.,
   *  format compact, classé, cartes sélectionnées) ? */
  function matchesFilters(g) {
    const cfg = g.gameConfig || {};
    if (settings.minPlayers > 0 && (Number(g.numClients) || 0) < settings.minPlayers) return false;
    // Mode (toutes / ffa / team / spécial / classé)
    if (settings.mode === "ranked") {
      if (!cfg.rankedType) return false;
    } else if (settings.mode !== "all") {
      const bucket = g.publicGameType === "special" ? "special" : (isTeam(g) ? "team" : "ffa");
      if (settings.mode !== bucket) return false;
    }
    // Classé : indépendant du mode (non classé / 1v1 / 2v2)
    if (settings.ranked === "unranked" && cfg.rankedType) return false;
    if (settings.ranked === "1v1" && cfg.rankedType !== "1v1") return false;
    if (settings.ranked === "2v2" && cfg.rankedType !== "2v2") return false;
    // Format
    const compact = isCompactGame(g);
    if (settings.compact === "only" && !compact) return false;
    if (settings.compact === "none" && compact) return false;
    // Cartes (sélection multiple — vide = toutes)
    const sel = Array.isArray(settings.maps) ? settings.maps : [];
    if (sel.length && !sel.includes(mapSlugOf(cfg.gameMap))) return false;
    return true;
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

  /* ── v5.20.1 : regroupement + cooldown des alertes « nouvelles parties » ── */

  /** Pousse une alerte candidate dans la file d'attente (si alertes actives). */
  function queueFreshAlert(g, id) {
    alertedIds.add(id);
    if (!settings.enabled) return; // alertes coupées : on n'accumule rien
    pendingFresh.push({ id, map: gameLabel(g), mode: modeLabelOf(g), n: Number(g.numClients) || 0 });
    if (pendingFresh.length > 30) pendingFresh.shift(); // garde-fou mémoire
  }

  /** Émet AU PLUS UN bip + une notification agrégée toutes les NEW_ALERT_COOLDOWN_MS. */
  function flushNewAlerts() {
    if (newAlertTimer) { clearTimeout(newAlertTimer); newAlertTimer = null; }
    if (!pendingFresh.length) return;
    if (!settings.enabled) { pendingFresh = []; return; }
    const wait = NEW_ALERT_COOLDOWN_MS - (Date.now() - lastNewAlert);
    if (wait > 0) {
      // Trop tôt : on garde en attente, flush automatique à la fin du cooldown.
      newAlertTimer = setTimeout(flushNewAlerts, wait + 50);
      return;
    }
    // Au moment du flush, ne citer que les parties ENCORE ouvertes
    // (inutile de prévenir d'une partie déjà lancée depuis 30 s).
    const alive = pendingFresh.filter((p) => findGameById(currentGames, p.id));
    pendingFresh = [];
    if (!alive.length) return;
    lastNewAlert = Date.now();
    beep();
    const g0 = alive[0];
    const extra = alive.length - 1;
    notify(
      extra > 0
        ? T("lobby.alert_new_many_title", `${alive.length} nouvelles parties ! 🎮`, { n: alive.length })
        : T("lobby.alert_new_title", "Nouvelle partie ! 🎮"),
      T("lobby.alert_new_body", `${g0.map} vient de s'ouvrir`, { map: g0.map }) +
        (extra > 0 ? " " + T("lobby.alert_new_extra", `(+${extra} autre${extra > 1 ? "s" : ""})`, { n: extra }) : ""),
      "tfh-new-" + g0.id
    );
  }

  function runMyGameEngine(detail) {
    const games = detail.games || {};
    const ids = Object.keys(mine);
    if (!ids.length) return;
    let dirty = false;
    const now = Date.now();
    // v5.20.1 : startsAt est en horloge SERVEUR — compare avec l'heure serveur
    // (publiée par lobby.js), pas l'horloge du navigateur (décalage possible).
    const sNow = Number(detail.serverNow) > 0 ? Number(detail.serverNow) : now;
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
        else if (Number(g.startsAt) > 0 && Number(g.startsAt) <= sNow + 1500) { dirty = true; fireMyGameStarted(id, g, "countdown"); }
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
    //    v5.20.1 : une surveillance n'est « armée » qu'après avoir été vue
    //    NON pleine au moins une fois dans cette session — sinon, après un
    //    rechargement de page, un lobby DÉJÀ pleine redéclenchait le bip.
    let watchDirty = false;
    for (const id of Object.keys(watch)) {
      const w = watch[id];
      const g = findGameById(games, id);
      if (g) {
        w.lastSeen = now;
        const cap = Number((g.gameConfig || {}).maxPlayers) || 0;
        const n = Number(g.numClients) || 0;
        if (cap > 0 && n >= cap) {
          if (w.armedAt && !firedFull.has(id)) {
            firedFull.add(id);
            beep();
            notify(
              T("lobby.alert_full_title", "Lobby plein ! 🔔"),
              T("lobby.alert_full_body", `${gameLabel(g)} est complète (${n}/${cap}) — file rejoindre !`, { map: gameLabel(g), n, cap }),
              "tfh-full-" + id
            );
          }
          delete watch[id]; // pleine (sonnée ou pas) : plus rien à surveiller
          watchDirty = true;
        } else if (!w.armedAt) {
          w.armedAt = now; // vue non pleine → alerte armée pour cette session
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

    // 2) Alertes « nouvelles parties » — avec anti-spam complet (v5.20.1) :
    //      • une partie ne déclenche AU PLUS UNE alerte par session ;
    //      • déclencheurs : création d'une partie qui passe les filtres, OU
    //        franchissement du seuil « joueurs min. » (de < min à ≥ min) ;
    //      • regroupement : 1 bip + 1 notification agrégée max / minute.
    const prevSeen = seenIds;
    if (detail.full) {
      seenIds = new Set(allGames(games).map((g) => String(g.gameID || g.id)));
      for (const k of lastCounts.keys()) if (!seenIds.has(k)) lastCounts.delete(k);
    }
    const wantMin = Math.max(0, Math.round(Number(settings.minPlayers) || 0));
    for (const g of allGames(games)) {
      const id = String(g.gameID || g.id);
      const n = Number(g.numClients) || 0;
      const prevN = lastCounts.get(id);
      lastCounts.set(id, n);
      if (alertedIds.has(id) || !matchesFilters(g)) continue;
      const isNew = !!(detail.full && prevSeen && !prevSeen.has(id));
      const crossed = wantMin > 0 && prevN !== undefined && prevN < wantMin && n >= wantMin;
      if ((isNew || crossed) && n >= wantMin) queueFreshAlert(g, id);
    }
    if (alertedIds.size > ALERTED_MAX) {
      alertedIds = new Set([...alertedIds].slice(-ALERTED_MAX / 2));
    }
    flushNewAlerts();

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
     UI — construction du bandeau alertes (v5.21 : compteur « Parties
     analysées », stats des cartes, chips de mode et courbe « Joueurs dans
     le lobby » retirés sur demande du propriétaire — ne reste que les
     alertes, discrètes, en haut des cartes)
     ══════════════════════════════════════════════════════════════════════ */

  const bellSvg = (fill) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;

  function buildStrip() {
    const viewEl = document.getElementById("lobby-view");
    if (!viewEl || document.getElementById("lobby-live-strip")) return;

    strip = document.createElement("section");
    strip.id = "lobby-live-strip";
    strip.className = "llive-strip";
    strip.setAttribute("aria-label", T("lobby.alert_title", "Alertes parties"));
    strip.innerHTML = `
      <div class="llive-row">
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
        <div class="llive-toggle-line">
          <label class="llive-toggle">
            <input type="checkbox" data-role="ll-enabled">
            <span class="llive-toggle-track" aria-hidden="true"></span>
            <span>${esc(T("lobby.alert_enable", "Alertes actives (notification + son)"))}</span>
          </label>
          <button type="button" class="llive-test-sound" data-role="ll-test"
                  title="${esc(T("lobby.alert_test_title", "Tester le son de l'alerte"))}">
            🔊 ${esc(T("lobby.alert_test", "Test"))}
          </button>
        </div>
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
          <label>
            <span>${esc(T("lobby.alert_compact", "Format"))}</span>
            <select data-role="ll-compact">
              <option value="any">${esc(T("lobby.alert_compact_any", "Tous"))}</option>
              <option value="only">${esc(T("lobby.alert_compact_only", "Compact"))}</option>
              <option value="none">${esc(T("lobby.alert_compact_none", "Normal"))}</option>
            </select>
          </label>
          <label>
            <span>${esc(T("lobby.alert_ranked", "Classé"))}</span>
            <select data-role="ll-ranked">
              <option value="any">${esc(T("lobby.alert_compact_any", "Tous"))}</option>
              <option value="unranked">${esc(T("lobby.alert_ranked_no", "Non classé"))}</option>
              <option value="1v1">1v1</option>
              <option value="2v2">2v2</option>
            </select>
          </label>
        </div>
        <div class="llive-maps">
          <div class="llive-maps-head">
            <span class="llive-maps-label">${esc(T("lobby.alert_maps", "Cartes"))}</span>
            <span class="llive-maps-summary" data-role="ll-maps-summary"></span>
            <button type="button" class="llive-maps-toggle" data-role="ll-maps-toggle"
                    aria-expanded="false">${esc(T("lobby.alert_maps_toggle", "Choisir…"))}</button>
          </div>
          <div class="llive-maps-body" data-role="ll-maps-body" hidden>
            <input type="search" class="llive-maps-search" data-role="ll-maps-search"
                   placeholder="${esc(T("lobby.alert_maps_search", "Rechercher une carte…"))}"
                   aria-label="${esc(T("lobby.alert_maps_search", "Rechercher une carte…"))}">
            <div class="llive-maps-actions">
              <button type="button" data-role="ll-maps-all">${esc(T("lobby.alert_maps_select_all", "Toutes"))}</button>
              <button type="button" data-role="ll-maps-none">${esc(T("lobby.alert_maps_clear", "Aucune"))}</button>
            </div>
            <div class="llive-maps-list" data-role="ll-maps-list" role="group"
                 aria-label="${esc(T("lobby.alert_maps", "Cartes à surveiller"))}"></div>
          </div>
        </div>
        <p class="llive-panel-hint">${esc(T("lobby.alert_hint", "Prévenu quand une partie correspondante s'ouvre (ou atteint le seuil de joueurs) — regroupé : 1 alerte max par minute. Garde cet onglet ouvert."))}</p>
        <div class="llive-watch-list" data-role="ll-watch"></div>
      </div>`;

    viewEl.parentNode.insertBefore(strip, viewEl);

    els = {
      badge:     strip.querySelector("[data-role=ll-badge]"),
      bell:      strip.querySelector("[data-role=ll-bell]"),
      panel:     strip.querySelector("[data-role=ll-panel]"),
      enabled:   strip.querySelector("[data-role=ll-enabled]"),
      test:      strip.querySelector("[data-role=ll-test]"),
      mode:      strip.querySelector("[data-role=ll-mode]"),
      min:       strip.querySelector("[data-role=ll-min]"),
      compact:   strip.querySelector("[data-role=ll-compact]"),
      ranked:    strip.querySelector("[data-role=ll-ranked]"),
      mapsHead:  strip.querySelector("[data-role=ll-maps-summary]").parentNode,
      mapsSummary: strip.querySelector("[data-role=ll-maps-summary]"),
      mapsToggle:  strip.querySelector("[data-role=ll-maps-toggle]"),
      mapsBody:    strip.querySelector("[data-role=ll-maps-body]"),
      mapsSearch:  strip.querySelector("[data-role=ll-maps-search]"),
      mapsAll:     strip.querySelector("[data-role=ll-maps-all]"),
      mapsNone:    strip.querySelector("[data-role=ll-maps-none]"),
      mapsList:    strip.querySelector("[data-role=ll-maps-list]"),
      watchList: strip.querySelector("[data-role=ll-watch]"),
    };

    // État initial des contrôles
    els.enabled.checked = !!settings.enabled;
    els.mode.value = settings.mode || "all";
    els.min.value = String(settings.minPlayers || 0);
    els.compact.value = settings.compact || "any";
    els.ranked.value = settings.ranked || "any";
    updateMapsSummary();

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
    // v5.22 — filtres étendus
    els.compact.addEventListener("change", () => {
      settings.compact = els.compact.value;
      save(LS_ALERTS, settings);
    });
    els.ranked.addEventListener("change", () => {
      settings.ranked = els.ranked.value;
      save(LS_ALERTS, settings);
    });
    els.test.addEventListener("click", () => {
      ensureAudio(); // geste utilisateur : débloque l'audio
      beep();
    });
    els.mapsToggle.addEventListener("click", () => {
      const open = els.mapsBody.hidden;
      els.mapsBody.hidden = !open;
      els.mapsToggle.setAttribute("aria-expanded", String(open));
      if (open) loadMapsCatalog();
    });
    els.mapsSearch.addEventListener("input", () => renderMapsList());
    els.mapsAll.addEventListener("click", () => {
      // sélectionne toutes les cartes VISIBLES (recherche respectée)
      const sel = new Set(settings.maps);
      els.mapsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        sel.add(cb.value);
        cb.checked = true;
        cb.closest(".llive-map-item")?.classList.add("is-on");
      });
      settings.maps = [...sel];
      save(LS_ALERTS, settings);
      updateMapsSummary();
    });
    els.mapsNone.addEventListener("click", () => {
      settings.maps = [];
      save(LS_ALERTS, settings);
      els.mapsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.checked = false;
        cb.closest(".llive-map-item")?.classList.remove("is-on");
      });
      updateMapsSummary();
    });

    // Ouverture/fermeture de surveillance depuis les cartes (lobby.js émet)
    window.addEventListener("tfh:lobby:watch-toggle", (e) => {
      const id = e.detail && e.detail.gameId;
      if (!id) return;
      toggleWatch(id);
    });

    renderBell();
    renderWatchList();
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
        armedAt: 0, // armée au 1er passage « non pleine » de cette session
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

  /* ── v5.22 — sélecteur de cartes (catalogue atlas, 132 cartes) ──────── */

  let mapsCatalog = null;       // [{ slug, name }] — chargé au 1er dépliage
  let mapsLoading = false;

  function loadMapsCatalog() {
    if (mapsCatalog || mapsLoading) { if (mapsCatalog) renderMapsList(); return; }
    mapsLoading = true;
    els.mapsList.innerHTML = `<p class="llive-maps-empty">${esc(T("lobby.alert_maps_loading", "Chargement des cartes…"))}</p>`;
    fetch("atlas-data/maps_data.json?v=132", { cache: "force-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((d) => {
        mapsCatalog = Object.keys(d || {}).map((slug) => {
          const e = d[slug] || {};
          return { slug, name: e.translated_name || e.display_name || e.enum_key || slug };
        }).sort((a, b) => a.name.localeCompare(b.name, "fr"));
      })
      .catch(() => {
        // Repli : les cartes actuellement en lobby (catalogue indisponible)
        const seen = new Map();
        allGames(currentGames).forEach((g) => {
          const raw = String((g.gameConfig || {}).gameMap || "");
          const slug = mapSlugOf(raw);
          if (slug && !seen.has(slug)) seen.set(slug, raw);
        });
        mapsCatalog = [...seen.entries()].map(([slug, raw]) => ({ slug, name: raw }))
          .sort((a, b) => a.name.localeCompare(b.name, "fr"));
      })
      .finally(() => {
        mapsLoading = false;
        renderMapsList();
      });
  }

  function renderMapsList() {
    if (!els.mapsList || !mapsCatalog) return;
    const q = String((els.mapsSearch && els.mapsSearch.value) || "").trim().toLowerCase();
    const sel = new Set(settings.maps);
    const items = mapsCatalog.filter((m) => !q || m.name.toLowerCase().includes(q) || m.slug.includes(q));
    els.mapsList.innerHTML = items.length
      ? items.map((m) => `
        <label class="llive-map-item${sel.has(m.slug) ? " is-on" : ""}">
          <input type="checkbox" value="${esc(m.slug)}"${sel.has(m.slug) ? " checked" : ""}>
          <img class="llive-map-thumb" alt="" loading="lazy" draggable="false"
               src="atlas-data/thumbnails/${esc(m.slug)}.webp"
               onerror="this.style.visibility='hidden'">
          <span class="llive-map-name">${esc(m.name)}</span>
        </label>`).join("")
      : `<p class="llive-maps-empty">${esc(T("lobby.alert_maps_empty", "Aucune carte trouvée"))}</p>`;
    els.mapsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const s = new Set(settings.maps);
        if (cb.checked) s.add(cb.value); else s.delete(cb.value);
        settings.maps = [...s];
        save(LS_ALERTS, settings);
        cb.closest(".llive-map-item")?.classList.toggle("is-on", cb.checked);
        updateMapsSummary();
      });
    });
  }

  function updateMapsSummary() {
    if (!els.mapsSummary) return;
    const n = Array.isArray(settings.maps) ? settings.maps.length : 0;
    els.mapsSummary.textContent = n === 0
      ? T("lobby.alert_maps_all", "Toutes")
      : T("lobby.alert_maps_custom", `${n} choisie${n > 1 ? "s" : ""}`, { n, s: n > 1 ? "s" : "" });
    els.mapsSummary.classList.toggle("is-filtered", n > 0);
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
    // v5.20.2 — snapshot DÉGRADÉ (parties terminées, pas de live) : le moteur
    // d'alertes et le suivi « ma partie » restent éteints — bip/notification
    // pour une partie déjà terminée = spam sans objet (l'utilisateur ne peut
    // plus la rejoindre).
    if (!detail.degraded) {
      runAlertEngine({
        games: currentGames,
        full: !!detail.full,
        serverNow: Number(detail.serverNow) || 0, // v5.20.1 : horloge serveur pour startsAt
      });
    }
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
