/**
 * Cloudflare Worker — Proxy CORS + WebSocket proxy vers OpenFront.
 *
 * Routes :
 *   GET /<path>           → proxy HTTP vers https://api.openfront.io/<path>
 *   GET /lobby-ws         → proxy WebSocket vers wss://<hôte jeu>/w{0-19}/lobbies
 *                           (hôte résolu via Server list v2 : cluster.json)
 *   GET /matchmaking-ws   → proxy WebSocket vers wss://api.openfront.io/matchmaking/join?...
 *
 * Le proxy WS side-steps le blocage Cloudflare cross-origin en se connectant
 * côté serveur (depuis le Worker, qui est same-origin pour OpenFront).
 *
 * ⚠️ SÉCURITÉ (audit 2026) : ce Worker injecte le header x-skailex-access
 * (accès API privilégié) sur CHAQUE requête. Il était ouvert à toutes les
 * origines (Access-Control-Allow-Origin: *) — n'importe quel site pouvait
 * l'utiliser comme passerelle anonyme vers l'API OpenFront avec ton exemption.
 * Il est désormais restreint aux origines officielles (liste ALLOWED_ORIGINS).
 *
 * ── Server list v2 (v34) ─────────────────────────────────────────────
 * L'hôte upstream de /lobby-ws est résolu dynamiquement :
 *   GET https://api.openfront.io/cluster.json?site=<CLUSTER_SITE>
 *   → 200 { latest, servers: { lettre: { host, numWorkers, version, state } } }
 *     → on choisit un serveur dont state != draining/fenced
 *   → 404 « Unknown site » (endpoint dormant, avant la bascule v34)
 *     → fallback legacy wss://openfront.io/w{0-19}/lobbies
 * Cache mémoire 30 s pour ne pas marteler l'API. Le site fonctionne donc
 * AVANT et APRÈS la bascule sans redéploiement du Worker.
 *
 * Configuration (Dashboard Cloudflare → Worker → Settings → Variables) :
 *   SKAILEX_ACCESS_TOKEN   — token d'accès (déjà en place, secret)
 *   ALLOWED_ORIGINS        — (optionnel) liste d'origines séparées par des
 *                            virgules, ex: "https://thefronthub.com,https://mon-dev.local"
 *                            Par défaut : origines officielles du site ci-dessous.
 *   ALLOW_ALL_ORIGINS      — (optionnel, déconseillé) "1" pour réouvrir à tout.
 *                            UNIQUEMENT pour déboguer, jamais en production.
 */

const SKAILEX_ACCESS_TOKEN = process.env.SKAILEX_ACCESS_TOKEN || "";
const API_BASE = "https://api.openfront.io";

// ── Allowlist d'origines (audit sécurité) ───────────────────────────────
// Ce worker relaie des requêtes avec ton token d'exemption : il ne doit
// être consommable QUE par tes propres sites.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://thefronthub.com",
  "https://www.thefronthub.com",
  "https://skailex239.github.io",   // miroir GitHub Pages
  "http://localhost:3000",         // dev local
  "http://localhost:5500",         // dev local (live server)
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5500",
];

const ALLOW_ALL_ORIGINS = process.env.ALLOW_ALL_ORIGINS === "1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (ALLOW_ALL_ORIGINS) return true;            // mode debug explicite
  if (!origin) return false;                     // requêtes sans Origin (curl, server-side) → refusées
  const list = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : DEFAULT_ALLOWED_ORIGINS;
  return list.includes(origin);
}

/** Réponse CORS dont l'origine est validée (jamais "*"). */
function corsHeadersFor(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

// Pool legacy complet : OpenFront sert numWorkers=20 depuis le déploiement
// du 2026-09-04 (les 20 workers exposent la même liste de lobbies).
const LOBBY_WORKERS = Array.from({ length: 20 }, (_, i) => `w${i}`);

// ── Server list v2 : résolution de l'hôte de jeu (cache mémoire 30 s) ──
const CLUSTER_SITE = "openfront.io";
const CLUSTER_TTL_MS = 30_000;
let clusterCache = { hosts: null, at: 0 }; // hosts = null → legacy

async function resolveLobbyHosts() {
  const now = Date.now();
  if (now - clusterCache.at < CLUSTER_TTL_MS) return clusterCache.hosts;
  let hosts = null; // fallback legacy par défaut
  try {
    const res = await fetch(
      `${API_BASE}/cluster.json?site=${encodeURIComponent(CLUSTER_SITE)}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "skailex",
          "x-skailex-access": SKAILEX_ACCESS_TOKEN,
        },
        cf: { cacheTtl: 0 },
      },
    );
    if (res.ok) {
      const data = await res.json();
      const list = data && data.servers
        ? Object.values(data.servers)
            .filter((s) => s && s.host && s.state !== "draining" && s.state !== "fenced")
            .map((s) => s.host)
        : [];
      if (list.length) hosts = list;
    }
    // 404 « Unknown site » ou réponse invalide → hosts reste null (legacy)
  } catch (e) {
    // réseau/erreur → legacy
  }
  clusterCache = { hosts, at: now };
  return hosts;
}

/** Réponse 403 générique (sans détails internes). */
function forbidden(origin) {
  return new Response(JSON.stringify({ error: "Forbidden origin" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ── Contrôle d'origine (audit sécurité) ──
    // Requis AVANT tout traitement : le worker relaie un token privilégié.
    const origin = request.headers.get("Origin") || "";
    if (!isOriginAllowed(origin)) {
      return forbidden(origin);
    }

    // ───────────────────────────────────────────────────────────
    // WebSocket proxy: /lobby-ws
    //   Client connects: wss://openfront-proxy.diofortnite3.workers.dev/lobby-ws
    //   Worker resolves: Server list v2 (cluster.json, cache 30 s) puis
    //                    fallback legacy wss://openfront.io/w{0-19}/lobbies
    //   Worker bridges   both sides (binary frames passthrough).
    // ───────────────────────────────────────────────────────────
    if (url.pathname === "/lobby-ws") {
      // ?site= permet de cibler un autre site enregistré (défaut : openfront.io)
      const site = url.searchParams.get("site") || CLUSTER_SITE;
      return proxyWebSocket(request, async () => {
        const hosts = site === CLUSTER_SITE
          ? await resolveLobbyHosts()
          : null;
        const host = hosts
          ? hosts[Math.floor(Math.random() * hosts.length)]
          : "openfront.io";
        const w = LOBBY_WORKERS[Math.floor(Math.random() * LOBBY_WORKERS.length)];
        return `wss://${host}/${w}/lobbies`;
      });
    }

    // /matchmaking-ws?mode=1v1  → wss://api.openfront.io/matchmaking/join?instance_id=tfh-monitor&mode=1v1
    // ⚠️ FIX v34 : le matchmaking est servi par l'API (api.<domain>), PAS par le
    // master de jeu — l'ancien upstream wss://openfront.io/matchmaking/join
    // ne correspond à aucun endpoint du jeu.
    if (url.pathname === "/matchmaking-ws") {
      return proxyWebSocket(request, () => {
        const mode = url.searchParams.get("mode") || "1v1";
        return `wss://api.openfront.io/matchmaking/join?instance_id=tfh-monitor&mode=${encodeURIComponent(mode)}`;
      });
    }

    // ── CORS preflight (origine déjà validée ci-dessus) ──
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeadersFor(origin) });
    }

    // ── Only allow GET ──
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeadersFor(origin) },
      });
    }

    // ── HTTP proxy: /<path> → https://api.openfront.io/<path> ──
    const targetUrl = `${API_BASE}${url.pathname}${url.search}`;
    try {
      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "skailex",
          "x-skailex-access": SKAILEX_ACCESS_TOKEN,
        },
        cf: { cacheTtl: 0 },
      });

      const body = await upstream.text();
      const contentType = upstream.headers.get("content-type") || "application/json";

      return new Response(body, {
        status: upstream.status,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          ...corsHeadersFor(origin),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown proxy error";
      return new Response(
        JSON.stringify({ error: "Proxy fetch failed", message }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeadersFor(origin) },
        }
      );
    }
  },
};

/**
 * Proxifie une connexion WebSocket entrante vers une URL upstream.
 * L'URL upstream peut être déterminée dynamiquement (résolution Server list
 * v2, pick d'un worker aléatoire) grâce à la fonction `resolveUpstream`
 * (synchrone ou async).
 */
async function proxyWebSocket(request, resolveUpstream) {
  const upgrade = request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const upstreamUrl = await resolveUpstream();

  try {
    // ⚠️ API Cloudflare Workers pour les WebSockets :
    //   On fetch l'URL wss:// SANS header Upgrade manuel (Cloudflare le fait).
    //   On doit passer l'header Origin pour passer les checks OpenFront.
    const upstreamResp = await fetch(upstreamUrl, {
      headers: {
        "Origin": "https://openfront.io",
        "User-Agent": "Mozilla/5.0",
      },
    });

    const upstreamWs = upstreamResp.webSocket;
    if (!upstreamWs) {
      return new Response(
        JSON.stringify({ error: "Upstream WS failed" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create client-facing WebSocket pair
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = [pair[0], pair[1]];

    upstreamWs.accept();
    serverWs.accept();

    // Forward upstream → client (binary safe)
    upstreamWs.addEventListener("message", (e) => {
      try { serverWs.send(e.data); } catch {}
    });
    // Forward client → upstream (rarement utile pour le lobby, mais safe)
    serverWs.addEventListener("message", (e) => {
      try { upstreamWs.send(e.data); } catch {}
    });

    const closeBoth = () => {
      try { upstreamWs.close(); } catch {}
      try { serverWs.close(); } catch {}
    };
    upstreamWs.addEventListener("close", closeBoth);
    serverWs.addEventListener("close", closeBoth);
    upstreamWs.addEventListener("error", closeBoth);
    serverWs.addEventListener("error", closeBoth);

    return new Response(null, { status: 101, webSocket: clientWs });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "WS proxy failed", message: err.message }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
