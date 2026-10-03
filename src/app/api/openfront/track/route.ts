// POST /api/openfront/track { publicId, tracked } — suivre / ne plus suivre un joueur.
import { NextResponse } from "next/server";
import { setTracked } from "@/lib/openfront/registry";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      publicId?: string;
      tracked?: boolean;
    };
    if (!body.publicId || !/^[A-Za-z0-9_-]{4,32}$/.test(body.publicId)) {
      return NextResponse.json(
        { error: "publicId invalide" },
        { status: 400 },
      );
    }
    const result = await setTracked(body.publicId, body.tracked !== false);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
