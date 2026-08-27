/**
 * Cloudflare Worker — Proxy CORS + WebSocket proxy vers OpenFront.
 *
 * Routes :
 *   GET /<path>           → proxy HTTP vers https://api.openfront.io/<path>
 *   GET /lobby-ws         → proxy WebSocket vers wss://openfront.io/w{0-4}/lobbies
 *   GET /matchmaking-ws   → proxy WebSocket vers wss://openfront.io/matchmaking/join?...
 *
 * Le proxy WS side-steps le blocage Cloudflare cross-origin en se connectant
 * côté serveur (depuis le Worker, qui est same-origin pour OpenFront).
 */

const SKAILEX_ACCESS_TOKEN = process.env.SKAILEX_ACCESS_TOKEN || "";
const API_BASE = "https://api.openfront.io";

// On pick un worker aléatoire parmi w0..w4 (load balancing côté OpenFront)
const LOBBY_WORKERS = ["w0", "w1", "w2", "w3", "w4"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ───────────────────────────────────────────────────────────
    // WebSocket proxy: /lobby-ws
    //   Client connects: wss://openfront-proxy.diofortnite3.workers.dev/lobby-ws
    //   Worker opens:     wss://openfront.io/w{0-4}/lobbies (random worker)
    //   Worker bridges    both sides (binary frames passthrough).
    // ───────────────────────────────────────────────────────────
    if (url.pathname === "/lobby-ws") {
      return proxyWebSocket(request, () => {
        const w = LOBBY_WORKERS[Math.floor(Math.random() * LOBBY_WORKERS.length)];
        return `wss://openfront.io/${w}/lobbies`;
      });
    }

    // /matchmaking-ws?mode=1v1  → wss://openfront.io/matchmaking/join?instance_id=tfh-monitor&mode=1v1
    if (url.pathname === "/matchmaking-ws") {
      return proxyWebSocket(request, () => {
        const mode = url.searchParams.get("mode") || "1v1";
        return `wss://openfront.io/matchmaking/join?instance_id=tfh-monitor&mode=${encodeURIComponent(mode)}`;
      });
    }

    // ── CORS preflight ──
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Only allow GET ──
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
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
          ...CORS_HEADERS,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown proxy error";
      return new Response(
        JSON.stringify({ error: "Proxy fetch failed", message, target: targetUrl }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        }
      );
    }
  },
};

/**
 * Proxifie une connexion WebSocket entrante vers une URL upstream.
 * L'URL upstream peut être déterminée dynamiquement (par exemple pour pick un
 * worker aléatoire) grâce à la fonction `resolveUpstream`.
 */
async function proxyWebSocket(request, resolveUpstream) {
  const upgrade = request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const upstreamUrl = resolveUpstream();

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
        JSON.stringify({ error: "Upstream WS failed", upstream: upstreamUrl }),
        { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
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
      JSON.stringify({ error: "WS proxy failed", message: err.message, upstream: upstreamUrl }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }
}
