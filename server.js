import http from "http";
import { parse as parseUrl } from "url";
import fs from "fs";
import path from "path";
import { API_BASE, openFrontFetch, warnIfNoExemption } from "./openfront-api.js";
import { MAP_ALIASES, normalizeMap } from "./shared/maps.js";
import { extractSpeedrun, TIME_OFFSET_SECS } from "./shared/extract-speedrun.js";

warnIfNoExemption();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const FETCH_TIMEOUT_MS = 10_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await openFrontFetch(url, { signal: controller.signal });

    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {}

      console.error(
        `[upstream] fetch failed: HTTP ${res.status} url=${url} body=${text.slice(0, 500)}`
      );

      const err = new Error(`HTTP ${res.status}`);
      err.upstreamStatus = res.status;
      err.upstreamUrl = url;
      err.upstreamBody = text;
      throw err;
    }

    return await res.json();
  } catch (e) {
    // timeout / abort
    if (e?.name === "AbortError") {
      const err = new Error(`Upstream timeout after ${FETCH_TIMEOUT_MS}ms`);
      err.upstreamStatus = 504;
      err.upstreamUrl = url;
      throw err;
    }

    // keep any upstream* fields if present
    if (e?.upstreamUrl == null) e.upstreamUrl = url;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// MAP_ALIASES, normalizeMap, extractSpeedrun, TIME_OFFSET_SECS are now imported from shared/

function formatTime(durationSeconds) {
  const m = Math.floor(durationSeconds / 60);
  const s = String(durationSeconds % 60).padStart(2, "0");
  return `${m}m${s}s`;
}

async function getGamesInRange(startIso, endIso) {
  // Eviter tout double-encoding (source probable du HTTP 400)
  const qs = new URLSearchParams({ start: startIso, end: endIso });
  const url = `${API_BASE}/public/games?${qs.toString()}`;
  const data = await fetchWithTimeout(url);
  const games = Array.isArray(data) ? data : (data.games || []);
  return games.filter(g =>
    g.type === "Public" &&
    (g.mode === "Free For All" || g.mode === "FFA") &&
    (g.numPlayers == null || g.numPlayers >= 10)
  );
}

async function getTopRuns({ limit = 20, windowDays = 30 }) {
  const nowMs = Date.now();
  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  const startDate = new Date(windowStartMs);
  const endDate = new Date(nowMs);

  const segments = [];
  {
    // Chunking strict sur jours UTC (évite les erreurs de “24h”/arrondis)
    // On force segStart à 00:00:00Z puis segEnd à +1 jour (toujours à 00:00Z)
    const MAX_DAYS = 370; // garde-fou (un an max) pour éviter des appels trop lourds

    let cursor = new Date(startDate.toISOString());
    let endIso = endDate.toISOString();

    // aligner cursor sur 00:00 UTC
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 0, 0, 0, 0));

    let i = 0;
    while (cursor < endDate && i < MAX_DAYS) {
      const segStart = cursor.toISOString();
      const next = new Date(cursor.getTime());
      next.setUTCDate(next.getUTCDate() + 1);
      const segEndDate = (next > endDate ? endDate : next);
      const segEnd = new Date(segEndDate.getTime() - 1).toISOString(); // end strictement exclu (<24h)

      segments.push([segStart, segEnd]);

      cursor = next;
      i++;
    }
  }

  const games = [];
  const seenGameIds = new Set();

  let gamesFetchError = null;

  for (const [segStart, segEnd] of segments) {
    try {
      const segGames = await getGamesInRange(segStart, segEnd);
      for (const gg of segGames) {
        const id = gg?.game;
        if (!id) continue;
        if (seenGameIds.has(id)) continue;
        seenGameIds.add(id);
        games.push(gg);
      }
    } catch (e) {
      if (!gamesFetchError) {
        gamesFetchError = {
          segStart,
          segEnd,
          error: String(e?.message || e),
          errorName: e?.name,
          upstreamStatus: e?.upstreamStatus,
          upstreamUrl: e?.upstreamUrl,
          upstreamBody:
            typeof e?.upstreamBody === "string" ? e?.upstreamBody.slice(0, 2000) : undefined,
        };
      }
      // continue: on agrège ce qu'on a
    }
  }

  // Limit the number of game detail calls to keep it responsive
  const maxGameDetails = Math.min(200, Math.max(50, limit * 10));
  const picked = games.slice(0, maxGameDetails);

  const seenRunIds = new Set();
  const runs = [];

  // debug-only
  let gameFetchError = null;

  for (const g of picked) {
    const gameId = g.game;
    if (!gameId) continue;

    try {
      const raw = await fetchWithTimeout(`${API_BASE}/public/game/${gameId}`);
      const run = extractSpeedrun(raw);
      if (run && !seenRunIds.has(run.id)) {
        seenRunIds.add(run.id);
        runs.push(run);
      }
    } catch (e) {
      if (!gameFetchError) {
        gameFetchError = {
          gameId,
          error: String(e?.message || e),
          errorName: e?.name,
          upstreamStatus: e?.upstreamStatus,
          upstreamUrl: e?.upstreamUrl,
          upstreamBody:
            typeof e?.upstreamBody === "string" ? e.upstreamBody.slice(0, 2000) : undefined,
        };
      }
      // ignore individual failures; keep going
    }

    if (runs.length >= limit * 3) break;
    await sleep(120); // mild pacing
  }

  runs.sort((a, b) => a.duration_s - b.duration_s);
  return {
    runs: runs.slice(0, limit),
    debug: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      windowDays,
      segmentsCount: segments.length,
      gamesCount: games.length,
      pickedCount: picked.length,
      firstGameIds: picked.slice(0, 5).map(x => x.game).filter(Boolean),
      gamesFetchError,
      gameFetchError,
    },
  };
}

const STATIC_DIR = path.resolve(process.cwd());

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendFile(res, status, filePath, contentType) {
  try {
    const full = path.resolve(filePath);
    const data = fs.readFileSync(full);
    res.writeHead(status, {
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = parseUrl(req.url || "", true);
  const pathname = urlObj.pathname || "/";

  if (pathname === "/api/top-runs") {
    const limit = Number(urlObj.query.limit || 20);
    const windowDays = Number(urlObj.query.windowDays || 30);

    try {
      const runs = await getTopRuns({ limit, windowDays });
      sendJson(res, 200, { ok: true, runs, generatedAt: new Date().toISOString() });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: String(e?.message || e),
        errorName: e?.name,
        errorStack: typeof e?.stack === "string" ? e.stack.slice(0, 2000) : undefined,
        upstreamStatus: e?.upstreamStatus,
        upstreamUrl: e?.upstreamUrl,
        upstreamBody: typeof e?.upstreamBody === "string" ? e.upstreamBody.slice(0, 2000) : undefined,
      });
    }
    return;
  }

  // DEBUG uniquement: affiche le vrai body OpenFront sur /public/games
  if (pathname.startsWith("/api/openfront/")) {
    const subpath = pathname.slice("/api/openfront".length) || "/";
    const qs = urlObj.search || "";
    const upstreamUrl = `${API_BASE}${subpath}${qs}`;
    try {
      const data = await fetchWithTimeout(upstreamUrl);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(data));
    } catch (e) {
      sendJson(res, e?.upstreamStatus || 502, {
        ok: false,
        error: String(e?.message || e),
        upstreamUrl,
      });
    }
    return;
  }

  if (pathname === "/api/debug/upstream") {
    const startIso = urlObj.query.start;
    const endIso = urlObj.query.end;

    if (!startIso || !endIso) {
      sendJson(res, 400, { ok: false, error: "missing start/end query params" });
      return;
    }

    const qs = new URLSearchParams({ start: startIso, end: endIso });
    const upstreamUrl = `${API_BASE}/public/games?${qs.toString()}`;

    try {
      const data = await fetchWithTimeout(upstreamUrl);
      sendJson(res, 200, { ok: true, upstreamUrl, sample: Array.isArray(data) ? data.slice(0, 3) : data });
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        upstreamUrl,
        error: String(e?.message || e),
        errorName: e?.name,
        upstreamStatus: e?.upstreamStatus,
        upstreamUrl: e?.upstreamUrl,
        upstreamBody: typeof e?.upstreamBody === "string" ? e.upstreamBody.slice(0, 2000) : undefined,
        errorStack: typeof e?.stack === "string" ? e.stack.slice(0, 2000) : undefined,
      });
    }
    return;
  }

  // Serve shared modules (for browser ES module imports)
  if (pathname.startsWith("/shared/")) {
    const file = pathname.slice(1); // remove leading /
    const filePath = path.join(STATIC_DIR, file);
    if (fs.existsSync(filePath)) {
      sendFile(res, 200, filePath, "text/javascript; charset=utf-8");
      return;
    }
  }

  // Serve bundled/minified JS from /dist/ (immutable cache because versioned via ?v=)
  if (pathname.startsWith("/dist/")) {
    const file = pathname.slice(1); // remove leading /
    const filePath = path.join(STATIC_DIR, file);
    if (fs.existsSync(filePath) && filePath.endsWith(".js")) {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": data.length,
        // 1 year immutable — files are versioned via ?v=N in HTML for cache busting
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(data);
      return;
    }
  }

  // IMPORTANT: ESM imports like `import { ... } from "./auth.js"` resolve to /auth.js
  // at runtime. We need to serve the MINIFIED version (from /dist/auth.min.js) so
  // that production pages get the optimized code, not the raw source.
  // Same logic for any other entry that's imported as a bare specifier from a bundle.
  const BARE_ESM_ALIASES = {
    "/auth.js": "dist/auth.min.js",
    "/openfront-parse.js": "dist/openfront-parse.min.js", // not currently minified but reserved
  };
  if (BARE_ESM_ALIASES[pathname]) {
    const filePath = path.join(STATIC_DIR, BARE_ESM_ALIASES[pathname]);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": data.length,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(data);
      return;
    }
  }

  const staticMap = {
    // HTML pages
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/profile.html": ["profile.html", "text/html; charset=utf-8"],
    "/runs.html": ["runs.html", "text/html; charset=utf-8"],
    "/dashboard.html": ["dashboard.html", "text/html; charset=utf-8"],
    "/lobby.html": ["lobby.html", "text/html; charset=utf-8"],
    "/atlas.html": ["atlas.html", "text/html; charset=utf-8"],
    "/tournois.html": ["tournois.html", "text/html; charset=utf-8"],
    // CSS
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/auth.css": ["auth.css", "text/css; charset=utf-8"],
    "/profile.css": ["profile.css", "text/css; charset=utf-8"],
    "/dashboard.css": ["dashboard.css", "text/css; charset=utf-8"],
    "/lobby.css": ["lobby.css", "text/css; charset=utf-8"],
    "/atlas.css": ["atlas.css", "text/css; charset=utf-8"],
    "/tournois.css": ["tournois.css", "text/css; charset=utf-8"],
    "/skins.css": ["skins.css", "text/css; charset=utf-8"],
    "/animations.css": ["animations.css", "text/css; charset=utf-8"],
    "/toast.css": ["toast.css", "text/css; charset=utf-8"],
    // Shared modules (ESM imports)
    "/shared/maps.js": ["shared/maps.js", "text/javascript; charset=utf-8"],
    "/shared/extract-speedrun.js": ["shared/extract-speedrun.js", "text/javascript; charset=utf-8"],
    // JSON data
    "/maps_list.json": ["maps_list.json", "application/json; charset=utf-8"],
    "/ranked.json": ["ranked.json", "application/json; charset=utf-8"],
    "/ranked.json.gz": ["ranked.json.gz", "application/gzip"],
    "/ranked_history.json": ["ranked_history.json", "application/json; charset=utf-8"],
    "/ranked_history.json.gz": ["ranked_history.json.gz", "application/gzip"],
    "/runs_public.json": ["runs_public.json", "application/json; charset=utf-8"],
    "/runs_public.json.gz": ["runs_public.json.gz", "application/gzip"],
    "/runs_compact_public.json": ["runs_compact_public.json", "application/json; charset=utf-8"],
    "/runs_compact_public.json.gz": ["runs_compact_public.json.gz", "application/gzip"],
    "/teams_public.json": ["teams_public.json", "application/json; charset=utf-8"],
    "/teams_public.json.gz": ["teams_public.json.gz", "application/gzip"],
    "/dashboard_ranking.json": ["dashboard_ranking.json", "application/json; charset=utf-8"],
    "/dashboard_scores.json": ["dashboard_scores.json", "application/json; charset=utf-8"],
    "/dashboard_scores.json.gz": ["dashboard_scores.json.gz", "application/gzip"],
    "/checkpoint.json": ["checkpoint.json", "application/json; charset=utf-8"],
    "/checkpoint_compact.json": ["checkpoint_compact.json", "application/json; charset=utf-8"],
    // Atlas data
    "/atlas-data/maps_data.json": ["atlas-data/maps_data.json", "application/json; charset=utf-8"],
    // Tournois data
    "/data/players.json": ["data/players.json", "application/json; charset=utf-8"],
    "/data/scoring.config.json": ["data/scoring.config.json", "application/json; charset=utf-8"],
    "/data/calendar.json": ["data/calendar.json", "application/json; charset=utf-8"],
    "/data/tournaments/manifest.json": ["data/tournaments/manifest.json", "application/json; charset=utf-8"],
    // Source JS (kept for backward compat — pages now use /dist/*.min.js)
    "/runs.js": ["runs.js", "text/javascript; charset=utf-8"],
    "/profile.js": ["profile.js", "text/javascript; charset=utf-8"],
    "/openfront-client.js": ["openfront-client.js", "text/javascript; charset=utf-8"],
    "/openfront-parse.js": ["openfront-parse.js", "text/javascript; charset=utf-8"],
    "/animations.js": ["animations.js", "text/javascript; charset=utf-8"],
    "/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
    "/auth.js": ["auth.js", "text/javascript; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/toast.js": ["toast.js", "text/javascript; charset=utf-8"],
    "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  };

  // Also serve any image / data file from the atlas-data folder, with proper content-type
  if (pathname.startsWith("/atlas-data/")) {
    const filePath = path.join(STATIC_DIR, pathname.slice(1));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const ct = ext === ".webp" ? "image/webp"
              : ext === ".png" ? "image/png"
              : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
              : ext === ".svg" ? "image/svg+xml"
              : ext === ".json" ? "application/json; charset=utf-8"
              : "application/octet-stream";
      sendFile(res, 200, filePath, ct);
      return;
    }
  }

  // Also serve any image asset by extension (logos, favicons, etc.)
  // NOTE: pathname may contain %20 (URL-encoded spaces). We decode it before checking the file.
  const imgExt = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".gif"];
  const decodedPath = decodeURIComponent(pathname);
  if (imgExt.includes(path.extname(decodedPath).toLowerCase())) {
    const filePath = path.join(STATIC_DIR, decodedPath.slice(1));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const ct = ext === ".webp" ? "image/webp"
              : ext === ".png" ? "image/png"
              : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
              : ext === ".svg" ? "image/svg+xml"
              : ext === ".ico" ? "image/x-icon"
              : ext === ".gif" ? "image/gif"
              : "application/octet-stream";
      sendFile(res, 200, filePath, ct);
      return;
    }
  }

  // Serve tournament data files dynamically (data/tournaments/*.json)
  if (pathname.startsWith("/data/tournaments/")) {
    const filePath = path.join(STATIC_DIR, pathname.slice(1));
    if (fs.existsSync(filePath) && filePath.endsWith(".json")) {
      sendFile(res, 200, filePath, "application/json; charset=utf-8");
      return;
    }
  }

  if (staticMap[pathname]) {
    const [file, type] = staticMap[pathname];
    sendFile(res, 200, path.join(STATIC_DIR, file), type);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});
