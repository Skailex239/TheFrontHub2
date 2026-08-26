/**
 * scripts/check-game-detail.js — Fetch a specific game's detail to confirm
 * the playerTeams format bug.
 *
 * Usage: node scripts/check-game-detail.js <gameId>
 */
const https = require("https");

const API_BASE = "https://api.openfront.io";
const SKAILEX_TOKEN = "6e477cdeeea36386e4061dd89450a66c";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "skailex-check",
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

async function main() {
  const gameId = process.argv[2];
  if (!gameId) {
    console.error("Usage: node scripts/check-game-detail.js <gameId>");
    process.exit(1);
  }

  console.log(`Fetching detail for game: ${gameId}\n`);
  const data = await fetchJson(`${API_BASE}/public/game/${gameId}?turns=false`);

  const info = data.info || data;
  const config = info.config || {};

  console.log("═".repeat(80));
  console.log("  📋 GAME DETAIL");
  console.log("═".repeat(80));
  console.log(`  gameID:        ${info.gameID || info.gameId || info.id}`);
  console.log(`  gameType:      ${config.gameType}`);
  console.log(`  gameMode:      ${config.gameMode}`);
  console.log(`  gameMapSize:   ${config.gameMapSize}`);
  console.log(`  bots:          ${config.bots}`);
  console.log(`  playerTeams:   ${JSON.stringify(config.playerTeams)}  ← clé du bug`);
  console.log(`  difficulty:    ${config.difficulty}`);
  console.log(`  gameMap:       ${config.gameMap}`);
  console.log(`  duration:      ${info.duration}s`);
  console.log("");

  // Modifiers
  const mods = config.publicGameModifiers || {};
  const hasMods = mods.isCompact || mods.isRandomSpawn || mods.isCrowded ||
    mods.isHardNations || mods.isAlliancesDisabled || mods.isPortsDisabled ||
    mods.isNukesDisabled || mods.isSAMsDisabled || mods.isPeaceTime ||
    mods.isWaterNukes || mods.isDoomsdayClock;
  console.log(`  Has modifiers: ${hasMods ? "YES ❌" : "no ✓"}`);
  if (hasMods) {
    console.log(`    Modifiers: ${JSON.stringify(mods)}`);
  }
  console.log("");

  // Players
  const players = info.players || [];
  const humans = players.filter(p => !p.isBot);
  console.log(`  Total players: ${players.length}`);
  console.log(`  Human players: ${humans.length}`);
  console.log(`  Bots:          ${players.length - humans.length}`);
  console.log("");

  // Winner
  const winner = info.winner;
  console.log(`  Winner:        ${JSON.stringify(winner)}`);
  if (Array.isArray(winner) && winner.length >= 3 && winner[0] === "team") {
    const winnerIds = winner.slice(2);
    const winnerPlayers = players.filter(p => winnerIds.includes(p.clientID) && p.username && !p.isBot);
    console.log(`  Winner team:   ${winner[1]}`);
    console.log(`  Winner players (${winnerPlayers.length}):`);
    for (const p of winnerPlayers) {
      console.log(`    - ${p.username} (clientID=${p.clientID}, clanTag=${p.clanTag || "—"})`);
    }
  }
  console.log("");

  // Check against extractTeamRun filters
  console.log("═".repeat(80));
  console.log("  🔍 CHECK sync-teams.js FILTERS");
  console.log("═".repeat(80));
  console.log(`  ✓ gameType === "Public":           ${config.gameType === "Public" ? "YES" : "NO ❌"}`);
  console.log(`  ✓ gameMode === "Team":              ${config.gameMode === "Team" ? "YES" : "NO ❌"}`);
  console.log(`  ✓ gameMapSize === "Normal":         ${config.gameMapSize === "Normal" ? "YES" : "NO ❌"}`);
  console.log(`  ✓ bots === 400:                     ${config.bots === 400 ? "YES" : "NO ❌"}`);
  console.log(`  ✓ playerTeams in ["Duos","Trios","Quads"]: ${["Duos","Trios","Quads"].includes(config.playerTeams) ? "YES" : "NO ❌ ← BUG!"}`);
  console.log(`  ✓ no modifiers:                    ${!hasMods ? "YES" : "NO ❌"}`);
  console.log(`  ✓ humans.length >= 10:             ${humans.length >= 10 ? "YES" : "NO ❌"}`);
  console.log(`  ✓ winner valid:                    ${Array.isArray(winner) && winner.length >= 3 && winner[0] === "team" ? "YES" : "NO ❌"}`);
  console.log(`  ✓ duration >= 60s:                  ${info.duration >= 60 ? "YES" : "NO ❌"}`);
}

main().catch(e => {
  console.error("[check] Fatal:", e.message);
  process.exit(1);
});
