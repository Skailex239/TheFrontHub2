/**
 * scripts/find-bug-games.js — Find Team games that match ALL sync-teams.js
 * filters EXCEPT playerTeams format (numeric vs text).
 *
 * Goal: identify games that should have been synced but weren't because
 * playerTeams is "2", "3", "4" instead of "Duos", "Trios", "Quads".
 */
const https = require("https");

const API_BASE = "https://api.openfront.io";
const SKAILEX_TOKEN = "6e477cdeeea36386e4061dd89450a66c";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "skailex-find-bug",
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
  console.log("\n" + "═".repeat(80));
  console.log("  🐛 Recherche de games Team avec playerTeams numérique");
  console.log("═".repeat(80) + "\n");

  // 1. Récupérer les games Team des 2 derniers jours SANS filtre playerTeams
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

  const url = `${API_BASE}/public/games?start=${twoDaysAgo.toISOString()}&end=${now.toISOString()}&type=Public&mode=Team&limit=1000`;
  console.log(`Fetching: ${url.substring(0, 120)}...\n`);
  const apiGames = await fetchJson(url);
  console.log(`✓ ${apiGames.length} Team games récupérées\n`);

  // 2. Compter par playerTeams
  const byPt = {};
  for (const g of apiGames) {
    const pt = g.playerTeams;
    byPt[pt] = (byPt[pt] || 0) + 1;
  }
  console.log("Répartition par playerTeams:");
  for (const [pt, count] of Object.entries(byPt).sort((a, b) => b[1] - a[1])) {
    console.log(`  "${pt}": ${count} games`);
  }
  console.log("");

  // 3. Identifier les games avec playerTeams numérique ("2", "3", "4")
  //    (potentiellement Duos/Trios/Quads)
  const numericPtGames = apiGames.filter(g =>
    ["2", "3", "4", "5", "6", "7"].includes(g.playerTeams)
  );
  console.log(`Games avec playerTeams numérique: ${numericPtGames.length}\n`);

  // 4. Pour confirmer le bug, fetcher 3 de ces games et vérifier leur config
  console.log("─".repeat(80));
  console.log("  🔍 DÉTAIL DE 5 GAMES AVEC playerTeams NUMÉRIQUE");
  console.log("─".repeat(80));

  const samples = numericPtGames.slice(0, 5);
  for (const g of samples) {
    console.log(`\n📌 Game ${g.game} (playerTeams=${g.playerTeams}, numPlayers=${g.numPlayers}, maxPlayers=${g.maxPlayers})`);
    try {
      const detail = await fetchJson(`${API_BASE}/public/game/${g.game}?turns=false`);
      const info = detail.info || detail;
      const config = info.config || {};
      const players = info.players || [];
      const humans = players.filter(p => !p.isBot);
      const mods = config.publicGameModifiers || {};
      const hasMods = mods.isCompact || mods.isRandomSpawn || mods.isCrowded ||
        mods.isHardNations || mods.isAlliancesDisabled || mods.isPortsDisabled ||
        mods.isNukesDisabled || mods.isSAMsDisabled || mods.isPeaceTime ||
        mods.isWaterNukes || mods.isDoomsdayClock;

      const filters = {
        "Public": config.gameType === "Public",
        "Team": config.gameMode === "Team",
        "Normal map": config.gameMapSize === "Normal",
        "bots=400": config.bots === 400,
        "no modifiers": !hasMods,
        "humans>=10": humans.length >= 10,
        "duration>=60s": info.duration >= 60,
        "winner is team": Array.isArray(info.winner) && info.winner[0] === "team",
      };

      const passed = Object.entries(filters).filter(([k, v]) => v).map(([k]) => k);
      const failed = Object.entries(filters).filter(([k, v]) => !v).map(([k]) => k);
      console.log(`    config.playerTeams = ${JSON.stringify(config.playerTeams)} ← bug principal`);
      console.log(`    humans=${humans.length}, duration=${info.duration}s, winner=${JSON.stringify(info.winner).slice(0, 80)}`);
      console.log(`    Pass: ${passed.join(", ")}`);
      console.log(`    Fail: ${failed.length > 0 ? "❌ " + failed.join(", ") : "— (aucun)"}`);
    } catch (e) {
      console.log(`    ✗ Échec fetch: ${e.message}`);
    }
  }

  console.log("\n✅ Terminé.\n");
}

main().catch(e => {
  console.error("[find-bug] Fatal:", e.message);
  process.exit(1);
});
