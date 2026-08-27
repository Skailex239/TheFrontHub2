/**
 * scripts/investigate-sync.js — Investigate the Team sync (v2 — corrected)
 *
 * Structure of teams_runs.json:
 *   { duos: [...], trios: [...], quads: [...] }
 *
 * 1. Calls https://api.openfront.io/public/games for the last 2 days
 *    with mode=Team, type=Public
 * 2. Loads the local teams_runs.json
 * 3. Compares: for each Duos/Trios/Quads from API, is it in local?
 */

const fs = require("fs");
const https = require("https");

const API_BASE = "https://api.openfront.io";
const SKAILEX_TOKEN = process.env.OPENFRONT_SKAILEX_ACCESS || "";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "skailex-investigate",
        "x-skailex-access": SKAILEX_TOKEN,
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
        catch (e) { reject(new Error(`JSON parse error on ${url}: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(new Error("timeout")); });
  });
}

function loadTeamsRuns() {
  try {
    const raw = fs.readFileSync("teams_runs.json", "utf8");
    const parsed = JSON.parse(raw);
    return parsed; // { duos, trios, quads }
  } catch (e) {
    console.warn("[investigate] Could not load teams_runs.json:", e.message);
    return { duos: [], trios: [], quads: [] };
  }
}

function extractIds(games) {
  const ids = new Set();
  for (const g of games) {
    const id = g.gameId || g.game || g.id;
    if (id) ids.add(id);
  }
  return ids;
}

async function main() {
  console.log("\n" + "═".repeat(80));
  console.log("  🔍 INVESTIGATION SYNC — Team games (Duos / Trios / Quads)");
  console.log("═".repeat(80) + "\n");

  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

  console.log(`Période: ${twoDaysAgo.toISOString()} → ${now.toISOString()}\n`);

  const url = `${API_BASE}/public/games?start=${twoDaysAgo.toISOString()}&end=${now.toISOString()}&type=Public&mode=Team&limit=1000`;
  console.log(`Fetching: ${url.substring(0, 120)}...\n`);

  let apiGames = [];
  try {
    const data = await fetchJson(url);
    apiGames = Array.isArray(data) ? data : (data.games || []);
    console.log(`✓ API returned ${apiGames.length} Team games for the last 2 days`);
  } catch (e) {
    console.error(`✗ API fetch failed: ${e.message}`);
    return;
  }

  // 2. Charger teams_runs.json local
  const localData = loadTeamsRuns();
  const localDuos = localData.duos || [];
  const localTrios = localData.trios || [];
  const localQuads = localData.quads || [];

  const localDuosIds = extractIds(localDuos);
  const localTriosIds = extractIds(localTrios);
  const localQuadsIds = extractIds(localQuads);

  console.log(`✓ Local teams_runs.json:`);
  console.log(`    Duos:  ${localDuos.length} games (${localDuosIds.size} unique IDs)`);
  console.log(`    Trios: ${localTrios.length} games (${localTriosIds.size} unique IDs)`);
  console.log(`    Quads: ${localQuads.length} games (${localQuadsIds.size} unique IDs)`);
  console.log(`    TOTAL: ${localDuos.length + localTrios.length + localQuads.length} games\n`);

  // 3. Filtrer les games API par playerTeams
  const apiDuos = apiGames.filter(g => g.playerTeams === "Duos");
  const apiTrios = apiGames.filter(g => g.playerTeams === "Trios");
  const apiQuads = apiGames.filter(g => g.playerTeams === "Quads");
  const apiOther = apiGames.filter(g => !["Duos", "Trios", "Quads"].includes(g.playerTeams));

  console.log("─".repeat(80));
  console.log("📊 RÉPARTITION DES GAMES API (2 derniers jours, n=" + apiGames.length + ")");
  console.log("─".repeat(80));
  console.log(`  Duos:           ${apiDuos.length}`);
  console.log(`  Trios:          ${apiTrios.length}`);
  console.log(`  Quads:          ${apiQuads.length}`);
  console.log(`  Autres (playerTeams null ou différent): ${apiOther.length}`);

  // Voir les playerTeams des "Autres"
  if (apiOther.length > 0) {
    const playerTeamsValues = {};
    for (const g of apiOther) {
      const pt = g.playerTeams;
      playerTeamsValues[pt] = (playerTeamsValues[pt] || 0) + 1;
    }
    console.log(`\n  Répartition des playerTeams pour les "Autres":`);
    for (const [pt, count] of Object.entries(playerTeamsValues).sort((a, b) => b[1] - a[1])) {
      console.log(`    "${pt}": ${count} games`);
    }
  }
  console.log("");

  // 4. Comparer : pour chaque type, combien manquent en local ?
  console.log("─".repeat(80));
  console.log("📊 ÉCART API vs LOCAL (par catégorie, 2 derniers jours)");
  console.log("─".repeat(80));

  const missingDuos = apiDuos.filter(g => !localDuosIds.has(g.game));
  const missingTrios = apiTrios.filter(g => !localTriosIds.has(g.game));
  const missingQuads = apiQuads.filter(g => !localQuadsIds.has(g.game));

  console.log(`  Duos:  API=${apiDuos.length}, manquants en local=${missingDuos.length} (${apiDuos.length > 0 ? Math.round(missingDuos.length/apiDuos.length*100) : 0}%)`);
  console.log(`  Trios: API=${apiTrios.length}, manquants en local=${missingTrios.length} (${apiTrios.length > 0 ? Math.round(missingTrios.length/apiTrios.length*100) : 0}%)`);
  console.log(`  Quads: API=${apiQuads.length}, manquants en local=${missingQuads.length} (${apiQuads.length > 0 ? Math.round(missingQuads.length/apiQuads.length*100) : 0}%)`);
  console.log("");

  // 5. Voir aussi le numPlayers des games manquantes
  console.log("─".repeat(80));
  console.log("📊 DISTRIBUTION DES numPlayers POUR LES GAMES MANQUANTES");
  console.log("─".repeat(80));
  const allMissing = [...missingDuos, ...missingTrios, ...missingQuads];
  if (allMissing.length > 0) {
    const dist = {};
    for (const g of allMissing) {
      const n = g.numPlayers;
      const bucket = n < 5 ? "0-4" : n < 10 ? "5-9" : n < 20 ? "10-19" : n < 30 ? "20-29" : n < 50 ? "30-49" : "50+";
      dist[bucket] = (dist[bucket] || 0) + 1;
    }
    for (const bucket of ["0-4", "5-9", "10-19", "20-29", "30-49", "50+"]) {
      console.log(`  ${bucket} joueurs: ${dist[bucket] || 0} games`);
    }
  }
  console.log("");

  // 6. Échantillon de games manquantes
  if (allMissing.length > 0) {
    console.log("─".repeat(80));
    console.log(`📌 ÉCHANTILLON DE 10 GAMES MANQUANTES EN LOCAL`);
    console.log("─".repeat(80));
    for (const g of allMissing.slice(0, 10)) {
      console.log(`  ${g.game} | ${g.start} | ${g.playerTeams} | numPlayers=${g.numPlayers} | maxPlayers=${g.maxPlayers} | difficulty=${g.difficulty} | rankedType=${g.rankedType}`);
    }
    console.log("");
  }

  // 7. Vérifier les games locales récentes (les plus récentes dans teams_runs.json)
  console.log("─".repeat(80));
  console.log("📊 DATES DES 5 GAMES LES PLUS RÉCENTES DANS LE LOCAL");
  console.log("─".repeat(80));
  const sortByStart = (a, b) => {
    const aTime = new Date(a.start || a.timestamp || 0).getTime();
    const bTime = new Date(b.start || b.timestamp || 0).getTime();
    return bTime - aTime;
  };
  console.log("\n  Duos (top 5 les plus récentes):");
  for (const g of [...localDuos].sort(sortByStart).slice(0, 5)) {
    console.log(`    ${g.gameId || g.game || g.id} | ${g.start || g.timestamp} | numPlayers=${g.numPlayers || g.players || "?"}`);
  }
  console.log("\n  Trios (top 5 les plus récentes):");
  for (const g of [...localTrios].sort(sortByStart).slice(0, 5)) {
    console.log(`    ${g.gameId || g.game || g.id} | ${g.start || g.timestamp} | numPlayers=${g.numPlayers || g.players || "?"}`);
  }
  console.log("\n  Quads (top 5 les plus récentes):");
  for (const g of [...localQuads].sort(sortByStart).slice(0, 5)) {
    console.log(`    ${g.gameId || g.game || g.id} | ${g.start || g.timestamp} | numPlayers=${g.numPlayers || g.players || "?"}`);
  }

  console.log("\n✅ Investigation terminée.\n");
}

main().catch(e => {
  console.error("[investigate] Fatal:", e);
  process.exit(1);
});
