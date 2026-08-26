/**
 * scripts/backfill-teams.js — One-shot backfill script to recover missing
 * Team games from the last N days.
 *
 * Bug: sync-teams.js was missing games with playerTeams="2", "3", "4", "5",
 * "6", "7", "Humans Vs Nations" — only "Duos"/"Trios"/"Quads" text was fetched.
 * This script crawls backwards in time and recovers those games.
 *
 * Usage:
 *   node scripts/backfill-teams.js                  # default 7 days
 *   node scripts/backfill-teams.js 30              # 30 days
 *   node scripts/backfill-teams.js 7 2026-08-13    # 7 days from a specific date
 *
 * Safety: uses teams_seen.json to avoid re-fetching games already synced.
 * Saves incrementally every 100 games.
 */

import fs from "fs";
import zlib from "zlib";
import {
  API_BASE,
  openFrontFetch,
  hasExemption,
} from "../openfront-api.js";

// ── Mode definitions (must match sync-teams.js) ──
const MODES = {
  duos:        { playerTeamsValues: ["Duos", "2"] },
  trios:       { playerTeamsValues: ["Trios", "3"] },
  quads:       { playerTeamsValues: ["Quads", "4"] },
  team_custom: { playerTeamsValues: ["5", "6", "7"] },
  hvn:         { playerTeamsValues: ["Humans Vs Nations"] },
};
const MODE_KEYS = Object.keys(MODES);
const PLAYER_TEAMS_TO_MODE = {};
for (const [k, def] of Object.entries(MODES)) {
  for (const v of def.playerTeamsValues) PLAYER_TEAMS_TO_MODE[v] = k;
}

// ── Constants ──
const WINDOW_MS = 30 * 1000;
const FETCH_TIMEOUT = 8000;
const DETAIL_CONCURRENCY = 12;
const TIME_OFFSET_SECS = 32;
const MIN_HUMANS = 10;
const SAVE_EVERY = 100;  // save progress every 100 new games

// ── File paths ──
const RUNS_FILE = "teams_runs.json";
const SEEN_FILE = "teams_seen.json";

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

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await openFrontFetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const wait = 2000 * (attempt + 1);
        console.log(`  429 — attente ${wait}ms (tentative ${attempt + 1}/${retries})`);
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
      console.warn(`  fetch failed: ${url}: ${e.message}`);
      return null;
    }
  }
  return null;
}

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

function extractTeamRun(raw) {
  const info = raw?.info;
  if (!info) return null;
  const config = info.config || {};

  if (config.gameType !== "Public") return null;
  if (config.gameMode !== "Team") return null;
  if (config.gameMapSize !== "Normal") return null;
  if (config.bots !== 400) return null;
  if (hasModifiers(config)) return null;

  const pt = config.playerTeams;
  if (pt == null) return null;
  const modeKey = PLAYER_TEAMS_TO_MODE[pt];
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
    mode: modeKey,
    team: winner[1],
    players: winnerPlayers.map(p => ({ username: p.username, clientID: p.clientID, clanTag: p.clanTag || null })),
    map: config.gameMap || "Unknown",
    duration_s: durationSecs,
    difficulty: config.difficulty || "Medium",
    bots: 400,
    numPlayers: humanPlayers.length,
    playerTeams: config.playerTeams,
    timestamp: info.start ? new Date(info.start > 1e10 ? info.start : info.start * 1000).toISOString() : new Date().toISOString(),
    url: `https://openfront.io/game/${gameId}`,
  };
}

async function main() {
  // Parse args: [days] [startDateISO]
  const days = parseInt(process.argv[2] || "7", 10);
  const startISO = process.argv[3] || new Date().toISOString();
  const startDate = new Date(startISO);
  const endDate = new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);

  console.log("═".repeat(80));
  console.log(`  🔄 BACKFILL TEAMS — ${days} jours depuis ${startDate.toISOString().slice(0, 10)}`);
  console.log("═".repeat(80));
  if (hasExemption()) console.log("🔑 Exemption Skailex active\n");
  else console.log("⚠️ Pas d'exemption — rate limits vont s'appliquer\n");

  const seen = loadSeen();
  const runs = loadRuns();

  const initialCounts = MODE_KEYS.map(k => `${k}=${runs[k].length}`).join(", ");
  console.log(`État initial: ${initialCounts}`);
  console.log(`seen.json: ${seen.size} games déjà vues\n`);

  let totalFetched = 0;
  let totalNew = 0;
  const newRunsByMode = emptyRuns();
  let lastSave = 0;

  // Walk backwards in time from endDate to startDate, 30s windows
  const totalWindows = Math.ceil((endDate.getTime() - startDate.getTime()) / WINDOW_MS);
  console.log(`${totalWindows} fenêtres de 30s à scanner\n`);

  let cursor = new Date(endDate.getTime());

  for (let i = 0; i < totalWindows; i++) {
    const windowEnd = cursor.getTime();
    const windowStart = Math.max(windowEnd - WINDOW_MS, startDate.getTime());
    cursor = new Date(windowStart);

    if (i % 100 === 0) {
      const pct = ((i / totalWindows) * 100).toFixed(1);
      const progress = `Progress: ${pct}% (${i}/${totalWindows}) — fetched=${totalFetched} new=${totalNew}`;
      console.log(`[${new Date(windowEnd).toISOString()}] ${progress}`);
    }

    // Fetch all Team games in this window (Option B — 2 requests: regular + offset if truncated)
    const url1 = `${API_BASE}/public/games?start=${new Date(windowStart).toISOString()}&end=${new Date(windowEnd).toISOString()}&type=Public&mode=Team&limit=1000`;
    const data1 = await fetchWithRetry(url1);
    if (!data1) {
      cursor = new Date(windowStart);
      continue;
    }
    let games = Array.isArray(data1) ? data1 : (data1.games || []);

    // If 1000 games returned, fetch next page
    if (games.length === 1000) {
      const url2 = `${API_BASE}/public/games?start=${new Date(windowStart).toISOString()}&end=${new Date(windowEnd).toISOString()}&type=Public&mode=Team&limit=1000&offset=1000`;
      const data2 = await fetchWithRetry(url2);
      if (data2) {
        const moreGames = Array.isArray(data2) ? data2 : (data2.games || []);
        games = [...games, ...moreGames];
        console.log(`  ⚠️ Fenêtre ${new Date(windowEnd).toISOString().slice(11, 19)}: ${games.length} games (pagination)`);
      }
    }

    const candidates = games.filter(g =>
      g.type === "Public" &&
      (g.numPlayers || 0) >= MIN_HUMANS &&
      g.game && !seen.has(g.game)
    );

    if (candidates.length === 0) {
      cursor = new Date(windowStart);
      continue;
    }

    // Fetch detail in parallel chunks
    for (let c = 0; c < candidates.length; c += DETAIL_CONCURRENCY) {
      const chunk = candidates.slice(c, c + DETAIL_CONCURRENCY);
      await Promise.all(chunk.map(async (g) => {
        seen.add(g.game);
        totalFetched++;
        try {
          const raw = await fetchWithRetry(`${API_BASE}/public/game/${encodeURIComponent(g.game)}?turns=false`);
          const run = extractTeamRun(raw);
          if (run) {
            newRunsByMode[run.mode].push(run);
            totalNew++;
          }
        } catch (e) { /* skip */ }
      }));
    }

    // Save incrementally
    if (totalNew - lastSave >= SAVE_EVERY) {
      for (const modeKey of MODE_KEYS) {
        if (newRunsByMode[modeKey].length > 0) {
          const existingIds = new Set(runs[modeKey].map(r => r.id));
          const newOnes = newRunsByMode[modeKey].filter(r => !existingIds.has(r.id));
          runs[modeKey] = [...runs[modeKey], ...newOnes];
          newRunsByMode[modeKey] = [];
        }
      }
      saveRuns(runs);
      saveSeen(seen);
      lastSave = totalNew;
      console.log(`  💾 Sauvegarde incrémentale — ${totalNew} nouveaux runs récupérés`);
    }
  }

  // Final merge + save
  for (const modeKey of MODE_KEYS) {
    if (newRunsByMode[modeKey].length > 0) {
      const existingIds = new Set(runs[modeKey].map(r => r.id));
      const newOnes = newRunsByMode[modeKey].filter(r => !existingIds.has(r.id));
      runs[modeKey] = [...runs[modeKey], ...newOnes];
    }
  }
  saveRuns(runs);
  saveSeen(seen);

  console.log("\n" + "═".repeat(80));
  console.log("  ✅ BACKFILL TERMINÉ");
  console.log("═".repeat(80));
  console.log(`  Fetched: ${totalFetched} games (dont ${totalNew} acceptées)`);
  console.log(`  Final counts:`);
  for (const k of MODE_KEYS) {
    console.log(`    ${k}: ${runs[k].length}`);
  }
}

main().catch(e => { console.error("[backfill] Fatal:", e); process.exit(1); });
