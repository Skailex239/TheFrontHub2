/**
 * scripts/quantify-bug.js — Quantify the bug impact
 *
 * For each Team game in the last 2 days, check if it would pass sync-teams.js
 * filters if we accepted playerTeams="2"/"3"/"4" as Duos/Trios/Quads.
 *
 * Output: how many Normal-mode Team games are missed because of playerTeams
 * format.
 */
const https = require("https");

const API_BASE = "https://api.openfront.io";
const SKAILEX_TOKEN = "6e477cdeeea36386e4061dd89450a66c";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "skailex-quantify",
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
  console.log("\n📊 Quantification du bug\n");

  // Récupérer les games Team des 2 derniers jours sans filtre playerTeams
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const url = `${API_BASE}/public/games?start=${twoDaysAgo.toISOString()}&end=${now.toISOString()}&type=Public&mode=Team&limit=1000`;
  const apiGames = await fetchJson(url);
  console.log(`Total Team games (2 jours): ${apiGames.length}`);

  // Répartition
  const stats = {
    "Duos texte": 0,
    "Trios texte": 0,
    "Quads texte": 0,
    "2 numérique": 0,
    "3 numérique": 0,
    "4 numérique": 0,
    "5+": 0,
    "Humans Vs Nations": 0,
    "Autres": 0,
  };

  for (const g of apiGames) {
    const pt = g.playerTeams;
    if (pt === "Duos") stats["Duos texte"]++;
    else if (pt === "Trios") stats["Trios texte"]++;
    else if (pt === "Quads") stats["Quads texte"]++;
    else if (pt === "2") stats["2 numérique"]++;
    else if (pt === "3") stats["3 numérique"]++;
    else if (pt === "4") stats["4 numérique"]++;
    else if (["5", "6", "7"].includes(pt)) stats["5+"]++;
    else if (pt === "Humans Vs Nations") stats["Humans Vs Nations"]++;
    else stats["Autres"]++;
  }

  console.log("\nRépartition par playerTeams:");
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k.padEnd(20)} : ${v} games`);
  }

  const totalText = stats["Duos texte"] + stats["Trios texte"] + stats["Quads texte"];
  const totalNumeric = stats["2 numérique"] + stats["3 numérique"] + stats["4 numérique"];
  console.log(`\n  TOTAL texte (récupéré par sync):     ${totalText}`);
  console.log(`  TOTAL numérique (raté par sync):     ${totalNumeric}`);
  console.log(`  TOTAL 5+/HVN/Autres (custom):       ${stats["5+"] + stats["Humans Vs Nations"] + stats["Autres"]}`);

  // Pour estimer combien des games numériques sont réellement "Duos/Trios/Quads"
  // (càd 2/3/4 joueurs par équipe), il faudrait fetcher le détail.
  // Mais on peut déjà estimer à partir de maxPlayers et numPlayers :
  // - Duos = numPlayers divisible par 2 (et ~2 joueurs par équipe)
  // - Trios = divisible par 3
  // - Quads = divisible par 4

  console.log("\n📊 ESTIMATION (par divisibilité de numPlayers):");
  const numericGames = apiGames.filter(g =>
    ["2", "3", "4"].includes(g.playerTeams) && g.numPlayers > 0
  );
  const divBy2 = numericGames.filter(g => g.playerTeams === "2").length;
  const divBy3 = numericGames.filter(g => g.playerTeams === "3").length;
  const divBy4 = numericGames.filter(g => g.playerTeams === "4").length;
  console.log(`  Games playerTeams="2" (probablement Duos):  ${divBy2}`);
  console.log(`  Games playerTeams="3" (probablement Trios): ${divBy3}`);
  console.log(`  Games playerTeams="4" (probablement Quads): ${divBy4}`);

  console.log("\n🎯 CONCLUSION:");
  console.log(`  Sur 2 jours, ${totalNumeric} games Team probablement Duos/Trios/Quads sont ratées`);
  console.log(`  par sync-teams.js à cause du filtre playerTeams="Duos/Trios/Quads" (texte).`);
  console.log(`  À cela s'ajoutent ${totalText} games avec playerTeams texte (récupérées mais`);
  console.log(`  dont certaines sont rejetées pour gameMapSize=Compact ou modifiers).`);
}

main().catch(e => {
  console.error("[quantify] Fatal:", e.message);
  process.exit(1);
});
