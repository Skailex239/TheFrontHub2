/**
 * OpenFront client-side helpers.
 *
 * Architecture v2 (stats agrégées côté serveur OpenFront) :
 *
 *   1. ranked.json  → static, served from /public (auto-synced offline by
 *      GitHub Actions). Contains career ranked wins for the top 100 1v1
 *      and top 100 2v2 players. Used for ranked-only players (non connectés).
 *
 *   2. Firebase public-aliases (Firestore REST API) → list of players
 *      who linked their OpenFront Public ID via Google/Discord login.
 *
 *   3. OpenFront API → pour chaque joueur connecté, DEUX appels :
 *
 *        a) GET /api/openfront/public/player/<pid>  →  objet `stats` AGRÉGÉ
 *           côté serveur OpenFront. Contient les wins carrière par
 *           mode/difficulté/ranked. 1 requête = toutes les wins all-time.
 *           Marche même pour un joueur à 3000+ games (plus de pagination !).
 *
 *        b) GET /api/openfront/public/player/<pid>/games  →  pagination
 *           COURTE qui s'arrête au 1er game de plus de 7 jours. 2-5 pages
 *           pour un joueur actif (vs 300 si on paginait tout). Sert uniquement
 *           au calcul hebdo.
 *
 *      Le proxy Next.js ajoute le header `x-skailex-access` côté serveur
 *      (exemption de rate-limit). Avec ~3-6 requêtes par joueur (au lieu de
 *      300+), le dashboard charge en quelques secondes.
 *
 * Scoring (per Task 26 spec):
 *   FFA casual  = +10 · FFA ranked (1v1)  = +1
 *   Team casual = +5  · Team ranked (2v2) = +1
 *   (ranked = 1 pt, NOT in addition to FFA/Team)
 *
 * All functions here are browser-safe (fetch, localStorage, Date).
 */

/* ════════════════════════════════════════════════════════════════
   Types
   ════════════════════════════════════════════════════════════════ */

export type GameCategory = "ffaCasual" | "ffaRanked" | "teamCasual" | "teamRanked";

export interface Wins {
  ffaCasual: number;
  ffaRanked: number;
  teamCasual: number;
  teamRanked: number;
}

export interface OpenFrontGame {
  gameId: string;
  start: string; // ISO 8601
  durationSeconds?: number;
  duration?: number;
  map?: string;
  mode?: string; // "Free For All" | "Team" | ...
  type?: string;
  playerTeams?: number | null;
  rankedType?: string; // "1v1" | "2v2" | "unranked" | ...
  result?: string; // "victory" | "defeat" | "incomplete" | ...
  totalPlayers?: number;
  username?: string;
  clanTag?: string | null;
}

export interface RankedPlayerEntry {
  rank: number;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  total: number;
  public_id: string;
  accountUsername: string | null;
  username: string;
  streak: number;
  movement: number;
}

export interface RankedJson {
  "1v1": RankedPlayerEntry[];
  "2v2": RankedPlayerEntry[];
  updatedAt?: string;
}

export interface ConnectedPlayer {
  publicId: string;
  username: string;
}

/** Réponse de GET /public/player/{id} — objet stats agrégé côté serveur. */
export interface PlayerProfile {
  publicId: string;
  username?: string;
  createdAt?: string;
  stats?: PlayerStatsAggregate;
}

/**
 * Structure de l'objet `stats` renvoyé par /public/player/{id}.
 * Vérifiée empiriquement : les wins sont des string (pas number) côté API.
 */
export interface PlayerStatsAggregate {
  Public?: Record<string, Record<string, ModeDiffStats>>;
  Private?: Record<string, Record<string, ModeDiffStats>>;
  Singleplayer?: Record<string, Record<string, ModeDiffStats>>;
  Ranked?: {
    "1v1"?: ModeDiffStats;
    "2v2"?: ModeDiffStats;
  };
  recent?: Record<string, unknown>;
}

export interface ModeDiffStats {
  wins?: string | number;
  losses?: string | number;
  total?: string | number;
  stats?: Record<string, unknown>;
}

export interface LiveStats {
  publicId: string;
  username: string;
  gamesCount: number;
  global: Wins;
  weekly: Wins;
  fetchedAt: number;
}

export interface MergedPlayer {
  publicId: string;
  username: string;
  clan: string | null;
  ffaCasualWins: number;
  ffaRankedWins: number;
  teamCasualWins: number;
  teamRankedWins: number;
  hasLive: boolean;
  gamesCount: number;
}

/* ════════════════════════════════════════════════════════════════
   Constants
   ════════════════════════════════════════════════════════════════ */

export const PTS_FFA_CASUAL = 10;
export const PTS_FFA_RANKED = 1;
export const PTS_TEAM_CASUAL = 5;
export const PTS_TEAM_RANKED = 1;

// Cache key v3 : invalidé par rapport à v2 car les wins carrière viennent
// maintenant de l'endpoint agrégé (plus précis que l'ancienne pagination).
const LIVE_CACHE_KEY = "dash_live_stats_v3";
const LIVE_CACHE_TTL = 30 * 60 * 1000; // 30 min
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
// Nombre max de pages de games à fetcher pour le calcul hebdo. Chaque page
// = ~10 games. 50 pages = 500 games = largement plus qu'une semaine d'activité
// même pour un joueur très actif. On s'arrête en plus dès le 1er game > 7 jours.
const MAX_WEEKLY_PAGES = 50;
const FIREBASE_PROJECT = "openfront-speedrun";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

/* ════════════════════════════════════════════════════════════════
   Week helpers (Europe/Paris, ISO week starting Monday)
   ════════════════════════════════════════════════════════════════ */

/**
 * Returns the start of the current week (Monday 00:00) in Europe/Paris
 * as a UTC timestamp (ms since epoch).
 *
 * Strategy: format "now" into Europe/Paris, take the weekday, subtract
 * (weekday - 1) days, build Monday 00:00 Europe/Paris, then convert back
 * to a UTC ms timestamp. This avoids relying on a timezone DB.
 */
export function getWeekStartMs(now: number = Date.now()): number {
  // Format current time in Europe/Paris → "Mon, 11 Aug 2026 14:30:05"
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdayStr = get("weekday"); // "Mon", "Tue", ...
  const day = parseInt(get("day"), 10);
  const month = get("month"); // "Jan", "Feb", ...
  const year = parseInt(get("year"), 10);
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const second = parseInt(get("second"), 10);

  const weekdayMap: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };
  const weekdayOffset = weekdayMap[weekdayStr] ?? 0;
  const monthMap: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const monthIdx = monthMap[month] ?? 0;

  // Build Monday 00:00:00 in Europe/Paris as a UTC timestamp.
  // We trick Intl with a fake "UTC" date, then ask for the Europe/Paris
  // interpretation, and offset by the timezone difference.
  const mondayDay = day - weekdayOffset;
  // Construct a UTC date for Monday 00:00 (we'll correct for Paris offset).
  const utcGuess = Date.UTC(year, monthIdx, mondayDay, 0, 0, 0);
  // Compute Paris offset (in ms) at that instant.
  const parisFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parisParts = parisFmt.formatToParts(new Date(utcGuess));
  const parisHour = parseInt(parisParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const parisMin = parseInt(parisParts.find((p) => p.type === "minute")?.value ?? "0", 10);
  // Paris local minutes since midnight.
  const parisLocalMin = parisHour * 60 + parisMin;
  // Offset (ms): Paris is ahead of UTC, so to get back to UTC, subtract.
  const offsetMs = (parisLocalMin - 0) * 60 * 1000;
  // Wait — we want "Monday 00:00 Paris" as a UTC ms. The utcGuess above
  // is "Monday 00:00 UTC", but in Paris that's "Monday 02:00" (CEST).
  // To get "Monday 00:00 Paris", we subtract 2 hours.
  // General formula: mondayParisMs = utcGuess - offsetMs (when offset positive).
  void hour; void minute; void second;
  return utcGuess - offsetMs;
}

/** Format a UTC ms timestamp as a French date in Europe/Paris. */
export function formatFrenchDate(ms: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ms));
}

/** Format a UTC ms timestamp with day + month only (French). */
export function formatShortFrenchDate(ms: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(ms));
}

/* ════════════════════════════════════════════════════════════════
   Fetch helpers
   ════════════════════════════════════════════════════════════════ */

/** Fetch ranked.json (static, served from /public). */
export async function fetchRankedJson(): Promise<RankedJson | null> {
  try {
    const res = await fetch("/ranked.json", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as RankedJson;
  } catch (e) {
    console.warn("[openfront] ranked.json indisponible:", (e as Error).message);
    return null;
  }
}

/** Fetch the list of connected players from Firebase public-aliases. */
export async function fetchConnectedPlayers(): Promise<ConnectedPlayer[]> {
  try {
    const res = await fetch(`${FIRESTORE_BASE}/public-aliases`, { cache: "no-store" });
    if (!res.ok) {
      console.warn(`[openfront] Firebase public-aliases: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const docs: Array<{ fields?: Record<string, unknown> }> = data.documents || [];
    const seen = new Set<string>();
    const list: ConnectedPlayer[] = [];
    for (const doc of docs) {
      const fields = doc.fields || {};
      const val = (f: unknown): string => {
        if (!f || typeof f !== "object") return "";
        const obj = f as Record<string, unknown>;
        return (obj.stringValue as string) || (obj.integerValue as string) || "";
      };
      const publicId = val(fields.publicId);
      if (!/^[A-Za-z0-9]{8}$/.test(publicId)) continue;
      if (seen.has(publicId)) continue;
      seen.add(publicId);
      list.push({
        publicId,
        username: val(fields.username) || publicId,
      });
    }
    return list;
  } catch (e) {
    console.warn("[openfront] Firebase indisponible:", (e as Error).message);
    return [];
  }
}

/** Fetch with timeout. */
async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Paginate ALL games of a player via the Next.js proxy.
 * Stops early when `shouldStop(game)` returns true (used for weekly cutoff).
 * Returns the full list of games.
 *
 * @deprecated Ne plus utiliser pour le dashboard — préférer fetchPlayerStats
 *   qui utilise l'endpoint agrégé /public/player/{id} (1 requête au lieu de
 *   300). Conservé pour la page profil qui a besoin de l'historique complet.
 */
export async function fetchAllPlayerGames(
  publicId: string,
  shouldStop?: (game: OpenFrontGame) => boolean,
  onProgress?: (count: number) => void,
): Promise<OpenFrontGame[]> {
  const all: OpenFrontGame[] = [];
  let cursor: string | null = null;
  // Hard cap 500 pages = 5000 games (sécurité, ne devrait jamais être atteint
  // car shouldStop coupe bien avant pour le calcul hebdo).
  for (let page = 0; page < 500; page++) {
    let path = `/api/openfront/public/player/${encodeURIComponent(publicId)}/games`;
    if (cursor) path += `?cursor=${encodeURIComponent(cursor)}`;
    let data: { results?: OpenFrontGame[]; nextCursor?: string | null };
    try {
      const res = await fetchWithTimeout(path, 8000);
      if (!res.ok) {
        console.warn(`[openfront] fetch games ${publicId} page ${page}: HTTP ${res.status}`);
        break;
      }
      data = await res.json();
    } catch (e) {
      console.warn(`[openfront] fetch games ${publicId} page ${page}:`, (e as Error).message);
      break;
    }
    const results = data?.results || [];
    if (results.length === 0) break;
    let stop = false;
    for (const g of results) {
      if (shouldStop && shouldStop(g)) {
        stop = true;
        break;
      }
      all.push(g);
    }
    onProgress?.(all.length);
    if (stop) break;
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return all;
}

/* ════════════════════════════════════════════════════════════════
   V2 : stats agrégées côté serveur OpenFront
   ════════════════════════════════════════════════════════════════ */

/**
 * Extrait les wins carrière (all-time) depuis l'objet `stats` agrégé
 * renvoyé par GET /public/player/{id}. L'API OpenFront maintient ces
 * totaux côté serveur → 1 seule requête par joueur, pas de pagination.
 *
 * Mapping vers nos 4 catégories :
 *   ffaCasual   = Σ stats[Public|Private|Singleplayer]["Free For All"][*].wins
 *                 + Σ stats[*]["Humans Vs Nations"][*].wins
 *   teamCasual  = Σ stats[Public|Private]["Team"][*].wins
 *   ffaRanked   = stats.Ranked["1v1"].wins
 *   teamRanked  = stats.Ranked["2v2"].wins
 */
export function extractCareerWinsFromStats(stats?: PlayerStatsAggregate | null): Wins {
  const global: Wins = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  if (!stats || typeof stats !== "object") return global;

  const CASUAL_VIS = ["Public", "Private", "Singleplayer"] as const;
  const FFA_MODES = ["Free For All", "Humans Vs Nations"];
  for (const vis of CASUAL_VIS) {
    const visData = stats[vis];
    if (!visData) continue;
    for (const mode of FFA_MODES) {
      const modeData = visData[mode];
      if (!modeData) continue;
      for (const diff of Object.keys(modeData)) {
        const d = modeData[diff];
        if (d?.wins != null) global.ffaCasual += Number(d.wins) || 0;
      }
    }
    const teamData = visData["Team"];
    if (teamData) {
      for (const diff of Object.keys(teamData)) {
        const d = teamData[diff];
        if (d?.wins != null) global.teamCasual += Number(d.wins) || 0;
      }
    }
  }

  const r1 = stats.Ranked?.["1v1"];
  if (r1?.wins != null) global.ffaRanked = Number(r1.wins) || 0;
  const r2 = stats.Ranked?.["2v2"];
  if (r2?.wins != null) global.teamRanked = Number(r2.wins) || 0;

  return global;
}

/** GET /public/player/{id} → profil + stats agrégées carrière. 1 requête. */
export async function fetchPlayerProfile(publicId: string): Promise<PlayerProfile | null> {
  try {
    const path = `/api/openfront/public/player/${encodeURIComponent(publicId)}`;
    const res = await fetchWithTimeout(path, 8000);
    if (!res.ok) {
      console.warn(`[openfront] profile ${publicId}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as PlayerProfile;
  } catch (e) {
    console.warn(`[openfront] profile ${publicId}:`, (e as Error).message);
    return null;
  }
}

/**
 * Pagine les parties récentes d'un joueur en S'ARRÊTANT dès qu'on croise
 * une game plus vieille que 7 jours (WEEKLY_MS). Typiquement 2-5 pages.
 * Retourne uniquement les games des 7 derniers jours.
 */
export async function fetchWeeklyGames(publicId: string): Promise<OpenFrontGame[]> {
  const weeklyGames: OpenFrontGame[] = [];
  const weekStartMs = Date.now() - WEEKLY_MS;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_WEEKLY_PAGES; page++) {
    let path = `/api/openfront/public/player/${encodeURIComponent(publicId)}/games`;
    if (cursor) path += `?cursor=${encodeURIComponent(cursor)}`;
    let data: { results?: OpenFrontGame[]; nextCursor?: string | null };
    try {
      const res = await fetchWithTimeout(path, 8000);
      if (!res.ok) break;
      data = await res.json();
    } catch (e) {
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
 *      → wins hebdo (2-5 req, stop au 1er game trop vieux)
 *
 * Total : ~3-6 requêtes par joueur (vs 300+ auparavant pour un gros joueur).
 * Pour un joueur à 3000 games, les wins carrière sont EXACTES car l'API
 * les maintient côté serveur — le site n'a plus besoin de tout télécharger.
 */
export async function fetchPlayerStats(player: ConnectedPlayer): Promise<LiveStats> {
  const profile = await fetchPlayerProfile(player.publicId);
  const global = extractCareerWinsFromStats(profile?.stats);
  const username = profile?.username || player.username;

  const weeklyGames = await fetchWeeklyGames(player.publicId);
  const weekly = computeWinsFromGames(weeklyGames, Date.now() - WEEKLY_MS, Date.now()).global;

  return {
    publicId: player.publicId,
    username,
    gamesCount: weeklyGames.length,
    global,
    weekly,
    fetchedAt: Date.now(),
  };
}

/* ════════════════════════════════════════════════════════════════
   Game classification + win computation
   ════════════════════════════════════════════════════════════════ */

/** Classify a game into one of the 4 categories. */
export function classifyGame(g: OpenFrontGame): GameCategory {
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

/** Compute wins (global + weekly) from a list of games. */
export function computeWinsFromGames(
  games: OpenFrontGame[],
  weekStartMs: number,
  now: number = Date.now(),
): { global: Wins; weekly: Wins } {
  const global: Wins = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const weekly: Wins = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const weekEnd = now; // current time = end of "this week"
  for (const g of games) {
    if (g.result !== "victory") continue;
    const cat = classifyGame(g);
    global[cat]++;
    if (g.start) {
      const t = new Date(g.start).getTime();
      if (t >= weekStartMs && t <= weekEnd) {
        weekly[cat]++;
      }
    }
  }
  return { global, weekly };
}

/** Points for a player given their win breakdown. Accepts either
 *  Wins ({ffaCasual, ffaRanked, teamCasual, teamRanked}) or
 *  MergedPlayer ({ffaCasualWins, ffaRankedWins, teamCasualWins, teamRankedWins}). */
export function pointsFor(
  w:
    | Partial<Wins>
    | Partial<MergedPlayer>
    | Record<string, number | undefined>,
): number {
  const ffaCasual = (w as Partial<Wins>).ffaCasual ?? (w as Partial<MergedPlayer>).ffaCasualWins ?? 0;
  const ffaRanked = (w as Partial<Wins>).ffaRanked ?? (w as Partial<MergedPlayer>).ffaRankedWins ?? 0;
  const teamCasual = (w as Partial<Wins>).teamCasual ?? (w as Partial<MergedPlayer>).teamCasualWins ?? 0;
  const teamRanked = (w as Partial<Wins>).teamRanked ?? (w as Partial<MergedPlayer>).teamRankedWins ?? 0;
  return (
    ffaCasual * PTS_FFA_CASUAL +
    ffaRanked * PTS_FFA_RANKED +
    teamCasual * PTS_TEAM_CASUAL +
    teamRanked * PTS_TEAM_RANKED
  );
}

/** Total wins across all categories. Accepts either Wins or MergedPlayer. */
export function totalWins(
  w:
    | Partial<Wins>
    | Partial<MergedPlayer>
    | Record<string, number | undefined>,
): number {
  const ffaCasual = (w as Partial<Wins>).ffaCasual ?? (w as Partial<MergedPlayer>).ffaCasualWins ?? 0;
  const ffaRanked = (w as Partial<Wins>).ffaRanked ?? (w as Partial<MergedPlayer>).ffaRankedWins ?? 0;
  const teamCasual = (w as Partial<Wins>).teamCasual ?? (w as Partial<MergedPlayer>).teamCasualWins ?? 0;
  const teamRanked = (w as Partial<Wins>).teamRanked ?? (w as Partial<MergedPlayer>).teamRankedWins ?? 0;
  return ffaCasual + ffaRanked + teamCasual + teamRanked;
}

/* ════════════════════════════════════════════════════════════════
   Cache (localStorage)
   ════════════════════════════════════════════════════════════════ */

type LiveCache = Record<string, LiveStats>;

export function loadLiveCache(): LiveCache {
  try {
    const raw = localStorage.getItem(LIVE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as LiveCache;
  } catch {
    /* ignore */
  }
  return {};
}

export function saveLiveCache(cache: LiveCache): void {
  try {
    localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota exceeded — ignore */
  }
}

export function isCacheFresh(entry: LiveStats, now: number = Date.now()): boolean {
  return now - entry.fetchedAt < LIVE_CACHE_TTL;
}

/* ════════════════════════════════════════════════════════════════
   Merge: ranked.json + live stats → MergedPlayer list
   ════════════════════════════════════════════════════════════════ */

/**
 * Merge ranked.json (career ranked wins) + live stats (casual wins).
 * Returns two lists: globalView and weeklyView.
 *
 * Global view:
 *   - ranked.json players: ffaRanked/teamRanked from career, casual = 0
 *   - connected players: ffaRanked/teamRanked = max(ranked.json, API live),
 *     casual = API live
 *
 * Weekly view:
 *   - Only connected players (live API gives weekly breakdown).
 *   - ranked.json has no weekly breakdown.
 */
export function buildMergedPlayers(
  rankedData: RankedJson | null,
  liveStats: Record<string, LiveStats>,
): { global: MergedPlayer[]; weekly: MergedPlayer[] } {
  const byPid = new Map<string, MergedPlayer>();
  const getOrCreate = (pid: string, name?: string): MergedPlayer => {
    let e = byPid.get(pid);
    if (!e) {
      e = {
        publicId: pid,
        username: name || pid,
        clan: null,
        ffaCasualWins: 0,
        ffaRankedWins: 0,
        teamCasualWins: 0,
        teamRankedWins: 0,
        hasLive: false,
        gamesCount: 0,
      };
      byPid.set(pid, e);
    }
    return e;
  };

  // 1. ranked.json → career ranked wins (global only)
  if (rankedData) {
    for (const p of rankedData["1v1"] || []) {
      const nm = p.username || p.accountUsername || p.public_id;
      const e = getOrCreate(p.public_id, nm);
      e.ffaRankedWins = p.wins || 0;
      if (nm && nm !== p.public_id) e.username = nm;
    }
    for (const p of rankedData["2v2"] || []) {
      const nm = p.username || p.accountUsername || p.public_id;
      const e = getOrCreate(p.public_id, nm);
      e.teamRankedWins = p.wins || 0;
      if (nm && nm !== p.public_id) e.username = nm;
    }
  }

  // 2. Live stats → casual wins + (weekly) ranked wins
  for (const [pid, live] of Object.entries(liveStats)) {
    const e = getOrCreate(pid, live.username);
    // Global: take max(ranked.json, API live) for ranked, API live for casual
    e.ffaCasualWins = live.global.ffaCasual;
    e.teamCasualWins = live.global.teamCasual;
    e.ffaRankedWins = Math.max(e.ffaRankedWins, live.global.ffaRanked);
    e.teamRankedWins = Math.max(e.teamRankedWins, live.global.teamRanked);
    e.hasLive = true;
    e.gamesCount = live.gamesCount;
    if (live.username && live.username !== pid) e.username = live.username;
  }

  // Build the two views
  const all = [...byPid.values()];
  const globalView: MergedPlayer[] = all
    .map((p) => ({ ...p, points: pointsFor(p) }))
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));

  // Weekly view: only players with live stats (no ranked.json weekly breakdown)
  const weeklyView: MergedPlayer[] = all
    .filter((p) => p.hasLive)
    .map((p) => {
      const live = liveStats[p.publicId];
      const weeklyWins: Wins = live?.weekly ?? {
        ffaCasual: 0,
        ffaRanked: 0,
        teamCasual: 0,
        teamRanked: 0,
      };
      return {
        ...p,
        ffaCasualWins: weeklyWins.ffaCasual,
        ffaRankedWins: weeklyWins.ffaRanked,
        teamCasualWins: weeklyWins.teamCasual,
        teamRankedWins: weeklyWins.teamRanked,
        points: pointsFor(weeklyWins),
      };
    })
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));

  return { global: globalView, weekly: weeklyView };
}

/* ════════════════════════════════════════════════════════════════
   Format helpers
   ════════════════════════════════════════════════════════════════ */

const frFormatter = new Intl.NumberFormat("fr-FR");

export function formatPoints(n: number): string {
  return frFormatter.format(n || 0);
}
