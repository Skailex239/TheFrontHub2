"use strict";
/**
 * lib-store.js — Couche de stockage de l'archive.
 *
 * FORMAT (source de verite = fichiers, 100% reimportables ailleurs) :
 *
 *   DATA_DIR/
 *     index/raw/YYYY-MM-DD.jsonl            listing BRUT (1 ligne = 1 jeu, tous types)
 *     index/gz/YYYY-MM.jsonl.gz             compacte mensuel (dedef par jour, gzip -9)
 *     index/manifest/YYYY-MM.json           { days: {jour: {count}}, ... }
 *     games/<Type>/raw/YYYY-MM-DD.jsonl     parties COMPLETES (1 ligne = 1 jeu + turns)
 *     games/<Type>/gz/YYYY-MM-DD.jsonl.gz   compacte journalier (dedef, gzip -9)
 *     games/<Type>/manifest/YYYY-MM-DD.json { count, bytes, md5, ... }
 *     state/                                etats de reprise + journaux + verrous
 *     logs/                                 logs horodates
 *
 * Garanties :
 *  - Ecritures raw = append simple (crash-safe) ; reprise exacte via state/journaux.
 *  - Upsert : si le raw du jour existe DEJA (syncs repetes), il est charge en RAM
 *    (gameID -> ligne) et les records sont REMPLACES (jamais dupliques), puis le
 *    fichier est reecrit atomiquement. Sinon append direct (backfill initial, RAM min).
 *  - Compactage = dedef par gameID + gzip -9 + manifest (count/md5), puis suppression
 *    du raw => le disque ne grossit qu'avec du compresse.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const readline = require("readline");
const { DATA_DIR } = require("./config.js");
const { ensureDir, writeJsonAtomic } = require("./lib-state.js");

/* ── Chemins ── */
function indexRawPath(day) {
  return path.join(DATA_DIR, "index", "raw", `${day}.jsonl`);
}
function indexGzPath(month) {
  return path.join(DATA_DIR, "index", "gz", `${month}.jsonl.gz`);
}
function indexManifestPath(month) {
  return path.join(DATA_DIR, "index", "manifest", `${month}.json`);
}
function turnsRawPath(type, day) {
  return path.join(DATA_DIR, "games", sanitize(type), "raw", `${day}.jsonl`);
}
function turnsGzPath(type, day) {
  return path.join(DATA_DIR, "games", sanitize(type), "gz", `${day}.jsonl.gz`);
}
function turnsManifestPath(type, day) {
  return path.join(DATA_DIR, "games", sanitize(type), "manifest", `${day}.json`);
}
function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
}

/* ID de jeu, quelle que soit la forme du record (listing ou partie complete). */
function gameIdOf(rec) {
  return (
    rec?.game ??
    rec?.gameID ??
    rec?.gameId ??
    rec?.info?.gameID ??
    rec?.id ??
    null
  );
}

function dayOfRecord(rec, fallbackDay) {
  const s = rec?.start || rec?.info?.start;
  if (typeof s === "string" && s.length >= 10) return s.slice(0, 10);
  return fallbackDay;
}

/* ── Lecture streaming d'un .jsonl ou .jsonl.gz ── */
function iterJsonl(file, onLine) {
  return new Promise((resolve, reject) => {
    let stream = fs.createReadStream(file);
    if (file.endsWith(".gz")) {
      const gunzip = zlib.createGunzip();
      stream.on("error", reject);
      stream = stream.pipe(gunzip);
    }
    stream.on("error", reject);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const t = line.trim();
      if (t) onLine(t);
    });
    rl.on("close", () => resolve());
    rl.on("error", reject);
  });
}

/* ── DayStore : ecriture raw avec upsert (pas de duplication) ── */
class DayStore {
  /**
   * @param {string} file chemin du .jsonl du jour
   * @param {string} day  YYYY-MM-DD (fallback pour records sans start)
   */
  constructor(file, day) {
    this.file = file;
    this.day = day;
    this.map = null; // Map<gameID, ligne> — chargee seulement si le raw existe
    this.dirty = false;
    this.stats = { upserted: 0, replaced: 0, invalid: 0 };
  }

  _ensureMap() {
    if (this.map !== null) return;
    this.map = new Map();
    if (fs.existsSync(this.file)) {
      // Sync : le raw est deja la (sync repetes) -> chargement en RAM pour upsert.
      const content = fs.readFileSync(this.file, "utf8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const id = gameIdOf(JSON.parse(t));
          if (id) this.map.set(String(id), t);
        } catch (_) {
          /* ligne corrompue : jetee au prochain flush */
        }
      }
    }
  }

  /** Ajoute/remplace un record. Retourne "new" | "replaced" | "invalid". */
  upsert(rec) {
    const id = gameIdOf(rec);
    if (!id) {
      this.stats.invalid++;
      return "invalid";
    }
    this._ensureMap();
    const key = String(id);
    const line = JSON.stringify(rec);
    if (this.map.has(key)) {
      const prev = this.map.get(key);
      this.map.set(key, line);
      if (prev !== line) {
        this.dirty = true;
        this.stats.replaced++;
        return "replaced";
      }
      return "replaced"; // identique : rien a faire de plus
    }
    this.map.set(key, line);
    this.dirty = true;
    this.stats.upserted++;
    return "new";
  }

  /** Reecriture atomique si modifie. RAM liberee apres flush. */
  flush() {
    if (!this.dirty) {
      this.map = null;
      return;
    }
    ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, Array.from(this.map.values()).join("\n") + "\n");
    fs.renameSync(tmp, this.file);
    this.dirty = false;
    this.map = null;
  }

  get size() {
    return this.map ? this.map.size : 0;
  }
}

/* ── md5 d'un fichier (streaming) ── */
function fileMd5(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("md5");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/* ── Compactage ── */

/**
 * Compacte le raw INDEX d'un jour dans le gz MENSUEL (dedef + gzip -9).
 * Gere le cas "jour deja compacte puis raw recree" (refresh pending apres
 * compact) : le gz est alors reecrit avec les records actualises.
 * Retourne { ok, mode, count }.
 */
async function compactIndexDay(day) {
  const raw = indexRawPath(day);
  if (!fs.existsSync(raw)) return { ok: false, mode: "no-raw", count: 0 };
  const month = day.slice(0, 7);
  const gz = indexGzPath(month);
  const manifestFile = indexManifestPath(month);
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { month, days: {}, total: 0, updatedAt: null };
  if (!manifest.days) manifest.days = {};

  /* 1) Charge le raw du jour en Map (dedef intra-jour, dernier gagne). */
  const map = new Map();
  await iterJsonl(raw, (t) => {
    try {
      const id = gameIdOf(JSON.parse(t));
      if (id) map.set(String(id), t);
    } catch (_) {}
  });

  const previouslyCompacted = Boolean(manifest.days[day]);

  /* 2) Ecrit le gz. */
  ensureDir(path.dirname(gz));
  const tmpGz = `${gz}.tmp-${process.pid}`;
  let written = 0;

  if (previouslyCompacted && fs.existsSync(gz)) {
    /* Reecriture : remplace les records de ce jour par les versions fraiches. */
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpGz);
      const gzf = zlib.createGzip({ level: 9 });
      gzf.pipe(out);
      let stream = fs.createReadStream(gz);
      const gun = zlib.createGunzip();
      stream.on("error", reject);
      stream = stream.pipe(gun);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const t = line.trim();
        if (!t) return;
        let id = null;
        try {
          id = String(gameIdOf(JSON.parse(t)));
        } catch (_) {}
        if (id && map.has(id)) {
          const repl = map.get(id);
          map.delete(id);
          gzf.write(repl + "\n");
          written++;
        } else {
          gzf.write(t + "\n");
          written++;
        }
      });
      rl.on("close", () => {
        for (const line of map.values()) {
          gzf.write(line + "\n");
          written++;
        }
        gzf.end();
        gzf.on("finish", resolve);
      });
      rl.on("error", reject);
      out.on("error", reject);
    });
  } else {
    /* Premier compactage du jour.
       Astuce : un fichier .gz valide accepte plusieurs "membres" gzip
       concatenes -> on copie les octets de l'ancien gz TEL QUEL puis on
       append un nouveau membre gzip contenant les lignes du jour. */
    await new Promise((resolve, reject) => {
      if (!fs.existsSync(gz)) {
        resolve();
        return;
      }
      const src = fs.createReadStream(gz);
      const dst = fs.createWriteStream(tmpGz);
      src.on("error", reject);
      dst.on("error", reject);
      dst.on("close", resolve);
      src.pipe(dst);
    });
    await new Promise((resolve, reject) => {
      const dst = fs.createWriteStream(tmpGz, { flags: "a" });
      const gzf = zlib.createGzip({ level: 9 });
      gzf.pipe(dst);
      for (const line of map.values()) gzf.write(line + "\n");
      gzf.end();
      gzf.on("finish", resolve);
      gzf.on("error", reject);
      dst.on("error", reject);
    });
    written = map.size;
  }

  fs.renameSync(tmpGz, gz);

  /* 3) Manifest + suppression du raw. */
  if (!previouslyCompacted) {
    manifest.days[day] = { count: map.size };
    manifest.total = (manifest.total || 0) + map.size;
  }
  manifest.updatedAt = new Date().toISOString();
  writeJsonAtomic(manifestFile, manifest);
  fs.unlinkSync(raw);

  return { ok: true, mode: previouslyCompacted ? "rewritten" : "appended", count: map.size };
}

/**
 * Compacte le raw TURNS d'un jour/type -> gz journalier (dedef + gzip -9).
 * Retourne { ok, count }.
 */
async function compactTurnsDay(type, day) {
  const raw = turnsRawPath(type, day);
  if (!fs.existsSync(raw)) return { ok: false, count: 0 };

  const map = new Map();
  await iterJsonl(raw, (t) => {
    try {
      const id = gameIdOf(JSON.parse(t));
      if (id) map.set(String(id), t);
    } catch (_) {}
  });

  const gz = turnsGzPath(type, day);
  ensureDir(path.dirname(gz));
  const tmpGz = `${gz}.tmp-${process.pid}`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpGz);
    const gzf = zlib.createGzip({ level: 9 });
    gzf.pipe(out);
    for (const line of map.values()) gzf.write(line + "\n");
    gzf.end();
    gzf.on("finish", resolve);
    out.on("error", reject);
  });
  fs.renameSync(tmpGz, gz);

  const md5 = await fileMd5(gz);
  writeJsonAtomic(turnsManifestPath(type, day), {
    type,
    day,
    count: map.size,
    bytes: fs.statSync(gz).size,
    md5,
    compactedAt: new Date().toISOString(),
  });
  fs.unlinkSync(raw);

  return { ok: true, count: map.size };
}

module.exports = {
  DATA_DIR,
  indexRawPath,
  indexGzPath,
  indexManifestPath,
  turnsRawPath,
  turnsGzPath,
  turnsManifestPath,
  sanitize,
  gameIdOf,
  dayOfRecord,
  iterJsonl,
  DayStore,
  fileMd5,
  compactIndexDay,
  compactTurnsDay,
};
