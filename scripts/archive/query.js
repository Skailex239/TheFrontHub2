#!/usr/bin/env node
"use strict";
/**
 * query.js — Exploration de l'archive en ligne de commande.
 *
 * L'archive est la SOURCE DE VERITE pour reconstruire n'importe quel service
 * de stats (ofstats-like). Exemples :
 *
 *   # comptes par jour/type
 *   node scripts/archive/query.js count --day=2026-09-19
 *   node scripts/archive/query.js count --month=2026-09 --type=Public
 *
 *   # parties d'un jour (métadonnées d'index)
 *   node scripts/archive/query.js games --day=2026-09-19 --type=Public --limit=10
 *   node scripts/archive/query.js games --day=2026-09-19 --mode="Free For All" --min-players=10 --limit=20
 *
 *   # parties COMPLÈTES stockées (avec turns) d'un jour/type
 *   node scripts/archive/query.js full --day=2026-09-19 --type=Public --limit=5
 *
 *   # vitesse : parties les plus courtes d'un jour (base speedrun)
 *   node scripts/archive/query.js full --day=2026-09-19 --type=Public --limit=5 --sort=duration
 *
 * Sortie : tableau lisible, ou JSON avec --json.
 */

const fs = require("fs");
const {
  indexGzPath,
  indexRawPath,
  turnsGzPath,
  turnsManifestPath,
  indexManifestPath,
  iterJsonl,
} = require("./lib-store.js");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

function fmtDuration(s) {
  if (s == null) return "?";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m${String(r).padStart(2, "0")}s`;
}

/* Choisit la source d'index d'un jour : raw si présent, sinon gz mensuel filtré. */
async function* iterIndexDay(day) {
  const raw = indexRawPath(day);
  if (fs.existsSync(raw)) {
    for await (const t of iterGen(raw)) yield t;
    return;
  }
  const man = fs.existsSync(indexManifestPath(day.slice(0, 7)));
  if (!man) return;
  const gz = indexGzPath(day.slice(0, 7));
  for await (const t of iterGen(gz)) {
    const s = t.indexOf('"start":"');
    if (s !== -1 && t.slice(s + 9, s + 19) === day) yield t;
  }
}

/* petit adaptateur : iterJsonl callback -> async generator */
async function* iterGen(file) {
  const queue = [];
  let done = false;
  let error = null;
  const p = iterJsonl(file, (t) => queue.push(t)).then(() => (done = true)).catch((e) => (error = e));
  while (true) {
    if (queue.length) yield queue.shift();
    else if (error) throw error;
    else if (done) return;
    else await new Promise((r) => setImmediate(r));
  }
}

async function cmdCount() {
  const day = arg("day", null);
  const month = arg("month", null);
  const type = arg("type", null);
  const mode = arg("mode", null);
  const counts = {};
  let total = 0;

  if (day) {
    for await (const t of iterIndexDay(day)) {
      try {
        const r = JSON.parse(t);
        if (type && r.type !== type) continue;
        if (mode && r.mode !== mode) continue;
        const k = r.type || "?";
        counts[k] = (counts[k] || 0) + 1;
        total++;
      } catch (_) {}
    }
  } else if (month) {
    for (let d = 1; d <= 31; d++) {
      const dd = `${month}-${String(d).padStart(2, "0")}`;
      for await (const t of iterIndexDay(dd)) {
        try {
          const r = JSON.parse(t);
          if (type && r.type !== type) continue;
          if (mode && r.mode !== mode) continue;
          counts[r.type || "?"] = (counts[r.type || "?"] || 0) + 1;
          total++;
        } catch (_) {}
      }
    }
  } else {
    console.error("précise --day= ou --month=");
    process.exit(2);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ total, counts }, null, 2));
  } else {
    console.log(`total : ${total.toLocaleString("fr-FR")}`);
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(15)} ${v.toLocaleString("fr-FR")}`);
    }
  }
}

async function cmdGames() {
  const day = arg("day");
  if (!day) {
    console.error("précise --day=");
    process.exit(2);
  }
  const type = arg("type", null);
  const mode = arg("mode", null);
  const minPlayers = Number(arg("min-players", 0)) || 0;
  const limit = Number(arg("limit", 20)) || 20;
  const asJson = process.argv.includes("--json");

  const rows = [];
  for await (const t of iterIndexDay(day)) {
    try {
      const r = JSON.parse(t);
      if (type && r.type !== type) continue;
      if (mode && r.mode !== mode) continue;
      if (minPlayers && (r.numPlayers == null || r.numPlayers < minPlayers)) continue;
      rows.push(r);
      if (rows.length >= limit * 3) break; // échantillon suffisant
    } catch (_) {}
  }
  rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const out = rows.slice(0, limit);
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    for (const r of out) {
      console.log(
        `${r.start}  ${String(r.game ?? r.gameID ?? "?").padEnd(12)} ${String(r.type).padEnd(14)} ${String(r.mode).padEnd(18)} ${String(r.numPlayers ?? "?").padStart(3)}j  ranked=${r.rankedType ?? "-"}`
      );
    }
    if (!out.length) console.log("(aucune partie)");
  }
}

async function cmdFull() {
  const day = arg("day");
  const type = arg("type", "Public");
  if (!day) {
    console.error("précise --day=");
    process.exit(2);
  }
  const limit = Number(arg("limit", 10)) || 10;
  const asJson = process.argv.includes("--json");
  const sort = arg("sort", "start"); // start | duration
  const player = arg("player", null);

  const gz = turnsGzPath(type, day);
  if (!fs.existsSync(gz)) {
    console.error(`aucune partie complète pour ${type} le ${day} (gz absent)`);
    process.exit(1);
  }

  const rows = [];
  for await (const t of iterGen(gz)) {
    try {
      const g = JSON.parse(t);
      const info = g.info || {};
      if (player) {
        const players = info.players || [];
        if (!players.some((p) => String(p.username || "").toLowerCase() === player.toLowerCase())) continue;
      }
      rows.push({
        gameID: info.gameID,
        start: info.start,
        duration: info.duration,
        numPlayers: info.numPlayers ?? (info.players || []).length,
        winner: info.winner,
        turns: (g.turns || []).length,
        gitCommit: g.gitCommit,
      });
      if (rows.length >= limit * 4) break;
    } catch (_) {}
  }
  if (sort === "duration") rows.sort((a, b) => (a.duration ?? 1e12) - (b.duration ?? 1e12));
  else rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const out = rows.slice(0, limit);
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    for (const r of out) {
      console.log(
        `${r.gameID?.padEnd(12)} ${r.start}  ${fmtDuration(r.duration).padStart(6)}  ${String(r.numPlayers).padStart(3)}j  ${String(r.turns).padStart(4)} turns  gagnant=${r.winner ?? "?"}`
      );
    }
    if (!out.length) console.log("(aucune partie)");
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "count") await cmdCount();
  else if (cmd === "games") await cmdGames();
  else if (cmd === "full") await cmdFull();
  else {
    console.log("usage : node scripts/archive/query.js <count|games|full> [--day=...] [--month=...] [--type=...] [--mode=...] [--limit=...] [--json]");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`FATAL : ${e.message}`);
  process.exit(1);
});
