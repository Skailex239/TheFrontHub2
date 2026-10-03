// GET /api/openfront/search?q=... — recherche dans le registre des joueurs connus.
import { NextResponse } from "next/server";
import { searchPlayers } from "@/lib/openfront/registry";
import { syncRegistryFromLeaderboard } from "@/lib/openfront/registry";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q") ?? "";
    if (!q.trim()) return NextResponse.json({ results: [] });
    await syncRegistryFromLeaderboard().catch(() => undefined);
    const results = await searchPlayers(q);
    return NextResponse.json(
      { results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
