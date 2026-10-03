// Instantané lobbies : le WebSocket zbin vit dans le mini-service bun
// (mini-services/openfront-service) ; ce module interroge ce service en
// localhost et garde un dernier instantané connu pour servir du stale si le
// service redémarre (hot reload) — le front ne doit jamais « clignoter ».
import "server-only";
import { ensureService } from "./service-manager";
import type { LobbySnapshot } from "./types";

interface FeedState {
  last: LobbySnapshot | null;
  started: boolean;
  pollTimer: NodeJS.Timeout | null;
}

const g = globalThis as unknown as { __ofLobbyPoller?: FeedState };

function state(): FeedState {
  if (!g.__ofLobbyPoller) {
    g.__ofLobbyPoller = { last: null, started: false, pollTimer: null };
  }
  return g.__ofLobbyPoller;
}

async function pollOnce(): Promise<void> {
  const s = state();
  try {
    const ok = await fetch("http://localhost:3020/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    })
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) await ensureService();
    const res = await fetch("http://localhost:3020/lobby", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const body = (await res.json()) as LobbySnapshot;
    if (body && Array.isArray(body.games)) s.last = body;
  } catch {
    /* on garde le dernier instantané connu */
  }
}

export function startLobbyFeed(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  void pollOnce();
  // Poll léger côté serveur (2 s) pour garder un instantané frais même
  // entre deux rafraîchissements du navigateur.
  s.pollTimer = setInterval(() => void pollOnce(), 2000);
  s.pollTimer.unref?.();
}

export function getLobbySnapshot(): LobbySnapshot {
  const s = state();
  startLobbyFeed();
  if (s.last) return s.last;
  // Premier appel avant la première réponse du service : instantané vide
  // structuré pour que le front affiche un squelette plutôt qu'un crash.
  return {
    connected: false,
    serverHost: "",
    serverState: "",
    numWorkers: 0,
    version: "",
    serverTime: Date.now(),
    lastFullAt: 0,
    lastFrameAt: 0,
    lastError: "en attente du mini-service",
    reconnects: 0,
    games: [],
  };
}
