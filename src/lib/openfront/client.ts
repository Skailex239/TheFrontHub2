// Client vers le mini-service bun (localhost:3020) qui est le seul point de
// sortie vers OpenFront (Cloudflare fingerprint TLS : Node est bloqué, bun
// passe). Même interface qu'avant : { data, fetchedAt }.
import "server-only";
import type {
  ClusterData,
  CosmeticsCompact,
  LeaderboardData,
  PlayerGame,
  PlayerProfile,
} from "./types";

const SERVICE_BASE = "http://localhost:3020";

interface ServiceResponse<T> {
  data: T | null;
  fetchedAt: number;
}

async function fromService<T>(
  path: string,
  timeoutMs = 30000,
): Promise<{ data: T | null; fetchedAt: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVICE_BASE}${path}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`service HTTP ${res.status} sur ${path}`);
    const body = (await res.json()) as ServiceResponse<T>;
    return { data: body.data ?? null, fetchedAt: body.fetchedAt ?? 0 };
  } catch (err) {
    console.warn(`[openfront] service ${path} échoué:`, (err as Error).message);
    return { data: null, fetchedAt: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function getLeaderboard(): Promise<{
  data: LeaderboardData | null;
  fetchedAt: number;
}> {
  return fromService<LeaderboardData>("/leaderboard");
}

export async function getCluster(): Promise<{
  data: ClusterData | null;
  fetchedAt: number;
}> {
  return fromService<ClusterData>("/cluster");
}

export async function getPlayerProfile(
  publicId: string,
): Promise<{ data: PlayerProfile | null; fetchedAt: number }> {
  return fromService<PlayerProfile>(
    `/player/${encodeURIComponent(publicId)}`,
  );
}

export async function getPlayerGames(
  publicId: string,
): Promise<{ data: { results: PlayerGame[] } | null; fetchedAt: number }> {
  return fromService<{ results: PlayerGame[] }>(
    `/player/${encodeURIComponent(publicId)}/games`,
  );
}

export async function getCosmeticsCompact(): Promise<{
  data: CosmeticsCompact | null;
  fetchedAt: number;
}> {
  return fromService<CosmeticsCompact>("/cosmetics", 60000);
}
