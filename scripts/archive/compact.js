#!/usr/bin/env node
"use strict";
/**
 * compact.js — Compactage manuel/forçable de l'archive (gzip -9 + dédup + manifest).
 *
 * En usage normal, le compactage est AUTOMATIQUE :
 *   - l'index est compacté par le cron nocturne (compact.js --all-index) ;
 *   - les turns sont compactés dès qu'une journée est 100% téléchargée.
 * Ce script sert pour rattraper/réparer à la main.
 *
 * Usage :
 *   node scripts/archive/compact.js --day=2026-09-19            # 1 jour d'index
 *   node scripts/archive/compact.js --month=2026-09             # tous les jours d'index d'un mois
 *   node scripts/archive/compact.js --turns --type=Public --day=2026-09-19
 *   node scripts/archive/compact.js --all-index                 # tout ce qui traîne
 *   node scripts/archive/compact.js --all-turns                 # tous les raw turns qui traînent
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config.js");
const {
  indexRawPath,
  compactIndexDay,
  compactTurnsDay,
} = require("./lib-store.js");
const { TURNS } = require("./config.js");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function logC(msg) {
  console.log(`[archive-compact ${new Date().toISOString()}] ${msg}`);
}

function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = [];
  for (let d = 1; d <= last; d++) {
    days.push(`${month}-${String(d).padStart(2, "0")}`);
  }
  return days;
}

async function main() {
  const day = arg("day", null);
  const month = arg("month", null);
  const turns = hasFlag("turns");
  const type = arg("type", TURNS.types[0] || "Public");
  const allIndex = hasFlag("all-index");
  const allTurns = hasFlag("all-turns");

  let did = 0;

  /* ── Index ── */
  if (allIndex) {
    const rawDir = path.join(DATA_DIR, "index", "raw");
    if (fs.existsSync(rawDir)) {
      for (const f of fs.readdirSync(rawDir).sort()) {
        if (f.endsWith(".jsonl")) {
          const r = await compactIndexDay(f.replace(/\.jsonl$/, ""));
          logC(`index ${f} : ${JSON.stringify(r)}`);
          did++;
        }
      }
    }
  } else if (month) {
    for (const d of daysInMonth(month)) {
      if (fs.existsSync(indexRawPath(d))) {
        const r = await compactIndexDay(d);
        logC(`index ${d} : ${JSON.stringify(r)}`);
        did++;
      }
    }
  } else if (day && !turns) {
    const r = await compactIndexDay(day);
    logC(`index ${day} : ${JSON.stringify(r)}`);
    did++;
  }

  /* ── Turns ── */
  if (allTurns) {
    const gamesDir = path.join(DATA_DIR, "games");
    if (fs.existsSync(gamesDir)) {
      for (const t of fs.readdirSync(gamesDir)) {
        const rawDir = path.join(gamesDir, t, "raw");
        if (!fs.existsSync(rawDir)) continue;
        for (const f of fs.readdirSync(rawDir).sort()) {
          if (f.endsWith(".jsonl")) {
            const r = await compactTurnsDay(t, f.replace(/\.jsonl$/, ""));
            logC(`turns ${t} ${f} : ${JSON.stringify(r)}`);
            did++;
          }
        }
      }
    }
  } else if (turns && day) {
    const r = await compactTurnsDay(type, day);
    logC(`turns ${type} ${day} : ${JSON.stringify(r)}`);
    did++;
  }

  if (did === 0) logC("rien à compacter (aucun raw trouvé pour les critères donnés)");
}

main().catch((e) => {
  logC(`FATAL : ${e.stack || e.message}`);
  process.exit(1);
});
