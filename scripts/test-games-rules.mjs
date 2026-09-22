/**
 * scripts/test-games-rules.mjs — Validation des règles d'ingestion games-sync.php
 * contre l'API OpenFront LIVE (miroir exact de classify_speedrun / winner mapping).
 *
 *   node scripts/test-games-rules.mjs
 *
 * Vérifie :
 *   1. /public/games pagination + filtres
 *   2. Roster : chaque joueur a publicID (ère publicID) / clientID / username
 *   3. classify_speedrun : FFA Normal 400 bots sans mod = 'normal', etc.
 *   4. Winner mapping player + team (ids gagnants tous dans le roster)
 *   5. Durée en secondes (post-v34) et pré-calcul -32s
 */
import https from "https";

const API = "https://api.openfront.io";
const UA = "TheFrontHub-RulesTest/1.0";
const TIME_OFFSET_S = 32;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// ── Miroir de classify_speedrun() PHP ──
function classify(info) {
  const cfg = info?.config ?? {};
  if (cfg.gameType !== "Public") return null;
  if (cfg.gameMode !== "Free For All") return null;
  let isCompact = null;
  if (cfg.gameMapSize === "Compact" && Number(cfg.bots) === 100) isCompact = true;
  else if (cfg.gameMapSize === "Normal" && Number(cfg.bots) === 400) isCompact = false;
  else return null;
  const mods = cfg.publicGameModifiers ?? {};
  const active = Object.keys(mods).filter((k) => mods[k]);
  if (isCompact) { if (active.some((a) => a !== "isCompact")) return null; }
  else if (active.length) return null;
  if (cfg.randomSpawn === true || cfg.donateGold === true || cfg.donateTroops === true) return null;
  if (cfg.infiniteGold || cfg.infiniteTroops || cfg.instantBuild) return null;
  if (cfg.startingGold != null && Number(cfg.startingGold) !== 0) return null;
  if (cfg.goldMultiplier != null && Number(cfg.goldMultiplier) !== 1) return null;
  const players = info.players ?? [];
  if (players.length < (isCompact ? 3 : 10)) return null;
  const w = info.winner;
  if (!Array.isArray(w) || w.length < 2) return null;
  if (w[0] !== "player") return null;
  const winner = players.find((p) => p.clientID === w[1]);
  if (!winner?.username) return null;
  let dur = null;
  if (info.duration != null) dur = info.duration > 100000 ? Math.round(info.duration / 1000) : info.duration;
  else if (info.start != null && info.end != null) {
    const d = info.end - info.start;
    dur = d > 100000 ? Math.round(d / 1000) : d;
  }
  if (dur == null || dur < 60) return null;
  return { category: isCompact ? "compact" : "normal", durationS: Math.max(0, dur - TIME_OFFSET_S), winnerClientId: w[1], winnerPublicId: winner.publicID ?? null };
}

// ── Winner mapping (player + team) ──
function winnerCids(winner) {
  if (!Array.isArray(winner) || winner.length < 2) return [];
  if (winner[0] === "player") return [winner[1]];
  if (winner[0] === "team") return winner.slice(2).map(String);
  return [];
}

let failures = 0;
function check(cond, label) {
  console.log((cond ? "  ✅ " : "  ❌ ") + label);
  if (!cond) failures++;
}

async function main() {
  console.log("\n═══ Test règles d'ingestion (API live) ═══\n");

  // 1) Pagination + filtres
  const now = new Date();
  const start = new Date(now.getTime() - 6 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const end = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const list = await get(`${API}/public/games?start=${start}&end=${end}&type=Public&limit=1000`);
  check(Array.isArray(list), `liste /public/games : ${list.length} parties publiques sur 6h`);
  const ffa = list.filter((g) => g.mode === "Free For All");
  const team = list.filter((g) => g.mode === "Team");
  console.log(`  → FFA: ${ffa.length}, Team: ${team.length}`);

  // 2) Roster + publicID sur un échantillon
  const sample = list.filter((g) => (g.numPlayers ?? 0) >= 10).slice(0, 6);
  let allHavePids = true, rostersOk = true;
  const speedruns = [];
  const teamWinnersOk = [];
  for (const g of sample) {
    const d = await get(`${API}/public/game/${g.game}?turns=false`);
    const info = d.info;
    const players = info.players ?? [];
    if (!players.every((p) => p.clientID && p.username)) rostersOk = false;
    if (!players.every((p) => typeof p.publicID === "string" && p.publicID.length >= 6)) allHavePids = false;
    // 3) classification
    const sr = classify(info);
    if (sr) speedruns.push({ id: info.gameID, ...sr });
    // 4) winner mapping
    if ((info.config?.gameMode) === "Team" && Array.isArray(info.winner) && info.winner[0] === "team") {
      const cids = winnerCids(info.winner);
      const rosterIds = new Set(players.map((p) => p.clientID));
      teamWinnersOk.push({ id: info.gameID, ok: cids.length > 0 && cids.every((c) => rosterIds.has(c)) });
    }
  }
  check(rostersOk, "roster : chaque joueur a clientID + username");
  check(allHavePids, "roster : chaque joueur a un publicID (ère publicID)");
  check(teamWinnersOk.every((t) => t.ok) && teamWinnersOk.length > 0 || teamWinnersOk.length === 0,
    `winner team : tous les ids gagnants dans le roster (${teamWinnersOk.filter(t=>t.ok).length}/${teamWinnersOk.length})`);

  // 5) speedruns détectés
  console.log(`  → ${speedruns.length} speedrun(s) valide(s) dans l'échantillon`);
  for (const s of speedruns.slice(0, 5)) {
    console.log(`     ${s.category} — ${s.durationS}s — winner ${s.winnerPublicId} (${s.id})`);
    check(s.durationS > 0 && s.winnerPublicId, `speedrun ${s.id} cohérent`);
  }

  // 6) Durée : post-v34 = secondes
  const anyDetail = await get(`${API}/public/game/${sample[0].game}?turns=false`);
  check(anyDetail.info.duration < 100000, `duration_s en secondes (got ${anyDetail.info.duration})`);

  console.log(failures === 0 ? "\n✅ TOUTES LES RÈGLES VALIDÉES\n" : `\n❌ ${failures} échec(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERREUR:", e.message); process.exit(2); });
