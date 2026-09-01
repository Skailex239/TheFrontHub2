/**
 * dashboard.js — Contrôleur du Tableau de bord TheFrontHub.
 *
 * Architecture (v2 — stats agrégées côté serveur OpenFront) :
 *
 *   1. ranked.json (auto-synced par GitHub Actions) → ranked wins carrière
 *      pour le top 100 1v1 + top 100 2v2. Servé depuis GitHub Pages.
 *      Utilisé pour les joueurs ranked-only (non connectés au site).
 *
 *   2. Firebase public-aliases (Firestore REST API) → liste des joueurs
 *      connectés via Google/Discord qui ont lié leur Public ID.
 *
 *   3. OpenFront API (via proxy Cloudflare Worker ou /api/openfront en dev)
 *      → pour chaque joueur connecté, DEUX appels seulement :
 *
 *        a) GET /public/player/{id}  →  objet `stats` AGRÉGÉ côté serveur
 *           contenant les wins carrière par mode/difficulté/ranked.
 *           1 requête = toutes les wins all-time (plus de pagination de
 *           300 pages !). Marche même pour un joueur à 3000+ games.
 *
 *        b) GET /public/player/{id}/games  →  pagination COURTE qui
 *           S'ARRÊTE au premier game de plus de 7 jours. Typiquement
 *           2-5 pages pour un joueur actif (vs 300 si on paginait tout).
 *           Sert uniquement à calculer les wins de la semaine.
 *
 *      Le proxy Cloudflare Worker ajoute le header x-skailex-access côté
 *      serveur (exemption de rate-limit). Avec seulement ~3-6 requêtes par
 *      joueur (au lieu de 300+), le rate-limit Cloudflare n'est plus un
 *      problème et le dashboard charge en quelques secondes.
 *
 *   Merge :
 *     - Joueurs ranked-only : ranked wins de ranked.json, casual = 0
 *     - Joueurs connectés : ranked wins = max(ranked.json, API carrière),
 *       casual wins = API agrégée
 *
 *   Cache : les stats live sont mises en cache dans localStorage (30 min)
 *   pour éviter de re-fetcher à chaque visite.
 *
 * Barème :
 *   FFA casual  = +10  ·  FFA classé (1v1) = +1
 *   Team casual = +5   ·  Team classé (2v2) = +1
 *   (ranked = 1 pt, PAS en plus du FFA/Team)
 *
 * Auth : importe auth.js (Firebase) et écoute onAuthStateChanged pour brancher
 * la sidebar (login-btn / user-badge). Définit sur window les handlers utilisés
 * par les onclick du HTML : toggleAuthModal, handleLogin, handleLogout,
 * toggleUserDropdown, goToProfilePage, closeProfileModal,
 * startOwnershipVerification, confirmOwnershipVerification,
 * cancelOwnershipVerification.
 */

import {
  auth, db,
  doc, getDoc, setDoc,
  collection, query, where, onSnapshot,
  onAuthStateChanged, signOut,
} from "./auth.js";
import { fetchOpenFront } from "./openfront-client.js?v=25";
import { fetchActiveSkinMap, normPlayerName } from "./reward-codes.js";
import { getSkin } from "./skins.js";

/* ════════════════════════════════════════════════════════════════
   Constantes (barème)
   ════════════════════════════════════════════════════════════════ */

const PTS_FFA_CASUAL  = 10;
const PTS_FFA_RANKED  = 1;   // ranked = 1 pt, pas en plus du FFA
const PTS_TEAM_CASUAL = 5;
const PTS_TEAM_RANKED = 1;   // ranked = 1 pt, pas en plus du Team

/* ════════════════════════════════════════════════════════════════
   State + DOM
   ════════════════════════════════════════════════════════════════ */

const view = document.getElementById("dashboard-view");
const lastUpdateEl = document.getElementById("last-update");

let _rankedData = null;        // ranked.json décodé (ranked wins carrière)
let _connectedPlayers = [];    // [{publicId, username}] depuis Firebase
let _liveStats = {};           // { publicId: { global: {...}, weekly: {...}, games: [], fetchedAt } }
// Layout 2 panneaux : on maintient deux vues (global + weekly) en parallèle
let _mergedViews = { global: [], weekly: [] };
let _liveFetchDone = false;    // true quand toutes les stats live sont chargées
let _liveFetchProgress = 0;    // nombre de joueurs connectés traités
// _dashMode conservé pour compat (plus utilisé par render() — layout 2 panneaux)
let _dashMode = "global";      // "global" | "weekly"
// Skins actifs : publicId → skinId + username → skinId
// Chargé depuis /api/skins.php?activeMap=1 (nouveau système tfh_user_skins).
// Permet d'afficher le pseudo en dégradé animé sur le leaderboard
// pour les joueurs qui ont un cosmétique ACTIF.
let _vipSkins = new Map();      // publicId → skinId
let _vipSkinsByName = new Map(); // username → skinId
let _vipSkinsByNorm = new Map(); // username normalisé → skinId
// ── Nouveautés dashboard : recherche + filtres + tendance hebdo ──
let _pointFilter = "all";      // "all" | "ffa" | "team" — filtre de mode appliqué aux 2 panneaux
let _searchQuery = "";         // recherche joueur (lowercase, trim) — "" = pas de recherche
// Semaine précédente (pré-calculée par sync-dashboard.js, dashboard_scores.json.gz) :
// publicId → { ffaCasualWins, ffaRankedWins, teamCasualWins, teamRankedWins }
// (mêmes clés que pointsFor → même barème, même filtre FFA/Team applicables).
// Sert aux flèches ↑/↓ : rang actuel vs rang FINAL de la semaine dernière.
// Vide si les données de sync ne sont pas encore à jour → pas de flèches (graceful).
let _prevWeekly = new Map();
let currentUser = null;     // { name, publicId, avatar, uid, email }
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;
let _loginInProgress = false;

// Cache key bumped to v3 : la semaine est désormais fixe (lundi→lundi 00h00
// Paris) au lieu d'une fenêtre flottante de 7 jours. Les entrées v2
// contiennent des wins hebdo calculées en fenêtre flottante → à invalider.
const LIVE_CACHE_KEY = "dash_live_stats_v3";
const LIVE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000; // conservé pour compat arrière
// Fuseau horaire de référence pour le découpage hebdomadaire (reset lundi 00h00 Paris).
const WEEK_TZ = "Europe/Paris";
// Nombre max de pages de games à fetcher pour le calcul hebdo. Chaque page
// = ~10 games. 50 pages = 500 games = largement plus qu'une semaine d'activité
// même pour un joueur très actif. On s'arrête en plus dès le 1er game > 7 jours.
const MAX_WEEKLY_PAGES = 50;

/* ════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════ */

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPoints(n) {
  return new Intl.NumberFormat("fr-FR").format(n || 0);
}

/**
 * Retourne le timestamp (ms UTC) du LUNDI 00h00 (heure de Paris)
 * de la semaine contenant `now`. Utilisé comme frontière de reset hebdo.
 *
 * SEMAINE FIXE (reset automatique) :
 *   Les scores hebdo couvrent la semaine en cours, du lundi 00h00 (Paris)
 *   au lundi suivant 00h00. Quand le calendrier passe à un nouveau lundi,
 *   cette fonction renvoie la nouvelle frontière → les points hebdo
 *   retombent à 0 automatiquement, sans aucune action manuelle.
 *
 * On force le fuseau Europe/Paris (au lieu de l'heure locale du navigateur)
 * pour que tous les visiteurs voient la MÊME semaine, cohérente avec le
 * script de pré-calcul (sync-dashboard.js) qui tourne en CI sur UTC.
 */
function getWeekStartMs(now) {
  // 1. Composantes de date dans le fuseau Paris
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: WEEK_TZ,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(new Date(now));
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  const year = parseInt(obj.year, 10);
  const month = parseInt(obj.month, 10) - 1; // 0-indexed
  const day = parseInt(obj.day, 10);
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[obj.weekday];
  if (weekday == null) {
    // Fallback défensif : heure locale navigateur (ancien comportement)
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const dday = d.getDay();
    const diff = dday === 0 ? -6 : 1 - dday;
    d.setDate(d.getDate() + diff);
    return d.getTime();
  }
  // 2. Recule jusqu'à lundi (même semaine calendaire Paris)
  const diff = weekday === 0 ? -6 : 1 - weekday;
  // 3. Candidat "lundi 00h00 UTC"
  const candidateUtc = Date.UTC(year, month, day + diff, 0, 0, 0);
  // 4. Corrige l'offset Paris (CET=+1h ou CEST=+2h selon DST) à cet instant
  const hourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: WEEK_TZ, hour: "2-digit", hour12: false,
  });
  let parisHour = parseInt(hourFmt.format(new Date(candidateUtc)), 10);
  if (isNaN(parisHour)) parisHour = 0;
  parisHour = parisHour % 24; // gère "24" pour minuit dans certains env
  return candidateUtc - parisHour * 3600 * 1000;
}

/** Formate un timestamp (ms) en date longue française (ex: "lundi 11 août 2026")
 *  dans le fuseau Europe/Paris pour rester cohérent avec getWeekStartMs. */
function formatFrenchDate(ms) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: WEEK_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ms));
}

function initials(name) {
  if (!name) return "?";
  const clean = name.replace(/^\[[^\]]+\]\s*/, "").trim();
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : clean.slice(0, 2);
  return letters.toUpperCase();
}

function rankCircleHtml(rank) {
  let cls = "dash-rank";
  if (rank === 1) cls += " dash-rank-1";
  else if (rank === 2) cls += " dash-rank-2";
  else if (rank === 3) cls += " dash-rank-3";
  return `<span class="${cls}">${rank}</span>`;
}

function avatarHtml(name, size = "sm") {
  return `<span class="dash-avatar dash-avatar-${size}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
}

function clanBadgeHtml(clan) {
  if (!clan) return "";
  return `<span class="dash-clan">[${escapeHtml(clan)}]</span>`;
}

function showToast(msg, type = "info", duration = 4000) {
  if (typeof window.showToast === "function") window.showToast(msg, type, duration);
  else console.log(`[toast:${type}]`, msg);
}

/* ════════════════════════════════════════════════════════════════
   Chargement des données (LIVE — pas de sync)
   ════════════════════════════════════════════════════════════════ */

/** Charge ranked.json (ranked wins carrière pour top 100 1v1 + 2v2). */
async function loadRankedJson() {
  try {
    const res = await fetch("ranked.json", { cache: "no-store" });
    if (res.ok) {
      _rankedData = await res.json();
      if (_rankedData?.updatedAt) updateLastUpdateLabel(_rankedData.updatedAt);
      console.log(`[dashboard] ranked.json: ${(_rankedData["1v1"]?.length || 0) + (_rankedData["2v2"]?.length || 0)} joueurs classés`);
    }
  } catch (e) {
    console.warn("[dashboard] ranked.json indisponible:", e.message);
  }
}

/** Charge la liste des joueurs connectés depuis l'API MySQL public-aliases. */
async function loadConnectedPlayers() {
  try {
    const res = await fetch("/api/public-aliases.php", { cache: "no-store" });
    if (!res.ok) {
      console.warn(`[dashboard] API public-aliases: HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const docs = data.aliases || [];
    const seen = new Set();
    _connectedPlayers = docs
      .map((doc) => ({
        publicId: doc.publicId || "",
        username: doc.username || doc.publicId || "?",
      }))
      // Filtrer : publicId valide = exactement 8 caractères alphanumériques
      .filter((p) => /^[A-Za-z0-9]{8}$/.test(p.publicId))
      // Dédoublonner par publicId (garder le premier)
      .filter((p) => {
        if (seen.has(p.publicId)) return false;
        seen.add(p.publicId);
        return true;
      });
    console.log(`[dashboard] API: ${_connectedPlayers.length} joueurs connectés (sur ${docs.length} alias)`);
  } catch (e) {
    console.warn("[dashboard] API indisponible:", e.message);
  }
}

/**
 * Charge la carte des skins ACTIFS depuis l'API MySQL (tfh_user_skins,
 * via /api/skins.php?activeMap=1) en UNE requête pour toute la page.
 * Mappe publicId → skinId ET username → skinId pour appliquer la classe
 * .skin-{id} (définie dans styles.css) sur les pseudos du classement.
 * Remplace l'ancien chargement Firestore public-rewards (legacy désactivé).
 */
async function loadVipSkins() {
  try {
    const { byPid, byUser, byNorm } = await fetchActiveSkinMap();
    _vipSkins = new Map(byPid);
    _vipSkinsByName = new Map(byUser);
    _vipSkinsByNorm = new Map(byNorm || new Map());
    console.log(`[dashboard] Skins actifs: ${_vipSkins.size} joueurs cosmétiques`);
  } catch (e) {
    console.warn("[dashboard] Skins indisponibles:", e.message);
  }
}

/**
 * Résout le skin actif d'un joueur du classement.
 * Priorité: publicId direct → username exact → username normalisé
 * ("[LBU] Skailex" / "VarXard.9236" → forme de base).
 * Retourne un skinId du nouveau catalogue (lagon, aurora, …) ou null.
 */
function getSkinForPlayer(publicId, username) {
  if (publicId && _vipSkins.has(publicId)) return _vipSkins.get(publicId);
  if (username && _vipSkinsByName.has(username)) return _vipSkinsByName.get(username);
  if (username) {
    const norm = normPlayerName(username);
    if (norm && _vipSkinsByNorm.has(norm)) return _vipSkinsByNorm.get(norm);
  }
  return null;
}

/**
 * Extrait les wins carrière (all-time) depuis l'objet `stats` agrégé
 * renvoyé par GET /public/player/{id}. L'API OpenFront maintient ces
 * totaux côté serveur → 1 seule requête par joueur, pas de pagination.
 *
 * Structure de stats (vérifiée empiriquement) :
 *   {
 *     "Public":       { "Free For All": {Easy:{wins,losses,total}, ...},
 *                       "Team": {Easy:{wins,...}, ...},
 *                       "Humans Vs Nations": {...} },
 *     "Private":      { ... idem ... },
 *     "Singleplayer": { "Free For All": {...} },
 *     "Ranked":       { "1v1": {wins, losses, total},
 *                       "2v2": {wins, losses, total} },
 *     "recent":       { ... breakdown des 100 dernières games ... }
 *   }
 *
 * Mapping vers nos 4 catégories (pour coller à l'ancien classifyGame) :
 *   ffaCasual   = Σ stats[Public|Private|Singleplayer]["Free For All"][*].wins
 *                 + Σ stats[*]["Humans Vs Nations"][*].wins
 *   teamCasual  = Σ stats[Public|Private]["Team"][*].wins
 *   ffaRanked   = stats.Ranked["1v1"].wins
 *   teamRanked  = stats.Ranked["2v2"].wins
 */
function extractCareerWinsFromStats(stats) {
  const global = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  if (!stats || typeof stats !== "object") return global;

  // Casual wins : on somme toutes les visibilities (Public/Private/Singleplayer)
  // et tous les modes non-Team non-Ranked (FFA + Humans Vs Nations).
  const CASUAL_VIS = ["Public", "Private", "Singleplayer"];
  const FFA_MODES = ["Free For All", "Humans Vs Nations"];
  for (const vis of CASUAL_VIS) {
    const visData = stats[vis];
    if (!visData || typeof visData !== "object") continue;
    for (const mode of FFA_MODES) {
      const modeData = visData[mode];
      if (!modeData || typeof modeData !== "object") continue;
      for (const diff of Object.keys(modeData)) {
        const d = modeData[diff];
        if (d && typeof d === "object" && d.wins != null) {
          global.ffaCasual += Number(d.wins) || 0;
        }
      }
    }
    // Team casual
    const teamData = visData["Team"];
    if (teamData && typeof teamData === "object") {
      for (const diff of Object.keys(teamData)) {
        const d = teamData[diff];
        if (d && typeof d === "object" && d.wins != null) {
          global.teamCasual += Number(d.wins) || 0;
        }
      }
    }
  }

  // Ranked wins (carrière exacte — pas besoin de ranked.json pour ces joueurs)
  const r1 = stats?.Ranked?.["1v1"];
  if (r1 && r1.wins != null) global.ffaRanked = Number(r1.wins) || 0;
  const r2 = stats?.Ranked?.["2v2"];
  if (r2 && r2.wins != null) global.teamRanked = Number(r2.wins) || 0;

  return global;
}

/**
 * Pagine les parties récentes d'un joueur en S'ARRÊTANT dès qu'on croise
 * une game antérieure au LUNDI 00h00 (Paris) en cours. Typiquement 2-5
 * pages pour un joueur actif, au lieu des 300+ pages qu'il faudrait pour
 * un joueur à 3000 games si on paginait tout l'historique.
 *
 * SEMAINE FIXE : ne retourne QUE les games de la semaine en cours
 * (depuis le lundi 00h00 Paris). Le reset est automatique — quand une
 * nouvelle semaine démarre, weekStartMs avance et les games de la semaine
 * précédente ne sont plus incluses.
 */
async function fetchWeeklyGames(publicId) {
  const weeklyGames = [];
  const weekStartMs = getWeekStartMs(Date.now());
  let cursor = null;
  for (let page = 0; page < MAX_WEEKLY_PAGES; page++) {
    let apiPath = `/public/player/${encodeURIComponent(publicId)}/games`;
    if (cursor) apiPath += `?cursor=${encodeURIComponent(cursor)}`;
    let data;
    try {
      data = await fetchOpenFront(apiPath);
    } catch (e) {
      console.warn(`[dashboard] weekly games ${publicId} page ${page}:`, e.message);
      break;
    }
    const results = data?.results || [];
    if (results.length === 0) break;
    let hitOld = false;
    for (const g of results) {
      const t = g.start ? new Date(g.start).getTime() : 0;
      if (t && t < weekStartMs) { hitOld = true; break; }
      weeklyGames.push(g);
    }
    if (hitOld) break;
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return weeklyGames;
}

/**
 * Charge les stats complètes d'un joueur connecté en 2 étapes :
 *   1. GET /public/player/{id} → wins carrière (agrégé côté serveur, 1 req)
 *   2. GET /public/player/{id}/games paginé jusqu'à la barre des 7 jours
 *      → wins hebdo (2-5 req, stop au premier game trop vieux)
 *
 * Total : ~3-6 requêtes par joueur (vs 300+ auparavant pour un gros joueur).
 * Pour un joueur à 3000 games, les wins carrière sont EXACTES car l'API
 * les maintient côté serveur — le site n'a plus besoin de tout télécharger.
 */
async function fetchPlayerStats(player) {
  // 1. Career (all-time) — 1 requête, stats agrégées côté serveur
  const profile = await fetchOpenFront(`/public/player/${encodeURIComponent(player.publicId)}`);
  const global = extractCareerWinsFromStats(profile?.stats || {});
  const username = profile?.username || player.username;

  // 2. Weekly — pagination courte jusqu'à 7 jours
  const weeklyGames = await fetchWeeklyGames(player.publicId);
  // computeWinsFromGames retourne { global, weekly } ; comme on ne lui passe
  // QUE les games des 7 derniers jours, .global == .weekly (toutes les games
  // sont dans la fenêtre). On prend .global par simplicité.
  const weekly = computeWinsFromGames(weeklyGames).global;

  return {
    publicId: player.publicId,
    username,
    games: weeklyGames.slice(-20), // 20 plus récentes pour le profil
    global,
    weekly,
    totalGames: 0, // non disponible simplement depuis l'API agrégée
    fetchedAt: Date.now(),
  };
}

/** Classifie une game en catégorie. */
function classifyGame(g) {
  const mode = String(g.mode || "").toLowerCase();
  const rt = String(g.rankedType || "").toLowerCase();
  const isTeam =
    mode === "team" ||
    mode.startsWith("2v2") ||
    mode.startsWith("3v3") ||
    mode.startsWith("4v4") ||
    rt === "2v2";
  const isRanked = rt === "1v1" || rt === "2v2" || rt === "ranked";
  if (isTeam) return isRanked ? "teamRanked" : "teamCasual";
  return isRanked ? "ffaRanked" : "ffaCasual";
}

/** Calcule les wins globales + hebdo depuis une liste de games.
 *  La fenêtre hebdo est la SEMAINE FIXE en cours (depuis le lundi 00h00 Paris),
 *  pas une fenêtre flottante de 7 jours. Le reset est donc automatique. */
function computeWinsFromGames(games) {
  const global = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const weekly = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const weekStartMs = getWeekStartMs(Date.now());
  for (const g of games) {
    if (g.result !== "victory") continue;
    const cat = classifyGame(g);
    global[cat]++;
    const t = g.start ? new Date(g.start).getTime() : 0;
    if (t && t >= weekStartMs) {
      weekly[cat]++;
    }
  }
  return { global, weekly };
}

/** Charge les stats live pour tous les joueurs connectés (avec cache, en parallèle). */
async function loadLiveStats() {
  if (_connectedPlayers.length === 0) {
    _liveFetchDone = true;
    return;
  }

  // ── 1. Charger le cache localStorage ──
  let cached = {};
  try {
    const raw = localStorage.getItem(LIVE_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cached = parsed;
    }
  } catch (e) { /* ignore */ }

  // ── 2. Séparer les joueurs en cache (frais) vs à fetcher ──
  const toFetch = [];
  for (const player of _connectedPlayers) {
    const cacheEntry = cached[player.publicId];
    const isFresh = cacheEntry && (Date.now() - cacheEntry.fetchedAt) < LIVE_CACHE_TTL;
    if (isFresh) {
      _liveStats[player.publicId] = cacheEntry;
      _liveFetchProgress++;
    } else {
      toFetch.push(player);
    }
  }
  // Premier rendu avec les données en cache
  if (_liveFetchProgress > 0) mergeAndRender();

  // ── 3. Fetch tous les joueurs en parallèle (exemption = 8 concurrent) ──
  const fetchOne = async (player) => {
    try {
      const entry = await fetchPlayerStats(player);
      _liveStats[player.publicId] = entry;
      cached[player.publicId] = entry;
      localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(cached));
      console.log(`[dashboard] live: ${entry.username} (${player.publicId}) → global=${JSON.stringify(entry.global)} weekly=${JSON.stringify(entry.weekly)}`);
    } catch (e) {
      console.warn(`[dashboard] live fetch failed for ${player.publicId}:`, e.message);
    }
    _liveFetchProgress++;
    mergeAndRender(); // rendu progressif après chaque joueur
  };

  // Lancer tous les fetchs en parallèle
  await Promise.all(toFetch.map(fetchOne));
  _liveFetchDone = true;
}

function updateLastUpdateLabel(ts) {
  if (!ts || !lastUpdateEl) return;
  const d = new Date(typeof ts === "number" ? ts : ts);
  if (Number.isNaN(d.getTime())) return;
  lastUpdateEl.textContent = "Mis à jour le " + new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(d);
}

/* ════════════════════════════════════════════════════════════════
   Merge ranked.json + stats live → _mergedViews { global, weekly }
   ════════════════════════════════════════════════════════════════ */

/**
 * Points d'un joueur selon le filtre de mode actif :
 *   "all"  → barème complet (FFA×10 + FFA classé×1 + Team×5 + Team classé×1)
 *   "ffa"  → uniquement les victoires FFA (casual + classé)
 *   "team" → uniquement les victoires Team (casual + classé)
 * Utilisé aussi pour la semaine précédente (flèches ↑/↓) avec les mêmes
 * clés { ffaCasual, ffaRanked, teamCasual, teamRanked }.
 */
function pointsFor(p, filter = "all") {
  if (filter === "ffa") {
    return (p.ffaCasualWins || 0) * PTS_FFA_CASUAL
         + (p.ffaRankedWins || 0) * PTS_FFA_RANKED;
  }
  if (filter === "team") {
    return (p.teamCasualWins || 0) * PTS_TEAM_CASUAL
         + (p.teamRankedWins || 0) * PTS_TEAM_RANKED;
  }
  return (p.ffaCasualWins || 0) * PTS_FFA_CASUAL
       + (p.ffaRankedWins || 0) * PTS_FFA_RANKED
       + (p.teamCasualWins || 0) * PTS_TEAM_CASUAL
       + (p.teamRankedWins || 0) * PTS_TEAM_RANKED;
}

/**
 * Fusionne ranked.json (career ranked wins) + live API (casual wins)
 * pour les DEUX vues (global + weekly) d'un coup. Les stats live
 * contiennent déjà `global` et `weekly` pour chaque joueur (cf.
 * computeWinsFromGames), donc on parcourt _liveStats deux fois sans
 * re-fetcher.
 */
function buildMergedViews() {
  const buildForMode = (isWeekly) => {
    const byPid = new Map();

    // 1. ranked.json → ranked wins carrière (GLOBAL uniquement)
    //    En weekly, on ne peut pas déduire les wins hebdo depuis ranked.json
    //    (career total only) → les joueurs ranked-only ont 0 pts en weekly
    if (_rankedData) {
      const getOrCreate = (pid, name) => {
        let e = byPid.get(pid);
        if (!e) {
          e = {
            publicId: pid, username: name || pid, clan: null,
            ffaCasualWins: 0, ffaRankedWins: 0,
            teamCasualWins: 0, teamRankedWins: 0,
            _hasLive: false,
          };
          byPid.set(pid, e);
        }
        return e;
      };
      for (const p of _rankedData["1v1"] || []) {
        const nm = p.username || p.accountUsername || p.public_id;
        const e = getOrCreate(p.public_id, nm);
        if (!isWeekly) e.ffaRankedWins = p.wins || 0;
        if (nm && nm !== p.public_id) e.username = nm;
      }
      for (const p of _rankedData["2v2"] || []) {
        const nm = p.username || p.accountUsername || p.public_id;
        const e = getOrCreate(p.public_id, nm);
        if (!isWeekly) e.teamRankedWins = p.wins || 0;
        if (nm && nm !== p.public_id) e.username = nm;
      }
    }

    // 2. Stats live → casual wins + ranked wins
    for (const [pid, live] of Object.entries(_liveStats)) {
      let e = byPid.get(pid);
      if (!e) {
        e = {
          publicId: pid, username: live.username || pid, clan: null,
          ffaCasualWins: 0, ffaRankedWins: 0,
          teamCasualWins: 0, teamRankedWins: 0,
          _hasLive: false,
        };
        byPid.set(pid, e);
      }
      const g = isWeekly ? live.weekly : live.global;
      e.ffaCasualWins = g.ffaCasualWins;
      e.teamCasualWins = g.teamCasualWins;
      // Ranked wins :
      //   - Global : max(ranked.json career, API live) — ranked.json est plus complet
      //   - Weekly : API live uniquement (ranked.json n'a pas de breakdown hebdo)
      if (isWeekly) {
        e.ffaRankedWins = g.ffaRankedWins;
        e.teamRankedWins = g.teamRankedWins;
      } else {
        e.ffaRankedWins = Math.max(e.ffaRankedWins || 0, g.ffaRankedWins);
        e.teamRankedWins = Math.max(e.teamRankedWins || 0, g.teamRankedWins);
      }
      e._hasLive = true;
      if (live.username && live.username !== pid) e.username = live.username;
    }

    // 3. Calcul des points (selon le filtre FFA/Team actif) + tri
    let players = [...byPid.values()].map((p) => ({
      ...p,
      points: pointsFor(p, _pointFilter),
    }));
    // Filtre actif : on masque les joueurs à 0 pt dans la catégorie
    // (un joueur 100 % FFA n'a pas sa place dans la vue Team).
    if (_pointFilter !== "all") players = players.filter((p) => p.points > 0);
    players.sort((a, b) => b.points - a.points);
    // Le rang est porté par les objets RÉELS de la vue (pas des copies) :
    // updateLists() / panelBodyHtml() relisent _mergedViews directement
    // (ligne TOI épinglée, flèches ↑/↓) → il faut p.rank ici.
    players.forEach((p, i) => { p.rank = i + 1; });
    return players;
  };

  return {
    global: buildForMode(false),
    weekly: buildForMode(true),
  };
}

/**
 * Compat shim : retourne la vue globale (ancienne API).
 * Plus utilisé par render() mais conservé pour d'éventuels appels externes.
 */
function getActiveView() {
  return { players: _mergedViews.global };
}

/* ════════════════════════════════════════════════════════════════
   Recherche + tendance hebdo (helpers)
   ════════════════════════════════════════════════════════════════ */

/**
 * Recherche joueur : match si le pseudo BRUT (lowercase) ou NORMALISÉ
 * (normPlayerName : sans tag de clan "[LBU]" ni suffixe ".9216") contient
 * la requête. "skailex" trouve donc "[LBU] Skailex", "9216" trouve
 * "Samraan.9216" (match brut).
 */
function nameMatches(name, q) {
  if (!q) return true;
  const raw = String(name || "").toLowerCase();
  if (raw.includes(q)) return true;
  const norm = normPlayerName(name);
  return !!norm && norm.includes(q);
}

/**
 * Rangs FINAUX de la semaine précédente (pour les flèches ↑/↓ du panel
 * « Cette semaine »), recalculés selon le filtre de mode actif.
 * Retourne Map publicId → rang, ou null si aucune donnée de sync
 * (dashboard_scores.json.gz pas encore régénéré) → pas de flèches.
 */
function computePrevWeeklyRanks() {
  if (_prevWeekly.size === 0) return null;
  const scored = [..._prevWeekly.entries()]
    .map(([pid, w]) => ({ pid, points: pointsFor(w, _pointFilter) }))
    .filter((e) => e.points > 0)
    .sort((a, b) => b.points - a.points);
  const ranks = new Map();
  scored.forEach((e, i) => ranks.set(e.pid, i + 1));
  return ranks;
}

/* ════════════════════════════════════════════════════════════════
   Rendu
   ════════════════════════════════════════════════════════════════ */

function render() {
  if (!_rankedData && _mergedViews.global.length === 0 && _mergedViews.weekly.length === 0) {
    view.innerHTML = `
      <div class="dash-empty-state">
        <div class="dash-empty-icon"><i data-icon="chart"></i></div>
        <h3>Chargement…</h3>
        <p>Récupération du classement…</p>
      </div>`;
    if (window.hydrateIcons) window.hydrateIcons(view);
    return;
  }

  // Deux vues : globale (all time) + hebdo (cette semaine)
  const globalView = _mergedViews.global.map((p) => ({ ...p }));
  const weeklyView = _mergedViews.weekly.map((p) => ({ ...p }));
  if (globalView.length === 0 && weeklyView.length === 0) {
    view.innerHTML = `
      <div class="dash-empty-state">
        <div class="dash-empty-icon"><i data-icon="chart"></i></div>
        <h3>Aucune donnée disponible</h3>
        <p>Chargement…</p>
      </div>`;
    if (window.hydrateIcons) window.hydrateIcons(view);
    return;
  }

  // Ajout du rang dans chaque vue
  globalView.forEach((p, i) => { p.rank = i + 1; });
  weeklyView.forEach((p, i) => { p.rank = i + 1; });

  // Indicateur de chargement live — barre de progression 0-100 %
  const total = _connectedPlayers.length || 1;
  const done = _liveFetchProgress;
  const pct = Math.min(100, Math.round((done / total) * 100));
  const liveTag = "";

  // Préserve le focus de la barre de recherche à travers les re-rendus
  // (mergeAndRender est appelé à chaque fetch live → la saisie ne doit pas
  // perdre le focus ni la position du curseur).
  const searchHadFocus = document.activeElement?.id === "dash-search-input";

  view.innerHTML = `
    ${liveTag}

    <div class="dash-intro">
      <p class="dash-intro-sub">TheFrontHub synchronise automatiquement votre historique de parties et vos statistiques OpenFront, visualise vos conquêtes et classe vos performances à l'échelle mondiale.</p>
      <button class="dash-help-btn" id="dash-help-btn" aria-label="Voir le barème des points" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </button>
      <div class="dash-help-popover" id="dash-help-popover" role="dialog" aria-label="Barème des points">
        <div class="dash-help-popover-header">Barème des points</div>
        <ul class="dash-help-popover-list">
          <li><span class="dash-help-mode">FFA</span><span class="dash-help-pts">+10 pts</span></li>
          <li><span class="dash-help-mode">Team</span><span class="dash-help-pts">+5 pts</span></li>
          <li><span class="dash-help-mode">classé (1v1)</span><span class="dash-help-pts">+1 pt</span></li>
          <li><span class="dash-help-mode">classé (2v2)</span><span class="dash-help-pts">+1 pt</span></li>
        </ul>
        <p class="dash-help-note">Le classé rapporte juste 1 pt, pas en plus du casual.</p>
      </div>
    </div>

    <div class="dash-toolbar">
      <div class="dash-search">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.3" y2="16.3"/></svg>
        <input type="search" id="dash-search-input" placeholder="Rechercher un joueur…" value="${escapeHtml(_searchQuery)}" autocomplete="off" spellcheck="false" aria-label="Rechercher un joueur dans le classement">
        <button type="button" class="dash-search-clear" id="dash-search-clear" aria-label="Effacer la recherche"${_searchQuery ? "" : " hidden"}><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="dash-filters" role="group" aria-label="Filtrer par mode de jeu">
        <button type="button" class="dash-filter${_pointFilter === "all" ? " active" : ""}" data-filter="all" aria-pressed="${_pointFilter === "all"}">Tous</button>
        <button type="button" class="dash-filter${_pointFilter === "ffa" ? " active" : ""}" data-filter="ffa" aria-pressed="${_pointFilter === "ffa"}">FFA</button>
        <button type="button" class="dash-filter${_pointFilter === "team" ? " active" : ""}" data-filter="team" aria-pressed="${_pointFilter === "team"}">Team</button>
      </div>
    </div>

    <div class="dash-grid">
      <section class="dash-panel">
        <div class="dash-panel-header">
          <h2 class="dash-panel-title">Top joueurs — Toutes saisons</h2>
          <span class="dash-panel-sub" id="dash-sub-global"></span>
        </div>
        <div class="dash-panel-body" id="dash-body-global"></div>
      </section>
      <section class="dash-panel">
        <div class="dash-panel-header">
          <h2 class="dash-panel-title">Top joueurs — Cette semaine</h2>
          <span class="dash-panel-sub" id="dash-sub-weekly"></span>
        </div>
        <div class="dash-panel-body" id="dash-body-weekly"></div>
      </section>
    </div>
  `;

  // Hydrate les icônes <i data-icon>
  if (window.hydrateIcons) window.hydrateIcons(view);

  // Toggle la popover du barème
  const helpBtn = document.getElementById("dash-help-btn");
  const helpPopover = document.getElementById("dash-help-popover");
  if (helpBtn && helpPopover) {
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = helpPopover.classList.toggle("open");
      helpBtn.classList.toggle("active", isOpen);
      helpBtn.setAttribute("aria-expanded", String(isOpen));
    });
    // Fermer au clic en dehors
    document.addEventListener("click", (e) => {
      if (!helpPopover.contains(e.target) && !helpBtn.contains(e.target)) {
        helpPopover.classList.remove("open");
        helpBtn.classList.remove("active");
        helpBtn.setAttribute("aria-expanded", "false");
      }
    });
    // Fermer avec Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && helpPopover.classList.contains("open")) {
        helpPopover.classList.remove("open");
        helpBtn.classList.remove("active");
        helpBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  // ── Barre de recherche : filtre les 2 panneaux en direct ──
  const searchInput = document.getElementById("dash-search-input");
  const searchClear = document.getElementById("dash-search-clear");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      _searchQuery = searchInput.value.trim().toLowerCase().slice(0, 40);
      if (searchClear) searchClear.hidden = _searchQuery.length === 0;
      updateLists();
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { clearSearch(); searchInput.blur(); }
    });
  }
  if (searchClear) {
    searchClear.addEventListener("click", () => {
      clearSearch();
      searchInput?.focus();
    });
  }

  // ── Filtres Tous / FFA / Team (appliqués aux 2 panneaux) ──
  document.querySelectorAll(".dash-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!btn.dataset.filter || btn.dataset.filter === _pointFilter) return;
      _pointFilter = btn.dataset.filter;
      // Rebuild complet : points recalculés + tri + corps des panneaux
      mergeAndRender();
    });
  });

  // Remplit les corps des 2 panneaux (listes + flèches + ligne TOI)
  updateLists();

  // Restaure le focus de la recherche si on était en train de saisir
  if (searchHadFocus) {
    const inp = document.getElementById("dash-search-input");
    if (inp) {
      inp.focus();
      const len = inp.value.length;
      try { inp.setSelectionRange(len, len); } catch (e) { /* ignore */ }
    }
  }

  // Re-init scroll reveal pour les nouveaux éléments .dash-panel / .dash-row
  // qui viennent d'être injectés dans le DOM (animations.js tourne avant le
  // rendu du dashboard, donc il ne les avait pas vus).
  if (window.TFH_reveal) {
    requestAnimationFrame(() => window.TFH_reveal());
  }
}

/** Merge + render (utilisé après chaque fetch live pour mise à jour progressive). */
function mergeAndRender() {
  _mergedViews = buildMergedViews();
  render();
}

/* ── Récompense Plutonium (preview) ──
 * Icône : tracé officiel Plutonium d'OpenFront.io (atome vert), réutilisé
 * à l'identique depuis tournois-icons.js (PLUTONIUM_PATH, viewBox 1200×1200,
 * fill #22c55e) pour garder le même rendu que la page Tournois.
 */
const PLUTONIUM_PATH = "m525.94 599.76c0-40.828 33.281-74.062 74.062-74.062 40.828 0 74.062 33.281 74.062 74.062 0 40.828-33.281 74.062-74.062 74.062-40.828 0-74.062-33.281-74.062-74.062zm-5.0625 169.82c15.609-6.5625 32.766-13.594 51.891-22.688-15.609-7.5469-30.234-15.609-44.344-23.672-14.109-8.5781-28.219-17.156-41.812-25.688 1.5 19.172 3.0469 37.781 5.5312 55.453 1.0312 9.5625 2.0156 18.141 3.5156 27.234 6.5625-2.5312 13.125-5.0625 19.641-8.0625 2.0625-0.5625 3.5625-1.5938 5.5781-2.5781zm415.78-169.36c75.094 84.141 106.31 161.76 87.703 219.71l-0.51562 0.51562c0 0.51562-0.51562 1.5-0.98438 2.5312 0 0.51562 0 1.0312-0.51562 1.0312-1.5 5.0156-3.5156 11.062-7.0781 16.125-23.672 41.344-75.609 63-147.66 63-29.719 0-62.484-3.5156-98.25-11.109-34.781 103.31-86.672 169.82-144.61 183.94-1.0312 0.51562-2.0156 0.98438-3.0469 0.98438-1.0312 0.51562-1.5 0.51562-2.5312 0.51562-5.0625 2.0156-11.109 2.5312-19.172 2.5312-68.016 0-129-68.531-168.32-188.95-36.281 8.5781-69.562 12.094-99.797 12.094-71.578 0-123.47-21.656-147.66-63-33.75-58.969-5.5312-146.16 78.609-239.86-83.672-94.734-111.89-181.92-78.609-240.37 3.0469-5.5312 7.0781-10.594 12.094-16.125 0.51562-0.51562 1.0312-1.5 1.5-2.0156 0.51562-0.51563 0.98438-1.0312 1.5-1.0312 40.828-43.359 124.97-55.453 232.31-32.25 39.375-119.95 100.36-188.48 168.37-188.48 5.0156 0 12.094 0.51563 19.641 2.5312 1.5 0 3.0469 0.51563 4.5469 0.98438 56.953 13.125 109.88 80.109 144.61 184.92 106.31-23.156 190.5-11.578 231.79 32.25 0.98438 0 1.5 1.0312 2.0156 1.5 0.51562 0.51563 1.0312 0.98438 1.0312 1.5 5.0156 4.5469 9.0938 10.594 12.094 16.125 33.797 58.5 5.5781 145.69-79.078 240.42zm-521.58 233.86c-1.0312-4.0312-2.0156-8.5781-3.0469-13.125-1.0312-4.0312-2.0156-8.0625-2.5312-11.578-6.5625-30.75-11.578-60.469-14.625-90.703-43.828-32.25-82.125-65.531-114.89-99.797-64.5 72.562-93.234 140.58-81.656 188.48 2.0156 7.0781 4.5469 13.594 8.0625 19.641 4.5469 8.0625 10.594 15.141 18.141 21.656 16.125 4.5469 35.297 7.0781 56.953 7.0781 37.828 0 82.688-7.0781 133.6-21.656zm9.0469-501.42c-95.25-20.156-170.81-10.594-205.6 24.703-1.0312 0.51562-1.5 1.5-2.0156 2.0156-4.5469 4.5469-8.0625 8.5781-10.078 12.609-5.0625 8.0625-8.0625 17.625-9.5625 27.703 12.094 47.344 51.891 104.81 116.39 165.79l0.51563 0.51562c21.188 20.156 45.844 41.344 75.609 63.984-0.51562-2.0156-0.51562-4.5469-0.51562-6.5625-0.51563-7.0312-0.51563-15.141-0.51563-23.672v-2.5312c0-28.219 1.0312-55.922 3.5156-82.125-17.625 13.594-34.781 27.703-50.906 41.812-3.5156-3.0469-7.0781-6.0469-10.078-9.0938-2.5312-2.5312-5.5312-5.0156-8.0625-8.0625 22.172-20.672 46.875-39.797 72.047-58.969 6.0938-54.422 15.656-104.3 29.25-148.13zm327.56 5.0156c-38.297 9.0938-78.609 22.172-119.95 39.328 23.672 11.062 47.859 24.188 74.578 39.328 23.672 13.594 46.875 28.734 71.062 44.859-5.5312-44.906-14.109-86.203-25.688-123.52zm-7.0312 548.29c-46.359-10.078-94.734-26.719-144.61-48.891-28.734 12.609-57.469 23.672-86.672 33.281-2.0156-8.0625-4.0312-16.125-6.0469-24.703-2.5312-13.125-5.5312-26.203-7.5469-40.312 8.5781-3.0469 17.109-6.5625 25.219-10.078 0.98437-0.51562 1.5-0.51562 2.5312-1.0312 23.203-9.5625 47.859-20.672 78.609-36.281 0.51563 0 0.51563-0.51562 1.0312-0.51562 21.656-11.109 43.828-22.172 64.5-34.266 46.875-27.703 91.219-57.469 131.53-87.703 0.51563 0 0.51563-0.51562 1.0312-0.51562h0.51563c0.51562-0.51562 1.0312-0.51562 1.5-1.0312 0.51562-0.51562 1.0312-0.51562 1.0312-1.0312 0.51562-0.51562 1.0312-0.98438 1.5-0.98438 29.203-23.203 55.453-44.859 77.109-66l0.51563-0.51562c63.516-59.484 103.83-116.91 116.91-164.29-1.5-10.594-4.5469-20.672-9.5625-29.25-2.0156-4.0312-5.5312-8.0625-9.5625-12.094-0.51563-1.0312-1.5-1.5-2.5312-2.0156-34.781-36.281-110.86-45.375-205.13-25.688 14.109 44.859 23.672 94.734 29.25 149.16v0.51562c25.688 18.656 49.406 37.781 71.062 57.938-2.5312 3.0469-5.5312 5.5312-8.0625 8.0625-3.0469 3.0469-6.5625 6.0469-10.078 9.0938-15.609-14.109-31.734-27.703-49.406-40.828 0 5.0156 0.51562 10.078 0.51562 15.141 1.0312 14.109 1.5 29.719 1.5 46.359v5.0156c0.51562 5.0625 0.98438 9.5625 0.98438 14.625l-0.51562 0.51562c-6.5625 5.0156-13.125 10.078-20.156 15.609-0.51562 0.51562-1.0312 0.51562-1.0312 0.98438-1.5 1.0312-2.5312 2.0156-4.0312 3.0469h-0.51562c0.51562-6.0469 0.51562-12.094 0.51562-17.625v-12.609c0.51562-4.0312 0-8.0625-0.51562-12.609 0.51562-8.0625 0-16.125-0.51562-24.188 0-5.0625 0-10.594-0.51562-15.609-0.51562-9.5625-1.0312-18.656-2.0156-28.219v-1.0312c-0.51562-3.5156-0.51562-7.0781-1.5-10.078-29.719-21.656-58.969-40.312-87.703-56.953-33.75-19.172-63.984-34.781-93.234-48.375-30.234 13.078-61.5 29.719-93.75 48.375l-6.5625 3.5156c-2.5312 1.5-5.0625 3.0469-8.0625 5.0156 1.0312-11.062 2.5312-21.656 4.0312-31.734 24.703-14.109 48.891-27.234 72.562-38.812-21.656-8.5781-42.328-16.125-61.5-21.656 2.0156-8.5781 4.0312-16.641 6.0469-24.703 26.719 8.0625 56.438 19.172 87.188 32.766 49.406-22.172 97.781-38.812 144.14-48.891-31.734-93.234-76.594-152.68-124.45-165.79-0.98437-0.51562-2.5312-0.51562-3.5156-0.98438-5.5312-1.5-10.078-2.0156-16.641-2.0156-10.078 0-19.641 2.0156-29.25 6.0469-67.547 67.547-112.88 240.37-112.88 448.5 0 24.703 0.51563 48.891 2.0156 72.562 0 1.0312 0 2.0156 0.51562 3.0469 1.5 29.25 4.0312 57.469 7.5469 84.656 0 0.51562 0 1.5 0.51562 2.0156 0.98438 12.094 3.0469 24.188 5.0156 35.297 0 1.5 0 3 0.51562 4.5469l0.51563 0.51562c3.0469 20.672 7.0312 40.828 11.578 59.484 0.51563 2.0156 1.0312 4.0312 1.5 6.0469 0.51563 0.51562 0.51563 1.0312 0.51563 1.0312 19.641 82.125 49.406 145.64 84.141 180.42 9.0938 3.5156 18.141 5.5312 27.703 5.5312 6.5625 0 11.062-0.51562 15.141-2.0156 1.5-0.51562 2.5312-0.51562 4.0312-1.0312 48.844-13.078 94.219-72.516 125.48-165.74zm174.84-267.1c-31.734 34.266-70.031 67.547-113.91 99.281-3.0469 30.75-7.5469 61.5-14.625 91.734-3.5156-0.98438-7.0781-2.0156-11.062-3.0469-4.0312-0.98438-8.0625-2.5312-12.609-4.0312 4.0312-21.188 8.0625-42.844 10.594-64.5-23.672 16.125-46.359 30.234-69.047 43.828-0.98438 0.51562-1.5 1.0312-2.5312 1.5l-4.0312 2.0156c-6.0469 3.5156-12.094 7.0781-18.141 9.5625-1.5 1.0312-2.5312 1.5-4.0312 2.5312 33.75 14.109 64.5 25.219 92.719 33.281h0.51563c0.98437 0.51562 2.0156 0.51562 3.0469 0.51562 55.922 17.156 103.31 24.703 143.63 24.703 20.156 0 37.781-2.0156 53.438-6.0469 8.5781-6.5625 15.141-14.625 20.156-23.156 3-4.5469 5.0156-9.0938 6.5625-14.109 0.51562-1.5 0.98438-3.0469 0.98438-4.5469 12.562-48.422-17.156-116.44-81.656-189.52z";

/** SVG inline de l'icône Plutonium (fill vert OpenFront). */
function plutoniumSvg(size = 12) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 1200 1200" aria-hidden="true" focusable="false"><path d="${PLUTONIUM_PATH}" fill="#22c55e"/></svg>`;
}

// Montant de la récompense hebdo (preview — sera officialisée prochainement).
const WEEKLY_PLUTONIUM_REWARD = 10;

/** Badge [Plutonium 10] + infobulle « preview » — affiché à côté du 1er de la semaine. */
function weeklyPlutoniumBadge() {
  const tip = `Récompense en preview : ${WEEKLY_PLUTONIUM_REWARD} Plutonium pour le 1er de la semaine. Mise en place officielle dans peu de temps.`;
  return `<span class="dash-pu" data-tip="${tip}" tabindex="0" role="note" aria-label="${tip}">${plutoniumSvg(12)}<b>${WEEKLY_PLUTONIUM_REWARD}</b></span>`;
}

/* ── Ranking list — design épuré, une ligne par joueur ──
 *   Pas de carte champion : la liste EST le contenu. Chaque ligne affiche
 *   le rang (trophée 1-3 / badge orange 4+), le nom du joueur, un mini
 *   breakdown des victoires (FFA · Team) en texte discret, et le score
 *   total à droite. Hover = teinte orange subtile + flèche ›.
 *   opts.weekly    : flèches ↑/↓ + badge Plutonium (panel hebdo).
 *   opts.mePid     : surligne la ligne du joueur connecté + chip « TOI ».
 *   opts.prevRanks : Map publicId → rang final semaine précédente (↑/↓).
 *   opts.searching : état recherche (message vide personnalisé). */
function renderRanking(topN, opts = {}) {
  const rows = topN.map((p) => {
    const name = p.username || p.publicId;
    const profileUrl = p.publicId
      ? `profile.html?pid=${encodeURIComponent(p.publicId)}&player=${encodeURIComponent(name)}`
      : `profile.html?player=${encodeURIComponent(name)}`;

    // Icônes SVG pour les 3 premiers : trophy (or) / medal (argent) / medal (bronze)
    const rankIcon = p.rank === 1 ? "trophy" : p.rank === 2 ? "medal" : p.rank === 3 ? "medal" : null;
    const rankSlot = rankIcon
      ? `<span class="dash-rank-trophy dash-rank-${p.rank}" aria-hidden="true"><i data-icon="${rankIcon}"></i></span>`
      : `<span class="dash-rank-badge">${p.rank}</span>`;

    // Mini breakdown des wins : FFA (casual + classé) · Team (casual + classé)
    const ffaWins = (p.ffaCasualWins || 0) + (p.ffaRankedWins || 0);
    const teamWins = (p.teamCasualWins || 0) + (p.teamRankedWins || 0);
    const breakdown = (ffaWins > 0 || teamWins > 0)
      ? `<span class="dash-player-breakdown">
           <span class="dash-bd-ffa">${ffaWins}<i data-icon="swords"></i></span>
           <span class="dash-bd-sep">·</span>
           <span class="dash-bd-team">${teamWins}<i data-icon="users"></i></span>
         </span>`
      : "";

    // Skin actif : applique la classe .skin-{id} (styles.css, chargé sur
    // toutes les pages) sur le span du pseudo.
    const skinType = getSkinForPlayer(p.publicId, name);
    const skinClass = skinType ? " " + getSkin(skinType).cssClass : "";

    // Ligne du joueur connecté : chip « TOI » + fond surligné (.dash-row-me)
    const isMe = !!opts.mePid && p.publicId === opts.mePid;
    const meChip = isMe
      ? `<span class="dash-me-chip" title="Votre position dans le classement">TOI</span>`
      : "";

    // Badge Plutonium (preview) : uniquement à côté du 1er du panel hebdo,
    // en classement OFFICIEL (filtre « Tous » — la récompense porte sur le
    // top toutes catégories). Enveloppé avec le pseudo dans une ligne flex
    // pour rester SUR la ligne du nom (.dash-player est en flex-column :
    // sans wrapper, le badge passerait sous le pseudo).
    const puBadge = opts.weekly && p.rank === 1 && _pointFilter === "all"
      ? weeklyPlutoniumBadge()
      : "";
    const nameHtml = `<span class="dash-player-name${skinClass}">${escapeHtml(name)}</span>`;
    const nameLine = (meChip || puBadge)
      ? `<span class="dash-player-line">${nameHtml}${meChip}${puBadge}</span>`
      : nameHtml;

    // Tendance hebdo : ↑/↓ vs rang final de la semaine dernière (panel hebdo)
    const trend = opts.weekly && opts.prevRanks ? weeklyTrendHtml(p, opts.prevRanks) : "";

    return `
      <a class="dash-row${p.rank <= 3 ? " dash-row-podium" : ""}${p.rank === 1 ? " dash-row-gold" : ""}${isMe ? " dash-row-me" : ""}" href="${profileUrl}">
        <span class="dash-rank-slot">${rankSlot}</span>
        <span class="dash-player">
          ${nameLine}
          ${breakdown}
        </span>
        ${trend}
        <span class="dash-score">
          <span class="dash-score-val">${formatPoints(p.points)}</span><span class="dash-score-suffix">pts</span>
        </span>
        <span class="dash-row-arrow" aria-hidden="true">›</span>
      </a>`;
  }).join("");

  return `
    <div class="dash-list" data-lenis-prevent>
      ${rows || (opts.searching
        ? `<p class="dash-empty">Aucun joueur ne correspond à « ${escapeHtml(_searchQuery)} ».</p>`
        : `<p class="dash-empty">Aucun joueur classé pour le moment.</p>`)}
    </div>`;
}

/* ── Tendance hebdo : flèche ↑/↓ vs rang FINAL de la semaine dernière ──
 *   delta > 0 = le joueur a grimpé · < 0 = descendu · 0 = inchangé.
 *   Pas classé la semaine dernière (0 pt) = « NEW ». Joueur à 0 pt cette
 *   semaine : pas de flèche (rang arbitraire parmi les ex æquo à 0).
 *   Info complémentaire en attribut title (tooltip natif, jamais rogné par
 *   le conteneur scrollable .dash-list, contrairement à une bulle CSS). */
function weeklyTrendHtml(p, prevRanks) {
  if (!p.points) return "";
  const prev = prevRanks.get(p.publicId);
  if (prev == null) {
    return `<span class="dash-trend dash-trend-new" title="N'était pas classé la semaine dernière" aria-label="Nouveau dans le classement de la semaine">NEW</span>`;
  }
  const delta = prev - p.rank;
  if (delta === 0) {
    return `<span class="dash-trend dash-trend-same" title="${prev}${rankOrdinalSuffix(prev)} la semaine dernière — position inchangée" aria-label="Position inchangée">–</span>`;
  }
  if (delta > 0) {
    return `<span class="dash-trend dash-trend-up" title="↑ ${delta} place${delta > 1 ? "s" : ""} vs semaine dernière (${prev}${rankOrdinalSuffix(prev)})" aria-label="Monté de ${delta} place${delta > 1 ? "s" : ""}">↑${delta}</span>`;
  }
  return `<span class="dash-trend dash-trend-down" title="↓ ${-delta} place${delta < -1 ? "s" : ""} vs semaine dernière (${prev}${rankOrdinalSuffix(prev)})" aria-label="Descendu de ${-delta} place${delta < -1 ? "s" : ""}">↓${-delta}</span>`;
}

/** Suffixe ordinal français : 1ᵉʳ, 2ᵉ, 3ᵉ… */
function rankOrdinalSuffix(n) {
  return n === 1 ? "ᵉʳ" : "ᵉ";
}

/* ── Ligne TOI épinglée : le joueur connecté classé au-delà du top 50 ──
 *   Rendue SOUS la liste (hors zone scrollable) → toujours visible sans
 *   scroller. Le rang affiché est le rang RÉEL dans la vue courante. */
function mePinnedRowHtml(me) {
  const name = me.username || me.publicId;
  const profileUrl = `profile.html?pid=${encodeURIComponent(me.publicId)}&player=${encodeURIComponent(name)}`;
  return `
    <a class="dash-row dash-row-me dash-me-pinned" href="${profileUrl}" aria-label="Votre position : ${me.rank} avec ${formatPoints(me.points)} points">
      <span class="dash-rank-slot"><span class="dash-rank-badge">${me.rank}</span></span>
      <span class="dash-player">
        <span class="dash-player-line">
          <span class="dash-player-name">${escapeHtml(name)}</span>
          <span class="dash-me-chip">TOI</span>
        </span>
      </span>
      <span class="dash-score">
        <span class="dash-score-val">${formatPoints(me.points)}</span><span class="dash-score-suffix">pts</span>
      </span>
      <span class="dash-row-arrow" aria-hidden="true">›</span>
    </a>`;
}

/* ── Corps d'un panel : liste + (ligne TOI épinglée) ── */
function panelBodyHtml(fullView, shown, me, weekly) {
  const mePid = currentUser?.publicId || null;
  const searching = _searchQuery.length > 0;
  const prevRanks = weekly ? computePrevWeeklyRanks() : null;
  const list = renderRanking(shown, { weekly, mePid, prevRanks, searching });
  // Ligne TOI épinglée : uniquement hors recherche, si le joueur connecté
  // est classé au-delà du top 50 AVEC des points (un rang à 0 pt serait
  // arbitraire parmi les ex æquo → on ne l'affiche pas).
  const meRow = (me && !searching && me.rank > 50 && me.points > 0) ? mePinnedRowHtml(me) : "";
  return list + meRow;
}

/* ── Re-rend UNIQUEMENT les corps des 2 panneaux ──
 *   Appelé à chaque frappe dans la recherche / après login (ligne TOI) :
 *   la toolbar n'est pas reconstruite → le focus de la saisie est préservé. */
function updateLists() {
  const searching = _searchQuery.length > 0;
  const computeShown = (fullView) => {
    if (!searching) return { shown: fullView.slice(0, 50), total: fullView.length };
    const matches = fullView.filter((p) => nameMatches(p.username, _searchQuery));
    return { shown: matches.slice(0, 20), total: matches.length };
  };

  const fill = (bodyId, subId, fullView, weekly, baseSub) => {
    const body = document.getElementById(bodyId);
    if (!body) return;
    const mePid = currentUser?.publicId || null;
    const me = mePid ? fullView.find((p) => p.publicId === mePid) : null;
    const { shown, total } = computeShown(fullView);
    body.innerHTML = panelBodyHtml(fullView, shown, me, weekly);
    if (window.hydrateIcons) window.hydrateIcons(body);
    const sub = document.getElementById(subId);
    if (sub) {
      if (searching) {
        let label = `${total} résultat${total > 1 ? "s" : ""} pour « ${_searchQuery} »`;
        if (total > shown.length) label += " · 20 premiers affichés";
        sub.textContent = label;
      } else {
        sub.textContent = baseSub(fullView.length);
      }
    }
  };

  fill("dash-body-global", "dash-sub-global", _mergedViews.global, false,
    (n) => `Classement cumulé · ${n} joueurs`);
  fill("dash-body-weekly", "dash-sub-weekly", _mergedViews.weekly, true,
    (n) => `Depuis le ${formatFrenchDate(getWeekStartMs(Date.now()))} · ${n} joueurs actifs`);
}

/** Vide la recherche et ré-affiche les listes complètes. */
function clearSearch() {
  _searchQuery = "";
  const input = document.getElementById("dash-search-input");
  if (input) input.value = "";
  const clearBtn = document.getElementById("dash-search-clear");
  if (clearBtn) clearBtn.hidden = true;
  updateLists();
}

/** Re-rend les listes si elles sont affichées (ligne TOI après login/logout). */
function refreshMeRows() {
  if (_mergedViews.global.length > 0 || _mergedViews.weekly.length > 0) updateLists();
}

/* ════════════════════════════════════════════════════════════════
   Auth UI (sidebar)
   ════════════════════════════════════════════════════════════════ */

function updateAuthUI(user) {
  const loginBtn = document.getElementById("login-btn-main");
  const userContainer = document.getElementById("user-container");
  if (!loginBtn || !userContainer) return;

  if (!user) {
    loginBtn.style.display = "flex";
    userContainer.style.display = "none";
    userContainer.classList.remove("open");
    return;
  }

  loginBtn.style.display = "none";
  userContainer.style.display = "block";

  const name = user.name || "Joueur";
  const publicId = user.publicId || "Non lié";

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setText("user-display-name", name);
  setText("user-public-id-side", publicId !== "Non lié" ? publicId : "En ligne");
  setText("dropdown-username-display", name);
  setText("dropdown-publicid-display", publicId);

  const avatarEl = document.getElementById("dropdown-avatar");
  const sidebarAvatarEl = document.getElementById("sidebar-avatar");
  const renderAvatar = (el) => {
    if (!el) return;
    if (user.avatar) {
      el.innerHTML = `<img src="${escapeHtml(user.avatar)}" alt="${escapeHtml(name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      el.innerHTML = "";
      el.textContent = initials(name);
      el.style.background = "linear-gradient(135deg,var(--accent),var(--accentL))";
      el.style.color = "#fff";
    }
  };
  renderAvatar(avatarEl);
  renderAvatar(sidebarAvatarEl);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    updateAuthUI(null);
    // Retrait de la ligne TOI après déconnexion
    refreshMeRows();
    return;
  }
  currentUser = { uid: user.uid, avatar: user.photoURL, email: user.email };

  // Lecture du profil Firestore
  let profile = null;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) profile = snap.data();
  } catch (e) {
    console.warn("[dashboard] Firestore read error:", e.message);
  }

  if (profile && profile.publicId) {
    currentUser.name = profile.username;
    currentUser.publicId = profile.publicId;
    updateAuthUI(currentUser);
    // Ligne TOI : re-rend les listes si les données sont déjà affichées
    refreshMeRows();
  } else {
    // Premier login sans profil : on affiche le badge + ouvre le setup modal
    currentUser.name = user.displayName || "Joueur";
    updateAuthUI(currentUser);
    refreshMeRows();
    // Redirige vers profile.html pour finaliser le setup (le dashboard n'a pas
    // vocation à héberger tout le flow d'ownership verification ici).
    if (profile == null) {
      // Pas de doc Firestore du tout → l'utilisateur n'a jamais finalisé.
      // On l'envoie sur profile.html qui gère le setup.
      // On évite la boucle en ne redirigeant que si l'URL ne contient pas ?setup=1
      const params = new URLSearchParams(window.location.search);
      if (params.get("setup") !== "1") {
        // Petit délai pour laisser le toast se figurer
        showToast("Bienvenue ! Finalisez votre profil pour accéder à vos stats.", "info", 3500);
        setTimeout(() => { window.location.href = "profile.html"; }, 1200);
        return;
      }
    }
  }
});

/* ════════════════════════════════════════════════════════════════
   Handlers globaux (pour onclick HTML)
   ════════════════════════════════════════════════════════════════ */

window.toggleAuthModal = function () {
  const modal = document.getElementById("auth-modal");
  if (modal) modal.classList.toggle("active");
};

window.closeProfileModal = function () {
  const modal = document.getElementById("profile-modal");
  if (modal) modal.classList.remove("active");
};

// État visuel du bouton Discord pendant la redirection OAuth
function setDiscordRedirecting(redirecting) {
  const btn = document.getElementById("auth-btn-discord") || document.querySelector(".auth-btn.discord");
  if (!btn) return;
  const label = btn.querySelector(".auth-btn-label");
  if (redirecting) {
    btn.disabled = true;
    btn.classList.add("is-redirecting");
    if (label) label.textContent = "Redirection vers Discord…";
  } else {
    btn.disabled = false;
    btn.classList.remove("is-redirecting");
    if (label) label.textContent = "Continuer avec Discord";
  }
}

window.handleLogin = async function (provider) {
  if (_loginInProgress) return;
  _loginInProgress = true;
  setDiscordRedirecting(true);
  try {
    // Discord uniquement — loginWithDiscord() redirige vers l'OAuth
    await window.loginWithDiscord();
    const modal = document.getElementById("auth-modal");
    if (modal) modal.classList.remove("active");
  } catch (e) {
    console.error("[dashboard] Login error:", e);
    _loginInProgress = false;
    setDiscordRedirecting(false);
  }
};

window.handleLogout = async function (event) {
  if (event) event.stopPropagation();
  if (!confirm("Voulez-vous vous déconnecter ?")) return;
  try { await signOut(auth); } catch (e) { console.warn("[dashboard] logout error:", e.message); }
  currentUser = null;
  updateAuthUI(null);
};

window.toggleUserDropdown = function (event) {
  if (event) event.stopPropagation();
  const c = document.getElementById("user-container");
  if (c) c.classList.toggle("open");
};

window.closeUserDropdown = function () {
  const c = document.getElementById("user-container");
  if (c) c.classList.remove("open");
};

window.goToProfilePage = function (event) {
  if (event) event.stopPropagation();
  window.closeUserDropdown();
  // Si l'utilisateur a un publicId, on pointe vers son profil public
  const pid = currentUser?.publicId;
  if (pid) {
    window.location.href = `profile.html?publicId=${encodeURIComponent(pid)}&player=${encodeURIComponent(currentUser.name || "")}`;
  } else {
    window.location.href = "profile.html";
  }
};

// Fermer le dropdown au clic extérieur
document.addEventListener("click", (e) => {
  const c = document.getElementById("user-container");
  if (c && !c.contains(e.target)) c.classList.remove("open");
});

/* ── Ownership verification (pour le #profile-modal copié de index.html) ── */

window.startOwnershipVerification = async function () {
  if (!currentUser) {
    showToast("Veuillez vous connecter d'abord.", "warning");
    return;
  }
  const usernameInput = document.getElementById("profile-username");
  const publicIdInput = document.getElementById("profile-public-id");
  const username = (usernameInput?.value || "").trim();
  const publicId = (publicIdInput?.value || "").trim();

  if (!username || !publicId) {
    showToast("Veuillez remplir tous les champs.", "warning");
    return;
  }
  if (username.length < 2 || username.length > 30) {
    showToast("Le pseudo doit faire entre 2 et 30 caractères.", "warning");
    return;
  }
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) {
    showToast("Le Public ID doit faire exactement 8 caractères alphanumériques (ex: HabCsQYR).", "warning");
    return;
  }
  if (/[^a-zA-Z0-9_\- ]/.test(username)) {
    showToast("Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -.", "warning");
    return;
  }

  showToast("Vérification du Public ID…", "info", 3000);
  try {
    const playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    if (!playerData || !playerData.publicId) {
      showToast("Public ID introuvable sur OpenFront. Vérifiez votre saisie.", "error");
      return;
    }
  } catch (e) {
    if (e?.isNotFound || e?.status === 404) {
      showToast("Public ID introuvable sur OpenFront. Vérifiez votre saisie.", "error");
      return;
    }
    showToast("Impossible de vérifier le Public ID (API indisponible). Réessayez plus tard.", "error", 6000);
    console.error("[ownership] API check failed:", e);
    return;
  }

  // Génération du code challenge TFS-XXXX
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  _ownershipCode = "TFS-";
  const rand = crypto.getRandomValues(new Uint8Array(4));
  for (let i = 0; i < 4; i++) _ownershipCode += chars[rand[i] % chars.length];
  _ownershipPublicId = publicId;
  _ownershipUsername = username;

  const s1 = document.getElementById("profile-setup-step1");
  const s2 = document.getElementById("profile-setup-step2");
  if (s1) s1.style.display = "none";
  if (s2) s2.style.display = "block";
  const codeEl = document.getElementById("ownership-code");
  const exEl = document.getElementById("ownership-example");
  if (codeEl) codeEl.textContent = _ownershipCode;
  if (exEl) exEl.textContent = _ownershipCode + " " + username;
  showToast("Code généré. Suivez les instructions ci-dessous.", "info");
  if (window.hydrateIcons) window.hydrateIcons(document.getElementById("profile-modal"));
};

window.confirmOwnershipVerification = async function () {
  if (!_ownershipCode || !_ownershipPublicId) return;
  const btn = document.getElementById("confirm-ownership-btn");
  const original = btn?.textContent || "Confirmer";
  if (btn) { btn.disabled = true; btn.textContent = "Vérification…"; }
  try {
    const gamesData = await fetchOpenFront(`/public/player/${encodeURIComponent(_ownershipPublicId)}/games`);
    const games = Array.isArray(gamesData?.results) ? gamesData.results : [];
    const found = games.some((g) => g.username && g.username.includes(_ownershipCode));
    if (!found) {
      showToast("Code non trouvé dans vos parties récentes. Jouez une partie avec le code dans votre pseudo, puis confirmez.", "error", 6000);
      if (btn) { btn.disabled = false; btn.textContent = original; }
      return;
    }
    await saveUserProfile(_ownershipUsername, _ownershipPublicId);
  } catch (e) {
    console.error("[ownership] Confirmation failed:", e);
    showToast("Erreur lors de la vérification. Réessayez.", "error");
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
};

window.cancelOwnershipVerification = function () {
  _ownershipCode = null;
  _ownershipPublicId = null;
  _ownershipUsername = null;
  const s1 = document.getElementById("profile-setup-step1");
  const s2 = document.getElementById("profile-setup-step2");
  if (s1) s1.style.display = "block";
  if (s2) s2.style.display = "none";
};

async function saveUserProfile(username, publicId) {
  if (!currentUser) throw new Error("No authenticated user");
  try {
    const userDocRef = doc(db, "users", currentUser.uid);
    const existing = (await getDoc(userDocRef)).data() || {};
    await setDoc(userDocRef, {
      username,
      publicId,
      email: currentUser.email,
      verified: true,
      verifiedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      openFrontSyncPending: true,
    }, { merge: true });

    currentUser.name = username;
    currentUser.publicId = publicId;

    const modal = document.getElementById("profile-modal");
    if (modal) modal.classList.remove("active");
    window.cancelOwnershipVerification();
    updateAuthUI(currentUser);
    showToast("Profil vérifié et enregistré avec succès ! Redirection…", "success");
    setTimeout(() => { window.location.href = `profile.html?publicId=${encodeURIComponent(publicId)}&player=${encodeURIComponent(username)}`; }, 800);
  } catch (e) {
    console.error("[dashboard] Save profile error:", e);
    showToast("Erreur lors de la sauvegarde du profil.", "error");
    throw e;
  }
}

/* ════════════════════════════════════════════════════════════════
   Navigation cliquable des lignes du tableau (délégation)
   ════════════════════════════════════════════════════════════════ */

document.addEventListener("click", (e) => {
  const row = e.target.closest(".dash-row-link");
  if (row && row.dataset.href) {
    window.location.href = row.dataset.href;
  }
});

/* ════════════════════════════════════════════════════════════════
   Init
   ════════════════════════════════════════════════════════════════ */

(async function init() {
  try {
    // Phase 0 : Charger dashboard_scores.json.gz (pré-calculé par la sync)
    // → rendu INSTANTANÉ, pas d'appel API live
    let scoresLoaded = false;
    try {
      const res = await fetch("dashboard_scores.json.gz", { cache: "no-store" });
      if (res.ok) {
        const ds = new DecompressionStream("gzip");
        const decompressed = res.body.pipeThrough(ds);
        const scoresData = await new Response(decompressed).json();
        if (scoresData && scoresData.players && scoresData.players.length > 0) {
          console.log(`[dashboard] ⚡ Scores pré-calculés chargés: ${scoresData.players.length} joueurs (${scoresData.lastUpdate})`);

          // Remplir _liveStats avec les scores pré-calculés pour réutiliser buildMergedViews
          for (const p of scoresData.players) {
            _liveStats[p.publicId] = {
              username: p.username,
              global: {
                ffaCasualWins: p.ffa_casual || 0,
                ffaRankedWins: p.ffa_ranked || 0,
                teamCasualWins: p.team_casual || 0,
                teamRankedWins: p.team_ranked || 0,
              },
              weekly: { ffaCasualWins: p.weekly_ffa_casual || 0, ffaRankedWins: p.weekly_ffa_ranked || 0, teamCasualWins: p.weekly_team_casual || 0, teamRankedWins: p.weekly_team_ranked || 0 },
              elo: p.elo,
              peak_elo: p.peak_elo,
              fetchedAt: Date.now(),
            };
            // Semaine précédente (rang final) → flèches ↑/↓ du panel hebdo.
            // Clés IDENTIQUES à celles de pointsFor() (ffaCasualWins…) pour
            // pouvoir recalculer les points de la semaine passée avec le
            // même barème (et le même filtre FFA/Team).
            // Absente si le gzip n'a pas encore été régénéré par la sync
            // → map vide → pas de flèches (graceful, pas de bug).
            if (p.prev_weekly_ffa_casual != null || p.prev_weekly_team_casual != null) {
              _prevWeekly.set(p.publicId, {
                ffaCasualWins: p.prev_weekly_ffa_casual || 0,
                ffaRankedWins: p.prev_weekly_ffa_ranked || 0,
                teamCasualWins: p.prev_weekly_team_casual || 0,
                teamRankedWins: p.prev_weekly_team_ranked || 0,
              });
            }
          }

          // Load ranked.json for ELO display + ranked wins merge
          await loadRankedJson();
          _mergedViews = buildMergedViews();
          mergeAndRender();
          scoresLoaded = true;
          _liveFetchDone = true;
          _liveFetchProgress = 1; // prevent progress bar
        }
      }
    } catch (e) {
      console.warn("[dashboard] dashboard_scores.json.gz non disponible, fallback live:", e.message);
    }

    if (scoresLoaded) {
      console.log("[dashboard] ✅ Rendu instantané depuis scores pré-calculés");
      // Skins VIP en arrière-plan : re-render quand ils arrivent (non bloquant)
      loadVipSkins().then(() => { if (_vipSkins.size > 0) mergeAndRender(); }).catch(() => {});
      return;
    }

    // Fallback : ancien système (ranked.json + live API)
    // Phase 1 : Charger ranked.json → rendu immédiat avec données classées
    await loadRankedJson();
    _mergedViews = buildMergedViews();
    render();
    // Skins VIP en arrière-plan même en mode fallback
    loadVipSkins().then(() => { if (_vipSkins.size > 0) mergeAndRender(); }).catch(() => {});

    // Phase 2 : Charger la liste des joueurs connectés (Firebase)
    await loadConnectedPlayers();

    // Phase 3 : Charger les stats live pour chaque joueur connecté
    if (_connectedPlayers.length > 0) {
      loadLiveStats().then(() => {
        mergeAndRender();
        console.log("[dashboard] Stats live chargées");
      }).catch((e) => {
        console.warn("[dashboard] loadLiveStats error:", e.message);
      });
    } else {
      _liveFetchDone = true;
    }
  } catch (e) {
    console.error("[dashboard] init failed:", e);
    view.innerHTML = `<div class="dash-empty-state"><div class="dash-empty-icon"><i data-icon="warning"></i></div><h3>Erreur</h3><p>${escapeHtml(e.message || "Chargement impossible.")}</p></div>`;
    if (window.hydrateIcons) window.hydrateIcons(view);
  }
})();
