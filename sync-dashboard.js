// sync-dashboard.js — Pré-calcule les scores du dashboard
// Sources de joueurs (fusionnées par publicId) :
//   1. data/players.json (joueurs Discord)
//   2. API MySQL TheFrontHub /api/public-aliases.php (joueurs connectés)
//      (migré depuis Firestore le 2026-08-29 — la source de vérité est
//      désormais la table tfh_public_aliases, fin de la migration 6/8)
//   3. ranked.json (top 100 1v1 + top 100 2v2 — nouveaux ranked auto-inclus)
//
// SEMAINE FIXE (reset automatique) :
//   Les scores hebdo couvrent la semaine en cours, du LUNDI 00h00 (heure de
//   Paris) au lundi suivant 00h00. Quand une nouvelle semaine commence, les
//   points hebdo retombent à 0 automatiquement — aucun reset manuel, aucune
//   action requise. La frontière est calculée dynamiquement à chaque exécution
//   via getWeekStartMs(Date.now()), en fuseau Europe/Paris pour rester
//   cohérent avec le label affiché côté navigateur ("Depuis le lundi …").
//
// Usage: node sync-dashboard.js

import fs from "fs";
import zlib from "zlib";
import { API_BASE, openFrontFetch, hasExemption } from "./openfront-api.js";

const PLAYERS_FILE = "data/players.json";
const OUTPUT_FILE = "dashboard_scores.json";
const CONCURRENCY = 8;
const TFH_ALIASES_URL = "https://thefronthub.com/api/public-aliases.php";

const SCORE = {
  ffa_casual: 10,
  ffa_ranked: 1,
  team_casual: 5,
  team_ranked: 1,
};

// Fuseau horaire de référence pour le découpage hebdomadaire.
// Paris = UTC+1 (CET) en hiver, UTC+2 (CEST) en été. On utilise l'API
// Intl pour calculer la frontière exacte quelle que soit la période DST.
const WEEK_TZ = "Europe/Paris";

/**
 * Retourne le timestamp (ms UTC) du LUNDI 00h00 (heure de Paris)
 * de la semaine contenant `now`. Utilisé comme frontière de reset hebdo.
 *
 * Exemple : si now = mercredi 13 août 2026 15h00 Paris,
 *   getWeekStartMs(now) = lundi 10 août 2026 00h00 Paris
 *   = dimanche 9 août 2026 22h00 UTC (Paris est UTC+2 en été).
 *
 * Le reset est donc AUTOMATIQUE : dès que le calendrier passe à un nouveau
 * lundi, cette fonction renvoie la nouvelle frontière et les points hebdo
 * repartent de zéro.
 */
function getWeekStartMs(now) {
  // 1. Récupère les composantes de date dans le fuseau Paris
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: WEEK_TZ,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(new Date(now));
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  const year = parseInt(obj.year, 10);
  const month = parseInt(obj.month, 10) - 1; // 0-indexed
  const day = parseInt(obj.day, 10);
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[obj.weekday];
  if (weekday == null) return now - 7 * 24 * 60 * 60 * 1000; // fallback défensif

  // 2. Recule jusqu'à lundi (même semaine calendaire Paris)
  const diff = weekday === 0 ? -6 : 1 - weekday;

  // 3. Construit un candidat "lundi 00h00 UTC" pour cette semaine
  const candidateUtc = Date.UTC(year, month, day + diff, 0, 0, 0);

  // 4. Calcule l'offset Paris (1h ou 2h selon DST) à cet instant précis,
  //    puis corrige pour obtenir lundi 00h00 Paris exact.
  const hourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: WEEK_TZ, hour: "2-digit", hour12: false,
  });
  let parisHour = parseInt(hourFmt.format(new Date(candidateUtc)), 10);
  if (isNaN(parisHour)) parisHour = 0;
  parisHour = parisHour % 24; // gère "24" pour minuit dans certains environnements
  return candidateUtc - parisHour * 3600 * 1000;
}

async function fetchPlayerStats(publicId) {
  try {
    const res = await openFrontFetch(`${API_BASE}/public/player/${encodeURIComponent(publicId)}`);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn(`[dashboard-sync] Failed for ${publicId}: ${e.message}`);
    return null;
  }
}

async function loadConnectedPlayers() {
  try {
    const res = await fetch(TFH_ALIASES_URL, { cache: "no-store" });
    if (!res.ok) { console.warn(`[dashboard-sync] API aliases: HTTP ${res.status}`); return []; }
    const data = await res.json();
    const aliases = data.aliases || [];
    const players = [];
    const seen = new Set();
    for (const alias of aliases) {
      const publicId = String(alias.publicId || "");
      if (!publicId || !/^[A-Za-z0-9]{8}$/.test(publicId) || seen.has(publicId)) continue;
      seen.add(publicId);
      players.push({ publicId, name: alias.username || publicId, openfrontId: publicId, source: "thefronthub" });
    }
    console.log(`[dashboard-sync] API aliases: ${players.length} joueurs connectés`);
    return players;
  } catch (e) {
    console.warn(`[dashboard-sync] API aliases error: ${e.message}`);
    return [];
  }
}

function loadRankedPlayers(ranked) {
  const players = [];
  const seen = new Set();
  for (const p of [...(ranked["1v1"] || []), ...(ranked["2v2"] || [])]) {
    const pid = p.public_id;
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    players.push({ publicId: pid, name: p.username || p.accountUsername || pid, openfrontId: pid, source: "ranked" });
  }
  console.log(`[dashboard-sync] ranked.json: ${players.length} joueurs classés`);
  return players;
}

function calculatePoints(apiResponse) {
  if (!apiResponse) return { total: 0, ffa_casual: 0, ffa_ranked: 0, team_casual: 0, team_ranked: 0 };
  let tree = null;
  if (apiResponse.stats && typeof apiResponse.stats === "object") {
    tree = apiResponse.stats;
  } else if (apiResponse.Public || apiResponse.Private || apiResponse.Ranked) {
    tree = apiResponse;
  } else {
    return { total: 0, ffa_casual: 0, ffa_ranked: 0, team_casual: 0, team_ranked: 0 };
  }
  let ffaCasualWins = 0, ffaRankedWins = 0, teamCasualWins = 0, teamRankedWins = 0;
  for (const catKey of Object.keys(tree)) {
    const cat = tree[catKey];
    if (!cat || typeof cat !== "object") continue;
    for (const modeKey of Object.keys(cat)) {
      const mode = cat[modeKey];
      if (!mode || typeof mode !== "object") continue;
      let modeWins = 0;
      for (const diffKey of Object.keys(mode)) {
        const diff = mode[diffKey];
        if (diff && typeof diff === "object" && diff.wins != null) modeWins += parseInt(diff.wins, 10) || 0;
      }
      if (catKey === "Public" || catKey === "Private") {
        if (modeKey === "Free For All") ffaCasualWins += modeWins;
        else if (modeKey === "Team") teamCasualWins += modeWins;
      } else if (catKey === "Ranked") {
        if (modeKey === "1v1") ffaRankedWins += modeWins;
        else if (modeKey === "2v2") teamRankedWins += modeWins;
        else if (modeKey === "Free For All") ffaRankedWins += modeWins;
        else if (modeKey === "Team") teamRankedWins += modeWins;
      }
    }
  }
  const total = ffaCasualWins * SCORE.ffa_casual + ffaRankedWins * SCORE.ffa_ranked + teamCasualWins * SCORE.team_casual + teamRankedWins * SCORE.team_ranked;
  return { total, ffa_casual: ffaCasualWins, ffa_ranked: ffaRankedWins, team_casual: teamCasualWins, team_ranked: teamRankedWins };
}


// Fetch les victoires des DEUX dernières semaines en UN SEUL passage :
//   - semaine en cours (depuis le lundi 00h00 Paris)  → weekly_*
//   - semaine précédente (7 jours avant, lundi→lundi) → prev_weekly_*
// La semaine précédente sert aux flèches ↑/↓ du dashboard (rang actuel vs
// rang final de la semaine dernière). La pagination est la même qu'avant :
// on pousse juste la frontière d'arrêt au lundi PRÉCÉDENT au lieu du lundi
// en cours → aucune requête supplémentaire, juste 1-3 pages de plus pour
// les joueurs actifs (plafond 10 pages conservé).
// SEMAINE FIXE : quand une nouvelle semaine démarre (lundi 00h00 Paris),
// les frontières avancent automatiquement → reset sans intervention.
async function fetchWeeklyWins(publicId) {
  try {
    const weekStartMs = getWeekStartMs(Date.now());
    const prevWeekStartMs = getWeekStartMs(weekStartMs - 1); // lundi précédent 00h00 Paris
    const curStartDate = new Date(weekStartMs);
    const prevStartDate = new Date(prevWeekStartMs);
    let cursor = null;
    let ffaCasual = 0, ffaRanked = 0, teamCasual = 0, teamRanked = 0;
    let pFfaCasual = 0, pFfaRanked = 0, pTeamCasual = 0, pTeamRanked = 0;
    
    for (let page = 0; page < 10; page++) {
      let url = `${API_BASE}/public/player/${encodeURIComponent(publicId)}/games?limit=50`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      
      const res = await openFrontFetch(url);
      if (!res || !res.ok) break;
      const data = await res.json();
      const games = data.results || data.games || [];
      if (!games.length) break;
      
      let stop = false;
      for (const g of games) {
        const gameDate = g.start ? new Date(g.start) : null;
        // Arrêt dès qu'on croise une game antérieure au lundi PRÉCÉDENT
        if (gameDate && gameDate < prevStartDate) { stop = true; break; }
        if (g.result !== 'victory') continue;
        
        const mode = g.mode || g.gameMode || '';
        const type = g.type || g.gameType || '';
        const ranked = g.rankedType || '';
        // Bucket : semaine en cours (>= lundi courant) vs semaine précédente
        const isCur = gameDate && gameDate >= curStartDate;
        
        if (ranked === '1v1' || ranked === '2v2') {
          if (ranked === '1v1') { if (isCur) ffaRanked++; else pFfaRanked++; }
          else { if (isCur) teamRanked++; else pTeamRanked++; }
        } else if (mode === 'Free For All' || mode === 'FFA') {
          if (isCur) ffaCasual++; else pFfaCasual++;
        } else if (mode === 'Team') {
          if (isCur) teamCasual++; else pTeamCasual++;
        }
      }
      
      cursor = data.nextCursor || data.cursor;
      if (!cursor || stop) break;
    }
    
    return {
      ffa_casual: ffaCasual, ffa_ranked: ffaRanked, team_casual: teamCasual, team_ranked: teamRanked,
      prev_ffa_casual: pFfaCasual, prev_ffa_ranked: pFfaRanked, prev_team_casual: pTeamCasual, prev_team_ranked: pTeamRanked,
    };
  } catch (e) {
    return { ffa_casual: 0, ffa_ranked: 0, team_casual: 0, team_ranked: 0, prev_ffa_casual: 0, prev_ffa_ranked: 0, prev_team_casual: 0, prev_team_ranked: 0 };
  }
}

async function main() {
  console.log("[dashboard-sync] 🚀 Démarrage");
  if (hasExemption()) console.log("[dashboard-sync] 🔑 Exemption active");

  // Frontière de la semaine en cours (lundi 00h00 Paris). Affichée pour
  // vérifier que le reset hebdo est aligné sur le bon jour.
  const weekStartMs = getWeekStartMs(Date.now());
  const weekStartIso = new Date(weekStartMs).toISOString();
  console.log(`[dashboard-sync] 📅 Semaine en cours depuis : ${new Date(weekStartMs).toLocaleString("fr-FR", { timeZone: WEEK_TZ })} (Paris) → ${weekStartIso} (UTC)`);

  // 1. data/players.json (Discord)
  const playersData = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
  const discordPlayers = (playersData.players || []).map(p => ({
    publicId: p.openfrontId || p.publicId || p.public_id || p.id,
    name: p.name || p.username || "Unknown",
    source: "discord",
  })).filter(p => p.publicId);
  console.log(`[dashboard-sync] data/players.json: ${discordPlayers.length} joueurs Discord`);

  // 2. API MySQL public-aliases (connectés)
  const connectedPlayers = await loadConnectedPlayers();

  // 3. ranked.json (top 100 1v1 + top 100 2v2)
  let ranked = {};
  let rankedPlayers = [];
  let rankedMap = {};
  try {
    ranked = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
    rankedPlayers = loadRankedPlayers(ranked);
    for (const p of [...(ranked["1v1"] || []), ...(ranked["2v2"] || [])]) {
      if (p.public_id) {
        if (!rankedMap[p.public_id]) rankedMap[p.public_id] = {};
        if (p.elo) rankedMap[p.public_id].elo = p.elo;
        if (p.peakElo) rankedMap[p.public_id].peak_elo = p.peakElo;
        if (p.username) rankedMap[p.public_id].username = p.username;
      }
    }
  } catch (e) { console.warn("[dashboard-sync] ranked.json introuvable"); }

  // 4. Fusionner les 3 sources (déduire par publicId)
  const merged = new Map();
  for (const p of discordPlayers) if (p.publicId && !merged.has(p.publicId)) merged.set(p.publicId, p);
  for (const p of connectedPlayers) if (p.publicId && !merged.has(p.publicId)) merged.set(p.publicId, p);
  for (const p of rankedPlayers) if (p.publicId && !merged.has(p.publicId)) merged.set(p.publicId, p);

  const allPlayers = [...merged.values()];
  console.log(`[dashboard-sync] Total: ${allPlayers.length} joueurs (${discordPlayers.length} Discord + ${connectedPlayers.length} connectés + ${rankedPlayers.length} Ranked)`);

  // 5. Fetch stats
  const results = [];
  const chunks = [];
  for (let i = 0; i < allPlayers.length; i += CONCURRENCY) chunks.push(allPlayers.slice(i, i + CONCURRENCY));

  let done = 0;
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (player) => {
      const publicId = player.publicId;
      const username = player.name || rankedMap[publicId]?.username || "Unknown";
      if (!publicId) return;

      const stats = await fetchPlayerStats(publicId);
      const points = calculatePoints(stats);
      const elo = rankedMap[publicId] || {};

      // Pour les joueurs ranked-only (pas de stats API), utiliser ranked.json directement
      let finalPoints = points.total;
      let ffaRanked = points.ffa_ranked;
      let teamRanked = points.team_ranked;
      if (finalPoints === 0 && elo.elo) {
        // Joueur ranked mais pas de stats casual → utiliser wins de ranked.json
        const r1v1 = (ranked["1v1"] || []).find(p => p.public_id === publicId);
        const r2v2 = (ranked["2v2"] || []).find(p => p.public_id === publicId);
        ffaRanked = r1v1?.wins || 0;
        teamRanked = r2v2?.wins || 0;
        finalPoints = ffaRanked * SCORE.ffa_ranked + teamRanked * SCORE.team_ranked;
      }

      // Fetch weekly wins (semaine en cours + précédente, un seul passage)
      const weekly = await fetchWeeklyWins(publicId);
      const weeklyPoints = weekly.ffa_casual * SCORE.ffa_casual + weekly.ffa_ranked * SCORE.ffa_ranked + weekly.team_casual * SCORE.team_casual + weekly.team_ranked * SCORE.team_ranked;
      const prevWeeklyPoints = weekly.prev_ffa_casual * SCORE.ffa_casual + weekly.prev_ffa_ranked * SCORE.ffa_ranked + weekly.prev_team_casual * SCORE.team_casual + weekly.prev_team_ranked * SCORE.team_ranked;
      
      results.push({
        publicId, username,
        points: finalPoints,
        ffa_casual: points.ffa_casual,
        ffa_ranked: ffaRanked,
        team_casual: points.team_casual,
        team_ranked: teamRanked,
        weekly_ffa_casual: weekly.ffa_casual,
        weekly_ffa_ranked: weekly.ffa_ranked,
        weekly_team_casual: weekly.team_casual,
        weekly_team_ranked: weekly.team_ranked,
        weekly_points: weeklyPoints,
        // Semaine précédente (rang final) → flèches ↑/↓ du dashboard
        prev_weekly_ffa_casual: weekly.prev_ffa_casual,
        prev_weekly_ffa_ranked: weekly.prev_ffa_ranked,
        prev_weekly_team_casual: weekly.prev_team_casual,
        prev_weekly_team_ranked: weekly.prev_team_ranked,
        prev_weekly_points: prevWeeklyPoints,
        elo: elo.elo || null,
        peak_elo: elo.peak_elo || null,
      });

      done++;
      if (done % 20 === 0) console.log(`[dashboard-sync] ${done}/${allPlayers.length} traités`);
    }));
  }

  results.sort((a, b) => b.points - a.points);

  const output = {
    lastUpdate: new Date().toISOString(),
    weekStart: weekStartIso, // lundi 00h00 Paris = frontière de reset hebdo
    totalPlayers: results.length,
    players: results,
  };
  const json = JSON.stringify(output);
  fs.writeFileSync(OUTPUT_FILE, json);
  fs.writeFileSync(OUTPUT_FILE + ".gz", zlib.gzipSync(json));

  console.log(`[dashboard-sync] ✅ ${results.length} joueurs — ${(zlib.gzipSync(json).length / 1024).toFixed(1)} KB`);
  console.log(`[dashboard-sync] 🏁 Top 3:`);
  for (const p of results.slice(0, 3)) console.log(`  ${p.username} (${p.publicId}): ${p.points} pts`);
}

main().catch(e => { console.error("[dashboard-sync] Fatal:", e); process.exit(1); });
