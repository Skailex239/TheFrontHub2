/**
 * scripts/gen-ranked-preview.js — Aperçu statique du top 100 pour dashboard.html
 *
 * 🎯 Pourquoi : le dashboard affiche « Chargement du classement… » tant que
 * ranked.json + l'API live ne sont pas arrivés. Les robots d'indexation
 * (Googlebot) et les connexions lentes peuvent donc voir une section vide.
 * On injecte à la place un APERÇU PRÉ-GÉNÉRÉ du top 100 (même markup que le
 * rendu live : .dash-grid / .dash-panel / .dash-row), remplacé automatiquement
 * dès que le classement live est prêt.
 *
 * ▶️ Usage :
 *   node scripts/gen-ranked-preview.js                       (fetch https://thefronthub.com/ranked.json)
 *   node scripts/gen-ranked-preview.js --url <url>           (autre source)
 *   node scripts/gen-ranked-preview.js --file ranked.json    (copie locale)
 *
 * ⚠️ À relancer avant chaque déploiement (le preview reste figé entre deux
 * pushes). Si le fetch échoue, le preview EXISTANT est conservé tel quel.
 *
 * Le bloc est délimité par les marqueurs TFH:RANKED_PREVIEW:START/END dans
 * dashboard.html — jamais édités à la main.
 */

import fs from "fs";

const TARGET = "dashboard.html";
const MARK_START = "<!-- TFH:RANKED_PREVIEW:START -->";
const MARK_END = "<!-- TFH:RANKED_PREVIEW:END -->";
const TOP_N = 100;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadRanked() {
  const args = process.argv.slice(2);
  const fileIx = args.indexOf("--file");
  if (fileIx !== -1 && args[fileIx + 1]) {
    return JSON.parse(fs.readFileSync(args[fileIx + 1], "utf8"));
  }
  const urlIx = args.indexOf("--url");
  const url = (urlIx !== -1 && args[urlIx + 1]) || "https://thefronthub.com/ranked.json";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.json();
}

/** Barème classé : victoire 1v1 = +1 pt, victoire 2v2 = +1 pt (PTS_FFA_RANKED / PTS_TEAM_RANKED de dashboard.js). */
function buildTop(data) {
  const byPid = new Map();
  const getOrCreate = (pid, nm) => {
    let e = byPid.get(pid);
    if (!e) {
      e = { publicId: pid, name: nm || pid, ffa: 0, team: 0 };
      byPid.set(pid, e);
    }
    return e;
  };
  for (const p of data["1v1"] || []) {
    const nm = p.username || p.accountUsername || p.public_id;
    const e = getOrCreate(p.public_id, nm);
    e.ffa += p.wins || 0;
    if (nm && nm !== p.public_id) e.name = nm;
  }
  for (const p of data["2v2"] || []) {
    const nm = p.username || p.accountUsername || p.public_id;
    const e = getOrCreate(p.public_id, nm);
    e.team += p.wins || 0;
    if (nm && nm !== p.public_id) e.name = nm;
  }
  return [...byPid.values()]
    .map((e) => ({ ...e, points: e.ffa * 1 + e.team * 1 }))
    .filter((e) => e.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, TOP_N);
}

function rowHtml(e, rank) {
  const profileUrl = e.publicId
    ? `profile.html?pid=${encodeURIComponent(e.publicId)}&player=${encodeURIComponent(e.name)}`
    : `profile.html?player=${encodeURIComponent(e.name)}`;
  const rankIcon = rank === 1 ? "trophy" : rank === 2 ? "medal" : rank === 3 ? "medal" : null;
  const rankSlot = rankIcon
    ? `<span class="dash-rank-trophy dash-rank-${rank}" aria-hidden="true"><i data-icon="${rankIcon}"></i></span>`
    : `<span class="dash-rank-badge">${rank}</span>`;
  return `        <a data-pfb-row class="dash-row${rank <= 3 ? " dash-row-podium" : ""}${rank === 1 ? " dash-row-gold" : ""}" href="${profileUrl}">
          <span class="dash-rank-slot">${rankSlot}</span>
          <span class="dash-player"><span class="dash-player-name"${e.publicId ? ` data-pfb-pid="${esc(e.publicId)}"` : ""}>${esc(e.name)}</span></span>
          <span class="dash-score"><span class="dash-score-val">${e.points.toLocaleString("fr-FR")}</span><span class="dash-score-suffix">pts</span></span>
          <span class="dash-row-arrow" aria-hidden="true">›</span>
        </a>`;
}

function buildPreview(data) {
  const top = buildTop(data);
  if (top.length === 0) throw new Error("ranked.json vide ou format inattendu");
  const rows = top.map((e, i) => rowHtml(e, i + 1)).join("\n");
  const generated = new Date().toISOString().slice(0, 10);
  return `${MARK_START}
      <!-- Aperçu PRÉ-GÉNÉRÉ par scripts/gen-ranked-preview.js (ne pas éditer à la main).
           Remplacé par le classement live dès que ranked.json + l'API sont chargés.
           Données ranked.json du ${generated} — barème classé : 1v1 ×1 pt, 2v2 ×1 pt. -->
      <div class="dash-static-preview" data-preview-date="${generated}">
        <p class="dash-preview-note"><span class="dash-preview-dot" aria-hidden="true"></span><span data-i18n="dash.preview_note">Aperçu du classement (top 100 classé) — actualisation en direct…</span></p>
        <div class="dash-grid">
          <section class="dash-panel dash-panel-preview">
            <div class="dash-panel-header">
              <h2 class="dash-panel-title" data-i18n="dash.panel_global">Top joueurs — Toutes saisons</h2>
            </div>
            <div class="dash-panel-body">
              <div class="dash-list" data-lenis-prevent>
${rows}
              </div>
            </div>
          </section>
        </div>
      </div>
      ${MARK_END}`;
}

async function main() {
  const html = fs.readFileSync(TARGET, "utf8");
  const startIx = html.indexOf(MARK_START);
  const endIx = html.indexOf(MARK_END);
  if (startIx === -1 || endIx === -1) {
    console.error(`✗ Marqueurs ${MARK_START} / ${MARK_END} introuvables dans ${TARGET}`);
    process.exit(1);
  }
  try {
    const data = await loadRanked();
    const preview = buildPreview(data);
    const next = html.slice(0, startIx) + preview + html.slice(endIx + MARK_END.length);
    fs.writeFileSync(TARGET, next);
    const n = (preview.match(/dash-row"/g) || []).length;
    console.log(`✓ Aperçu injecté dans ${TARGET} : top ${n} (source ${process.argv.includes("--file") ? "fichier local" : "live"})`);
  } catch (e) {
    console.warn(`⚠ ranked.json indisponible (${e.message}) — preview existant conservé.`);
    process.exitCode = 0;
  }
}

main();
