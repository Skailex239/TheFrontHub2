/**
 * Mock v5.42 — sert le site en statique + simule les 2 routes API du
 * compteur « vues » profil avec la MÊME sémantique de dédoublonnage que le
 * backend PHP (INSERT IGNORE par PK (publicId, visitId) + compteur).
 * Chaque POST est tracé sur stdout : counted=1 → incrément, counted=0 → dédup.
 *
 * Usage : bun tests/mock-v542.mjs   (port 4173)
 */
import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join, extname, normalize } from "path";

const ROOT = join(import.meta.dir, "..");
const PORT = 4173;

/* ── État « serveur » (compteurs + visites déjà vues) ── */
const views = {};          // pid → compteur public
const seen = new Set();    // "pid|visitHash" déjà comptés

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".gz": "application/gzip",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function profilePayload(pid) {
  return {
    ok: true,
    views: views[pid] || 0,
    player: { publicId: pid, lastUsername: "Skailex", lastClanTag: null, firstSeen: 1700000000000, lastSeen: Date.now(), gamesCount: 42, winsCount: 12, deletedAt: null },
    verified: true,
    profile: { bio: "Profil de test v5.42", favMap: "Italy", favMapUserSet: false, links: { x: null, youtube: null, twitch: null, discord: null }, alias: "Skailex", verifiedAt: 1700000000 },
    aliases: [{ username: "Skailex", timesUsed: 10, lastSeen: 1700000000 }],
    ratings: [{ board: "ffa", rating: 1012.4, rd: 55, games: 30, wins: 14, peak: 1044, peakAt: 1700000000 }],
    cosmetics: [],
    hubCosmetics: { activeSkinId: null, ownedSkins: [], activeBannerId: null, ownedBanners: [], vipType: null, vipActive: false },
    clans: [],
    official: { username: "Skailex", createdAt: 1700000000, fetchedAt: Math.floor(Date.now() / 1000), stats: {} },
    stats: { byMode: [{ mode: "Free For All", rankedType: null, games: 42, wins: 12, winRate: 0.2857 }], byMap: [{ map: "Italy", games: 10, wins: 4 }], bestSpeedruns: [], recentGames: [] },
  };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    /* ── API simulée ── */
    if (path === "/api/games-api.php") {
      const route = url.searchParams.get("route") || "";
      if (req.method === "POST" && route === "profile-view") {
        const b = await req.json().catch(() => ({}));
        const pid = String(b.publicId || "");
        const vid = String(b.visitId || "");
        const isNew = !seen.has(pid + "|" + vid);
        if (isNew) seen.add(pid + "|" + vid);
        views[pid] = (views[pid] || 0) + (isNew ? 1 : 0);
        console.log(`[pfview] pid=${pid} visit=${vid} counted=${isNew ? 1 : 0} total=${views[pid]}`);
        return json({ ok: true, views: views[pid] });
      }
      if (route === "profile") {
        const pid = String(url.searchParams.get("publicId") || "");
        console.log(`[profile] GET payload pid=${pid} views=${views[pid] || 0}`);
        return json(profilePayload(pid));
      }
      if (route === "speedruns") return json({ ok: true, runs: [], games_total: 0 });
      return json({ ok: false, error: "mock: route non simulée" }, 404);
    }
    if (path.startsWith("/public/player/")) {
      return json({ error: "mock: OpenFront injoignable" }, 503);
    }

    /* ── Fichiers statiques ── */
    let rel = normalize(path).replace(/^([/\\])+/, "");
    if (rel === "" ) rel = "index.html";
    let file = join(ROOT, rel);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      const alt = join(ROOT, rel, "index.html");
      if (existsSync(alt)) file = alt;
      else return new Response("Not Found", { status: 404 });
    }
    const ext = extname(file).toLowerCase();
    return new Response(readFileSync(file), {
      headers: { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" },
    });
  },
});

console.log("[mock-v542] http://localhost:" + PORT + " - profile.html?publicId=chwwRwsA pour tester");
