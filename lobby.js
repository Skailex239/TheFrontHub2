// lobby.js — Lobby TheFrontHub (v5 — B+ + favoris & remplissage + hooks v5.18)
//
// v5.29 : FILTRE DES PARTIES (avec lobby-live.js) — le filtre (entonnoir)
//   filtre VRAIMENT l'affichage : les parties qui le cochent s'affichent
//   (sections + bandeau « prochaine partie »), les autres sont masquées.
//   Prédicat exposé par lobby-live.js (window.TFH_LOBBY_FILTER) + event
//   « tfh:lobby:filter-changed » → re-rendu immédiat à chaque changement.
//
// v5.18 : hooks pour lobby-live.js (compteurs live, courbe d'activité, stats
// par mode, alertes) et lobby-chat.js (chat communautaire par partie) :
//   - ingestFull/ingestCounts émettent window event « tfh:lobby:update »
//   - cartes : bouton cloche « prévenir quand pleine » (data-role=watch)
//     et bulle chat (data-role=chat) — délégation dans boot()
//   - clic sur une carte (lancement de partie) → émet « tfh:lobby:open-chat »
//
// v5.21 : SUR DEMANDE DU PROPRIÉTAIRE —
//   - FIN de l'auto-défilement des carrousels (la « transition qui défile
//     vers la droite » était horrible) : les pistes de cartes sont des
//     listes horizontales à scroll MANUEL (doigt/trackpad/flèches).
//   - Bandeau compagnon réduit aux ALERTES (lobby-live.js) : le compteur
//     « Parties analysées », les « Stats des cartes », les chips de mode
//     et la courbe « Joueurs dans le lobby » sont retirés.
//
// Bandeau compact « Prochaine partie », filtre segmenté
// Toutes / FFA / Team / Spécial / Favoris, en-têtes de section au design
// system (majuscules + filet) et cartes claires (vignette, timer flottant,
// pills chips, étoile favori, CTA « Rejoindre »), réparties en pistes
// horizontales à scroll manuel.
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

// Helper i18n : T(clé, fallback, params) — passe par window.t (i18n.js,
// chargé en <head>) et retombe sur le libellé FR si le moteur est absent.
const T = (k, fb, params) => (typeof window.t === "function" ? window.t(k, params) : fb);

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

// ── Server list v2 (v34) — résolution dynamique des hôtes WS ──────────
// À partir de la v34, le client peut lire GET api.<domain>/cluster.json?site=<host>
// pour découvrir les hôtes de jeu (blue/green.openfront.io…).
// ⚠️ v5.21 — FIX « lobby vide » : FORCED_HOST = green + résolution désactivée
// datait du 2026-09-14 (green open, blue draining). Depuis, OpenFront a
// BASCULÉ : blue est actif, green draine → on se connectait à un serveur
// mourant qui ne diffuse plus aucune partie en attente (« aucune partie en
// attente » en permanence). Désormais : cluster.json à chaque (re)connexion
// (serveurs « open » d'abord), repli blue → green si l'endpoint est indisponible.
const FORCED_HOST = "blue.openfront.io"; // repli si cluster.json injoignable
const USE_CLUSTER_JSON = true;
const API_PROXY_META = document.querySelector('meta[name="openfront-api-proxy"]');
const API_PROXY_BASE = (API_PROXY_META && API_PROXY_META.content || "").replace(/\/$/, "");
const CLUSTER_SITE = "openfront.io";
const HOSTS_TTL = 5 * 60_000;       // re-résolution toutes les 5 min
let dynamicHosts = null;            // null = legacy (openfront.io)
let dynamicHostsAt = 0;
let hostsRefreshInFlight = null;

function legacyLobbyWsUrl() {
  const w = DIRECT_WORKERS[Math.floor(Math.random() * DIRECT_WORKERS.length)];
  // ?platform=web : même signature que le client officiel OpenFront
  // (v5.17 : le challenge CF devant les hôtes de jeu filtre sur l'UA — un
  // navigateur réel passe ; le paramètre aligne la requête sur le client jeu).
  return `wss://${FORCED_HOST}/${w}/lobbies?platform=web`;
}

/** Récupère cluster.json v2 via le proxy CF → proxy Next → API directe. */
async function fetchClusterJson() {
  const q = `cluster.json?site=${encodeURIComponent(CLUSTER_SITE)}&t=${Date.now()}`;
  const candidates = [];
  if (API_PROXY_BASE) candidates.push(`${API_PROXY_BASE}/${q}`);
  candidates.push(`/api/openfront/${q}`); // proxy Next (dev/Vercel)
  candidates.push(`https://api.openfront.io/${q}`); // direct (CORS selon l'origine)
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue; // 404 « Unknown site » = endpoint dormant
      const data = await res.json();
      if (data && data.servers && typeof data.servers === "object") return data;
    } catch (e) { /* candidat suivant */ }
  }
  return null;
}

/** Rafraîchit la liste des hôtes (Server list v2) ; fallback legacy sinon. */
function refreshLobbyHosts() {
  if (hostsRefreshInFlight) return hostsRefreshInFlight;
  if (dynamicHosts && Date.now() - dynamicHostsAt < HOSTS_TTL) {
    return Promise.resolve();
  }
  hostsRefreshInFlight = (async () => {
    try {
      const data = await fetchClusterJson();
      // v5.21 : serveurs « open » D'ABORD (le repli FORCED_HOST = blue reste
      // en tête si cluster.json est vide — même logique que le worker v2).
      const hosts = data
        ? Object.values(data.servers || {})
            .filter((s) => s && s.host && s.state !== "draining" && s.state !== "fenced")
            .sort((a, b) => (a.state === "open" ? -1 : 1) - (b.state === "open" ? -1 : 1))
            .map((s) => s.host)
        : [];
      if (hosts.length) {
        if (JSON.stringify(hosts) !== JSON.stringify(dynamicHosts)) {
          console.log(`[lobby] Server list v2 : ${hosts.length} hôte(s) → ${hosts.join(", ")}`);
        }
        dynamicHosts = hosts;
      } else {
        if (dynamicHosts) console.log(`[lobby] Server list v2 vide/absente → repli ${FORCED_HOST}`);
        dynamicHosts = null; // endpoint dormant ou vide → repli
      }
      dynamicHostsAt = Date.now();
    } finally {
      hostsRefreshInFlight = null;
    }
  })();
  return hostsRefreshInFlight;
}

function pickLobbyWsUrl() {
  const w = DIRECT_WORKERS[Math.floor(Math.random() * DIRECT_WORKERS.length)];
  const host = dynamicHosts
    ? dynamicHosts[Math.floor(Math.random() * dynamicHosts.length)]
    : FORCED_HOST;
  return `wss://${host}/${w}/lobbies?platform=web`;
}

const WS_OPEN_TIMEOUT = 12_000;      // délai max avant de passer au niveau suivant
const WS_RECONNECT_BASE = 1_000;     // backoff exponentiel
const WS_RECONNECT_MAX = 15_000;
const HTTP_POLL_INTERVAL = 60_000;   // fallback : refresh 60 s

// ── Mode dégradé « aperçu des dernières parties » (v5.16.7) ──────────────
// Depuis la mise à jour OpenFront du 2026-09-30, Cloudflare challenge
// l'upgrade WebSocket des hôtes de jeu (cf-mitigated: challenge) : ni la
// page, ni le proxy worker, ni le sync serveur ne peuvent plus ouvrir le
// flux lobbies. L'API HTTP /public/games (games terminées) reste,
// elle, accessible — on l'affiche en attendant la réouverture du WS.
const PROXY_HTTP_URL = "https://openfront-proxy.diofortnite3.workers.dev";
// v5.20.2 — source d'enrichissement du mode dégradé : la collecte continue du
// hub (MySQL) connaît la CARTE de chaque partie (route=recent), ce que
// /public/games d'OpenFront n'expose pas. Sans elle, l'aperçu n'affichait
// AUCUNE vignette de carte — d'où « on ne voit plus les cartes ».
const HUB_RECENT_API = "api/games-api.php";
const DEGRADED_WINDOW_MS = 2 * 60 * 60_000;   // fenêtre : 2 h de parties
const DEGRADED_POLL_INTERVAL = 120_000;       // refresh aperçu : 2 min
const DEGRADED_MAX_ITEMS = 24;
// v5.20.3 — tolérance au retard de la collecte hub (cron serveur, 5-15 min).
// Constat terrain 2026-10-02 : le cron games-sync peut geler plusieurs heures
// (rate-limit OpenFront, cron arrêté…) → les 30 dernières parties MySQL
// sortaient TOUTES de la fenêtre 2 h → hubRows = 0 → l'aperçu retombait en
// cartes SANS vignette (« ça fait toujours la même chose »). Dégradé propre :
// au-delà de 2 h de retard, on montre quand même les plus récentes du hub
// (elles ont leurs vignettes), sous quota, jusqu'à 12 h de retard. Passé ce
// délai, on retombe sur le comportement v5.20.2 (fraîches seules).
const DEGRADED_STALE_MAX_MS = 12 * 60 * 60_000; // retard hub toléré : 12 h
const DEGRADED_MAPPED_QUOTA = 16;               // mini de cartes AVEC vignette
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
// v5.30 — alias wire → atlas : l'enum wire « Tourney 2 Teams » slugifie en
// « tourney2teams » alors que la clé atlas (vignettes locales) est « tourney1 ».
const MAP_SLUG_ALIASES = {
  tourney2teams: "tourney1",
  tourney3teams: "tourney2",
  tourney4teams: "tourney3",
  tourney8teams: "tourney4",
};
function mapSlug(mapName) {
  const s = typeof mapName === "string"
    ? mapName.toLowerCase().replace(/[\s_]/g, "").replace(/[^\w]/g, "")
    : "";
  return MAP_SLUG_ALIASES[s] || s;
}

/** Miniature de map — miroir LOCAL d'abord (atlas-data/thumbnails, même
 * origine : rapide, fiable, pas de dépendance à GitHub), puis repli GitHub
 * via l'attribut data-gh + onerror (voir IMG_THUMB_ONERROR). */
function mapThumb(mapName) {
  const slug = mapSlug(mapName);
  // ?v=2 : vignettes officielles OpenFront (fond surface #0a1628, comme le vrai jeu)
  return slug ? `atlas-data/thumbnails/${slug}.webp?v=2` : "";
}

/** Repli distant de la miniature (repo GitHub OpenFrontIO, CDN public). */
function mapThumbRemote(mapName) {
  const slug = mapSlug(mapName);
  return slug
    ? `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${slug}/thumbnail.webp`
    : "";
}

/** v5.22 — chaîne de repli des vignettes : local → GitHub → suppression
 * (l'initiale de la map prend le relais via .lobby-card-img-fallback). */
const IMG_THUMB_ONERROR =
  "if(this.dataset.gh){this.src=this.dataset.gh;this.removeAttribute('data-gh');}else{this.remove();}";

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
    pills.push(T("lobby.pill_gold_x", `Or ×${mods.goldMultiplier}`, { n: mods.goldMultiplier }));
  }
  if (mods.startingGold) {
    const m = Math.round(Number(mods.startingGold) / 1_000_000);
    if (m > 0 && m !== 5) pills.push(T("lobby.pill_gold_m", `Or ${m}M`, { n: m })); // 5M = défaut, pas de pill
  }
  return pills.slice(0, 4); // max 4 pills visibles
}

function pillLabel(p) {
  if (PILL_LABELS.hasOwnProperty(p)) {
    const fb = PILL_LABELS[p];
    return fb == null ? p : T("lobby.pill_" + p, fb);
  }
  return p; // libellés dynamiques ("Or ×3") déjà traduits au push
}

/** Format d'équipe : {teams, perTeam, hvn} → "Duos · 4 équipes" etc. */
const TEAM_SIZES = { duos: 2, trios: 3, quads: 4, quints: 5, sextets: 6 };
const PER_TEAM_LABEL = { 2: "Duos", 3: "Trios", 4: "Quads" };

function describeTeams(cfg) {
  const max = Number(cfg.maxPlayers) || 0;
  const pt = cfg.playerTeams;
  if (typeof pt === "number" && pt > 0) {
    const per = max ? Math.floor(max / pt) : 0;
    return per > 0
      ? T("lobby.teams_of", `${pt} équipes de ${per}`, { n: pt, m: per })
      : T("lobby.teams", `${pt} équipes`, { n: pt });
  }
  if (typeof pt === "string") {
    const s = pt.trim().toLowerCase();
    if (s === "humans vs nations") return T("lobby.humans_vs_nations", "Humains vs Nations");
    const n = TEAM_SIZES[s];
    if (n) {
      const label = PER_TEAM_LABEL[n] || T("lobby.players_n", `${n} joueurs`, { n });
      return max ? `${label} · ${Math.floor(max / n)} équipes` : label;
    }
  }
  return cfg.gameMode === "Team" ? "Team" : "FFA";
}

/** Compte à rebours lisible ("Imminent", "3 min", "1h 20min", "En cours"). */
function countdownText(startsAt, serverNow) {
  if (!startsAt) return T("lobby.cd_pending", "En attente");
  const delta = startsAt - serverNow;
  if (delta <= 0) return T("lobby.cd_ongoing", "En cours");
  const s = Math.floor(delta / 1000);
  if (s < 60) return s <= 10 ? T("lobby.cd_imminent", "Imminent") : `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60 ? (m % 60) + " min" : ""}`.trim();
}

/** Le compte à rebours est-il « urgent » (imminent / déjà en cours) ? */
function isUrgentCountdown(txt) {
  return txt === T("lobby.cd_imminent", "Imminent") || txt === T("lobby.cd_ongoing", "En cours");
}

function modeLabel(game) {
  const cfg = game.gameConfig || {};
  if (game.publicGameType === "special") return T("lobby.sec_special", "Spécial");
  if (cfg.rankedType) return cfg.rankedType === "2v2" ? T("lobby.ranked_2v2", "Classé 2v2") : T("lobby.ranked_1v1", "Classé 1v1");
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
  recentGames: [],         // mode dégradé : dernières parties terminées (/public/games)
  degradedCards: false,    // v5.20.2 : true = state.games contient les cartes d'aperçu (parties terminées)
  hubLagMs: 0,             // v5.20.3 : retard constaté de la collecte hub (0 = à l'heure)
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
      window.showToast?.(T("lobby.toast_new_fav", `Nouvelle partie sur ta carte favorite : ${mapDisplayName(mapName)}`, { map: mapDisplayName(mapName) }), "info", 7000, "star");
    }, i * 400);
  });
}

/** Horloge serveur interpolée localement (serverTime + temps écoulé).
 *  0 si le serveur n'a encore rien annoncé — les consommateurs retombent
 *  alors sur leur horloge locale (guard Number(...) > 0). */
function serverNow() {
  if (!state.serverTime) return 0;
  return state.serverTime + (Date.now() - state.serverTimeAt);
}

/* ── v5.29 — FILTRE DES PARTIES (lobby-live.js) ─────────────────────
 *  Le filtre n'est plus réservé aux alertes : les parties qui le cochent
 *  s'affichent, les autres sont MASQUÉES (sections + bandeau prochaine
 *  partie). lobby-live.js expose window.TFH_LOBBY_FILTER et émet
 *  « tfh:lobby:filter-changed » à chaque changement. */
function customFilter() {
  const lf = window.TFH_LOBBY_FILTER;
  if (lf && typeof lf.active === "function" && typeof lf.matches === "function" && lf.active()) return lf;
  return null;
}

function passesCustomFilter(g, bucket, lf) {
  const f = lf || customFilter();
  if (!f) return true;
  try { return f.matches(g, bucket) !== false; }
  catch { return true; } // un filtre cassé ne doit jamais vider la page
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
  state.degradedCards = false; // v5.20.2 : snapshot LIVE → les cartes d'aperçu partent
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
  // v5.18 — publie le snapshot aux modules compagnons (lobby-live.js : compteurs
  // live / courbe / stats par mode / alertes ; lobby-chat.js : badges salons)
  // v5.20.1 — serverNow : horloge serveur interpolée (les comparaisons startsAt
  // côté alertes ne doivent PAS utiliser l'horloge du navigateur, décalage possible)
  try {
    window.dispatchEvent(new CustomEvent("tfh:lobby:update", {
      detail: { games: state.games, source: state.source, full: true, serverNow: serverNow() },
    }));
  } catch { /* navigateurs très anciens : sans importance */ }
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
  if (touched) {
    // v5.18 — les compteurs de joueurs bougent : publie aux modules compagnons
    try {
      window.dispatchEvent(new CustomEvent("tfh:lobby:update", {
        detail: { games: state.games, source: state.source, full: false, serverNow: serverNow() },
      }));
    } catch { /* ignore */ }
    scheduleRender(false); // maj légère : compteurs seulement
  }
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
  const url = useProxy ? PROXY_WS_URL : pickLobbyWsUrl();
  const level = useProxy ? "proxy" : "direct";

  console.log(`[lobby] Connexion ${level} → ${url}${dynamicHosts ? " [v2]" : ""}`);

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
    stopDegradedMode();
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
      if (msg && msg.type === "full") {
        if (msg.gitCommit) {
          // v34 : le serveur annonce son commit de build (info de bascule)
          console.log(`[lobby] serveur build=${String(msg.gitCommit).slice(0, 7)} active=${msg.active !== false}`);
        }
        ingestFull(msg);
      } else if (msg && msg.type === "counts") ingestCounts(msg);
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
let degradedTimer = null;
let degradedInFlight = false;

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
      // Snapshot vide + WS bloqué → mode dégradé (aperçu dernières parties)
      if (snapshotIsEmpty()) startDegradedMode();
      else stopDegradedMode();
    } else if (data && typeof data === "object") {
      // JSON valide mais sans games (ancien format) → état vide plutôt qu'attente infinie
      ingestFull({ serverTime: Date.now(), games: {} });
      state.connected = true;
      setSource("fallback");
      if (snapshotIsEmpty()) startDegradedMode();
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    state.connected = false;
    setSource("offline");
    // Snapshot injoignable mais le proxy HTTP OpenFront peut marcher →
    // le mode dégradé (aperçu dernières parties) reste utile.
    startDegradedMode();
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
   Mode dégradé — aperçu des dernières parties via l'API HTTP publique
   (/public/games, games terminées) relayée par le proxy Cloudflare.
   Le WS lobbies est bloqué côté OpenFront (challenge CF) : on montre de
   vraies données à la place d'un panneau vide, et le retour du WS est
   automatique dès qu'OpenFront rouvre (retente toutes les 5 min).
   ════════════════════════════════════════════════════════════════════════ */

/** API row → objet compatible avec l'affichage (mode, difficulté, durée…).
 *  v5.20.2 : `enrich` (ligne route=recent du hub) apporte le nom de CARTE +
 *  mapSize + rankedType — sans vignette, l'aperçu dégradé n'affichait rien. */
function deriveRecentCard(g, enrich) {
  const id = String(g.game || "");
  if (!id) return null;
  const startsAt = Date.parse(g.start);
  const endsAt = Date.parse(g.end);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return null;
  const mode = String(g.mode || "");
  // Catégorisation like live : FFA / Team / Special
  const isTeam = /team|2v2|duo/i.test(mode) || String(g.playerTeams || "") === "2";
  const isSpecial = /special/i.test(String(g.type || ""));
  const cfg = {
    gameMap: "",
    maxPlayers: Number(g.maxPlayers) || 0,
    mode,
    difficulty: String(g.difficulty || ""),
  };
  let rankedType = "";
  if (enrich) {
    if (enrich.map) cfg.gameMap = String(enrich.map);
    if (enrich.mapSize) cfg.gameMapSize = String(enrich.mapSize);
    if (enrich.rankedType && enrich.rankedType !== "unranked") rankedType = String(enrich.rankedType);
    if (enrich.difficulty) cfg.difficulty = String(enrich.difficulty);
    if (enrich.playerTeams) cfg.playerTeams = enrich.playerTeams;
    if (enrich.numPlayers) cfg.maxPlayers = Number(enrich.maxPlayers) || cfg.maxPlayers;
  }
  if (rankedType) cfg.rankedType = rankedType;
  return {
    gameID: id,
    degraded: true,
    startsAt,
    endedAt: endsAt,
    durationS: Math.max(0, Math.round((endsAt - startsAt) / 1000)),
    numClients: Number(g.numPlayers) || 0,
    gameConfig: cfg,
    mode,
    difficulty: String(g.difficulty || ""),
    bucket: isSpecial ? "special" : isTeam ? "team" : "ffa",
  };
}

/** Ligne route=recent du HUB (collecte MySQL, 6 M+ parties) → carte d'aperçu.
 *  Le hub connaît la carte + le mode exact — source PRIMAIRE de l'aperçu
 *  dégradé (les vignettes s'affichent), /public/games ne servant qu'à
 *  combler les toutes dernières minutes pas encore collectées. */
function deriveHubCard(r) {
  if (!r || !r.id) return null;
  const startsAt = Number(r.startedAt) || 0;
  const durationS = Number(r.durationS) || 0;
  if (!startsAt || !durationS) return null;
  const mode = String(r.mode || "");
  const isTeam = /team|2v2|duo/i.test(mode) || String(r.playerTeams || "") === "2";
  const isSpecial = /special/i.test(String(r.type || ""));
  const cfg = {
    gameMap: r.map ? String(r.map) : "",
    gameMapSize: r.mapSize ? String(r.mapSize) : undefined,
    maxPlayers: Number(r.numPlayers) || 0,
    mode,
    difficulty: String(r.difficulty || ""),
  };
  if (r.playerTeams) cfg.playerTeams = r.playerTeams;
  if (r.rankedType && r.rankedType !== "unranked") cfg.rankedType = String(r.rankedType);
  return {
    gameID: String(r.id),
    degraded: true,
    startsAt,
    endedAt: startsAt + durationS * 1000,
    durationS,
    numClients: Number(r.numPlayers) || 0,
    gameConfig: cfg,
    mode,
    difficulty: String(r.difficulty || ""),
    bucket: isSpecial ? "special" : isTeam ? "team" : "ffa",
  };
}

/** Récupère les dernières parties terminées (2 h) : hub (cartes !) +
 *  OpenFront /public/games (fraîcheur minute) fusionnées. v5.20.2.
 *  v5.20.3 : robuste au RETARD du hub — si le cron serveur a pris du retard
 *  (> 2 h), les parties MySQL sortent toutes de la fenêtre et l'aperçu
 *  retombait en cartes sans vignette ; on étend alors la sélection aux plus
 *  récentes du hub (jusqu'à 12 h) pour que les vignettes restent visibles. */
async function pollRecentGames() {
  if (degradedInFlight) return;
  degradedInFlight = true;
  const end = Date.now();
  const start = end - DEGRADED_WINDOW_MS;
  const publicUrl = `${PROXY_HTTP_URL}/public/games?start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
  // Hub : même origine (pas de CORS), collecte ≤ 5 min — apporte la carte.
  const hubUrl = `${HUB_RECENT_API}?route=recent&limit=30`;
  const [hubRes, publicRes] = await Promise.allSettled([
    fetch(hubUrl, { cache: "no-store", credentials: "same-origin" }),
    fetch(publicUrl, { cache: "no-store" }),
  ]);
  try {
    // 1. Cartes du hub (avec vignettes de carte) — toutes dérivées, la
    //    fenêtre 2 h est appliquée ensuite (v5.20.3 ; SQL = récentes d'abord).
    const hubAll = [];
    if (hubRes.status === "fulfilled" && hubRes.value.ok) {
      const body = await hubRes.value.json().catch(() => null);
      if (body && body.ok && Array.isArray(body.games)) {
        for (const r of body.games) {
          const c = deriveHubCard(r);
          if (c) hubAll.push(c);
        }
      }
    }
    const hubRows = hubAll.filter((c) => c.startsAt >= start);
    // 2. Parties toutes fraîches d'OpenFront (pas encore collectées par le hub)
    const freshRows = [];
    if (publicRes.status === "fulfilled" && publicRes.value.ok) {
      const arr = await publicRes.value.json().catch(() => null);
      if (Array.isArray(arr)) freshRows.push(...arr);
    }
    const hubIds = new Set(hubAll.map((c) => c.gameID));
    const freshCards = [];
    for (const g of freshRows) {
      const id = String(g.game || "");
      if (!id || hubIds.has(id)) continue; // déjà couvert par le hub (plus riche)
      const c = deriveRecentCard(g, null);
      if (c) freshCards.push(c);
    }
    // 3. Sélection + fusion — v5.20.3 : les cartes AVEC vignette sont
    //    garanties au quota, même quand le hub a du retard.
    let cards;
    let hubLagMs = 0;
    if (hubRows.length > 0) {
      // Chemin nominal (hub à l'heure) : comportement v5.20.2.
      cards = [...hubRows, ...freshCards];
    } else if (
      hubAll.length > 0 && hubAll[0].startsAt >= end - DEGRADED_STALE_MAX_MS
    ) {
      // v5.20.3 — RETARD DU HUB : plus rien dans la fenêtre 2 h, mais les
      // données restent exploitables (≤ 12 h). On montre les plus récentes
      // (vignettes !) en tête, complétées par les fraîches sans carte.
      const staleFloor = end - DEGRADED_STALE_MAX_MS;
      const staleHub = hubAll
        .filter((c) => c.startsAt >= staleFloor && c.gameConfig && c.gameConfig.gameMap)
        .slice(0, freshCards.length > 0 ? DEGRADED_MAPPED_QUOTA : DEGRADED_MAX_ITEMS);
      hubLagMs = end - hubAll[0].startsAt;
      console.warn(`[lobby] hub en retard de ${Math.round(hubLagMs / 60000)} min — vignettes sur les ${staleHub.length} plus récentes du hub`);
      for (const c of staleHub) c.mapPinned = true; // tri : vignettes d'abord
      const freshQuota = Math.max(0, DEGRADED_MAX_ITEMS - staleHub.length);
      cards = [...staleHub, ...freshCards.slice(0, freshQuota)];
    } else {
      // Hub vide ou trop vieux (> 12 h) : v5.20.2 (fraîches seules).
      cards = freshCards.slice(0, DEGRADED_MAX_ITEMS);
    }
    state.hubLagMs = hubLagMs;
    // 4. Ordre d'affichage : cartes pinnées (vignettes) d'abord, puis
    //    décroissance temporelle — plafond global inchangé.
    state.recentGames = cards
      .sort((a, b) => (b.mapPinned ? 1 : 0) - (a.mapPinned ? 1 : 0) || b.startsAt - a.startsAt)
      .slice(0, DEGRADED_MAX_ITEMS);
    console.log(`[lobby] aperçu hors-ligne : ${state.recentGames.length} parties (${hubRows.length} avec carte hub${hubLagMs ? `, hub en retard ${Math.round(hubLagMs / 60000)} min` : ", " + (state.recentGames.length - hubRows.length) + " fraîches"})`);
  } catch (e) {
    console.warn("[lobby] aperçu hors-ligne indisponible :", e && e.message);
    // on garde la liste précédente
  } finally {
    degradedInFlight = false;
  }
  ingestDegradedGames();
  renderDegradedPanel();
  scheduleRender(true);
}

/** v5.20.2 — injecte les parties d'aperçu dans les sections FFA/Team/Spécial
 *  pour qu'elles s'affichent comme de VRAIES cartes défilantes (vignettes,
 *  auto-scroll, filtres) au lieu d'un panneau texte sans images. Les cartes
 *  dégradées portent `degraded: true` (timer « Terminée », actions masquées). */
function ingestDegradedGames() {
  const buckets = { ffa: [], team: [], special: [] };
  for (const c of state.recentGames) {
    (buckets[c.bucket] || buckets.ffa).push(c);
  }
  // Tri interne : la plus récente d'abord (contrairement au live « la plus
  // proche de démarrer d'abord » — ici tout est terminé, la fraîcheur prime)
  for (const k of Object.keys(buckets)) {
    // v5.20.3 : les cartes pinnées (vignettes du hub en retard) restent en
    // tête de section ; sinon décroissance temporelle, comme avant.
    buckets[k].sort(
      (a, b) => (b.mapPinned ? 1 : 0) - (a.mapPinned ? 1 : 0) || b.startsAt - a.startsAt,
    );
  }
  state.games = buckets;
  state.degradedCards = true;
  state.updatedAt = Date.now();
  // Modules compagnons (lobby-live.js) : même contrat que le live — les
  // compteurs suivent l'aperçu plutôt qu'un panneau vide.
  try {
    window.dispatchEvent(new CustomEvent("tfh:lobby:update", {
      detail: { games: state.games, source: state.source, full: true, degraded: true, serverNow: Date.now() },
    }));
  } catch { /* navigateurs très anciens : sans importance */ }
}

/** Démarre le mode dégradé (si pas déjà armé). */
function startDegradedMode() {
  if (degradedTimer) return;
  console.log("[lobby] Mode dégradé : aperçu des dernières parties (API HTTP)");
  pollRecentGames();
  degradedTimer = setInterval(pollRecentGames, DEGRADED_POLL_INTERVAL);
}

/** Stoppe le mode dégradé (WS ou snapshot revenus). */
function stopDegradedMode() {
  if (degradedTimer) {
    clearInterval(degradedTimer);
    degradedTimer = null;
    console.log("[lobby] Mode dégradé arrêté — flux temps réel revenu");
  }
  state.recentGames = [];
  state.hubLagMs = 0;
  // v5.20.2 : si les sections contiennent encore les cartes d'aperçu, on les
  // vide (le prochain snapshot live remplit) pour ne pas afficher des parties
  // terminées sous l'étiquette « Temps réel ».
  if (state.degradedCards) {
    state.games = { ffa: [], team: [], special: [] };
    state.degradedCards = false;
    scheduleRender(true);
  }
  renderDegradedPanel();
}

/** Retourne true si le snapshot courant est totalement vide. */
function snapshotIsEmpty() {
  return state.games.ffa.length === 0 && state.games.team.length === 0 && state.games.special.length === 0;
}

/** Libellé de la période couverte par l'aperçu. Nominal : 2 h (la fenêtre).
 *  v5.20.3 : quand le hub a du retard, la période réelle s'étend au retard
 *  constaté — l'étiquette reste honnête (« Aperçu · 5 h »). */
function previewSpanLabel() {
  const list = state.recentGames;
  let oldest = Infinity;
  for (const c of list) if (c.startsAt && c.startsAt < oldest) oldest = c.startsAt;
  if (!Number.isFinite(oldest)) return "2 h";
  const hours = Math.max(2, Math.ceil((Date.now() - oldest) / 3_600_000));
  return `${hours} h`;
}

/** Injecte/retire le bloc « aperçu » sous le panneau d'état.
 *  v5.20.2 : quand les parties d'aperçu sont rendues en CARTES dans les
 *  sections (state.degradedCards), la liste texte devient redondante — on
 *  n'affiche plus que la note explicative (pourquoi le live est en panne). */
function renderDegradedPanel() {
  const host = document.getElementById("lobby-degraded");
  if (!host) return;
  const active = degradedTimer && state.recentGames.length >= 0;
  if (!active) { host.hidden = true; host.innerHTML = ""; return; }
  host.hidden = false;
  const head = `
    <div class="lobby-degraded-head">
      <h3>${esc(T("lobby.degraded_title", "Aperçu — dernières parties" + " (" + previewSpanLabel() + ")", { span: previewSpanLabel() }))}</h3>
      <p>${esc(T("lobby.degraded_note", "Le flux temps réel est bloqué côté OpenFront (protection anti-bots). Dès sa réouverture, le live revient automatiquement."))}</p>
    </div>`;
  if (state.degradedCards) {
    // Les cartes défilantes affichent déjà les parties avec leur carte :
    // la note seule suffit — pas de double liste.
    host.innerHTML = head;
    return;
  }
  const rows = state.recentGames.map((g) => {
    const mins = Math.max(1, Math.round((Date.now() - g.startsAt) / 60_000));
    const ago = mins < 60
      ? T("lobby.degraded_ago_min", "il y a {n} min", { n: mins })
      : T("lobby.degraded_ago_h", "il y a {n} h", { n: Math.round(mins / 60) });
    const dur = g.durationS >= 60
      ? Math.floor(g.durationS / 60) + " min"
      : g.durationS + " s";
    const mode = g.mode ? esc(g.mode.replace(/^Free For All$/i, "FFA")) : "—";
    const diff = g.difficulty ? esc(g.difficulty) : "";
    return `
      <a class="lobby-degraded-row" href="https://openfront.io/game/${encodeURIComponent(g.gameID)}" target="_blank" rel="noopener">
        <span class="lobby-degraded-ago">${esc(ago)}</span>
        <span class="lobby-degraded-mode">${mode}</span>
        <span class="lobby-degraded-diff">${diff}</span>
        <span class="lobby-degraded-dur">${esc(dur)}</span>
        <span class="lobby-degraded-cta">${esc(T("lobby.degraded_watch", "Voir la partie"))}
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
        </span>
      </a>`;
  }).join("");
  host.hidden = false;
  host.innerHTML = `
    ${head}
    <div class="lobby-degraded-list">${rows || `<p class="lobby-degraded-none">${esc(T("lobby.degraded_none", "Aucune partie terminée sur les 2 dernières heures."))}</p>`}</div>`;
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
      <div class="lobby-filter" role="group" aria-label="${esc(T("lobby.filter_aria", "Filtrer les parties"))}">
        <span class="lobby-filter-label">${esc(T("lobby.filter_show", "Afficher"))}</span>
        <div class="lobby-filter-group">
          ${FILTERS.map((f) => `<button type="button" class="lobby-filter-btn" data-filter="${f.key}" aria-pressed="${f.key === "all"}">${esc(T("lobby.filter_" + f.key, f.label))}</button>`).join("")}
        </div>
        <span class="lobby-filter-updated" id="lobby-updated"></span>
      </div>
      <a class="lobby-banner" id="lobby-hero" hidden></a>
      <div id="lobby-degraded" hidden></div>
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
    const secLabel = T("lobby.sec_" + sec.key, sec.label);
    const el = document.createElement("section");
    el.className = "lobby-section";
    el.id = `lobby-sec-${sec.key}`;
    el.innerHTML = `
      <header class="lobby-section-head">
        <h2 class="lobby-section-title">${esc(secLabel)}</h2>
        <span class="lobby-section-count" id="lobby-count-${sec.key}"></span>
        <span class="lobby-section-rule" aria-hidden="true"></span>
        <div class="lobby-section-nav">
          <button class="lobby-arrow" data-dir="-1" aria-label="${esc(T("lobby.scroll_left", "Défiler vers la gauche"))}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button class="lobby-arrow" data-dir="1" aria-label="${esc(T("lobby.scroll_right", "Défiler vers la droite"))}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </header>
      <div class="lobby-track-zone">
        <div class="lobby-track" id="lobby-track-${sec.key}" tabindex="0" role="list"
             aria-label="${esc(T("lobby.track_aria", `Parties ${sec.label}`, { mode: secLabel }))}"></div>
      </div>`;
    sections.appendChild(el);

    // Flèches de défilement manuel
    const track = $(`#lobby-track-${sec.key}`, el);
    $$(".lobby-arrow", el).forEach((btn) => {
      btn.addEventListener("click", () => {
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

/** Icône cloche du bouton « prévenir quand pleine » (pleine si active). */
function watchIconSvg(filled) {
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
}

/** État visuel du bouton cloche d'une carte (lobby-live.js pilote l'état). */
function setWatchBtn(btn, active) {
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(active));
  btn.innerHTML = watchIconSvg(active);
  btn.title = active
    ? T("lobby.watch_remove_title", "Ne plus surveiller ce lobby")
    : T("lobby.watch_add_title", "Me prévenir quand ce lobby est plein");
  btn.setAttribute("aria-label", btn.title);
  btn.classList.toggle("is-active", active);
}

/** État visuel du bouton favori d'une carte. */
function setFavBtn(btn, filled) {
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(filled));
  btn.innerHTML = favIconSvg(filled);
  btn.title = filled ? T("lobby.fav_remove_title", "Retirer des cartes favorites") : T("lobby.fav_add_title", "Ajouter aux cartes favorites");
  btn.setAttribute("aria-label", filled ? T("lobby.fav_remove_aria", "Retirer la carte des favoris") : T("lobby.fav_add_aria", "Ajouter la carte aux favoris"));
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
           data-gh="${esc(mapThumbRemote(mapName))}"
           onerror="${IMG_THUMB_ONERROR}">
      <span class="lobby-card-img-fallback">${esc(mapName.slice(0, 1).toUpperCase())}</span>
      <span class="lobby-card-shade" aria-hidden="true"></span>
      <span class="lobby-card-timer" data-role="timer"></span>
      <span class="lobby-card-pills"></span>
      <span class="lobby-card-actions">
        <button type="button" class="lobby-card-chat" data-role="chat"
                title="${esc(T("lobby.chat_open_title", "Chat de la partie"))}"
                aria-label="${esc(T("lobby.chat_open_aria", "Ouvrir le chat de cette partie"))}">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button type="button" class="lobby-card-watch" data-role="watch" aria-pressed="false"
                title="${esc(T("lobby.watch_add_title", "Me prévenir quand ce lobby est plein"))}"
                aria-label="${esc(T("lobby.watch_add_aria", "Me prévenir quand ce lobby est plein"))}">${watchIconSvg(false)}</button>
        <button type="button" class="lobby-card-fav" data-role="fav"
                aria-pressed="false" title="${esc(T("lobby.fav_add_title", "Ajouter aux cartes favorites"))}"
                aria-label="${esc(T("lobby.fav_add_aria", "Ajouter la carte aux favoris"))}">${favIconSvg(false)}</button>
      </span>
    </span>
    <span class="lobby-card-body">
      <h3 class="lobby-card-map"></h3>
      <p class="lobby-card-mode"></p>
      <span class="lobby-card-fill" aria-hidden="true"><i data-role="fill"></i></span>
      <span class="lobby-card-foot">
        <span class="lobby-card-count" data-role="count"></span>
        <span class="lobby-card-cta" aria-hidden="true">${esc(T("lobby.join", "Rejoindre"))}
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
  const nPlayers = Number(game.numClients) || 0; // affiché + alertes

  if (opts.full) {
    const img = $(".lobby-card-media img", card);
    const src = mapThumb(mapName);
    if (img) {
      if (img.getAttribute("src") !== src) img.setAttribute("src", src);
      img.dataset.gh = mapThumbRemote(mapName);
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
    // v5.20.2 — carte d'aperçu (partie terminée) : pas d'actions live (chat/
    // cloche), le filtre favoris reste actif (slug de carte présent).
    card.classList.toggle("is-degraded", !!game.degraded);
  }

  // v5.22 — retour demandé : compteur joueurs + barre de remplissage sur
  // chaque carte (maj à CHAQUE frame, y compris les « counts » WebSocket qui
  // font évoluer numClients en temps réel). L'état interne reste aussi
  // utilisé par les alertes (is-full / no-cap).
  const fillEl = $("[data-role=fill]", card);
  if (fillEl) {
    const pct = cap > 0 ? Math.min(100, Math.round((nPlayers / cap) * 100)) : 0;
    if (fillEl.dataset.pct !== String(pct)) {
      fillEl.dataset.pct = String(pct);
      fillEl.style.width = pct + "%";
    }
    card.classList.toggle("is-nearly-full", cap > 0 && pct >= 80 && pct < 100);
  }
  const countEl = $("[data-role=count]", card);
  if (countEl) {
    const txt = cap > 0 ? `${nPlayers}/${cap}` : `${nPlayers}`;
    if (countEl.textContent !== txt) countEl.textContent = txt;
  }

  // Compte à rebours (maj fréquente) — v5.20.2 : « Terminée » sur une carte
  // d'aperçu dégradée (le countdown live n'a pas de sens, la partie est finie)
  const tEl = $("[data-role=timer]", card);
  const txt = game.degraded
    ? T("lobby.cd_done", "Terminée")
    : countdownText(Number(game.startsAt) || 0, serverNow());
  if (tEl) {
    if (tEl.textContent !== txt) tEl.textContent = txt;
    tEl.classList.toggle("urgent", !game.degraded && isUrgentCountdown(txt));
  }
}

/* ── Pistes horizontales — scroll manuel uniquement (v5.21) ───────────
 *   L'ancien auto-défilement (le « défile vers la droite » animé en
 *   permanence) est SUPPRIMÉ sur demande du propriétaire. Les pistes sont
 *   des listes horizontales standards : doigt/trackpad, molette et les
 *   flèches de section suffisent. Pas de rAF, pas de drag custom. */

/* ── Rendu principal ────────────────────────────────────────────────── */

function render(isFull) {
  if (!buildSkeleton()) return;
  renderDegradedPanel(); // sync le bloc « aperçu » à chaque passe de rendu

  // Liste VISIBLE par section :
  //   • filtre « fav » → cartes favorites uniquement (compte requis)
  //   • v5.29 — FILTRE DES PARTIES (lobby-live.js) → seules les parties qui
  //     cochent le filtre s'affichent, les autres sont masquées.
  const filtering = state.filter === "fav";
  const lf = customFilter();
  const customActive = !!lf;
  const visible = {};
  const hiddenCount = {};
  let total = 0;
  for (const sec of SECTIONS) {
    const list = state.games[sec.key] || [];
    visible[sec.key] = list.filter((g) => {
      if (filtering && !state.favorites.has(mapSlug((g.gameConfig || {}).gameMap || ""))) return false;
      if (customActive && !passesCustomFilter(g, sec.key, lf)) return false;
      return true;
    });
    hiddenCount[sec.key] = list.length - visible[sec.key].length;
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
          <p>${esc(T("lobby.connecting", "Connexion aux serveurs OpenFront…"))}</p>
        </div>`;
    } else if (customActive) {
      // v5.29 — le FILTRE ne garde aucune partie : message dédié (ne jamais
      // laisser croire que le flux est en panne alors que c'est le filtre).
      emptyEl.hidden = false;
      emptyEl.innerHTML = `
        <div class="lobby-empty-inner">
          <div class="lobby-empty-icon"><i data-icon="target" data-icon-size="32"></i></div>
          <h3>${T("lobby.empty_filter_title", "Aucune partie ne correspond au filtre")}</h3>
          <p>${T("lobby.empty_filter_text", `Modifie ou réinitialise le filtre (entonnoir en haut) pour revoir toutes les parties.`)}</p>
        </div>`;
    } else if (filtering) {
      emptyEl.hidden = false;
      emptyEl.innerHTML = `
        <div class="lobby-empty-inner">
          <div class="lobby-empty-icon"><i data-icon="star" data-icon-size="32"></i></div>
          <h3>${T("lobby.fav_empty_title", "Aucune partie sur tes cartes favorites")}</h3>
          <p>${T("lobby.fav_empty_text", `Clique l'étoile d'une carte pour l'ajouter à tes favoris —<br>tu seras prévenu dès qu'une partie s'ouvre dessus.`)}</p>
        </div>`;
    } else if (state.source === "fallback" || state.source === "offline") {
      // Mode dégradé : le flux temps réel est injoignable depuis ce réseau
      emptyEl.hidden = false;
      emptyEl.innerHTML = `
        <div class="lobby-empty-inner">
          <div class="lobby-empty-icon"><i data-icon="globe" data-icon-size="32"></i></div>
          <h3>${T("lobby.stream_down_title", "Flux temps réel indisponible")}</h3>
          <p>${T("lobby.stream_down_text", `Impossible de joindre les serveurs OpenFront en direct depuis ce réseau.<br>L'aperçu des dernières parties s'affiche ci-dessous — le live reviendra automatiquement.`)}</p>
          <button class="lobby-retry-btn" type="button">${esc(T("lobby.retry", "Réessayer"))}</button>
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
          <h3>${T("lobby.empty_title", "Aucune partie en attente")}</h3>
          <p>${T("lobby.empty_text", "Les nouvelles parties OpenFront apparaîtront ici automatiquement.")}</p>
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

  // Hero : la prochaine partie à démarrer (toutes catégories) — v5.20.2 :
  // sans objet en mode dégradé (parties déjà terminées, pas de « prochaine »)
  // v5.29 : le bandeau respecte le FILTRE (prochaine partie qui le coche).
  if (isFull && !state.degradedCards) renderHero(lf);
  // Le bandeau « Prochaine partie » n'a pas de sens filtré sur les favoris
  if (filtering) {
    const heroEl = document.getElementById("lobby-hero");
    if (heroEl) heroEl.hidden = true;
  }

  for (const sec of SECTIONS) {
    const games = visible[sec.key];
    const countEl = document.getElementById(`lobby-count-${sec.key}`);
    if (countEl) {
      countEl.textContent = games.length ? `${games.length}` : "";
      // v5.29 — transparence : combien de parties sont masquées par le filtre
      const hid = customActive ? hiddenCount[sec.key] : 0;
      countEl.title = hid > 0
        ? T("lobby.count_hidden_title", `${hid} partie${hid > 1 ? "s" : ""} masquée${hid > 1 ? "s" : ""} par le filtre`, { n: hid, s: hid > 1 ? "s" : "" })
        : "";
    }

    const track = document.getElementById(`lobby-track-${sec.key}`);
    if (!track) continue;

    if (games.length === 0) {
      const msg = customActive
        ? T("lobby.track_empty_filter", `Aucune partie ${esc(sec.label.toLowerCase())} ne correspond au filtre`,
            { mode: esc(T("lobby.sec_" + sec.key, sec.label).toLowerCase()) })
        : filtering
        ? T("lobby.fav_empty_title", "Aucune partie sur tes cartes favorites")
        : T("lobby.track_empty", `Aucune partie ${esc(sec.label.toLowerCase())} en attente`,
            { mode: esc(T("lobby.sec_" + sec.key, sec.label).toLowerCase()) });
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
      // v5.21 : plus AUCUN auto-défilement — la piste reste immobile.
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

/** Grande carte "prochaine partie" (celle qui démarre le plus tôt).
 *  v5.29 : respecte le FILTRE des parties (entonnoir) — le bandeau montre
 *  la prochaine partie qui le coche, jamais une partie masquée. */
function renderHero(lf) {
  const hero = document.getElementById("lobby-hero");
  if (!hero) return;
  const buckets = [
    ["ffa", state.games.ffa], ["team", state.games.team], ["special", state.games.special],
  ];
  let all = [];
  for (const [key, list] of buckets) {
    for (const g of list) {
      if (!(Number(g.startsAt) > 0)) continue;
      if (lf && !passesCustomFilter(g, key, lf)) continue;
      all.push(g);
    }
  }
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
      <span class="lobby-banner-label">${esc(T("lobby.next_game", "Prochaine partie"))}</span>
      <span class="lobby-banner-thumb">
        <img alt="" src="${esc(mapThumb(mapName))}" data-gh="${esc(mapThumbRemote(mapName))}" onerror="${IMG_THUMB_ONERROR}">
        <span class="lobby-banner-thumb-fallback">${esc(mapName.slice(0, 1).toUpperCase())}</span>
      </span>
      <span class="lobby-banner-name">${esc(mapDisplayName(mapName))}</span>
      <span class="lobby-banner-mode">${esc(bannerMode)}</span>
      <span class="lobby-banner-count" data-role="hero-count"></span>
      <span class="lobby-card-timer" data-role="hero-timer"></span>
      <span class="lobby-banner-cta">${esc(T("lobby.join", "Rejoindre"))}
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
      </span>`;
    hero.setAttribute("aria-label", T("lobby.hero_aria", `Rejoindre la prochaine partie : ${mapDisplayName(mapName)}`, { map: mapDisplayName(mapName) }));
  }

  // Mise à jour dynamique — v5.22 : compteur joueurs du bandeau RÉTABLI
  // (demande du propriétaire) + timer.
  const cEl = $("[data-role=hero-count]", hero);
  if (cEl) {
    const hcap = Number(cfg.maxPlayers) || 0;
    const hn = Number(next.numClients) || 0;
    const ctxt = hcap > 0 ? `${hn}/${hcap}` : `${hn}`;
    if (cEl.textContent !== ctxt) cEl.textContent = ctxt;
  }
  const tEl = $("[data-role=hero-timer]", hero);
  if (tEl) {
    const txt = countdownText(Number(next.startsAt) || 0, serverNow());
    tEl.textContent = txt;
    tEl.classList.toggle("urgent", isUrgentCountdown(txt));
  }
}

/* ── Barre d'état (topbar) ──────────────────────────────────────────── */

const SOURCE_META = {
  direct:   { cls: "connected", labelKey: "lobby.status_live", labelFb: "Temps réel", titleKey: "lobby.status_live_title", titleFb: "WebSocket OpenFront (direct)" },
  proxy:    { cls: "connected", labelKey: "lobby.status_live", labelFb: "Temps réel", titleKey: "lobby.status_proxy_title", titleFb: "WebSocket OpenFront (proxy Cloudflare)" },
  fallback: { cls: "delayed",   labelKey: "lobby.status_cache", labelFb: "Cache 5 min", titleKey: "lobby.status_cache_title", titleFb: "Flux temps réel indisponible — données rafraîches toutes les 5 min" },
  offline:  { cls: "error",     labelKey: "lobby.status_offline", labelFb: "Hors ligne", titleKey: "lobby.status_offline_title", titleFb: "Impossible de joindre OpenFront" },
  idle:     { cls: "",          labelKey: "lobby.status_connecting", labelFb: "Connexion…", titleKey: "lobby.status_connecting_title", titleFb: "Connexion en cours" },
};

function renderStatus() {
  const el = document.getElementById("lobby-status");
  if (!el) return;
  const meta = SOURCE_META[state.source] || SOURCE_META.idle;
  el.className = `lobby-status ${meta.cls}`;
  el.title = state.degradedCards
    ? T("lobby.status_preview_title", "Flux temps réel bloqué — aperçu des dernières parties, rafraîchi toutes les 2 min")
    : T(meta.titleKey, meta.titleFb);
  const label = $("#lobby-status-label", el);
  if (label) label.textContent = state.degradedCards
    ? T("lobby.status_preview", "Aperçu · " + previewSpanLabel(), { span: previewSpanLabel() })
    : T(meta.labelKey, meta.labelFb);

  const stats = document.getElementById("lobby-stats");
  if (stats) {
    const total = state.games.ffa.length + state.games.team.length + state.games.special.length;
    if (state.degradedCards) {
      // v5.20.2 — aperçu des parties TERMINÉES : le libellé « en attente »
      // serait mensonger.
      stats.textContent = total > 0
        ? T("lobby.stats_done", `${total} dernières parties (${previewSpanLabel()})`, { total, span: previewSpanLabel() })
        : "";
    } else {
      const players = ["ffa", "team", "special"].reduce(
        (sum, k) => sum + state.games[k].reduce((s, g) => s + (Number(g.numClients) || 0), 0), 0);
      stats.textContent = total > 0
        ? T("lobby.stats",
            `${total} partie${total > 1 ? "s" : ""} en attente · ${players} joueur${players > 1 ? "s" : ""}`,
            { total, players, gs: total > 1 ? "s" : "", ps: players > 1 ? "s" : "" })
        : "";
      // v5.29 — filtre actif : ajoute combien de parties sont masquées
      if (total > 0 && customFilter()) {
        const buckets = [["ffa", state.games.ffa], ["team", state.games.team], ["special", state.games.special]];
        let hid = 0;
        for (const [key, list] of buckets) {
          for (const g of list) if (!passesCustomFilter(g, key)) hid++;
        }
        if (hid > 0) {
          stats.textContent += " · " + T("lobby.stats_hidden",
            `${hid} masquée${hid > 1 ? "s" : ""} par le filtre`, { n: hid, s: hid > 1 ? "s" : "" });
        }
      }
    }
  }
}

/** Injecte la pill d'état dans la topbar (une seule fois, sans écraser le
 * bouton chat présent statiquement dans lobby.html — v5.19). */
function ensureStatusBar() {
  const right = document.querySelector(".topbar-right");
  if (!right || document.getElementById("lobby-status")) return;
  right.insertAdjacentHTML("afterbegin", `
    <span id="lobby-stats" class="lobby-stats"></span>
    <span id="lobby-status" class="lobby-status" title="${esc(T("lobby.status_connecting_title", "Connexion en cours"))}">
      <span class="lobby-status-dot"></span>
      <span id="lobby-status-label">${esc(T("lobby.status_connecting", "Connexion…"))}</span>
    </span>`);
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
  window.showToast?.(T("lobby.toast_login_favorites", "Connecte-toi avec Discord pour enregistrer tes cartes favorites"), "warning", 5000);
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
    window.showToast?.(T("lobby.toast_fav_error", "Impossible de mettre à jour tes favoris, réessaie"), "error");
    return;
  }
  // Répercute sur toutes les cartes de la même carte (plusieurs parties possibles)
  $$('.lobby-card[data-map="' + slug + '"] [data-role=fav]').forEach((b) => setFavBtn(b, r.favorited));
  window.showToast?.(
    r.favorited
      ? T("lobby.toast_fav_added", `${mapDisplayName(mapName)} ajoutée à tes cartes favorites`, { map: mapDisplayName(mapName) })
      : T("lobby.toast_fav_removed", `${mapDisplayName(mapName)} retirée de tes cartes favorites`, { map: mapDisplayName(mapName) }),
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
      const txt = s < 5 ? T("lobby.updated_now", "Actualisé à l'instant")
        : s < 60 ? T("lobby.updated_s", `Actualisé il y a ${s} s`, { n: s })
        : T("lobby.updated_min", `Actualisé il y a ${Math.floor(s / 60)} min`, { n: Math.floor(s / 60) });
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
        // v5.20.2 — carte d'aperçu dégradée : « Terminée » (le countdown
        // écraserait sinon le libellé posé par updateCard toutes les secondes)
        const txt = game.degraded
          ? T("lobby.cd_done", "Terminée")
          : countdownText(Number(game.startsAt) || 0, serverNow());
        if (el.textContent !== txt) el.textContent = txt;
        el.classList.toggle("urgent", !game.degraded && isUrgentCountdown(txt));
      }
    });
    // Hero timer (caché en mode dégradé — le garde-fou reste par sécurité)
    const heroT = document.querySelector("[data-role=hero-timer]");
    if (heroT) {
      const hero = document.getElementById("lobby-hero");
      const id = hero && hero.dataset.gameId;
      const all = [...state.games.ffa, ...state.games.team, ...state.games.special];
      const game = all.find((g) => (g.gameID || g.id) === id);
      if (game) {
        const txt = game.degraded
          ? T("lobby.cd_done", "Terminée")
          : countdownText(Number(game.startsAt) || 0, serverNow());
        heroT.textContent = txt;
        heroT.classList.toggle("urgent", !game.degraded && isUrgentCountdown(txt));
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

  // v5.29 — FILTRE DES PARTIES (lobby-live.js) : à chaque changement de
  // filtre (chips, bornes, cartes, profil, reset), la liste est re-rendue
  // immédiatement — les parties qui cochent s'affichent, les autres partent.
  window.addEventListener("tfh:lobby:filter-changed", () => scheduleRender(true));
  window.addEventListener("tfh:lobby:filter-changed", renderStatus);

  // Étoile favori + cloche « prévenir » + bulle chat : délégation au niveau
  // de la vue — ces clics ne doivent JAMAIS suivre le lien de la carte.
  view().addEventListener("click", (e) => {
    const fav = e.target.closest("[data-role=fav]");
    if (fav) {
      e.preventDefault();
      e.stopPropagation();
      onFavClick(fav);
      return;
    }
    const watch = e.target.closest("[data-role=watch]");
    if (watch) {
      e.preventDefault();
      e.stopPropagation();
      const card = watch.closest(".lobby-card");
      if (card) {
        window.dispatchEvent(new CustomEvent("tfh:lobby:watch-toggle", {
          detail: { gameId: card.dataset.gameId },
        }));
      }
      return;
    }
    const chatBtn = e.target.closest("[data-role=chat]");
    if (chatBtn) {
      e.preventDefault();
      e.stopPropagation();
      const card = chatBtn.closest(".lobby-card");
      if (card) {
        window.dispatchEvent(new CustomEvent("tfh:lobby:open-chat", {
          detail: { gameId: card.dataset.gameId },
        }));
      }
      return;
    }
    // Clic sur la CARTE elle-même = lancement de la partie (le lien s'ouvre
    // dans un nouvel onglet). v5.19 : on RETIENT la partie — dès que le flux
    // voit qu'elle démarre (pleine / compte à rebours écoulé / sortie de
    // liste), lobby-live.js ouvre le chat du salon. Plus d'ouverture immédiate
    // du drawer au clic (c'était « mal fait ») : le chat s'ouvre AU BON MOMENT.
    const card = e.target.closest(".lobby-card");
    if (card && card.dataset.gameId) {
      window.dispatchEvent(new CustomEvent("tfh:lobby:my-game", {
        detail: { gameId: card.dataset.gameId, map: card.dataset.mapName || "" },
      }));
      window.showToast?.(
        T("lobby.mygame_track_toast", "Suivi activé — le chat de la partie s'ouvrira au lancement 💬"),
        "success", 4500, "bell"
      );
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
  // Résolution Server list v2 (non bloquante) : la 1re connexion part en
  // legacy ; dès que cluster.json répond, les reconnexions utilisent les
  // hôtes résolus. Re-résolution périodique toutes les 5 min.
  refreshLobbyHosts();
  setInterval(refreshLobbyHosts, HOSTS_TTL);
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
  // v5.18 — modules compagnons (lobby-live.js / lobby-chat.js)
  setWatchBtn,
  watchIconSvg,
  fallback: startHttpFallback,
  ingest: (fake) => ingestFull(fake),
  // Tests : simule un compte connecté / des favoris (sans serveur PHP)
  setAccount: (u) => { state.account = u || null; scheduleRender(true); },
  setFavorites: (slugs) => { state.favorites = new Set(slugs || []); scheduleRender(true); },
  // Mode dégradé (aperçu dernières parties) — tests E2E / support
  setRecentGames: (rows) => {
    state.recentGames = (rows || []).map(deriveRecentCard).filter(Boolean);
    renderDegradedPanel();
    scheduleRender(true);
  },
  degraded: { start: startDegradedMode, stop: stopDegradedMode },
  toggleFavoriteRemote,
};
