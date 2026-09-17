// sync-lobby-state.js
//
// Maintient l'état du lobby OpenFront de façon persistante dans
// `lobby_state.json`. Conçu pour tourner toutes les 5 min en GitHub Action.
//
// Sources de données :
//   1. WebSocket  : hôte résolu dynamiquement (Server list v2 puis legacy)
//      → snapshot temps réel du lobby (games en attente + numClients).
//   2. API HTTP   : https://api.openfront.io/public/games → games terminées
//      (stats ranked 1v1/2v2 dernière heure, recentHistory, heatmap 24h).
//
// Résolution WS « Server list v2 » (déploiement v34 imminent) :
//   GET https://api.openfront.io/cluster.json?site=openfront.io
//   → 200 { latest, servers: { lettre: { host, numWorkers, version, state } } }
//     → wss://<host>/w0/lobbies
//   → 404 "Unknown site" (endpoint dormant, avant le switch)
//     → fallback legacy wss://openfront.io/w0/lobbies
// Le site fonctionne donc AVANT et APRÈS la bascule sans redéploiement.
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
import crypto from "crypto";
import tls from "tls";
import { spawn } from "child_process";
import fetch from "node-fetch";
import WebSocket from "ws";

// Import lobby-wire.js (CommonJS) pour décoder le zbin binaire d'OpenFront
const require = createRequire(import.meta.url);
const { decodeLobbyMessage } = require("./lobby-wire.js");

// ── Paths & constants ──────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, "lobby_state.json");

const LEGACY_WS_URL = "wss://openfront.io/w0/lobbies";
// ⚠️ 17/09/2026 : fin du HÔTE FORCÉ — OpenFront a basculé blue/green (green
// forcé → state=draining → feed full vide) et l'infra passe aux hôtes
// machine-scoped annoncés par la registry (#5474,#5478,#5479,#5486).
// Nouvelle stratégie robuste aux rollovers (voir resolveLobbyCandidates) :
//   1. registry cluster.json v2 → serveurs state=open (puis draining),
//   2. candidats statiques blue/green (slots de couleur stables),
//   3. proxy Cloudflare Worker (tourne DANS Cloudflare → pas de blocage bot),
//   4. legacy openfront.io — puis sondage : premier full avec ≥ 1 partie gagne.
const STATIC_COLOR_HOSTS = ["blue.openfront.io", "green.openfront.io"];
const PROXY_WS_URL = "wss://openfront-proxy.diofortnite3.workers.dev/lobby-ws";
const USE_CLUSTER_JSON = true;
const CLUSTER_JSON_URL = "https://api.openfront.io/cluster.json?site=openfront.io";
const API_BASE = "https://api.openfront.io";
const SKAILEX_TOKEN =
  process.env.OPENFRONT_SKAILEX_ACCESS || "";

const SCRIPT_TIMEOUT_MS = 60_000; // large marge (job GitHub timeout-minutes: 5)
const WS_TIMEOUT_MS = 4_000;      // transport ws-lib par candidat
const OPENSSL_TIMEOUT_MS = 7_000; // transports tls/openssl par candidat
const MAX_CANDIDATES = 4;
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

// ── Résolution des URLs WebSocket candidates (Server list v2) ───────────
// 1. cluster.json (format v2 : { latest, servers: { lettre: { host,
//    numWorkers, version, state } } }) → open d'abord, draining ensuite
//    (un draining sert encore son feed, un fenced plus du tout).
// 2. Slots de couleur statiques blue/green (stables par convention amont).
// 3. Proxy Cloudflare Worker (résout lui-même la registry depuis l'edge).
// 4. Legacy openfront.io. La liste est dédupliquée, plafonnée, et le
//    premier candidat dont le feed full contient au moins une partie gagne
//    (fetchLobbySnapshotBest) — résilient aux rollovers non annoncés.
async function resolveLobbyCandidates() {
  const urls = [];
  const push = (u) => { if (u && !urls.includes(u)) urls.push(u); };

  if (USE_CLUSTER_JSON) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      // Headers navigateur : Cloudflare devant api.openfront.io rejette les
      // requêtes sans allure navigateur (403 challenge) depuis les runners.
      const res = await fetch(CLUSTER_JSON_URL, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Origin: "https://openfront.io",
          "x-skailex-access":
            process.env.OPENFRONT_SKAILEX_ACCESS || SKAILEX_TOKEN,
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        const entries = data && data.servers
          ? Object.values(data.servers)
              .filter((s) => s && s.host && s.state !== "fenced")
              .map((s) => ({
                host: s.host,
                numWorkers: Number(s.numWorkers) || 1,
                state: s.state || "open",
              }))
          : [];
        entries.sort((a, b) =>
          (a.state === "open" ? 0 : 1) - (b.state === "open" ? 0 : 1));
        for (const e of entries) {
          const w = Math.floor(Math.random() * Math.max(1, e.numWorkers));
          push(`wss://${e.host}/w${w}/lobbies`);
        }
        log(`cluster.json v2 : ${entries.map((e) => `${e.host}(${e.state})`).join(", ")}`);
      } else {
        warn(`cluster.json: HTTP ${res.status} → candidats statiques`);
      }
    } catch (e) {
      warn(`cluster.json indisponible (${e.message}) → candidats statiques`);
    }
  }

  // Le worker proxy tourne DANS l'edge Cloudflare : jamais challenge bot.
  // Placé tôt : son échec (502 si pas redéployé) coûte ~1 s seulement.
  push(PROXY_WS_URL);

  for (const host of STATIC_COLOR_HOSTS) push(`wss://${host}/w0/lobbies`);
  push(LEGACY_WS_URL);

  const list = urls.slice(0, MAX_CANDIDATES);
  log(`candidats lobby (${list.length}) : ${list.join(" , ")}`);
  return list.length ? list : [STATIC_COLOR_HOSTS[0] ? `wss://${STATIC_COLOR_HOSTS[0]}/w0/lobbies` : LEGACY_WS_URL];
}

function loadPreviousState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}

// ── 1) Snapshot du lobby via WebSocket ─────────────────────────────────
// Renvoie { lobbyPlayers, lobbyGames, serverTime, games, gotFull }.
// games = { ffa: [...], team: [...], special: [...] } détaillé (pour polling HTTP)
// En cas d'échec/timeout, renvoie des zéros (on garde quand même le reste).
function fetchLobbySnapshot(wsUrl, timeoutMs = WS_TIMEOUT_MS, origin = "https://openfront.io") {
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
      warn(`WS pas de snapshot (${wsUrl}) — ${reason}`);
      finish({ lobbyPlayers: 0, lobbyGames: 0, serverTime: Date.now(), games: { ffa: [], team: [], special: [] }, gotFull: false });
    };

    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          // Cloudflare devant openfront.io rejette les upgrades WS sans
          // allure navigateur (403 "Unexpected server response" depuis les
          // runners GitHub Actions — IP datacenter + TLS non-navigateur).
          // Ces headers ne suffisent pas toujours — d'où le transport
          // openssl s_client (opensslLobbySnapshot) essayé en premier.
          Origin: origin,
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
      () => fallback(`timeout ${timeoutMs}ms`),
      timeoutMs
    );

    ws.on("open", () =>
      log(`WS connecté à ${wsUrl}`)
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
          gotFull: true,
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

/**
 * Transport alternatif via `openssl s_client` : l'empreinte TLS d'OpenSSL
 * passe le bot-management Cloudflare qui rejette la stack TLS de Node
 * (403 sur les runners GitHub comme sur toute IP datacenter). Fait
 * l'upgrade WS en HTTP/1.1 manuellement, lit les frames binaires et
 * décode le premier snapshot "full" zbin. Retourne null si échec.
 */
/**
 * Transport Node pur avec empreinte TLS « navigateur/curl » :
 * Cloudflare bot-management rejette la JA3 par défaut de Node (403 sur les
 * handshakes WS), mais accepte une empreinte suites/curves/signatures façon
 * curl-OpenSSL (prouvé le 17/09 : 101 + frames là où le Node nu prenait 403).
 * Upgrade HTTP/1.1 manuel, lecture des frames binaires WS, décodage zbin du
 * premier snapshot 'full'. Retourne null si échec.
 */
function tlsLobbySnapshot(wsUrl, timeoutMs = 7000, origin = 'https://openfront.io') {
  return new Promise((resolve) => {
    const m = /^wss:\/\/([^\/#?]+)(\/[^#?]*)/.exec(wsUrl);
    if (!m) return resolve(null);
    const host = m[1];
    const reqPath = m[2] || '/w0/lobbies';
    const key = crypto.randomBytes(16).toString('base64');

    let sock;
    try {
      sock = tls.connect({
        host,
        port: 443,
        servername: host,
        ALPNProtocols: ['http/1.1'],
        ciphers: [
          'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256',
          'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
          'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
          'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
          'ECDHE-ECDSA-AES256-SHA', 'ECDHE-RSA-AES256-SHA',
          'ECDHE-ECDSA-AES128-SHA', 'ECDHE-RSA-AES128-SHA',
        ].join(':'),
        ecdhCurve: 'X25519:prime256v1:secp384r1',
        sigalgs:
          'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:rsa_pkcs1_sha384:rsa_pkcs1_sha512',
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: true,
      });
    } catch (e) {
      return resolve(null);
    }

    let done = false;
    let opened = false;
    let buf = Buffer.alloc(0);

    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (_) {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    sock.on('error', () => finish(null));

    sock.on('secureConnect', () => {
      sock.write(
        `GET ${reqPath} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n` +
        `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n` +
        `Accept-Language: fr-FR,fr;q=0.9,en;q=0.8\r\n\r\n`
      );
    });

    sock.on('data', (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      if (!opened) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString();
        opened = true;
        buf = buf.subarray(idx + 4);
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          log(`tls: pas d'upgrade (${head.split('\r\n')[0]}) sur ${wsUrl}`);
          return finish(null);
        }
        log(`tls: upgrade OK → ${wsUrl}`);
      }
      for (;;) {
        if (buf.length < 2) break;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          const big = buf.readBigUInt64BE(2);
          if (big > 67108864n) { finish(null); return; }
          len = Number(big);
          off = 10;
        }
        if (buf.length < off + len) break;
        const payload = Buffer.from(buf.subarray(off, off + len));
        buf = buf.subarray(off + len);
        if (opcode === 0x2) {
          try {
            const msg = decodeLobbyMessage(new Uint8Array(payload));
            if (msg && msg.games && typeof msg.games === 'object') {
              const all = [
                ...(Array.isArray(msg.games.ffa) ? msg.games.ffa : []),
                ...(Array.isArray(msg.games.team) ? msg.games.team : []),
                ...(Array.isArray(msg.games.special) ? msg.games.special : []),
              ];
              const players = all.reduce((s, g) => s + (Number(g && g.numClients) || 0), 0);
              const serverTime = typeof msg.serverTime === 'number' ? msg.serverTime : Date.now();
              log(`tls full snapshot: ${all.length} games, ${players} joueurs (${wsUrl})`);
              return finish({
                lobbyPlayers: players,
                lobbyGames: all.length,
                serverTime,
                gotFull: true,
                games: {
                  ffa: Array.isArray(msg.games.ffa) ? msg.games.ffa : [],
                  team: Array.isArray(msg.games.team) ? msg.games.team : [],
                  special: Array.isArray(msg.games.special) ? msg.games.special : [],
                },
              });
            }
          } catch (_) { /* frame non décodable : on attend la suivante */ }
        } else if (opcode === 0x8) {
          return finish(null);
        }
      }
    });
  });
}

function opensslLobbySnapshot(wsUrl, timeoutMs = 6000, origin = "https://openfront.io") {
  return new Promise((resolve) => {
    const m = /^wss:\/\/([^/#?]+)(\/[^#?]*)/.exec(wsUrl);
    if (!m) return resolve(null);
    const host = m[1];
    const reqPath = m[2] || "/w0/lobbies";

    let ssl;
    try {
      // stdbuf -o0 : force la sortie NON bufferisée d'openssl — indispensable
      // sur les runners Ubuntu où s_client bloque ses frames dans le buffer
      // du pipe (4-8 Ko) et les n'envoie qu'à la fermeture du process.
      ssl = spawn(
        "stdbuf",
        ["-o0", "openssl", "s_client", "-connect", `${host}:443`, "-servername", host, "-alpn", "http/1.1", "-quiet", "-ign_eof"],
        { stdio: ["pipe", "pipe", "ignore"] }
      );
    } catch (e) {
      try {
        ssl = spawn(
          "openssl",
          ["s_client", "-connect", `${host}:443`, "-servername", host, "-alpn", "http/1.1", "-quiet", "-ign_eof"],
          { stdio: ["pipe", "pipe", "ignore"] }
        );
      } catch (e2) {
        return resolve(null);
      }
    }
    // binaire openssl indisponible → l'event 'error' intervient ; on résout null

    let done = false;
    let opened = false;
    let buf = Buffer.alloc(0);
    const key = crypto.randomBytes(16).toString("base64");

    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ssl.kill(); } catch (_) {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    ssl.on("error", () => finish(null));

    /* Requête d'upgrade WS — envoyée immédiatement après le spawn. */
    ssl.stdin.write(
      `GET ${reqPath} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n` +
      `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n` +
      `Accept-Language: fr-FR,fr;q=0.9,en;q=0.8\r\n\r\n`
    );

    ssl.stdout.on("data", (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      if (!opened) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString();
        opened = true;
        buf = buf.subarray(idx + 4);
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          log(`openssl: pas d'upgrade (${head.split("\r\n")[0]}) sur ${wsUrl}`);
          return finish(null);
        }
        log(`openssl: upgrade OK → ${wsUrl}`);
      }
      // Parsing des frames WS serveur (non masquées)
      for (;;) {
        if (buf.length < 2) break;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          const big = buf.readBigUInt64BE(2);
          if (big > 67108864n) { finish(null); return; }
          len = Number(big);
          off = 10;
        }
        if (buf.length < off + len) break;
        const payload = Buffer.from(buf.subarray(off, off + len));
        buf = buf.subarray(off + len);
        if (opcode === 0x2) {
          try {
            const msg = decodeLobbyMessage(new Uint8Array(payload));
            if (msg && msg.games && typeof msg.games === "object") {
              const all = [
                ...(Array.isArray(msg.games.ffa) ? msg.games.ffa : []),
                ...(Array.isArray(msg.games.team) ? msg.games.team : []),
                ...(Array.isArray(msg.games.special) ? msg.games.special : []),
              ];
              const serverTime = typeof msg.serverTime === "number" ? msg.serverTime : Date.now();
              log(
                `openssl full snapshot: ${all.length} games, ${all.reduce((s, g) => s + (Number(g && g.numClients) || 0), 0)} joueurs (${wsUrl})`
              );
              return finish({
                lobbyPlayers: all.reduce((s, g) => s + (Number(g && g.numClients) || 0), 0),
                lobbyGames: all.length,
                serverTime,
                gotFull: true,
                games: {
                  ffa: Array.isArray(msg.games.ffa) ? msg.games.ffa : [],
                  team: Array.isArray(msg.games.team) ? msg.games.team : [],
                  special: Array.isArray(msg.games.special) ? msg.games.special : [],
                },
              });
            }
          } catch (_) { /* frame non décodable : on attend la suivante */ }
        } else if (opcode === 0x8) {
          return finish(null);
        }
      }
    });
  });
}

/**
 * Sondage des candidats : le PREMIER dont le feed full contient au moins
 * une partie gagne. Par candidat : transport Node-JA3 d'abord (passe le
 * bot-management Cloudflare), openssl ensuite, lib `ws` enfin. Un feed
 * décodé mais VIDE (serveur draining après un rollover blue/green) fait
 * passer au candidat suivant. Sans candidat utile, on rend le dernier
 * résultat (zéros) — le front bascule alors sur les stats HTTP
 * (ranked/heatmap) qui restent valides. Budget global borné.
 */
async function fetchLobbySnapshotBest(candidates) {
  const empty = () => ({
    lobbyPlayers: 0,
    lobbyGames: 0,
    serverTime: Date.now(),
    games: { ffa: [], team: [], special: [] },
    gotFull: false,
  });
  const deadline = Date.now() + 45_000; // marge large (job = 5 min)
  let last = empty();

  for (const url of (candidates || []).slice(0, MAX_CANDIDATES)) {
    const remaining = deadline - Date.now();
    if (remaining < 4_000) {
      warn(`budget épuisé avant ${url} — arrêt du sondage`);
      break;
    }
    const t = Math.min(OPENSSL_TIMEOUT_MS, remaining);
    const oOrigin = url.includes("workers.dev")
      ? "https://thefronthub.com" // allowlist du worker proxy
      : "https://openfront.io";

    // 1) Transport Node pur (empreinte TLS façon curl — passe CF)
    const viaTls = await tlsLobbySnapshot(url, t, oOrigin);
    if (viaTls && viaTls.gotFull && viaTls.lobbyGames > 0) return viaTls;
    if (viaTls && viaTls.gotFull) {
      warn(`feed décodé mais vide sur ${url} → candidat suivant`);
      last = viaTls;
      continue;
    }
    if (viaTls) {
      // 101 sans frames = IP flaggée par CF (données retenues) : inutile
      // d'essayer les autres transports sur ce candidat.
      warn(`upgrade sans données sur ${url} (IP flaggée CF ?) → candidat suivant`);
      continue;
    }

    // 2) Transport openssl (empreinte TLS OpenSSL — passe CF)
    const viaOpenssl = await opensslLobbySnapshot(url, t, oOrigin);
    if (viaOpenssl && viaOpenssl.gotFull && viaOpenssl.lobbyGames > 0) return viaOpenssl;
    if (viaOpenssl && viaOpenssl.gotFull) {
      warn(`feed décodé mais vide sur ${url} → candidat suivant`);
      last = viaOpenssl;
      continue;
    }

    // 3) Secours : lib `ws` (peut marcher selon la réputation de l'IP)
    const viaWs = await fetchLobbySnapshot(url, Math.min(5_000, deadline - Date.now()), oOrigin);
    last = viaWs;
    if (viaWs.gotFull && viaWs.lobbyGames > 0) return viaWs;
    if (viaWs.gotFull) warn(`feed décodé mais vide sur ${url} → candidat suivant`);
  }
  return last;
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

  // WS (le plus lent, ~6 s max par candidat, 3 candidats) + HTTP en parallèle.
  // La résolution registry (4 s max) précède le sondage des candidats.
  const [lobby, ranked, recent] = await Promise.all([
    resolveLobbyCandidates().then(fetchLobbySnapshotBest),
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
