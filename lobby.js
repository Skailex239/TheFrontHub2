// lobby.js — Lobby Preview (parties OpenFront en temps réel)
// Source: wss://openfront.io/{w0-w4}/lobbies via proxy Cloudflare
// Format binaire: zbin — décodé via lobby-wire.js (OpenFrontWire.decodeLobbyMessage)
//
// Architecture:
//   1. WebSocket → proxy /lobby-ws → decodeLobbyMessage(bytes) → snapshot
//   2. 3 carrousels horizontaux auto-scroll (FFA, Team, Special) — pause au hover
//   3. Panneau de filtres latéral (catégorie, mode, mods, joueurs min/max, tri)
//   4. Sections préservées: stats bar, next-game highlight, ranked queue, historique, heatmap 24h

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════

// 🎯 Connexion WSS directe vers OpenFront (comme minhkarl.github.io)
// Pas de proxy : le navigateur se connecte directement à OpenFront.
// Cloudflare laisse passer les WS des vrais navigateurs.
const LOBBY_WS_POOL = ["w0", "w1", "w2", "w3", "w4"];
const LOBBY_WS_WORKER = LOBBY_WS_POOL[Math.floor(Math.random() * LOBBY_WS_POOL.length)];
const LOBBY_WS_URL = `wss://openfront.io/${LOBBY_WS_WORKER}/lobbies`;

const MM_WS_URL = (mode) =>
  `wss://openfront.io/matchmaking/join?instance_id=tfh-monitor&mode=${mode}`;

const LOBBY_VIEW = document.getElementById("lobby-view");
if (!LOBBY_VIEW) throw new Error("[lobby] #lobby-view missing");

// ── Modificateurs de partie ──
const MOD_LABEL = new Map(Object.entries({
  compact:        "Compact",
  hardNations:    "Nations diff.",
  waterNukes:     "Nukes marines",
  noNations:      "Sans nations",
  infiniteGold:   "Or infini",
  infiniteTroops: "Troupes infinies",
  instantBuild:   "Build instant",
  randomSpawn:    "Spawn aléa.",
  donateGold:     "Don d'or",
  donateTroops:   "Don de troupes",
  noClanTags:     "Sans tags",
  disabledUnits:  "Unités désact.",
}));
const DULL_MODS = new Set(["donateGold", "donateTroops", "noClanTags", "noNations"]);
const KNOWN_PM = new Set(["isCompact", "isHardNations", "isWaterNukes"]);
const TEAM_WORDS = { duos: 2, trios: 3, quads: 4, quints: 5, sextets: 6 };
const SIZE_WORDS = { 2: "Duos", 3: "Trios", 4: "Quads" };

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════

let ws = null;
let wsGen = 0;
let reconnectTimer = null;
let retries = 0;
let snapshot = null;            // { serverTime, games: { ffa, team, special } }
let renderTimer = null;
let cardEls = new Map();        // gameId → DOM node (for in-place updates)
let sharedState = null;         // from lobby_state.json
let historyLoaded = false;
let recentHistory = [];          // games qui viennent de quitter le lobby
let prevGameIds = new Set();

let wsStatus = "connecting";     // connecting | connected | reconnecting | error
let wsDown = false;              // true si WS abandonné après 5 échecs (mode dégradé)

let queueSize1v1 = null;
let queueSize2v2 = null;

// ── Filtres ──
const FILTERS = {
  q: "",                 // recherche texte (map, mode, game ID)
  cats: new Set(["ffa", "team", "special"]),  // catégories affichées
  mods: new Set(),       // mods requis (tous)
  modsExclude: new Set(),// mods exclus
  minPlayers: 0,
  maxPlayers: 0,         // 0 = pas de max
  minCapacity: 0,
  maxCapacity: 0,
  sortBy: "startsAt",   // startsAt | players | capacity | name
  hideFull: false,
  hideEmpty: false,
};

// ═══════════════════════════════════════════════════════════
//  UTILITAIRES
// ═══════════════════════════════════════════════════════════

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function mapSlug(mapName) {
  if (typeof mapName !== "string") return "";
  return mapName.toLowerCase().replace(/[\s_]/g, "").replace(/[^\w]/g, "");
}

function getMapThumbnailUrl(mapName) {
  const slug = mapSlug(mapName);
  if (!slug) return "";
  return `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${slug}/thumbnail.webp`;
}

function humanize(k) {
  return k.replace(/^is(?=[A-Z])/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, c => c.toUpperCase());
}
function pmKey(k) {
  const bare = k.replace(/^is(?=[A-Z])/, "");
  return bare.charAt(0).toLowerCase() + bare.slice(1);
}

function modsOf(cfg) {
  const set = new Set();
  const pm = cfg.publicGameModifiers || {};
  if (pm.isCompact || cfg.gameMapSize === "Compact") set.add("compact");
  if (pm.isHardNations) set.add("hardNations");
  if (pm.isWaterNukes || cfg.waterNukes) set.add("waterNukes");
  if (cfg.nations === "disabled") set.add("noNations");
  if (cfg.infiniteGold) set.add("infiniteGold");
  if (cfg.infiniteTroops) set.add("infiniteTroops");
  if (cfg.instantBuild) set.add("instantBuild");
  if (cfg.randomSpawn) set.add("randomSpawn");
  if (cfg.donateGold) set.add("donateGold");
  if (cfg.donateTroops) set.add("donateTroops");
  if (cfg.disableClanTags) set.add("noClanTags");
  if (Array.isArray(cfg.disabledUnits) && cfg.disabledUnits.length) set.add("disabledUnits");
  for (const [k, v] of Object.entries(pm)) {
    if (v !== true || KNOWN_PM.has(k)) continue;
    const key = pmKey(k);
    set.add(key);
    if (!MOD_LABEL.has(key)) MOD_LABEL.set(key, humanize(k));
  }
  return set;
}

function extrasOf(cfg) {
  const pm = cfg.publicGameModifiers || {};
  const out = [];
  for (const [k, v] of Object.entries(pm)) {
    if (typeof v !== "number") continue;
    if (k === "goldMultiplier") out.push(`Or ×${v}`);
    else out.push(`${humanize(k)} ${v}`);
  }
  return out;
}

function teamShape(playerTeams, capacity) {
  if (typeof playerTeams === "number" && playerTeams > 0)
    return { teams: playerTeams, perTeam: capacity ? Math.floor(capacity / playerTeams) : 0, hvn: false };
  if (typeof playerTeams === "string") {
    const key = playerTeams.trim().toLowerCase();
    if (key === "humans vs nations") return { teams: 0, perTeam: 0, hvn: true };
    const size = TEAM_WORDS[key];
    if (size) return { teams: capacity ? Math.floor(capacity / size) : 0, perTeam: size, hvn: false };
  }
  return { teams: 0, perTeam: 0, hvn: false };
}

function modeLabel(g) {
  if (g.hvn) return "Humains vs Nations";
  if (g.teams > 0) {
    const word = SIZE_WORDS[g.perTeam];
    return word ? `${word} · ${g.teams} équipes` : `${g.teams} équipes de ${g.perTeam}`;
  }
  return "Free For All";
}

function formatStartsAt(startsAt, serverTime) {
  if (!startsAt) return "Ouverte";
  const now = serverTime || Date.now();
  const diff = startsAt - now;
  if (diff <= 0) return "En cours";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Imminent";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h}h${mins % 60 ? " " + (mins % 60) + "min" : ""}`;
}

function formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) +
    " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function normalizeGame(raw) {
  const cfg = raw.gameConfig || raw.cfg || {};
  const capacity = Number(cfg.maxPlayers) || 0;
  const shape = teamShape(cfg.playerTeams, capacity);
  const mods = modsOf(cfg);
  const badges = [
    ...[...mods].filter(k => !DULL_MODS.has(k)).map(k => MOD_LABEL.get(k) || k),
    ...extrasOf(cfg),
  ];
  return {
    id: raw.gameID || raw.id || "",
    cat: raw.publicGameType || "ffa",
    players: Number(raw.numClients) || 0,
    capacity, map: cfg.gameMap || raw.map || "?",
    difficulty: cfg.difficulty || "",
    teams: shape.teams, perTeam: shape.perTeam, hvn: shape.hvn,
    startsAt: Number(raw.startsAt) || 0, badges, gameConfig: cfg,
  };
}

// ═══════════════════════════════════════════════════════════
//  WEBSOCKET (via proxy Cloudflare)
// ═══════════════════════════════════════════════════════════

function connect() {
  closeSocket();
  const gen = ++wsGen;
  setStatus("connecting", "Connexion…");
  console.log(`[lobby] Connecting to ${LOBBY_WS_URL}…`);

  let socket;
  try { socket = new WebSocket(LOBBY_WS_URL); } catch (e) {
    console.error("[lobby] WS ctor failed:", e);
    scheduleReconnect(gen);
    return;
  }
  socket.binaryType = "arraybuffer";   // ⚠️ zbin = binary frames
  ws = socket;

  const connectTimer = setTimeout(() => {
    if (gen !== wsGen || socket.readyState === WebSocket.OPEN) return;
    try { socket.close(); } catch {}
  }, 12000);

  socket.onopen = () => {
    if (gen !== wsGen) return;
    clearTimeout(connectTimer);
    retries = 0;
    setStatus("connected", "En direct");
    console.log("[lobby] ✅ WS open");
  };

  socket.onmessage = (e) => {
    if (gen !== wsGen) return;
    handleIncomingFrame(e.data);
  };

  socket.onclose = () => {
    if (gen !== wsGen) return;
    clearTimeout(connectTimer);
    scheduleReconnect(gen);
  };
  socket.onerror = () => {
    if (gen !== wsGen) return;
    try { socket.close(); } catch {}
  };
}

function closeSocket() {
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  try { ws.close(); } catch {}
  ws = null;
}

function scheduleReconnect(gen) {
  if (gen !== wsGen) return;
  retries++;

  // ⚠️ Après 5 tentatives, on abandonne le WS et on bascule en mode dégradé
  //    (les sections ranked + historique + heatmap continuent via lobby_state.json)
  if (retries > 5) {
    setStatus("error", "WS bloqué — mode dégradé");
    console.warn("[lobby] ⚠️ WS abandonné après 5 échecs (probable bloquage Cloudflare cross-origin)");
    console.warn("[lobby] ✅ Mode dégradé actif : ranked + historique + heatmap via lobby_state.json");
    wsDown = true;  // flag global pour afficher message dans les carrousels
    scheduleRender();
    return;
  }

  setStatus("reconnecting", `Reconnexion… (${retries}/5)`);
  const delay = Math.min(1000 * Math.pow(2, retries - 1), 15000);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (gen === wsGen) connect(); }, delay);
}

// ── Décode le frame entrant (binaire zbin OU fallback JSON texte) ──

function handleIncomingFrame(data) {
  try {
    let msg;
    if (typeof data === "string") {
      // Fallback JSON (rare)
      msg = JSON.parse(data);
    } else if (data instanceof ArrayBuffer) {
      // zbin binaire — décodé via lobby-wire.js
      if (!window.OpenFrontWire || !window.OpenFrontWire.decodeLobbyMessage) {
        console.error("[lobby] OpenFrontWire decoder not loaded");
        return;
      }
      const bytes = new Uint8Array(data);
      msg = window.OpenFrontWire.decodeLobbyMessage(bytes);
    } else if (data instanceof Blob) {
      // Rare, mais on gère
      data.arrayBuffer().then(buf => handleIncomingFrame(buf));
      return;
    } else {
      return;
    }
    applyServerMessage(msg);
  } catch (err) {
    console.error("[lobby] decode error:", err);
  }
}

function applyServerMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  let serverTime = Date.now();
  if (typeof msg.serverTime === "number") serverTime = msg.serverTime;

  // ── counts delta (juste les numClients) ──
  if (msg.type === "counts" && msg.counts) {
    if (!snapshot || !snapshot.games) return;
    for (const cat of Object.keys(snapshot.games)) {
      for (const game of snapshot.games[cat]) {
        if (game.id && Object.prototype.hasOwnProperty.call(msg.counts, game.id))
          game.players = Number(msg.counts[game.id]) || 0;
      }
    }
    snapshot.serverTime = serverTime;
    scheduleRender();
    return;
  }

  // ── full snapshot (configs + counts) ──
  if (msg.games && typeof msg.games === "object") {
    const normalized = { ffa: [], team: [], special: [] };
    for (const cat of Object.keys(normalized)) {
      const list = msg.games[cat];
      if (Array.isArray(list))
        normalized[cat] = list.filter(g => g && (g.gameID || g.id)).map(normalizeGame);
    }

    // Détecter games qui viennent de quitter (terminées) → historique
    const currentIds = new Set();
    for (const cat of Object.keys(normalized))
      for (const g of normalized[cat]) currentIds.add(g.id);

    if (prevGameIds.size > 0) {
      for (const id of prevGameIds) {
        if (!currentIds.has(id) && snapshot && snapshot.games) {
          for (const cat of Object.keys(snapshot.games)) {
            const oldGame = snapshot.games[cat].find(g => g.id === id);
            if (oldGame) {
              const cap = oldGame.capacity || 0;
              const pls = oldGame.players || 0;
              if (cap > 0 && pls > 0 && (cap - pls) <= 3) oldGame.players = cap;
              recentHistory.unshift({ ...oldGame, endedAt: serverTime });
              break;
            }
          }
        }
      }
    }
    if (recentHistory.length > 25) recentHistory = recentHistory.slice(0, 25);
    prevGameIds = currentIds;

    snapshot = { serverTime, games: normalized };
    scheduleRender();
    return;
  }
}

// ═══════════════════════════════════════════════════════════
//  STATUS
// ═══════════════════════════════════════════════════════════

function setStatus(state, label) {
  wsStatus = state;
  const dot = document.getElementById("lobby-status-dot");
  const txt = document.getElementById("lobby-status-text");
  if (dot) {
    dot.className = "lobby-status-dot is-" + state;
  }
  if (txt) txt.textContent = label;
}

// ═══════════════════════════════════════════════════════════
//  SHARED STATE (lobby_state.json — ranked + history + heatmap)
// ═══════════════════════════════════════════════════════════

async function fetchSharedState() {
  try {
    const res = await fetch("lobby_state.json?v=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    sharedState = data;
    return data;
  } catch (e) {
    console.warn("[lobby] lobby_state.json fetch failed:", e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  FILTRES — applique les filtres à un jeu
// ═══════════════════════════════════════════════════════════

function passesFilters(game) {
  // Catégorie
  if (!FILTERS.cats.has(game.cat)) return false;

  // Recherche texte
  if (FILTERS.q) {
    const q = FILTERS.q.toLowerCase();
    const hay = `${game.map} ${modeLabel(game)} ${game.id} ${game.badges.join(" ")}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }

  // Mods requis (tous)
  const gameMods = modsOf(game.gameConfig);
  for (const required of FILTERS.mods) {
    if (!gameMods.has(required)) return false;
  }
  // Mods exclus (aucun)
  for (const excluded of FILTERS.modsExclude) {
    if (gameMods.has(excluded)) return false;
  }

  // Players count
  if (FILTERS.minPlayers > 0 && game.players < FILTERS.minPlayers) return false;
  if (FILTERS.maxPlayers > 0 && game.players > FILTERS.maxPlayers) return false;
  if (FILTERS.minCapacity > 0 && game.capacity < FILTERS.minCapacity) return false;
  if (FILTERS.maxCapacity > 0 && game.capacity > FILTERS.maxCapacity) return false;

  // Toggles
  if (FILTERS.hideFull && game.capacity > 0 && game.players >= game.capacity) return false;
  if (FILTERS.hideEmpty && game.players === 0) return false;

  return true;
}

function sortGames(games) {
  const arr = [...games];
  switch (FILTERS.sortBy) {
    case "players":  arr.sort((a, b) => b.players - a.players); break;
    case "capacity": arr.sort((a, b) => b.capacity - a.capacity); break;
    case "name":     arr.sort((a, b) => a.map.localeCompare(b.map)); break;
    case "startsAt":
    default:
      arr.sort((a, b) => {
        const sa = a.startsAt || Infinity;
        const sb = b.startsAt || Infinity;
        return sa - sb;
      });
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════
//  RENDER — layout + carrousels auto-scroll
// ═══════════════════════════════════════════════════════════

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
}

function render() {
  if (!LOBBY_VIEW) return;

  // ── Layout skeleton (une seule fois) ──
  if (!document.getElementById("lobby-header-info")) {
    LOBBY_VIEW.innerHTML = `
      <div class="lobby-header-info">
        <div class="lobby-stats-bar">
          <div class="lobby-stat-item">
            <span class="lobby-stat-num" id="lobby-stat-players">—</span>
            <span class="lobby-stat-label">joueurs en lobby</span>
          </div>
          <div class="lobby-stat-item">
            <span class="lobby-stat-num" id="lobby-stat-games">—</span>
            <span class="lobby-stat-label">parties en lobby</span>
          </div>
        </div>
        <div class="lobby-status" id="lobby-status-indicator">
          <span class="lobby-status-dot is-connecting" id="lobby-status-dot"></span>
          <span id="lobby-status-text">Connexion…</span>
          <button id="lobby-filters-toggle" class="lobby-filters-toggle" aria-label="Filtres">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>
            <span>Filtres</span>
          </button>
        </div>
      </div>

      <div id="lobby-filters-panel" class="lobby-filters-panel" hidden>
        <div class="lobby-filters-row">
          <input type="search" id="lobby-filter-q" placeholder="Rechercher (map, mode, ID…)" autocomplete="off">
        </div>
        <div class="lobby-filters-row">
          <label class="lobby-filter-check"><input type="checkbox" data-cat="ffa" checked> FFA</label>
          <label class="lobby-filter-check"><input type="checkbox" data-cat="team" checked> Team</label>
          <label class="lobby-filter-check"><input type="checkbox" data-cat="special" checked> Special</label>
        </div>
        <div class="lobby-filters-row">
          <label class="lobby-filter-num">
            Joueurs min
            <input type="number" id="lobby-filter-min-players" min="0" max="500" value="0">
          </label>
          <label class="lobby-filter-num">
            Joueurs max
            <input type="number" id="lobby-filter-max-players" min="0" max="500" value="0">
          </label>
          <label class="lobby-filter-num">
            Places min
            <input type="number" id="lobby-filter-min-capacity" min="0" max="500" value="0">
          </label>
          <label class="lobby-filter-num">
            Places max
            <input type="number" id="lobby-filter-max-capacity" min="0" max="500" value="0">
          </label>
        </div>
        <div class="lobby-filters-row">
          <label class="lobby-filter-select">
            Trier par
            <select id="lobby-filter-sort">
              <option value="startsAt">Départ (le plus tôt)</option>
              <option value="players">Joueurs (le plus)</option>
              <option value="capacity">Capacité (le plus)</option>
              <option value="name">Map (A→Z)</option>
            </select>
          </label>
          <label class="lobby-filter-check"><input type="checkbox" id="lobby-filter-hide-full"> Cacher pleines</label>
          <label class="lobby-filter-check"><input type="checkbox" id="lobby-filter-hide-empty"> Cacher vides</label>
          <button id="lobby-filter-reset" class="lobby-filter-reset">Réinitialiser</button>
        </div>
        <div class="lobby-filters-row lobby-filters-mods" id="lobby-filter-mods">
          <!-- Mods buttons injected dynamically -->
        </div>
      </div>

      <div id="lobby-next-game-wrap"></div>

      <div id="lobby-carousels" class="lobby-carousels"></div>

      <div class="lobby-ranked-section" id="lobby-ranked-section"></div>

      <div id="lobby-container"></div>
    `;
    bindFilters();
  }

  // ── Stats ──
  // Récupère les games depuis snapshot (WS) OU sharedState (HTTP polling fallback)
  let allRawGames = [];
  if (snapshot?.games) {
    allRawGames = [...snapshot.games.ffa, ...snapshot.games.team, ...snapshot.games.special];
  } else if (sharedState?.games) {
    allRawGames = [...(sharedState.games.ffa || []), ...(sharedState.games.team || []), ...(sharedState.games.special || [])];
  }
  const allGames = allRawGames.map(normalizeGame);
  const filtered = allGames.filter(passesFilters);
  const totalGames = filtered.length;
  const totalPlayers = filtered.reduce((s, g) => s + (g.players || 0), 0);

  const playersEl = document.getElementById("lobby-stat-players");
  const gamesEl = document.getElementById("lobby-stat-games");
  if (playersEl) playersEl.textContent = totalPlayers;
  if (gamesEl) gamesEl.textContent = totalGames;

  // ── Next game highlight ──
  renderNextGame(allGames);

  // ── 3 carrousels ──
  renderCarousels();

  // ── Ranked queue ──
  renderRankedSection();

  // ── History ──
  renderHistory();
}

// ── Render: 3 carrousels horizontaux auto-scroll ──

const COLUMNS = [
  { key: "ffa",     label: "Free For All", color: "var(--orange)" },
  { key: "team",    label: "Teams",         color: "#06b6d4"      },
  { key: "special", label: "Special",       color: "#a855f7"      },
];

function renderCarousels() {
  const wrap = document.getElementById("lobby-carousels");
  if (!wrap) return;

  // Créer les 3 colonnes la 1re fois
  if (!wrap.children.length) {
    for (const col of COLUMNS) {
      const section = document.createElement("section");
      section.className = `lobby-carousel lobby-carousel-${col.key}`;
      section.dataset.cat = col.key;
      section.innerHTML = `
        <div class="lobby-carousel-header">
          <span class="lobby-carousel-title" style="--col-color:${col.color}">${col.label}</span>
          <span class="lobby-carousel-count">0</span>
        </div>
        <div class="lobby-carousel-viewport">
          <div class="lobby-carousel-track"></div>
        </div>
      `;
      wrap.appendChild(section);
    }
  }

  // 🎯 Source des données :
  //   - Si WS connecté (snapshot.games) → données temps réel via WS
  //   - Sinon (wsDown = true) → fallback sur sharedState.games (HTTP polling)
  let dataSource = null;
  let dataServerTime = Date.now();

  if (snapshot?.games) {
    // WS alive → données temps réel
    dataSource = snapshot.games;
    dataServerTime = snapshot.serverTime || Date.now();
  } else if (sharedState?.games) {
    // Mode dégradé → données via lobby_state.json (polling 15s)
    dataSource = sharedState.games;
    dataServerTime = sharedState.serverTime || Date.now();
  }

  if (!dataSource) {
    // Ni WS ni sharedState → on ne peut rien afficher
    return;
  }

  for (const col of COLUMNS) {
    const section = wrap.querySelector(`[data-cat="${col.key}"]`);
    if (!section) continue;

    // Récupère les games de cette catégorie
    let rawGames = dataSource[col.key] || [];
    // Normalise les games (au cas où elles viendraient de sharedState avec un format légèrement différent)
    const allGames = rawGames.map(normalizeGame);
    const filtered = sortGames(allGames.filter(passesFilters));

    // Compteur
    const countEl = section.querySelector(".lobby-carousel-count");
    if (countEl) countEl.textContent = filtered.length;

    const track = section.querySelector(".lobby-carousel-track");
    if (!track) continue;

    // Si pas de parties → message vide
    if (!filtered.length) {
      const emptyMsg = (wsDown && !sharedState?.games)
        ? `📡 WebSocket bloqué — parties temps réel indisponibles. Les sections ranked + historique restent actives.`
        : `Aucune partie ${col.label.toLowerCase()} pour le moment…`;
      track.innerHTML = `<div class="lobby-carousel-empty">${emptyMsg}</div>`;
      track.classList.remove("is-scrolling");
      continue;
    }

    // Rendu des cartes.
    // On rend N cartes (max 20) + on les duplique pour le scroll seamless
    // (carrousel infini) — voir lobby.css .lobby-carousel-track.
    const cards = filtered.slice(0, 20);
    const html = cards.map(g => cardHtml(g, dataServerTime)).join("");

    // Si on a au moins 2 cartes, on duplique pour faire défiler en boucle
    if (cards.length >= 2) {
      track.innerHTML = html + html;
      track.classList.add("is-scrolling");
      // Vitesse d'animation proportionnelle au nombre de cartes (plus il y en a, plus c'est long)
      const duration = Math.max(40, cards.length * 8);
      track.style.animationDuration = `${duration}s`;
    } else {
      // 1 seule carte : pas de scroll, on la centre
      track.innerHTML = html;
      track.classList.remove("is-scrolling");
    }
  }
}

// ── Card HTML — gros thumbnail + badges + countdown + players + join ──

function cardHtml(g, serverTime) {
  const thumbUrl = getMapThumbnailUrl(g.map);
  const startsIn = formatStartsAt(g.startsAt, serverTime);
  const startsClass = !g.startsAt ? "is-open"
    : (g.startsAt <= (serverTime || Date.now()) ? "is-running" : "is-soon");
  const fullClass = g.capacity > 0 && g.players >= g.capacity ? "is-full" : "";
  const gameUrl = `https://openfront.io/game/${encodeURIComponent(g.id)}`;
  const mode = modeLabel(g);

  const badgesHtml = g.badges.length
    ? `<div class="lobby-card-badges">${g.badges.slice(0, 4).map(b => `<span class="lobby-card-badge">${escapeHtml(b)}</span>`).join("")}</div>`
    : "";

  return `
    <a class="lobby-card ${fullClass}" href="${escapeHtml(gameUrl)}" target="_blank" rel="noopener" data-game-id="${escapeHtml(g.id)}">
      <div class="lobby-card-thumb">
        ${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(g.map)}" loading="lazy" decoding="async" onerror="this.style.display='none';this.parentElement.classList.add('is-missing')">` : `<div class="lobby-card-thumb-fallback">🗺️</div>`}
        ${badgesHtml}
        <div class="lobby-card-time lobby-card-time-${startsClass}">${escapeHtml(startsIn)}</div>
        <div class="lobby-card-players"><span>${g.players}</span>/<span>${g.capacity || "?"}</span></div>
      </div>
      <div class="lobby-card-info">
        <div class="lobby-card-name">${escapeHtml(g.map)}</div>
        <div class="lobby-card-mode">${escapeHtml(mode)}</div>
      </div>
    </a>
  `.trim();
}

// ── Next game highlight ──

function renderNextGame(allGames) {
  const wrap = document.getElementById("lobby-next-game-wrap");
  if (!wrap) return;

  if (!allGames.length) {
    wrap.innerHTML = '<div class="lobby-next-empty">En attente des parties OpenFront…</div>';
    return;
  }

  const now = snapshot?.serverTime || sharedState?.serverTime || Date.now();
  const upcoming = allGames.filter(g => g.startsAt && g.startsAt > now).sort((a, b) => a.startsAt - b.startsAt);
  const next = upcoming[0];

  if (!next) {
    wrap.innerHTML = '<div class="lobby-next-empty">Aucune partie programmée pour l\'instant</div>';
    return;
  }

  const thumbUrl = getMapThumbnailUrl(next.map);
  const startsIn = formatStartsAt(next.startsAt, now);
  const gameUrl = `https://openfront.io/game/${encodeURIComponent(next.id)}`;

  wrap.innerHTML = `
    <div class="lobby-next">
      <div class="lobby-next-thumb">${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(next.map)}">` : "🎮"}</div>
      <div class="lobby-next-info">
        <div class="lobby-next-tag">▶ Prochaine partie</div>
        <div class="lobby-next-name">${escapeHtml(next.map)}</div>
        <div class="lobby-next-meta">${escapeHtml(modeLabel(next))} · ${next.players}/${next.capacity || "?"} joueurs</div>
      </div>
      <div class="lobby-next-countdown">
        <div class="lobby-next-countdown-label">Démarre dans</div>
        <div class="lobby-next-countdown-val">${escapeHtml(startsIn)}</div>
        <a class="lobby-next-join" href="${escapeHtml(gameUrl)}" target="_blank" rel="noopener">Rejoindre →</a>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════
//  RANKED SECTION (depuis lobby_state.json)
// ═══════════════════════════════════════════════════════════

function renderRankedSection() {
  const section = document.getElementById("lobby-ranked-section");
  if (!section) return;

  const r1v1 = sharedState?.ranked?.["1v1"];
  const r2v2 = sharedState?.ranked?.["2v2"];

  if (!r1v1 && !r2v2) {
    section.innerHTML = `<div class="lobby-ranked-card"><div class="lobby-ranked-header"><h3>⚔️ Queue classée</h3><span class="lobby-ranked-sub">Activité sur la dernière heure</span></div><div class="lobby-ranked-body"><div class="lobby-ranked-loading">Chargement…</div></div></div>`;
    return;
  }

  const fmtWait = (s) => s != null ? (s < 60 ? `${s}s` : `${Math.round(s/60)}min`) : "—";
  const fill1v1 = fmtWait(r1v1?.avgWaitTime);
  const fill2v2 = fmtWait(r2v2?.avgWaitTime);
  const games1v1 = r1v1?.gamesLastHour ?? 0;
  const games2v2 = r2v2?.gamesLastHour ?? 0;
  const players1v1 = r1v1?.playersLastHour ?? (games1v1 * 2);
  const players2v2 = r2v2?.playersLastHour ?? (games2v2 * 4);

  const q1v1Display = queueSize1v1 !== null ? queueSize1v1 : "—";
  const q2v2Display = queueSize2v2 !== null ? queueSize2v2 : "—";
  const q1v1Live = queueSize1v1 !== null;
  const q2v2Live = queueSize2v2 !== null;

  section.innerHTML = `
    <div class="lobby-ranked-card">
      <div class="lobby-ranked-header">
        <h3>⚔️ Queue classée</h3>
        <span class="lobby-ranked-sub">Temps réel + activité dernière heure</span>
      </div>
      <div class="lobby-ranked-body">
        <div class="lobby-ranked-modes">
          <div class="lobby-ranked-mode">
            <div class="lobby-ranked-mode-label">1v1 Classé</div>
            <div class="lobby-ranked-mode-stats">
              <div class="lobby-ranked-stat lobby-ranked-stat-live"><span class="lobby-ranked-stat-num ${q1v1Live ? 'is-live' : ''}" id="queue-1v1-num">${q1v1Display}</span><span class="lobby-ranked-stat-label">en queue</span></div>
              <div class="lobby-ranked-stat"><span class="lobby-ranked-stat-num">${games1v1}</span><span class="lobby-ranked-stat-label">parties (1h)</span></div>
              <div class="lobby-ranked-stat"><span class="lobby-ranked-stat-num">${players1v1}</span><span class="lobby-ranked-stat-label">joueurs (1h)</span></div>
              <div class="lobby-ranked-stat"><span class="lobby-ranked-stat-num">${fill1v1}</span><span class="lobby-ranked-stat-label">attente moy.</span></div>
            </div>
            <a class="lobby-ranked-cta" href="https://openfront.io/#modal=ranked" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18l3-2 3 2V3z"/><path d="M9 7h6"/></svg>Lancer 1v1</a>
          </div>
          <div class="lobby-ranked-mode">
            <div class="lobby-ranked-mode-label">2v2 Classé</div>
            <div class="lobby-ranked-mode-stats">
              <div class="lobby-ranked-stat lobby-ranked-stat-live"><span class="lobby-ranked-stat-num ${q2v2Live ? 'is-live' : ''}" id="queue-2v2-num">${q2v2Display}</span><span class="lobby-ranked-stat-label">en queue</span></div>
              <div class="lobby-ranked-stat"><span class="lobby-ranked-stat-num">${games2v2}</span><span class="lobby-ranked-stat-label">parties (1h)</span></div>
              <div class="lobby-ranked-stat"><span class="lobby-ranked-stat-num">${players2v2}</span><span class="lobby-ranked-stat-label">joueurs (1h)</span></div>
              <div class="lobby-ranked-stat"><span class="lobby-ranked-stat-num">${fill2v2}</span><span class="lobby-ranked-stat-label">attente moy.</span></div>
            </div>
            <a class="lobby-ranked-cta" href="https://openfront.io/#modal=ranked" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18l3-2 3 2V3z"/><path d="M9 7h6"/></svg>Lancer 2v2</a>
          </div>
        </div>
        <p class="lobby-ranked-note">Queue en temps réel via WebSocket · Stats 1h via API OpenFront.</p>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════
//  HISTORY + HEATMAP 24h
// ═══════════════════════════════════════════════════════════

function renderHistory() {
  const container = document.getElementById("lobby-container");
  if (!container) return;

  let historyEl = document.getElementById("lobby-history");
  if (!historyEl) {
    historyEl = document.createElement("section");
    historyEl.id = "lobby-history";
    historyEl.className = "lobby-history";
    container.appendChild(historyEl);
  }

  const history = sharedState?.recentHistory || recentHistory || [];
  const heatmap24h = sharedState?.heatmap24h || new Array(24).fill(0);
  const lastUpdate = sharedState?.lastUpdate;

  const maxHeat = Math.max(...heatmap24h, 1);
  const heatBars = heatmap24h.map((count, hour) => {
    const h = (count / maxHeat) * 100;
    const label = hour % 3 === 0 ? `${hour}h` : "";
    return `<div class="lobby-heat-col" title="${hour}h — ${count} partie(s)"><div class="lobby-heat-col-track"><div class="lobby-heat-col-fill" style="height:${h.toFixed(0)}%"></div></div><span class="lobby-heat-col-label">${label}</span></div>`;
  }).join("");

  if (!history.length) {
    historyEl.innerHTML = `<div class="lobby-history-header"><h2 class="lobby-history-title">Historique & Insights</h2><span class="lobby-history-sub">En attente de données…</span></div><div class="lobby-history-extras"><div class="lobby-history-extra-card"><h4>Activité 24h</h4><div class="lobby-heatmap">${heatBars}</div><p class="lobby-heatmap-sub">Parties terminées par heure</p></div></div><div class="lobby-history-list"><div class="lobby-history-empty"><p>Chargement de l'historique…</p><p class="lobby-history-note">Les parties terminées apparaîtront ici (données partagées entre tous les visiteurs).</p></div></div>`;
    return;
  }

  const items = history.map(g => {
    const thumbUrl = getMapThumbnailUrl(g.map);
    const mode = g.mode || g.rankedType || "FFA";
    const date = formatDate(g.endedAt);
    const gameUrl = `https://openfront.io/game/${encodeURIComponent(g.id)}`;
    const diff = g.difficulty ? g.difficulty.charAt(0).toUpperCase() + g.difficulty.slice(1) : "";
    return `<a class="lobby-history-item" href="${escapeHtml(gameUrl)}" target="_blank" rel="noopener"><div class="lobby-history-thumb">${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(g.map)}" loading="lazy" onerror="this.style.display='none'">` : ""}</div><div class="lobby-history-info"><div class="lobby-history-map">${escapeHtml(g.map)}</div><div class="lobby-history-meta">${escapeHtml(mode)}${diff ? " · " + escapeHtml(diff) : ""} · ${g.players}/${g.maxPlayers || g.capacity || "?"} joueurs</div></div><span class="lobby-history-date">${escapeHtml(date)}</span></a>`;
  }).join("");

  const updateStr = lastUpdate ? new Date(lastUpdate).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";
  historyEl.innerHTML = `<div class="lobby-history-header"><h2 class="lobby-history-title">Historique & Insights</h2><span class="lobby-history-sub">${history.length} parties · MAJ ${updateStr}</span></div><div class="lobby-history-extras"><div class="lobby-history-extra-card"><h4>Activité 24h</h4><div class="lobby-heatmap">${heatBars}</div><p class="lobby-heatmap-sub">Parties terminées par heure</p></div></div><div class="lobby-history-list">${items}</div>`;
}

// ═══════════════════════════════════════════════════════════
//  FILTERS PANEL — binding
// ═══════════════════════════════════════════════════════════

function bindFilters() {
  // Toggle panel
  const toggle = document.getElementById("lobby-filters-toggle");
  const panel = document.getElementById("lobby-filters-panel");
  if (toggle && panel) {
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.classList.toggle("is-open", !panel.hidden);
    });
  }

  // Search input
  const q = document.getElementById("lobby-filter-q");
  if (q) q.addEventListener("input", () => { FILTERS.q = q.value.trim(); scheduleRender(); });

  // Category toggles
  document.querySelectorAll('[data-cat]').forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) FILTERS.cats.add(cb.dataset.cat);
      else FILTERS.cats.delete(cb.dataset.cat);
      scheduleRender();
    });
  });

  // Numeric filters
  const minP = document.getElementById("lobby-filter-min-players");
  if (minP) minP.addEventListener("input", () => { FILTERS.minPlayers = +minP.value || 0; scheduleRender(); });
  const maxP = document.getElementById("lobby-filter-max-players");
  if (maxP) maxP.addEventListener("input", () => { FILTERS.maxPlayers = +maxP.value || 0; scheduleRender(); });
  const minC = document.getElementById("lobby-filter-min-capacity");
  if (minC) minC.addEventListener("input", () => { FILTERS.minCapacity = +minC.value || 0; scheduleRender(); });
  const maxC = document.getElementById("lobby-filter-max-capacity");
  if (maxC) maxC.addEventListener("input", () => { FILTERS.maxCapacity = +maxC.value || 0; scheduleRender(); });

  // Sort
  const sort = document.getElementById("lobby-filter-sort");
  if (sort) sort.addEventListener("change", () => { FILTERS.sortBy = sort.value; scheduleRender(); });

  // Toggles
  const hideFull = document.getElementById("lobby-filter-hide-full");
  if (hideFull) hideFull.addEventListener("change", () => { FILTERS.hideFull = hideFull.checked; scheduleRender(); });
  const hideEmpty = document.getElementById("lobby-filter-hide-empty");
  if (hideEmpty) hideEmpty.addEventListener("change", () => { FILTERS.hideEmpty = hideEmpty.checked; scheduleRender(); });

  // Reset
  const reset = document.getElementById("lobby-filter-reset");
  if (reset) reset.addEventListener("click", () => {
    FILTERS.q = "";
    FILTERS.cats = new Set(["ffa", "team", "special"]);
    FILTERS.mods = new Set();
    FILTERS.modsExclude = new Set();
    FILTERS.minPlayers = 0;
    FILTERS.maxPlayers = 0;
    FILTERS.minCapacity = 0;
    FILTERS.maxCapacity = 0;
    FILTERS.sortBy = "startsAt";
    FILTERS.hideFull = false;
    FILTERS.hideEmpty = false;
    if (q) q.value = "";
    document.querySelectorAll('[data-cat]').forEach(cb => { cb.checked = FILTERS.cats.has(cb.dataset.cat); });
    if (minP) minP.value = 0;
    if (maxP) maxP.value = 0;
    if (minC) minC.value = 0;
    if (maxC) maxC.value = 0;
    if (sort) sort.value = "startsAt";
    if (hideFull) hideFull.checked = false;
    if (hideEmpty) hideEmpty.checked = false;
    buildModsButtons();
    scheduleRender();
  });

  buildModsButtons();
}

function buildModsButtons() {
  const wrap = document.getElementById("lobby-filter-mods");
  if (!wrap) return;

  // Construire la liste de tous les mods possibles
  // (depuis le snapshot courant, sinon depuis MOD_LABEL)
  const allMods = new Set(MOD_LABEL.keys());
  if (snapshot?.games) {
    for (const cat of Object.keys(snapshot.games)) {
      for (const g of snapshot.games[cat]) {
        for (const m of modsOf(g.gameConfig)) allMods.add(m);
      }
    }
  }

  const buttons = [...allMods].sort().map(mod => {
    const label = MOD_LABEL.get(mod) || humanize(mod);
    const state = FILTERS.mods.has(mod) ? "is-required"
      : FILTERS.modsExclude.has(mod) ? "is-excluded"
      : "";
    return `<button type="button" class="lobby-mod-btn ${state}" data-mod="${escapeHtml(mod)}">${escapeHtml(label)}</button>`;
  }).join("");

  wrap.innerHTML = `<span class="lobby-filters-mods-label">Modificateurs</span><div class="lobby-filters-mods-list">${buttons}</div><span class="lobby-filters-mods-hint">Clic = requis · Clic droit = exclu · Double-clic = reset</span>`;

  wrap.querySelectorAll(".lobby-mod-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const mod = btn.dataset.mod;
      if (FILTERS.mods.has(mod)) {
        FILTERS.mods.delete(mod);
        FILTERS.modsExclude.add(mod);
      } else if (FILTERS.modsExclude.has(mod)) {
        FILTERS.modsExclude.delete(mod);
      } else {
        FILTERS.mods.add(mod);
      }
      buildModsButtons();
      scheduleRender();
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const mod = btn.dataset.mod;
      if (FILTERS.modsExclude.has(mod)) {
        FILTERS.modsExclude.delete(mod);
      } else {
        FILTERS.mods.delete(mod);
        FILTERS.modsExclude.add(mod);
      }
      buildModsButtons();
      scheduleRender();
    });
    btn.addEventListener("dblclick", (e) => {
      e.preventDefault();
      const mod = btn.dataset.mod;
      FILTERS.mods.delete(mod);
      FILTERS.modsExclude.delete(mod);
      buildModsButtons();
      scheduleRender();
    });
  });
}

// ═══════════════════════════════════════════════════════════
//  MATCHMAKING WS — queue size temps réel
// ═══════════════════════════════════════════════════════════

function connectMatchmaking() {
  connectMM('1v1');
  connectMM('2v2');
}

function connectMM(mode) {
  try {
    const wsMM = new WebSocket(MM_WS_URL(mode));
    wsMM.onmessage = (e) => {
      try {
        let data;
        if (typeof e.data === "string") data = JSON.parse(e.data);
        else if (e.data instanceof ArrayBuffer) data = JSON.parse(new TextDecoder().decode(e.data));
        else return;
        if (data.type === 'queue-size' && typeof data.count === 'number') {
          if (mode === '1v1') queueSize1v1 = data.count;
          else queueSize2v2 = data.count;
          const el = document.getElementById(`queue-${mode}-num`);
          if (el) {
            el.textContent = data.count;
            el.classList.add('is-live');
          }
        }
      } catch {}
    };
    wsMM.onerror = () => {};
    wsMM.onclose = () => {
      setTimeout(() => { try { connectMM(mode); } catch {} }, 60000);
    };
  } catch {}
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

connect();
connectMatchmaking();

// Render initial (vide, en attente)
render();

// Fetch shared state immediately, then every 15s (polling quasi-temps réel)
// ⚠️ En mode dégradé (WS down), c'est la SEULE source de données pour les carrousels.
//    15s = bon compromis entre fraîcheur et charge serveur.
fetchSharedState().then(() => {
  scheduleRender();
});
setInterval(() => {
  fetchSharedState().then(() => scheduleRender());
}, 15000);

// Re-render toutes les 10s pour rafraîchir les countdowns (sans re-fetch)
setInterval(() => { scheduleRender(); }, 10000);

// Re-build mods buttons quand snapshot change (pour capter les nouveaux mods)
let lastModSetSize = 0;
setInterval(() => {
  if (!snapshot?.games) return;
  const allMods = new Set();
  for (const cat of Object.keys(snapshot.games))
    for (const g of snapshot.games[cat])
      for (const m of modsOf(g.gameConfig)) allMods.add(m);
  if (allMods.size !== lastModSetSize) {
    lastModSetSize = allMods.size;
    buildModsButtons();
  }
}, 5000);
