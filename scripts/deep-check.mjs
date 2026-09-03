// deep-check.mjs — Analyse fine d'un joueur : structure des games + points carrière
const API = "https://api.openfront.io";
const headers = { "User-Agent": "skailex" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PID = process.argv[2] || "nijRHQpV";
const PAGES = parseInt(process.argv[3] || "12", 10);

function getWeekStartMs(now = Date.now()) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const obj = {};
  for (const p of fmt.formatToParts(new Date(now))) obj[p.type] = p.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[obj.weekday];
  const diff = wd === 0 ? -6 : 1 - wd;
  const c = Date.UTC(+obj.year, +obj.month - 1, +obj.day + diff, 0, 0, 0);
  const hf = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false });
  let ph = parseInt(hf.format(new Date(c)), 10) || 0;
  return c - (ph % 24) * 3600000;
}

async function api(path) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${API}${path}`, { headers });
    if (res.status === 429) { await sleep(2000); continue; }
    if (!res.ok) return null;
    return res.json();
  }
  return null;
}

const weekStartMs = getWeekStartMs();
console.log(`Joueur ${PID} · semaine depuis ${new Date(weekStartMs).toISOString()}`);

// 1. Arbre de stats → points carrière (méthode serveur calculatePoints)
const profile = await api(`/public/player/${PID}`);
if (profile) {
  const tree = profile.stats || {};
  let ffaCasual = 0, ffaRanked = 0, teamCasual = 0, teamRanked = 0;
  for (const catKey of Object.keys(tree)) {
    const cat = tree[catKey] || {};
    for (const modeKey of Object.keys(cat)) {
      const mode = cat[modeKey] || {};
      let mw = 0;
      for (const d of Object.keys(mode)) mw += (mode[d] && mode[d].wins != null) ? parseInt(mode[d].wins, 10) || 0 : 0;
      if (catKey === "Public" || catKey === "Private") {
        if (modeKey === "Free For All") ffaCasual += mw;
        else if (modeKey === "Team") teamCasual += mw;
      } else if (catKey === "Ranked") {
        if (modeKey === "1v1") ffaRanked += mw;
        else if (modeKey === "2v2") teamRanked += mw;
      }
    }
  }
  const pts = ffaCasual * 10 + ffaRanked * 1 + teamCasual * 5 + teamRanked * 1;
  console.log(`Carrière recalculée : ${pts} pts [FFA ${ffaCasual} · 1v1 ${ffaRanked} · Team ${teamCasual} · 2v2 ${teamRanked}]`);
  console.log(`Stats tree catégories : ${Object.keys(tree).join(", ")}`);
  if (tree.Ranked) console.log(`  Ranked modes : ${Object.keys(tree.Ranked).join(", ")}`);
} else console.log("⚠️ stats joueur indisponibles");

// 2. Structure des games page par page
let cursor = null;
for (let page = 0; page < PAGES; page++) {
  const data = await api(`/public/player/${PID}/games?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (!data) { console.log(`page ${page}: ERREUR`); break; }
  const games = data.results || [];
  if (!games.length) { console.log(`page ${page}: vide`); break; }
  let noStart = 0, minT = Infinity, maxT = 0;
  const results = {};
  for (const g of games) {
    const t = g.start ? new Date(g.start).getTime() : 0;
    if (!t) noStart++;
    else { if (t < minT) minT = t; if (t > maxT) maxT = t; }
    results[g.result] = (results[g.result] || 0) + 1;
  }
  const d = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
  console.log(`page ${page}: ${games.length} games · ${d(minT)} → ${d(maxT)} UTC · sans date:${noStart} · ${JSON.stringify(results)} · dans semaine: ${games.filter((g) => g.start && new Date(g.start) >= weekStartMs).length}`);
  cursor = data.nextCursor || data.cursor;
  if (!cursor) { console.log("fin de l'historique atteinte"); break; }
  await sleep(120);
}
