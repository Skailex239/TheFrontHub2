import { NextResponse } from "next/server";
import { getLobbySnapshot } from "@/lib/openfront/lobby-feed";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = getLobbySnapshot();
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
