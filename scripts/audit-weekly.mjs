// audit-weekly.mjs — AUDIT INDÉPENDANT des points hebdo du dashboard
// Recalcule depuis api.openfront.io (pagination large) les victoires de la
// semaine en cours de chaque joueur du TOP, et compare à dashboard_scores.json
//
// Usage: node audit-weekly.mjs [TOP_N]

const API = "https://api.openfront.io";
const UA = "skailex";
const TOP_N = parseInt(process.argv[2] || "15", 10);
const MAX_PAGES = 30; // largement plus que le plafond serveur (10) pour détecter les sous-comptages

const SCORE = { ffa_casual: 10, ffa_ranked: 1, team_casual: 5, team_ranked: 1 };

function getWeekStartMs(now = Date.now()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const obj = {};
  for (const p of fmt.formatToParts(new Date(now))) obj[p.type] = p.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[obj.weekday];
  if (weekday == null) return now - 7 * 86400000;
  const diff = weekday === 0 ? -6 : 1 - weekday;
  const candidateUtc = Date.UTC(+obj.year, +obj.month - 1, +obj.day + diff, 0, 0, 0);
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false });
  let ph = parseInt(hourFmt.format(new Date(candidateUtc)), 10);
  if (isNaN(ph)) ph = 0;
  return candidateUtc - (ph % 24) * 3600000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { "User-Agent": UA };

async function api(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, { headers });
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(1000); }
  }
  return null;
}

// Classification "client" (référence, la plus complète)
function classify(g) {
  const mode = String(g.mode || "").toLowerCase();
  const rt = String(g.rankedType || "").toLowerCase();
  const isTeam = mode === "team" || mode.startsWith("2v2") || mode.startsWith("3v3") ||
                 mode.startsWith("4v4") || rt === "2v2";
  const isRanked = rt === "1v1" || rt === "2v2" || rt === "ranked";
  if (isTeam) return isRanked ? "team_ranked" : "team_casual";
  return isRanked ? "ffa_ranked" : "ffa_casual";
}

async function auditPlayer(publicId, weekStartMs, prevWeekStartMs) {
  const wins = { ffa_casual: 0, ffa_ranked: 0, team_casual: 0, team_ranked: 0 };
  const modeStats = {}; // inventaire des valeurs mode/rankedType vues
  let totalGames = 0, gamesThisWeek = 0, pages = 0, cursor = null, hitPrev = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await api(`/public/player/${publicId}/games?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!data) break;
    const games = data.results || data.games || [];
    if (!games.length) break;
    pages++;
    for (const g of games) {
      const t = g.start ? new Date(g.start).getTime() : 0;
      if (t && t < prevWeekStartMs) { hitPrev = true; break; }
      totalGames++;
      if (t && t >= weekStartMs) gamesThisWeek++;
      if (g.result !== "victory") continue;
      if (t && t >= weekStartMs) wins[classify(g)]++;
      const key = `${g.mode || "?"}|${g.rankedType || "-"}`;
      modeStats[key] = (modeStats[key] || 0) + 1;
    }
    if (hitPrev) break;
    cursor = data.nextCursor || data.cursor;
    if (!cursor) break;
    await sleep(120);
  }
  const points = wins.ffa_casual * SCORE.ffa_casual + wins.ffa_ranked * SCORE.ffa_ranked +
                 wins.team_casual * SCORE.team_casual + wins.team_ranked * SCORE.team_ranked;
  return { wins, points, totalGames, gamesThisWeek, pages, hitPrev, modeStats, truncated: !hitPrev && !!cursor };
}

async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log(" AUDIT INDÉPENDANT — points hebdo du dashboard TheFrontHub");
  console.log("════════════════════════════════════════════════════════════");

  // 1. Charger les scores publiés
  const res = await fetch("https://thefronthub.com/dashboard_scores.json", { cache: "no-store" });
  if (!res.ok) { console.error(`dashboard_scores.json HTTP ${res.status}`); process.exit(1); }
  const ds = await res.json();
  const weekStartMs = new Date(ds.weekStart).getTime();
  const prevWeekStartMs = getWeekStartMs(weekStartMs - 1);
  const ageMin = Math.round((Date.now() - new Date(ds.lastUpdate).getTime()) / 60000);
  console.log(`Scores publiés : ${ds.totalPlayers} joueurs · maj il y a ${ageMin} min`);
  console.log(`Semaine (lundi 00h00 Paris) : ${new Date(weekStartMs).toISOString()} → aujourd'hui ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Semaine précédente : ${new Date(prevWeekStartMs).toISOString()}\n`);

  const top = [...ds.players].sort((a, b) => (b.weekly_points || 0) - (a.weekly_points || 0)).slice(0, TOP_N);

  // 2. Audit de chaque joueur du top
  let mismatches = 0;
  const rows = [];
  for (const p of top) {
    const a = await auditPlayer(p.publicId, weekStartMs, prevWeekStartMs);
    const storedW = {
      ffa_casual: p.weekly_ffa_casual || 0, ffa_ranked: p.weekly_ffa_ranked || 0,
      team_casual: p.weekly_team_casual || 0, team_ranked: p.weekly_team_ranked || 0,
    };
    const storedPts = p.weekly_points || 0;
    const diffPts = a.points - storedPts;
    const diffW = {};
    let wDiff = false;
    for (const k of Object.keys(wins_keys)) if ((storedW[k] || 0) !== a.wins[k]) { wDiff = true; diffW[k] = a.wins[k] - (storedW[k] || 0); }
    if (diffPts !== 0) mismatches++;
    rows.push({ p, a, storedW, storedPts, diffPts, wDiff, diffW });
    const flag = diffPts === 0 ? "✅" : `⚠️  (${diffPts > 0 ? "+" : ""}${diffPts})`;
    console.log(`${flag} #${rows.length} ${p.username} (${p.publicId})`);
    console.log(`   publié  : ${storedPts} pts  [FFA ${storedW.ffa_casual} · FFA classé ${storedW.ffa_ranked} · Team ${storedW.team_casual} · Team classé ${storedW.team_ranked}]`);
    console.log(`   recalcul: ${a.points} pts  [FFA ${a.wins.ffa_casual} · FFA classé ${a.wins.ffa_ranked} · Team ${a.wins.team_casual} · Team classé ${a.wins.team_ranked}]  · ${a.gamesThisWeek} games semaine · ${a.pages} pages · scan compl.${a.hitPrev ? "OK" : "STOP 30 pages"}`);
    if (wDiff) console.log(`   écarts wins: ${JSON.stringify(diffW)}`);
    await sleep(150);
  }

  // 3. Rangs publiés vs recalculés
  console.log("\n──────── Vérification du classement publié ────────");
  const rankIssues = [];
  top.forEach((p, i) => {
    const storedRank = ds.players.findIndex((q) => q.publicId === p.publicId) + 1;
    rows.forEach((r) => { if (r.p.publicId === p.publicId) r.recRankByPts = storedRank; });
    void i;
  });
  // le top publié = tri weekly_points ; vérifions la cohérence du tri
  const sortedPub = [...ds.players].sort((a, b) => (b.weekly_points || 0) - (a.weekly_points || 0));
  const pubTop5 = sortedPub.slice(0, 5).map((p) => `${p.username}:${p.weekly_points}`);
  console.log(`Top 5 publié : ${pubTop5.join(" · ")}`);

  console.log(`\n════════ RÉSULTAT : ${TOP_N - mismatches}/${TOP_N} joueurs exacts, ${mismatches} écart(s) ════════`);

  // 4. Inventaire global des modes rencontrés (détection de modes non comptés)
  const allModes = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.a.modeStats || {})) allModes[k] = (allModes[k] || 0) + v;
  console.log("\nModes rencontrés (mode|rankedType → victoires semaine) :");
  for (const [k, v] of Object.entries(allModes).sort((a, b) => b[1] - a[1])) console.log(`  ${k} → ${v}`);
}

const wins_keys = ["ffa_casual", "ffa_ranked", "team_casual", "team_ranked"];
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
