import fs from "fs";
import zlib from "zlib";
import {
  API_BASE,
  openFrontFetch,
  hasExemption,
} from "./openfront-api.js";

// Charger .env manuellement (même pattern que sync.js)
try {
  const envContent = fs.readFileSync(".env", "utf8");
  envContent.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim();
    if (key && value) {
      process.env[key.trim()] = value;
    }
  });
} catch (e) {
  // .env optionnel
}

const MAX_PAGES = 4; // 4 × 50 = top 200 joueurs
const MAX_HISTORY_POINTS = 200; // 200 points max par joueur (~50h de sync)

async function fetchLeaderboardPage(page) {
  const url = `${API_BASE}/leaderboard/ranked?page=${page}`;
  const res = await openFrontFetch(url);
  if (!res.ok) {
    if (res.status === 404) {
      console.log(`[ranked-sync] Page ${page}: 404, arrêt.`);
      return null; // signal: stop paging
    }
    // C4: Graceful fallback on 401/403 (exemption token missing/invalid)
    if (res.status === 401 || res.status === 403) {
      console.warn(`[ranked-sync] ⚠️ HTTP ${res.status} — token d'exemption manquant ou invalide.`);
      console.warn(`[ranked-sync] Conservation du cache précédent (ranked.json non écrasé).`);
      // Try to load previous cached data
      try {
        const cached = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
        if (cached && ((cached["1v1"] && cached["1v1"].length > 0) || (cached["2v2"] && cached["2v2"].length > 0))) {
          console.log(`[ranked-sync] Cache précédent conservé: 1v1=${(cached["1v1"] || []).length}, 2v2=${(cached["2v2"] || []).length} joueurs.`);
          return { __cached: cached };
        }
      } catch (e2) { /* no cache available */ }
      throw new Error(`HTTP ${res.status}`); // caller will break
    }
    console.warn(`[ranked-sync] HTTP ${res.status} à la page ${page}`);
    return null;
  }
  const data = await res.json();
  return data;
}

async function fetchAllRanked() {
  const all1v1 = [];
  const all2v2 = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    try {
      const data = await fetchLeaderboardPage(page);

      // Handle cached fallback from 401/403
      if (data && data.__cached) {
        const cached = data.__cached;
        if (cached["1v1"]) all1v1.push(...cached["1v1"]);
        if (cached["2v2"]) all2v2.push(...cached["2v2"]);
        return { "1v1": all1v1, "2v2": all2v2 };
      }

      // null means stop paging (404 or non-retryable HTTP error)
      if (data === null) break;

      const p1v1 = data["1v1"];
      const p2v2 = data["2v2"];
      if ((!p1v1 || p1v1.length === 0) && (!p2v2 || p2v2.length === 0)) {
        console.log(`[ranked-sync] Plus de joueurs à la page ${page}`);
        break;
      }
      if (p1v1 && Array.isArray(p1v1)) all1v1.push(...p1v1);
      if (p2v2 && Array.isArray(p2v2)) all2v2.push(...p2v2);
      console.log(
        `[ranked-sync] Page ${page}: 1v1=${p1v1?.length || 0}, 2v2=${p2v2?.length || 0} (total: 1v1=${all1v1.length}, 2v2=${all2v2.length})`
      );
      page++;
    } catch (e) {
      console.warn(`[ranked-sync] Erreur page ${page}:`, e.message);
      break;
    }
  }

  return { "1v1": all1v1, "2v2": all2v2 };
}

async function enrichStreaks(players, mode) {
  // Calcule la série de victoires/défaites consécutives pour le top 20
  const topN = 20;
  const enriched = [...players];
  for (let i = 0; i < Math.min(topN, enriched.length); i++) {
    const p = enriched[i];
    if (!p.public_id) continue;
    try {
      const res = await openFrontFetch(`${API_BASE}/public/player/${encodeURIComponent(p.public_id)}`);
      if (!res.ok) {
        console.warn(`[ranked-sync] Streak fetch ${p.username}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      let games;
      if (mode === "2v2") {
        games = (data.games || [])
          .filter(g => g.rankedType === '2v2' || g.mode === '2v2')
          .sort((a, b) => new Date(b.start || b.end || 0) - new Date(a.start || a.end || 0));
      } else {
        games = (data.games || [])
          .filter(g => g.rankedType === '1v1' || g.mode === '1v1' || g.type === 'Ranked')
          .sort((a, b) => new Date(b.start || b.end || 0) - new Date(a.start || a.end || 0));
      }

      let streak = 0;
      for (const g of games) {
        if (g.hasWon === true) {
          if (streak >= 0) streak++;
          else break;
        } else if (g.hasWon === false) {
          if (streak <= 0) streak--;
          else break;
        } else {
          break; // unknown result
        }
      }
      enriched[i] = { ...p, streak };
      console.log(`[ranked-sync] Streak ${mode} #${i + 1} ${p.username}: ${streak > 0 ? '🔥+' + streak : streak < 0 ? '❄️' + streak : '0'}`);
    } catch (e) {
      console.warn(`[ranked-sync] Streak erreur ${mode} ${p.username}:`, e.message);
    }
  }
  return enriched;
}

function loadHistory(filename) {
  try {
    const raw = fs.readFileSync(filename, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveHistory(history, players, jsonFilename, gzFilename) {
  const now = Date.now();
  players.forEach(p => {
    if (!p.public_id) return;
    if (!history[p.public_id]) history[p.public_id] = [];
    history[p.public_id].push({ t: now, elo: p.elo, rank: p.rank });
    // Garder les derniers MAX_HISTORY_POINTS
    if (history[p.public_id].length > MAX_HISTORY_POINTS) {
      history[p.public_id] = history[p.public_id].slice(-MAX_HISTORY_POINTS);
    }
  });

  // Nettoyer les joueurs non vus depuis 7 jours
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  Object.keys(history).forEach(pid => {
    const arr = history[pid];
    if (!arr || arr.length === 0) { delete history[pid]; return; }
    const last = arr[arr.length - 1];
    if (last.t < weekAgo) delete history[pid];
  });

  const json = JSON.stringify(history);
  fs.writeFileSync(jsonFilename, json);
  fs.writeFileSync(gzFilename, zlib.gzipSync(json));
  console.log(`[ranked-sync] 📈 Historique sauvegardé (${jsonFilename}): ${Object.keys(history).length} joueurs, ${(json.length / 1024).toFixed(0)} KB`);
}

function computeNewcomersAndDropouts(currentPlayers, previousPlayers) {
  const currentIds = new Set(currentPlayers.map(p => p.public_id));
  const previousIds = new Set(previousPlayers.map(p => p.public_id));

  const newcomers = currentPlayers
    .filter(p => !previousIds.has(p.public_id))
    .map(p => ({ rank: p.rank, username: p.username, public_id: p.public_id, elo: p.elo }));

  const dropouts = previousPlayers
    .filter(p => !currentIds.has(p.public_id))
    .map(p => ({ rank: p.rank, username: p.username, public_id: p.public_id, elo: p.elo }));

  return { newcomers, dropouts };
}

function computeMovement(players, previousPlayers) {
  const previousById = new Map();
  previousPlayers.forEach(p => {
    if (p.public_id) previousById.set(p.public_id, p.rank);
  });

  // Ajouter movement (ancien rang - nouveau rang)
  // > 0 = monté, < 0 = descendu, 0 = inchangé
  const enriched = players.map(p => {
    const prevRank = previousById.get(p.public_id);
    const movement = prevRank != null ? prevRank - p.rank : null;
    return { ...p, movement };
  });

  return enriched;
}

function saveWithMovement(players1v1, players2v2) {
  // Charger l'ancien classement pour calculer les mouvements
  let previous1v1 = [];
  let previous2v2 = [];
  try {
    const oldRaw = fs.readFileSync("ranked.json", "utf8");
    const oldData = JSON.parse(oldRaw);
    previous1v1 = oldData["1v1"] || [];
    previous2v2 = oldData["2v2"] || [];
    console.log(`[ranked-sync] 📊 Ancien classement chargé: 1v1=${previous1v1.length}, 2v2=${previous2v2.length} joueurs`);
  } catch (e) {
    console.log("[ranked-sync] ℹ️ Pas d'ancien classement, mouvements non calculés");
  }

  // Compute movements for both modes
  const enriched1v1 = computeMovement(players1v1, previous1v1);
  const enriched2v2 = computeMovement(players2v2, previous2v2);

  // Nouveaux arrivants / sortants (top 100 uniquement) — 1v1
  const top100_1v1 = enriched1v1.slice(0, 100);
  const prevTop100_1v1 = previous1v1.slice(0, 100);
  const { newcomers: newcomers1v1, dropouts: dropouts1v1 } = computeNewcomersAndDropouts(top100_1v1, prevTop100_1v1);
  if (newcomers1v1.length) console.log(`[ranked-sync] 🆕 Nouveaux 1v1: ${newcomers1v1.map(n => n.username).join(', ')}`);
  if (dropouts1v1.length) console.log(`[ranked-sync] 📉 Sortants 1v1: ${dropouts1v1.map(d => d.username).join(', ')}`);

  // Nouveaux arrivants / sortants (top 100 uniquement) — 2v2
  const top100_2v2 = enriched2v2.slice(0, 100);
  const prevTop100_2v2 = previous2v2.slice(0, 100);
  const { newcomers: newcomers2v2, dropouts: dropouts2v2 } = computeNewcomersAndDropouts(top100_2v2, prevTop100_2v2);
  if (newcomers2v2.length) console.log(`[ranked-sync] 🆕 Nouveaux 2v2: ${newcomers2v2.map(n => n.username).join(', ')}`);
  if (dropouts2v2.length) console.log(`[ranked-sync] 📉 Sortants 2v2: ${dropouts2v2.map(d => d.username).join(', ')}`);

  const payload = {
    "1v1": enriched1v1,
    "2v2": enriched2v2,
    newcomers1v1,
    dropouts1v1,
    newcomers2v2,
    dropouts2v2,
    updatedAt: new Date().toISOString(),
    totalPlayers1v1: enriched1v1.length,
    totalPlayers2v2: enriched2v2.length,
  };
  const json = JSON.stringify(payload);
  fs.writeFileSync("ranked.json", json);
  fs.writeFileSync("ranked.json.gz", zlib.gzipSync(json));

  const movements1v1 = enriched1v1.filter(p => p.movement != null && p.movement !== 0).length;
  const streaks1v1 = enriched1v1.filter(p => p.streak != null && p.streak !== 0).length;
  const movements2v2 = enriched2v2.filter(p => p.movement != null && p.movement !== 0).length;
  const streaks2v2 = enriched2v2.filter(p => p.streak != null && p.streak !== 0).length;
  console.log(
    `[ranked-sync] 💾 1v1: ${enriched1v1.length} joueurs, 2v2: ${enriched2v2.length} joueurs sauvegardés — ` +
      `${(json.length / 1024).toFixed(0)} KB raw / ` +
      `${(zlib.gzipSync(json).length / 1024).toFixed(0)} KB gz ` +
      `(1v1: ${movements1v1} mvts, ${streaks1v1} streaks, ${newcomers1v1.length}↑, ${dropouts1v1.length}↓ | ` +
      `2v2: ${movements2v2} mvts, ${streaks2v2} streaks, ${newcomers2v2.length}↑, ${dropouts2v2.length}↓)`
  );

  return { newcomers1v1, dropouts1v1, newcomers2v2, dropouts2v2 };
}

async function main() {
  console.log("[ranked-sync] 🚀 Démarrage du sync ranked...");
  if (hasExemption()) {
    console.log("[ranked-sync] 🔑 Exemption Skailex active");
  } else {
    console.warn(
      "[ranked-sync] ⚠️ Pas d'exemption — les rate limits peuvent s'appliquer"
    );
  }

  const { "1v1": players1v1, "2v2": players2v2 } = await fetchAllRanked();

  // Enrich streaks for both modes
  const players1v1WithStreaks = await enrichStreaks(players1v1, "1v1");
  const players2v2WithStreaks = await enrichStreaks(players2v2, "2v2");

  // Save history for both modes
  const history1v1 = loadHistory("ranked_history.json");
  saveHistory(history1v1, players1v1WithStreaks, "ranked_history.json", "ranked_history.json.gz");
  const history2v2 = loadHistory("ranked_2v2_history.json");
  saveHistory(history2v2, players2v2WithStreaks, "ranked_2v2_history.json", "ranked_2v2_history.json.gz");

  // Save combined ranked.json
  saveWithMovement(players1v1WithStreaks, players2v2WithStreaks);

  console.log("[ranked-sync] ✅ Terminé.");
}

main().catch((e) => {
  console.error("[ranked-sync] Fatal:", e);
  process.exit(1);
});
