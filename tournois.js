/**
 * tournois.js — Contrôleur principal de la section Tournois & Power Ranking.
 *
 * Architecture :
 *   - Routeur par hash (#/home, #/ranking, #/tournaments, #/tournament/:slug,
 *     #/player/:id, #/calendar)
 *   - Charge les données une fois (loadData du moteur) puis rend la vue.
 *   - Les vues sont des fonctions pures (rootEl, data) => HTML string.
 *
 * Design : reprend EXACTEMENT le style PR-Front (couleurs, typographie,
 * cartes, animations) via les classes .prf- de tournois.css. Les icônes
 * utilisées sont les icônes maison de PR-Front (tournois-icons.js).
 */

import {
  loadData,
  computePlayerPRs,
  computeTournamentPlayerStats,
  computeDashboardRanking,
  isTeamTournament,
  weekKey,
  currentWeekKey,
  isFinalPhase,
  phaseUsesTierMultiplier,
  tierMultiplier,
  rewardPoints,
  formatPoints,
  formatDate,
  formatDateShort,
  formatDateTime,
  initials,
  placeLabel,
  getPlayer,
  getTournament,
} from "./tournois-engine.js";
import { hydratePrfIcons } from "./tournois-icons.js";

/* ════════════════════════════════════════════════════════════════
   État global
   ════════════════════════════════════════════════════════════════ */
let _data = null; // { players, scoring, tournaments, calendar, leaderboard }

const view = document.getElementById("tournois-view");
const titleEl = document.getElementById("tournois-title");
const subtitleEl = document.getElementById("tournois-subtitle");
const countEl = document.getElementById("tournois-count");
const breadcrumb = document.getElementById("tournois-breadcrumb");
const breadcrumbPath = document.getElementById("breadcrumb-path");
const breadcrumbBack = document.getElementById("breadcrumb-back");

/* ════════════════════════════════════════════════════════════════
   Helpers de rendu
   ════════════════════════════════════════════════════════════════ */

function setHeader(title, subtitle, count) {
  if (titleEl) titleEl.textContent = title;
  if (subtitleEl) subtitleEl.textContent = subtitle || "";
  if (countEl) countEl.innerHTML = count || "";
}

function showBreadcrumb(path) {
  if (!breadcrumb) return;
  if (path) {
    breadcrumb.style.display = "flex";
    if (breadcrumbPath) breadcrumbPath.innerHTML = path;
  } else {
    breadcrumb.style.display = "none";
  }
}

function avatarHtml(name, size = "sm") {
  return `<span class="prf-avatar prf-avatar-${size}">${initials(name)}</span>`;
}

function rankCircleHtml(rank) {
  let cls = "";
  if (rank === 1) cls = "top1";
  else if (rank === 2) cls = "top2";
  else if (rank === 3) cls = "top3";
  else if (rank <= 10) cls = "top10";
  return `<span class="prf-rank-circle ${cls}">${rank}</span>`;
}

function tierBadge(tier) {
  const labels = { major: "Major", standard: "Standard", minor: "Minor" };
  return `<span class="prf-badge prf-badge-${tier}">${labels[tier] || tier}</span>`;
}

function formatTierMult(tier) {
  const mults = { major: "×2.5", standard: "×1.0", minor: "×0.5" };
  return mults[tier] || "";
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Échappement pour attribut HTML contenant du JS (onclick="fn('…')") :
// le navigateur décode les entités AVANT d'exécuter le JS — escapeHtml seul
// ne suffit donc pas. On sérialise en littéral JSON puis on échappe pour
// l'attribut HTML : escapeHtml(JSON.stringify(v)) round-trip parfaitement.
function jsq(v) {
  return escapeHtml(JSON.stringify(String(v ?? "")));
}

// Valide un URL externe (http/https uniquement) avant insertion dans un href.
function safeExternalUrl(u) {
  try {
    const url = new URL(String(u));
    return (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
  } catch {
    return null;
  }
}

/* ════════════════════════════════════════════════════════════════
   Routeur
   ════════════════════════════════════════════════════════════════ */

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (!h) return { route: "home", params: {} };
  // Séparer la route des query params (?q=...)
  const [pathPart, queryPart] = h.split("?");
  const parts = pathPart.split("/");
  const route = parts[0];
  const params = {};
  if (route === "tournament" && parts[1]) params.slug = decodeURIComponent(parts[1]);
  else if (route === "player" && parts[1]) params.id = decodeURIComponent(parts[1]);
  // Parser les query params (ex: ?q=ultimus)
  if (queryPart) {
    const search = new URLSearchParams(queryPart);
    for (const [k, v] of search) params[k] = v;
  }
  return { route, params };
}

async function router() {
  if (!_data) {
    try {
      _data = await loadData();
    } catch (e) {
      console.error("[tournois] loadData failed:", e);
      view.innerHTML = `<div class="prf-error">
        <div class="spinner"></div>
        <h3>Impossible de charger les données</h3>
        <p>${escapeHtml(e.message)}</p>
      </div>`;
      return;
    }
  }

  const { route, params } = parseHash();

  // Mise à jour de la nav active (top-nav + drawer)
  updateNavActive(route);

  // Breadcrumb + retour
  let bcPath = "";
  let backRoute = "home";
  if (route === "tournament" && params.slug) {
    const t = getTournament(_data.tournaments, params.slug);
    bcPath = `<strong>Tournois</strong> / ${escapeHtml(t?.name || params.slug)}`;
    backRoute = "tournaments";
  } else if (route === "player" && params.id) {
    const p = getPlayer(_data.players, params.id);
    bcPath = `<strong>Classement</strong> / ${escapeHtml(p?.name || params.id)}`;
    backRoute = "ranking";
  }
  showBreadcrumb(bcPath);
  if (breadcrumbBack) breadcrumbBack.setAttribute("data-back", backRoute);

  // Rendu
  try {
    // Restaurer le header bar (caché sur la home pour le hero pleine largeur)
    const headerEl = document.getElementById("tournois-page-head");
    if (headerEl) headerEl.style.display = "";
    switch (route) {
      case "dashboard": await renderDashboard(); break;
      case "ranking": await renderRanking(params); break;
      case "tournaments": await renderTournamentsList(); break;
      case "tournament": await renderTournamentDetail(params.slug); break;
      case "player": await renderPlayerProfile(params.id); break;
      case "calendar": await renderCalendar(); break;
      case "home":
      default: await renderHome(); break;
    }
    hydratePrfIcons(view);
  } catch (e) {
    console.error("[tournois] render error:", e);
    view.innerHTML = `<div class="prf-error"><h3>Erreur de rendu</h3><p>${escapeHtml(e.message)}</p></div>`;
  }

  // Scroll en haut
  view.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ════════════════════════════════════════════════════════════════
   Navigation active state (top-nav + mobile drawer)
   ════════════════════════════════════════════════════════════════ */
function updateNavActive(route) {
  // Top-nav (desktop)
  document.querySelectorAll(".prf-topnav-link").forEach((btn) => {
    const active = btn.dataset.route === route;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  // Drawer (mobile)
  document.querySelectorAll(".prf-drawer-link").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === route);
  });
}

/* ════════════════════════════════════════════════════════════════
   VUE : Tableau de bord — Classement par points (FFA +10 / Team +5)
   ════════════════════════════════════════════════════════════════ */
let _dashMode = "overall"; // "overall" | "weekly"

async function renderDashboard() {
  setHeader("Tableau de bord", "Classement par points · FFA +10 / Team +5 par victoire",
    `<span class="prf-chip"><i data-prf-icon="trophy" data-prf-icon-size="14"></i> ${_data.tournaments.length} tournois</span> <span class="prf-chip"><i data-prf-icon="users" data-prf-icon-size="14"></i> ${_data.leaderboard.length} joueurs</span>`);

  const weekOnly = _dashMode === "weekly" ? currentWeekKey() : null;
  const ranking = computeDashboardRanking(_data.tournaments, _data.players, _data.scoring, { weekOnly });

  // Champion (overall #1 ou weekly #1)
  const champion = ranking[0] ?? null;

  // Stats globales
  const totalPlayers = ranking.length;
  const totalWins = ranking.reduce((s, e) => s + e.wins, 0);
  const totalPoints = ranking.reduce((s, e) => s + e.points, 0);
  const totalFfaWins = ranking.reduce((s, e) => s + e.ffaWins, 0);
  const totalTeamWins = ranking.reduce((s, e) => s + e.teamWins, 0);

  // Top 10 affiché (scrollable si plus)
  const topN = ranking.slice(0, 50);

  const modeLabel = _dashMode === "weekly" ? "Cette semaine" : "Global";

  view.innerHTML = `
    ${champion ? `
    <div class="prf-hero">
      <div class="prf-hero-label">${_dashMode === "weekly" ? "Champion de la semaine" : "Champion Global"}</div>
      <div class="prf-hero-name">${escapeHtml(champion.player?.name || champion.playerId)}</div>
      <div class="prf-hero-sub">
        ${champion.player?.clan ? `[${escapeHtml(champion.player.clan)}] ` : ""}Rank #${champion.rank}
      </div>
      <div class="prf-hero-stats">
        <div class="prf-hero-stat">
          <div class="prf-hero-stat-val">${formatPoints(champion.points)}</div>
          <div class="prf-hero-stat-label">Points</div>
        </div>
        <div class="prf-hero-stat">
          <div class="prf-hero-stat-val">${champion.wins}</div>
          <div class="prf-hero-stat-label">Victoires</div>
        </div>
        <div class="prf-hero-stat">
          <div class="prf-hero-stat-val">${champion.ffaWins}</div>
          <div class="prf-hero-stat-label">FFA</div>
        </div>
        <div class="prf-hero-stat">
          <div class="prf-hero-stat-val">${champion.teamWins}</div>
          <div class="prf-hero-stat-label">Team</div>
        </div>
      </div>
    </div>` : ""}

    <div class="prf-stats-grid">
      <div class="prf-stat-card">
        <div class="label">Joueurs classés</div>
        <div class="value">${totalPlayers}</div>
        <div class="sub">${modeLabel}</div>
      </div>
      <div class="prf-stat-card">
        <div class="label">Points distribués</div>
        <div class="value">${formatPoints(totalPoints)}</div>
        <div class="sub">${modeLabel}</div>
      </div>
      <div class="prf-stat-card">
        <div class="label">Victoires FFA</div>
        <div class="value">${totalFfaWins}</div>
        <div class="sub">+10 pts chacune</div>
      </div>
      <div class="prf-stat-card">
        <div class="label">Victoires Team</div>
        <div class="value">${totalTeamWins}</div>
        <div class="sub">+5 pts chacune</div>
      </div>
    </div>

    <div class="prf-card prf-dash-card">
      <div class="prf-card-header">
        <span class="prf-card-title">Classement — ${modeLabel}</span>
        <div class="prf-dash-toggle" role="tablist" aria-label="Période du classement">
          <button class="prf-dash-toggle-btn ${_dashMode === "overall" ? "active" : ""}" data-dash-mode="overall" role="tab" aria-selected="${_dashMode === "overall"}">Global</button>
          <button class="prf-dash-toggle-btn ${_dashMode === "weekly" ? "active" : ""}" data-dash-mode="weekly" role="tab" aria-selected="${_dashMode === "weekly"}">Cette semaine</button>
        </div>
      </div>
      <div class="prf-card-body">
        ${topN.length ? `
        <div class="prf-table-wrap" style="max-height:560px;overflow-y:auto">
          <table class="prf-table prf-dash-table">
            <thead>
              <tr>
                <th class="prf-th-rank">#</th>
                <th>Joueur</th>
                <th class="prf-th-num">FFA</th>
                <th class="prf-th-num">Team</th>
                <th class="prf-th-num">Top 3</th>
                <th class="prf-th-num">Points</th>
              </tr>
            </thead>
            <tbody>
              ${topN.map((e) => {
                const name = e.player?.name || e.playerId;
                const clan = e.player?.clan || "";
                return `
                <tr class="prf-row-link" onclick="location.hash=${jsq('#/player/' + encodeURIComponent(e.playerId))}">
                  <td class="prf-td-rank">${rankCircleHtml(e.rank)}</td>
                  <td class="prf-td-player">
                    ${avatarHtml(name, "sm")}
                    <div class="prf-td-player-info">
                      <span class="prf-td-player-name">${escapeHtml(name)}</span>
                      ${clan ? `<span class="prf-td-player-clan">[${escapeHtml(clan)}]</span>` : ""}
                    </div>
                  </td>
                  <td class="prf-td-num">${e.ffaWins}</td>
                  <td class="prf-td-num">${e.teamWins}</td>
                  <td class="prf-td-num">${e.top3}</td>
                  <td class="prf-td-num prf-td-points">${formatPoints(e.points)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>` : `<p style="color:var(--prf-muted);text-align:center;padding:40px 20px">Aucun tournoi ${_dashMode === "weekly" ? "cette semaine" : "pour le moment"}.</p>`}
      </div>
    </div>

    <div class="prf-dash-scoring-info">
      <i data-prf-icon="info" data-prf-icon-size="14"></i>
      <span>Barème : FFA — 1er <strong>+10</strong>, 2e +7, 3e +5, 4e +3, 5e +1 · Team — 1er <strong>+5</strong>, 2e +3, 3e +2</span>
    </div>
  `;

  // Toggle event listeners
  view.querySelectorAll(".prf-dash-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _dashMode = btn.dataset.dashMode;
      renderDashboard();
    });
  });
}

/* ════════════════════════════════════════════════════════════════
   VUE : Accueil
   ════════════════════════════════════════════════════════════════ */
async function renderHome() {
  setHeader("Tournois", "Power Ranking · Circuit compétitif OpenFront",
    `<span class="prf-chip"><i data-prf-icon="trophy" data-prf-icon-size="14"></i> ${_data.tournaments.length} tournois</span> <span class="prf-chip"><i data-prf-icon="users" data-prf-icon-size="14"></i> ${_data.leaderboard.length} joueurs</span>`);

  const lb = _data.leaderboard;
  const champion = lb[0] ?? null;
  const mostWins = [...lb].sort((a, b) => b.wins - a.wins)[0] ?? null;
  const latestTournament = _data.tournaments[0] ?? null;

  // Dernier vainqueur
  let latestWinnerName = "—";
  let latestWinnerId = "";
  let latestDate = "—";
  if (latestTournament) {
    latestDate = formatDateShort(latestTournament.date);
    for (const phase of latestTournament.phases) {
      if (!isFinalPhase(_data.scoring, latestTournament, phase.type)) continue;
      const win = phase.placements.find((p) => p.place === 1);
      if (win) {
        latestWinnerName = getPlayer(_data.players, win.player)?.name || win.player;
        latestWinnerId = win.player;
        break;
      }
    }
  }

  // Cacher le header par défaut pour le hero pleine largeur
  const headerEl = document.getElementById("tournois-page-head");
  if (headerEl) headerEl.style.display = "none";

  view.innerHTML = `
    <div class="trn-home">
      <!-- ═══ HERO SOMBRE ═══ -->
      <section class="trn-hero">
        <div class="trn-hero-bg"></div>
        <div class="trn-hero-content">
          <div class="trn-hero-eyebrow">CIRCUIT COMPÉTITIF OPENFRONT</div>
          <h1 class="trn-hero-title">Tournois & Power Ranking</h1>
          <p class="trn-hero-subtitle">Suivez les performances des meilleurs joueurs du circuit compétitif.</p>

          <div class="trn-hero-search">
            <i data-prf-icon="search" data-prf-icon-size="20"></i>
            <input type="text" id="trn-home-search" placeholder="Rechercher un joueur, un clan, un tournoi…" />
            <button onclick="window._trnSearch()" aria-label="Rechercher">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
          </div>

          <div class="trn-hero-stats">
            <span class="trn-hero-stat">
              <i data-prf-icon="trophy" data-prf-icon-size="16"></i> ${_data.tournaments.length} tournois
            </span>
            <span class="trn-hero-stat">
              <i data-prf-icon="users" data-prf-icon-size="16"></i> ${lb.length} joueurs classés
            </span>
          </div>
        </div>
      </section>

      <!-- ═══ 3 CARTES HIGHLIGHT ═══ -->
      <div class="trn-home-cards">
        ${champion ? `
        <a class="trn-hl-card trn-hl-gold" href="#/player/${encodeURIComponent(champion.playerId)}">
          <div class="trn-hl-header">
            <span class="trn-hl-label">CHAMPION ACTUEL</span>
            <span class="trn-hl-more">Voir plus <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>
          </div>
          <div class="trn-hl-body">
            ${avatarHtml(champion.player?.name || champion.playerId, "md")}
            <div class="trf-hl-info">
              <div class="trn-hl-name">${escapeHtml(champion.player?.name || champion.playerId)}</div>
              <div class="trn-hl-meta">${champion.player?.clan ? `[${escapeHtml(champion.player.clan)}] ` : ""}PR ${formatPoints(champion.points)} · #1</div>
            </div>
            <div class="trn-hl-watermark"><i data-prf-icon="crown" data-prf-icon-size="56"></i></div>
          </div>
        </a>` : ""}

        ${mostWins && mostWins.wins > 0 ? `
        <a class="trn-hl-card trn-hl-cyan" href="#/player/${encodeURIComponent(mostWins.playerId)}">
          <div class="trn-hl-header">
            <span class="trn-hl-label">PLUS DE VICTOIRES</span>
            <span class="trn-hl-more">Voir plus <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>
          </div>
          <div class="trn-hl-body">
            ${avatarHtml(mostWins.player?.name || mostWins.playerId, "md")}
            <div class="trf-hl-info">
              <div class="trn-hl-name">${escapeHtml(mostWins.player?.name || mostWins.playerId)}</div>
              <div class="trn-hl-meta">${mostWins.wins} victoires · ${mostWins.events} tournois</div>
            </div>
            <div class="trn-hl-watermark"><i data-prf-icon="trophy" data-prf-icon-size="56"></i></div>
          </div>
        </a>` : ""}

        ${latestTournament ? `
        <a class="trn-hl-card trn-hl-purple" href="#/tournament/${encodeURIComponent(latestTournament.slug || "")}">
          <div class="trn-hl-header">
            <span class="trn-hl-label">DERNIER TOURNOI</span>
            <span class="trn-hl-more">Voir plus <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>
          </div>
          <div class="trn-hl-body">
            ${avatarHtml(latestWinnerName, "md")}
            <div class="trf-hl-info">
              <div class="trn-hl-name">${escapeHtml(latestWinnerName)}</div>
              <div class="trn-hl-meta">${escapeHtml(latestTournament.name)} · ${latestDate}</div>
            </div>
            <div class="trn-hl-watermark"><i data-prf-icon="flag" data-prf-icon-size="56"></i></div>
          </div>
        </a>` : ""}
      </div>
    </div>
  `;
  hydratePrfIcons(view);

  // Wire la recherche vers la route classement
  const searchInput = document.getElementById("trn-home-search");
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") window._trnSearch();
    });
  }
  window._trnSearch = function () {
    const q = document.getElementById("trn-home-search")?.value?.trim() || "";
    location.hash = "#/ranking" + (q ? "?q=" + encodeURIComponent(q) : "");
  };
}

/* ════════════════════════════════════════════════════════════════
   VUE : Classement PR
   ════════════════════════════════════════════════════════════════ */

let _lbState = { q: "", filter: "all", sort: { key: "points", direction: "desc" } };

async function renderRanking(params = {}) {
  // Pré-remplir la recherche si ?q=... est dans l'URL (depuis la home search bar)
  if (params.q) _lbState.q = params.q;

  setHeader("Classement Power Ranking", "Points cumulés sur tous les tournois",
    `<span class="prf-chip"><i data-prf-icon="users" data-prf-icon-size="14"></i> ${_data.leaderboard.length} joueurs</span>`);

  const rows = _data.leaderboard.map((e) => ({
    rank: e.rank,
    id: e.playerId,
    name: e.player?.name ?? e.playerId,
    clan: e.player?.clan ?? null,
    points: e.points,
    events: e.events,
    wins: e.wins,
    top3: e.top3,
    avgPlace: e.avgPlace,
  }));

  view.innerHTML = `
    <div class="prf-card">
      <div class="prf-card-header">
        <span class="prf-card-title">Classement général</span>
      </div>
      <div class="prf-filters" id="lb-filters">
        ${[
          { id: "all", label: "Tous", count: rows.length },
          { id: "recurring", label: "Réguliers (≥2)", count: rows.filter(r => r.events >= 2).length },
          { id: "top100", label: "Top 100", count: Math.min(100, rows.length) },
          { id: "clan", label: "Avec clan", count: rows.filter(r => r.clan).length },
        ].map(f => `<button class="prf-filter-btn ${_lbState.filter === f.id ? "active" : ""}" data-filter="${f.id}">${f.label}<span class="count">${f.count}</span></button>`).join("")}
        <div class="prf-search">
          <span class="prf-search-icon"><i data-prf-icon="search" data-prf-icon-size="14"></i></span>
          <input type="text" id="lb-search" placeholder="Rechercher un joueur…" value="${escapeHtml(_lbState.q)}">
        </div>
      </div>
      <div class="prf-table-wrap">
        <table class="prf-table" id="lb-table">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;
  hydratePrfIcons(view);

  const filtersEl = document.getElementById("lb-filters");
  const searchEl = document.getElementById("lb-search");
  const tableEl = document.getElementById("lb-table");

  filtersEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".prf-filter-btn");
    if (!btn) return;
    _lbState.filter = btn.dataset.filter;
    renderLbTable();
    filtersEl.querySelectorAll(".prf-filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === _lbState.filter));
  });
  searchEl.addEventListener("input", (e) => {
    _lbState.q = e.target.value;
    renderLbTable();
  });

  function renderLbTable() {
    let out = rows;
    if (_lbState.filter === "recurring") out = out.filter(r => r.events >= 2);
    else if (_lbState.filter === "top100") out = out.filter(r => r.rank <= 100);
    else if (_lbState.filter === "clan") out = out.filter(r => r.clan);
    const needle = _lbState.q.trim().toLowerCase();
    if (needle) {
      out = out.filter(r => `${r.name} ${r.id} ${r.clan ?? ""}`.toLowerCase().includes(needle));
    }
    // Tri
    const { key, direction } = _lbState.sort;
    out = [...out].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return a.rank - b.rank;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return a.rank - b.rank;
      return direction === "desc" ? bv - av : av - bv;
    });

    const sortArrow = (col) => {
      if (key !== col) return "↕";
      return direction === "desc" ? "↓" : "↑";
    };
    const sortClass = (col) => `sortable ${key === col ? "active" : ""}`;

    tableEl.querySelector("thead").innerHTML = `
      <tr>
        <th class="${sortClass("rank")}" data-sort="rank"># <span class="sort-arrow">${sortArrow("rank")}</span></th>
        <th>Joueur</th>
        <th class="num ${sortClass("points")}" data-sort="points">PR <span class="sort-arrow">${sortArrow("points")}</span></th>
        <th class="num ${sortClass("events")}" data-sort="events">Tournois <span class="sort-arrow">${sortArrow("events")}</span></th>
        <th class="num ${sortClass("wins")}" data-sort="wins">Victoires <span class="sort-arrow">${sortArrow("wins")}</span></th>
        <th class="num ${sortClass("top3")}" data-sort="top3">Top 3 <span class="sort-arrow">${sortArrow("top3")}</span></th>
        <th class="num ${sortClass("avgPlace")}" data-sort="avgPlace">Place moy. <span class="sort-arrow">${sortArrow("avgPlace")}</span></th>
      </tr>
    `;
    tableEl.querySelector("tbody").innerHTML = out.length ? out.map((r) => `
      <tr class="prf-row-link" onclick="location.hash=${jsq('#/player/' + encodeURIComponent(r.id))}">
        <td>${rankCircleHtml(r.rank)}</td>
        <td>
          <div class="prf-player-cell">
            ${avatarHtml(r.name, "sm")}
            <div>
              <div>
                ${r.clan ? `<span class="prf-player-clan">[${escapeHtml(r.clan)}]</span>` : ""}
                <span class="prf-player-name">${escapeHtml(r.name)}</span>
                ${r.events === 1 ? `<span class="prf-badge prf-badge-new" style="margin-left:6px">Nouveau</span>` : ""}
              </div>
              <div class="prf-player-id">${escapeHtml(r.id)}</div>
            </div>
          </div>
        </td>
        <td class="num"><span class="prf-points">${formatPoints(r.points)}</span></td>
        <td class="num">${r.events}</td>
        <td class="num">${r.wins}</td>
        <td class="num">${r.top3}</td>
        <td class="num">${r.avgPlace == null ? "—" : `#${r.avgPlace.toFixed(1)}`}</td>
      </tr>
    `).join("") : `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--prf-muted)">Aucun résultat.</td></tr>`;

    // Tri au clic sur les en-têtes
    tableEl.querySelector("thead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      const col = th.dataset.sort;
      if (_lbState.sort.key === col) {
        _lbState.sort.direction = _lbState.sort.direction === "desc" ? "asc" : "desc";
      } else {
        _lbState.sort.key = col;
        _lbState.sort.direction = (col === "rank" || col === "avgPlace") ? "asc" : "desc";
      }
      renderLbTable();
    }, { once: true });
  }

  renderLbTable();
}

/* ════════════════════════════════════════════════════════════════
   VUE : Liste des tournois
   ════════════════════════════════════════════════════════════════ */
async function renderTournamentsList() {
  setHeader("Tournois", "Circuit compétitif OpenFront",
    `<span class="prf-chip"><i data-prf-icon="trophy" data-prf-icon-size="14"></i> ${_data.tournaments.length} tournois</span>`);

  const cards = _data.tournaments.map((t) => {
    const finalPhase = t.phases.find((p) => isFinalPhase(_data.scoring, t, p.type));
    const winner = finalPhase?.placements.find((p) => p.place === 1);
    const winnerName = winner ? (getPlayer(_data.players, winner.player)?.name || "—") : null;
    const participantCount = finalPhase?.placements.length || t.participants || 0;
    return `
      <a class="prf-tournament-card ${t.tier === "major" ? "major-card" : ""}" href="#/tournament/${encodeURIComponent(t.slug)}">
        <div class="prf-tournament-card-header">
          <div>
            <div class="prf-tournament-name">${escapeHtml(t.name)}</div>
            <div class="prf-tournament-date">${formatDate(t.date)}</div>
          </div>
          ${tierBadge(t.tier)}
        </div>
        <div class="prf-tournament-meta">
          <span><i data-prf-icon="swords" data-prf-icon-size="14"></i> ${t.format.toUpperCase()}</span>
          <span><i data-prf-icon="users" data-prf-icon-size="14"></i> ${participantCount}</span>
          ${t.series ? `<span><i data-prf-icon="trophy" data-prf-icon-size="14"></i> ${escapeHtml(t.series)}</span>` : ""}
          ${formatTierMult(t.tier) ? `<span style="color:var(--prf-accent-strong);font-weight:800">${formatTierMult(t.tier)}</span>` : ""}
        </div>
        ${winnerName ? `<div class="prf-tournament-winner"><i data-prf-icon="crown" data-prf-icon-size="14"></i> Vainqueur : <span class="name">${escapeHtml(winnerName)}</span></div>` : ""}
      </a>
    `;
  }).join("");

  view.innerHTML = `
    <div class="prf-tournament-grid">
      ${cards || `<p style="color:var(--prf-muted)">Aucun tournoi.</p>`}
    </div>
  `;
  hydratePrfIcons(view);
}

/* ════════════════════════════════════════════════════════════════
   VUE : Détail tournoi
   ════════════════════════════════════════════════════════════════ */
async function renderTournamentDetail(slug) {
  const t = getTournament(_data.tournaments, slug);
  if (!t) {
    setHeader("Tournoi introuvable", "", "");
    view.innerHTML = `<div class="prf-error"><h3>Tournoi introuvable</h3><p>Slug : ${escapeHtml(slug)}</p></div>`;
    return;
  }

  setHeader(t.name, `${formatDate(t.date)} · ${t.format.toUpperCase()}`, "");
  countEl.innerHTML = `${tierBadge(t.tier)} <span style="margin-left:8px;color:var(--prf-muted);font-size:12px;font-weight:600">${formatTierMult(t.tier)}</span>`;

  const scoring = _data.scoring;
  const mult = tierMultiplier(scoring, t);

  // Phases (dans l'ordre du format)
  const formatConf = scoring.formats[t.format];
  const phaseOrder = formatConf?.phaseOrder || t.phases.map(p => p.type);
  const phasesHtml = phaseOrder.map((phaseType) => {
    const phase = t.phases.find(p => p.type === phaseType);
    if (!phase) return "";
    const phaseConf = formatConf?.phases?.[phaseType];
    const label = phaseConf?.label || phaseType;
    const isFinal = isFinalPhase(scoring, t, phaseType);
    const usesMult = phaseUsesTierMultiplier(scoring, t, phaseType);

    const placements = [...phase.placements]
      .filter(p => p.place != null)
      .sort((a, b) => a.place - b.place);

    if (placements.length === 0) {
      const participants = phase.placements;
      return `
        <div class="prf-phase-section">
          <h3 class="prf-phase-title">${escapeHtml(label)} ${isFinal ? '<span class="prf-badge prf-badge-major">Finale</span>' : ''}</h3>
          <p style="color:var(--prf-muted);padding:8px 0">${participants.length} participants (pas de classement détaillé)</p>
        </div>
      `;
    }

    const rows = placements.map((p) => {
      const name = getPlayer(_data.players, p.player)?.name || p.player;
      const entry = _data.leaderboard.find(e => e.playerId === p.player);
      const reward = rewardPoints(scoring, t, p.place);
      return `
        <tr class="prf-row-link" onclick="location.hash=${jsq('#/player/' + encodeURIComponent(p.player))}">
          <td>${rankCircleHtml(p.place)}</td>
          <td>
            <div class="prf-player-cell">
              ${avatarHtml(name, "sm")}
              <div>
                ${entry?.player?.clan ? `<span class="prf-player-clan">[${escapeHtml(entry.player.clan)}]</span>` : ""}
                <span class="prf-player-name">${escapeHtml(name)}</span>
              </div>
            </div>
          </td>
          <td class="num pr-points-cell">+${Math.round((phaseConf?.places?.[String(p.place)] || 0) * (usesMult ? mult : 1))}</td>
          <td class="num">${reward > 0 ? `<span style="color:var(--prf-gold);font-weight:800">${reward} P</span>` : "—"}</td>
        </tr>
      `;
    }).join("");

    return `
      <div class="prf-phase-section">
        <h3 class="prf-phase-title">${escapeHtml(label)} ${isFinal ? '<span class="prf-badge prf-badge-major">Finale</span>' : ''}</h3>
        <div class="prf-table-wrap">
          <table class="prf-results-table">
            <thead>
              <tr>
                <th>Place</th>
                <th>Joueur</th>
                <th class="num">Points PR</th>
                <th class="num">Récompense</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join("");

  // Stats par joueur (depuis details.games)
  let statsHtml = "";
  if (t.details?.games?.length) {
    const statsMap = computeTournamentPlayerStats(t);
    const statsArr = [...statsMap.values()].sort((a, b) => b.gamesPlayed - a.gamesPlayed || (a.bestPlace ?? 999) - (b.bestPlace ?? 999));
    if (statsArr.length) {
      const stageLabels = { qualifier: "Qualif", semifinal: "Demi", final: "Finale" };
      statsHtml = `
        <div class="prf-card" style="margin-bottom:20px">
          <div class="prf-card-header"><span class="prf-card-title">Stats du tournoi (par joueur)</span></div>
          <div class="prf-table-wrap">
            <table class="prf-stats-table">
              <thead>
                <tr>
                  <th>Joueur</th>
                  <th>Parties</th>
                  <th>Wins</th>
                  <th>Kills</th>
                  <th>Survécues</th>
                  <th>Meilleure place</th>
                  <th>Stage max</th>
                  <th>Temps (min)</th>
                  <th>Pts/partie</th>
                </tr>
              </thead>
              <tbody>
                ${statsArr.map(s => {
                  const name = getPlayer(_data.players, s.playerId)?.name || s.playerId;
                  return `<tr class="prf-row-link" onclick="location.hash=${jsq('#/player/' + encodeURIComponent(s.playerId))}">
                    <td><strong>${escapeHtml(name)}</strong></td>
                    <td>${s.gamesPlayed}</td>
                    <td>${s.wins}</td>
                    <td>${s.kills}</td>
                    <td>${s.survived}</td>
                    <td>${s.bestPlace == null ? "—" : `#${s.bestPlace}`}</td>
                    <td>${s.furthestStage ? stageLabels[s.furthestStage] || s.furthestStage : "—"}</td>
                    <td>${Math.round(s.playtimeMin)}</td>
                    <td>${s.avgGamePoints == null ? "—" : s.avgGamePoints}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
  }

  view.innerHTML = `
    <div class="prf-detail-header">
      <div class="prf-detail-title">${escapeHtml(t.name)}</div>
      <div class="prf-detail-meta">
        <span><i data-prf-icon="calendar" data-prf-icon-size="14"></i> ${formatDate(t.date)}</span>
        <span><i data-prf-icon="swords" data-prf-icon-size="14"></i> ${t.format.toUpperCase()}</span>
        <span><i data-prf-icon="trophy" data-prf-icon-size="14"></i> ${escapeHtml(t.series || "—")}</span>
        <span><i data-prf-icon="users" data-prf-icon-size="14"></i> ${t.participants} participants</span>
        ${t.map ? `<span><i data-prf-icon="flag" data-prf-icon-size="14"></i> ${escapeHtml(t.map)}</span>` : ""}
      </div>
    </div>
    ${statsHtml}
    ${phasesHtml || '<p style="color:var(--prf-muted)">Aucune phase.</p>'}
  `;
  hydratePrfIcons(view);
}

/* ════════════════════════════════════════════════════════════════
   Courbe d'évolution du Power Ranking (port de pr-chart.tsx)
   ════════════════════════════════════════════════════════════════ */
const PR_CHART_W = 720;
const PR_CHART_H = 190;
const PR_CHART_PAD = { left: 12, right: 14, top: 16, bottom: 38 };

function buildPRChartCard(chartData) {
  if (!chartData.length) {
    return `<div class="prf-card">
      <div class="prf-card-header"><span class="prf-card-title">Évolution du Power Ranking</span></div>
      <div class="prf-card-body">
        <div class="prf-pr-chart prf-pr-chart-empty">Aucune donnée</div>
      </div>
    </div>`;
  }

  const W = PR_CHART_W, H = PR_CHART_H, PAD = PR_CHART_PAD;
  const max = Math.max(...chartData.map(p => p.cumulative), 1);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i) => chartData.length <= 1 ? W / 2 : PAD.left + (i / (chartData.length - 1)) * innerW;
  const y = (v) => PAD.top + (1 - v / max) * innerH;
  const coords = chartData.map((p, i) => ({ x: x(i), y: y(p.cumulative) }));
  const line = coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = coords.length
    ? `${coords[0].x.toFixed(1)},${H - PAD.bottom} ${line} ${coords[coords.length - 1].x.toFixed(1)},${H - PAD.bottom}`
    : "";
  const baseline = H - PAD.bottom;

  const gridLines = [0, 0.5, 1].map(p => {
    const yy = PAD.top + p * innerH;
    return `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${yy}" y2="${yy}" stroke="#e8e2dc" stroke-width="1"/>`;
  }).join("");

  const pointsHtml = coords.map((c, i) => {
    const lbl = formatDateShort(chartData[i].date).slice(0, 5);
    return `<g class="prf-pr-chart-point" style="animation-delay:${700 + i * 110}ms">
      <circle class="prf-pr-chart-dot" data-i="${i}" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4" fill="#fff" stroke="#e8781d" stroke-width="2.5"/>
      <text x="${c.x.toFixed(1)}" y="${H - 12}" text-anchor="middle" fill="#8b837d" font-size="10" font-weight="400">${escapeHtml(lbl)}</text>
    </g>`;
  }).join("");

  return `<div class="prf-card">
    <div class="prf-card-body">
      <div class="prf-pr-chart">
        <div class="prf-pr-chart-header">
          <div>
            <div class="prf-pr-chart-title">Évolution du Power Ranking</div>
            <div class="prf-pr-chart-sub">Points cumulés après chaque tournoi</div>
          </div>
          <div class="prf-pr-chart-badge">POWER RANKING</div>
        </div>
        <div class="prf-pr-chart-wrap" id="prf-pr-chart-wrap">
          <svg class="prf-pr-chart-svg" id="prf-pr-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution des points PR cumulés — survolez la courbe pour le détail" tabindex="0">
            <defs>
              <linearGradient id="prf-pr-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#e8781d" stop-opacity="0.28"/>
                <stop offset="1" stop-color="#e8781d" stop-opacity="0.02"/>
              </linearGradient>
            </defs>
            ${gridLines}
            <polygon class="prf-pr-chart-area" points="${area}" fill="url(#prf-pr-area)"/>
            <polyline class="prf-pr-chart-line" points="${line}" fill="none" stroke="#e8781d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            <line class="prf-pr-chart-cursor" id="prf-pr-chart-cursor" x1="0" x2="0" y1="${PAD.top - 4}" y2="${baseline}" stroke="#e8781d" stroke-width="1.5" stroke-dasharray="4 4" opacity="0"/>
            ${pointsHtml}
          </svg>
          <div class="prf-pr-chart-tip" id="prf-pr-chart-tip" style="display:none">
            <div class="prf-pr-chart-tip-name"></div>
            <div class="prf-pr-chart-tip-meta"></div>
            <div class="prf-pr-chart-tip-body">
              <div>
                <div class="prf-pr-chart-tip-lbl">Total PR</div>
                <div class="prf-pr-chart-tip-total"></div>
              </div>
              <div class="prf-pr-chart-tip-gained-wrap">
                <div class="prf-pr-chart-tip-lbl">Gagnés</div>
                <div class="prf-pr-chart-tip-gained"></div>
              </div>
            </div>
          </div>
        </div>
        <p class="prf-pr-chart-hint">Survolez la courbe (ou utilisez les flèches) pour voir le détail</p>
      </div>
    </div>
  </div>`;
}

function attachPRChart(chartData) {
  const wrap = document.getElementById("prf-pr-chart-wrap");
  const svg = document.getElementById("prf-pr-chart-svg");
  const tip = document.getElementById("prf-pr-chart-tip");
  const cursor = document.getElementById("prf-pr-chart-cursor");
  if (!wrap || !svg || !tip || !cursor || !chartData.length) return;

  const W = PR_CHART_W, H = PR_CHART_H, PAD = PR_CHART_PAD;
  const max = Math.max(...chartData.map(p => p.cumulative), 1);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i) => chartData.length <= 1 ? W / 2 : PAD.left + (i / (chartData.length - 1)) * innerW;
  const y = (v) => PAD.top + (1 - v / max) * innerH;
  const coords = chartData.map((p, i) => ({ x: x(i), y: y(p.cumulative) }));
  const dots = svg.querySelectorAll(".prf-pr-chart-dot");
  let activeIdx = null;

  function setActive(idx) {
    activeIdx = idx;
    if (idx == null) {
      tip.style.display = "none";
      cursor.setAttribute("opacity", "0");
      dots.forEach(d => { d.setAttribute("r", "4"); d.setAttribute("stroke-width", "2.5"); });
      return;
    }
    const c = coords[idx];
    const p = chartData[idx];
    dots.forEach(d => {
      const i = parseInt(d.dataset.i, 10);
      if (i === idx) { d.setAttribute("r", "6.5"); d.setAttribute("stroke-width", "3.5"); }
      else { d.setAttribute("r", "4"); d.setAttribute("stroke-width", "2.5"); }
    });
    cursor.setAttribute("x1", c.x);
    cursor.setAttribute("x2", c.x);
    cursor.setAttribute("opacity", "0.55");

    tip.style.display = "block";
    tip.querySelector(".prf-pr-chart-tip-name").textContent = p.name;
    tip.querySelector(".prf-pr-chart-tip-meta").textContent =
      formatDateShort(p.date) + (p.bestPlace != null ? ` · #${p.bestPlace}` : "");
    tip.querySelector(".prf-pr-chart-tip-total").textContent = formatPoints(p.cumulative);
    tip.querySelector(".prf-pr-chart-tip-gained").textContent = "+" + formatPoints(p.gained);

    const tipW = 190;
    const leftPct = (c.x / W) * 100;
    tip.style.left = `clamp(0px, calc(${leftPct}% - ${tipW / 2}px), calc(100% - ${tipW}px))`;
  }

  function nearestIndex(clientX) {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return null;
    const vx = ((clientX - rect.left) / rect.width) * W;
    let best = 0, bestDist = Infinity;
    coords.forEach((c, i) => {
      const d = Math.abs(c.x - vx);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  svg.addEventListener("mousemove", (e) => setActive(nearestIndex(e.clientX)));
  svg.addEventListener("mouseleave", () => setActive(null));
  svg.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (t) setActive(nearestIndex(t.clientX));
  }, { passive: true });
  svg.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (t) { setActive(nearestIndex(t.clientX)); e.preventDefault(); }
  }, { passive: false });
  svg.addEventListener("touchend", () => setActive(null));
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const cur = activeIdx == null ? -1 : activeIdx;
      const next = e.key === "ArrowRight" ? cur + 1 : cur - 1;
      const clamped = Math.max(0, Math.min(chartData.length - 1, next));
      setActive(clamped);
    } else if (e.key === "Escape") {
      setActive(null);
    }
  });
  svg.addEventListener("blur", () => setActive(null));
}

/* ════════════════════════════════════════════════════════════════
   VUE : Profil joueur
   ════════════════════════════════════════════════════════════════ */
async function renderPlayerProfile(discordId) {
  const player = getPlayer(_data.players, discordId);
  const entry = _data.leaderboard.find(e => e.playerId === discordId);

  if (!player && !entry) {
    setHeader("Joueur introuvable", "", "");
    view.innerHTML = `<div class="prf-error"><h3>Joueur introuvable</h3><p>ID : ${escapeHtml(discordId)}</p></div>`;
    return;
  }

  const name = player?.name || discordId;
  const clan = player?.clan || null;
  const rank = entry?.rank ?? "—";
  const points = entry?.points ?? 0;
  const events = entry?.events ?? 0;
  const wins = entry?.wins ?? 0;
  const top3 = entry?.top3 ?? 0;
  const bestPlace = entry?.bestPlace;
  const avgPlace = entry?.avgPlace;

  setHeader(name, `Profil tournoi · ${clan ? `[${clan}] ` : ""}Rank #${rank}`, "");

  // Décomposition des points (awards groupés par tournoi)
  const awards = entry?.awards || [];
  const byTournament = new Map();
  for (const a of awards) {
    if (!byTournament.has(a.tournamentSlug)) {
      byTournament.set(a.tournamentSlug, {
        slug: a.tournamentSlug,
        name: a.tournamentName,
        date: a.tournamentDate,
        tier: a.tier,
        awards: [],
        total: 0,
      });
    }
    const grp = byTournament.get(a.tournamentSlug);
    grp.awards.push(a);
    grp.total += a.points;
  }
  const tournaments = [...byTournament.values()].sort((a, b) => b.date.localeCompare(a.date));

  // Chart PR : chronologique, avec cumul progressif (courbe d'évolution)
  let _running = 0;
  const chartData = [...tournaments]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((g) => {
      _running += g.total;
      const bestPlace = g.awards.map(a => a.place).filter(p => p != null).sort((a, b) => a - b)[0] ?? null;
      return {
        slug: g.slug,
        name: g.name,
        date: g.date,
        gained: g.total,
        cumulative: _running,
        bestPlace,
      };
    });

  // Récompenses Plutonium cumulées
  let totalPlutonium = 0;
  for (const a of awards) {
    const t = getTournament(_data.tournaments, a.tournamentSlug);
    if (t && a.place != null) {
      totalPlutonium += rewardPoints(_data.scoring, t, a.place);
    }
  }

  const awardsHtml = tournaments.length ? tournaments.map((grp) => `
    <div class="prf-award" onclick="location.hash=${jsq('#/tournament/' + encodeURIComponent(grp.slug))}">
      <div class="prf-award-place">${grp.tier === "major" ? "★" : "•"}</div>
      <div class="prf-award-info">
        <div class="prf-award-tournament">
          <a class="prf-link" href="#/tournament/${encodeURIComponent(grp.slug)}">${escapeHtml(grp.name)}</a>
        </div>
        <div class="prf-award-phase">
          ${formatDateShort(grp.date)} · ${grp.awards.map(a => `${a.phaseLabel}${a.place ? ` #${a.place}` : ""}`).join(", ")}
        </div>
      </div>
      <div class="prf-award-points">+${formatPoints(grp.total)}</div>
    </div>
  `).join("") : `<p style="color:var(--prf-muted);padding:16px">Aucun tournoi joué.</p>`;



  view.innerHTML = `
    <div class="prf-profile-header">
      <div style="flex:1">
        <div class="prf-profile-name">${escapeHtml(name)}</div>
        <div class="prf-profile-sub">
          ${clan ? `Clan : <strong>${escapeHtml(clan)}</strong> · ` : ""}Rank Power Ranking : <strong style="color:var(--prf-accent-strong)">#${rank}</strong>
        </div>
        <div class="prf-profile-stats">
          <div class="prf-profile-stat"><div class="v">${formatPoints(points)}</div><div class="l">Points PR</div></div>
          <div class="prf-profile-stat"><div class="v">${events}</div><div class="l">Tournois</div></div>
          <div class="prf-profile-stat"><div class="v">${wins}</div><div class="l">Victoires</div></div>
          <div class="prf-profile-stat"><div class="v">${top3}</div><div class="l">Top 3</div></div>
          <div class="prf-profile-stat"><div class="v">${bestPlace == null ? "—" : `#${bestPlace}`}</div><div class="l">Meilleure place</div></div>
          <div class="prf-profile-stat"><div class="v">${avgPlace == null ? "—" : `#${avgPlace.toFixed(1)}`}</div><div class="l">Place moy.</div></div>
          ${totalPlutonium > 0 ? `<div class="prf-profile-stat"><div class="v" style="color:var(--prf-gold)">${totalPlutonium} P</div><div class="l">Plutonium</div></div>` : ""}
        </div>
      </div>
    </div>

    <div class="prf-grid-2">
      <div class="prf-card">
        <div class="prf-card-header"><span class="prf-card-title">Décomposition des points</span></div>
        <div class="prf-card-body">
          <div class="prf-awards-list">${awardsHtml}</div>
        </div>
      </div>
      ${buildPRChartCard(chartData)}
    </div>
  `;
  hydratePrfIcons(view);
  attachPRChart(chartData);
}

/* ════════════════════════════════════════════════════════════════
   VUE : Calendrier
   ════════════════════════════════════════════════════════════════ */
async function renderCalendar() {
  setHeader("Calendrier", "Prochains tournois du circuit",
    `<span class="prf-chip"><i data-prf-icon="calendar" data-prf-icon-size="14"></i> ${_data.calendar.length} événement(s)</span>`);

  const events = [..._data.calendar].sort((a, b) =>
    (a.startsAt ?? a.date).localeCompare(b.startsAt ?? b.date)
  );

  if (!events.length) {
    view.innerHTML = `<div class="prf-card"><div class="prf-card-body"><p style="color:var(--prf-muted);padding:20px">Aucun événement à venir.</p></div></div>`;
    return;
  }

  const monthLabels = ["JAN","FÉV","MAR","AVR","MAI","JUN","JUL","AOÛ","SEP","OCT","NOV","DÉC"];

  view.innerHTML = `
    <div class="prf-cal-list">
      ${events.map(ev => {
        const d = new Date(ev.startsAt || ev.date + "T12:00:00Z");
        const day = d.getUTCDate();
        const month = monthLabels[d.getUTCMonth()];
        const time = ev.startsAt ? formatDateTime(ev.startsAt) : formatDate(ev.date);
        return `
          <div class="prf-cal-item">
            <div class="prf-cal-date">
              <div class="prf-cal-day">${day}</div>
              <div class="prf-cal-month">${month}</div>
            </div>
            <div class="prf-cal-info">
              <div class="prf-cal-name">${escapeHtml(ev.name)}</div>
              <div class="prf-cal-meta">
                ${time}
                ${ev.format ? ` · ${ev.format.toUpperCase()}` : ""}
                ${ev.tier ? ` · ${tierBadge(ev.tier)}` : ""}
                ${ev.series ? ` · ${escapeHtml(ev.series)}` : ""}
                ${ev.participants ? ` · ${ev.participants} inscrits` : ""}
              </div>
            </div>
            ${ev.registrationUrl && safeExternalUrl(ev.registrationUrl) ? `<a class="prf-cal-register" href="${escapeHtml(safeExternalUrl(ev.registrationUrl))}" target="_blank" rel="noreferrer noopener">S'inscrire</a>` : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
  hydratePrfIcons(view);
}

/* ════════════════════════════════════════════════════════════════
   Init & events
   ════════════════════════════════════════════════════════════════ */

// Top-nav (desktop) : navigation par hash
document.querySelectorAll(".prf-topnav-link").forEach((btn) => {
  btn.addEventListener("click", () => {
    const route = btn.dataset.route;
    if (route) location.hash = `#/${route}`;
  });
});

// Mobile drawer : toggle + navigation
const drawer = document.getElementById("prf-drawer");
const drawerOverlay = document.getElementById("prf-drawer-overlay");
const menuToggle = document.getElementById("prf-menu-toggle");
const drawerClose = document.getElementById("prf-drawer-close");

function openDrawer() {
  if (!drawer) return;
  drawer.classList.add("open");
  drawerOverlay?.classList.add("open");
  menuToggle?.setAttribute("aria-expanded", "true");
  document.body.style.overflow = "hidden";
}
function closeDrawer() {
  if (!drawer) return;
  drawer.classList.remove("open");
  drawerOverlay?.classList.remove("open");
  menuToggle?.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
}

menuToggle?.addEventListener("click", openDrawer);
drawerClose?.addEventListener("click", closeDrawer);
drawerOverlay?.addEventListener("click", closeDrawer);

// Drawer links : navigation + fermeture
document.querySelectorAll(".prf-drawer-link").forEach((btn) => {
  btn.addEventListener("click", () => {
    const route = btn.dataset.route;
    if (route) location.hash = `#/${route}`;
    closeDrawer();
  });
});

// Fermer le drawer sur Échap
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

// Breadcrumb retour
breadcrumbBack?.addEventListener("click", () => {
  const back = breadcrumbBack.getAttribute("data-back") || "home";
  location.hash = `#/${back}`;
});

// Route au chargement et au changement de hash
window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);

// Si pas de hash au démarrage, aller à l'accueil
if (!window.location.hash) {
  window.location.hash = "#/home";
} else {
  router();
}
