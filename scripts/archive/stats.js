#!/usr/bin/env node
"use strict";
/**
 * stats.js — Santé de l'archive : couverture, gaps, volumes disque.
 *
 * Usage :
 *   node scripts/archive/stats.js
 *   node scripts/archive/stats.js --json
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR, INDEX } = require("./config.js");
const {
  indexGzPath,
  indexManifestPath,
  turnsManifestPath,
} = require("./lib-store.js");
const { readJson } = require("./lib-state.js");
const { INDEX_STATE_FILE } = require("./lib-index.js");

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

function human(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + " Go";
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + " Mo";
  if (bytes > 1e3) return (bytes / 1e3).toFixed(1) + " Ko";
  return bytes + " o";
}

function main() {
  const asJson = process.argv.includes("--json");
  const today = new Date().toISOString().slice(0, 10);
  const startDay = INDEX.START_DATE.slice(0, 10);

  /* Index : jours compactés et gaps. */
  const months = [];
  const gzDir = path.join(DATA_DIR, "index", "gz");
  if (fs.existsSync(gzDir)) {
    for (const f of fs.readdirSync(gzDir).sort()) {
      if (f.endsWith(".jsonl.gz")) months.push(f.replace(".jsonl.gz", ""));
    }
  }
  const compactedDays = new Set();
  const indexCounts = {};
  let indexTotal = 0;
  for (const m of months) {
    const man = readJson(indexManifestPath(m), null);
    if (man && man.days) {
      for (const d of Object.keys(man.days)) {
        compactedDays.add(d);
        indexCounts[d] = man.days[d].count;
        indexTotal += man.days[d].count || 0;
      }
    }
  }
  const rawDir = path.join(DATA_DIR, "index", "raw");
  const rawDays = fs.existsSync(rawDir)
    ? fs.readdirSync(rawDir).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(".jsonl", "")).sort()
    : [];

  /* Gaps : jours ouvrables (>= START_DATE, <= hier) sans raw ni compactage. */
  const gaps = [];
  for (let ms = Date.parse(`${startDay}T00:00:00.000Z`); ms < Date.parse(`${today}T00:00:00.000Z`); ms += 86400e3) {
    const d = new Date(ms).toISOString().slice(0, 10);
    if (!compactedDays.has(d) && !rawDays.includes(d)) gaps.push(d);
  }

  /* Turns. */
  const gamesDir = path.join(DATA_DIR, "games");
  const turns = {};
  let turnsTotal = 0;
  if (fs.existsSync(gamesDir)) {
    for (const t of fs.readdirSync(gamesDir)) {
      const manDir = path.join(gamesDir, t, "manifest");
      if (!fs.existsSync(manDir)) continue;
      const files = fs.readdirSync(manDir).filter((f) => f.endsWith(".json")).sort();
      turns[t] = { days: files.length, firstDay: null, lastDay: null, count: 0 };
      for (const f of files) {
        const man = readJson(path.join(manDir, f), null);
        if (man) {
          turns[t].count += man.count || 0;
          const d = f.replace(".json", "");
          if (!turns[t].firstDay) turns[t].firstDay = d;
          turns[t].lastDay = d;
        }
      }
      turnsTotal += turns[t].count;
    }
  }

  /* Curseurs. */
  const indexState = readJson(INDEX_STATE_FILE, { windowsDone: {} });
  const windowsDone = Object.keys(indexState.windowsDone || {}).length;

  const report = {
    dataDir: DATA_DIR,
    index: {
      windowsDone,
      compactedDays: compactedDays.size,
      rawDaysPendingCompact: rawDays.length,
      gamesIndexed: indexTotal,
      months: months.length,
      gaps: gaps.length,
      gapsSample: gaps.slice(0, 15),
      lastDays: Object.keys(indexCounts).sort().slice(-7).map((d) => ({ day: d, count: indexCounts[d] })),
    },
    turns: {
      totalGames: turnsTotal,
      byType: turns,
    },
    disk: {
      indexRaw: human(dirSize(path.join(DATA_DIR, "index", "raw"))),
      indexGz: human(dirSize(path.join(DATA_DIR, "index", "gz"))),
      gamesRaw: human(dirSize(path.join(DATA_DIR, "games"))),
      total: human(dirSize(DATA_DIR)),
    },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("════════════════════════════════════════════════════════");
  console.log(` ARCHIVE THEFRONTHUB — ${DATA_DIR}`);
  console.log("════════════════════════════════════════════════════════");
  console.log(` INDEX  : ${report.index.gamesIndexed.toLocaleString("fr-FR")} parties indexées (tous types)`);
  console.log(`          ${report.index.windowsDone} fenêtres faites, ${report.index.compactedDays} jours compactés, ${report.index.rawDaysPendingCompact} raw en attente`);
  console.log(`          gaps : ${report.index.gaps}${report.index.gaps ? " -> " + report.index.gapsSample.join(", ") : ""}`);
  if (report.index.lastDays.length) {
    console.log("          7 derniers jours compactés :");
    for (const d of report.index.lastDays) console.log(`            ${d.day} : ${d.count.toLocaleString("fr-FR")} parties`);
  }
  console.log(` TURNS  : ${turnsTotal.toLocaleString("fr-FR")} parties complètes stockées`);
  for (const [t, v] of Object.entries(turns)) {
    console.log(`          ${t} : ${v.count.toLocaleString("fr-FR")} parties, ${v.days} jours (${v.firstDay} -> ${v.lastDay})`);
  }
  console.log(` DISQUE : index raw=${report.disk.indexRaw}, index gz=${report.disk.indexGz}, games=${report.disk.gamesRaw}, TOTAL=${report.disk.total}`);
  console.log("════════════════════════════════════════════════════════");
}

main();
