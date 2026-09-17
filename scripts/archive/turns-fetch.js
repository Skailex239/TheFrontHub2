#!/usr/bin/env node
"use strict";
/**
 * turns-fetch.js — Télécharge les parties COMPLETES (avec tous les turns)
 * pour les types configurés (défaut : "Public").
 *
 * Source des IDs : l'index local (index/raw/<jour>.jsonl, ou index/gz/<mois>.jsonl.gz
 * si le jour est déjà compacté). L'index doit donc exister pour le jour visé.
 *
 * Robustesse :
 *   - Journal append-only par type (state/turns-<Type>.journal) : une partie
 *     déjà téléchargée n'est JAMAIS re-téléchargée, même après un crash.
 *   - Erreurs permanentes (404) journalisées -> ignorées définitivement.
 *   - Quand une journée est 100% téléchargée -> compactage automatique
 *     (gz + manifest + suppression du raw) puis purge du journal.
 *
 * Usage :
 *   node scripts/archive/turns-fetch.js                       # hier (UTC)
 *   node scripts/archive/turns-fetch.js --day=2026-09-19      # un jour précis
 *   node scripts/archive/turns-fetch.js --from-day=2026-09-01 --to-day=2026-09-19
 *   node scripts/archive/turns-fetch.js --types=Public,Private
 *   node scripts/archive/turns-fetch.js --max=50              # limite (tests)
 *
 * Volume (mesures Task 6) : ~2 860 à 8 749 parties Public/jour ;
 * à concurrency=3, ~40-70 min par jour récent. Historique 15 mois ≈ 2-3 semaines
 * de fetch continu (ou réduire ARCHIVE_TURNS_TYPES / élever la concurrency).
 */

const fs = require("fs");
const path = require("path");
const { TURNS, MISC, DATA_DIR } = require("./config.js");
const { getGame } = require("./lib-api.js");
const {
  indexRawPath,
  indexGzPath,
  indexManifestPath,
  turnsRawPath,
  turnsManifestPath,
  iterJsonl,
  gameIdOf,
  compactTurnsDay,
} = require("./lib-store.js");
const {
  STATE_DIR,
  appendJournal,
  readJournal,
  rewriteJournal,
  acquireLock,
  releaseLock,
} = require("./lib-state.js");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function dayMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function logT(msg) {
  console.log(`[archive-turns ${new Date().toISOString()}] ${msg}`);
}

/* ── Récupère les records listing d'un jour (raw ou gz mensuel) ── */
async function loadIndexRecordsForDay(day) {
  const raw = indexRawPath(day);
  const out = [];
  if (fs.existsSync(raw)) {
    await iterJsonl(raw, (t) => out.push(t));
    return { records: out, source: "raw" };
  }
  // jour compacté ? -> filtre le gz mensuel
  const manifest = fs.existsSync(indexManifestPath(day.slice(0, 7)))
    ? JSON.parse(fs.readFileSync(indexManifestPath(day.slice(0, 7)), "utf8"))
    : null;
  if (manifest && manifest.days && manifest.days[day]) {
    const gz = indexGzPath(day.slice(0, 7));
    const filtered = [];
    await iterJsonl(gz, (t) => {
      // filtre par jour de start (lecture streaming du mois complet)
      const s = t.indexOf('"start":"');
      if (s !== -1 && t.slice(s + 9, s + 19) === day) {
        filtered.push(t);
      }
    });
    return { records: filtered, source: "gz" };
  }
  return { records: null, source: "missing" };
}

/* ── Journal d'un type ── */
function journalPath(type) {
  return path.join(STATE_DIR, `turns-${type}.journal`);
}
function loadDone(type) {
  const done = new Set();
  for (const e of readJournal(journalPath(type))) {
    if (e && e.id) done.add(String(e.id));
  }
  return done;
}
function pruneJournal(type) {
  const keepDays = new Set();
  const entries = readJournal(journalPath(type));
  const kept = [];
  for (const e of entries) {
    if (!e || !e.id) continue;
    // on garde une entrée si le jour n'est PAS compacté (manifest absent)
    const compacted =
      e.day && fs.existsSync(turnsManifestPath(type, e.day));
    if (!compacted) kept.push(e);
  }
  if (kept.length !== entries.length) {
    rewriteJournal(journalPath(type), kept);
    logT(`journal ${type} purgé : ${entries.length - kept.length} entrée(s) (jours déjà compactés)`);
  }
  void keepDays;
  void MISC.JOURNAL_RETENTION_DAYS;
}

/* ── Pool de téléchargement ── */
async function fetchDayType({ type, day, ids, done, max }) {
  const todo = ids.filter((id) => !done.has(id));
  if (!todo.length) return { done: 0, skipped404: 0, failed: 0 };

  const rawFile = turnsRawPath(type, day);
  const rawDir = path.dirname(rawFile);
  fs.mkdirSync(rawDir, { recursive: true });

  let ok = 0;
  let notFound = 0;
  let failed = 0;
  const t0 = Date.now();
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      if (max && ok >= max) return;
      const id = todo[i];
      try {
        const game = await getGame(id);
        const gid = String(gameIdOf(game) || id);
        fs.appendFileSync(rawFile, JSON.stringify(game) + "\n");
        appendJournal(journalPath(type), { id: gid, day, t: Date.now() });
        done.add(gid);
        ok++;
        if (ok % 250 === 0) {
          const rate = ok / ((Date.now() - t0) / 1000);
          const etaMin = ((todo.length - ok) / Math.max(rate, 0.01) / 60).toFixed(1);
          logT(`${type} ${day} : ${ok}/${todo.length} téléchargées (${rate.toFixed(1)}/s, ETA ${etaMin} min)`);
        }
      } catch (e) {
        if (e && e.permanent) {
          // 404/400 : partie indisponible côté API -> journalisée, on n'y reviendra plus
          appendJournal(journalPath(type), { id, day, t: Date.now(), err: "gone" });
          done.add(id);
          notFound++;
        } else {
          failed++;
          // non journalisée -> retentée à la prochaine passe
          if (failed % 25 === 0) {
            logT(`avertissement ${type} ${day} : ${failed} échecs transitoires (dernier : ${e.message})`);
          }
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(TURNS.CONCURRENCY, todo.length) }, () => worker())
  );

  const rate = ok / Math.max((Date.now() - t0) / 1000, 1);
  logT(`${type} ${day} : passe terminée — ${ok} ok, ${notFound} introuvables, ${failed} échecs (${rate.toFixed(1)}/s)`);
  return { done: ok, skipped404: notFound, failed };
}

/* ── Traitement d'un jour ── */
async function processDay(day, types, max) {
  const { records, source } = await loadIndexRecordsForDay(day);
  if (records === null) {
    logT(`jour ${day} : index absent (ni raw, ni compacté) — lancer l'index d'abord. Ignoré.`);
    return { skipped: true };
  }
  logT(`jour ${day} : ${records.length} records d'index (source: ${source})`);

  /* Filtre par type/modes/ranked. */
  const perType = new Map(); // type -> Set(ids)
  for (const t of records) {
    let rec;
    try {
      rec = JSON.parse(t);
    } catch (_) {
      continue;
    }
    if (!types.includes(rec.type)) continue;
    if (TURNS.modes.length && !TURNS.modes.includes(rec.mode)) continue;
    if (TURNS.onlyRanked && rec.rankedType == null) continue;
    const id = String(gameIdOf(rec) || "");
    if (!id) continue;
    if (!perType.has(rec.type)) perType.set(rec.type, new Set());
    perType.get(rec.type).add(id);
  }

  const summary = { skipped: false, types: {} };
  for (const type of perType.keys()) {
    const ids = Array.from(perType.get(type));
    const manifest = turnsManifestPath(type, day);
    if (fs.existsSync(manifest)) {
      logT(`${type} ${day} : déjà compacté (manifest présent) — rien à faire`);
      summary.types[type] = { status: "done" };
      continue;
    }
    const done = loadDone(type);
    const res = await fetchDayType({ type, day, ids, done, max });
    summary.types[type] = { status: "fetched", ...res, total: ids.length };

    /* Journée 100% traitée (toutes les IDs journalisées/404) -> compactage auto. */
    const doneNow = loadDone(type);
    const allDone = ids.every((id) => doneNow.has(id));
    if (allDone && ids.length > 0) {
      const c = await compactTurnsDay(type, day);
      if (c.ok) {
        logT(`${type} ${day} : compacté -> ${c.count} parties, raw supprimé`);
        pruneJournal(type);
      }
    } else {
      logT(`${type} ${day} : incomplet (${doneNow.size}/${ids.length}) — repris à la prochaine passe`);
    }
    if (max && res.done >= max) {
      logT(`--max=${max} atteint — arrêt.`);
      break;
    }
  }
  return summary;
}

async function main() {
  if (!TURNS.enabled) {
    logT("ARCHIVE_TURNS_ENABLED=false — stockage des turns désactivé.");
    return;
  }
  if (!acquireLock("turns")) {
    logT("un autre fetch de turns tourne déjà (verrou) — sortie");
    return;
  }

  try {
    const types = (arg("types", TURNS.types.join(",")) || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const max = Number(arg("max", 0)) || 0;

    let days = [];
    if (hasFlag("today")) days.push(utcDay(Date.now()));
    if (arg("day", null)) days = [arg("day")];
    if (arg("from-day", null)) {
      const from = arg("from-day");
      const to = arg("to-day", utcDay(Date.now() - 86400e3));
      for (let ms = dayMs(from); ms <= dayMs(to); ms += 86400e3) {
        days.push(utcDay(ms));
      }
    }
    if (!days.length) days = [utcDay(Date.now() - 86400e3)]; // hier par défaut

    logT(`fetch turns — types=${types.join(",")} jours=${days[0]}${days.length > 1 ? `..${days[days.length - 1]}` : ""}${max ? ` max=${max}` : ""} concurrency=${TURNS.CONCURRENCY}`);

    for (const day of days) {
      await processDay(day, types, max);
    }
  } finally {
    releaseLock("turns");
  }
}

main().catch((e) => {
  logT(`FATAL : ${e.stack || e.message}`);
  releaseLock("turns");
  process.exit(1);
});
