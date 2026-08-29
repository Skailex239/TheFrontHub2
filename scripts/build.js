/**
 * scripts/build.js — Build script for TheFrontHub (vanilla JS frontend)
 *
 * Bundles + minifies the page entry-point JS files using esbuild.
 *
 * Strategy:
 *   - Page entries (app.js, profile.js, dashboard.js, lobby.js, atlas.js, tournois.js, runs.js)
 *     get bundled into dist/<name>.min.js. Local imports (toast.js, shared/maps.js,
 *     shared/extract-speedrun.js, openfront-parse.js, openfront-client.js, icons.js,
 *     tournois-icons.js, tournois-engine.js) get inlined.
 *   - External imports:
 *       • URL imports (https://www.gstatic.com/firebasejs/...) → automatically external
 *       • ./auth.js → kept external (shared across pages, imports Firebase from CDN)
 *   - Standalone scripts (i18n.js, toast.js, animations.js, lenis.js, icons.js, auth.js)
 *     are minified in place (no bundling) because they are loaded via <script> tag.
 *
 * Output: dist/*.min.js
 *
 * Usage:
 *   node scripts/build.js          # one-shot build
 *   node scripts/build.js --watch  # watch mode
 */

import { build, context } from "esbuild";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// ── Build targets ─────────────────────────────────────────────────────────────
// bundled = bundle local imports + minify
// standalone = just minify (no bundling)
const targets = [
  // Page entry-points (bundled)
  { entry: "app.js",         out: "app.min.js",         bundled: true },
  { entry: "profile.js",     out: "profile.min.js",     bundled: true },
  { entry: "dashboard.js",   out: "dashboard.min.js",   bundled: true },
  { entry: "lobby.js",       out: "lobby.min.js",        bundled: true },
  { entry: "atlas.js",       out: "atlas.min.js",        bundled: true },
  { entry: "tournois.js",    out: "tournois.min.js",     bundled: true },
  { entry: "runs.js",        out: "runs.min.js",         bundled: false },
  // Standalone scripts (just minified)
  { entry: "i18n.js",        out: "i18n.min.js",         bundled: false },
  { entry: "toast.js",       out: "toast.min.js",        bundled: false },
  { entry: "animations.js",  out: "animations.min.js",   bundled: false },
  { entry: "lenis.js",       out: "lenis.min.js",        bundled: false },
  { entry: "icons.js",       out: "icons.min.js",        bundled: false },
  // auth.js n'a plus d'imports locaux (migration MySQL) — le bundle reste
  // inoffensif et garantit un fichier autonome minifié.
  { entry: "auth.js",        out: "auth.min.js",         bundled: true },
  { entry: "tournois-icons.js", out: "tournois-icons.min.js", bundled: false },
  // Tutorial (no imports, just standalone)
  { entry: "tutorial.js",    out: "tutorial.min.js",     bundled: false },
];

const watch = process.argv.includes("--watch");

// ════════════════════════════════════════════════════════════════════════════
// Auto-versionnement du cache (fini les bumps manuels de ?v= et CACHE_NAME)
// ──────────────────────────────────────────────────────────────────────────
// 1. Chaque référence locale `src/href="...js|css?v=N"` dans les *.html est
//    réécrite avec un hash court du contenu du fichier référencé → le
//    navigateur ne re-télécharge QUE ce qui a réellement changé.
// 2. CACHE_NAME du sw.js devient un hash du contenu des fichiers precachés
//    (STATIC_ASSETS) → le SW n'invalide son cache que si nécessaire.
// 3. CACHE_IMMUTABLE devient un hash de tous les bundles dist/*.js.
// Exécuté uniquement en mode one-shot (pas en --watch).
// ════════════════════════════════════════════════════════════════════════════

function contentHash8(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
}

function bumpHtmlVersions() {
  const htmls = fs.readdirSync(ROOT).filter(f => f.endsWith(".html"));
  let totalRefs = 0;
  for (const html of htmls) {
    const p = path.join(ROOT, html);
    const src = fs.readFileSync(p, "utf8");
    let count = 0;
    const out = src.replace(
      /((?:src|href)\s*=\s*["'])([^"'?]+\.(?:js|css))\?v=[^"']*("|')/g,
      (m, pre, file, post) => {
        const abs = path.join(ROOT, file);
        if (!fs.existsSync(abs)) return m; // fichier introuvable → on ne touche pas
        count++;
        return `${pre}${file}?v=${contentHash8(abs)}${post}`;
      }
    );
    if (count > 0) {
      totalRefs += count;
      if (out !== src) {
        fs.writeFileSync(p, out);
        console.log(`[build] 🔖 ${html} : ${count} version(s) ?v= recalculée(s)`);
      }
    }
  }
  if (totalRefs === 0) console.log("[build] 🔖 Aucune référence ?v= à mettre à jour");
}

function bumpSwCacheNames() {
  const swPath = path.join(ROOT, "sw.js");
  if (!fs.existsSync(swPath)) return;
  let src = fs.readFileSync(swPath, "utf8");
  let changed = false;

  // CACHE_NAME ← hash du contenu des fichiers precachés (STATIC_ASSETS)
  const listMatch = src.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/);
  if (listMatch) {
    const urls = [...listMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
      .filter(u => u.startsWith("/"));
    const h = crypto.createHash("sha256");
    for (const u of urls) {
      const abs = path.join(ROOT, u);
      h.update(u);
      // u = '/' (racine) ou fichier absent → empreinte "MISSING" stable
      const isFile = u !== "/" && fs.existsSync(abs) && fs.statSync(abs).isFile();
      h.update(isFile ? fs.readFileSync(abs) : Buffer.from("MISSING"));
    }
    const next = `const CACHE_NAME = 'thefronthub-${h.digest("hex").slice(0, 8)}';`;
    if (!src.includes(next)) {
      src = src.replace(/const CACHE_NAME = 'thefronthub-[^']*';/, next);
      changed = true;
    }
  }

  // CACHE_IMMUTABLE ← hash de tous les bundles dist/*.js
  if (fs.existsSync(DIST)) {
    const distFiles = fs.readdirSync(DIST).filter(f => f.endsWith(".js")).sort();
    const h2 = crypto.createHash("sha256");
    for (const f of distFiles) h2.update(fs.readFileSync(path.join(DIST, f)));
    const next = `const CACHE_IMMUTABLE = 'thefronthub-imm-${h2.digest("hex").slice(0, 8)}';`;
    if (!src.includes(next)) {
      src = src.replace(/const CACHE_IMMUTABLE = 'thefronthub-[^']*';/, next);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(swPath, src);
    console.log("[build] 🔖 sw.js : CACHE_NAME / CACHE_IMMUTABLE recalculés (hash contenu)");
  } else {
    console.log("[build] 🔖 sw.js : caches déjà à jour");
  }
}

async function run() {
  const beforeMs = Date.now();

  const entries = targets.map(t => {
    const opts = {
      entryPoints: [path.join(ROOT, t.entry)],
      outfile: path.join(DIST, t.out),
      minify: true,
      // Keep identifiers readable for debugging + avoid tree-shaking bugs.
      // minifyIdentifiers=false keeps original variable names (e.g. MAP_NORMALIZATION)
      // so cross-module references can't be accidentally dropped.
      minifyIdentifiers: false,
      minifySyntax: true,
      minifyWhitespace: true,
      target: "es2020",
      format: "esm",
      sourcemap: false,
      legalComments: "none",
      logLevel: "warning",
      // Tree-shaking can sometimes drop exports that ARE used (false negative).
      // Disable it to be safe — bundle size impact is minimal (<5%).
      treeShaking: false,
    };
    if (t.bundled) {
      opts.bundle = true;
      // Inline everything including auth.js (small, only 3.5KB minified).
      // URL imports (https://www.gstatic.com/firebasejs/...) are automatically
      // kept external by esbuild since they're not relative paths.
      opts.external = [];
    } else {
      opts.bundle = false;
    }
    return opts;
  });

  if (watch) {
    for (const e of entries) {
      const c = await context(e);
      await c.watch();
    }
    console.log("[build] 👀 Watching for changes... (Ctrl+C to stop)");
  } else {
    await Promise.all(entries.map(e => build(e)));

    // ── Fix Lenis : dist/lenis.min.js est chargé en <script> CLASSIQUE
    // (sans type="module") sur toutes les pages, mais esbuild (format: esm)
    // convertit l'UMD en ESM : « export default J(); » → SyntaxError
    // « Unexpected token 'export' » + le wrapper CJS détourne l'UMD vers
    // module.exports sans jamais poser globalThis.Lenis.
    // Correctif : on remplace l'export par une assignation globale —
    // J() exécute l'usine et retourne la classe Lenis.
    const lenisOut = path.join(DIST, "lenis.min.js");
    if (fs.existsSync(lenisOut)) {
      let src = fs.readFileSync(lenisOut, "utf8");
      const patched = src.replace(/;export default (\w+)\(\);?\s*$/, ";globalThis.Lenis=$1();");
      if (patched !== src) {
        fs.writeFileSync(lenisOut, patched);
        console.log("[build] 🔧 lenis.min.js : « export default J() » → « globalThis.Lenis = J() »");
      }
    }

    // ── Auto-versionnement du cache (?v= HTML + CACHE_NAME sw.js) ──
    bumpHtmlVersions();
    bumpSwCacheNames();

    const afterMs = Date.now();

    // Report sizes
    console.log("\n" + "━".repeat(78));
    console.log(" 📦 BUILD RESULTS — TheFrontHub");
    console.log("━".repeat(78));
    let totalBefore = 0, totalAfter = 0;
    for (const t of targets) {
      const src = path.join(ROOT, t.entry);
      const dst = path.join(DIST, t.out);
      if (!fs.existsSync(src)) continue;
      const beforeSize = fs.statSync(src).size;
      const afterSize = fs.existsSync(dst) ? fs.statSync(dst).size : 0;
      totalBefore += beforeSize;
      totalAfter += afterSize;
      const ratio = beforeSize > 0 ? ((1 - afterSize / beforeSize) * 100).toFixed(1) : "—";
      const bar = "█".repeat(Math.max(1, Math.round(afterSize / 2048)));
      const mode = t.bundled ? "📦" : "  ";
      console.log(
        `  ${mode} ${t.entry.padEnd(26)} ${String(beforeSize).padStart(7)} B → ${String(afterSize).padStart(7)} B  (−${ratio}%)  ${bar}`
      );
    }
    console.log("─".repeat(78));
    const totalRatio = ((1 - totalAfter / totalBefore) * 100).toFixed(1);
    console.log(`  TOTAL                       ${String(totalBefore).padStart(7)} B → ${String(totalAfter).padStart(7)} B  (−${totalRatio}%)`);
    console.log(`  ⏱  Build took ${afterMs - beforeMs} ms`);
    console.log("━".repeat(78) + "\n");
  }
}

run().catch(err => {
  console.error("[build] ❌ Fatal:", err);
  process.exit(1);
});
