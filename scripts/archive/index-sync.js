#!/usr/bin/env node
"use strict";
/**
 * index-sync.js — Rattrapage incrémental de l'index (conçu pour CRON).
 *
 * Fait 3 choses, vite et silencieusement :
 *   1. Indexe les fenêtres pas encore couvertes (depuis la dernière passe
 *      jusqu'à now - ARCHIVE_INDEX_LAG_MIN minutes).
 *   2. Rafraîchit les parties "en cours" (records end==null notés en pending)
 *      jusqu'à obtenir leur record complet.
 *   3. Sort toujours avec code 0 sauf erreur fatale (cron-friendly).
 *
 * Usage cron (toutes les heures, par exemple) :
 *   cd /home2/mask6607/thefronthub-src && /usr/local/bin/node scripts/archive/index-sync.js >> /home2/mask6607/logs/archive-index.log 2>&1
 *
 * Premier lancement sans backfill préalable : couvre les 48 dernières heures,
 * le backfill (index-backfill.js) reste indispensable pour l'historique complet.
 */

const { INDEX } = require("./config.js");
const { acquireLock, releaseLock } = require("./lib-state.js");
const { runIndexCatchup, logIndex } = require("./lib-index.js");

async function main() {
  if (!acquireLock("index")) {
    // Normal si le backfill tourne en parallèle : on cède sans bruit.
    process.exit(0);
  }
  try {
    const toMs = Date.now() - INDEX.LAG_MS;
    const res = await runIndexCatchup({
      toMs,
      workers: 1,
      pendingRefresh: true,
      label: "sync",
    });
    // Code de sortie 0 même en cas de fenêtres en erreur (elles seront reprises).
  } finally {
    releaseLock("index");
  }
}

main().catch((e) => {
  logIndex(`FATAL : ${e.stack || e.message}`);
  releaseLock("index");
  process.exit(1);
});
