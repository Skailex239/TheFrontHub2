// sync-lobby-state.js
//
// Maintient l'état du lobby OpenFront de façon persistante dans
// `lobby_state.json`. Conçu pour tourner toutes les 5 min en GitHub Action.
//
// Sources de données :
//   1. WebSocket  : wss://openfront.io/w0/lobbies  → snapshot temps réel
//      du lobby (games en attente + numClients).
//   2. API HTTP   : https://api.openfront.io/public/games → games terminées
//      (stats ranked 1v1/2v2 dernière heure, recentHistory, heatmap 24h).
//
// Sortie : `lobby_state.json` (pretty-printé, 2 espaces) à la racine du repo.
//
// Notes V1 :
//   - `activePlayers` / `activeGames` = 0 (impossible à tracker sans WS
//     persistant). Le front affichera "en lobby" au lieu de "en cours".
//   - `topMapsToday` = [] (l'API /public/games ne retourne pas le nom de
//     la map). Améliorable plus tard via /public/game/<id>?turns=false.
//   - `heatmap24h` : accumulé d'un run à l'autre via un cache privé `_gameEnds`
//     ({ gameId: endMs }). L'API /public/games est capée à 1000 résultats
//     (~3h aux heures de pointe), donc un recompute from scratch donnerait un
//     heatmap tronqué. En accumulant+dédupliquant les gameIds et en prunant
//     ceux de +24h, on reconstruit un vrai 24h (chaque game est capturée quand
//     elle est "récente", i.e. dans le top 1000 après sa fin).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fetch from "node-fetch";
import WebSocket from "ws";

// Import lobby-wire.js (CommonJS) pour décoder le zbin binaire d'OpenFront
const require = createRequire(import.meta.url);
const { decodeLobbyMessage } = require("./lobby-wire.js");

// ── Paths & constants ──────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, "lobby_state.json");

const WS_URL = "wss://openfront.io/w0/lobbies";
const API_BASE = "https://api.openfront.io";
const SKAILEX_TOKEN =
  process.env.OPENFRONT_SKAILEX_ACCESS || "";

const SCRIPT_TIMEOUT_MS = 28_000; // garde < 30s (limite GitHub Action)
const WS_TIMEOUT_MS = 8_000;
const RECENT_HISTORY_LIMIT = 25;

// ── Hard timeout guard (ne bloque jamais l'Action) ────────────────────
const hardKill = setTimeout(() => {
  console.error("[lobby-sync] ⛔ Timeout global (28s) — exit forcé");
  process.exit(2);
}, SCRIPT_TIMEOUT_MS);
hardKill.unref();

// ── .env loader (optionnel, override du token possible en local) ───────
try {
  const envContent = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  envContent.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim();
    if (key && value) process.env[key.trim()] = value;
  });
} catch (e) {
  // .env optionnel
}

// ── Helpers ────────────────────────────────────────────────────────────
const iso = (d) => d.toISOString();
const log = (msg) => console.log(`[lobby-sync] ${msg}`);
const warn = (msg) => console.warn(`[lobby-sync] ⚠️ ${msg}`);

function apiHeaders() {
  return {
    "x-skailex-access":
      process.env.OPENFRONT_SKAILEX_ACCESS || SKAILEX_TOKEN,
    "User-Agent": "skailex",
    Accept: "application/json",
  };
}

function loadPreviousState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}

// ── 1) Snapshot du lobby via WebSocket ─────────────────────────────────
// Renvoie { lobbyPlayers, lobbyGames, serverTime, games }.
// games = { ffa: [...], team: [...], special: [...] } détaillé (pour polling HTTP)
// En cas d'échec/timeout, renvoie des zéros (on garde quand même le reste).
function fetchLobbySnapshot() {
  return new Promise((resolve) => {
    let done = false;
    let ws = null;

    const finish = (data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws && ws.close();
      } catch (e) {
        /* ignore */
      }
      resolve(data);
    };

    const fallback = (reason) => {
      warn(`WS pas de snapshot — ${reason}`);
      finish({ lobbyPlayers: 0, lobbyGames: 0, serverTime: Date.now(), games: { ffa: [], team: [], special: [] } });
    };

    try {
      ws = new WebSocket(WS_URL, {
        headers: {
          // Cloudflare devant openfront.io rejette les upgrades WS sans
          // allure navigateur (403 "Unexpected server response" depuis les
          // runners GitHub Actions — IP datacenter + TLS non-navigateur).
          // Ces headers ne suffisent pas toujours, mais ils maximisent les
          // chances et ne coûtent rien. Le fallback garde le site fonctionnel
          // (games vides, ranked/heatmap OK via l'API HTTP).
          Origin: "https://openfront.io",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        },
      });
    } catch (e) {
      return fallback(`init error: ${e.message}`);
    }

    const timer = setTimeout(
      () => fallback(`timeout ${WS_TIMEOUT_MS}ms`),
      WS_TIMEOUT_MS
    );

    ws.on("open", () =>
      log("WS connecté à wss://openfront.io/w0/lobbies")
    );

    ws.on("message", (raw) => {
      let msg;
      // Détection du format : ArrayBuffer/Buffer = binaire (zbin), string = JSON
      const isBinary = raw instanceof Buffer || raw instanceof ArrayBuffer ||
        (typeof Buffer !== "undefined" && Buffer.isBuffer(raw));

      if (isBinary) {
        // Format binaire zbin (OpenFront moderne) → utiliser lobby-wire.js
        try {
          const bytes = new Uint8Array(raw);
          msg = decodeLobbyMessage(bytes);
        } catch (e) {
          warn(`zbin decode error: ${e.message}`);
          return;
        }
      } else {
        // Format JSON texte (legacy)
        try {
          msg = JSON.parse(raw.toString());
        } catch (e) {
          return; // message non-JSON non-binaire, on ignore
        }
      }

      if (!msg || typeof msg !== "object") return;

      // Premier snapshot complet (peut arriver avec ou sans `type: "full"`).
      if (msg.games && typeof msg.games === "object") {
        const games = msg.games;
        const all = [
          ...(Array.isArray(games.ffa) ? games.ffa : []),
          ...(Array.isArray(games.team) ? games.team : []),
          ...(Array.isArray(games.special) ? games.special : []),
        ];
        const serverTime =
          typeof msg.serverTime === "number" ? msg.serverTime : Date.now();
        const lobbyGames = all.length;
        const lobbyPlayers = all.reduce(
          (sum, g) => sum + (Number(g && g.numClients) || 0),
          0
        );
        log(
          `WS full snapshot: ${lobbyGames} games en lobby, ${lobbyPlayers} joueurs` +
            ` (serverTime=${serverTime}, format=${isBinary ? "zbin" : "JSON"})`
        );
        finish({
          lobbyPlayers,
          lobbyGames,
          serverTime,
          games: {
            ffa: Array.isArray(games.ffa) ? games.ffa : [],
            team: Array.isArray(games.team) ? games.team : [],
            special: Array.isArray(games.special) ? games.special : [],
          },
        });
      }
      // Les messages `type: "counts"` sont ignorés (on déconnecte après le full).
    });

    ws.on("error", (err) => fallback(`erreur: ${err.message}`));

    ws.on("close", () => {
      if (!done) fallback("socket fermé avant snapshot");
    });
  });
}

// ── 2) Stats ranked (1v1 / 2v2) sur la dernière heure ─────────────────
async function fetchRankedStats() {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  async function fetchMode(rankedType) {
    const url =
      `${API_BASE}/public/games?start=${iso(oneHourAgo)}&end=${iso(now)}` +
      `&rankedType=${rankedType}&limit=1000`;
    try {
      const res = await fetch(url, { headers: apiHeaders() });
      if (!res.ok) {
        warn(`ranked ${rankedType}: HTTP ${res.status}`);
        return zero(rankedType);
      }
      const games = await res.json();
      if (!Array.isArray(games)) {
        warn(`ranked ${rankedType}: réponse non-array`);
        return zero(rankedType);
      }

      const gamesLastHour = games.length;

      // avgWaitTime : moyenne des lobbyFillTime (ms → s).
      // Défensif : si la moyenne dépasse 120, on suppose des ms et on
      // divise par 1000 ; sinon on garde tel quel (déjà en secondes).
      const waits = games
        .map((g) => Number(g && g.lobbyFillTime))
        .filter((v) => Number.isFinite(v) && v >= 0);
      let avgWaitTime = 0;
      if (waits.length > 0) {
        let avg = waits.reduce((a, b) => a + b, 0) / waits.length;
        if (avg > 120) avg = avg / 1000; // ms → s
        avgWaitTime = Math.round(avg * 10) / 10;
      }

      const playersPerGame = rankedType === "2v2" ? 4 : 2;
      const playersLastHour = gamesLastHour * playersPerGame;

      log(
        `ranked ${rankedType}: ${gamesLastHour} games, avgWait=${avgWaitTime}s` +
          ` (raw avg=${waits.length ? (waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(0) : "n/a"}),` +
          ` players=${playersLastHour}`
      );
      return { gamesLastHour, avgWaitTime, playersLastHour };
    } catch (e) {
      warn(`ranked ${rankedType} erreur: ${e.message}`);
      return zero(rankedType);
    }
  }

  const zero = (rt) => ({
    gamesLastHour: 0,
    avgWaitTime: 0,
    playersLastHour: 0,
  });

  const [s1v1, s2v2] = await Promise.all([
    fetchMode("1v1"),
    fetchMode("2v2"),
  ]);
  return { "1v1": s1v1, "2v2": s2v2 };
}

// ── 3) Recent games + heatmap 24h (HTTP) ──────────────────────────────
//
// Heatmap 24h : l'API /public/games est limitée à 1000 résultats, ce qui
// ne couvre que ~3h aux heures de pointe. Pour reconstruire un heatmap
// complet sur 24h, on accumule les gameIds vus ({ id: endMs }) d'un run à
// l'autre, on prune ceux de plus de 24h, puis on rebucketise. Chaque game
// est "récente" (top 1000) dans les ~3h qui suivent sa fin, donc un run
// toutes les 5 min la capture forcément au moins une fois.
async function fetchRecentGames(previousGameEnds) {
  const now = new Date();
  const nowMs = now.getTime();
  const twentyFourHoursAgo = new Date(nowMs - 24 * 60 * 60 * 1000);

  // Un seul fetch 24h (limit 1000) sert à la fois pour l'accumulation du
  // heatmap ET pour recentHistory (top 25 par end desc).
  const url =
    `${API_BASE}/public/games?start=${iso(twentyFourHoursAgo)}&end=${iso(now)}` +
    `&type=Public&limit=1000`;

  let games24h = [];
  try {
    const res = await fetch(url, { headers: apiHeaders() });
    if (!res.ok) {
      warn(`/public/games (24h): HTTP ${res.status}`);
    } else {
      const data = await res.json();
      if (Array.isArray(data)) games24h = data;
      else warn(`/public/games (24h): réponse non-array`);
    }
  } catch (e) {
    warn(`/public/games (24h) erreur: ${e.message}`);
  }

  log(`/public/games (24h): ${games24h.length} games récupérées`);

  // ── Accumulation + dedup des gameIds vus (pour le heatmap 24h) ──
  // On part du cache précédent, on y merge les games fraîchement fetchées,
  // puis on prune celles de plus de 24h.
  const gameEnds = previousGameEnds && typeof previousGameEnds === "object"
    ? { ...previousGameEnds }
    : {};

  let added = 0;
  for (const g of games24h) {
    if (!g) continue;
    const id = g.game || g.id || g.gameID;
    if (!id) continue;
    const endMs =
      typeof g.end === "number" ? g.end : Date.parse(g.end);
    if (!Number.isFinite(endMs)) continue;
    if (!Object.prototype.hasOwnProperty.call(gameEnds, id)) added++;
    gameEnds[id] = endMs;
  }

  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const id of Object.keys(gameEnds)) {
    if (gameEnds[id] < cutoff) {
      delete gameEnds[id];
      pruned++;
    }
  }

  // ── heatmap24h : bucket par heure UTC, reconstruit from gameEnds ──
  const heatmap24h = new Array(24).fill(0);
  for (const id of Object.keys(gameEnds)) {
    const hour = new Date(gameEnds[id]).getUTCHours();
    if (hour >= 0 && hour < 24) heatmap24h[hour]++;
  }

  // ── recentHistory : top 25 par end desc (depuis le fetch frais) ──
  const sorted = games24h.slice().sort((a, b) => {
    const ta = a && a.end != null ? (typeof a.end === "number" ? a.end : Date.parse(a.end)) : 0;
    const tb = b && b.end != null ? (typeof b.end === "number" ? b.end : Date.parse(b.end)) : 0;
    return (tb || 0) - (ta || 0);
  });

  const recentHistory = sorted
    .slice(0, RECENT_HISTORY_LIMIT)
    .map((g) => {
      const cfg = (g && g.gameConfig) || {};
      const toIso = (v) => {
        if (v == null) return null;
        if (typeof v === "number") return new Date(v).toISOString();
        const parsed = Date.parse(v);
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : v;
      };
      return {
        id: g.game || g.id || g.gameID || "",
        // L'API /public/games ne retourne pas gameMap → "?" en V1.
        map: cfg.gameMap || "?",
        mode: g.rankedType || g.mode || "?",
        players: Number(g.numPlayers) || 0,
        maxPlayers: Number(g.maxPlayers) || 0,
        startedAt: toIso(g.start),
        endedAt: toIso(g.end),
        difficulty: g.difficulty || cfg.difficulty || "?",
      };
    });

  log(
    `recentHistory: ${recentHistory.length} entrées | ` +
      `heatmap24h: ${Object.keys(gameEnds).length} games accumulées ` +
      `(+${added} nouveaux, -${pruned} prunées), ` +
      `total=${heatmap24h.reduce((a, b) => a + b, 0)} parties dans les 24h`
  );

  return { recentHistory, heatmap24h, gameEnds };
}

// ── 4) Main ───────────────────────────────────────────────────────────
async function main() {
  const startMs = Date.now();
  log("🚀 Démarrage sync-lobby-state");

  const previous = loadPreviousState();
  // Cache privé des gameIds déjà vus (pour l'accumulation du heatmap 24h).
  // Clé préfixée par `_` → champ privé, non lu par le front.
  const previousGameEnds =
    previous && previous._gameEnds && typeof previous._gameEnds === "object"
      ? previous._gameEnds
      : null;
  if (previous) {
    log(
      `État précédent chargé (lastUpdate=${previous.lastUpdate || "?"}, ` +
        `lobbyGames=${previous.stats?.lobbyGames ?? "?"}, ` +
        `_gameEnds=${previousGameEnds ? Object.keys(previousGameEnds).length : 0} ids)`
    );
  } else {
    log("Aucun état précédent — départ de zéro");
  }

  // WS (le plus lent, ~8s max) + HTTP fetches en parallèle.
  const [lobby, ranked, recent] = await Promise.all([
    fetchLobbySnapshot(),
    fetchRankedStats(),
    fetchRecentGames(previousGameEnds),
  ]);

  const now = new Date();
  const state = {
    lastUpdate: now.toISOString(),
    serverTime: lobby.serverTime,
    stats: {
      lobbyPlayers: lobby.lobbyPlayers,
      lobbyGames: lobby.lobbyGames,
      // V1 : non tracker (sans WS persistant). Front label = "en lobby".
      activePlayers: 0,
      activeGames: 0,
    },
    // 🎯 V2 : on stocke aussi les games détaillées (pour HTTP polling côté lobby.js)
    // Format identique au WS OpenFront : { ffa: [...], team: [...], special: [...] }
    // Chaque game contient : gameID, numClients, startsAt, publicGameType, gameConfig
    games: lobby.games || { ffa: [], team: [], special: [] },
    ranked,
    recentHistory: recent.recentHistory,
    topMapsToday: [], // V1 : API /public/games ne retourne pas gameMap.
    heatmap24h: recent.heatmap24h,
    // Champ privé : cache des gameIds vus pour l'accumulation du heatmap.
    // Permet de reconstruire un vrai 24h malgré la limite de 1000 games/appel.
    _gameEnds: recent.gameEnds,
  };

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  const elapsed = Date.now() - startMs;
  const sizeKb = (JSON.stringify(state).length / 1024).toFixed(1);
  log(
    `💾 ${path.basename(STATE_FILE)} écrit (${sizeKb} KB) en ${elapsed}ms`
  );
  log(
    `✅ Terminé — ` +
      `lobby=${state.stats.lobbyGames}g/${state.stats.lobbyPlayers}p, ` +
      `1v1=${state.ranked["1v1"].gamesLastHour}g, ` +
      `2v2=${state.ranked["2v2"].gamesLastHour}g, ` +
      `recent=${state.recentHistory.length}, ` +
      `heatmap24h total=${state.heatmap24h.reduce((a, b) => a + b, 0)}`
  );

  clearTimeout(hardKill);
}

main().catch((e) => {
  console.error("[lobby-sync] Fatal:", e);
  clearTimeout(hardKill);
  process.exit(1);
});
