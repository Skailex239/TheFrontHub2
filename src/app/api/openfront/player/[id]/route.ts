// GET /api/openfront/player/[id] — profil + dernières parties en un appel.
import { NextResponse } from "next/server";
import { getPlayerGames, getPlayerProfile } from "@/lib/openfront/client";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) {
      return NextResponse.json({ error: "identifiant invalide" }, { status: 400 });
    }
    const [profile, games] = await Promise.all([
      getPlayerProfile(id),
      getPlayerGames(id),
    ]);
    if (!profile.data) {
      return NextResponse.json(
        { error: "joueur introuvable" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      {
        profile: profile.data,
        profileFetchedAt: profile.fetchedAt,
        games: games.data?.results ?? [],
        gamesFetchedAt: games.fetchedAt,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
