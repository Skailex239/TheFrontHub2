/**
 * detect-new-players.js — Détecte les nouveaux joueurs connectés.
 *
 * Interroge l'API MySQL TheFrontHub (tfh_public_aliases via
 * /api/public-aliases.php) pour lister tous les joueurs qui ont lié leur
 * compte. Remplace l'ancienne lecture Firestore `public-aliases`
 * (migration MySQL terminée).
 *
 * Ajoute les joueurs absents dans sync-players.json.
 *
 * Usage:
 *   node detect-new-players.js
 *
 * Env:
 *   TFH_ALIASES_URL — URL de l'API aliases (défaut: https://thefronthub.com/api/public-aliases.php)
 *
 * Écrit le résultat dans sync-players.json (mis à jour).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALIASES_URL =
  process.env.TFH_ALIASES_URL || "https://thefronthub.com/api/public-aliases.php";
const CONFIG_FILE = path.join(__dirname, "sync-players.json");

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "skailex-sync" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchConnectedPlayers() {
  console.log("[detect] Fetching connected players from MySQL API (tfh_public_aliases)...");
  try {
    const data = await fetchJson(ALIASES_URL);
    const rows = Array.isArray(data.aliases) ? data.aliases : [];
    const seen = new Set();
    const list = [];
    for (const row of rows) {
      const publicId = String(row.publicId || "");
      if (!/^[A-Za-z0-9]{8}$/.test(publicId)) continue;
      if (seen.has(publicId)) continue;
      seen.add(publicId);
      list.push({
        publicId,
        username: row.username || publicId,
      });
    }
    console.log(`[detect] Found ${list.length} connected players`);
    return list;
  } catch (e) {
    console.warn(`[detect] Aliases API fetch failed: ${e.message}`);
    return [];
  }
}

async function main() {
  // Read current config
  let config = { players: [] };
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
  const existing = new Set((config.players || []).map((p) => p.publicId));
  console.log(`[detect] Current config has ${existing.size} players`);

  const connected = await fetchConnectedPlayers();
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
}

main().catch((e) => {
  console.error("[detect] Fatal:", e);
  process.exit(1);
});
