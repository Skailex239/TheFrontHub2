"use strict";
/**
 * lib-pending.js — Suivi des parties EN COURS.
 *
 * Le listing /public/games liste les parties par date de DEMARRAGE. Une partie
 * capturee pendant qu'elle tourne a un record incomplet (end == null, duration
 * absente). On note ces records dans state/pending.json et les syncs suivants
 * re-interrogent l'API (1 requete par partie, fenetre de 1 h autour du start)
 * jusqu'a obtenir le record complet. Une partie qui disparait (404) est retiree.
 */

const path = require("path");
const { MISC } = require("./config.js");
const { STATE_DIR, readJson, writeJsonAtomic } = require("./lib-state.js");
const { gameIdOf } = require("./lib-store.js");

const PENDING_FILE = path.join(STATE_DIR, "pending.json");

function loadPending() {
  return readJson(PENDING_FILE, {});
}

function savePending(pending) {
  writeJsonAtomic(PENDING_FILE, pending);
}

/**
 * Integre un record listing dans la map pending :
 *  - end != null  -> la partie est finie, on retire du pending.
 *  - end == null  -> partie en cours, on la note (garde-fou taille max).
 */
function trackPending(pending, rec) {
  const id = gameIdOf(rec);
  if (!id) return;
  const key = String(id);
  if (rec.end != null) {
    if (pending[key]) delete pending[key];
    return;
  }
  if (pending[key]) return;
  if (Object.keys(pending).length >= MISC.PENDING_MAX) return;
  pending[key] = {
    start: rec.start || null,
    day: typeof rec.start === "string" ? rec.start.slice(0, 10) : null,
    t: Date.now(),
  };
}

/** Nombre d'entrees pending. */
function pendingCount(pending) {
  return Object.keys(pending).length;
}

module.exports = { PENDING_FILE, loadPending, savePending, trackPending, pendingCount };
