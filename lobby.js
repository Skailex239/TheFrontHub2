// lobby.js — Lobby TheFrontHub (v5 — B+ + favoris & remplissage)
//
// Bandeau compact « Prochaine partie », filtre segmenté
// Toutes / FFA / Team / Spécial / Favoris, en-têtes de section au design
// system (majuscules + filet) et cartes claires (vignette, timer flottant,
// pills chips, barre de remplissage, compteur mono, étoile favori,
// CTA « Rejoindre »), réparties en carrousels défilants.
//
// v5 :
//   - FIN des cartes en double : chaque partie est rendue UNE seule fois
//     (l'ancienne duplication ×2 servait à boucler l'auto-scroll ; le
//     carrousel repasse simplement au début en fin de piste).
//   - Le clic sur une carte redirige de nouveau DIRECTEMENT vers la partie :
//     l'ancien setPointerCapture du drag retargetait le pointerup vers la
//     piste → le clic était émis sur la piste et non sur le lien. Le drag
//     n'avale le clic qu'après un vrai déplacement (seuil 6 px, souris
//     uniquement) ; le tactile garde le scroll natif.
//   - Barre de remplissage joueur/capacité + badge « Presque pleine » (≥ 80 %).
//   - Favoris : étoile par carte, stockés EN BASE (api/favorites.php,
//     session Discord requise), filtre « Favoris », toast quand une
//     nouvelle partie s'ouvre sur une carte favorite.
//
// ── Connexion tri-niveaux (fiabilité maximale) ──────────────────────────
//   N1  WebSocket DIRECT   wss://openfront.io/w{0-4}/lobbies   (zbin binaire)
//   N2  WebSocket PROXY    wss://openfront-proxy.<user>.workers.dev/lobby-ws
//                         (même flux zbin, bridgé par le Worker Cloudflare)
//   N3  HTTP FALLBACK      lobby_state.json (rafraîchi toutes les 5 min par
//                         GitHub Actions — dernier recours hors ligne)
//
// Le flux OpenFront est désormais au format binaire "zbin" : c'est la raison
// pour laquelle l'ancienne implémentation (JSON.parse) ne recevait rien.
// Le décodage est assuré par lobby-wire.js (chargé AVANT ce module).
//
// ── Comportement ────────────────────────────────────────────────────────
//   - Compte à rebours rafraîchi chaque seconde (basé sur serverTime WS)
//   - Messages "counts" patchent les numClients sans re-render complet
//   - Carrousels : auto-défilement lent, pause au survol / drag, flèches
//   - Clic sur une carte → ouvre la partie sur openfront.io (nouvel onglet)
//   - Thème : suit le design system du site (sombre par défaut + toggle clair)

"use strict";

/* ── Helpers ─────────────────────────────────────────────────────────── */

// Nom de carte affichable : passe par i18n (window.t, chargé sur toutes les
// pages) pour afficher le nom francisé ("Mer Égée", "Alpes"…) comme sur
// l'index et /runs. Les vignettes (mapThumb) et l'URL du jeu continuent
// d'utiliser le nom brut de l'API — seul le libellé visible est traduit.
function mapDisplayName(raw) {
  if (!raw) return "?";
  const key = "map." + raw;
  const translated = (typeof window.t === "function") ? window.t(key) : null;
  return (translated && translated !== key) ? translated : raw;
}

/* ════════════════════════════════════════════════════════════════════════
   Configuration
   ════════════════════════════════════════════════════════════════════════ */

// ⚠️ OpenFront sert désormais numWorkers=20 (BOOTSTRAP_CONFIG, déploiement
// 2026-09-04) — tous les workers w0..w19 exposent la MÊME liste de lobbies
// (choix purement aléatoire côté client pour répartir la charge).
const DIRECT_WORKERS = Array.from({ length: 20 }, (_, i) => `w${i}`);
// Worker proxy Cloudflare existant (allowlist d'origines déjà configurée)
const PROXY_WS_URL = "wss://openfront-proxy.diofortnite3.workers.dev/lobby-ws";
const FALLBACK_JSON = "lobby_state.json";

const WS_OPEN_TIMEOUT = 12_000;      // délai max avant de passer au niveau suivant
const WS_RECONNECT_BASE = 1_000;     // backoff exponentiel
const WS_RECONNECT_MAX = 15_000;
const HTTP_POLL_INTERVAL = 60_000;   // fallback : refresh 60 s
const COUNTDOWN_TICK = 1_000;
const MAX_CARDS_PER_ROW = 30;

// Catégories affichées (hosted n'est pas exposé par le flux public)
const SECTIONS = [
  { key: "ffa", label: "Free For All", icon: "swords" },
  { key: "team", label: "Team", icon: "users" },
  { key: "special", label: "Spécial", icon: "bolt" },
];

// Filtre segmenté (maquette C) : toutes les catégories, une seule, ou les
// cartes favorites (« fav » nécessite un compte — favoris stockés en base).
const FILTERS = [
  { key: "all", label: "Toutes" },
  { key: "ffa", label: "FFA" },
  { key: "team", label: "Team" },
  { key: "special", label: "Spécial" },
  { key: "fav", label: "Favoris" },
];

/* ════════════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════════════ */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(v) {
  return v == null ? "" : String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Slug du dossier de map OpenFront ("Amazon River" → "amazonriver"). */
function mapSlug(mapName) {
  return typeof mapName === "string"
    ? mapName.toLowerCase().replace(/[\s_]/g, "").replace(/[^\w]/g, "")
    : "";
}

/** URL de la miniature de map (repo GitHub OpenFrontIO, CDN public). */
function mapThumb(mapName) {
  const slug = mapSlug(mapName);
  return slug
    ? `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${slug}/thumbnail.webp`
    : "";
}

/** "isCompact" → "Compact", pour l'affichage des pills de modificateurs. */
function humanizeFlag(name) {
  return name.replace(/^is(?=[A-Z])/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Liste des pills à afficher, façon OpenFront (labels FR courts). */
const PILL_LABELS = {
  compact: "Compact",
  crowded: "Chargée",
  hardNations: "Nations diff.",
  waterNukes: "Nukes marines",
  noNations: "Sans nations",
  infiniteGold: "Or infini",
  infiniteTroops: "Troupes inf.",
  instantBuild: "Build instant",
  randomSpawn: "Spawn aléa.",
  alliancesOff: "Sans alliances",
  portsOff: "Sans ports",
  nukesOff: "Sans nukes",
  samsOff: "Sans SAM",
  peaceTime: "Peace time",
  doomsdayClock: "Horloge",
  overtime: "Overtime",
  disabledUnits: "Unités désact.",
  goldMultiplier: null, // dynamique → "Or ×N"
  startingGold: null,   // dynamique → "Or N M"
};

function modifierPills(game) {
  const cfg = game.gameConfig || {};
  const mods = cfg.publicGameModifiers || {};
  const pills = [];

  if (mods.isCompact || cfg.gameMapSize === "Compact") pills.push("compact");
  if (mods.isCrowded) pills.push("crowded");
  if (mods.isHardNations) pills.push("hardNations");
  if (mods.isWaterNukes || cfg.waterNukes === true) pills.push("waterNukes");
  if (cfg.nations === "disabled") pills.push("noNations");
  if (mods.isAlliancesDisabled || cfg.disableAlliances === true) pills.push("alliancesOff");
  if (mods.isPortsDisabled) pills.push("portsOff");
  if (mods.isNukesDisabled) pills.push("nukesOff");
  if (mods.isSAMsDisabled) pills.push("samsOff");
  if (mods.isPeaceTime) pills.push("peaceTime");
  if (mods.isDoomsdayClock) pills.push("doomsdayClock");
  if (mods.isOvertime) pills.push("overtime");
  if (cfg.randomSpawn) pills.push("randomSpawn");
  if (cfg.infiniteGold) pills.push("infiniteGold");
  if (cfg.infiniteTroops) pills.push("infiniteTroops");
  if (cfg.instantBuild) pills.push("instantBuild");
  if (Array.isArray(cfg.disabledUnits) && cfg.disabledUnits.length) pills.push("disabledUnits");

  if (mods.goldMultiplier && Number(mods.goldMultiplier) !== 1) {
    pills.push(`Or ×${mods.goldMultiplier}`);
  }
  if (mods.startingGold) {
    const m = Math.round(Number(mods.startingGold) / 1_000_000);
    if (m > 0 && m !== 5) pills.push(`Or ${m}M`); // 5M = défaut, pas de pill
  }
  return pills.slice(0, 4); // max 4 pills visibles
}

function pillLabel(p) {
  if (PILL_LABELS.hasOwnProperty(p)) return PILL_LABELS[p];
  return p; // libellés dynamiques ("Or ×3") déjà lisibles
}

/** Format d'équipe : {teams, perTeam, hvn} → "Duos · 4 équipes" etc. */
const TEAM_SIZES = { duos: 2, trios: 3, quads: 4, quints: 5, sextets: 6 };
const PER_TEAM_LABEL = { 2: "Duos", 3: "Trios", 4: "Quads" };

function describeTeams(cfg) {
  const max = Number(cfg.maxPlayers) || 0;
  const pt = cfg.playerTeams;
  if (typeof pt === "number" && pt > 0) {
    const per = max ? Math.floor(max / pt) : 0;
    return per > 0 ? `${pt} équipes de ${per}` : `${pt} équipes`;
  }
  if (typeof pt === "string") {
    const s = pt.trim().toLowerCase();
    if (s === "humans vs nations") return "Humains vs Nations";
    const n = TEAM_SIZES[s];
    if (n) {
      const label = PER_TEAM_LABEL[n] || `${n} joueurs`;
      return max ? `${label} · ${Math.floor(max / n)} équipes` : label;
    }
  }
  return cfg.gameMode === "Team" ? "Team" : "FFA";
}

/** Compte à rebours lisible ("Imminent", "3 min", "1h 20min", "En cours"). */
function countdownText(startsAt, serverNow) {
  if (!startsAt) return "En attente";
  const delta = startsAt - serverNow;
  if (delta <= 0) return "En cours";
  const s = Math.floor(delta / 1000);
  if (s < 60) return s <= 10 ? "Imminent" : `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60 ? (m % 60) + " min" : ""}`.trim();
}

function modeLabel(game) {
  const cfg = game.gameConfig || {};
  if (game.publicGameType === "special") return "Spécial";
  if (cfg.rankedType) return cfg.rankedType === "2v2" ? "Classé 2v2" : "Classé 1v1";
  return describeTeams(cfg);
}

/* ════════════════════════════════════════════════════════════════════════
   État global
   ════════════════════════════════════════════════════════════════════════ */

const state = {
  source: "idle",          // direct | proxy | fallback | idle
  serverTime: Date.now(),  // horloge serveur OpenFront (drift compensé)
  serverTimeAt: Date.now(),
  games: { ffa: [], team: [], special: [] },
  connected: false,
  updatedAt: 0,            // Date.now() du dernier snapshot (label « Actualisé il y a… »)
  filter: "all",           // filtre actif (all | ffa | team | special | fav)
  account: null,           // compte connecté (api/me.php) ou null
  favorites: new Set(),    // slugs des cartes favorites (api/favorites.php)
  knownIds: null,          // Set des ids du dernier snapshot (détection nouvelles parties)
  hydrated: false,         // true après le 1er snapshot (le toast favori ne s'arme qu'ensuite)
};

/** Retrouve une partie par son id, toutes catégories confondues. */
function findGame(id) {
  for (const k of ["ffa", "team", "special"]) {
    const found = state.games[k].find((g) => (g.gameID || g.id) === id);
    if (found) return found;
  }
  return null;
}

/** Toast pour les nouvelles parties jouées sur une carte favorite (max 3). */
function announceFavoriteGames(isNew) {
  const fresh = [];
  for (const k of Object.keys(state.games)) {
    for (const g of state.games[k]) {
      if (fresh.length >= 3) break;
      const cfg = g.gameConfig || {};
      const mapName = cfg.gameMap || "";
      if (mapName && isNew(g) && state.favorites.has(mapSlug(mapName))) fresh.push(mapName);
    }
    if (fresh.length >= 3) break;
  }
  fresh.forEach((mapName, i) => {
    setTimeout(() => {
      window.showToast?.(`Nouvelle partie sur ta carte favorite : ${mapDisplayName(mapName)}`, "info", 7000, "star");
    }, i * 400);
  });
}

/** Horloge serveur interpolée localement (serverTime + temps écoulé). */
function serverNow() {
  return state.serverTime + (Date.now() - state.serverTimeAt);
}

function setSource(source) {
  state.source = source;
  renderStatus();
}

function ingestFull(msg) {
  if (typeof msg.serverTime === "number") {
    state.serverTime = msg.serverTime;
    state.serverTimeAt = Date.now();
  }
  const g = msg.games || {};
  state.games = {
    ffa: Array.isArray(g.ffa) ? g.ffa.filter((x) => x && (x.gameID || x.id)) : [],
    team: Array.isArray(g.team) ? g.team.filter((x) => x && (x.gameID || x.id)) : [],
    special: Array.isArray(g.special) ? g.special.filter((x) => x && (x.gameID || x.id)) : [],
  };
  // Tri : la partie qui démarre le plus tôt en premier (sans startsAt → fin)
  for (const k of Object.keys(state.games)) {
    state.games[k].sort((a, b) => {
      const ta = Number(a.startsAt) || Infinity;
      const tb = Number(b.startsAt) || Infinity;
      return ta - tb;
    });
  }

  // Détection des NOUVELLES parties → toast si carte favorite
  const ids = new Set();
  for (const k of Object.keys(state.games)) {
    for (const g of state.games[k]) ids.add(g.gameID || g.id);
  }
  if (state.hydrated && state.knownIds) {
    const prev = state.knownIds;
    announceFavoriteGames((g) => !prev.has(g.gameID || g.id));
  }
  state.knownIds = ids;
  state.hydrated = true;

  state.updatedAt = Date.now();
  scheduleRender(true);
}

function ingestCounts(msg) {
  if (typeof msg.serverTime === "number") {
    state.serverTime = msg.serverTime;
    state.serverTimeAt = Date.now();
  }
  const counts = msg.counts || {};
  let touched = false;
  for (const k of Object.keys(state.games)) {
    for (const game of state.games[k]) {
      const id = game.gameID || game.id;
      if (id != null && Object.prototype.hasOwnProperty.call(counts, id)) {
        const n = Number(counts[id]);
        if (Number.isFinite(n) && n !== game.numClients) {
          game.numClients = n;
          touched = true;
        }
      }
    }
  }
  if (touched) scheduleRender(false); // maj légère : compteurs seulement
}

/* ════════════════════════════════════════════════════════════════════════
   Niveau 1 + 2 — WebSocket (direct puis proxy), décodage zbin
   ════════════════════════════════════════════════════════════════════════ */

const wire = () => (typeof window !== "undefined" ? window.OpenFrontWire : null);

let ws = null;
let wsGeneration = 0;
let wsFailCount = { direct: 0, proxy: 0 };
let decoderWarned = false;
let wsReconnectTimer = null;
let wsOpenTimer = null;

function stopWebSocket() {
  wsGeneration++;
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (wsOpenTimer) { clearTimeout(wsOpenTimer); wsOpenTimer = null; }
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
}

/** Tente le niveau `direct` puis `proxy`. En cas d'échec répété → N3 (HTTP). */
function startWebSocket() {
  const gen = ++wsGeneration;

  const useProxy = wsFailCount.direct >= 2;
  const url = useProxy
    ? PROXY_WS_URL
    : `wss://openfront.io/${DIRECT_WORKERS[Math.floor(Math.random() * DIRECT_WORKERS.length)]}/lobbies`;
  const level = useProxy ? "proxy" : "direct";

  console.log(`[lobby] Connexion ${level} → ${url}`);

  let sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    wsFailed(gen, level);
    return;
  }
  ws = sock;
  sock.binaryType = "arraybuffer"; // ⚠️ indispensable : le flux est en zbin binaire

  // Si pas connecté après WS_OPEN_TIMEOUT → niveau suivant
  wsOpenTimer = setTimeout(() => {
    if (gen === wsGeneration && sock.readyState !== WebSocket.OPEN) {
      try { sock.close(); } catch { /* ignore */ }
    }
  }, WS_OPEN_TIMEOUT);

  sock.onopen = () => {
    if (gen !== wsGeneration) return;
    clearTimeout(wsOpenTimer);
    wsFailCount[level] = 0;
    state.connected = true;
    setSource(level);
    console.log(`[lobby] ✅ WebSocket ${level} connecté`);
    // Le serveur envoie immédiatement un snapshot "full" — rien à demander.
  };

  sock.onmessage = (event) => {
    if (gen !== wsGeneration) return;
    const decoder = wire();
    if (!decoder) {
      // Sans décodeur, toutes les frames seraient silencieusement perdues :
      // le lobby resterait vide sous badge « Temps réel ». On signale fort.
      if (!decoderWarned) {
        decoderWarned = true;
        console.error("[lobby] OpenFrontWire indisponible — frames zbin ignorées");
      }
      return;
    }
    try {
      const bytes = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : new Uint8Array(event.data);
      const msg = decoder.decodeLobbyMessage(bytes);
      if (msg && msg.type === "full") ingestFull(msg);
      else if (msg && msg.type === "counts") ingestCounts(msg);
    } catch (e) {
      // Une frame illisible ne doit pas tuer la connexion : on ignore.
      console.warn("[lobby] frame zbin ignorée:", e.message);
    }
  };

  sock.onclose = () => { if (gen === wsGeneration) wsFailed(gen, level); };
  sock.onerror = () => {
    if (gen === wsGeneration) {
      try { sock.close(); } catch { /* ignore */ }
    }
  };
}

function wsFailed(gen, level) {
  if (gen !== wsGeneration) return;
  clearTimeout(wsOpenTimer);
  state.connected = false;
  wsFailCount[level]++;

  // Trop d'échecs cumulés → on bascule sur le fallback HTTP (N3)
  if (wsFailCount.direct >= 2 && wsFailCount.proxy >= 2) {
    console.warn("[lobby] WS indisponible (direct + proxy) → fallback HTTP");
    startHttpFallback();
    return;
  }

  const delay = Math.min(
    WS_RECONNECT_BASE * Math.pow(2, Math.max(wsFailCount.direct, wsFailCount.proxy) - 1),
    WS_RECONNECT_MAX,
  );
  wsReconnectTimer = setTimeout(() => {
    if (gen === wsGeneration) startWebSocket();
  }, delay);
}

/* ════════════════════════════════════════════════════════════════════════
   Niveau 3 — HTTP fallback (lobby_state.json, sync GitHub Actions 5 min)
   ════════════════════════════════════════════════════════════════════════ */

let httpTimer = null;
let httpAbort = null;

async function pollFallbackJson() {
  try {
    if (httpAbort) httpAbort.abort();
    httpAbort = new AbortController();
    const res = await fetch(`${FALLBACK_JSON}?t=${Date.now()}`, {
      cache: "no-store",
      signal: httpAbort.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.games && typeof data.games === "object") {
      ingestFull({
        serverTime: typeof data.serverTime === "number" ? data.serverTime : Date.now(),
        games: data.games,
      });
      state.connected = true;
      setSource("fallback");
    } else if (data && typeof data === "object") {
      // JSON valide mais sans games (ancien format) → état vide plutôt qu'attente infinie
      ingestFull({ serverTime: Date.now(), games: {} });
      state.connected = true;
      setSource("fallback");
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    state.connected = false;
    setSource("offline");
  }
}

function startHttpFallback() {
  stopWebSocket();
  setSource("fallback");
  pollFallbackJson();
  if (httpTimer) clearInterval(httpTimer);
  httpTimer = setInterval(pollFallbackJson, HTTP_POLL_INTERVAL);

  // Toutes les 5 min, on retente le WebSocket (le blocage peut être temporaire)
  setTimeout(() => {
    if (state.source === "fallback") {
      console.log("[lobby] Retente WebSocket après fallback…");
      wsFailCount = { direct: 0, proxy: 0 };
      if (httpTimer) { clearInterval(httpTimer); httpTimer = null; }
      startWebSocket();
    }
  }, 5 * 60_000);
}

/* ════════════════════════════════════════════════════════════════════════
   Rendu — grandes cartes défilantes façon OpenFront
   ════════════════════════════════════════════════════════════════════════ */

const view = () => document.getElementById("lobby-view");
let renderTimer = null;
let fullRender = true;

function scheduleRender(isFull) {
  fullRender = fullRender || !!isFull;
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    const wasFull = fullRender;
    fullRender = false;
    render(wasFull);
  }, 120);
}

function buildSkeleton() {
  const v = view();
  if (!v) return false;
  if (document.getElementById("lobby-root")) return true; // déjà construit

  v.innerHTML = `
    <div id="lobby-root">
      <div class="lobby-filter" role="group" aria-label="Filtrer les parties">
        <span class="lobby-filter-label">Afficher</span>
        <div class="lobby-filter-group">
          ${FILTERS.map((f) => `<button type="button" class="lobby-filter-btn" data-filter="${f.key}" aria-pressed="${f.key === "all"}">${esc(f.label)}</button>`).join("")}
        </div>
        <span class="lobby-filter-updated" id="lobby-updated"></span>
      </div>
      <a class="lobby-banner" id="lobby-hero" hidden></a>
      <div id="lobby-sections"></div>
    </div>`;

  // Filtre segmenté : toutes les sections, une catégorie, ou les favoris
  const lobbyRoot = $("#lobby-root");
  $$(".lobby-filter-btn", lobbyRoot).forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.filter;
      // Le filtre Favoris nécessite un compte connecté (favoris en base)
      if (key === "fav" && !state.account) {
        promptLogin();
        return;
      }
      state.filter = key;
      $$(".lobby-filter-btn", lobbyRoot).forEach((b) =>
        b.setAttribute("aria-pressed", String(b === btn)));
      for (const sec of SECTIONS) {
        const el = document.getElementById(`lobby-sec-${sec.key}`);
        if (el) el.hidden = key !== "all" && key !== "fav" && sec.key !== key;
      }
      scheduleRender(true);
    });
  });

  const sections = $("#lobby-sections");
  for (const sec of SECTIONS) {
    const el = document.createElement("section");
    el.className = "lobby-section";
    el.id = `lobby-sec-${sec.key}`;
    el.innerHTML = `
      <header class="lobby-section-head">
        <h2 class="lobby-section-title">${esc(sec.label)}</h2>
        <span class="lobby-section-count" id="lobby-count-${sec.key}"></span>
        <span class="lobby-section-rule" aria-hidden="true"></span>
        <div class="lobby-section-nav">
          <button class="lobby-arrow" data-dir="-1" aria-label="Défiler vers la gauche">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button class="lobby-arrow" data-dir="1" aria-label="Défiler vers la droite">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </header>
      <div class="lobby-track-zone">
        <div class="lobby-track" id="lobby-track-${sec.key}" tabindex="0" role="list"
             aria-label="Parties ${esc(sec.label)}"></div>
      </div>`;
    sections.appendChild(el);

    // Flèches de défilement manuel
    const track = $(`#lobby-track-${sec.key}`, el);
    $$(".lobby-arrow", el).forEach((btn) => {
      btn.addEventListener("click", () => {
        pauseAutoScroll(track, 6000);
        track.scrollBy({ left: Number(btn.dataset.dir) * track.clientWidth * 0.8, behavior: "smooth" });
      });
    });
  }

  // Zones vides / loading
  if (!document.getElementById("lobby-empty")) {
    const empty = document.createElement("div");
    empty.id = "lobby-empty";
    empty.className = "lobby-empty";
    empty.hidden = true;
    v.appendChild(empty);
  }
  return true;
}

/** Étoile (contour / pleine) du bouton favori — window.icon() d'icons.js si dispo. */
function favIconSvg(filled) {
  if (typeof window.icon === "function") {
    const svg = window.icon(filled ? "star" : "starOutline", { size: 14 });
    if (svg) return svg;
  }
  const path = '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.8 6.6 20l1-6.1L3.2 9.5l6.1-.9L12 3z"/>';
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${path}</svg>`;
}

/** État visuel du bouton favori d'une carte. */
function setFavBtn(btn, filled) {
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(filled));
  btn.innerHTML = favIconSvg(filled);
  btn.title = filled ? "Retirer des cartes favorites" : "Ajouter aux cartes favorites";
  btn.setAttribute("aria-label", filled ? "Retirer la carte des favoris" : "Ajouter la carte aux favoris");
}

/** La carte (maquette B — surface claire au design system). */
function buildCard(game) {
  const id = game.gameID || game.id || "";
  const cfg = game.gameConfig || {};
  const mapName = cfg.gameMap || "?";
  const url = `https://openfront.io/game/${encodeURIComponent(id)}`;

  const card = document.createElement("a");
  card.className = "lobby-card";
  card.target = "_blank";
  card.rel = "noopener";
  card.href = url;
  card.dataset.gameId = id;
  card.dataset.map = mapSlug(mapName);
  card.dataset.mapName = mapName;
  card.setAttribute("role", "listitem");
  card.innerHTML = `
    <span class="lobby-card-media">
      <img alt="" loading="lazy" draggable="false"
           src="${esc(mapThumb(mapName))}"
           onerror="this.remove()">
      <span class="lobby-card-img-fallback">${esc(mapName.slice(0, 1).toUpperCase())}</span>
      <span class="lobby-card-shade" aria-hidden="true"></span>
      <span class="lobby-card-timer" data-role="timer"></span>
      <span class="lobby-card-almost" data-role="almost" hidden>Presque pleine</span>
      <span class="lobby-card-pills"></span>
      <button type="button" class="lobby-card-fav" data-role="fav"
              aria-pressed="false" title="Ajouter aux cartes favorites"
              aria-label="Ajouter la carte aux favoris">${favIconSvg(false)}</button>
    </span>
    <span class="lobby-card-body">
      <h3 class="lobby-card-map"></h3>
      <p class="lobby-card-mode"></p>
      <span class="lobby-card-fill" aria-hidden="true"><span class="lobby-card-fill-bar" data-role="fill"></span></span>
      <span class="lobby-card-foot">
        <span class="lobby-card-players" data-role="players"></span>
        <span class="lobby-card-cta" aria-hidden="true">Rejoindre
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
        </span>
      </span>
    </span>`;
  return card;
}

function updateCard(card, game, opts) {
  const cfg = game.gameConfig || {};
  const mapName = cfg.gameMap || "?";
  const cap = Number(cfg.maxPlayers) || 0;
  const nPlayers = Number(game.numClients) || 0;

  if (opts.full) {
    const img = $(".lobby-card-media img", card);
    const src = mapThumb(mapName);
    if (img) {
      if (img.getAttribute("src") !== src) img.setAttribute("src", src);
      img.alt = mapName;
    }
    $(".lobby-card-img-fallback", card).textContent = mapName.slice(0, 1).toUpperCase();

    const pills = $(".lobby-card-pills", card);
    const labels = modifierPills(game);
    const sig = labels.join("|");
    if (pills.dataset.sig !== sig) {
      pills.dataset.sig = sig;
      pills.innerHTML = labels.map((p) => `<span class="lobby-pill">${esc(pillLabel(p))}</span>`).join("");
    }

    const mapEl = $(".lobby-card-map", card);
    const mapLabel = mapDisplayName(mapName);
    if (mapEl.textContent !== mapLabel) mapEl.textContent = mapLabel;

    const mode = modeLabel(game);
    const modeEl = $(".lobby-card-mode", card);
    if (modeEl.textContent !== mode) modeEl.textContent = mode;

    card.dataset.map = mapSlug(mapName);
    card.dataset.mapName = mapName;
    card.classList.toggle("no-cap", cap <= 0);

    // Étoile favori (état depuis la base)
    setFavBtn($("[data-role=fav]", card), state.favorites.has(card.dataset.map));

    card.classList.toggle("is-featured", !!game.featured);
    card.classList.toggle("is-full", cap > 0 && nPlayers >= cap);
  }

  // Barre de remplissage + badge « Presque pleine » (maj fréquente : les
  // messages "counts" patchent numClients sans re-render complet)
  const pct = cap > 0 ? Math.min(100, Math.round((nPlayers / cap) * 100)) : 0;
  const fill = $("[data-role=fill]", card);
  if (fill) fill.style.width = pct + "%";
  const almost = cap > 0 && pct >= 80 && nPlayers < cap;
  card.classList.toggle("is-almost-full", almost);
  const almostEl = $("[data-role=almost]", card);
  if (almostEl) almostEl.hidden = !almost;

  // Compteur joueurs + compte à rebours (maj fréquente)
  const players = `${nPlayers}${cap ? "/" + cap : ""}`;
  const pEl = $("[data-role=players]", card);
  if (pEl && pEl.textContent !== players) pEl.textContent = players;

  const tEl = $("[data-role=timer]", card);
  const txt = countdownText(Number(game.startsAt) || 0, serverNow());
  if (tEl) {
    if (tEl.textContent !== txt) tEl.textContent = txt;
    tEl.classList.toggle("urgent", txt === "Imminent" || txt === "En cours");
  }
}

/* ── Auto-défilement des carrousels ─────────────────────────────────── */

const autoScrollState = new WeakMap(); // track → {pausedUntil, raf}

function pauseAutoScroll(track, ms) {
  const st = autoScrollState.get(track);
  if (st) st.pausedUntil = Math.max(st.pausedUntil || 0, Date.now() + ms);
}

function startAutoScroll(track, speedPxPerSec) {
  if (autoScrollState.has(track)) return; // déjà actif
  const st = { pausedUntil: 0, last: performance.now(), dragging: false, carry: 0 };
  autoScrollState.set(track, st);

  const step = (now) => {
    const dt = Math.min(now - st.last, 100);
    st.last = now;
    const auto = track.dataset.autoScroll !== "off";
    const hovered = track.matches(":hover");
    const paused = Date.now() < (st.pausedUntil || 0);

    if (!st.dragging && !hovered && !paused && auto) {
      // ⚠️ scrollLeft est arrondi à l'entier par le navigateur : on accumule
      // les fractions en JS et on n'écrit que des pixels entiers.
      st.carry += (speedPxPerSec * dt) / 1000;
      if (st.carry >= 1) {
        const whole = Math.floor(st.carry);
        st.carry -= whole;
        // Une seule copie des cartes (pas de duplication) : en fin de piste
        // on repasse simplement au début.
        const maxScroll = track.scrollWidth - track.clientWidth;
        if (maxScroll > 0) {
          if (track.scrollLeft >= maxScroll - 1) {
            track.scrollLeft = 0;
          } else {
            track.scrollLeft = Math.min(track.scrollLeft + whole, maxScroll);
          }
        }
      }
    }
    if (track.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  // ── Drag manuel (souris uniquement ; le tactile garde le scroll natif) ──
  // ⚠️ NE PAS utiliser setPointerCapture : il retargete le pointerup vers la
  // piste, le navigateur émet alors le clic sur la piste (ancêtre commun de
  // pointerdown/pointerup) et JAMAIS sur le lien de la carte → « cliquer une
  // carte ne fait rien ». On drague via des listeners fenêtre et on n'avale
  // le clic qu'après un VRAI déplacement (seuil 6 px).
  const DRAG_THRESHOLD = 6;
  let activePointer = null;

  const onMove = (e) => {
    if (activePointer !== e.pointerId) return;
    const dx = e.clientX - st.downX;
    if (!st.dragging && Math.abs(dx) > DRAG_THRESHOLD) st.dragging = true;
    if (st.dragging) {
      track.scrollLeft = st.downScroll - dx;
      pauseAutoScroll(track, 4000);
    }
  };
  const onUp = (e) => {
    if (activePointer !== e.pointerId) return;
    activePointer = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (st.dragging) {
      st.dragging = false;
      st.suppressClick = true; // le clic qui suit est un reliquat du drag
    }
  };

  track.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    activePointer = e.pointerId;
    st.downX = e.clientX;
    st.downScroll = track.scrollLeft;
    st.dragging = false;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  track.addEventListener("click", (e) => {
    if (st.suppressClick) {
      st.suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  track.addEventListener("wheel", () => pauseAutoScroll(track, 5000), { passive: true });
}

/* ── Rendu principal ────────────────────────────────────────────────── */

function render(isFull) {
  if (!buildSkeleton()) return;

  // Liste VISIBLE par section (le filtre « fav » ne garde que les cartes favorites)
  const filtering = state.filter === "fav";
  const visible = {};
  let total = 0;
  for (const sec of SECTIONS) {
    const list = state.games[sec.key] || [];
    visible[sec.key] = filtering
      ? list.filter((g) => state.favorites.has(mapSlug((g.gameConfig || {}).gameMap || "")))
      : list;
    total += visible[sec.key].length;
  }
  const emptyEl = document.getElementById("lobby-empty");

  if (total === 0) {
    // FIX (bug favoris) : le message « favoris vide » est PRIORITAIRE sur le
    // message « flux indisponible » — quand l'utilisateur a volontairement
    // filtré, le filtre ne doit jamais laisser croire que le site est en panne.
    if (state.source === "idle") {
      emptyEl.hidden = false;
      emptyEl.innerHTML = `
        <div class="lobby-loading">
          <div class="spinner"></div>
          <p>Connexion aux serveurs OpenFront…</p>
        </div>`;
    } else if (filtering) {
      emptyEl.hidden = false;
      emptyEl.innerHTML = `
        <div class="lobby-empty-inner">
          <div class="lobby-empty-icon"><i data-icon="star" data-icon-size="32"></i></div>
          <h3>Aucune partie sur tes cartes favorites</h3>
          <p>Clique l'étoile d'une carte pour l'ajouter à tes favoris —<br>tu seras prévenu dès qu'une partie s'ouvre dessus.</p>
        </div>`;
    } else if (state.source === "fallback" || state.source === "offline") {
      // Mode dégradé : le flux temps réel est injoignable depuis ce réseau
      emptyEl.hidden = false;
      emptyEl.innerHTML = `
        <div class="lobby-empty-inner">
          <div class="lobby-empty-icon"><i data-icon="globe" data-icon-size="32"></i></div>
          <h3>Flux temps réel indisponible</h3>
          <p>Impossible de joindre les serveurs OpenFront en direct depuis ce réseau.<br>Les parties réapparaîtront dès la reconnexion.</p>
          <button class="lobby-retry-btn" type="button">Réessayer</button>
        </div>`;
      const retry = $(".lobby-retry-btn", emptyEl);
      if (retry) retry.addEventListener("click", () => {
        wsFailCount = { direct: 0, proxy: 0 };
        if (httpTimer) { clearInterval(httpTimer); httpTimer = null; }
        setSource("idle");
        render(true);
        startWebSocket();
      });
    } else {
      emptyEl.hidden = false;
      emptyEl.innerHTML = `
        <div class="lobby-empty-inner">
          <div class="lobby-empty-icon"><i data-icon="hourglass" data-icon-size="32"></i></div>
          <h3>Aucune partie en attente</h3>
          <p>Les nouvelles parties OpenFront apparaîtront ici automatiquement.</p>
        </div>`;
    }
    // FIX (bug favoris) : on ne masque PLUS #lobby-root en entier — il contient
    // la barre de filtres (Toutes/FFA/Team/Spécial/Favoris). Quand le filtre
    // « Favoris » n'avait aucun résultat, toute la barre disparaissait avec la
    // vue : impossible de recliquer « Toutes » → coincé sur les favoris.
    // On masque uniquement les sections + le bandeau hero, le filtre reste
    // cliquable pour revenir en arrière.
    const sectionsEl = document.getElementById("lobby-sections");
    if (sectionsEl) sectionsEl.style.display = "none";
    const heroEl = document.getElementById("lobby-hero");
    if (heroEl) heroEl.hidden = true;
    renderStatus();
    return;
  }

  emptyEl.hidden = true;
  document.getElementById("lobby-root").style.display = "";
  // Ré-affiche les sections (cachées par l'état vide ci-dessus)
  const sectionsEl = document.getElementById("lobby-sections");
  if (sectionsEl) sectionsEl.style.display = "";

  // Hero : la prochaine partie à démarrer (toutes catégories)
  if (isFull) renderHero();
  // Le bandeau « Prochaine partie » n'a pas de sens filtré sur les favoris
  if (filtering) {
    const heroEl = document.getElementById("lobby-hero");
    if (heroEl) heroEl.hidden = true;
  }

  for (const sec of SECTIONS) {
    const games = visible[sec.key];
    const countEl = document.getElementById(`lobby-count-${sec.key}`);
    if (countEl) countEl.textContent = games.length ? `${games.length}` : "";

    const track = document.getElementById(`lobby-track-${sec.key}`);
    if (!track) continue;

    if (games.length === 0) {
      const msg = filtering
        ? "Aucune partie sur tes cartes favorites"
        : `Aucune partie ${esc(sec.label.toLowerCase())} en attente`;
      if (track.dataset.empty !== "1" || track.dataset.emptyMsg !== msg) {
        track.dataset.empty = "1";
        track.dataset.emptyMsg = msg;
        track.innerHTML = `<div class="lobby-track-empty">${msg}</div>`;
      }
      // ⚠️ Invalide la signature : au retour du filtre (ou d'un nouveau
      // snapshot), la piste DOIT être reconstruite même si la liste d'ids
      // redevient identique à celle d'avant la mise en vide.
      track.dataset.sig = "";
      track.dataset.count = "0";
      continue;
    }
    track.dataset.empty = "";

    // Reconstruction UNIQUEMENT si la liste de parties a changé (signature par
    // IDs). Sinon simple mise à jour des cartes → le scroll et l'auto-défilement
    // ne sont jamais interrompus par les polls répétés.
    const sig = games.map((g) => g.gameID || g.id).join(",");
    const needsRebuild = track.dataset.sig !== sig;

    if (needsRebuild) {
      const savedScroll = track.scrollLeft;
      track.dataset.sig = sig;
      // Chaque partie est rendue UNE SEULE fois (pas de cartes en double)
      const shown = games.slice(0, MAX_CARDS_PER_ROW);
      const cards = shown.map((g) => buildCard(g));
      track.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const c of cards) frag.appendChild(c);
      track.appendChild(frag);
      track.dataset.count = String(shown.length);
      // Restaure la position de scroll (clampée au nouveau contenu)
      const max = Math.max(0, track.scrollWidth - track.clientWidth);
      track.scrollLeft = Math.min(savedScroll, max);
      startAutoScroll(track, 18); // ~18 px/s, défilement lent (pause au survol)
    }

    // Mise à jour des cartes visibles (timers + joueurs + contenu)
    const count = Number(track.dataset.count) || 0;
    const children = track.children;
    for (let i = 0; i < children.length; i++) {
      const card = children[i];
      if (!card.classList.contains("lobby-card")) continue;
      const idx = i % Math.max(count, 1);
      const game = games[idx];
      if (game) updateCard(card, game, { full: needsRebuild || isFull });
    }
  }
  renderStatus();
}

/** Grande carte "prochaine partie" (celle qui démarre le plus tôt). */
function renderHero() {
  const hero = document.getElementById("lobby-hero");
  if (!hero) return;
  const all = [
    ...state.games.ffa, ...state.games.team, ...state.games.special,
  ].filter((g) => Number(g.startsAt) > 0);
  if (all.length === 0) { hero.hidden = true; hero.innerHTML = ""; return; }

  const next = all.reduce((a, b) => (Number(a.startsAt) < Number(b.startsAt) ? a : b));
  const cfg = next.gameConfig || {};
  const mapName = cfg.gameMap || "?";

  // FIX : ré-affiche toujours le bandeau hors mode favoris (il restait masqué
  // après un aller-retour Favoris → Toutes, caché par le rendu favoris).
  hero.hidden = false;
  if (hero.dataset.gameId !== (next.gameID || next.id)) {
    hero.dataset.gameId = next.gameID || next.id || "";
    const url = `https://openfront.io/game/${encodeURIComponent(next.gameID || next.id || "")}`;
    const bannerMode = [modeLabel(next), ...modifierPills(next).map((p) => pillLabel(p))].join(" · ");
    hero.innerHTML = `
      <span class="lobby-banner-dot" aria-hidden="true"></span>
      <span class="lobby-banner-label">Prochaine partie</span>
      <span class="lobby-banner-thumb">
        <img alt="" src="${esc(mapThumb(mapName))}" onerror="this.remove()">
        <span class="lobby-banner-thumb-fallback">${esc(mapName.slice(0, 1).toUpperCase())}</span>
      </span>
      <span class="lobby-banner-name">${esc(mapDisplayName(mapName))}</span>
      <span class="lobby-banner-mode">${esc(bannerMode)}</span>
      <span class="lobby-banner-players" data-role="hero-players"></span>
      <span class="lobby-card-timer" data-role="hero-timer"></span>
      <span class="lobby-banner-cta">Rejoindre
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
      </span>`;
    hero.setAttribute("aria-label", `Rejoindre la prochaine partie : ${mapDisplayName(mapName)}`);
  }

  // Mise à jour dynamique
  const cap = Number(cfg.maxPlayers) || 0;
  const players = `${Number(next.numClients) || 0}${cap ? "/" + cap : ""}`;
  const pEl = $("[data-role=hero-players]", hero);
  if (pEl && pEl.textContent !== players) pEl.textContent = players;
  const tEl = $("[data-role=hero-timer]", hero);
  if (tEl) {
    const txt = countdownText(Number(next.startsAt) || 0, serverNow());
    tEl.textContent = txt;
    tEl.classList.toggle("urgent", txt === "Imminent" || txt === "En cours");
  }
}

/* ── Barre d'état (topbar) ──────────────────────────────────────────── */

const SOURCE_META = {
  direct:   { cls: "connected", label: "Temps réel", title: "WebSocket OpenFront (direct)" },
  proxy:    { cls: "connected", label: "Temps réel", title: "WebSocket OpenFront (proxy Cloudflare)" },
  fallback: { cls: "delayed",   label: "Cache 5 min", title: "Flux temps réel indisponible — données rafraîches toutes les 5 min" },
  offline:  { cls: "error",     label: "Hors ligne", title: "Impossible de joindre OpenFront" },
  idle:     { cls: "",          label: "Connexion…", title: "Connexion en cours" },
};

function renderStatus() {
  const el = document.getElementById("lobby-status");
  if (!el) return;
  const meta = SOURCE_META[state.source] || SOURCE_META.idle;
  el.className = `lobby-status ${meta.cls}`;
  el.title = meta.title;
  const label = $("#lobby-status-label", el);
  if (label) label.textContent = meta.label;

  const stats = document.getElementById("lobby-stats");
  if (stats) {
    const total = state.games.ffa.length + state.games.team.length + state.games.special.length;
    const players = ["ffa", "team", "special"].reduce(
      (sum, k) => sum + state.games[k].reduce((s, g) => s + (Number(g.numClients) || 0), 0), 0);
    stats.textContent = total > 0
      ? `${total} partie${total > 1 ? "s" : ""} en attente · ${players} joueur${players > 1 ? "s" : ""}`
      : "";
  }
}

/** Injecte la pill d'état dans la topbar (une seule fois). */
function ensureStatusBar() {
  const right = document.querySelector(".topbar-right");
  if (!right || document.getElementById("lobby-status")) return;
  right.innerHTML = `
    <span id="lobby-stats" class="lobby-stats"></span>
    <span id="lobby-status" class="lobby-status" title="Connexion en cours">
      <span class="lobby-status-dot"></span>
      <span id="lobby-status-label">Connexion…</span>
    </span>`;
}

/* ════════════════════════════════════════════════════════════════════════
   Compte + cartes favorites (api/me.php + api/favorites.php, MySQL)
   Favoris stockés EN BASE : une session Discord est obligatoire pour en
   poser ; les visiteurs déconnectés voient le bouton Connexion.
   ════════════════════════════════════════════════════════════════════════ */

/** Identifie l'utilisateur (session PHP) puis charge ses favoris. */
async function initAccount() {
  try {
    const res = await fetch("api/me.php", { credentials: "same-origin", cache: "no-store" });
    state.account = res.ok ? ((await res.json()).user || null) : null;
  } catch {
    state.account = null; // offline / réseau bloqué : fonctionnalité cachée
  }
  if (state.account) await reloadFavorites();
  scheduleRender(true); // peint les étoiles + rend le filtre Favoris cliquable
}

async function reloadFavorites() {
  try {
    const res = await fetch("api/favorites.php", { credentials: "same-origin", cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      state.favorites = new Set(Array.isArray(data.favorites) ? data.favorites : []);
    }
  } catch { /* réseau : on garde l'état courant */ }
}

/** add/remove/toggle en base. → { ok, favorited?, auth? } */
async function toggleFavoriteRemote(slug) {
  try {
    const res = await fetch("api/favorites.php", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ map: slug, action: "toggle" }),
    });
    if (res.status === 401) {
      state.account = null;
      state.favorites = new Set();
      return { ok: false, auth: true };
    }
    if (!res.ok) return { ok: false };
    const data = await res.json();
    if (data.favorited) state.favorites.add(slug);
    else state.favorites.delete(slug);
    return { ok: true, favorited: !!data.favorited };
  } catch {
    return { ok: false };
  }
}

/** Invite à se connecter (modal + toast). */
function promptLogin() {
  window.showToast?.("Connecte-toi avec Discord pour enregistrer tes cartes favorites", "warning", 5000);
  window.toggleAuthModal?.();
}

/** Clic sur l'étoile d'une carte (délégation au niveau #lobby-view). */
async function onFavClick(btn) {
  const card = btn.closest(".lobby-card");
  if (!card || !card.dataset.map) return;
  if (!state.account) { promptLogin(); return; }

  const slug = card.dataset.map;
  const mapName = card.dataset.mapName || slug;
  const next = !state.favorites.has(slug);
  setFavBtn(btn, next); // optimiste

  const r = await toggleFavoriteRemote(slug);
  if (!r.ok) {
    if (r.auth) { promptLogin(); return; }
    setFavBtn(btn, state.favorites.has(slug)); // revert
    window.showToast?.("Impossible de mettre à jour tes favoris, réessaie", "error");
    return;
  }
  // Répercute sur toutes les cartes de la même carte (plusieurs parties possibles)
  $$('.lobby-card[data-map="' + slug + '"] [data-role=fav]').forEach((b) => setFavBtn(b, r.favorited));
  window.showToast?.(
    r.favorited ? `${mapDisplayName(mapName)} ajoutée à tes cartes favorites`
                : `${mapDisplayName(mapName)} retirée de tes cartes favorites`,
    "success", 3500, r.favorited ? "star" : "starOutline",
  );
  // En mode « Favoris », un retrait d'étoile doit retirer la carte de la vue
  // tout de suite (sinon elle reste affichée jusqu'au prochain snapshot WS).
  if (state.filter === "fav") scheduleRender(true);
}

/* ════════════════════════════════════════════════════════════════════════
   Boucle d'horloge (comptes à rebours chaque seconde)
   ════════════════════════════════════════════════════════════════════════ */

function startClock() {
  setInterval(() => {
    // Label « Actualisé il y a … » (dernier snapshot reçu)
    const upEl = document.getElementById("lobby-updated");
    if (upEl && state.updatedAt) {
      const s = Math.max(0, Math.round((Date.now() - state.updatedAt) / 1000));
      const txt = s < 5 ? "Actualisé à l'instant"
        : s < 60 ? `Actualisé il y a ${s} s`
        : `Actualisé il y a ${Math.floor(s / 60)} min`;
      if (upEl.textContent !== txt) upEl.textContent = txt;
    }
    // Maj légère : uniquement timers + compteurs (pas de re-render structurel)
    const root = document.getElementById("lobby-root");
    if (!root) return;
    $$("[data-role=timer]", root).forEach((el) => {
      const card = el.closest(".lobby-card");
      if (!card) return;
      const game = findGame(card.dataset.gameId);
      if (game) {
        const txt = countdownText(Number(game.startsAt) || 0, serverNow());
        if (el.textContent !== txt) el.textContent = txt;
        el.classList.toggle("urgent", txt === "Imminent" || txt === "En cours");
      }
    });
    // Hero timer
    const heroT = document.querySelector("[data-role=hero-timer]");
    if (heroT) {
      const hero = document.getElementById("lobby-hero");
      const id = hero && hero.dataset.gameId;
      const all = [...state.games.ffa, ...state.games.team, ...state.games.special];
      const game = all.find((g) => (g.gameID || g.id) === id);
      if (game) {
        const txt = countdownText(Number(game.startsAt) || 0, serverNow());
        heroT.textContent = txt;
        heroT.classList.toggle("urgent", txt === "Imminent" || txt === "En cours");
      }
    }
  }, COUNTDOWN_TICK);
}

/* ════════════════════════════════════════════════════════════════════════
   Boot
   ════════════════════════════════════════════════════════════════════════ */

function boot() {
  if (!view()) {
    console.warn("[lobby] #lobby-view introuvable");
    return;
  }
  ensureStatusBar();
  buildSkeleton();
  render(true);
  startClock();

  // Étoile favori : délégation au niveau de la vue — le clic sur l'étoile ne
  // doit JAMAIS suivre le lien de la carte (openfront.io).
  view().addEventListener("click", (e) => {
    const fav = e.target.closest("[data-role=fav]");
    if (fav) {
      e.preventDefault();
      e.stopPropagation();
      onFavClick(fav);
    }
  });

  // Compte + favoris (silencieux si déconnecté)
  initAccount();

  // Filet de sécurité : sans décodeur zbin (lobby-wire), le WebSocket ne peut
  // rien rendre — on bascule directement sur le fallback HTTP (lobby_state.json)
  // qui n'a PAS besoin du décodeur. Les cartes restent donc toujours visibles.
  if (!wire()) {
    console.error("[lobby] lobby-wire indisponible → fallback HTTP direct (décodage zbin impossible)");
    startHttpFallback();
    return;
  }
  startWebSocket();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// API de debug (console)
window._lobbyDebug = {
  state,
  reconnect: () => { wsFailCount = { direct: 0, proxy: 0 }; startWebSocket(); },
  fallback: startHttpFallback,
  ingest: (fake) => ingestFull(fake),
  // Tests : simule un compte connecté / des favoris (sans serveur PHP)
  setAccount: (u) => { state.account = u || null; scheduleRender(true); },
  setFavorites: (slugs) => { state.favorites = new Set(slugs || []); scheduleRender(true); },
  toggleFavoriteRemote,
  scrollState: (trackOrId) => {
    const track = typeof trackOrId === "string"
      ? document.getElementById(`lobby-track-${trackOrId}`)
      : trackOrId;
    return track ? autoScrollState.get(track) : null;
  },
};
