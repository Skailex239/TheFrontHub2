/**
 * sync-player-games.js — Synchronise les parties d'un joueur depuis l'API OpenFront.
 *
 * Usage (GitHub Actions / CLI):
 *   node sync-player-games.js                    # sync tous les joueurs de sync-players.json
 *   node sync-player-games.js <publicId>         # sync un joueur spécifique
 *   node sync-player-games.js --full <publicId>  # force full sync (ignore le cache)
 *
 * Comportement:
 *   - Première sync (pas de fichier player-data/<pid>.json):
 *     Pagine TOUTES les parties depuis l'API (jusqu'à 500 pages = 5000 games).
 *     Lent mais complet.
 *   - Syncs suivantes (fichier existe):
 *     Pagine les parties récentes en s'arrêtant dès qu'on croise un gameId
 *     déjà présent dans le fichier. Rapide (1-3 pages généralement).
 *   - Déduplique par gameId, trie par date (récent en premier).
 *   - Écrit le résultat dans player-data/<pid>.json avec métadonnées.
 *
 * Le fichier JSON de sortie a la structure:
 *   {
 *     publicId, username,
 *     lastSyncedAt: ISO string,
 *     syncMode: "full" | "incremental",
 *     totalGames: number,
 *     games: [ { gameId, start, map, mode, result, ... } ]
 *   }
 *
 * L'API OpenFront est appelée directement avec le header x-skailex-access
 * (exemption de rate-limit). Le token est dans la variable d'env SKAILEX_ACCESS_TOKEN.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const SKAILEX_ACCESS_TOKEN = process.env.SKAILEX_ACCESS_TOKEN || "";
const API_BASE = "https://api.openfront.io";
const DATA_DIR = path.join(__dirname, "player-data");
const CONFIG_FILE = path.join(__dirname, "sync-players.json");
const MAX_PAGES_FULL = 500; // full sync: up to 5000 games
const MAX_PAGES_INCREMENTAL = 150; // incremental: up to 1500 games (scans more pages to not miss team games)

/* ── HTTP fetch helper ── */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "skailex-sync",
        "x-skailex-access": SKAILEX_ACCESS_TOKEN,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} on ${url}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout on ${url}`)); });
  });
}

/* ── Fetch player profile (for username) ── */
async function fetchPlayerProfile(publicId) {
  try {
    const data = await fetchJson(`${API_BASE}/public/player/${encodeURIComponent(publicId)}`);
    return data;
  } catch (e) {
    console.warn(`[sync] profile fetch failed for ${publicId}: ${e.message}`);
    return null;
  }
}

/* ── Paginate games from API ── */
/**
 * Fetches games for a player.
 * If knownGameIds is provided (Set), stops early when hitting a known gameId.
 * Returns array of games (new ones not in knownGameIds).
 */
async function fetchGames(publicId, knownGameIds, maxPages, onProgress) {
  const newGames = [];
  let cursor = null;
  let pages = 0;

  while (pages < maxPages) {
    let url = `${API_BASE}/public/player/${encodeURIComponent(publicId)}/games`;
    if (cursor) url += `?cursor=${encodeURIComponent(cursor)}`;

    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      console.warn(`[sync] games page ${pages} failed: ${e.message}`);
      break;
    }

    const results = data?.results || [];
    if (results.length === 0) break;

    // BUG FIX: Don't break on first known gameId — scan ALL games on the page.
    // The API returns games by gameId (numeric order), NOT by start date.
    // Team games can have different gameId ranges than FFA games.
    // If we stop at the first known gameId, we miss games on the same page
    // and games on subsequent pages that are newer.
    // FIX: Collect ALL unknown games from every page, stop only when we've
    // gone through enough pages with zero new games (safety break).
    let newOnThisPage = 0;
    for (const g of results) {
      if (knownGameIds && knownGameIds.has(g.gameId)) {
        continue; // skip known, but DON'T break — keep scanning
      }
      newGames.push(g);
      newOnThisPage++;
    }

    pages++;
    onProgress?.(newGames.length, pages);

    // Safety: if we're in incremental mode and found 0 new games on
    // 3 consecutive pages, we've passed all new games — stop.
    if (knownGameIds && newOnThisPage === 0) {
      // Check if we should stop (3 empty pages in a row)
      if (!fetchGames._emptyStreak) fetchGames._emptyStreak = 0;
      fetchGames._emptyStreak++;
      if (fetchGames._emptyStreak >= 3) {
        console.log(`[sync] ${publicId}: 3 consecutive empty pages, stopping (incremental)`);
        break;
      }
    } else {
      fetchGames._emptyStreak = 0;
    }

    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }

  fetchGames._emptyStreak = 0; // reset for next player
  return newGames;
}

/* ── Sync one player ── */
async function syncPlayer(publicId, options = {}) {
  const forceFull = options.forceFull === true;
  const filePath = path.join(DATA_DIR, `${publicId}.json`);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[sync] Player: ${publicId}`);
  console.log(`${"═".repeat(60)}`);

  // Read existing data
  let existing = null;
  if (!forceFull && fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
      console.log(`[sync] Existing file: ${existing.totalGames} games, last synced ${existing.lastSyncedAt}`);
    } catch (e) {
      console.warn(`[sync] Could not read existing file, doing full sync: ${e.message}`);
      existing = null;
    }
  }

  // Fetch profile for username
  const profile = await fetchPlayerProfile(publicId);
  const username = profile?.username || existing?.username || publicId;

  // Build known game IDs set (for incremental dedup)
  const knownGameIds = new Set();
  let existingGames = [];
  if (existing && Array.isArray(existing.games)) {
    existingGames = existing.games;
    for (const g of existingGames) {
      if (g.gameId) knownGameIds.add(g.gameId);
    }
  }

  const isIncremental = existingGames.length > 0 && !forceFull;
  const maxPages = isIncremental ? MAX_PAGES_INCREMENTAL : MAX_PAGES_FULL;
  console.log(`[sync] Mode: ${isIncremental ? "incremental" : "full"} (max ${maxPages} pages)`);
  console.log(`[sync] Known games: ${knownGameIds.size}`);

  // Fetch new games
  const startTime = Date.now();
  const newGames = await fetchGames(publicId, isIncremental ? knownGameIds : null, maxPages, (count, pages) => {
    process.stdout.write(`\r[sync] Fetched ${count} new games (${pages} pages)...    `);
  });
  console.log(""); // newline after progress

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[sync] Fetched ${newGames.length} new games in ${elapsed}s`);

  // Merge + dedupe + sort
  const allGamesMap = new Map();
  for (const g of existingGames) {
    if (g.gameId) allGamesMap.set(g.gameId, g);
  }
  for (const g of newGames) {
    if (g.gameId) allGamesMap.set(g.gameId, g);
  }
  const allGames = [...allGamesMap.values()].sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : 0;
    const tb = b.start ? new Date(b.start).getTime() : 0;
    return tb - ta; // most recent first
  });

  console.log(`[sync] Total: ${allGames.length} games (${newGames.length} new)`);

  // Write file
  const output = {
    publicId,
    username,
    lastSyncedAt: new Date().toISOString(),
    syncMode: isIncremental ? "incremental" : "full",
    syncDurationSec: parseFloat(elapsed),
    totalGames: allGames.length,
    newGamesThisSync: newGames.length,
    games: allGames,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
  console.log(`[sync] Written to ${filePath} (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`);

  return { publicId, username, totalGames: allGames.length, newGames: newGames.length, elapsed };
}

/* ── Main ── */
async function main() {
  const args = process.argv.slice(2);
  let publicIds = [];
  let forceFull = false;

  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--full") {
      forceFull = true;
    } else if (args[i] && !args[i].startsWith("-")) {
      publicIds.push(args[i]);
    }
  }

  // If no publicIds in args, read from config file
  if (publicIds.length === 0) {
    if (!fs.existsSync(CONFIG_FILE)) {
      console.error(`[sync] No config file found: ${CONFIG_FILE}`);
      console.error(`[sync] Create it with format: { "players": [{ "publicId": "XXXXXXXX", "username": "name" }] }`);
      process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    publicIds = (config.players || []).map((p) => p.publicId).filter(Boolean);
    console.log(`[sync] Loaded ${publicIds.length} players from ${CONFIG_FILE}`);
  }

  if (publicIds.length === 0) {
    console.error("[sync] No players to sync");
    process.exit(1);
  }

  console.log(`[sync] Starting sync for ${publicIds.length} player(s) at ${new Date().toISOString()}`);
  console.log(`[sync] Force full: ${forceFull}`);

  const results = [];
  for (const pid of publicIds) {
    try {
      const result = await syncPlayer(pid, { forceFull });
      results.push(result);
    } catch (e) {
      console.error(`[sync] FAILED for ${pid}: ${e.message}`);
      results.push({ publicId: pid, error: e.message });
    }
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log("[sync] SUMMARY");
  console.log(`${"═".repeat(60)}`);
  for (const r of results) {
    if (r.error) {
      console.log(`  ❌ ${r.publicId}: ${r.error}`);
    } else {
      console.log(`  ✅ ${r.publicId} (${r.username}): ${r.totalGames} games (+${r.newGames} new) in ${r.elapsed}s`);
    }
  }

  // Write summary file for workflow to use
  const summaryPath = path.join(DATA_DIR, "_sync-summary.json");
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify({
    syncedAt: new Date().toISOString(),
    results,
  }, null, 2));
}

main().catch((e) => {
  console.error("[sync] Fatal error:", e);
  process.exit(1);
});
