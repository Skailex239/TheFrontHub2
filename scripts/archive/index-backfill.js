#!/usr/bin/env node
"use strict";
/**
 * index-backfill.js — Backfill COMPLET de l'index (listing /public/games, TOUS types).
 *
 * Stocke, pour chaque partie depuis le 01/06/2025 (disponibilité du listing),
 * toutes ses métadonnées : gameID, start, end, type, mode, difficulty,
 * numPlayers, maxPlayers, lobbyFillTime, playerTeams, rankedType...
 * → fichiers index/raw/<jour>.jsonl, ensuite compactés en index/gz/<mois>.jsonl.gz.
 *
 * Reprise EXACTE : relancer la commande reprend où elle s'était arrêtée
 * (state/index.json). --reset efface la mémoire de reprise.
 *
 * Usage :
 *   node scripts/archive/index-backfill.js
 *   node scripts/archive/index-backfill.js --from=2025-06-01T00:00:00.000Z --to=2026-09-20T00:00:00.000Z
 *   node scripts/archive/index-backfill.js --workers=2          # 2 fenêtres en parallèle
 *   node scripts/archive/index-backfill.js --reset              # reprendre depuis zéro
 *
 * Volume estimé (mesures Task 6) : ~170k parties/jour tous types ≈ 100-200 requêtes
 * de listing par jour couvert ; 15 mois ≈ 50-80k requêtes (quelques heures à une nuit).
 */

const { INDEX, DATA_DIR } = require("./config.js");
const { acquireLock, releaseLock, readJson, writeJsonAtomic } = require("./lib-state.js");
const { INDEX_STATE_FILE, runIndexCatchup, logIndex } = require("./lib-index.js");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  if (!acquireLock("index")) {
    logIndex("un autre job d'indexation tourne déjà (verrou) — sortie");
    process.exit(0);
  }

  try {
    if (hasFlag("reset")) {
      writeJsonAtomic(INDEX_STATE_FILE, { windowsDone: {}, updatedAt: null });
      logIndex("état de reprise réinitialisé (--reset)");
    }

    const fromArg = arg("from", null);
    const toArg = arg("to", null);
    const workers = Math.max(1, Number(arg("workers", 1)));

    const fromMs = fromArg ? Date.parse(fromArg) : Date.parse(INDEX.START_DATE);
    const toMs = toArg ? Date.parse(toArg) : Date.now() - INDEX.LAG_MS;

    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      logIndex(`plage invalide (from=${fromArg} to=${toArg}) — rien à faire`);
      return;
    }

    logIndex(`BACKFILL index : de ${new Date(fromMs).toISOString()} à ${new Date(toMs).toISOString()}`);
    logIndex(`stockage : ${DATA_DIR}`);

    const res = await runIndexCatchup({ fromMs, toMs, workers, pendingRefresh: true, label: "backfill" });
    logIndex(`résultat : ${JSON.stringify(res)}`);
  } finally {
    releaseLock("index");
  }
}

main().catch((e) => {
  logIndex(`FATAL : ${e.stack || e.message}`);
  releaseLock("index");
  process.exit(1);
});
