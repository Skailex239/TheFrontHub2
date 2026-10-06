/**
 * Cloudflare Worker — Proxy CORS + WebSocket pour OpenFront.
 * v2 « fusion » (2026-10-03) : l'ancien proxy + les nouvelles routes.
 *
 * ROUTES :
 *   GET /lobby-ws         → proxy WebSocket vers wss://<hôte jeu>/w{0-19}/lobbies
 *                           (hôte résolu DYNAMIQUEMENT via cluster.json — voir FIX v2)
 *   GET /matchmaking-ws   → proxy WebSocket vers wss://api.openfront.io/matchmaking/join?...
 *   GET /lobbies          → NOUVEAU : lobbies publics en JSON (instantané décodé
 *                           côté serveur, flux zbin, cache 2,5 s + secours stale)
 *   GET /leaderboard      → NOUVEAU : classements 1v1 + 2v2 (cache 60 s)
 *   GET /cluster          → NOUVEAU : état des serveurs de jeu (cache 60 s)
 *   GET /cosmetics        → NOUVEAU : catalogue cosmétiques compacté (cache 6 h)
 *   GET /player/:id       → NOUVEAU : profil d'un joueur (cache 5 min)
 *   GET /player/:id/games → NOUVEAU : dernières parties d'un joueur (cache 5 min)
 *   GET /all              → NOUVEAU : leaderboard + cluster + cosmétiques en un appel
 *   GET /  ·  /health     → NOUVEAU : état du worker (JSON)
 *   GET /<path>           → proxy HTTP vers https://api.openfront.io/<path>
 *                           (inchangé — les appels existants du site continuent de marcher)
 *
 * ⚠️ FIX v2 (le bug du lobby vide) :
 *   L'ancienne version forçait FORCED_HOST = "green.openfront.io" avec la
 *   résolution dynamique désactivée (bascule du 2026-09-14 : green était
 *   « open », blue « draining »). Depuis, les serveurs ont basculé :
 *   blue est actif, green draine. Le site restait donc connecté à un serveur
 *   mort → « aucune partie en attente ». Désormais l'hôte est résolu à chaque
 *   connexion via cluster.json (serveurs « open » d'abord), avec repli
 *   blue → green → openfront.io legacy. Plus jamais de breaker manuel.
 *
 * ⚠️ SÉCURITÉ (audit 2026, conservée) : ce Worker peut injecter le header
 * x-skailex-access (accès API privilégié) sur les requêtes vers api.openfront.io.
 * Il n'est consommable QUE par les origines officielles (ALLOWED_ORIGINS),
 * plus les previews de l'agent (*.space-z.ai, pour le mode « worker URL »
 * du tableau de bord v6). Le header n'est envoyé que si le secret
 * SKAILEX_ACCESS_TOKEN est configuré.
 *
 * Configuration (Dashboard Cloudflare → Worker → Settings → Variables) :
 *   SKAILEX_ACCESS_TOKEN   — token d'accès (déjà en place, secret)
 *   ALLOWED_ORIGINS        — (optionnel) origines séparées par des virgules
 *   ALLOW_ALL_ORIGINS      — (optionnel, déconseillé) "1" pour tout ouvrir
 *
 * Le protocole des lobbies est un flux binaire « zbin » (dépôt officiel
 * OpenFrontIO). Les routes /lobby-ws (relais transparent, décodage côté
 * navigateur) et /lobbies (décodage côté serveur) partagent le même schéma.
 * Zéro dépendance externe.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 0. Configuration
// ─────────────────────────────────────────────────────────────────────────────

const SKAILEX_ACCESS_TOKEN = process.env.SKAILEX_ACCESS_TOKEN || "";
const API_BASE = "https://api.openfront.io";

// Ordre de repli si cluster.json est injoignable : blue puis green.
const FALLBACK_SERVERS = ["blue.openfront.io", "green.openfront.io"];
// Dernier recours absolu (pool legacy d'avant la v34).
const LEGACY_LOBBY_HOST = "openfront.io";

const CLUSTER_TTL_MS = 30000;   // cache de la liste des serveurs
const LOBBY_CACHE_MS = 2500;    // anti-hammer sur /lobbies
const API_TIMEOUT_MS = 12000;
const WS_TIMEOUT_MS = 6000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Allowlist d'origines (audit sécurité, conservée)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_ORIGINS = [
  "https://thefronthub.com",
  "https://www.thefronthub.com",
  "https://dev.thefronthub.com",   // pré-production
  "https://skailex239.github.io",   // miroir GitHub Pages
  "http://localhost:3000",         // dev local
  "http://localhost:5500",         // dev local (live server)
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5500",
];

// Suffixes autorisés ( previews de l'agent : https://preview-<id>.space-z.ai ).
const DEFAULT_ALLOWED_SUFFIXES = [".space-z.ai"];

const ALLOW_ALL_ORIGINS = process.env.ALLOW_ALL_ORIGINS === "1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (ALLOW_ALL_ORIGINS) return true;            // mode debug explicite
  if (!origin) return false;                     // curl / server-side → refusé
  const list = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : DEFAULT_ALLOWED_ORIGINS;
  if (list.indexOf(origin) !== -1) return true;
  for (let i = 0; i < DEFAULT_ALLOWED_SUFFIXES.length; i++) {
    if (origin.endsWith(DEFAULT_ALLOWED_SUFFIXES[i])) return true;
  }
  return false;
}

/** Réponse CORS dont l'origine est validée (jamais "*"). */
function corsHeadersFor(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

/** Réponse 403 générique (sans détails internes). */
function forbidden() {
  return new Response(JSON.stringify({ error: "Forbidden origin" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonResponse(body, status, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (origin) {
    var k;
    for (k in corsHeadersFor(origin)) headers[k] = corsHeadersFor(origin)[k];
  }
  return new Response(JSON.stringify(body), { status: status || 200, headers: headers });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Résolution des serveurs de jeu (cluster.json, cache 30 s)
// ─────────────────────────────────────────────────────────────────────────────

let clusterCache = { at: 0, servers: null };

async function apiHeaders() {
  const h = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": "skailex",
  };
  if (SKAILEX_ACCESS_TOKEN) h["x-skailex-access"] = SKAILEX_ACCESS_TOKEN;
  return h;
}

async function apiJson(path) {
  const res = await fetch(API_BASE + path, {
    headers: await apiHeaders(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error("api.openfront.io HTTP " + res.status + " sur " + path);
  return await res.json();
}

/**
 * Liste des serveurs de jeu, pré-triée : « open » d'abord (ordre alphabétique),
 * puis les autres (draining/fenced) en fin de liste. Si cluster.json échoue,
 * on retombe sur blue puis green. Chaque entrée : { host, numWorkers, version, state }.
 */
async function getClusterServers() {
  const now = Date.now();
  if (clusterCache.servers && now - clusterCache.at < CLUSTER_TTL_MS) {
    return clusterCache.servers;
  }
  let servers = null;
  try {
    const data = await apiJson("/cluster.json?site=" + encodeURIComponent("openfront.io"));
    const entries = [];
    const raw = (data && data.servers) || {};
    Object.keys(raw).forEach(function (name) {
      const s = raw[name] || {};
      const host = s.host || name;
      if (!host) return;
      entries.push({
        host: String(host),
        numWorkers: Number(s.numWorkers || 20),
        version: String(s.version || ""),
        state: String(s.state || "open"),
      });
    });
    const open = entries.filter(function (s) { return s.state === "open"; });
    const rest = entries.filter(function (s) { return s.state !== "open"; });
    open.sort(function (a, b) { return a.host < b.host ? -1 : 1; });
    rest.sort(function (a, b) { return a.host < b.host ? -1 : 1; });
    if (open.length) servers = open.concat(rest);
    else if (entries.length) servers = entries;
  } catch (e) {
    // cluster.json injoignable → repli
  }
  if (!servers) {
    servers = FALLBACK_SERVERS.map(function (host) {
      return { host: host, numWorkers: 20, version: "", state: "fallback" };
    });
  }
  clusterCache = { at: now, servers: servers };
  return servers;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Décodeur zbin compact (flux lobbies)
// ─────────────────────────────────────────────────────────────────────────────
//  Règles du format (dépôt officiel zbin/, tests golden) :
//   - objets : en-tête de bits (LSB d'abord) puis corps des champs DANS
//     L'ORDRE DE DÉCLARATION ; chaque champ prend : un bit de présence si
//     optionnel, un bit « null » si nullable, un bit de valeur si booléen.
//   - varint : LEB128 non signé ; float : 64 bits little-endian ;
//     chaîne : varint longueur + UTF-8 ; énum : varint ordinal ; union :
//     varint tag + variante ; tableau : varint nombre + éléments.

const UTF8 = new TextDecoder("utf-8", { fatal: true });

const ZBIN_ENUMS = {
  gameMap: [
    "Achiran", "Aegean", "Africa", "Alps", "Amazon River", "Antarctica",
    "ArchipelagoSea", "Arctic", "Asia", "Australia", "Bab el-Mandeb Strait", "Baikal",
    "Baikal Nuke Wars", "Baja California", "Balkans", "Balkhash", "Baltics", "Bering Sea",
    "Bering Strait", "Between Two Seas", "Black Sea", "Bosphorus Straits", "Branching Paths", "Britannia",
    "Britannia Classic", "Canary Islands", "Cape Cod", "Cape Of Good Hope", "Caribbean", "Caspian Sea",
    "Caucasus", "Central America", "Channel Islands", "China", "Chopping Block", "Clearwater Lakes",
    "Conakry", "Crimea", "Danish Straits", "Deglaciated Antarctica", "Didier", "Didier France",
    "Dyslexdria", "East Asia", "Europe", "Europe Classic", "Falkland Islands", "Faroe Islands",
    "Finger Lakes", "Four Islands", "France", "Gateway to the Atlantic", "Germany", "Giant World Map",
    "Great Lakes", "Gulf Of Guinea", "Gulf Of Mexico", "Gulf of St. Lawrence", "Halkidiki", "Hawaii",
    "Hecate Strait", "Hong Kong", "Horn Of Africa", "Iceland", "Indian Subcontinent", "Irish Sea",
    "Italia", "Japan", "Juan De Fuca Strait", "Korea", "Labyrinth", "Las Vegas Strip",
    "Lemnos", "Levant", "Lisbon", "Los Angeles", "Luna", "Madagascar",
    "Manicouagan", "Mare Nostrum", "Mars", "Mena", "Middle East", "MilkyWay",
    "Mississippi River", "Montreal", "More Than Luck", "New York City", "New Zealand", "Nile Delta",
    "North America", "Northwest Passage", "Oceania", "Onion", "Pangaea", "Passage",
    "Pluto", "Pulicat Lake", "Qing China", "Rio de Janeiro", "Russia", "San Francisco",
    "Scandinavia", "Sierpinski", "Sol", "South America", "SoutheastAsia", "Strait of Gibraltar",
    "Strait of Hormuz", "Strait Of Malacca", "Surrounded", "Svalmel", "Taiwan Strait", "The Box",
    "Tierra Del Fuego", "Titan", "Tourney 2 Teams", "Tourney 3 Teams", "Tourney 4 Teams", "Tourney 8 Teams",
    "Traders Dream", "Two Lakes", "United States", "Vancouver Island", "Venice", "Vietnam",
    "Warship Warship", "World", "World Inverted", "Yangtze River", "Yellow Sea", "Yenisei",
  ],
  difficulty: ["Easy", "Medium", "Hard", "Impossible"],
  gameType: ["Singleplayer", "Public", "Private"],
  gameMode: ["Free For All", "Team"],
  rankedType: ["1v1", "2v2"],
  gameMapSize: ["Compact", "Normal"],
  unitType: [
    "Transport", "Warship", "Shell", "SAMMissile", "Port", "Atom Bomb",
    "Hydrogen Bomb", "Trade Ship", "Missile Silo", "Defense Post",
    "SAM Launcher", "City", "MIRV", "MIRV Warhead", "Train", "Factory",
  ],
  publicGameType: ["ffa", "team", "special", "hosted"],
  accent: ["gold", "blue", "green", "red"],
};

function ZbReader(u8) {
  this.b = u8;
  this.p = 0;
  this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}
ZbReader.prototype.left = function () { return this.b.length - this.p; };
ZbReader.prototype.u8 = function () {
  if (this.p >= this.b.length) throw new Error("zbin: fin de trame inattendue");
  return this.b[this.p++];
};
ZbReader.prototype.uint = function () {
  var r = 0, m = 1;
  for (;;) {
    var b = this.u8();
    r += (b & 0x7f) * m;
    if ((b & 0x80) === 0) break;
    m *= 128;
    if (m > 9007199254740992) throw new Error("zbin: varint trop grand");
  }
  return r;
};
ZbReader.prototype.f64 = function () {
  if (this.left() < 8) throw new Error("zbin: fin de trame inattendue");
  var v = this.dv.getFloat64(this.p, true);
  this.p += 8;
  return v;
};
ZbReader.prototype.str = function () {
  var n = this.uint();
  if (this.left() < n) throw new Error("zbin: fin de trame inattendue");
  var s = UTF8.decode(this.b.subarray(this.p, this.p + n));
  this.p += n;
  return s;
};
ZbReader.prototype.header = function (n) {
  var out = new Array(n);
  for (var i = 0; i < n; i++) out[i] = this.u8();
  return out;
};
ZbReader.prototype.end = function () {
  if (this.left() !== 0) throw new Error("zbin: octets en trop après la valeur");
};

var zbit = function (h, i) { return (h[i >> 3] >> (i & 7)) & 1; };

// Fabrique un décodeur d'objet zbin à partir d'une spec de champs.
//   champ : [clé, genre, opts] — genres : "u" varint · "f" float64 ·
//   "s" chaîne · "b" booléen · "e" énum · "o" objet · "a" tableau ·
//   "un" union · "c" littéral · "rec" record.
function zbObject(fields) {
  var bitCount = 0;
  var plan = fields.map(function (f) {
    var key = f[0], kind = f[1], opts = f[2] || {};
    var p = { key: key, kind: kind, opts: opts };
    p.pres = opts.opt ? bitCount++ : -1;
    p.nulB = opts.nul ? bitCount++ : -1;
    p.valB = kind === "b" ? bitCount++ : -1;
    return p;
  });
  var hBytes = Math.ceil(bitCount / 8);
  return function (r) {
    var h = r.header(hBytes);
    var out = {};
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      if (p.pres >= 0 && zbit(h, p.pres) === 0) continue;
      if (p.nulB >= 0 && zbit(h, p.nulB) === 1) { out[p.key] = null; continue; }
      var o = p.opts;
      switch (p.kind) {
        case "b": out[p.key] = zbit(h, p.valB) === 1; break;
        case "c": out[p.key] = o.c; break;
        case "u": out[p.key] = r.uint(); break;
        case "f": out[p.key] = r.f64(); break;
        case "s": out[p.key] = r.str(); break;
        case "e": out[p.key] = o.values[r.uint()]; break;
        case "o": out[p.key] = o.sub(r); break;
        case "a": {
          var n = r.uint();
          var arr = new Array(n);
          for (var j = 0; j < n; j++) arr[j] = o.sub(r);
          out[p.key] = arr;
          break;
        }
        case "un": {
          var tag = r.uint();
          var v = o.variants[tag];
          if (!v) throw new Error("zbin: variante d'union inconnue " + tag);
          if (v.c !== undefined) out[p.key] = v.c;
          else if (v.u) out[p.key] = r.uint();
          else if (v.e) out[p.key] = v.e[r.uint()];
          else if (v.s) out[p.key] = r.str();
          break;
        }
        case "rec": {
          var rn = r.uint();
          var rec = {};
          for (var k = 0; k < rn; k++) {
            var key = o.strKeys ? r.str() : o.enumKeys[r.uint()];
            rec[key] = o.sub(r);
          }
          out[p.key] = rec;
          break;
        }
        default:
          throw new Error("zbin: genre inconnu " + p.kind);
      }
    }
    return out;
  };
}

var zbStr = function (r) { return r.str(); };
var zbUint = function (r) { return r.uint(); };
var zbUnitType = function (r) { return ZBIN_ENUMS.unitType[r.uint()]; };

// Schéma GameConfig (dépôt officiel — ordre de déclaration exact).
var zbGameConfig = zbObject([
  ["gameMap", "e", { values: ZBIN_ENUMS.gameMap }],
  ["difficulty", "e", { values: ZBIN_ENUMS.difficulty }],
  ["donateGold", "b"],
  ["donateTroops", "b"],
  ["gameType", "e", { values: ZBIN_ENUMS.gameType }],
  ["gameMode", "e", { values: ZBIN_ENUMS.gameMode }],
  ["rankedType", "e", { values: ZBIN_ENUMS.rankedType, opt: true }],
  ["gameMapSize", "e", { values: ZBIN_ENUMS.gameMapSize }],
  ["doomsdayClock", "o", { opt: true, sub: zbObject([
    ["enabled", "b", { opt: true }],
    ["speed", "e", { values: ["slow", "normal", "fast", "veryfast"], opt: true }],
  ]) }],
  ["overtime", "o", { opt: true, sub: zbObject([
    ["enabled", "b", { opt: true }],
    ["startMinutes", "u", { opt: true }],
  ]) }],
  ["publicGameModifiers", "o", { opt: true, sub: zbObject([
    ["isCompact", "b", { opt: true }],
    ["isRandomSpawn", "b", { opt: true }],
    ["isCrowded", "b", { opt: true }],
    ["isHardNations", "b", { opt: true }],
    ["startingGold", "u", { opt: true }],
    ["goldMultiplier", "f", { opt: true }],
    ["isAlliancesDisabled", "b", { opt: true }],
    ["isPortsDisabled", "b", { opt: true }],
    ["isNukesDisabled", "b", { opt: true }],
    ["isSAMsDisabled", "b", { opt: true }],
    ["isPeaceTime", "b", { opt: true }],
    ["isWaterNukes", "b", { opt: true }],
    ["isDoomsdayClock", "b", { opt: true }],
  ]) }],
  ["nations", "un", { variants: [{ u: 1 }, { e: ["default", "disabled"] }] }],
  ["bots", "u"],
  ["infiniteGold", "b"],
  ["infiniteTroops", "b"],
  ["instantBuild", "b"],
  ["disableNavMesh", "b", { opt: true }],
  ["disableAlliances", "b", { opt: true, nul: true }],
  ["disableClanTags", "b", { opt: true }],
  ["liveStatsEnabled", "b", { opt: true }],
  ["anonymizeNames", "b", { opt: true }],
  ["nameReveals", "a", { opt: true, sub: zbStr }],
  ["nameRevealPublicIds", "a", { opt: true, sub: zbStr }],
  ["waterNukes", "b", { opt: true, nul: true }],
  ["randomSpawn", "b"],
  ["maxPlayers", "u", { opt: true }],
  ["allowedPublicIds", "a", { opt: true, sub: zbStr }],
  ["trusted", "b", { opt: true }],
  ["maxTimerValue", "u", { opt: true, nul: true }],
  ["customAllianceDuration", "u", { opt: true, nul: true }],
  ["startDelay", "u", { opt: true, nul: true }],
  ["spawnImmunityDuration", "u", { opt: true, nul: true }],
  ["disabledUnits", "a", { opt: true, sub: zbUnitType }],
  ["playerTeams", "un", { opt: true, variants: [
    { u: 1 }, { c: "Duos" }, { c: "Trios" }, { c: "Quads" }, { c: "Humans Vs Nations" },
  ] }],
  ["goldMultiplier", "f", { opt: true, nul: true }],
  ["startingGold", "u", { opt: true, nul: true }],
  ["hostCheats", "o", { opt: true, sub: zbObject([
    ["infiniteGold", "b", { opt: true }],
    ["infiniteTroops", "b", { opt: true }],
    ["goldMultiplier", "f", { opt: true, nul: true }],
    ["startingGold", "u", { opt: true, nul: true }],
  ]) }],
  ["pool", "o", { opt: true, sub: zbObject([
    ["id", "s"],
    ["siblings", "a", { sub: zbStr }],
  ]) }],
]);

// Schéma PublicGameInfo (ordre de déclaration exact).
var zbGameInfo = zbObject([
  ["gameID", "s"],
  ["numClients", "u"],
  ["startsAt", "u", { opt: true }],
  ["gameConfig", "o", { opt: true, sub: zbGameConfig }],
  ["publicGameType", "e", { values: ZBIN_ENUMS.publicGameType }],
  ["label", "s", { opt: true }],
  ["accent", "e", { values: ZBIN_ENUMS.accent, opt: true }],
  ["featured", "b", { opt: true }],
  ["autoStartAt", "u", { opt: true }],
  ["custom", "b", { opt: true }],
]);

// Schéma PublicLobbyMessage : union discriminée { full | counts }.
var zbFull = zbObject([
  ["type", "c", { c: "full" }],
  ["serverTime", "u"],
  ["games", "rec", { enumKeys: ZBIN_ENUMS.publicGameType, sub: function (r) {
    var n = r.uint();
    var arr = new Array(n);
    for (var i = 0; i < n; i++) arr[i] = zbGameInfo(r);
    return arr;
  } }],
  ["gitCommit", "s", { opt: true }],
  ["active", "b", { opt: true }],
]);

var zbCounts = zbObject([
  ["type", "c", { c: "counts" }],
  ["serverTime", "u"],
  ["counts", "rec", { strKeys: true, sub: zbUint }],
]);

/** Décode une trame binaire zbin du flux lobbies. */
function decodeLobbyFrame(bytes) {
  var r = new ZbReader(bytes);
  var tag = r.uint();
  var msg;
  if (tag === 0) msg = zbFull(r);
  else if (tag === 1) msg = zbCounts(r);
  else throw new Error("zbin: tag de message lobbies inconnu (" + tag + ")");
  r.end();
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. /lobbies — instantané JSON (WebSocket côté serveur + décodage zbin)
// ─────────────────────────────────────────────────────────────────────────────

// Cache mémoire : { clé: { data, fetchedAt, inflight } }
const mem = new Map();

async function memFetch(key, ttlMs, loader) {
  const now = Date.now();
  let e = mem.get(key);
  if (!e) {
    e = { data: null, fetchedAt: 0, inflight: null };
    mem.set(key, e);
  }
  if (e.data !== null && now - e.fetchedAt < ttlMs) {
    return { data: e.data, fetchedAt: e.fetchedAt };
  }
  if (e.inflight) return await e.inflight;
  e.inflight = (async () => {
    const data = await loader();
    e.data = data;
    e.fetchedAt = Date.now();
    return { data, fetchedAt: e.fetchedAt };
  })().finally(() => {
    e.inflight = null;
  });
  return await e.inflight;
}

// Handshake WS sortant : deux profils d'en-têtes (nu d'abord — passe la
// passerelle sans maquillage ; puis UA navigateur en repli).
async function wsHandshake(url, withBrowserUa) {
  const headers = {
    Upgrade: "websocket",
    Origin: "https://openfront.io",
  };
  if (withBrowserUa) {
    headers["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    headers["Accept-Language"] = "en-US,en;q=0.9";
  }
  return await fetch(url, {
    headers: headers,
    signal: AbortSignal.timeout(WS_TIMEOUT_MS),
  });
}

async function wsLobbyFull(server) {
  const workerIndex = server.numWorkers > 0
    ? Math.floor(Math.random() * server.numWorkers)
    : 0;
  const url = "https://" + server.host + "/w" + workerIndex + "/lobbies?platform=web";
  let res = await wsHandshake(url, false);
  if (res.status !== 101 || !res.webSocket) {
    try {
      res = await wsHandshake(url, true);
    } catch (e) {
      /* on garde la première réponse pour le message d'erreur */
    }
  }
  if (res.status !== 101 || !res.webSocket) {
    throw new Error("pas de WebSocket sur " + server.host + " (HTTP " + res.status + ")");
  }
  const ws = res.webSocket;
  ws.binaryType = "arraybuffer";
  ws.accept();

  return await new Promise(function (resolve, reject) {
    let settled = false;
    function finish(fn, arg) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) { /* ignore */ }
      fn(arg);
    }
    const timer = setTimeout(function () {
      finish(reject, new Error("aucune trame full reçue de " + server.host));
    }, WS_TIMEOUT_MS);
    ws.addEventListener("message", function (ev) {
      Promise.resolve().then(async function () {
        try {
          let raw = null;
          if (ev.data instanceof ArrayBuffer) raw = ev.data;
          else if (ev.data && typeof ev.data.arrayBuffer === "function") {
            raw = await ev.data.arrayBuffer();
          }
          if (!raw) throw new Error("trame non binaire");
          const msg = decodeLobbyFrame(new Uint8Array(raw));
          if (msg.type === "full") finish(resolve, msg);
        } catch (err) {
          finish(reject, err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    ws.addEventListener("error", function () {
      finish(reject, new Error("erreur WebSocket vers " + server.host));
    });
    ws.addEventListener("close", function (ev) {
      finish(reject, new Error("connexion fermée (" + (ev && ev.code ? ev.code : "?") + ") avant la trame full"));
    });
  });
}

function toLobbyInfo(raw, bucket) {
  const cfg = (raw && raw.gameConfig) || {};
  // v2.2 — gameConfig en PASSTHROUGH complet (objet décodé côté worker, même
  // forme que le décodage zbin de la page) : sans lui, le relais /lobbies
  // perdait rankedType, gameMapSize, publicGameModifiers (pills « Compact »…)
  // et le filtre d'alertes côté site dégénérait. Trim supprimé.
  return {
    gameID: String(raw.gameID || ""),
    numClients: Number(raw.numClients || 0),
    startsAt: typeof raw.startsAt === "number" ? raw.startsAt : undefined,
    autoStartAt: typeof raw.autoStartAt === "number" ? raw.autoStartAt : undefined,
    publicGameType: String(raw.publicGameType || bucket),
    custom: raw.custom === true,
    featured: raw.featured === true,
    queued: false,
    label: raw.label || undefined,
    gameConfig: cfg,
  };
}

let lobbyInflight = null;
let lobbyStale = null; // dernier instantané connu (sert de secours)

async function fetchLobbySnapshot() {
  const now = Date.now();
  if (lobbyStale && now - lobbyStale.generatedAt < LOBBY_CACHE_MS) {
    return lobbyStale;
  }
  if (lobbyInflight) return await lobbyInflight;
  lobbyInflight = (async () => {
    const servers = await getClusterServers();
    let lastError = "aucun serveur joignable";
    for (const srv of servers) {
      try {
        const full = await wsLobbyFull(srv);
        const games = [];
        Object.keys(full.games || {}).forEach(function (bucket) {
          const list = full.games[bucket] || [];
          for (let i = 0; i < list.length; i++) {
            const info = toLobbyInfo(list[i], bucket);
            if (info.gameID) games.push(info);
          }
        });
        games.sort(function (a, b) {
          const rank = function (t) { return t === "ffa" ? 0 : t === "team" ? 1 : 2; };
          const ra = rank(a.publicGameType);
          const rb = rank(b.publicGameType);
          if (ra !== rb) return ra - rb;
          return b.numClients - a.numClients;
        });
        const snapshot = {
          connected: true,
          serverHost: srv.host,
          serverState: srv.state,
          numWorkers: srv.numWorkers,
          version: srv.version,
          serverTime: Number(full.serverTime || Date.now()),
          lastFullAt: Date.now(),
          lastFrameAt: Date.now(),
          lastError: undefined,
          reconnects: 0,
          generatedAt: Date.now(),
          games: games,
        };
        lobbyStale = snapshot;
        return snapshot;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (lobbyStale) {
      const staleCopy = {};
      Object.keys(lobbyStale).forEach(function (k) { staleCopy[k] = lobbyStale[k]; });
      staleCopy.connected = false;
      staleCopy.lastError = "secours: " + lastError;
      return staleCopy;
    }
    throw new Error(lastError);
  })().finally(() => {
    lobbyInflight = null;
  });
  return await lobbyInflight;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cosmétiques compactés
// ─────────────────────────────────────────────────────────────────────────────

function firstPaletteNames(v, max) {
  const cps = v && v.colorPalettes;
  if (!Array.isArray(cps)) return [];
  return cps
    .slice(0, max || 8)
    .map(function (c) { return typeof c === "string" ? c : String((c && c.name) || ""); })
    .filter(Boolean);
}

function compactCosmetics(raw) {
  const groups = { patterns: [], flags: [], crowns: [], skins: [], effects: [], palettes: [] };
  const push = function (arr, v, category) {
    arr.push({
      name: String(v.name || ""),
      rarity: String(v.rarity || "common"),
      artist: v.artist ? String(v.artist) : undefined,
      priceHard: typeof v.priceHard === "number" ? v.priceHard : undefined,
      url: typeof v.url === "string" ? v.url : undefined,
      pattern: typeof v.pattern === "string" ? v.pattern : undefined,
      palettes: firstPaletteNames(v),
      category: category,
    });
  };
  Object.keys(raw.patterns || {}).forEach(function (name) {
    const v = raw.patterns[name];
    push(groups.patterns, Object.assign({}, v, { name: v.name || name }), "pattern");
  });
  Object.keys(raw.flags || {}).forEach(function (name) {
    const v = raw.flags[name];
    push(groups.flags, Object.assign({}, v, { name: v.name || name }), "flag");
  });
  Object.keys(raw.crowns || {}).forEach(function (name) {
    const v = raw.crowns[name];
    push(groups.crowns, Object.assign({}, v, { name: v.name || name }), "crown");
  });
  Object.keys(raw.skins || {}).forEach(function (name) {
    const v = raw.skins[name];
    push(groups.skins, Object.assign({}, v, { name: v.name || name }), "skin");
  });
  Object.keys(raw.effects || {}).forEach(function (category) {
    const group = raw.effects[category] || {};
    Object.keys(group).forEach(function (name) {
      const v = group[name];
      push(groups.effects, Object.assign({}, v, { name: v.name || name }), "effect:" + category);
    });
  });
  Object.keys(raw.colorPalettes || {}).forEach(function (name) {
    const v = raw.colorPalettes[name] || {};
    groups.palettes.push({
      name: v.name || name,
      primaryColor: String(v.primaryColor || "#000000"),
      secondaryColor: String(v.secondaryColor || "#ffffff"),
    });
  });
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Proxy WebSocket transparent (relais /lobby-ws et /matchmaking-ws)
// ─────────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────
// GET /lobby-snapshot — ouvre le WS upstream, capture la 1ère trame
// « full » et la renvoie en JSON : { frame: <base64 zbin>, ts: <ms>,
// host: "<hôte>" }. Timeout 6 s → 504. v2 : hôte résolu dynamiquement
// (cluster.json, open d'abord, repli pool legacy openfront.io).
// ───────────────────────────────────────────────────────────────
async function handleLobbySnapshot(request) {
  const origin = request.headers.get("Origin") || "";
  const cors = { "Content-Type": "application/json" };
  const extra = corsHeadersFor(origin);
  Object.keys(extra).forEach(function (k) { cors[k] = extra[k]; });

  const finish = function (status, body) {
    return new Response(JSON.stringify(body), { status: status, headers: cors });
  };

  try {
    const servers = (await getClusterServers()).slice();
    servers.push({ host: LEGACY_LOBBY_HOST, numWorkers: 20 });
    let lastError = "aucun upstream disponible";
    for (let i = 0; i < servers.length; i++) {
      const host = servers[i].host;
      const n = servers[i].numWorkers > 0 ? servers[i].numWorkers : 20;
      const w = Math.floor(Math.random() * n);
      // v2.1 — API Cloudflare Workers : le WS SORTANT s'ouvre via fetch() sur
      // une URL https:// avec l'entête « Upgrade: websocket » (la réponse
      // 101 porte .webSocket). fetch("wss://…") est REFUSÉ par le runtime
      // (« Fetch API cannot load: wss://… ») — le worker était muet.
      const upstreamUrl = "https://" + host + "/w" + w + "/lobbies?platform=web";
      let upstreamResp;
      try {
        upstreamResp = await fetch(upstreamUrl, {
          headers: {
            "Upgrade": "websocket",
            "Origin": "https://openfront.io",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
          },
        });
      } catch (err) {
        lastError = "WS fetch failed (" + host + "): " +
          (err && err.message ? err.message : String(err));
        continue;
      }
      const upstreamWs = upstreamResp.webSocket;
      if (!upstreamWs) {
        lastError = "upstream " + host + " a refusé le WebSocket (HTTP " +
          upstreamResp.status + ")";
        continue;
      }
      upstreamWs.accept();
      return await new Promise(function (resolve) {
        let settled = false;
        const done = function (status, body) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { upstreamWs.close(); } catch (e) { /* ignore */ }
          resolve(finish(status, body));
        };
        const timer = setTimeout(
          function () { done(504, { error: "snapshot timeout" }); }, 6000);
        upstreamWs.addEventListener("message", function (e) {
          if (settled) return;
          try {
            const bytes = new Uint8Array(e.data);
            // zbin binaire → base64 (safe JSON). Tag 0 = « full » ;
            // on ignore les frames « counts » (tag 1) qui précéderaient.
            if (bytes.length > 0 && bytes[0] !== 0) return;
            let bin = "";
            for (let i = 0; i < bytes.length; i++) {
              bin += String.fromCharCode(bytes[i]);
            }
            done(200, { frame: btoa(bin), ts: Date.now(), host: host });
          } catch (err) {
            done(502, { error: "frame error: " + err.message });
          }
        });
        upstreamWs.addEventListener("close", function () {
          done(502, { error: "upstream closed early" });
        });
        upstreamWs.addEventListener("error", function () {
          done(502, { error: "upstream error" });
        });
      });
    }
    return finish(502, { error: lastError });
  } catch (err) {
    return finish(502, {
      error: "WS fetch failed",
      message: err && err.message ? err.message : String(err),
    });
  }
}

/**
 * Proxifie une connexion WebSocket entrante vers une URL upstream.
 * `resolveUpstream` renvoie une URL (string) OU une liste de candidates
 * (on essaie chacune jusqu'à réussite du handshake).
 */
async function proxyWebSocket(request, resolveUpstream) {
  const upgrade = request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const candidates = await resolveUpstream();
  const list = Array.isArray(candidates) ? candidates : [candidates];
  let lastError = "aucun upstream disponible";

  for (let i = 0; i < list.length; i++) {
    const upstreamUrl = list[i];
    try {
      // ⚠️ API Cloudflare Workers (v2.1) : le WS sortant = fetch() sur une
      // URL https:// + entête « Upgrade: websocket » — PAS fetch("wss://…")
      // (refusé par le runtime : « Fetch API cannot load: wss://… »).
      // Origin requis pour les checks OpenFront. UA Chrome complet (le
      // « Mozilla/5.0 » nu est flagué bot 403 par le challenge CF).
      let upstreamResp = await fetch(upstreamUrl, {
        headers: {
          "Upgrade": "websocket",
          "Origin": "https://openfront.io",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
        },
      });
      if (!upstreamResp.webSocket) {
        try {
          upstreamResp = await fetch(upstreamUrl, {
            headers: { "Upgrade": "websocket", "Origin": "https://openfront.io" },
          });
        } catch (e) { /* on garde la première réponse */ }
      }
      const upstreamWs = upstreamResp.webSocket;
      if (!upstreamWs) {
        lastError = "upstream " + upstreamUrl + " a refusé le WebSocket (HTTP " + upstreamResp.status + ")";
        continue;
      }

      // Create client-facing WebSocket pair
      const pair = new WebSocketPair();
      const clientWs = pair[0];
      const serverWs = pair[1];

      upstreamWs.accept();
      serverWs.accept();

      // Forward upstream → client (binary safe)
      upstreamWs.addEventListener("message", function (e) {
        try { serverWs.send(e.data); } catch (err) {}
      });
      // Forward client → upstream (rarement utile pour le lobby, mais safe)
      serverWs.addEventListener("message", function (e) {
        try { upstreamWs.send(e.data); } catch (err) {}
      });

      const closeBoth = function () {
        try { upstreamWs.close(); } catch (err) {}
        try { serverWs.close(); } catch (err) {}
      };
      upstreamWs.addEventListener("close", closeBoth);
      serverWs.addEventListener("close", closeBoth);
      upstreamWs.addEventListener("error", closeBoth);
      serverWs.addEventListener("error", closeBoth);

      return new Response(null, { status: 101, webSocket: clientWs });
    } catch (err) {
      lastError = "upstream " + upstreamUrl + " : " + (err && err.message ? err.message : String(err));
    }
  }

  return new Response(
    JSON.stringify({ error: "WS proxy failed", message: lastError }),
    { status: 502, headers: { "Content-Type": "application/json" } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Routes
// ─────────────────────────────────────────────────────────────────────────────

const startedAt = Date.now();

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ── Contrôle d'origine (audit sécurité) — requis AVANT tout traitement ──
    const origin = request.headers.get("Origin") || "";
    if (!isOriginAllowed(origin)) {
      return forbidden();
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";

    // ───────────────────────────────────────────────────────────────────
    // WebSocket proxy: /lobby-ws  (FIX v2 : hôte résolu dynamiquement)
    //   Client connects: wss://open-proxy.<compte>.workers.dev/lobby-ws
    //   Worker connects: wss://<hôte actif>/w{0-19}/lobbies (cluster.json)
    // ───────────────────────────────────────────────────────────────────
    if (path === "/lobby-ws") {
      return proxyWebSocket(request, async function () {
        const servers = await getClusterServers();
        const candidates = [];
        for (let i = 0; i < servers.length; i++) {
          const srv = servers[i];
          const n = srv.numWorkers > 0 ? srv.numWorkers : 20;
          const w = Math.floor(Math.random() * n);
          // v2.1 : https:// + Upgrade: websocket (fetch(wss://) est refusé)
          candidates.push("https://" + srv.host + "/w" + w + "/lobbies?platform=web");
        }
        // Repli absolu : pool legacy openfront.io.
        candidates.push("https://" + LEGACY_LOBBY_HOST + "/w" + Math.floor(Math.random() * 20) + "/lobbies?platform=web");
        return candidates;
      });
    }

    // /matchmaking-ws?mode=1v1 → api.openfront.io/matchmaking/join?...
    if (path === "/matchmaking-ws") {
      return proxyWebSocket(request, function () {
        const mode = url.searchParams.get("mode") || "1v1";
        // v2.1 : https:// + Upgrade: websocket (fetch(wss://) est refusé)
        return "https://api.openfront.io/matchmaking/join?instance_id=tfh-monitor&mode=" + encodeURIComponent(mode);
      });
    }

    // ── CORS preflight (origine déjà validée ci-dessus) ──
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeadersFor(origin) });
    }

    // ── Only allow GET ──
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    // ───────────────────────────────────────────────────────────
    // GET /lobby-snapshot — one-shot (v5.17, conservé pour le sync
    //   o2switch) : 1ère trame « full » en base64, décodée côté serveur
    //   par sync-lobby-state.js (lobby-wire.js). v2 : hôte dynamique
    //   via cluster.json (open d'abord) — fin du FORCED_HOST figé.
    // ───────────────────────────────────────────────────────────
    if (path === "/lobby-snapshot") {
      return handleLobbySnapshot(request);
    }

    // ── Santé du worker ──
    if (path === "/" || path === "/health") {
      let lobbies = 0;
      let lobbyError = undefined;
      try {
        const snap = await fetchLobbySnapshot();
        lobbies = snap.games.length;
      } catch (err) {
        lobbyError = err instanceof Error ? err.message : String(err);
      }
      return jsonResponse({
        ok: true,
        service: "openfront-proxy",
        version: "v2.2",
        uptimeMs: Date.now() - startedAt,
        lobbies: lobbies,
        lobbyError: lobbyError,
        endpoints: [
          "/lobby-ws", "/matchmaking-ws", "/lobby-snapshot", "/lobbies", "/leaderboard", "/cluster",
          "/cosmetics", "/player/:id", "/player/:id/games", "/all", "/<path> (proxy)",
        ],
      }, 200, origin);
    }

    // ── Lobbies en JSON (instantané décodé côté serveur) ──
    if (path === "/lobbies" || path === "/lobby") {
      try {
        const snapshot = await fetchLobbySnapshot();
        return jsonResponse(snapshot, 200, origin);
      } catch (err) {
        return jsonResponse({
          connected: false,
          serverHost: "",
          serverState: "",
          numWorkers: 0,
          version: "",
          serverTime: Date.now(),
          lastFullAt: 0,
          lastFrameAt: 0,
          lastError: err instanceof Error ? err.message : String(err),
          reconnects: 0,
          generatedAt: Date.now(),
          games: [],
        }, 200, origin);
      }
    }

    // ── Classements 1v1 + 2v2 ──
    if (path === "/leaderboard") {
      const r = await memFetch("leaderboard", 60000, function () {
        return apiJson("/leaderboard/ranked");
      });
      return jsonResponse(r, 200, origin);
    }

    // ── État des serveurs de jeu ──
    if (path === "/cluster") {
      const r = await memFetch("cluster", 60000, function () {
        return apiJson("/cluster.json?site=openfront.io");
      });
      return jsonResponse(r, 200, origin);
    }

    // ── Cosmétiques compactés ──
    if (path === "/cosmetics") {
      const r = await memFetch("cosmetics", 21600000, async function () {
        return compactCosmetics(await apiJson("/cosmetics.json"));
      });
      return jsonResponse(r, 200, origin);
    }

    // ── Agrégat (chargement atomique) ──
    if (path === "/all" || path === "/dashboard") {
      const parts = await Promise.all([
        memFetch("leaderboard", 60000, function () {
          return apiJson("/leaderboard/ranked");
        }),
        memFetch("cluster", 60000, function () {
          return apiJson("/cluster.json?site=openfront.io");
        }),
        memFetch("cosmetics", 21600000, async function () {
          return compactCosmetics(await apiJson("/cosmetics.json"));
        }),
      ]);
      return jsonResponse({
        generatedAt: Date.now(),
        apiOk: parts[0].data !== null,
        leaderboard: parts[0],
        cluster: parts[1],
        cosmetics: parts[2],
      }, 200, origin);
    }

    // ── Joueur : profil ──
    let m = path.match(/^\/player\/([A-Za-z0-9_-]{4,32})$/);
    if (m) {
      const r = await memFetch("player:" + m[1], 300000, function () {
        return apiJson("/public/player/" + encodeURIComponent(m[1]));
      });
      return jsonResponse(r, 200, origin);
    }

    // ── Joueur : dernières parties ──
    m = path.match(/^\/player\/([A-Za-z0-9_-]{4,32})\/games$/);
    if (m) {
      const r = await memFetch("games:" + m[1], 300000, function () {
        return apiJson("/public/player/" + encodeURIComponent(m[1]) + "/games");
      });
      return jsonResponse(r, 200, origin);
    }

    // ───────────────────────────────────────────────────────────────────
    // HTTP proxy: /<path> → https://api.openfront.io/<path> (inchangé)
    // ───────────────────────────────────────────────────────────────────
    const targetUrl = API_BASE + url.pathname + url.search;
    try {
      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers: await apiHeaders(),
        cf: { cacheTtl: 0 },
      });

      const body = await upstream.text();
      const contentType = upstream.headers.get("content-type") || "application/json";

      return new Response(body, {
        status: upstream.status,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "Vary": "Origin",
          "Access-Control-Allow-Origin": origin,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown proxy error";
      return jsonResponse({ error: "Proxy fetch failed", message: message }, 502, origin);
    }
  },
};

export { decodeLobbyFrame };
