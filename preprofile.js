/**
 * preprofile.js — Bloc « Historique TheFrontHub » (pré-profils par publicId).
 *
 * Chargé par profile.html. Si l'URL contient ?publicId=XXX, interroge
 * l'API DB locale (/api/games-api.php?route=profile) remplie par le cron
 * api/games-sync.php et rend :
 *   - identité DB (dernier pseudo, première/dernière partie, compteurs) ;
 *   - tous les alias connus du joueur (pseudo en jeu historiques) ;
 *   - stats par mode + top cartes ;
 *   - meilleurs speedruns + dernières parties (avec résultat personnel).
 *
 * Autonome (IIFE, aucun import) — sinon rien : profil non trouvé / API absente.
 * Script autonome déclaré dans scripts/build.js (bundled: false).
 */
(function () {
  'use strict';

  const API = '/api/games-api.php';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c];
    });
  }

  function fmtTime(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return '—';
    const m = Math.floor(sec / 60);
    const s = String(Math.round(sec % 60)).padStart(2, '0');
    return m + ':' + s;
  }

  function fmtDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function normName(s) {
    return String(s || '').toLowerCase().replace(/^\[[a-z0-9_-]{2,8}\]\s*/, '').replace(/\.\d{3,6}$/, '').trim();
  }

  // Pseudo hub (pseudo TheFrontHub du joueur) s'il est connecté — même source
  // que runs.js : Firebase public-aliases (via window.__tfhHubNames si dispo,
  // sinon Firebase direct via auth.min.js chargé par profile.js).
  const hubNames = (window.__tfhHubNames = window.__tfhHubNames || { byPid: {} });
  function hubNameFor(pid) {
    return (pid && hubNames.byPid[String(pid)]) || null;
  }

  function bootHubNames() {
    try {
      // profile.js charge déjà Firebase ; on s'accroche au même flux si dispo
      const src = window.__tfhAliasesListener;
      if (typeof src === 'function') src(function (pid, name) {
        hubNames.byPid[String(pid)] = String(name);
      });
    } catch (e) { /* silencieux */ }
  }

  const CSS = `
  <style>
  #preprofile-section { margin-top: 22px; }
  .pp-panel { background: var(--card-bg, rgba(255,255,255,.04)); border: 1px solid var(--card-border, rgba(255,255,255,.09));
    border-radius: 16px; padding: 18px 20px; }
  .pp-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .pp-title { font-size: 17px; font-weight: 800; color: var(--fg, #fff); letter-spacing: .2px; }
  .pp-sub { font-size: 12.5px; color: var(--fg-muted, #9aa); }
  .pp-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 16px; }
  .pp-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 5px 11px;
    border-radius: 999px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); color: var(--fg, #fff); }
  .pp-chip b { font-size: 13px; }
  .pp-chip.win { border-color: rgba(74,222,128,.4); }
  .pp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  .pp-box h4 { margin: 0 0 8px; font-size: 12.5px; text-transform: uppercase; letter-spacing: .8px; color: var(--fg-muted, #9aa); }
  .pp-bar { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 5px 0; color: var(--fg, #fff); }
  .pp-bar .pp-map { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pp-bar .pp-track { width: 90px; height: 6px; border-radius: 3px; background: rgba(255,255,255,.08); overflow: hidden; }
  .pp-bar .pp-fill { height: 100%; background: linear-gradient(90deg, var(--orange, #ff7a1a), #ffb15c); border-radius: 3px; }
  .pp-alias { display: inline-block; font-size: 12px; padding: 3px 9px; margin: 3px 4px 3px 0; border-radius: 8px;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); color: var(--fg-muted, #bcc); }
  .pp-alias.main { color: var(--orange, #ff7a1a); border-color: rgba(255,122,26,.35); }
  .pp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .pp-table th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .6px;
    color: var(--fg-muted, #9aa); padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.09); }
  .pp-table td { padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,.05); color: var(--fg, #fff); }
  .pp-table tr:last-child td { border-bottom: none; }
  .pp-win { color: #4ade80; font-weight: 700; }
  .pp-loss { color: #f87171; font-weight: 700; }
  .pp-inc { color: var(--fg-muted, #9aa); font-weight: 600; }
  .pp-cat { font-size: 10.5px; font-weight: 800; letter-spacing: .5px; text-transform: uppercase;
    padding: 2px 7px; border-radius: 6px; }
  .pp-cat.normal { background: rgba(255,122,26,.16); color: var(--orange, #ff7a1a); }
  .pp-cat.compact { background: rgba(96,165,250,.16); color: #7fb8ff; }
  .pp-scroll { max-height: 340px; overflow-y: auto; }
  .pp-scroll::-webkit-scrollbar { width: 8px; }
  .pp-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 4px; }
  .pp-link { color: inherit; text-decoration: none; }
  .pp-link:hover { color: var(--orange, #ff7a1a); }
  @media (max-width: 640px) { .pp-grid { grid-template-columns: 1fr; } .pp-table .pp-col-players { display: none; } }
  </style>`;

  function modeLabel(mode, ranked) {
    if (ranked && ranked !== 'unranked') return 'Classé ' + ranked;
    if (mode === 'Free For All') return 'FFA';
    if (mode === 'Team') return 'Équipes';
    return mode || '—';
  }

  function resultBadge(won, result) {
    if (won === true) return '<span class="pp-win">Victoire</span>';
    if (won === false) return '<span class="pp-loss">Défaite</span>';
    return '<span class="pp-inc">—</span>';
  }

  function render(pid, data) {
    const anchor = document.getElementById('pf2-below') || document.getElementById('profile-main');
    if (!anchor) return;
    const p = data.player || {};
    const st = (data.stats || {});
    const aliases = data.aliases || [];
    const byMode = st.byMode || [];
    const byMap = st.byMap || [];
    const best = st.bestSpeedruns || [];
    const recent = st.recentGames || [];

    const hub = hubNameFor(pid);
    const displayName = hub || p.lastUsername || pid;

    // ── Compteurs ──
    const games = p.gamesCount || 0;
    const wins = p.winsCount || 0;
    const wr = games > 0 ? Math.round((wins / games) * 1000) / 10 : null;

    // ── Modes ──
    const maxMode = Math.max.apply(null, [1].concat(byMode.map(function (m) { return m.games; })));
    const modesHtml = byMode.map(function (m) {
      const w = Math.round((m.games / maxMode) * 100);
      return '<div class="pp-bar"><span style="min-width:86px">' + esc(modeLabel(m.mode, m.rankedType)) +
        '</span><div class="pp-track"><div class="pp-fill" style="width:' + w + '%"></div></div><span style="min-width:96px;text-align:right;color:var(--fg-muted,#9aa)">' +
        m.games + ' parties • ' + (m.winRate != null ? Math.round(m.winRate * 100) + '%' : '—') + '</span></div>';
    }).join('') || '<div class="pp-sub">Aucune donnée</div>';

    // ── Cartes ──
    const maxMap = Math.max.apply(null, [1].concat(byMap.map(function (m) { return m.games; })));
    const mapsHtml = byMap.slice(0, 6).map(function (m) {
      const w = Math.round((m.games / maxMap) * 100);
      return '<div class="pp-bar"><span class="pp-map">' + esc(m.map) +
        '</span><div class="pp-track"><div class="pp-fill" style="width:' + w + '%"></div></div><span style="min-width:80px;text-align:right;color:var(--fg-muted,#9aa)">' +
        m.games + ' • ' + m.wins + 'V</span></div>';
    }).join('') || '<div class="pp-sub">Aucune donnée</div>';

    // ── Alias ──
    const aliasesHtml = aliases.slice(0, 10).map(function (a, i) {
      return '<span class="pp-alias' + (i === 0 ? ' main' : '') + '" title="Utilisé ' + a.timesUsed + '×, dernière fois ' + fmtDate(a.lastSeen) + '">' +
        esc(a.username) + '</span>';
    }).join('') || '<span class="pp-sub">—</span>';

    // ── Speedruns ──
    const bestHtml = best.slice(0, 5).map(function (s) {
      return '<div class="pp-bar"><span class="pp-cat ' + esc(s.category) + '">' + esc(s.category) +
        '</span><span class="pp-map">' + esc(s.map || '—') + '</span><b>' + fmtTime(s.durationS) + '</b></div>';
    }).join('') || '<div class="pp-sub">Aucun speedrun validé</div>';

    // ── Dernières parties ──
    const recentRows = recent.slice(0, 15).map(function (g) {
      const sr = g.speedrun ? ' <span class="pp-cat ' + esc(g.speedrun.category) + '">' + esc(g.speedrun.category) + '</span>' : '';
      return '<tr>' +
        '<td>' + fmtDateTime(g.startedAt) + '</td>' +
        '<td><a class="pp-link" href="https://openfront.io/game/' + esc(g.id) + '" target="_blank" rel="noopener">' + esc(g.map || '—') + '</a>' + sr + '</td>' +
        '<td>' + esc(modeLabel(g.mode, g.rankedType)) + '</td>' +
        '<td>' + resultBadge(g.won) + '</td>' +
        '<td class="pp-col-players">' + (g.numPlayers != null ? g.numPlayers : '—') + '</td>' +
        '</tr>';
    }).join('');

    const html = CSS +
      '<section id="preprofile-section" class="pp-panel" aria-label="Historique TheFrontHub">' +
      '<div class="pp-head"><span class="pp-title">Historique TheFrontHub</span>' +
      '<span class="pp-sub">Pré-profil ' + esc(pid) + ' • toutes les parties publiques archivées depuis sept. 2025</span></div>' +
      '<div class="pp-chips">' +
      '<span class="pp-chip"><b>' + esc(displayName) + '</b></span>' +
      '<span class="pp-chip">' + games.toLocaleString('fr-FR') + ' parties</span>' +
      '<span class="pp-chip win">' + wins.toLocaleString('fr-FR') + ' victoires</span>' +
      (wr != null ? '<span class="pp-chip">' + wr + '% de victoire</span>' : '') +
      '<span class="pp-chip">Première : ' + fmtDate(p.firstSeen) + '</span>' +
      '<span class="pp-chip">Dernière : ' + fmtDate(p.lastSeen) + '</span>' +
      '</div>' +
      '<div class="pp-grid">' +
      '<div class="pp-box"><h4>Pseudos connus (en jeu)</h4>' + aliasesHtml + '</div>' +
      '<div class="pp-box"><h4>Par mode</h4>' + modesHtml + '</div>' +
      '<div class="pp-box"><h4>Cartes les plus jouées</h4>' + mapsHtml + '</div>' +
      '<div class="pp-box"><h4>Meilleurs speedruns</h4>' + bestHtml + '</div>' +
      '</div>' +
      (recent.length ? '<h4 style="margin:18px 0 8px;font-size:12.5px;text-transform:uppercase;letter-spacing:.8px;color:var(--fg-muted,#9aa)">Dernières parties</h4>' +
        '<div class="pp-scroll"><table class="pp-table"><thead><tr>' +
        '<th>Date</th><th>Carte</th><th>Mode</th><th>Résultat</th><th class="pp-col-players">Joueurs</th>' +
        '</tr></thead><tbody>' + recentRows + '</tbody></table></div>' : '') +
      '</section>';

    anchor.insertAdjacentHTML('afterend', html);
  }

  async function boot() {
    const qp = new URLSearchParams(window.location.search);
    const pid = qp.get('publicId');
    if (!pid || !/^[A-Za-z0-9]{6,16}$/.test(pid)) return;

    bootHubNames();

    try {
      const res = await fetch(API + '?route=profile&publicId=' + encodeURIComponent(pid) + '&limit=20', { cache: 'no-store' });
      if (!res.ok) return; // 404 = joueur pas encore dans la DB → section masquée
      const data = await res.json();
      if (data && data.ok) render(pid, data);
    } catch (e) {
      /* API absente (avant déploiement) : silencieux */
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
