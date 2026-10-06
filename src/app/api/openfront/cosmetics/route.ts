import { NextResponse } from "next/server";
import { getCosmeticsCompact } from "@/lib/openfront/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { data, fetchedAt } = await getCosmeticsCompact();
    if (!data) {
      return NextResponse.json(
        { error: "cosmétiques indisponibles" },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { data, fetchedAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
