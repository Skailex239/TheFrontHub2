"use strict";
/**
 * lib-api.js — Client minimaliste de l'API publique OpenFront (v34).
 *
 * Endpoints utilises (mesures Task 6-11) :
 *   GET /public/games?start=&end=&limit=&offset=
 *        - fenetre start/end MAX 48 h PILE (on enforce 47h59 via config)
 *        - limit cap strict a 1000
 *        - total disponible via l'en-tete Content-Range ("a-b/total")
 *   GET /public/game/:gameID            -> partie COMPLETE (turns inclus par defaut)
 *   GET /public/game/:gameID?turns=false-> metadonnees seules
 *
 * Robustesse : timeout, retries avec backoff lineaire sur 429/5xx/erreurs reseau,
 * erreurs 400/404 considerees permanentes (pas de retry inutile).
 */

const {
  API_BASE,
  ACCESS_TOKEN,
  HTTP,
  INDEX,
} = require("./config.js");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseTotal(contentRange) {
  if (!contentRange) return null;
  const m = /\/(\d+)\s*$/.exec(String(contentRange));
  return m ? Number(m[1]) : null;
}

/**
 * fetch JSON avec retries. Retourne { data, total }.
 * Throw une Erreur avec .permanent = true si 400/404 (pas de retry).
 */
async function apiFetch(pathname, query = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const url = `${API_BASE}${pathname}${qs.toString() ? "?" + qs.toString() : ""}`;

  let lastErr = null;
  for (let attempt = 1; attempt <= HTTP.MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP.TIMEOUT_MS);
    try {
      const headers = {
        Accept: "application/json",
        "User-Agent": "skailex-archive/1.0 (TheFrontHub)",
      };
      if (ACCESS_TOKEN) headers["x-skailex-access"] = ACCESS_TOKEN;

      const res = await fetch(url, { headers, signal: controller.signal });

      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} sur ${url}`);
        await sleep(HTTP.RETRY_BASE_MS * attempt);
        continue;
      }
      if (!res.ok) {
        let body = "";
        try {
          body = await res.text();
        } catch (_) {}
        const err = new Error(
          `HTTP ${res.status} sur ${url} :: ${body.slice(0, 200)}`
        );
        err.permanent = res.status === 400 || res.status === 404;
        throw err;
      }

      const total = parseTotal(res.headers.get("content-range"));
      const data = await res.json();
      return { data, total };
    } catch (e) {
      if (e && e.permanent) throw e;
      lastErr = e;
      if (attempt < HTTP.MAX_RETRIES) await sleep(HTTP.RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`fetch impossible : ${url}`);
}

/**
 * Une page du listing /public/games.
 * @param {object} p { start: ISO, end: ISO, limit, offset }
 * @returns {{ games: any[], total: number|null }}
 */
async function listGamesPage({ start, end, limit = INDEX.PAGE_LIMIT, offset = 0 }) {
  const { data, total } = await apiFetch("/public/games", { start, end, limit, offset });
  const games = Array.isArray(data) ? data : data && Array.isArray(data.games) ? data.games : [];
  return { games, total };
}

/** Partie complete (avec turns). turns=false -> metadonnees seules. */
async function getGame(gameId, { turns } = {}) {
  const q = turns === false ? { turns: "false" } : {};
  const { data } = await apiFetch(`/public/game/${encodeURIComponent(gameId)}`, q);
  return data;
}

module.exports = { apiFetch, listGamesPage, getGame, sleep, parseTotal };
