// Service « Speedrun » : records de victoires rapides.
//
// Toutes les 10 minutes (et au premier appel) on récupère l'historique des
// dernières parties des meilleurs joueurs classés + des joueurs suivis, puis
// on conserve les victoires les plus rapides. Les entrées sont indexées par
// gameId et triées par durée : la liste est stable entre deux rafraîchissements
// (pas de pseudo qui clignote), les pseudos viennent du registre.
import "server-only";
import { db } from "@/lib/db";
import { getLeaderboard, getPlayerGames } from "./client";
import type { PlayerGame, SpeedrunRecord } from "./types";

const MAX_PLAYERS_FETCHED = 40;
const BATCH_SIZE = 8;

interface SpeedrunState {
  computing: boolean;
  lastComputedAt: number;
  playerCount: number;
  top: SpeedrunRecord[];
  byMap: Array<{ map: string; record: SpeedrunRecord; count: number }>;
  seen: Map<string, string>; // gameId -> publicId (stable)
  timer?: NodeJS.Timeout;
  started: boolean;
}

const g = globalThis as unknown as { __ofSpeedrun?: SpeedrunState };

function state(): SpeedrunState {
  if (!g.__ofSpeedrun) {
    g.__ofSpeedrun = {
      computing: false,
      lastComputedAt: 0,
      playerCount: 0,
      top: [],
      byMap: [],
      seen: new Map(),
      started: false,
    };
  }
  return g.__ofSpeedrun;
}

async function playerList(): Promise<
  Array<{ publicId: string; username: string }>
> {
  const { data } = await getLeaderboard();
  const fromBoard: Array<{ publicId: string; username: string }> = [];
  if (data) {
    const seen = new Set<string>();
    for (const e of [...(data["1v1"] ?? []), ...(data["2v2"] ?? [])]) {
      if (seen.has(e.public_id)) continue;
      seen.add(e.public_id);
      fromBoard.push({ publicId: e.public_id, username: e.username });
    }
  }
  const tracked = await db.player.findMany({
    where: { tracked: true },
    select: { publicId: true, username: true },
  });
  const map = new Map<string, string>();
  for (const p of [...fromBoard, ...tracked]) map.set(p.publicId, p.username);
  return [...map.entries()]
    .map(([publicId, username]) => ({ publicId, username }))
    .slice(0, MAX_PLAYERS_FETCHED + tracked.length);
}

function toRecord(
  game: PlayerGame,
  publicId: string,
  username: string,
): SpeedrunRecord | null {
  if (game.result !== "victory") return null;
  if (!Number.isFinite(game.durationSeconds) || game.durationSeconds <= 0)
    return null;
  return {
    publicId,
    username,
    gameId: game.gameId,
    map: game.map,
    mode: game.mode,
    durationSeconds: Math.round(game.durationSeconds),
    start: game.start,
    totalPlayers: game.totalPlayers,
    rankedType: game.rankedType,
  };
}

async function compute(): Promise<void> {
  const s = state();
  if (s.computing) return;
  s.computing = true;
  // Auto-guérison : un état vide hérité d'un calcul raté (service pas prêt)
  // est traité comme « pas encore calculé ».
  if (s.playerCount === 0) s.lastComputedAt = 0;
  try {
    const players = await playerList();
    if (players.length === 0) {
      // Classement indisponible (service en cours de démarrage ?) :
      // on ne marque PAS le calcul comme fait, on réessaie plus tard.
      return;
    }
    const all: SpeedrunRecord[] = [];
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const batch = players.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (p) => {
          const { data } = await getPlayerGames(p.publicId);
          const games = data?.results ?? [];
          return games
            .map((game) => toRecord(game, p.publicId, p.username))
            .filter((r): r is SpeedrunRecord => r !== null);
        }),
      );
      for (const recs of results) all.push(...recs);
    }
    // Dé-duplication par gameId (ordre stable : durée croissante).
    const byGame = new Map<string, SpeedrunRecord>();
    for (const r of all) {
      const existing = byGame.get(r.gameId);
      if (!existing || r.durationSeconds < existing.durationSeconds) {
        byGame.set(r.gameId, r);
      }
    }
    const unique = [...byGame.values()];
    unique.sort((a, b) =>
      a.durationSeconds !== b.durationSeconds
        ? a.durationSeconds - b.durationSeconds
        : a.gameId.localeCompare(b.gameId),
    );
    s.top = unique.slice(0, 100);
    s.playerCount = players.length;
    s.lastComputedAt = Date.now();

    const mapGroups = new Map<string, SpeedrunRecord[]>();
    for (const r of unique) {
      const list = mapGroups.get(r.map) ?? [];
      list.push(r);
      mapGroups.set(r.map, list);
    }
    s.byMap = [...mapGroups.entries()]
      .map(([map, list]) => ({
        map,
        record: list.reduce((best, r) =>
          r.durationSeconds < best.durationSeconds ? r : best,
        ),
        count: list.length,
      }))
      .sort((a, b) => a.record.durationSeconds - b.record.durationSeconds)
      .slice(0, 30);
  } catch (err) {
    console.warn("[speedrun] calcul échoué:", (err as Error).message);
  } finally {
    s.computing = false;
  }
}

export function startSpeedrunService(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  // Premier calcul après 5 s (laisse le mini-service et son cache chauffer),
  // puis re-essai rapide si le premier calcul a échoué (données pas prêtes).
  const retry = () => {
    void compute().then(() => {
      if (s.lastComputedAt === 0) setTimeout(retry, 30_000).unref?.();
    });
  };
  setTimeout(retry, 5000).unref?.();
  s.timer = setInterval(() => void compute(), 10 * 60_000);
  s.timer.unref?.();
}

export function getSpeedrun() {
  startSpeedrunService();
  const s = state();
  if (s.lastComputedAt === 0 || s.playerCount === 0) return null;
  return {
    computedAt: s.lastComputedAt,
    playerCount: s.playerCount,
    top: s.top,
    byMap: s.byMap,
  };
}

/** Déclenche un calcul en arrière-plan si les données manquent. */
export function ensureSpeedrun(): void {
  const s = state();
  if (s.lastComputedAt === 0 || s.playerCount === 0) {
    void compute();
  }
}
