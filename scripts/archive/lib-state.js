"use strict";
/**
 * lib-state.js — Etats de reprise, journaux crash-safe et verrous.
 *
 * Principes :
 *  - Toute ecriture d'etat est ATOMIQUE (tmp + rename) : jamais d'etat corrompu.
 *  - Les journaux ("journal") sont append-only : une ligne JSON par evenement,
 *    les lignes tronquees par un crash sont simplement ignorees a la relecture.
 *  - Un verrou fichier (lock) empeche deux crons de tourner en parallele ;
 *    il expire automatiquement (TTL) pour eviter tout blocage permanent.
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR, MISC } = require("./config.js");

const STATE_DIR = path.join(DATA_DIR, "state");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

/* Ecriture atomique : tmp dans le meme dossier puis rename (POSIX atomique). */
function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj) + "\n");
  fs.renameSync(tmp, file);
}

/* ── Journaux append-only (crash-safe) ── */
function appendJournal(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function readJournal(file) {
  const out = [];
  try {
    const content = fs.readFileSync(file, "utf8");
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch (_) {
        /* ligne tronquee par un crash : ignoree */
      }
    }
  } catch (_) {
    /* fichier absent */
  }
  return out;
}

/* Reecrit un journal atomiquement (utilise pour la rotation/retention). */
function rewriteJournal(file, entries) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(tmp, (body ? body + "\n" : "") );
  fs.renameSync(tmp, file);
}

/* ── Verrou anti-chevauchement (TTL auto-expire) ── */
function lockFileFor(jobName) {
  return path.join(STATE_DIR, `lock-${jobName}.json`);
}

/**
 * Tente d'acquerir le verrou. Retourne true si acquis, false si un autre
 * process sature detient un verrou NON expire.
 */
function acquireLock(jobName) {
  ensureDir(STATE_DIR);
  const file = lockFileFor(jobName);
  const ttlMs = MISC.LOCK_TTL_MIN * 60 * 1000;
  const existing = readJson(file, null);
  if (
    existing &&
    typeof existing.ts === "number" &&
    Date.now() - existing.ts < ttlMs
  ) {
    return false;
  }
  writeJsonAtomic(file, { pid: process.pid, ts: Date.now(), job: jobName });
  return true;
}

function releaseLock(jobName) {
  try {
    fs.unlinkSync(lockFileFor(jobName));
  } catch (_) {
    /* deja parti */
  }
}

module.exports = {
  STATE_DIR,
  ensureDir,
  readJson,
  writeJsonAtomic,
  appendJournal,
  readJournal,
  rewriteJournal,
  acquireLock,
  releaseLock,
};
