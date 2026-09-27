import fs from "fs";
import { API_BASE, openFrontFetch } from "../openfront-api.js";

// ─────────────────────────────────────────────────────────────────────────────
// sync-mirrors.js — v5.12b (2026-09-27)
//
// CONSTAT (v5.12 en prod) : le WAF Cloudflare renvoie 403 pour plusieurs
// routes officielles quand elles sont appelées depuis l'IP datacenter
// o2switch (/leaderboard/public/ffa, /leaderboard/tribes, /news.json,
// /streams.json, /public/clan/:tag/sessions) — même avec la clé et des
// en-têtes navigateur. C'est le même problème que /leaderboard/ranked
// (constat v5.11) → même solution : MIROIR via GitHub Actions (IP Azure
// tolérées), publié en assets de la release data-latest, puis ingéré par
// api/games-sync.php.
//
// Assets publiés (noms préfixés of_ pour zéro collision) :
//   of_ffa.json          → tableau du board FFA officiel (shape API)
//   of_tribes.json       → objet {windowDays, start, end, tribes:[...]}
//   of_news.json         → tableau des annonces (shape API)
//   of_streams.json      → objet {verifiedAt, featured:[], live:[...]}
//   of_clansessions.json → {fetchedAt, start, end, clans:{TAG:[sessions]}}
//   of_clansess_state.json → état interne {lastStart} (fenêtre incrémentale)
//
// Chaque flux est INDÉPENDANT : un échec ne bloque pas les autres.
// ─────────────────────────────────────────────────────────────────────────────

const OUT_FILES = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await openFrontFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function writeOut(name, data) {
  fs.writeFileSync(name, JSON.stringify(data));
  OUT_FILES.push(name);
  console.log(`[mirrors] ✅ ${name} écrit`);
}

/* 1) Board FFA officiel — top 1000 (tri wins côté API). */
async function mirrorFfa() {
  const d = await fetchJson(`${API_BASE}/leaderboard/public/ffa`);
  if (!Array.isArray(d)) throw new Error("ffa: payload inattendu");
  await writeOut("of_ffa.json", d.slice(0, 1000));
}

/* 2) Ladder des tribus (fenêtre 30 j). */
async function mirrorTribes() {
  const d = await fetchJson(`${API_BASE}/leaderboard/tribes`);
  if (!d || !Array.isArray(d.tribes)) throw new Error("tribes: payload inattendu");
  await writeOut("of_tribes.json", d);
}

/* 3) News officielles. */
async function mirrorNews() {
  const d = await fetchJson(`${API_BASE}/news.json`);
  if (!Array.isArray(d)) throw new Error("news: payload inattendu");
  await writeOut("of_news.json", d);
}

/* 4) Streams live. */
async function mirrorStreams() {
  const d = await fetchJson(`${API_BASE}/streams.json`);
  if (!d || typeof d !== "object") throw new Error("streams: payload inattendu");
  await writeOut("of_streams.json", d);
}

/* 5) Sessions des top clans officiels — fenêtre incrémentale (état local). */
async function mirrorClanSessions() {
  // État : fenêtre depuis le dernier passage COMPLET (1 h de chevauchement).
  let lastStart = Date.now() - 6 * 3600 * 1000;
  try {
    const st = JSON.parse(fs.readFileSync("of_clansess_state.json", "utf8"));
    if (Number.isFinite(st.lastStart)) lastStart = st.lastStart;
  } catch (e) { /* premier run */ }
  let startTs = Math.min(lastStart - 3600 * 1000, Date.now() - 10 * 60 * 1000);
  if (Date.now() - startTs > 23 * 3600 * 1000) startTs = Date.now() - 23 * 3600 * 1000;
  const startIso = new Date(startTs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const endIso = new Date(Date.now() - 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  // Top 50 clans officiels par weightedWins.
  const lb = await fetchJson(`${API_BASE}/public/clans/leaderboard`);
  const clansArr = Array.isArray(lb?.clans) ? lb.clans : [];
  const tags = clansArr
    .slice()
    .sort((a, b) => (b.weightedWins ?? 0) - (a.weightedWins ?? 0))
    .slice(0, 50)
    .map((c) => String(c.tag || "").toUpperCase())
    .filter(Boolean);
  if (!tags.length) throw new Error("clansess: aucun clan dans le leaderboard");

  const clans = {};
  let total = 0;
  for (const tag of tags) {
    const sessions = [];
    for (let page = 1; page <= 8; page++) {
      const url = `${API_BASE}/public/clan/${encodeURIComponent(tag)}/sessions?start=${startIso}&end=${endIso}&page=${page}&limit=100`;
      let rows = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { rows = (await fetchJson(url))?.results ?? null; break; }
        catch (e) {
          if (attempt === 3) console.warn(`[mirrors] clansess ${tag} p${page}: ${e.message}`);
          else await sleep(1500);
        }
      }
      if (!Array.isArray(rows)) break;
      sessions.push(...rows);
      if (rows.length < 100) break;
      await sleep(300); // pacing gentil côté API
    }
    clans[tag] = sessions;
    total += sessions.length;
  }
  await writeOut("of_clansessions.json", { fetchedAt: new Date().toISOString(), start: startIso, end: endIso, clans });
  // Fenêtre ancrée à la fin de CE run (reprise exacte au prochain passage).
  fs.writeFileSync("of_clansess_state.json", JSON.stringify({ lastStart: Date.now() - 10 * 60 * 1000 }));
  OUT_FILES.push("of_clansess_state.json");
  console.log(`[mirrors] clansess: ${total} session(s) pour ${tags.length} clan(s) (${startIso} → ${endIso})`);
}

/* ── main ── */
const jobs = [
  ["ffa", mirrorFfa],
  ["tribes", mirrorTribes],
  ["news", mirrorNews],
  ["streams", mirrorStreams],
  ["clansess", mirrorClanSessions],
];
let ok = 0;
for (const [name, fn] of jobs) {
  try { await fn(); ok++; }
  catch (e) { console.warn(`[mirrors] ⚠️ ${name}: ${e.message}`); }
}
console.log(`[mirrors] terminé — ${ok}/${jobs.length} flux OK, fichiers: ${OUT_FILES.join(", ") || "aucun"}`);
if (OUT_FILES.length === 0) process.exit(1); // rien à publier → le job sort en échec doux
