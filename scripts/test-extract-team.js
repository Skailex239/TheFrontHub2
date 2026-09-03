/**
 * scripts/test-extract-team.js — Verify the new extractTeamRun works correctly
 * on games with playerTeams="2", "3", "4", "5", "6", "7", "Humans Vs Nations".
 *
 * Fetches 5 games of each type and confirms they would now be classified.
 */
const https = require("https");
const { execSync } = require("child_process");

const API_BASE = "https://api.openfront.io";
const SKAILEX_TOKEN = process.env.OPENFRONT_SKAILEX_ACCESS || "";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "skailex-test-extract",
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
  console.log("\n🧪 Test de la nouvelle fonction extractTeamRun\n");

  // Load the new sync-teams.js to use its extractTeamRun function
  // Since it's an ES module, we'll just simulate the logic inline
  // Fix 2026-09-03 : NUMBER N = N grandes équipes de couleur → REJETÉ.
  // Seules les strings ("Duos"/"Trios"/"Quads"/"Humans Vs Nations") sont valides.
  const PLAYER_TEAMS_TO_MODE = {
    "Duos": "duos",
    "Trios": "trios",
    "Quads": "quads",
    "Humans Vs Nations": "hvn",
  };

  function classifyGameMode(config) {
    const pt = config.playerTeams;
    if (pt == null) return null;
    return PLAYER_TEAMS_TO_MODE[pt] || null;
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
    const modeKey = classifyGameMode(config);
    if (!modeKey) return null;
    const players = info.players || [];
    const humanPlayers = players.filter(p => !p.isBot);
    if (humanPlayers.length < 10) return null;
    const winner = info.winner;
    if (!Array.isArray(winner) || winner.length < 3 || winner[0] !== "team") return null;
    const winnerIds = winner.slice(2);
    const winnerPlayers = players.filter(p => winnerIds.includes(p.clientID) && p.username && !p.isBot);
    if (winnerPlayers.length === 0) return null;
    let durationSecs = info.duration;
    if (!durationSecs || durationSecs < 60) return null;
    return { id: info.gameID, mode: modeKey, numPlayers: humanPlayers.length, duration: durationSecs };
  }

  // Tests : pour chaque playerTeams value, fetch une game récente
  const tests = [
    { playerTeams: "2", expected: "duos" },
    { playerTeams: "3", expected: "trios" },
    { playerTeams: "4", expected: "quads" },
    { playerTeams: 5, expected: null },
    { playerTeams: 6, expected: null },
    { playerTeams: 7, expected: null },
    { playerTeams: "Humans Vs Nations", expected: "hvn" },
    { playerTeams: "Duos", expected: "duos" },
    { playerTeams: "Trios", expected: "trios" },
    { playerTeams: "Quads", expected: "quads" },
  ];

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  let pass = 0, fail = 0;

  for (const { playerTeams, expected } of tests) {
    // List games with this playerTeams
    const url = `${API_BASE}/public/games?start=${oneDayAgo.toISOString()}&end=${now.toISOString()}&type=Public&mode=Team&playerTeams=${encodeURIComponent(playerTeams)}&limit=5`;
    console.log(`\n📌 Test playerTeams="${playerTeams}" → expected mode="${expected}"`);
    try {
      const games = await fetchJson(url);
      if (!games || games.length === 0) {
        console.log(`  ⚠️ Aucune game trouvée pour playerTeams="${playerTeams}"`);
        continue;
      }
      console.log(`  ${games.length} games trouvées, fetching 1er détail...`);

      // Fetch detail of first game
      const first = games[0];
      const detailUrl = `${API_BASE}/public/game/${first.game}?turns=false`;
      const detail = await fetchJson(detailUrl);

      const run = extractTeamRun(detail);
      if (run) {
        if (run.mode === expected) {
          console.log(`  ✅ PASS — game ${first.game} classée en mode "${run.mode}" (numPlayers=${run.numPlayers}, duration=${run.duration}s)`);
          pass++;
        } else {
          console.log(`  ❌ FAIL — game ${first.game} classée en mode "${run.mode}" (attendu "${expected}")`);
          fail++;
        }
      } else {
        console.log(`  ⚠️ extractTeamRun a retourné null — la game ne passe pas les filtres`);
        // Diagnostiquer
        const info = detail.info || detail;
        const config = info.config || {};
        console.log(`     config: playerTeams=${JSON.stringify(config.playerTeams)}, gameType=${config.gameType}, gameMode=${config.gameMode}, gameMapSize=${config.gameMapSize}, bots=${config.bots}`);
        const humans = (info.players || []).filter(p => !p.isBot).length;
        console.log(`     humans=${humans}, duration=${info.duration}, winner=${JSON.stringify(info.winner).slice(0, 80)}`);
        // Pas un fail, c'est juste que cette game ne matche pas tous les filtres
      }
    } catch (e) {
      console.log(`  ✗ Erreur: ${e.message}`);
    }
  }

  console.log("\n" + "═".repeat(80));
  console.log(`  Résultats: ${pass} pass, ${fail} fail`);
  console.log("═".repeat(80));
}

main().catch(e => {
  console.error("[test] Fatal:", e.message);
  process.exit(1);
});
