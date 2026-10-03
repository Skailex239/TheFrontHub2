// Service OpenFront (mini-service bun, port 3020).
//
// Pourquoi un service séparé ? La passerelle Cloudflare d'api.openfront.io
// fingerprint TLS : les connexions issues de Node (undici/OpenSSL) sont
// rejetées (403) alors que celles de bun (BoringSSL) passent. Ce service bun
// est donc le SEUL point de sortie vers OpenFront :
//   - HTTP : api.openfront.io (leaderboard, cluster, cosmetics, profils, parties)
//   - WebSocket temps réel : wss://<serveur>/wN/lobbies (flux zbin des lobbies)
//
// Le serveur Next.js consomme ce service en localhost :3020.
import WebSocket from "ws";
import { decodeLobbyFrame } from "./lobby-decoder.mjs";

const PORT = 3020;
const API_BASE = "https://api.openfront.io";
const WS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Cache HTTP simple avec stale-while-revalidate
// ---------------------------------------------------------------------------
interface CacheEntry {
  data: unknown | null;
  fetchedAt: number;
  inflight: Promise<unknown | null> | null;
}
const httpCache = new Map<string, CacheEntry>();

async function fetchJson(path: string, timeoutMs = 15000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: "application/json, text/plain, */*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${path}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cached(key: string, ttlMs: number, loader: () => Promise<unknown>) {
  let entry = httpCache.get(key);
  if (!entry) {
    entry = { data: null, fetchedAt: 0, inflight: null };
    httpCache.set(key, entry);
  }
  if (entry.data !== null && Date.now() - entry.fetchedAt < ttlMs) {
    return { data: entry.data, fetchedAt: entry.fetchedAt };
  }
  if (entry.inflight) {
    const data = await entry.inflight;
    return { data: data ?? entry.data, fetchedAt: entry.fetchedAt };
  }
  const p = loader()
    .then((data: unknown) => {
      entry!.data = data;
      entry!.fetchedAt = Date.now();
      return data;
    })
    .catch((err: Error) => {
      console.warn(`[openfront-service] échec ${key}: ${err.message}`);
      return null;
    })
    .finally(() => {
      entry!.inflight = null;
    });
  entry.inflight = p;
  const data = await p;
  return { data: data ?? entry.data, fetchedAt: entry.fetchedAt };
}

// ---------------------------------------------------------------------------
// Cosmétiques compactés (catalogue quasi statique)
// ---------------------------------------------------------------------------
function firstPaletteNames(v: Record<string, unknown>, max = 8): string[] {
  const cps = v.colorPalettes;
  if (!Array.isArray(cps)) return [];
  return cps
    .slice(0, max)
    .map((c) =>
      typeof c === "string"
        ? c
        : String((c as { name?: string } | null)?.name ?? ""),
    )
    .filter(Boolean);
}

function compactCosmetics(raw: Record<string, unknown>) {
  const patterns: Array<Record<string, unknown>> = [];
  const flags: Array<Record<string, unknown>> = [];
  const crowns: Array<Record<string, unknown>> = [];
  const skins: Array<Record<string, unknown>> = [];
  const effects: Array<Record<string, unknown>> = [];
  const palettes: Array<Record<string, unknown>> = [];

  const push = (arr: Array<Record<string, unknown>>, v: Record<string, unknown>, category: string) => {
    arr.push({
      name: String(v.name ?? ""),
      rarity: String(v.rarity ?? "common"),
      artist: v.artist ? String(v.artist) : undefined,
      priceHard: typeof v.priceHard === "number" ? v.priceHard : undefined,
      url: typeof v.url === "string" ? v.url : undefined,
      pattern: typeof v.pattern === "string" ? v.pattern : undefined,
      palettes: firstPaletteNames(v),
      category,
    });
  };

  for (const [name, v] of Object.entries((raw.patterns ?? {}) as Record<string, Record<string, unknown>>)) {
    push(patterns, { ...v, name: (v.name as string) ?? name }, "pattern");
  }
  for (const [name, v] of Object.entries((raw.flags ?? {}) as Record<string, Record<string, unknown>>)) {
    push(flags, { ...v, name: (v.name as string) ?? name }, "flag");
  }
  for (const [name, v] of Object.entries((raw.crowns ?? {}) as Record<string, Record<string, unknown>>)) {
    push(crowns, { ...v, name: (v.name as string) ?? name }, "crown");
  }
  for (const [name, v] of Object.entries((raw.skins ?? {}) as Record<string, Record<string, unknown>>)) {
    push(skins, { ...v, name: (v.name as string) ?? name }, "skin");
  }
  for (const [category, group] of Object.entries((raw.effects ?? {}) as Record<string, Record<string, Record<string, unknown>>>)) {
    for (const [name, v] of Object.entries(group ?? {})) {
      push(effects, { ...v, name: (v.name as string) ?? name }, `effect:${category}`);
    }
  }
  for (const [name, v] of Object.entries((raw.colorPalettes ?? {}) as Record<string, Record<string, string>>)) {
    palettes.push({
      name: (v.name as string) ?? name,
      primaryColor: String(v.primaryColor ?? "#000000"),
      secondaryColor: String(v.secondaryColor ?? "#ffffff"),
    });
  }
  return { patterns, flags, crowns, skins, effects, palettes };
}

// ---------------------------------------------------------------------------
// Flux WebSocket des lobbies publics (zbin)
// ---------------------------------------------------------------------------
const feed = {
  ws: null as WebSocket | null,
  serverHost: "",
  serverState: "",
  numWorkers: 0,
  version: "",
  workerIndex: Math.floor(Math.random() * 20),
  games: new Map<string, Record<string, unknown>>(),
  serverTime: 0,
  lastFullAt: 0,
  lastFrameAt: 0,
  lastError: undefined as string | undefined,
  reconnects: 0,
  connected: false,
  started: false,
  reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  clusterTimer: null as ReturnType<typeof setInterval> | null,
  backoffMs: 1000,
};

function toLobbyInfo(raw: Record<string, unknown>, bucket: string): Record<string, unknown> {
  const cfg = (raw.gameConfig ?? {}) as Record<string, unknown>;
  return {
    gameID: String(raw.gameID ?? ""),
    numClients: Number(raw.numClients ?? 0),
    startsAt: typeof raw.startsAt === "number" ? raw.startsAt : undefined,
    autoStartAt: typeof raw.autoStartAt === "number" ? raw.autoStartAt : undefined,
    publicGameType: String(raw.publicGameType ?? bucket),
    custom: raw.custom === true,
    featured: raw.featured === true,
    queued: raw.queued === true,
    label: raw.label ?? undefined,
    gameConfig: {
      gameMap: cfg.gameMap ? String(cfg.gameMap) : undefined,
      gameMode: cfg.gameMode ? String(cfg.gameMode) : undefined,
      maxPlayers: typeof cfg.maxPlayers === "number" ? cfg.maxPlayers : undefined,
      difficulty: cfg.difficulty ? String(cfg.difficulty) : undefined,
      gameType: cfg.gameType ? String(cfg.gameType) : undefined,
      playerTeams: typeof cfg.playerTeams === "number" ? cfg.playerTeams : null,
      nations: typeof cfg.nations === "number" ? cfg.nations : undefined,
      initialCoins: typeof cfg.initialCoins === "number" ? cfg.initialCoins : undefined,
    },
  };
}

function handleMessage(data: Buffer) {
  let msg: ReturnType<typeof decodeLobbyFrame>;
  try {
    msg = decodeLobbyFrame(new Uint8Array(data));
  } catch (err) {
    feed.lastError = `trame zbin illisible: ${(err as Error).message}`;
    return;
  }
  feed.lastFrameAt = Date.now();
  feed.backoffMs = 1000;

  if (msg.type === "full") {
    feed.serverTime = msg.serverTime;
    feed.lastFullAt = Date.now();
    feed.games = new Map();
    for (const [bucket, list] of Object.entries(msg.games ?? {})) {
      for (const raw of list as Array<Record<string, unknown>>) {
        const info = toLobbyInfo(raw, bucket);
        if (info.gameID) feed.games.set(info.gameID as string, info);
      }
    }
    if (msg.active === false) {
      feed.lastError = "serveur en cours de vidage (active=false)";
      closeSocket();
      scheduleReconnect();
    }
  } else if (msg.type === "counts") {
    feed.serverTime = msg.serverTime;
    for (const [gameId, n] of Object.entries(msg.counts ?? {})) {
      const existing = feed.games.get(gameId);
      if (existing) existing.numClients = Number(n);
    }
  }
}

function closeSocket() {
  if (feed.ws) {
    try {
      feed.ws.removeAllListeners();
      feed.ws.close();
    } catch {
      /* ignore */
    }
    feed.ws = null;
  }
  feed.connected = false;
}

function scheduleReconnect() {
  if (feed.reconnectTimer) return;
  feed.backoffMs = Math.min(feed.backoffMs * 1.8, 30_000);
  feed.reconnectTimer = setTimeout(() => {
    feed.reconnectTimer = null;
    connectWs();
  }, feed.backoffMs);
}

function connectWs() {
  if (!feed.serverHost || feed.numWorkers <= 0) {
    scheduleReconnect();
    return;
  }
  closeSocket();
  const worker = feed.workerIndex % feed.numWorkers;
  const url = `wss://${feed.serverHost}/w${worker}/lobbies?platform=web`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, {
      headers: {
        "User-Agent": WS_UA,
        Origin: "https://openfront.io",
        "Accept-Language": "en-US,en;q=0.9",
      },
      handshakeTimeout: 15000,
    } as WebSocket.ClientOptions);
  } catch (err) {
    feed.lastError = `connexion impossible: ${(err as Error).message}`;
    scheduleReconnect();
    return;
  }
  feed.ws = ws;
  ws.on("open", () => {
    feed.connected = true;
    feed.lastError = undefined;
    console.log(`[openfront-service] WS lobbies connecté: ${url}`);
  });
  ws.on("message", (data: Buffer) => handleMessage(data));
  ws.on("error", (err: Error) => {
    feed.lastError = err.message;
  });
  ws.on("close", (code: number) => {
    feed.connected = false;
    if (feed.ws === ws) feed.ws = null;
    feed.reconnects += 1;
    feed.workerIndex += 1; // rotation du worker wN à chaque échec
    if (code === 403 || code === 1002 || code === 1010) {
      void refreshCluster(true).then(() => scheduleReconnect());
      return;
    }
    scheduleReconnect();
  });
}

async function refreshCluster(force = false) {
  const { data } = await cached("cluster", 60_000, () =>
    fetchJson("/cluster.json?site=openfront.io"),
  );
  const cluster = data as { servers?: Record<string, { host: string; numWorkers: number; version: string; state: string }> } | null;
  if (!cluster) {
    if (force) feed.lastError = "cluster.json injoignable";
    return;
  }
  const entries = Object.entries(cluster.servers ?? {});
  const open = entries.filter(([, s]) => s.state === "open");
  const draining = entries.filter(([, s]) => s.state === "draining");
  const pool = open.length > 0 ? open : draining;
  if (pool.length === 0) {
    feed.lastError = "aucun serveur dans cluster.json";
    return;
  }
  pool.sort(([a], [b]) => a.localeCompare(b));
  const [, srv] = pool[0];
  const changed = srv.host !== feed.serverHost || srv.numWorkers !== feed.numWorkers;
  feed.serverHost = srv.host;
  feed.serverState = srv.state;
  feed.numWorkers = srv.numWorkers;
  feed.version = srv.version;
  if (changed && feed.ws) {
    closeSocket();
    scheduleReconnect();
  }
}

function startFeed() {
  if (feed.started) return;
  feed.started = true;
  void refreshCluster().then(() => connectWs());
  feed.clusterTimer = setInterval(() => void refreshCluster(), 120_000);
}

function lobbySnapshot() {
  startFeed();
  const games = [...feed.games.values()].sort((a, b) => {
    const bucket = (t: unknown) =>
      t === "ffa" ? 0 : t === "team" ? 1 : 2;
    const ba = bucket(a.publicGameType);
    const bb = bucket(b.publicGameType);
    if (ba !== bb) return ba - bb;
    return Number(b.numClients) - Number(a.numClients);
  });
  return {
    connected: feed.connected,
    serverHost: feed.serverHost,
    serverState: feed.serverState,
    numWorkers: feed.numWorkers,
    version: feed.version,
    serverTime: feed.serverTime,
    lastFullAt: feed.lastFullAt,
    lastFrameAt: feed.lastFrameAt,
    lastError: feed.lastError,
    reconnects: feed.reconnects,
    games,
  };
}

// ---------------------------------------------------------------------------
// Serveur HTTP du mini-service
// ---------------------------------------------------------------------------
const startedAt = Date.now();

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });

    try {
      if (path === "/health") {
        return json({
          ok: true,
          uptimeMs: Date.now() - startedAt,
          wsConnected: feed.connected,
          wsHost: feed.serverHost,
          lobbies: feed.games.size,
        });
      }
      if (path === "/lobby" || path === "/lobbies") {
        // Alias /lobbies + CORS : permet de tester en navigateur le mode
        // « source worker » de l'app (même format de réponse que le worker
        // Cloudflare).
        return new Response(JSON.stringify(lobbySnapshot()), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      if (path === "/leaderboard") {
        const r = await cached("leaderboard", 60_000, () => fetchJson("/leaderboard/ranked"));
        return json(r);
      }
      if (path === "/cluster") {
        const r = await cached("cluster", 60_000, () => fetchJson("/cluster.json?site=openfront.io"));
        return json(r);
      }
      if (path === "/cosmetics") {
        const r = await cached("cosmetics", 6 * 3600_000, async () => {
          const raw = (await fetchJson("/cosmetics.json")) as Record<string, unknown>;
          return compactCosmetics(raw);
        });
        return json(r);
      }
      const playerMatch = path.match(/^\/player\/([A-Za-z0-9_-]{4,32})$/);
      if (playerMatch) {
        const id = playerMatch[1];
        const r = await cached(`player:${id}`, 5 * 60_000, () =>
          fetchJson(`/public/player/${encodeURIComponent(id)}`),
        );
        return json(r);
      }
      const gamesMatch = path.match(/^\/player\/([A-Za-z0-9_-]{4,32})\/games$/);
      if (gamesMatch) {
        const id = gamesMatch[1];
        const r = await cached(`games:${id}`, 5 * 60_000, () =>
          fetchJson(`/public/player/${encodeURIComponent(id)}/games`),
        );
        return json(r);
      }
      return json({ error: "route inconnue" }, 404);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  },
});

startFeed();
console.log(`[openfront-service] à l'écoute sur http://localhost:${server.port}`);
