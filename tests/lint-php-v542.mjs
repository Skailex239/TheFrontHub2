/**
 * Test : parse AST (php-parser) des fichiers PHP modifiés par v5.42.
 * Le sandbox n'a pas de binaire php → php-parser (même méthode que v5.40).
 * Usage : node tests/lint-php-v542.mjs
 */
import { Engine } from "php-parser";
import fs from "fs";

const files = [
  "api/games-api.php",
  "api/profile-cache.php",
];

const engine = new Engine({
  parser: { extractDoc: true, suppressErrors: false },
  ast: { withPositions: true },
});

let failed = false;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  try {
    engine.parseCode(src, f);
    console.log(`  ✔ ${f} — parse OK`);
  } catch (e) {
    failed = true;
    console.error(`  ✘ ${f} — ${e.message}`);
  }
}

// Garde-fou supplémentaire : la route profile-view doit exister et POSTer
const api = fs.readFileSync("api/games-api.php", "utf8");
const checks = [
  ["route profile-view présente", api.includes("case 'profile-view':")],
  ["POST obligatoire sur profile-view", /case 'profile-view':\s*\{[\s\S]{0,600}?'POST'/.test(api)],
  ["dédoublonnage appelé", api.includes("tfh_profile_count_visit($pdo, $pid, $visitHash, $ipHash)")],
  ["vues injectées dans le payload frais", api.includes("$payload['views'] = tfh_profile_views_get($pdo, $pid);")],
  ["vues réinjectées sur le cache fichier", /tfh_profile_cache_read\( \$pid \)|\$cached\['views'\] = tfh_profile_views_get/.test(api)],
  ["rate limit anti-spam", api.includes("rate_limit($pdo, 'pfview:' . client_ip(), 60, 3600)")],
  ["CORS POST autorisé", api.includes("Access-Control-Allow-Methods: GET, POST, OPTIONS")],
];
for (const [label, ok] of checks) {
  if (ok) console.log(`  ✔ ${label}`);
  else { failed = true; console.error(`  ✘ ${label}`); }
}

const cache = fs.readFileSync("api/profile-cache.php", "utf8");
const checksCache = [
  ["table dédoublonnage tfh_g_profile_visit_seen", cache.includes("tfh_g_profile_visit_seen")],
  ["PK (public_id, visit_hash) = dédoublonnage visite", cache.includes("PRIMARY KEY (public_id, visit_hash)")],
  ["colonne public_views ajoutée", cache.includes("public_views BIGINT UNSIGNED NOT NULL DEFAULT 0")],
  ["INSERT IGNORE (dédup)", cache.includes("INSERT IGNORE INTO tfh_g_profile_visit_seen")],
  ["garde anti-spam 10/jour", cache.includes("TFH_PROFILE_VISIT_MAX_PER_DAY = 10")],
  ["purge 7 jours", cache.includes("INTERVAL 7 DAY")],
];
for (const [label, ok] of checksCache) {
  if (ok) console.log(`  ✔ ${label}`);
  else { failed = true; console.error(`  ✘ ${label}`); }
}

console.log(failed ? "\n❌ ÉCHEC" : "\n✅ Tous les contrôles passent");
process.exit(failed ? 1 : 0);
