// reconstruct-weekly.mjs — Reconstitution a posteriori des semaines manquantes
// de weekly_history.json.gz (ex. S3 = 2026-09-06, S4 = 2026-09-13, perdues
// pendant l'indisponibilité du sync-dashboard).
//
// Méthode : identique à sync-dashboard.js (fetchWeeklyWins) —
//   - victoires uniquement (result === "victory")
//   - buckets via rankedType/mode EXACTEMENT comme sync-dashboard.js :
//       rankedType "1v1"            → ffa_ranked
//       rankedType "2v2"            → team_ranked
//       mode "Free For All"|"FFA"   → ffa_casual
//       mode "Team"                 → team_casual
//   - points t = ffa_casual×10 + team_casual×5 + ffa_ranked×1 + team_ranked×1
//   - f = ffa_casual + ffa_ranked ; te = team_casual + team_ranked ;
//     r = ffa_ranked + team_ranked ; k = rang (tri t desc)
//   - snapshot pour TOUS les joueurs suivis (même 0 pt), comme la sync.
//
// Modes :
//   node reconstruct-weekly.mjs validate [N]   → recalcule S5 pour N joueurs
//                                                 du top et compare à
//                                                 l'historique enregistré
//   node reconstruct-weekly.mjs run            → reconstruit S3+S4 et écrit
//                                                 /tmp/weekly_history_fixed.json
//                                                 (+ .gz)

import fs from "fs";
import zlib from "zlib";

const API = "https://api.openfront.io";
const UA = "skailex";
const MODE = process.argv[2] || "validate";
const VALIDATE_N = parseInt(process.argv[3] || "12", 10);

// Bornes de semaines (lundi 00h00 Paris = dimanche 22h00 UTC, CEST)
const S3_START = Date.parse("2026-09-06T22:00:00.000Z");
const S4_START = Date.parse("2026-09-13T22:00:00.000Z");
const S5_START = Date.parse("2026-09-20T22:00:00.000Z");
const S6_START = Date.parse("2026-09-27T22:00:00.000Z");

const SCORE = { ffa_casual: 10, ffa_ranked: 1, team_casual: 5, team_ranked: 1 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Classification VERBATIM de sync-dashboard.js (fetchWeeklyWins) ──
function bucketWin(g) {
  if (g.result !== "victory") return null;
  const mode = g.mode || g.gameMode || "";
  const ranked = g.rankedType || "";
  if (ranked === "1v1") return "ffa_ranked";
  if (ranked === "2v2") return "team_ranked";
  if (mode === "Free For All" || mode === "FFA") return "ffa_casual";
  if (mode === "Team") return "team_casual";
  return null; // autre mode → non compté (idem sync)
}

async function apiJson(path, attempts = 8) {
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(`${API}${path}`, { headers: { "User-Agent": UA } });
      if (res.status === 429) { await sleep(6000 * (a + 1)); continue; }
      if (!res.ok) { await sleep(1500 * (a + 1)); continue; }
      return await res.json();
    } catch { await sleep(2000 * (a + 1)); }
  }
  return null;
}

// Scanne TOUTES les games à partir de `sinceMs` (stop dès qu'une game est plus vieille).
// Retourne les victoires bucketées par semaine : { S3:{...}, S4:{...}, S5:{...} }
async function scanPlayer(publicId, sinceMs, bounds) {
  const wins = {};
  for (const key of Object.keys(bounds)) {
    wins[key] = { ffa_casual: 0, ffa_ranked: 0, team_casual: 0, team_ranked: 0, games: 0 };
  }
  let cursor = null, pages = 0, reached = false, truncated = false;
  for (let page = 0; page < 220; page++) {
    const data = await apiJson(`/public/player/${encodeURIComponent(publicId)}/games${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!data) { truncated = true; break; }
    const games = data.results || data.games || [];
    if (!games.length) { break; }
    pages++;
    let stop = false;
    for (const g of games) {
      const t = g.start ? Date.parse(g.start) : 0;
      if (t && t < sinceMs) { stop = true; break; }
      const b = bucketWin(g);
      if (!b || !t) continue;
      for (const [key, [from, to]] of Object.entries(bounds)) {
        if (t >= from && t < to) { wins[key][b]++; wins[key].games++; }
      }
    }
    if (stop) { reached = true; break; }
    cursor = data.nextCursor || data.cursor;
    if (!cursor) { reached = true; break; }
    await sleep(220);
  }
  if (!reached) truncated = true; // plafond de pages atteint sans revenir assez loin
  return { wins, pages, truncated };
}

function toSnapshotEntry(w) {
  const t = w.ffa_casual * SCORE.ffa_casual + w.team_casual * SCORE.team_casual + w.ffa_ranked * SCORE.ffa_ranked + w.team_ranked * SCORE.team_ranked;
  return {
    t,
    f: w.ffa_casual + w.ffa_ranked,
    te: w.team_casual + w.team_ranked,
    r: w.ffa_ranked + w.team_ranked,
  };
}

async function main() {
  const hist = JSON.parse(zlib.gunzipSync(fs.readFileSync("/tmp/wh_main.json.gz")));
  const universe = JSON.parse(fs.readFileSync("/tmp/universe.json", "utf8"));
  console.log(`[reconstruct] univers: ${universe.length} joueurs · mode: ${MODE}`);

  if (MODE === "validate") {
    // ── VALIDATION : recalcule la semaine S5 enregistrée et compare ──
    const w5 = hist.weeks["2026-09-20"];
    const recorded = Object.entries(w5.players)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, VALIDATE_N);
    const bounds = { S5: [S5_START, S6_START] };
    let mismatch = 0;
    for (const [pid, rec] of recorded) {
      const { wins, pages, truncated } = await scanPlayer(pid, S5_START, bounds);
      const mine = toSnapshotEntry(wins.S5);
      const ok = mine.t === rec.t && mine.f === rec.f && mine.te === rec.te && mine.r === rec.r;
      if (!ok) mismatch++;
      console.log(`${ok ? "OK " : "MISMATCH "} ${pid} enregistre t=${rec.t} f=${rec.f} te=${rec.te} r=${rec.r} | recalcule t=${mine.t} f=${mine.f} te=${mine.te} r=${mine.r} (${pages} pages${truncated ? ", TRONQUE" : ""})`);
      await sleep(220);
    }
    console.log(mismatch === 0 ? `\nVALIDATION OK — methode fidele (0 divergence sur ${VALIDATE_N})` : `\n${mismatch}/${VALIDATE_N} divergences — NE PAS utiliser sans corriger`);
    process.exit(mismatch === 0 ? 0 : 2);
  }

  if (MODE === "run") {
    const bounds = {
      S3: [S3_START, S4_START],
      S4: [S4_START, S5_START],
    };
    const STATE_FILE = "/tmp/reconstruct-state.json";
    let results = {}, truncatedCount = 0;
    try { results = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { /* 1er passage */ }
    const queue = universe.filter((pid) => !results[pid]);
    console.log(`[reconstruct] deja scannes: ${Object.keys(results).length} · restants: ${queue.length}`);
    let done = 0, truncated = 0;
    const t0 = Date.now();
    const CONC = 4;
    const q = [...queue];
    async function worker(id) {
      while (q.length) {
        const pid = q.shift();
        if (!pid) break;
        const { wins, pages, truncated: tr } = await scanPlayer(pid, S3_START, bounds);
        results[pid] = wins;
        if (tr) truncated++;
        done++;
        if (done % 10 === 0) {
          fs.writeFileSync(STATE_FILE, JSON.stringify(results));
          console.log(`  ... ${done}/${queue.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        }
        await sleep(150);
      }
    }
    await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
    fs.writeFileSync(STATE_FILE, JSON.stringify(results));
    truncatedCount = truncated;
    console.log(`[reconstruct] scan termine en ${((Date.now() - t0) / 1000).toFixed(0)}s — tronques (a verifier): ${truncatedCount}`);

    // Construit les snapshots (k = rang par t desc, inclut les 0 comme la sync)
    for (const [key, wkStartIso] of [["S3", "2026-09-06T22:00:00.000Z"], ["S4", "2026-09-13T22:00:00.000Z"]]) {
      const snap = {};
      for (const pid of Object.keys(results)) snap[pid] = toSnapshotEntry(results[pid][key]);
      const sorted = Object.entries(snap).sort((a, b) => b[1].t - a[1].t);
      const snapOrdered = {};
      sorted.forEach(([pid, v], idx) => { snapOrdered[pid] = { t: v.t, f: v.f, te: v.te, r: v.r, k: idx + 1 }; });
      hist.weeks[key === "S3" ? "2026-09-06" : "2026-09-13"] = { start: wkStartIso, players: snapOrdered };
      const top3 = sorted.slice(0, 3).map(([pid, v]) => `${pid}:t=${v[Object.keys(v)[0]] && v.t}`).join(" · ");
      console.log(`[reconstruct] ${key} → ${Object.keys(snapOrdered).length} joueurs`);
    }

    // Réordonne les semaines
    const ordered = {};
    for (const k of Object.keys(hist.weeks).sort()) ordered[k] = hist.weeks[k];
    hist.weeks = ordered;

    const json = JSON.stringify(hist);
    fs.writeFileSync("/tmp/weekly_history_fixed.json", json);
    fs.writeFileSync("/tmp/weekly_history_fixed.json.gz", zlib.gzipSync(json));
    const nz3 = Object.values(hist.weeks["2026-09-06"].players).filter(p => p.t > 0).length;
    const nz4 = Object.values(hist.weeks["2026-09-13"].players).filter(p => p.t > 0).length;
    console.log(`[reconstruct] ecrit /tmp/weekly_history_fixed.json(.gz) — S3: ${nz3} joueurs >0pt · S4: ${nz4} joueurs >0pt`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
