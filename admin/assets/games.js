/* ─────────────────────────────────────────────────────────────────────────────
   admin/assets/games.js — Vue « Parties récupérées » (v1)
   Compteur d'ingestion OpenFront → MySQL (tables tfh_g_* de api/games-sync.php),
   auto-actualisé toutes les 30 s pendant que la vue est ouverte.

   Routing géré par support.js (VIEWS) : ce module expose window.TfhAdminGames
   = { activate, stopPoll, refresh } et se restaure tout seul si la dernière
   vue ouverte était « games » (scripts chargés après support.js).
   ───────────────────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  const BOOT = window.TASK_BOOT;
  if (!BOOT) return; /* pages connexion / refusé : rien à faire */

  const BASE = BOOT.base || '';
  const REFRESH_MS = 30000;
  /* 2026-09-10T00:00Z — début de l'ère V34 (constante GAMES_EPOCH_MS de
     api/games-sync.php). Curseur de backfill revenu à cette date = terminé. */
  const EPOCH_MS = 1788998400000;

  const $ = (sel) => document.querySelector(sel);
  const ids = {
    games: $('#st-games'),
    last24h: $('#st-last24h'),
    roster: $('#st-roster'),
    players: $('#st-players'),
    speedruns: $('#st-speedruns'),
    cursor: $('#st-cursor'),
    progress: $('#st-progress'),
    bar: $('#st-progressbar'),
    newest: $('#st-newest'),
    updated: $('#st-updated'),
    grid: $('#games-grid'),
    live: $('#games-live')
  };
  if (!ids.games || !ids.grid) return; /* vue absente (page non connecté) */

  let timer = null;
  let active = false;
  let refreshing = false;

  function fmtInt(n) {
    return Number(n || 0).toLocaleString('fr-FR');
  }

  /* « 2026-09-24 18:03:00 » (MySQL, UTC) → « 24/09/2026 18:03 ». */
  function fmtDateTime(mysql) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(mysql || ''));
    if (!m) return String(mysql || '—');
    return m[3] + '/' + m[2] + '/' + m[1] + ' ' + m[4] + ':' + m[5];
  }

  /* Epoch ms → « 24/09/2026 » (date UTC, cohérente avec --status du sync). */
  function fmtDateUTC(ms) {
    try {
      const iso = new Date(ms).toISOString(); /* 2026-09-24T18:03:00.000Z */
      const d = iso.slice(0, 10).split('-');
      return d[2] + '/' + d[1] + '/' + d[0];
    } catch (e) {
      return '—';
    }
  }

  function paintBackfill(cursorMs) {
    if (cursorMs === null || cursorMs === undefined || !isFinite(cursorMs)) {
      ids.progress.style.width = '0%';
      ids.bar.setAttribute('aria-valuenow', '0');
      ids.cursor.textContent = 'Curseur indisponible — lance un premier tick games-sync.';
      return;
    }
    if (cursorMs <= EPOCH_MS) {
      ids.progress.style.width = '100%';
      ids.bar.setAttribute('aria-valuenow', '100');
      ids.cursor.textContent = 'Terminé — tout l\u2019historique V34 (depuis le 10 sept 2026) est en base.';
      return;
    }
    const total = Math.max(1, Date.now() - EPOCH_MS);
    const done = Math.max(0, Math.min(1, (Date.now() - cursorMs) / total));
    const pct = done * 100;
    ids.progress.style.width = Math.max(1, Math.min(100, pct)).toFixed(1) + '%';
    ids.bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    ids.cursor.textContent = 'Rattrapage en cours — remonte vers le ' + fmtDateUTC(cursorMs)
      + ' · ≈ ' + pct.toFixed(1) + ' % de l\u2019historique ingéré';
  }

  function paint(j) {
    if (!j || !j.ok) throw new Error('bad_response');
    if (j.available === false) {
      ids.grid.classList.add('is-error');
      ids.games.textContent = '—';
      ids.last24h.textContent = 'base non installée';
      ids.roster.textContent = '—';
      ids.players.textContent = '—';
      ids.speedruns.textContent = '—';
      ids.progress.style.width = '0%';
      ids.cursor.textContent = 'Les tables tfh_g_* n\u2019existent pas encore — lance api/games-sync.php une fois (elles se créent seules).';
      ids.newest.textContent = '—';
      ids.updated.textContent = fmtUpdated(j.checked_at);
      return;
    }
    ids.grid.classList.remove('is-error');
    ids.games.textContent = fmtInt(j.games);
    ids.last24h.textContent = '+' + fmtInt(j.last24h) + ' sur les dernières 24 h';
    ids.roster.textContent = fmtInt(j.roster_rows);
    ids.players.textContent = fmtInt(j.players);
    ids.speedruns.textContent = fmtInt(j.speedruns);
    paintBackfill(j.backfill_cursor_ms);
    ids.newest.textContent = j.newest_game ? fmtDateTime(j.newest_game) + ' UTC' : '—';
    ids.updated.textContent = fmtUpdated(j.checked_at);
  }

  function fmtUpdated(epochS) {
    const d = new Date((Number(epochS) || Math.floor(Date.now() / 1000)) * 1000);
    return d.toLocaleTimeString('fr-FR');
  }

  async function refresh() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    if (ids.live) ids.live.classList.add('is-busy');
    try {
      let r;
      try {
        r = await fetch(BASE + '/api.php?action=games.status', {
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        });
      } catch (e) {
        throw new Error('network');
      }
      if (r.status === 401) { window.location.reload(); return; }
      let j = null;
      try { j = await r.json(); } catch (e) { /* réponse non JSON */ }
      paint(j);
    } catch (e) {
      ids.grid.classList.add('is-error');
      ids.updated.textContent = 'indisponible — nouvelle tentative dans 30 s';
    } finally {
      refreshing = false;
      if (ids.live) ids.live.classList.remove('is-busy');
    }
  }

  function start() {
    active = true;
    refresh();
    if (!timer) {
      timer = setInterval(() => {
        if (active && !document.hidden) refresh();
      }, REFRESH_MS);
    }
  }

  function stop() {
    active = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* Dernière vue ouverte = « games » ? (setView de support.js a déjà tourné
     avant le chargement de ce script — on démarre le poll ici.) */
  try {
    if ((localStorage.getItem('tfh-admin-view') || '') === 'games') start();
  } catch (e) { /* ignore */ }

  document.addEventListener('visibilitychange', () => {
    if (active && !document.hidden) refresh();
  });

  window.TfhAdminGames = { activate: start, stopPoll: stop, refresh };
})();
