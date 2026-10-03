/**
 * scripts/gen-ranked-preview.js — Aperçu statique du dashboard pour dashboard.html
 *
 * 🎯 Pourquoi : le dashboard affiche un APERÇU PRÉ-GÉNÉRÉ pendant que les
 * données live (dashboard_scores.json.gz + API) arrivent. Les robots
 * d'indexation (Googlebot) et les connexions lentes voient ainsi un vrai
 * classement au lieu d'une section vide, et le rendu live le remplace
 * SANS SAUT VISUEL : v5.23 génère les DEUX panneaux (global + hebdo) depuis
 * les MÊMES données et le MÊME barème que le rendu live.
 *
 *   Avant v5.23 : panneau global = ranked.json (barème classé ×1 → des
 *   valeurs/ordre différents du live) + panneau hebdo = squelettes
 *   « Disponible dans un instant… » (le bug « ça enlève le top de la
 *   semaine et ça prend tout l'écran »).
 *   Après v5.23 : les 2 panneaux = photo exacte du dernier sync
 *   (dashboard_scores.json.gz, barème live FFA×10 / classé×1 / Team×5).
 *
 * ▶️ Usage :
 *   node scripts/gen-ranked-preview.js
 *        (fetch https://thefronthub.com/dashboard_scores.json.gz, fallback ranked.json)
 *   node scripts/gen-ranked-preview.js --scores <fichier.json|json.gz|url>
 *   node scripts/gen-ranked-preview.js --file ranked.json    (fallback ancien mode)
 *
 * ⚠️ À relancer à chaque cycle de données (le preview reste figé entre deux
 * lancements). Si TOUTES les sources échouent, le preview EXISTANT est
 * conservé tel quel.
 *
 * Le bloc est délimité par les marqueurs TFH:RANKED_PREVIEW:START/END dans
 * dashboard.html — jamais édités à la main.
 */

import fs from "fs";
import zlib from "zlib";

const TARGET = "dashboard.html";
const MARK_START = "<!-- TFH:RANKED_PREVIEW:START -->";
const MARK_END = "<!-- TFH:RANKED_PREVIEW:END -->";
const TOP_N = 100;

/* Barème OFFICIEL du dashboard (identique à dashboard.js PTS_* et
 * sync-dashboard.js SCORE) — ne jamais diverger, sinon le preview
 * afficherait des valeurs différentes du rendu live. */
const SCORE = { ffa_casual: 10, ffa_ranked: 1, team_casual: 5, team_ranked: 1 };
const SCORE_RANKED_FALLBACK = { ffa: 1, team: 1 }; // ancien mode ranked.json

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtPoints(n) {
  return new Intl.NumberFormat("fr-FR").format(n || 0);
}

/* ── Sources ─────────────────────────────────────────────────────────── */

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.json();
}

/** Charge dashboard_scores.json(.gz) — fichier local (.gz ou .json) ou URL. */
async function loadScores() {
  const args = process.argv.slice(2);
  const ix = args.indexOf("--scores");
  const src = (ix !== -1 && args[ix + 1]) || "https://thefronthub.com/dashboard_scores.json.gz";
  console.log(`  → source scores : ${src}`);
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${src}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const json = isGzip(buf) ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    return JSON.parse(json);
  }
  const buf = fs.readFileSync(src);
  const json = isGzip(buf) ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return JSON.parse(json);
}

function isGzip(buf) {
  return buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** ranked.json — fallback ancien mode (top classé uniquement). */
async function loadRanked() {
  const args = process.argv.slice(2);
  const fileIx = args.indexOf("--file");
  if (fileIx !== -1 && args[fileIx + 1]) {
    return JSON.parse(fs.readFileSync(args[fileIx + 1], "utf8"));
  }
  const urlIx = args.indexOf("--url");
  const url = (urlIx !== -1 && args[urlIx + 1]) || "https://thefronthub.com/ranked.json";
  return fetchJson(url);
}

/* ── Construction des tops ───────────────────────────────────────────── */

/**
 * Top depuis dashboard_scores.json (même barème que le rendu live).
 * @param {object} data  contenu de dashboard_scores.json
 * @param {boolean} weekly  false = global (carrière), true = cette semaine
 * @returns {{rows: Array, total: number}}  rows = top 100, total = joueurs à
 *   points > 0 (pour le sous-titre « N joueurs », comme le rendu live).
 */
function buildTopFromScores(data, weekly) {
  const players = data.players || [];
  const ptsOf = (p) => weekly
    ? (p.weekly_ffa_casual || 0) * SCORE.ffa_casual
      + (p.weekly_ffa_ranked || 0) * SCORE.ffa_ranked
      + (p.weekly_team_casual || 0) * SCORE.team_casual
      + (p.weekly_team_ranked || 0) * SCORE.team_ranked
    : (p.ffa_casual || 0) * SCORE.ffa_casual
      + (p.ffa_ranked || 0) * SCORE.ffa_ranked
      + (p.team_casual || 0) * SCORE.team_casual
      + (p.team_ranked || 0) * SCORE.team_ranked;
  const winsOf = (p) => weekly
    ? {
        ffa: (p.weekly_ffa_casual || 0) + (p.weekly_ffa_ranked || 0),
        team: (p.weekly_team_casual || 0) + (p.weekly_team_ranked || 0),
      }
    : {
        ffa: (p.ffa_casual || 0) + (p.ffa_ranked || 0),
        team: (p.team_casual || 0) + (p.team_ranked || 0),
      };
  const rows = players
    .map((p) => ({ publicId: p.publicId, name: p.username || p.publicId, points: ptsOf(p), ...winsOf(p) }))
    .filter((e) => e.points > 0)
    .sort((a, b) => b.points - a.points);
  return { rows: rows.slice(0, TOP_N), total: rows.length };
}

/** Ancien mode : top classé depuis ranked.json (1v1 ×1 + 2v2 ×1). */
function buildTopFromRanked(data) {
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
  const rows = [...byPid.values()]
    .map((e) => ({ publicId: e.publicId, name: e.name, points: e.ffa * SCORE_RANKED_FALLBACK.ffa + e.team * SCORE_RANKED_FALLBACK.team, ffa: e.ffa, team: e.team }))
    .filter((e) => e.points > 0)
    .sort((a, b) => b.points - a.points);
  return { rows: rows.slice(0, TOP_N), total: rows.length };
}

/* ── Rendu HTML (markup IDENTIQUE au rendu live renderRanking) ───────── */

/**
 * Une ligne du classement.
 * @param {object} e  { publicId, name, points, ffa, team }
 * @param {number} rank  rang 1-based
 * @param {boolean} withBreakdown  insère le mini breakdown FFA · Team
 *   (mêmes classes que renderRanking() côté navigateur) — utilisé pour les
 *   tops issus de dashboard_scores ; l'ancien fallback ranked.json s'en passe.
 */
function rowHtml(e, rank, withBreakdown) {
  const profileUrl = e.publicId
    ? `profile.html?pid=${encodeURIComponent(e.publicId)}&player=${encodeURIComponent(e.name)}`
    : `profile.html?player=${encodeURIComponent(e.name)}`;
  const rankIcon = rank === 1 ? "trophy" : rank === 2 ? "medal" : rank === 3 ? "medal" : null;
  const rankSlot = rankIcon
    ? `<span class="dash-rank-trophy dash-rank-${rank}" aria-hidden="true"><i data-icon="${rankIcon}"></i></span>`
    : `<span class="dash-rank-badge">${rank}</span>`;
  const breakdown = withBreakdown && (e.ffa > 0 || e.team > 0)
    ? `
            <span class="dash-player-breakdown">
              <span class="dash-bd-ffa">${e.ffa || 0}<i data-icon="swords"></i></span>
              <span class="dash-bd-sep">·</span>
              <span class="dash-bd-team">${e.team || 0}<i data-icon="users"></i></span>
            </span>`
    : "";
  // Le breakdown est DANS .dash-player (flex-column) → sous le nom,
  // exactement comme renderRanking() côté navigateur (zéro saut visuel
  // quand le rendu live remplace l'aperçu).
  return `        <a data-pfb-row class="dash-row${rank <= 3 ? " dash-row-podium" : ""}${rank === 1 ? " dash-row-gold" : ""}" href="${profileUrl}">
          <span class="dash-rank-slot">${rankSlot}</span>
          <span class="dash-player"><span class="dash-player-name"${e.publicId ? ` data-pfb-pid="${esc(e.publicId)}"` : ""}>${esc(e.name)}</span>${breakdown}
          </span>
          <span class="dash-score"><span class="dash-score-val">${fmtPoints(e.points)}</span><span class="dash-score-suffix">pts</span></span>
          <span class="dash-row-arrow" aria-hidden="true">›</span>
        </a>`;
}

function listHtml(top, withBreakdown) {
  return top.map((e, i) => rowHtml(e, i + 1, withBreakdown)).join("\n");
}

function skeletonListHtml() {
  return Array.from({ length: 12 }, () => '                <div class="dash-skeleton-row"><span class="dash-skeleton-rank"></span><span class="dash-skeleton-name"></span><span class="dash-skeleton-pts"></span></div>').join("\n");
}

/** Date du lundi (weekStart ISO UTC) lisible en français. */
function frWeekLabel(weekStartIso) {
  try {
    return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" }).format(new Date(weekStartIso));
  } catch (e) {
    return String(weekStartIso || "").slice(0, 10);
  }
}

function buildPreview({ globalRows, weeklyRows, scoresMeta, globalTotal, weeklyTotal, weekLabel }) {
  const generated = new Date().toISOString().slice(0, 10);
  // Panneau hebdo : lignes réelles si le top hebdo est dispo, sinon squelettes.
  const weeklyHasData = weeklyRows && weeklyRows.length > 0;
  const weeklyBody = weeklyHasData ? listHtml(weeklyRows, true) : skeletonListHtml();
  const weeklySub = weeklyHasData
    ? // v5.24 — sous-titre identique au rendu live (updateLists) → le header
      // du panel a la même hauteur au swap (zéro saut de layout).
      `\n              <span class="dash-panel-sub">Depuis le ${esc(weekLabel || "lundi")} · ${fmtPoints(weeklyTotal || 0)} joueurs actifs</span>`
    : `\n              <span class="dash-panel-sub" data-i18n="dash.preview_weekly_sub">Disponible dans un instant…</span>`;
  const weeklyAria = weeklyHasData ? "" : ' aria-hidden="true"';
  // v5.24 — l'aperçu inclut AUSSI l'intro + la toolbar (recherche + filtres) :
  // le rendu live les contient, leur absence faisait « sauter » la page au
  // swap (contenu remonté puis redescendu = impression de reset). Le markup
  // est IDENTIQUE au rendu live (dashboard.js render()), SANS les ids
  // fonctionnels et avec inert : rien n'est interactif tant que le rendu
  // live n'a pas pris le relais (il remplace tout de toute façon).
  const introToolbar = `      <div class="dash-intro" inert>
        <p class="dash-intro-sub" data-i18n="dash.intro_sub">TheFrontHub synchronise automatiquement votre historique de parties et vos statistiques OpenFront, visualise vos conquêtes et classe vos performances à l'échelle mondiale.</p>
        <button type="button" class="dash-help-btn" aria-label="Voir le barème des points" aria-expanded="false" tabindex="-1">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </button>
        <div class="dash-help-popover" role="dialog" aria-label="Barème des points">
          <div class="dash-help-popover-header">Barème des points</div>
          <ul class="dash-help-popover-list">
            <li><span class="dash-help-mode">FFA</span><span class="dash-help-pts">+10 pts</span></li>
            <li><span class="dash-help-mode">Team</span><span class="dash-help-pts">+5 pts</span></li>
            <li><span class="dash-help-mode">classé (1v1)</span><span class="dash-help-pts">+1 pt</span></li>
            <li><span class="dash-help-mode">classé (2v2)</span><span class="dash-help-pts">+1 pt</span></li>
          </ul>
          <p class="dash-help-note">Le classé rapporte juste 1 pt, pas en plus du casual.</p>
        </div>
      </div>
      <div class="dash-toolbar" inert>
        <div class="dash-search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.3" y2="16.3"/></svg>
          <input type="search" placeholder="Rechercher un joueur…" autocomplete="off" spellcheck="false" aria-label="Rechercher un joueur dans le classement" tabindex="-1">
        </div>
        <div class="dash-filters" role="group" aria-label="Filtrer par mode de jeu">
          <button type="button" class="dash-filter active" data-filter="all" aria-pressed="true" tabindex="-1">Tous</button>
          <button type="button" class="dash-filter" data-filter="ffa" aria-pressed="false" tabindex="-1">FFA</button>
          <button type="button" class="dash-filter" data-filter="team" aria-pressed="false" tabindex="-1">Team</button>
        </div>
      </div>`;
  return `${MARK_START}
      <!-- Aperçu PRÉ-GÉNÉRÉ par scripts/gen-ranked-preview.js (ne pas éditer à la main).
           Remplacé par le classement live dès que dashboard_scores.json.gz + l'API sont chargés.
           ${scoresMeta} — barème live : FFA casual ×10, FFA classé ×1, Team casual ×5, Team classé ×1. -->
      <div class="dash-static-preview" data-preview-date="${generated}">
        <p class="dash-preview-note"><span class="dash-preview-dot" aria-hidden="true"></span><span data-i18n="dash.preview_note">Aperçu du classement (top 100) — actualisation en direct…</span></p>
${introToolbar}
        <div class="dash-grid">
          <section class="dash-panel dash-panel-preview">
            <div class="dash-panel-header">
              <h2 class="dash-panel-title" data-i18n="dash.panel_global">Top joueurs — Toutes saisons</h2>
              <span class="dash-panel-sub">Classement cumulé · ${fmtPoints(globalTotal || 0)} joueurs</span>
            </div>
            <div class="dash-panel-body">
              <div class="dash-list" data-lenis-prevent>
${globalRows}
              </div>
            </div>
          </section>
          <section class="dash-panel dash-panel-preview dash-panel-preview-weekly"${weeklyAria}>
            <div class="dash-panel-header">
              <h2 class="dash-panel-title" data-i18n="dash.panel_weekly">Top joueurs — Cette semaine</h2>${weeklySub}
            </div>
            <div class="dash-panel-body">
${weeklyHasData ? `              <div class="dash-list" data-lenis-prevent>\n${weeklyBody}\n              </div>` : `              <div class="dash-skeleton-list" data-lenis-prevent>\n${weeklyBody}\n              </div>`}
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
    // Mode 1 (v5.23) : dashboard_scores.json.gz → les DEUX panneaux, barème live.
    let preview = null;
    try {
      const scores = await loadScores();
      const globalTop = buildTopFromScores(scores, false);
      const weeklyTop = buildTopFromScores(scores, true);
      if (globalTop.rows.length === 0) throw new Error("scores sans joueurs à points > 0");
      const updated = (scores.lastUpdate || "").slice(0, 10) || "date inconnue";
      const weekLabel = scores.weekStart ? frWeekLabel(scores.weekStart) : "";
      preview = buildPreview({
        globalRows: listHtml(globalTop.rows, true),
        weeklyRows: weeklyTop.rows,
        globalTotal: globalTop.total,
        weeklyTotal: weeklyTop.total,
        weekLabel,
        scoresMeta: `Données dashboard_scores du ${updated}${weekLabel ? ` — semaine depuis le ${weekLabel}` : ""}`,
      });
      console.log(`  ✓ Top global : ${globalTop.rows.length} joueurs (${globalTop.total} au total) · top hebdo : ${weeklyTop.rows.length} (${weeklyTop.total}) (barème live)`);
    } catch (e) {
      console.warn(`  ⚠ dashboard_scores indisponible (${e.message}) — fallback ranked.json`);
    }
    // Mode 2 (fallback) : ranked.json → top global classé + squelette hebdo.
    if (!preview) {
      const data = await loadRanked();
      const top = buildTopFromRanked(data);
      if (top.rows.length === 0) throw new Error("ranked.json vide ou format inattendu");
      preview = buildPreview({
        globalRows: listHtml(top.rows, false),
        weeklyRows: null,
        globalTotal: top.total,
        weeklyTotal: 0,
        weekLabel: "",
        scoresMeta: `Données ranked.json du ${new Date().toISOString().slice(0, 10)}`,
      });
      console.log(`  ✓ Top classé : ${top.rows.length} joueurs (fallback ranked.json, hebdo = squelette)`);
    }
    const next = html.slice(0, startIx) + preview + html.slice(endIx + MARK_END.length);
    fs.writeFileSync(TARGET, next);
    const n = (preview.match(/dash-row"/g) || []).length;
    console.log(`✓ Aperçu injecté dans ${TARGET} : ${n} lignes (source ${process.argv.includes("--file") || process.argv.includes("--scores") ? "locale" : "live"})`);
  } catch (e) {
    console.warn(`⚠ Aucune source disponible (${e.message}) — preview existant conservé.`);
    process.exitCode = 0;
  }
}

main();
