import { NextResponse } from "next/server";

/**
 * Proxy CORS vers l'API publique OpenFront avec exemption Skailex.
 *
 * Le client (openfront-client.js) appelle /api/openfront/<path> en dev local
 * pour contourner les restrictions CORS de l'API OpenFront (qui n'autorise
 * que openfront.io). En production (GitHub Pages), le client utilise le
 * Cloudflare Worker (cloudflare-worker/openfront-proxy.js) à la place.
 *
 * Cette route ajoute le header `x-skailex-access` côté serveur pour bénéficier
 * de l'exemption de rate-limit. Le token n'est jamais exposé côté client.
 *
 * Cette route est utilisée UNIQUEMENT en environnement de développement
 * Next.js (localhost). Elle forward vers https://api.openfront.io/<path>.
 */

const OPENFRONT_API_BASE = "https://api.openfront.io";
const SKAILEX_ACCESS_TOKEN = process.env.SKAILEX_ACCESS_TOKEN || "";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathSegments } = await params;
  const fullPath = pathSegments.join("/");
  const url = new URL(request.url);
  const queryString = url.search ? url.search.slice(1) : "";

  const targetUrl = `${OPENFRONT_API_BASE}/${fullPath}${queryString ? "?" + queryString : ""}`;

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "skailex",
        "x-skailex-access": SKAILEX_ACCESS_TOKEN,
      },
      cache: "no-store",
    });

    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";

    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown proxy error";
    return NextResponse.json(
      { error: "Proxy fetch failed", message, target: targetUrl },
      { status: 502 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    },
  });
}
