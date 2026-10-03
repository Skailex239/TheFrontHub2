// GET /api/openfront/dashboard — un SEUL appel renvoyant toutes les données
// du tableau de bord : c'est la correction du bug « la page affiche d'abord
// les joueurs, puis les skins, puis les joueurs vérifiés ». Tout arrive
// atomiquement et le rendu se fait en une passe.
import { NextResponse } from "next/server";
import { getCluster, getLeaderboard } from "@/lib/openfront/client";
import { ensureService } from "@/lib/openfront/service-manager";
import { listRegistry, syncRegistryFromLeaderboard } from "@/lib/openfront/registry";
import { getSpeedrun, ensureSpeedrun, startSpeedrunService } from "@/lib/openfront/speedrun";
import { startLobbyFeed } from "@/lib/openfront/lobby-feed";
import type { DashboardPayload, LeaderboardEntry } from "@/lib/openfront/types";

export const dynamic = "force-dynamic";

function isVerifiedUsername(username: string): boolean {
  return !username.includes(".") && !/^TEMPORARY\d{4}$/.test(username);
}

export async function GET() {
  try {
    startLobbyFeed();
    startSpeedrunService();
    // Le mini-service bun doit tourner avant toute requête en aval.
    await ensureService();

    const [leaderboard, cluster] = await Promise.all([
      getLeaderboard(),
      getCluster(),
    ]);

    // Mise à jour du registre (pseudo stable + renommages) en arrière-plan
    // de la requête, mais on attend sa version déjà calculée pour la réponse.
    await syncRegistryFromLeaderboard().catch(() => undefined);
    const registry = await listRegistry().catch(() => []);

    // Relance le calcul speedrun en arrière-plan s'il manque.
    ensureSpeedrun();

    const verified: LeaderboardEntry[] = [];
    const seen = new Set<string>();
    for (const board of [leaderboard.data?.["1v1"], leaderboard.data?.["2v2"]]) {
      for (const e of board ?? []) {
        if (!isVerifiedUsername(e.username) || seen.has(e.public_id)) continue;
        seen.add(e.public_id);
        verified.push(e);
      }
    }
    verified.sort((a, b) => b.elo - a.elo);

    const payload: DashboardPayload = {
      generatedAt: Date.now(),
      apiOk: leaderboard.data !== null,
      leaderboard: {
        "1v1": leaderboard.data?.["1v1"] ?? [],
        "2v2": leaderboard.data?.["2v2"] ?? [],
      },
      leaderboardFetchedAt: leaderboard.fetchedAt,
      cluster: cluster.data,
      clusterFetchedAt: cluster.fetchedAt,
      verified,
      registry,
      speedrun: getSpeedrun(),
    };

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
