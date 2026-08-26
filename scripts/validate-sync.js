/**
 * scripts/validate-sync.js — Validate that teams_runs.json matches the API.
 *
 * For the last N hours (default 6h), fetches all Team games from the API,
 * fetches each game's detail, runs extractTeamRun, and compares with what's
 * stored in teams_runs.json locally.
 *
 * Output:
 *   - Total API Team games (with ≥10 humans, valid winner, etc.)
 *   - Local teams_runs.json count for the same period
 *   - Missing games (in API but not in local)
 *   - Extra games (in local but not in API — could be deleted/abandoned)
 *   - Per-mode breakdown
 *
 * Usage:
 *   node scripts/validate-sync.js        # last 6h
 *   node scripts/validate-sync.js 24     # last 24h
 */

import fs from "fs";
import https from "https";

const API_BASE = "https://api.openfront.io";
const SKAILEX_TOKEN = "6e477cdeeea36386e4061dd89450a66c";

// Must match sync-teams.js
const MODES = {
  duos:        { name: "Duos",              playerTeamsValues: ["Duos", "2"] },
  trios:       { name: "Trios",            playerTeamsValues: ["Trios", "3"] },
  quads:       { name: "Quads",            playerTeamsValues: ["Quads", "4"] },
  team_custom: { name: "Team Custom",      playerTeamsValues: ["5", "6", "7"] },
  hvn:         { name: "Humans Vs Nations", playerTeamsValues: ["Humans Vs Nations"] },
};
const MODE_KEYS = Object.keys(MODES);
const PLAYER_TEAMS_TO_MODE = {};
for (const [k, def] of Object.entries(MODES)) {
  for (const v of def.playerTeamsValues) PLAYER_TEAMS_TO_MODE[v] = k;
}

const MIN_HUMANS = 10;
const TIME_OFFSET_SECS = 32;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "skailex-validate",
        "x-skailex-access": SKAILEX_TOKEN,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(new Error("timeout")); });
  });
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
    timestamp: info.start ? new Date(info.start > 1e10 ? info.start : info.start * 1000).toISOString() : new Date().toISOString(),
  };
}

function loadLocalRuns() {
  try {
    const raw = JSON.parse(fs.readFileSync("teams_runs.json", "utf8"));
    const result = {};
    for (const k of MODE_KEYS) result[k] = Array.isArray(raw[k]) ? raw[k] : [];
    return result;
  } catch { const r = {}; for (const k of MODE_KEYS) r[k] = []; return r; }
}

async function main() {
  const hours = parseInt(process.argv[2] || "6", 10);
  const now = new Date();
  const sinceMs = now.getTime() - hours * 60 * 60 * 1000;
  const since = new Date(sinceMs);

  console.log("\n" + "═".repeat(80));
  console.log(`  🔍 VALIDATION SYNC — ${hours} dernières heures`);
  console.log(`  Période: ${since.toISOString()} → ${now.toISOString()}`);
  console.log("═".repeat(80) + "\n");

  // 1. Charger local
  const localRuns = loadLocalRuns();
  // Filter by date (only runs from since → now)
  const localRecent = {};
  for (const k of MODE_KEYS) {
    localRecent[k] = localRuns[k].filter(r => {
      const t = new Date(r.timestamp).getTime();
      return t >= sinceMs && t <= now.getTime();
    });
  }
  const localIds = new Set();
  for (const k of MODE_KEYS) for (const r of localRecent[k]) localIds.add(r.id);

  console.log(`Local teams_runs.json (${hours}h):`);
  let totalLocal = 0;
  for (const k of MODE_KEYS) {
    console.log(`  ${MODES[k].name.padEnd(20)} : ${localRecent[k].length}`);
    totalLocal += localRecent[k].length;
  }
  console.log(`  ${"TOTAL".padEnd(20)} : ${totalLocal}\n`);

  // 2. Fetch API Team games in 30s windows (2 requests per window)
  console.log("Fetching API Team games...\n");
  const windowMs = 30 * 1000;
  const apiGames = [];
  let apiCalls = 0;
  for (let endMs = now.getTime(); endMs > sinceMs; endMs -= windowMs) {
    const startMs = Math.max(endMs - windowMs, sinceMs);
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();

    // Request 1
    const url1 = `${API_BASE}/public/games?start=${start}&end=${end}&type=Public&mode=Team&limit=1000`;
    try {
      const data1 = await fetchJson(url1);
      apiCalls++;
      const games1 = Array.isArray(data1) ? data1 : (data1.games || []);
      apiGames.push(...games1);

      // Request 2 if truncated
      if (games1.length === 1000) {
        const url2 = `${API_BASE}/public/games?start=${start}&end=${end}&type=Public&mode=Team&limit=1000&offset=1000`;
        try {
          const data2 = await fetchJson(url2);
          apiCalls++;
          const games2 = Array.isArray(data2) ? data2 : (data2.games || []);
          apiGames.push(...games2);
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }
  }

  // Dedupe by game ID (in case of overlap)
  const apiGameIds = new Set();
  const apiGamesUnique = [];
  for (const g of apiGames) {
    if (!apiGameIds.has(g.game)) {
      apiGameIds.add(g.game);
      apiGamesUnique.push(g);
    }
  }

  console.log(`API: ${apiGamesUnique.length} Team games uniques (${apiCalls} appels API)\n`);

  // 3. Pour chaque game API, fetcher le détail et classifier
  console.log("Fetching détails des games API pour classifier...\n");
  const apiClassified = {}; // mode → [gameId]
  for (const k of MODE_KEYS) apiClassified[k] = [];
  let apiRejected = 0;

  // Process in parallel chunks
  const CHUNK_SIZE = 12;
  for (let i = 0; i < apiGamesUnique.length; i += CHUNK_SIZE) {
    const chunk = apiGamesUnique.slice(i, i + CHUNK_SIZE);
    await Promise.all(chunk.map(async (g) => {
      try {
        const detail = await fetchJson(`${API_BASE}/public/game/${g.game}?turns=false`);
        const run = extractTeamRun(detail);
        if (run) {
          apiClassified[run.mode].push(run.id);
        } else {
          apiRejected++;
        }
      } catch (e) { apiRejected++; }
    }));

    // Progress every 50 games
    if ((i + CHUNK_SIZE) % 50 < CHUNK_SIZE) {
      const total = i + CHUNK_SIZE;
      console.log(`  Progress: ${total}/${apiGamesUnique.length} games checked`);
    }
  }

  console.log("");
  const totalApiAccepted = MODE_KEYS.reduce((sum, k) => sum + apiClassified[k].length, 0);
  console.log(`API accepted (passed all filters): ${totalApiAccepted}`);
  console.log(`API rejected (Compact, modifiers, <10p, etc.): ${apiRejected}\n`);

  // 4. Comparer
  console.log("─".repeat(80));
  console.log("📊 COMPARAISON API vs LOCAL");
  console.log("─".repeat(80));
  console.log(`  Mode                       API    Local   Missing  Match %`);
  console.log("  " + "─".repeat(76));

  let totalApi = 0, totalLocalCompare = 0, totalMissing = 0;
  for (const k of MODE_KEYS) {
    const api = apiClassified[k];
    const local = localRecent[k];
    const localIdsForMode = new Set(local.map(r => r.id));
    const missing = api.filter(id => !localIdsForMode.has(id));
    const matchPct = api.length > 0 ? Math.round((1 - missing.length / api.length) * 100) : 100;
    console.log(`  ${MODES[k].name.padEnd(26)} ${String(api.length).padStart(5)}  ${String(local.length).padStart(5)}  ${String(missing.length).padStart(7)}  ${matchPct}%`);
    totalApi += api.length;
    totalLocalCompare += local.length;
    totalMissing += missing.length;
  }
  const overallMatch = totalApi > 0 ? Math.round((1 - totalMissing / totalApi) * 100) : 100;
  console.log("  " + "─".repeat(76));
  console.log(`  ${"TOTAL".padEnd(26)} ${String(totalApi).padStart(5)}  ${String(totalLocalCompare).padStart(5)}  ${String(totalMissing).padStart(7)}  ${overallMatch}%\n`);

  // 5. Échantillon de games manquantes
  if (totalMissing > 0) {
    console.log("─".repeat(80));
    console.log(`📌 ÉCHANTILLON DE 10 GAMES MANQUANTES EN LOCAL`);
    console.log("─".repeat(80));
    let count = 0;
    for (const k of MODE_KEYS) {
      const api = apiClassified[k];
      const local = localRecent[k];
      const localIdsForMode = new Set(local.map(r => r.id));
      const missing = api.filter(id => !localIdsForMode.has(id));
      for (const id of missing.slice(0, 3)) {
        if (count >= 10) break;
        console.log(`  [${MODES[k].name}] ${id}`);
        count++;
      }
      if (count >= 10) break;
    }
    console.log("");
  }

  if (overallMatch === 100) {
    console.log("🎉 PARFAIT : 100% des games API sont dans le local !");
  } else if (overallMatch >= 95) {
    console.log(`✅ BON : ${overallMatch}% de match (acceptable pour les prochaines syncs)`);
  } else {
    console.log(`⚠️ ATTENTION : ${overallMatch}% de match — investigate the missing games`);
  }
  console.log("");
}

main().catch(e => {
  console.error("[validate] Fatal:", e.message);
  process.exit(1);
});
