/**
 * recent-games.js — Bloc « Dernières parties publiques » (tous modes) sur l'index.
 *
 * Interroge l'API DB locale (/api/games-api.php?route=recent) remplie par le
 * cron api/games-sync.php : dernières parties publiques archivées (FFA, Team,
 * classé) avec gagnant lié par publicId → clic = profil pré-profil.
 *
 * Autonome (IIFE). Si l'API n'est pas encore déployée : le bloc reste masqué
 * (aucune régression possible sur l'index).
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

  function modeBadge(mode, ranked) {
    let label = mode === 'Team' ? 'Équipes' : 'FFA';
    let cls = 'rg-mode-ffa';
    if (ranked && ranked !== 'unranked') { label = 'Classé ' + ranked; cls = 'rg-mode-ranked'; }
    else if (mode === 'Team') cls = 'rg-mode-team';
    return '<span class="rg-mode ' + cls + '">' + esc(label) + '</span>';
  }

  const CSS = `
  <style>
  .rg-item { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-bottom: 1px solid rgba(255,255,255,.05); font-size: 13px; }
  .rg-item:last-child { border-bottom: none; }
  .rg-winner { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--fg, #fff); text-decoration: none; cursor: pointer; }
  .rg-winner:hover { color: var(--orange, #ff7a1a); }
  .rg-winner b { font-weight: 700; }
  .rg-map { color: var(--fg-muted, #9aa); font-size: 12px; flex-shrink: 0; max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rg-dur { color: var(--fg-muted, #9aa); font-size: 12px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .rg-mode { font-size: 10.5px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase;
    padding: 2px 7px; border-radius: 6px; flex-shrink: 0; }
  .rg-mode-ffa { background: rgba(255,122,26,.14); color: var(--orange, #ff7a1a); }
  .rg-mode-team { background: rgba(74,222,128,.14); color: #4ade80; }
  .rg-mode-ranked { background: rgba(96,165,250,.16); color: #7fb8ff; }
  .rg-when { color: var(--fg-muted, #8a9); font-size: 11px; flex-shrink: 0; min-width: 44px; text-align: right; }
  .rg-footer { margin-top: 10px; font-size: 11.5px; color: var(--fg-muted, #8a9); display: flex; justify-content: space-between; align-items: center; }
  .rg-footer a { color: var(--orange, #ff7a1a); text-decoration: none; }
  </style>`;

  function ago(ms) {
    if (!ms) return '—';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "à l'instant";
    if (m < 60) return 'il y a ' + m + ' min';
    const h = Math.round(m / 60);
    if (h < 24) return 'il y a ' + h + ' h';
    return 'il y a ' + Math.round(h / 24) + ' j';
  }

  function row(g) {
    const w = g.winner || {};
    const name = w.username || w.publicId || '—';
    const map = g.map || '—';
    const dur = g.durationS != null ? fmtTime(g.durationS) : '';
    const sr = g.speedrun ? ' ⚡' : '';
    const inner = '<b>' + esc(name) + '</b>' + (w.publicId ? '' : '');
    return '<div class="rg-item">' +
      modeBadge(g.mode, g.rankedType) +
      (w.publicId
        ? '<a class="rg-winner" href="profile.html?player=' + encodeURIComponent(name) + '&publicId=' + encodeURIComponent(w.publicId) + '">' + inner + '</a>'
        : '<span class="rg-winner">' + inner + '</span>') +
      '<span class="rg-map">' + esc(map) + sr + '</span>' +
      (dur ? '<span class="rg-dur">' + dur + '</span>' : '') +
      '<span class="rg-when">' + ago(g.startedAt) + '</span>' +
      '</div>';
  }

  async function boot() {
    const container = document.getElementById('recent-games-list');
    if (!container) return;
    try {
      const res = await fetch(API + '?route=recent&limit=12', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.games) || !data.games.length) return;
      const section = container.closest('section, .card, .panel, div');
      const host = section || container;
      host.insertAdjacentHTML('beforebegin', CSS);
      container.innerHTML = data.games.map(row).join('');
      const foot = document.getElementById('recent-games-footer');
      if (foot) {
        foot.innerHTML = '<span>' + data.games.length + ' dernières parties archivées</span>' +
          '<a href="runs.html">Voir les speedruns →</a>';
        foot.style.display = 'flex';
      }
    } catch (e) { /* API absente : bloc masqué */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
