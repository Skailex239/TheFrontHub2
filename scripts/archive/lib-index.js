"use strict";
/**
 * lib-index.js — Moteur d'indexation du listing /public/games (TOUS types).
 *
 * Un seul moteur sert au backfill initial ET au rattrapage incrémental (cron) :
 *   - Fenêtres de 47h59 (limite API 48h pile) depuis INDEX.START_DATE.
 *   - Chaque fenêtre = pagination offset (limit=1000) jusqu'à épuisement.
 *   - Reprise EXACTE : chaque fenêtre complète est cochée dans
 *     state/index.json { windowsDone } ; un crash ne repart jamais de zéro.
 *   - Écriture via DayStore (upsert, pas de duplication).
 *   - Les records end==null alimentent la map "pending" (parties en cours),
 *     rafraîchie à chaque passe (option pendingRefresh).
 */

const { INDEX } = require("./config.js");
const { listGamesPage } = require("./lib-api.js");
const { DayStore, indexRawPath, dayOfRecord } = require("./lib-store.js");
const {
  STATE_DIR,
  readJson,
  writeJsonAtomic,
  ensureDir,
} = require("./lib-state.js");
const {
  loadPending,
  savePending,
  trackPending,
  pendingCount,
} = require("./lib-pending.js");
const path = require("path");

const INDEX_STATE_FILE = path.join(STATE_DIR, "index.json");
const MAX_PAGES_PER_WINDOW = 4000; // garde-fou (48h ≈ 400 pages max mesuré)

function logIndex(msg) {
  console.log(`[archive-index ${new Date().toISOString()}] ${msg}`);
}

/** Liste des fenêtres [start, end) couvrant [from, to). */
function enumerateWindows(fromMs, toMs) {
  const wins = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const end = Math.min(cursor + INDEX.WINDOW_MS, toMs);
    wins.push({ start: new Date(cursor).toISOString(), end: new Date(end).toISOString() });
    cursor = end;
  }
  return wins;
}

/**
 * Passe d'indexation : traite toutes les fenêtres non faites entre
 * max(from, START_DATE) et to. Retourne un résumé.
 */
async function runIndexCatchup({
  fromMs = Date.parse(INDEX.START_DATE),
  toMs = Date.now() - INDEX.LAG_MS,
  workers = 1,
  pendingRefresh = false,
  label = "index",
} = {}) {
  const startedAt = Date.now();
  const state = readJson(INDEX_STATE_FILE, { windowsDone: {}, updatedAt: null });
  if (!state.windowsDone) state.windowsDone = {};

  const all = enumerateWindows(fromMs, toMs);
  const todo = all.filter((w) => !state.windowsDone[w.start]);
  logIndex(
    `${label} : ${all.length} fenêtre(s) dans la plage, ${todo.length} à traiter, ${workers} worker(s)`
  );

  /* Stores par jour (partagés entre workers, mono-thread JS => sans race). */
  const stores = new Map();
  const pending = loadPending();
  const totals = { windows: 0, records: 0, new: 0, replaced: 0, invalid: 0, requests: 0 };

  function storeFor(day) {
    let s = stores.get(day);
    if (!s) {
      s = new DayStore(indexRawPath(day), day);
      stores.set(day, s);
    }
    return s;
  }

  function flushAll() {
    for (const s of stores.values()) s.flush();
    stores.clear();
  }

  async function fetchWindow(win) {
    let offset = 0;
    let fetched = 0;
    let pages = 0;
    const fallbackDay = win.end.slice(0, 10);

    while (pages < MAX_PAGES_PER_WINDOW) {
      const { games, total } = await listGamesPage({
        start: win.start,
        end: win.end,
        limit: INDEX.PAGE_LIMIT,
        offset,
      });
      totals.requests++;
      pages++;

      if (!games.length) break;

      for (const rec of games) {
        const day = dayOfRecord(rec, fallbackDay);
        if (rec.start == null) {
          totals.invalid++;
          continue;
        }
        const res = storeFor(day).upsert(rec);
        if (res === "new") totals.new++;
        else if (res === "replaced") totals.replaced++;
        totals.records++;
        trackPending(pending, rec);
      }

      fetched += games.length;
      offset += games.length;
      if (games.length < INDEX.PAGE_LIMIT) break;
      if (total != null && offset >= total) break;
    }
    return { fetched, pages };
  }

  /* Pool de workers sur la file de fenêtres restantes. */
  let nextIdx = 0;
  async function worker(id) {
    while (true) {
      const i = nextIdx++;
      if (i >= todo.length) return;
      const win = todo[i];
      try {
        const { fetched, pages } = await fetchWindow(win);
        totals.windows++;
        // Fenêtre complète : flush des stores + état + log.
        flushAll();
        state.windowsDone[win.start] = true;
        state.updatedAt = new Date().toISOString();
        writeJsonAtomic(INDEX_STATE_FILE, state);
        logIndex(
          `${label} w${id} : fenêtre ${win.start} -> ${fetched} jeux (${pages} pages) | cumul new=${totals.new} repl=${totals.replaced} | pending=${pendingCount(pending)}`
        );
      } catch (e) {
        logIndex(`ERREUR fenêtre ${win.start} : ${e.message} — fenêtre laissée à refaire, on continue avec la suivante`);
        // flush quand même ce qui a été écrit (partiel) pour limiter la reprise
        flushAll();
        savePending(pending);
      }
    }
  }

  if (todo.length > 0) {
    await Promise.all(Array.from({ length: Math.min(workers, todo.length) }, (_, i) => worker(i)));
    flushAll();
    savePending(pending);
  }

  /* Rafraîchissement des parties en cours (records end==null). */
  let pendingRefreshed = 0;
  if (pendingRefresh && pendingCount(pending) > 0) {
    pendingRefreshed = await refreshPending(pending);
  }

  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  logIndex(
    `${label} TERMINÉ en ${elapsedMin} min : ${totals.windows} fenêtres, ${totals.records} records, new=${totals.new}, remplacés=${totals.replaced}, invalides=${totals.invalid}, ${totals.requests} req, pending refresh=${pendingRefreshed}`
  );

  return { ...totals, pendingRefreshed, windowsTodo: todo.length };
}

/**
 * Re-interroge l'API pour les parties en cours (end==null), par fenêtre de
 * 1 h autour de leur start. Max 1500 par passe pour borner le temps de run.
 */
async function refreshPending(pending) {
  const { listGamesPage } = require("./lib-api.js");
  const { DayStore, indexRawPath } = require("./lib-store.js");

  const ids = Object.keys(pending).slice(0, 1500);
  let refreshed = 0;
  const stores = new Map();

  function storeFor(day) {
    let s = stores.get(day);
    if (!s) {
      s = new DayStore(indexRawPath(day), day);
      stores.set(day, s);
    }
    return s;
  }

  for (const id of ids) {
    const p = pending[id];
    if (!p || !p.start) {
      delete pending[id];
      continue;
    }
    const startMs = Date.parse(p.start);
    if (!Number.isFinite(startMs)) {
      delete pending[id];
      continue;
    }
    const wStart = new Date(startMs - 2000).toISOString();
    const wEnd = new Date(startMs + 3600 * 1000).toISOString();
    try {
      const { games } = await listGamesPage({ start: wStart, end: wEnd, limit: 1000, offset: 0 });
      const rec = games.find((g) => String(g?.game ?? g?.gameID ?? g?.gameId) === id);
      if (!rec) {
        // pas encore listée dans cette fenêtre ? (improbable) -> on garde
        continue;
      }
      const day = dayOfRecord(rec, p.day);
      storeFor(day).upsert(rec);
      if (rec.end != null) {
        delete pending[id];
        refreshed++;
      }
    } catch (e) {
      if (e.permanent) delete pending[id]; // 404/400 : partie introuvable -> abandon
      // sinon : on garde pour la prochaine passe
    }
  }

  for (const s of stores.values()) s.flush();
  savePending(pending);
  return refreshed;
}

module.exports = { enumerateWindows, runIndexCatchup, INDEX_STATE_FILE, logIndex };
