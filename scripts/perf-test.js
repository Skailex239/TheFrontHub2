/**
 * scripts/perf-test.js — Performance benchmark for TheFrontHub
 *
 * Measures:
 *   1. File sizes (raw + gzip) before vs after
 *   2. HTTP load times (5 runs averaged, on localhost)
 *   3. Total page weight (HTML + JS + CSS, without Firebase/Google Fonts)
 */

import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import zlib from "zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const files = [
  ["app.js",                "dist/app.min.js"],
  ["profile.js",            "dist/profile.min.js"],
  ["dashboard.js",          "dist/dashboard.min.js"],
  ["lobby.js",              "dist/lobby.min.js"],
  ["atlas.js",              "dist/atlas.min.js"],
  ["tournois.js",           "dist/tournois.min.js"],
  ["runs.js",               "dist/runs.min.js"],
  ["i18n.js",               "dist/i18n.min.js"],
  ["toast.js",              "dist/toast.min.js"],
  ["animations.js",         "dist/animations.min.js"],
  ["lenis.js",              "dist/lenis.min.js"],
  ["icons.js",              "dist/icons.min.js"],
  ["auth.js",               "dist/auth.min.js"],
  ["tournois-icons.js",     "dist/tournois-icons.min.js"],
];

function fetchLocal(url) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    http.get(url, { family: 4 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          body,
          size: body.length,
          ms: performance.now() - start,
          headers: res.headers,
        });
      });
    }).on("error", reject);
  });
}

function gzipSize(buf) {
  return zlib.gzipSync(buf).length;
}

async function main() {
  console.log("\n" + "═".repeat(80));
  console.log("  📊 PERF BENCHMARK — TheFrontHub (Sprint 1)");
  console.log("═".repeat(80));

  // ── 1. File sizes ──
  console.log("\n┌─ Tailles des fichiers (raw sur disque + gzip) ─────────────────────────────┐");
  console.log("│ Fichier                     │ Avant    │ Après    │ Δ      │ Gzip Av → Après │");
  console.log("├──────────────────────────────────────────────────────────────────────────────┤");
  let totalBefore = 0, totalAfter = 0, totalGzipBefore = 0, totalGzipAfter = 0;
  for (const [orig, min] of files) {
    const origPath = path.join(ROOT, orig);
    const minPath = path.join(ROOT, min);
    if (!fs.existsSync(origPath) || !fs.existsSync(minPath)) continue;
    const origBuf = fs.readFileSync(origPath);
    const minBuf = fs.readFileSync(minPath);
    const before = origBuf.length;
    const after = minBuf.length;
    const beforeGz = gzipSize(origBuf);
    const afterGz = gzipSize(minBuf);
    totalBefore += before;
    totalAfter += after;
    totalGzipBefore += beforeGz;
    totalGzipAfter += afterGz;
    const delta = ((1 - after / before) * 100).toFixed(1);
    const gzInfo = `${(beforeGz/1024).toFixed(1)}K → ${(afterGz/1024).toFixed(1)}K`;
    console.log(`│ ${orig.padEnd(28)} │ ${String(before).padStart(7)} B │ ${String(after).padStart(7)} B │ ${delta.padStart(5)}% │ ${gzInfo.padStart(15)} │`);
  }
  console.log("├──────────────────────────────────────────────────────────────────────────────┤");
  const totalDelta = ((1 - totalAfter / totalBefore) * 100).toFixed(1);
  console.log(`│ ${"TOTAL".padEnd(28)} │ ${String(totalBefore).padStart(7)} B │ ${String(totalAfter).padStart(7)} B │ ${totalDelta.padStart(5)}% │ ${`${(totalGzipBefore/1024).toFixed(1)}K → ${(totalGzipAfter/1024).toFixed(1)}K`.padStart(15)} │`);
  console.log("└──────────────────────────────────────────────────────────────────────────────┘");

  // ── 2. HTTP load times ──
  console.log("\n┌─ Temps de chargement HTTP (localhost, 5 runs moyennés) ──────────────────────┐");
  console.log("│ URL                            │ Taille    │ Cache-Control               │ Temps moyen              │");
  console.log("├────────────────────────────────────────────────────────────────────────────────────────────┤");

  const endpoints = [
    ["/dist/app.min.js",          "app.min.js (minifié)"],
    ["/dist/profile.min.js",       "profile.min.js (minifié)"],
    ["/dist/dashboard.min.js",     "dashboard.min.js (minifié)"],
    ["/dist/lobby.min.js",         "lobby.min.js (minifié)"],
    ["/dist/atlas.min.js",         "atlas.min.js (minifié)"],
    ["/dist/tournois.min.js",      "tournois.min.js (minifié)"],
    ["/dist/i18n.min.js",          "i18n.min.js (minifié)"],
    ["/dist/animations.min.js",    "animations.min.js (minifié)"],
    ["/dist/auth.min.js",          "auth.min.js (bundled + minifié)"],
    ["/sw.js",                     "sw.js (SWR v8)"],
    ["/",                          "index.html"],
    ["/runs_public.json.gz",       "runs_public.json.gz (data)"],
    ["/ranked.json.gz",            "ranked.json.gz (data)"],
  ];

  for (const [url, label] of endpoints) {
    const times = [];
    let size = 0, cacheHeader = "";
    for (let i = 0; i < 5; i++) {
      const r = await fetchLocal(`http://127.0.0.1:3000${url}`);
      times.push(r.ms);
      size = r.size;
      cacheHeader = r.headers["cache-control"] || "none";
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const cacheDisplay = cacheHeader.length > 25 ? cacheHeader.slice(0, 22) + "..." : cacheHeader.padEnd(25);
    console.log(`│ ${label.padEnd(30)} │ ${String(size).padStart(8)} B │ ${cacheDisplay} │ ${avg.toFixed(2).padStart(5)}ms (min ${min.toFixed(2)}, max ${max.toFixed(2)}) │`);
  }
  console.log("└────────────────────────────────────────────────────────────────────────────────────────────┘");

  // ── 3. Total page weight (per page) ──
  console.log("\n┌─ Poids total de chaque page (JS local chargé, sans Firebase/fonts Google) ───┐");
  console.log("├──────────────────────────────────────────────────────────────────────────────┤");

  const pageAssets = {
    "index.html (Speedruns)": ["dist/app.min.js", "dist/i18n.min.js", "dist/toast.min.js", "dist/animations.min.js", "dist/lenis.min.js", "dist/icons.min.js"],
    "profile.html (Profil)": ["dist/profile.min.js", "dist/i18n.min.js", "dist/toast.min.js", "dist/animations.min.js", "dist/lenis.min.js", "dist/icons.min.js"],
    "dashboard.html": ["dist/dashboard.min.js", "dist/toast.min.js", "dist/animations.min.js", "dist/lenis.min.js", "dist/icons.min.js", "dist/auth.min.js"],
    "lobby.html": ["dist/lobby.min.js", "dist/toast.min.js", "dist/animations.min.js", "dist/lenis.min.js", "dist/icons.min.js", "dist/auth.min.js"],
    "atlas.html": ["dist/atlas.min.js", "dist/toast.min.js", "dist/animations.min.js", "dist/lenis.min.js", "dist/icons.min.js"],
    "tournois.html": ["dist/tournois.min.js", "dist/tournois-icons.min.js", "dist/animations.min.js", "dist/lenis.min.js", "dist/icons.min.js"],
    "runs.html": ["dist/runs.min.js", "dist/toast.min.js", "dist/animations.min.js", "dist/lenis.min.js"],
  };

  const originalPageAssets = {
    "index.html (Speedruns)": ["app.js", "i18n.js", "toast.js", "animations.js", "lenis.js", "icons.js"],
    "profile.html (Profil)": ["profile.js", "i18n.js", "toast.js", "animations.js", "lenis.js", "icons.js"],
    "dashboard.html": ["dashboard.js", "toast.js", "animations.js", "lenis.js", "icons.js", "auth.js"],
    "lobby.html": ["lobby.js", "toast.js", "animations.js", "lenis.js", "icons.js", "auth.js"],
    "atlas.html": ["atlas.js", "toast.js", "animations.js", "lenis.js", "icons.js"],
    "tournois.html": ["tournois.js", "tournois-icons.js", "animations.js", "lenis.js", "icons.js"],
    "runs.html": ["runs.js", "toast.js", "animations.js", "lenis.js"],
  };

  for (const [page, assets] of Object.entries(pageAssets)) {
    const origAssets = originalPageAssets[page];
    let beforeWeight = 0, beforeGzWeight = 0;
    let afterWeight = 0, afterGzWeight = 0;
    for (const f of origAssets) {
      const buf = fs.readFileSync(path.join(ROOT, f));
      beforeWeight += buf.length;
      beforeGzWeight += gzipSize(buf);
    }
    for (const f of assets) {
      const buf = fs.readFileSync(path.join(ROOT, f));
      afterWeight += buf.length;
      afterGzWeight += gzipSize(buf);
    }
    const weightDelta = ((1 - afterWeight / beforeWeight) * 100).toFixed(1);
    const gzDelta = ((1 - afterGzWeight / beforeGzWeight) * 100).toFixed(1);
    console.log(`│ ${page.padEnd(28)} avant: ${(beforeWeight/1024).toFixed(1)}K (gzip ${(beforeGzWeight/1024).toFixed(1)}K) → après: ${(afterWeight/1024).toFixed(1)}K (gzip ${(afterGzWeight/1024).toFixed(1)}K)  -${weightDelta}%/-${gzDelta}%`);
  }
  console.log("└──────────────────────────────────────────────────────────────────────────────┘");

  console.log("\n✅ Test terminé.\n");
}

main().catch(e => {
  console.error("[perf-test] Error:", e);
  process.exit(1);
});
