// sync-teams.js — Team speedrun sync (Duos, Trios, Quads, Team Custom, HvN)
// Same accumulation logic as sync.js: loads existing runs, adds new ones, saves back.
// Scans last 2h each run, accumulates over time.
//
// BUG FIXED (2026-08-20): OpenFront API now returns playerTeams as BOTH:
//   - "Duos", "Trios", "Quads" (text, old games)
//   - "2", "3", "4" (numeric, new games — same meaning)
//   - "5", "6", "7" (numeric, custom team sizes)
//   - "Humans Vs Nations" (special mode)
// Previously we only fetched the text format → missed ~76% of Team games.
// Now we fetch ALL Team games with one request (Option B — clean sync) and
// classify them in extractTeamRun based on playerTeams value.
//
// Usage: node sync-teams.js
// Files: teams_runs.json (full accumulated), teams_seen.json (de-dupe),
//        teams_checkpoint.json (last_sync_time), teams_public.json.gz (payload)

import fs from "fs";
import zlib from "zlib";
import {
  API_BASE,
  openFrontFetch,
  hasExemption,
} from "./openfront-api.js";

// ── Mode definitions ──────────────────────────────────────────────────────
// Each mode maps to a key in teams_runs.json and to a set of playerTeams values.
// We accept BOTH the text format (legacy) and the numeric format (new).
const MODES = {
  duos:        { name: "Duos",              playerTeamsValues: ["Duos", "2"] },
  trios:       { name: "Trios",            playerTeamsValues: ["Trios", "3"] },
  quads:       { name: "Quads",            playerTeamsValues: ["Quads", "4"] },
  team_custom: { name: "Team Custom",      playerTeamsValues: ["5", "6", "7"] },
  hvn:         { name: "Humans Vs Nations", playerTeamsValues: ["Humans Vs Nations"] },
};
const MODE_KEYS = Object.keys(MODES); // ["duos", "trios", "quads", "team_custom", "hvn"]

// Reverse map: API playerTeams value → mode key
const PLAYER_TEAMS_TO_MODE = {};
for (const [modeKey, def] of Object.entries(MODES)) {
  for (const v of def.playerTeamsValues) {
    PLAYER_TEAMS_TO_MODE[v] = modeKey;
  }
}

// ── Constants ──
const RECENT_MAX_MS = 2 * 60 * 60 * 1000;  // 2 hours
const RECENT_OVERLAP_MS = 10 * 60 * 1000;   // 10 min overlap
const WINDOW_MS = 30 * 1000;                 // 30s windows
const WINDOW_DELAY = 0;                       // no delay (with exemption)
const FETCH_TIMEOUT = 8000;
const DETAIL_CONCURRENCY = 24;  // ⚡ BOOSTED from 12 to 24 (parallel game detail fetches)
const WINDOW_CONCURRENCY = 16;  // ⚡ NEW: 16 windows in parallel (was 1 = serial)
const TIME_OFFSET_SECS = 32;
const MIN_HUMANS = 10;
const TOP_PER_MAP = 25; // for public payload only
const TARGET_DATE = new Date("2025-11-01").getTime(); // backfill jusqu'à nov 2025
const DEFAULT_HISTORY_WINDOWS = 10000; // fenêtres par cycle de backfill

// ── File paths ──
const RUNS_FILE = "teams_runs.json";        // { duos, trios, quads, team_custom, hvn }
const SEEN_FILE = "teams_seen.json";        // ["gameId1", "gameId2", ...]
const CHECKPOINT_FILE = "teams_checkpoint.json";

// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function emptyRuns() {
  const r = {};
  for (const k of MODE_KEYS) r[k] = [];
  return r;
}

function loadRuns() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
    // Migrate: ensure all mode keys exist (in case of upgrade from old version)
    const result = emptyRuns();
    if (raw && typeof raw === "object") {
      for (const k of MODE_KEYS) {
        if (Array.isArray(raw[k])) result[k] = raw[k];
      }
    }
    return result;
  } catch { return emptyRuns(); }
}

function saveRuns(runs) {
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
  fs.writeFileSync(RUNS_FILE + ".gz", zlib.gzipSync(JSON.stringify(runs)));
}

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); }
  catch { return new Set(); }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
}

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8")); }
  catch { return { last_sync_time: "0" }; }
}

function saveCheckpoint(cp) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await openFrontFetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const wait = 2000 * (attempt + 1);
        console.log(`[teams] 429 — attente ${wait}ms (tentative ${attempt + 1}/${retries})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      console.warn(`[teams] fetch failed: ${url}: ${e.message}`);
      return null;
    }
  }
  return null;
}

function buildWindows30s(rangeStart, rangeEnd) {
  const windows = [];
  for (let end = rangeEnd.getTime(); end > rangeStart.getTime(); end -= WINDOW_MS) {
    const start = Math.max(end - WINDOW_MS, rangeStart.getTime());
    windows.push({ start: new Date(start), end: new Date(end) });
  }
  return windows;
}

// ── Game filtering ──
function hasModifiers(config) {
  const mods = config.publicGameModifiers || {};
  if (mods.isCompact || mods.isRandomSpawn || mods.isCrowded ||
      mods.isHardNations || mods.isAlliancesDisabled || mods.isPortsDisabled ||
      mods.isNukesDisabled || mods.isSAMsDisabled || mods.isPeaceTime ||
      mods.isWaterNukes || mods.isDoomsdayClock) return true;
  if (config.randomSpawn === true) return true;
  if (config.infiniteGold || config.infiniteTroops || config.instantBuild) return true;
  if (config.startingGold != null && config.startingGold !== 0) return true;
  if (config.goldMultiplier != null && config.goldMultiplier !== 1) return true;
  return false;
}

/**
 * Determine which mode a game belongs to based on config.playerTeams.
 * Returns null if the game doesn't match any known mode.
 */
function classifyGameMode(config) {
  const pt = config.playerTeams;
  if (pt == null) return null;
  return PLAYER_TEAMS_TO_MODE[pt] || null;
}

function extractTeamRun(raw) {
  const info = raw?.info;
  if (!info) return null;
  const config = info.config || {};

  if (config.gameType !== "Public") return null;
  if (config.gameMode !== "Team") return null;
  if (config.gameMapSize !== "Normal") return null;
  if (config.bots !== 400) return null;
  if (hasModifiers(config)) return null;

  // Classify mode from playerTeams (accepts both text and numeric format)
  const modeKey = classifyGameMode(config);
  if (!modeKey) return null;

  const players = info.players || [];
  const humanPlayers = players.filter(p => !p.isBot);
  if (humanPlayers.length < MIN_HUMANS) return null;

  const winner = info.winner;
  if (!Array.isArray(winner) || winner.length < 3 || winner[0] !== "team") return null;

  const winnerIds = winner.slice(2);
  const winnerPlayers = players.filter(p => winnerIds.includes(p.clientID) && p.username && !p.isBot);
  if (winnerPlayers.length === 0) return null;

  let durationSecs = info.duration;
  if (!durationSecs || durationSecs < 60) return null;
  durationSecs = Math.max(0, durationSecs - TIME_OFFSET_SECS);

  const gameId = info.gameID || info.gameId || info.id;

  return {
    id: gameId,
    mode: modeKey,  // ← new field so we know which mode this run belongs to
    team: winner[1],
    players: winnerPlayers.map(p => ({ username: p.username, clientID: p.clientID, clanTag: p.clanTag || null })),
    map: config.gameMap || "Unknown",
    duration_s: durationSecs,
    difficulty: config.difficulty || "Medium",
    bots: 400,
    numPlayers: humanPlayers.length,
    playerTeams: config.playerTeams,  // keep raw value for debugging
    timestamp: info.start ? new Date(info.start > 1e10 ? info.start : info.start * 1000).toISOString() : new Date().toISOString(),
    url: `https://openfront.io/game/${gameId}`,
  };
}

// ── Sync recent (last 2h, accumulate) ──
// Strategy: 2 requests per 30s window
//   - Request 1: mode=Team (no playerTeams filter) → fetches up to 1000 games
//   - Request 2: if request 1 hit the 1000-limit (Content-Range indicates more),
//                fetch with offset=1000 to get remaining games
// This avoids missing games on busy periods where a single 30s window has >1000 Team games.
async function syncRecent() {
  console.log(`[teams] 🔄 Sync récente — ${new Date().toISOString()}`);
  const seen = loadSeen();
  const runs = loadRuns();
  const cp = loadCheckpoint();

  const now = new Date();
  const lastSync = cp.last_sync_time ? parseInt(cp.last_sync_time, 10) : 0;
  const agoMs = now.getTime() - RECENT_MAX_MS; // TOUJOURS 2h
  const ago = new Date(agoMs);

  const windows = buildWindows30s(ago, now);
  console.log(`[teams] ${windows.length} fenêtres de 30s (~${Math.round((now - ago) / 60000)} min, max 2h, filtre Public Team ≥10p)`);
  console.log(`[teams] 2 requêtes max par fenêtre (1 normale + 1 avec offset si >1000 games)`);

  let totalNew = 0;
  let totalApiCalls = 0;
  const newRunsByMode = emptyRuns();
  const gameIdsToFetch = []; // { gameId, playerTeams }

  // ⚡ Phase 1: fetch game lists in PARALLEL batches of WINDOW_CONCURRENCY (was serial)
  for (let i = 0; i < windows.length; i += WINDOW_CONCURRENCY) {
    const batch = windows.slice(i, i + WINDOW_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async ({ start, end }) => {
      let apiCalls = 0;
      // Request 1: regular
      const url1 = `${API_BASE}/public/games?start=${start.toISOString()}&end=${end.toISOString()}&type=Public&mode=Team&limit=1000`;
      const data1 = await fetchWithRetry(url1);
      apiCalls++;
      let games1 = [];
      if (data1) {
        games1 = Array.isArray(data1) ? data1 : (data1.games || []);
      }

      // Request 2: only if request 1 returned 1000 games (might be truncated)
      let games2 = [];
      if (games1.length === 1000) {
        const url2 = `${API_BASE}/public/games?start=${start.toISOString()}&end=${end.toISOString()}&type=Public&mode=Team&limit=1000&offset=1000`;
        const data2 = await fetchWithRetry(url2);
        apiCalls++;
        if (data2) {
          games2 = Array.isArray(data2) ? data2 : (data2.games || []);
        }
      }

      const allGames = [...games1, ...games2];
      const candidates = [];
      for (const g of allGames) {
        if (g.type !== "Public") continue;
        if ((g.numPlayers || 0) < MIN_HUMANS) continue;
        const gameId = g.game || g.gameId;
        if (!gameId || seen.has(gameId)) continue;
        candidates.push({ gameId, playerTeams: g.playerTeams });
      }
      return { candidates, apiCalls };
    }));

    for (const { candidates, apiCalls } of batchResults) {
      gameIdsToFetch.push(...candidates);
      totalApiCalls += apiCalls;
    }
  }

  console.log(`[teams] ⚡ Phase 1 terminée — ${gameIdsToFetch.length} games candidates (${totalApiCalls} appels API, ${windows.length} fenêtres en ${Math.ceil(windows.length / WINDOW_CONCURRENCY)} batches parallèles)`);

  // Phase 2: fetch game details in parallel chunks
  const chunks = [];
  for (let i = 0; i < gameIdsToFetch.length; i += DETAIL_CONCURRENCY) {
    chunks.push(gameIdsToFetch.slice(i, i + DETAIL_CONCURRENCY));
  }

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async ({ gameId, playerTeams }) => {
      seen.add(gameId);
      try {
        const raw = await fetchWithRetry(`${API_BASE}/public/game/${encodeURIComponent(gameId)}?turns=false`);
        const run = extractTeamRun(raw);
        if (run) {
          // run.mode is set by extractTeamRun based on config.playerTeams
          if (newRunsByMode[run.mode]) {
            newRunsByMode[run.mode].push(run);
            totalNew++;
          }
        }
      } catch (e) {
        console.warn(`[teams] game ${gameId} (pt=${playerTeams}): ${e.message}`);
      }
    }));
  }

  // Phase 3: merge new runs into existing
  for (const modeKey of MODE_KEYS) {
    if (newRunsByMode[modeKey].length > 0) {
      // Deduplicate by run ID (in case of overlap)
      const existingIds = new Set(runs[modeKey].map(r => r.id));
      const newOnes = newRunsByMode[modeKey].filter(r => !existingIds.has(r.id));
      runs[modeKey] = [...runs[modeKey], ...newOnes];
      console.log(`[teams] ${MODES[modeKey].name}: +${newOnes.length} nouveaux runs (total: ${runs[modeKey].length})`);
    }
  }

  // Save if new runs found
  if (totalNew > 0) {
    saveRuns(runs);
    console.log(`[teams] 💾 ${totalNew} nouveaux runs sauvegardés`);
  } else {
    console.log(`[teams] ✅ Aucun nouveau run`);
  }
  saveSeen(seen);

  cp.last_sync_time = String(Date.now());
  saveCheckpoint(cp);

  console.log(`[teams] ✅ Sync récente terminée — ${totalNew} nouveaux runs (${totalApiCalls} appels API)`);

  // Generate public payload
  generatePublicPayload(runs);

  return totalNew;
}

// ── Generate public payload (top 25/map, compact format) ──
function generatePublicPayload(runs) {
  const payload = {
    u: new Date().toISOString(),
  };
  for (const k of MODE_KEYS) payload[k] = {};

  for (const key of MODE_KEYS) {
    // Group by map
    const byMap = {};
    for (const r of runs[key]) {
      if (!byMap[r.map]) byMap[r.map] = [];
      byMap[r.map].push(r);
    }
    // Sort by duration, keep top 25
    for (const map in byMap) {
      byMap[map].sort((a, b) => a.duration_s - b.duration_s);
      payload[key][map] = byMap[map].slice(0, TOP_PER_MAP).map(r => {
        // Robust: handle both array of objects and array of strings
        let teamName = "Unknown";
        let playerCount = 0;
        if (Array.isArray(r.players)) {
          teamName = r.players.map(p => typeof p === 'string' ? p : (p.username || p.name || '')).filter(Boolean).join(" + ");
          playerCount = r.players.length;
        } else if (typeof r.players === 'string') {
          teamName = r.players;
          playerCount = 0;
        }
        return {
          t: teamName,
          d: r.duration_s,
          g: r.id,
          n: playerCount,
          ts: r.timestamp,
        };
      });
    }
  }

  const json = JSON.stringify(payload);
  fs.writeFileSync("teams_public.json", json);
  fs.writeFileSync("teams_public.json.gz", zlib.gzipSync(json));

  const totals = {};
  for (const k of MODE_KEYS) totals[k] = Object.keys(payload[k]).length;
  let totalRuns = 0;
  for (const k of MODE_KEYS) totalRuns += runs[k].length;
  console.log(`[teams] 📦 Public payload: ${(zlib.gzipSync(json).length / 1024).toFixed(1)} KB, ${totalRuns} runs total, maps: duos=${totals.duos} trio=${totals.trios} quad=${totals.quads} custom=${totals.team_custom} hvn=${totals.hvn}`);
}

// ── History backfill (remonte dans le temps, comme sync.js) ──
async function syncHistory(maxWindows = DEFAULT_HISTORY_WINDOWS) {
  const seen = loadSeen();
  const runs = loadRuns();
  const cp = loadCheckpoint();

  const now = Date.now();
  const oldest = TARGET_DATE;
  const saved = cp.history_oldest_reached ? parseInt(cp.history_oldest_reached, 10) : now;

  if (saved <= oldest + WINDOW_MS * 2) {
    console.log("[teams-history] ✅ Historique complet jusqu'au " + new Date(oldest).toISOString().slice(0, 10));
    return 0;
  }

  // Scan backwards from saved towards oldest
  let oldestReached = saved;
  let totalNew = 0;
  const newRunsByMode = emptyRuns();

  for (let i = 0; i < maxWindows; i++) {
    const windowEnd = oldestReached - i * WINDOW_MS;
    const windowStart = Math.max(windowEnd - WINDOW_MS, oldest);

    if (windowEnd <= oldest) {
      console.log("[teams-history] ✅ Atteint la date cible: " + new Date(oldest).toISOString().slice(0, 10));
      break;
    }

    // Option B: 2 requests per window (regular + offset if truncated)
    const url1 = `${API_BASE}/public/games?start=${new Date(windowStart).toISOString()}&end=${new Date(windowEnd).toISOString()}&type=Public&mode=Team&limit=1000`;
    const data1 = await fetchWithRetry(url1);
    if (!data1) continue;
    let games = Array.isArray(data1) ? data1 : (data1.games || []);

    // If 1000 games returned, fetch next page (offset=1000)
    if (games.length === 1000) {
      const url2 = `${API_BASE}/public/games?start=${new Date(windowStart).toISOString()}&end=${new Date(windowEnd).toISOString()}&type=Public&mode=Team&limit=1000&offset=1000`;
      const data2 = await fetchWithRetry(url2);
      if (data2) {
        const moreGames = Array.isArray(data2) ? data2 : (data2.games || []);
        games = [...games, ...moreGames];
        console.log(`[teams-history] ⚠️ Fenêtre ${new Date(windowEnd).toISOString().slice(11, 19)}: ${games.length} games (pagination utilisée)`);
      }
    }

    for (const g of games) {
      if (g.type !== "Public") continue;
      if ((g.numPlayers || 0) < MIN_HUMANS) continue;
      const gameId = g.game || g.gameId;
      if (!gameId || seen.has(gameId)) continue;

      // Fetch detail
      seen.add(gameId);
      try {
        const raw = await fetchWithRetry(`${API_BASE}/public/game/${encodeURIComponent(gameId)}?turns=false`);
        const run = extractTeamRun(raw);
        if (run) {
          newRunsByMode[run.mode].push(run);
          totalNew++;
        }
      } catch (e) { /* skip */ }
    }

    oldestReached = windowStart;

    // Checkpoint every 50 windows
    if (i > 0 && i % 50 === 0) {
      cp.history_oldest_reached = String(oldestReached);
      saveCheckpoint(cp);
      if (totalNew > 0) {
        // Merge + save
        for (const modeKey of MODE_KEYS) {
          if (newRunsByMode[modeKey].length > 0) {
            const existingIds = new Set(runs[modeKey].map(r => r.id));
            const newOnes = newRunsByMode[modeKey].filter(r => !existingIds.has(r.id));
            runs[modeKey] = [...runs[modeKey], ...newOnes];
          }
        }
        saveRuns(runs);
        saveSeen(seen);
      }
      const pct = Math.round(((now - oldestReached) / (now - oldest)) * 100);
      console.log(`[teams-history] ${i}/${maxWindows} fenêtres — ${pct}% — ${totalNew} nouveaux runs`);
    }
  }

  // Final merge + save
  for (const modeKey of MODE_KEYS) {
    if (newRunsByMode[modeKey].length > 0) {
      const existingIds = new Set(runs[modeKey].map(r => r.id));
      const newOnes = newRunsByMode[modeKey].filter(r => !existingIds.has(r.id));
      runs[modeKey] = [...runs[modeKey], ...newOnes];
      console.log(`[teams-history] ${MODES[modeKey].name}: +${newOnes.length} (total: ${runs[modeKey].length})`);
    }
  }
  if (totalNew > 0) saveRuns(runs);
  saveSeen(seen);

  cp.history_oldest_reached = String(oldestReached);
  saveCheckpoint(cp);

  if (totalNew > 0) generatePublicPayload(runs);

  console.log(`[teams-history] 🏁 ${totalNew} nouveaux runs historiques (oldest: ${new Date(oldestReached).toISOString().slice(0, 10)})`);
  return totalNew;
}

// ── Main ──
async function main() {
  console.log("[teams] 🚀 Démarrage — Team Speedrun Sync (5 modes: duos, trios, quads, team_custom, hvn)");
  if (hasExemption()) console.log("[teams] 🔑 Exemption Skailex active");
  else console.log("[teams] ⚠️ Pas d'exemption — rate limits peuvent s'appliquer");

  // 1. Sync recent (last 2h)
  await syncRecent();

  // 2. History backfill (remonte dans le temps)
  const histNew = await syncHistory(DEFAULT_HISTORY_WINDOWS);

  const runs = loadRuns();
  const counts = MODE_KEYS.map(k => `${MODES[k].name}=${runs[k].length}`).join(", ");
  console.log(`[teams] 🏁 Terminé: ${counts} (${histNew} historiques)`);
}

main().catch(e => { console.error("[teams] Fatal:", e); process.exit(1); });
