// lobby.js — Lobby Preview (parties OpenFront en temps réel)
// WebSocket wss://openfront.io/{w0-w4}/lobbies
// + Historique des 25 dernières parties via API HTTP

const LOBBY_VIEW = document.getElementById("lobby-view");

const WORKER_POOL = ["w0", "w1", "w2", "w3", "w4"];
const WS_URL = (w) => `wss://openfront.io/${w}/lobbies`;

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

let ws = null;
let wsGen = 0;
let reconnectTimer = null;
let retries = 0;
let snapshot = null;
let renderTimer = null;
let cardEls = new Map();
let historyLoaded = false;
let recentHistory = []; // games qui viennent de quitter le lobby (terminées)
let prevGameIds = new Set(); // IDs présents au snapshot précédent

/* ═══ Utilitaires ═══ */

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
  if (!startsAt) return "";
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

/* ═══ WebSocket ═══ */

function connect() {
  closeSocket();
  const gen = ++wsGen;
  const worker = WORKER_POOL[Math.floor(Math.random() * WORKER_POOL.length)];
  console.log(`[lobby] Connecting to ${WS_URL(worker)}…`);
  let socket;
  try { socket = new WebSocket(WS_URL(worker)); } catch { scheduleReconnect(gen); return; }
  ws = socket;
  const ct = setTimeout(() => { if (gen !== wsGen || socket.readyState === WebSocket.OPEN) return; try { socket.close(); } catch {} }, 12000);
  socket.onopen = () => { if (gen !== wsGen) return; clearTimeout(ct); retries = 0; console.log("[lobby] ✅ Connected"); };
  socket.onmessage = (e) => { if (gen !== wsGen) return; try { applyMessage(JSON.parse(e.data)); } catch {} };
  socket.onclose = () => { if (gen !== wsGen) return; clearTimeout(ct); scheduleReconnect(gen); };
  socket.onerror = () => { if (gen !== wsGen) return; try { socket.close(); } catch {} };
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
  const delay = Math.min(1000 * Math.pow(2, retries - 1), 15000);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (gen === wsGen) connect(); }, delay);
}

/* ═══ Traitement des messages ═══ */

function applyMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  let serverTime = Date.now();
  if (typeof msg.serverTime === "number") serverTime = msg.serverTime;

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

  if (msg.games && typeof msg.games === "object") {
    const normalized = { ffa: [], team: [], special: [] };
    for (const cat of Object.keys(normalized)) {
      const list = msg.games[cat];
      if (Array.isArray(list))
        normalized[cat] = list.filter(g => g && (g.gameID || g.id)).map(normalizeGame);
    }

    // Détecter les games qui ont quitté le lobby (terminées) → historique
    const currentIds = new Set();
    for (const cat of Object.keys(normalized)) {
      for (const g of normalized[cat]) currentIds.add(g.id);
    }
    if (prevGameIds.size > 0) {
      for (const id of prevGameIds) {
        if (!currentIds.has(id)) {
          // Cette game était dans le snapshot précédent, elle n'y est plus → terminée
          // On la cherche dans l'ancien snapshot pour récupérer ses infos
          if (snapshot && snapshot.games) {
            for (const cat of Object.keys(snapshot.games)) {
              const oldGame = snapshot.games[cat].find(g => g.id === id);
              if (oldGame) {
                recentHistory.unshift({ ...oldGame, endedAt: serverTime });
                break;
              }
            }
          }
        }
      }
    }
    // Garder max 25 entrées
    if (recentHistory.length > 25) recentHistory = recentHistory.slice(0, 25);
    prevGameIds = currentIds;

    snapshot = { serverTime, games: normalized };
    scheduleRender();
    return;
  }
}

/* ═══ Rendu ═══ */

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
}

function render() {
  if (!LOBBY_VIEW) return;
  if (!snapshot || !snapshot.games) {
    LOBBY_VIEW.innerHTML = `<div class="lobby-loading"><div class="spinner"></div><p>Connexion aux serveurs OpenFront…</p></div>`;
    return;
  }

  const { ffa, team, special } = snapshot.games;
  const totalGames = ffa.length + team.length + special.length;

  if (totalGames === 0) {
    LOBBY_VIEW.innerHTML = `<div class="lobby-empty"><div style="font-size:48px">🎮</div><h3>Aucune partie en cours</h3><p>Les parties OpenFront apparaîtront ici dès qu'elles seront créées.</p></div>`;
    return;
  }

  // Créer le conteneur s'il n'existe pas
  let container = document.getElementById("lobby-container");
  if (!container) {
    LOBBY_VIEW.innerHTML = `<div id="lobby-container"></div>`;
    container = document.getElementById("lobby-container");
  }

  // Colonnes
  const columns = [
    { key: "ffa", label: "FFA", games: ffa },
    { key: "team", label: "Team", games: team },
    { key: "special", label: "Special", games: special },
  ];

  let columnsWrap = document.getElementById("lobby-columns");
  if (!columnsWrap) {
    columnsWrap = document.createElement("div");
    columnsWrap.id = "lobby-columns";
    columnsWrap.className = "lobby-columns";
    container.appendChild(columnsWrap);
  }

  for (const col of columns) {
    let colEl = document.getElementById(`lobby-col-${col.key}`);
    if (!colEl) {
      colEl = document.createElement("section");
      colEl.id = `lobby-col-${col.key}`;
      colEl.className = `lobby-column lobby-column-${col.key}`;
      colEl.innerHTML = `
        <div class="lobby-column-header">
          <span class="lobby-column-title">${col.label}</span>
          <span class="lobby-column-count">0</span>
        </div>
        <div class="lobby-column-body"></div>
      `;
      columnsWrap.appendChild(colEl);
    }

    const countEl = colEl.querySelector(".lobby-column-count");
    if (countEl) countEl.textContent = col.games.length;

    const body = colEl.querySelector(".lobby-column-body");
    if (!body) continue;

    // Nettoyer les cards qui ne sont plus dans cette colonne
    // IMPORTANT: ne supprimer que les cards qui appartiennent à body (cette colonne)
    // pas les cards des autres colonnes
    const liveIds = new Set(col.games.map(g => g.id));
    const toRemove = [];
    for (const [id, node] of cardEls) {
      if (node.parentNode === body && !liveIds.has(id)) {
        node.remove();
        toRemove.push(id);
      }
    }
    for (const id of toRemove) cardEls.delete(id);

    // Créer ou updater les cards (pas de re-order)
    col.games.slice(0, 20).forEach((game) => {
      let card = cardEls.get(game.id);
      if (!card) {
        card = createCard(game);
        cardEls.set(game.id, card);
        body.appendChild(card);
      }
      updateCard(card, game);
    });
  }

  // Historique des 25 dernières parties (rendu à chaque update)
  renderHistory();
}

/* ═══ Rendu de l'historique (games terminées détectées en live) ═══ */

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

  if (recentHistory.length === 0) {
    historyEl.innerHTML = `
      <div class="lobby-history-header">
        <h2 class="lobby-history-title">Historique</h2>
        <span class="lobby-history-sub">Parties terminées récemment</span>
      </div>
      <div class="lobby-history-empty">
        <p>En attente de parties terminées…</p>
        <p class="lobby-history-note">Les parties apparaîtront ici dès qu'elles se terminent.</p>
      </div>
    `;
    return;
  }

  const items = recentHistory.map(g => {
    const thumbUrl = getMapThumbnailUrl(g.map);
    const mode = modeLabel(g);
    const date = formatDate(g.endedAt);
    const gameUrl = `https://openfront.io/game/${encodeURIComponent(g.id)}`;
    const diff = g.difficulty ? g.difficulty.charAt(0).toUpperCase() + g.difficulty.slice(1) : "";
    return `
      <a class="lobby-history-item" href="${escapeHtml(gameUrl)}" target="_blank" rel="noopener">
        <div class="lobby-history-thumb">
          ${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(g.map)}" loading="lazy" onerror="this.style.display='none'">` : ""}
        </div>
        <div class="lobby-history-info">
          <div class="lobby-history-map">${escapeHtml(g.map)}</div>
          <div class="lobby-history-meta">${escapeHtml(mode)}${diff ? " · " + escapeHtml(diff) : ""} · ${g.players}/${g.capacity || "?"} joueurs</div>
        </div>
        <span class="lobby-history-date">${escapeHtml(date)}</span>
      </a>
    `;
  }).join("");

  historyEl.innerHTML = `
    <div class="lobby-history-header">
      <h2 class="lobby-history-title">Historique</h2>
      <span class="lobby-history-sub">${recentHistory.length} partie${recentHistory.length > 1 ? "s" : ""} terminée${recentHistory.length > 1 ? "s" : ""}</span>
    </div>
    <div class="lobby-history-list">${items}</div>
  `;
}
function createCard(game) {
  const card = document.createElement("a");
  card.className = "lobby-game";
  card.target = "_blank";
  card.rel = "noopener";
  card.href = `https://openfront.io/game/${encodeURIComponent(game.id)}`;
  card.dataset.gameId = game.id;
  card.innerHTML = `
    <div class="lobby-game-thumb"></div>
    <div class="lobby-game-info">
      <div class="lobby-game-name"></div>
      <div class="lobby-game-mode"></div>
      <div class="lobby-game-meta">
        <span class="lobby-game-players"></span>
        <span class="lobby-game-starts"></span>
      </div>
      <div class="lobby-game-badges"></div>
    </div>
    <div class="lobby-game-join">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
    </div>
  `;
  return card;
}

function updateCard(card, game) {
  const thumb = card.querySelector(".lobby-game-thumb");
  const thumbUrl = getMapThumbnailUrl(game.map);
  if (thumbUrl && thumb.dataset.url !== thumbUrl) {
    thumb.dataset.url = thumbUrl;
    thumb.innerHTML = `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(game.map)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;lobby-game-thumb-fallback&quot;>🗺️</div>'">`;
  } else if (!thumbUrl && !thumb.dataset.empty) {
    thumb.dataset.empty = "1";
    thumb.innerHTML = `<div class="lobby-game-thumb-fallback">🗺️</div>`;
  }

  const nameEl = card.querySelector(".lobby-game-name");
  if (nameEl.textContent !== game.map) nameEl.textContent = game.map;

  const modeEl = card.querySelector(".lobby-game-mode");
  const modeText = modeLabel(game);
  if (modeEl.textContent !== modeText) modeEl.textContent = modeText;

  const playersEl = card.querySelector(".lobby-game-players");
  const playersText = `${game.players}/${game.capacity || "?"}`;
  if (playersEl.textContent !== playersText) {
    playersEl.textContent = playersText;
    playersEl.classList.toggle("full", game.capacity && game.players >= game.capacity);
  }

  const startsEl = card.querySelector(".lobby-game-starts");
  const startsText = formatStartsAt(game.startsAt, snapshot.serverTime);
  if (startsEl.textContent !== startsText) startsEl.textContent = startsText;

  const badgesEl = card.querySelector(".lobby-game-badges");
  const sig = game.badges.join("|");
  if (badgesEl.dataset.sig !== sig) {
    badgesEl.dataset.sig = sig;
    badgesEl.innerHTML = game.badges.length
      ? game.badges.map(b => `<span class="lobby-badge">${escapeHtml(b)}</span>`).join("")
      : "";
  }
}

/* ═══ Init ═══ */

connect();

setInterval(() => { if (snapshot && snapshot.games) scheduleRender(); }, 30000);
