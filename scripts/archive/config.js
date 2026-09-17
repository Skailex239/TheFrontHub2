"use strict";
/**
 * config.js — Configuration centrale du module d'archive TheFrontHub.
 *
 * TOUT est surchargeable par variables d'environnement (ou par le .env du repo,
 * charge manuellement avec le meme pattern que openfront-api.js).
 *
 * Principe Task 12 : stocker TOUTES les parties (tous types) en metadonnees,
 * + les parties COMPLETES (avec turns) pour les types choisis, en fichiers
 * JSONL compresses gzip, reutilisables pour reconstruire un site de stats
 * (ofstats-like) et extensibles aux speedruns.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/* ── Chargement du .env du repo (n'ecrase PAS l'environnement existant) ── */
(function loadEnv() {
  const envPath = path.join(__dirname, "..", "..", ".env");
  try {
    const content = fs.readFileSync(envPath, "utf8");
    content.split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const eq = t.indexOf("=");
      if (eq <= 0) return;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    });
  } catch (_) {
    /* .env optionnel */
  }
})();

const API_BASE =
  process.env.OPENFRONT_API_BASE || "https://api.openfront.io";

/* Exemption rate-limit OpenFront (header x-skailex-access).
   Deux noms supportes : OPENFRONT_SKAILEX_ACCESS (openfront-api.js)
   et SKAILEX_ACCESS_TOKEN (sync-player-games.js). */
const ACCESS_TOKEN =
  process.env.OPENFRONT_SKAILEX_ACCESS ||
  process.env.SKAILEX_ACCESS_TOKEN ||
  "";

/* Repertoire de stockage des donnees.
   IMPORTANT : hors repo et hors webroot (jamais touches par deploy.sh/rsync).
   Defaut : ~/thefronthub-archive  (sur o2switch : /home2/mask6607/thefronthub-archive) */
const DATA_DIR =
  process.env.ARCHIVE_DATA_DIR ||
  path.join(os.homedir(), "thefronthub-archive");

/* ── Index (listing /public/games, TOUS types) ── */
const INDEX = {
  // Le listing n'existe que depuis ~01/06/2025 (mesure Task 6).
  START_DATE: process.env.ARCHIVE_INDEX_START || "2025-06-01T00:00:00.000Z",
  // Limite API mesuree : 48 h PILE -> 400. On garde une marge de 1 minute.
  WINDOW_MS: 47 * 60 * 60 * 1000 + 59 * 60 * 1000,
  PAGE_LIMIT: 1000, // cap API strict (1001+ -> 400 zod)
  // Marge de securite : on n'indexe pas les parties demarrees recemment
  // (leur record listing est encore incomplet ; le refresh pending les rattrape).
  LAG_MS: Number(process.env.ARCHIVE_INDEX_LAG_MIN || 60) * 60 * 1000,
};

/* ── Turns (parties COMPLETES avec tous les tours) ── */
const TURNS = {
  enabled: (process.env.ARCHIVE_TURNS_ENABLED || "true") !== "false",
  // Types pour lesquels on stocke les parties completes.
  // "Public" par defaut (volume maitrise). Pour elargir : "Public,Private".
  // SPEEDRUNS plus tard : ajouter un filtre `modes` (ex ["Free For All"])
  // ou un nouveau type si OpenFront en introduit un.
  types: (process.env.ARCHIVE_TURNS_TYPES || "Public")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  modes: (process.env.ARCHIVE_TURNS_MODES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean), // vide = tous les modes
  onlyRanked: (process.env.ARCHIVE_TURNS_ONLY_RANKED || "false") === "true",
  CONCURRENCY: Math.max(1, Number(process.env.ARCHIVE_TURNS_CONCURRENCY || 3)),
};

/* ── HTTP ── */
const HTTP = {
  TIMEOUT_MS: Number(process.env.ARCHIVE_HTTP_TIMEOUT_MS || 45000),
  MAX_RETRIES: Number(process.env.ARCHIVE_HTTP_RETRIES || 6),
  RETRY_BASE_MS: Number(process.env.ARCHIVE_HTTP_RETRY_BASE_MS || 1500),
};

/* ── Divers ── */
const MISC = {
  // Les records listing avec end==null (partie pas encore finie) sont mis de
  // cote puis rafraichis automatiquement par les syncs suivants.
  PENDING_MAX: Number(process.env.ARCHIVE_PENDING_MAX || 50000),
  // Duree de conservation des entrees du journal turns (jours).
  JOURNAL_RETENTION_DAYS: Number(
    process.env.ARCHIVE_JOURNAL_RETENTION_DAYS || 45
  ),
  // Verrou anti-chevauchement des crons (minutes avant expiration).
  LOCK_TTL_MIN: Number(process.env.ARCHIVE_LOCK_TTL_MIN || 180),
};

module.exports = { API_BASE, ACCESS_TOKEN, DATA_DIR, INDEX, TURNS, HTTP, MISC };
