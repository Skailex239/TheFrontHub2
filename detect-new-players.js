/**
 * detect-new-players.js — Détecte les nouveaux joueurs depuis Firebase.
 *
 * Lit la collection Firestore `public-aliases` via l'API REST pour lister
 * tous les joueurs connectés (Google/Discord). Ajoute ceux qui ne sont pas
 * encore dans sync-players.json.
 *
 * Usage:
 *   node detect-new-players.js
 *
 * Écrit le résultat dans sync-players.json (mis à jour).
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const FIREBASE_PROJECT = "openfront-speedrun";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
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
  console.log("[detect] Fetching connected players from Firebase public-aliases...");
  try {
    const data = await fetchJson(`${FIRESTORE_BASE}/public-aliases?pageSize=1000`);
    const docs = data.documents || [];
    const seen = new Set();
    const list = [];
    for (const doc of docs) {
      const fields = doc.fields || {};
      const val = (f) => {
        if (!f || typeof f !== "object") return "";
        return f.stringValue || f.integerValue || "";
      };
      const publicId = val(fields.publicId);
      if (!/^[A-Za-z0-9]{8}$/.test(publicId)) continue;
      if (seen.has(publicId)) continue;
      seen.add(publicId);
      list.push({
        publicId,
        username: val(fields.username) || publicId,
      });
    }
    console.log(`[detect] Found ${list.length} connected players`);
    return list;
  } catch (e) {
    console.warn(`[detect] Firebase fetch failed: ${e.message}`);
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
