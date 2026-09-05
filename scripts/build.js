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
  // ⚠️ format iife OBLIGATOIRE : lobby-wire.js contient `module.exports` (usage
  // Node dans sync-lobby-state.js) → esbuild le détecte en CommonJS. Avec le
  // format esm par défaut, la sortie finit par « export default U(); » : chargé
  // en <script> CLASSIQUE (lobby.html), le navigateur lève une SyntaxError
  // « Unexpected token 'export' » et window.OpenFrontWire n'est jamais posé →
  // plus AUCUNE carte rendue dans le lobby (frames zbin toutes ignorées).
  // iife enveloppe le module CJS et INVOQUE l'entrée immédiatement.
  { entry: "lobby-wire.js",  out: "lobby-wire.min.js",   bundled: false, format: "iife" },
  { entry: "auth-ui.js",     out: "auth-ui.min.js",      bundled: true },
  { entry: "atlas.js",       out: "atlas.min.js",        bundled: true },
  // Page Support (tickets + messagerie) — module ESM chargé en type="module"
  { entry: "support.js",     out: "support.min.js",      bundled: true },
  // Banderole « mises à jour » — script autonome (IIFE), chargé en defer
  { entry: "update-banner.js", out: "update-banner.min.js", bundled: false },
  // Chat flottant joueur ↔ équipe — script autonome (IIFE), chargé en defer
  { entry: "chat-widget.js", out: "chat-widget.min.js", bundled: false },
  { entry: "tournois.js",    out: "tournois.min.js",     bundled: true },
  { entry: "runs.js",        out: "runs.min.js",         bundled: false },
  // Standalone scripts (just minified)
  { entry: "i18n.js",        out: "i18n.min.js",         bundled: false },
  { entry: "toast.js",       out: "toast.min.js",        bundled: false },
  { entry: "animations.js",  out: "animations.min.js",   bundled: false },
  { entry: "lenis.js",       out: "lenis.min.js",        bundled: false },
  { entry: "icons.js",       out: "icons.min.js",        bundled: false },
  // auth.js imports ./shared/firebase-config.js — bundle it so the firebase config
  // gets inlined (otherwise the browser looks for /dist/shared/firebase-config.js which 404s)
  { entry: "auth.js",        out: "auth.min.js",         bundled: true },
  { entry: "tournois-icons.js", out: "tournois-icons.min.js", bundled: false },
  // Tutorial (no imports, just standalone)
  { entry: "tutorial.js",    out: "tutorial.min.js",     bundled: false },
  // Ads (no imports, loaded on every page)
  { entry: "ads.js",         out: "ads.min.js",          bundled: false },
];

const watch = process.argv.includes("--watch");

async function run() {
  const beforeMs = Date.now();

  const entries = targets.map(t => {
    const opts = {
      entryPoints: [path.join(ROOT, t.entry)],
      outfile: path.join(DIST, t.out),
      // ⚠️ NE PAS utiliser `minify: true` : avec esbuild ≥ 0.28, le raccourci
      // ÉCRASE minifyIdentifiers:false passé à côté (testé 0.28.2) → les noms
      // top-level (function setLanguage, const PAGES_SANS_PUB…) étaient
      // renommés en l/i/o… et deux scripts CLASSIques chargés sur la même
      // page entraient en collision :
      //   « Uncaught SyntaxError: Identifier 'l' has already been declared »
      // (i18n.min.js `function l` vs ads.min.js `const l`) → le script ads
      // mourait sur toutes les pages. On minifie donc via les 3 flags, en
      // laissant les identifiants d'origine (lisibles + zéro collision).
      minifyWhitespace: true,
      minifySyntax: true,
      minifyIdentifiers: false,
      target: "es2020",
      format: "esm",
      sourcemap: false,
      legalComments: "none",
      logLevel: "warning",
      // Tree-shaking can sometimes drop exports that ARE used (false negative).
      // Disable it to be safe — bundle size impact is minimal (<5%).
      treeShaking: false,
    };
    // Surcharge ponctuelle du format (voir la cible lobby-wire.js ci-dessus)
    if (t.format) opts.format = t.format;
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
