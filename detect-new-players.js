/**
 * detect-new-players.js — Détecte les nouveaux joueurs connectés.
 *
 * Interroge l'API MySQL TheFrontHub (/api/public-aliases.php) pour lister
 * tous les joueurs connectés via Discord. Ajoute ceux qui ne sont pas
 * encore dans sync-players.json.
 * (Migré depuis Firestore le 2026-08-29 — fin de la migration Firestore→MySQL.)
 *
 * Usage:
 *   node detect-new-players.js
 *
 * Écrit le résultat dans sync-players.json (mis à jour).
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const TFH_ALIASES_URL = "https://thefronthub.com/api/public-aliases.php";
const CONFIG_FILE = path.join(__dirname, "sync-players.json");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Accept: "application/json", "User-Agent": "skailex-sync" },
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

async function fetchConnectedPlayers() {
  console.log("[detect] Fetching connected players from thefronthub.com API...");
  try {
    const data = await fetchJson(TFH_ALIASES_URL);
    const aliases = data.aliases || [];
    const seen = new Set();
    const list = [];
    for (const alias of aliases) {
      const publicId = String(alias.publicId || "");
      if (!/^[A-Za-z0-9]{8}$/.test(publicId)) continue;
      if (seen.has(publicId)) continue;
      seen.add(publicId);
      list.push({
        publicId,
        username: alias.username || publicId,
      });
    }
    console.log(`[detect] Found ${list.length} connected players`);
    return list;
  } catch (e) {
    console.warn(`[detect] Aliases API fetch failed: ${e.message}`);
    return [];
  }
}

function main() {
  // Read current config
  let config = { players: [] };
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
  const existing = new Set((config.players || []).map((p) => p.publicId));
  console.log(`[detect] Current config has ${existing.size} players`);

  fetchConnectedPlayers().then((connected) => {
    const newPlayers = connected.filter((p) => !existing.has(p.publicId));
    console.log(`[detect] ${newPlayers.length} new players to add`);

    if (newPlayers.length > 0) {
      config.players = [...(config.players || []), ...newPlayers];
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log(`[detect] ✅ Added ${newPlayers.length} new players to sync-players.json:`);
      for (const p of newPlayers) {
        console.log(`  + ${p.publicId} (${p.username})`);
      }
    } else {
      console.log(`[detect] No new players to add`);
    }

    console.log(`[detect] Total players now: ${config.players.length}`);
  }).catch((e) => {
    console.error("[detect] Fatal:", e);
    process.exit(1);
  });
}

main();
