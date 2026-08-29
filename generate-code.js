/**
 * generate-code.js — Génère des codes récompense TheFrontHub (SQL MySQL).
 *
 * ⚠️ Migration MySQL : les codes vivent désormais dans la table
 * `tfh_reward_codes` (o2switch). Firebase/Firestore n'est plus utilisé.
 * Ce script ne nécessite AUCUNE dépendance ni clé de service : il génère
 * des requêtes SQL INSERT prêtes à coller dans phpMyAdmin (ou via la CLI
 * MySQL d'o2switch).
 *
 * Le code est normalisé comme le fait api/skins.php (normalize_code) :
 * majuscules, caractères alphanumériques uniquement, SANS tiret.
 *
 * Usage :
 *   node generate-code.js [count] [skinId] [maxUses]
 *
 *   node generate-code.js              → 1 code pour le premier skin non-default (illimité)
 *   node generate-code.js 5            → 5 codes "lagon" (usages illimités)
 *   node generate-code.js 3 prisme 100 → 3 codes "prisme", 100 usages max chacun
 *
 * Référence des skins : skins.js (VALID_SKIN_IDS) — ex. lagon, aurora,
 * braise, dusk, prisme. Vérifie SKINS.md pour la checklist d'ajout.
 */

import { randomInt } from "crypto";

// Liste de référence (synchronisée avec skins.js / SKINS.md). Mettre à jour
// ici si un nouveau skin est ajouté dans skins.js.
const VALID_SKINS = ["lagon", "aurora", "braise", "dusk", "prisme"];

// ── Args ──
const count = Math.max(1, parseInt(process.argv[2] || "1", 10) || 1);
const skinId = (process.argv[3] || VALID_SKINS[0]).toLowerCase();
const maxUses = process.argv[4] ? Math.max(1, parseInt(process.argv[4], 10) || 1) : null;

if (!VALID_SKINS.includes(skinId) || skinId === "default") {
  console.error(`❌ skinId invalide : ${skinId}. Skins disponibles : ${VALID_SKINS.join(", ")}`);
  process.exit(1);
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Pas de I,O,0,1 pour éviter la confusion
  let code = "OR"; // préfixe OR (OpenFront Reward) — normalisé SANS tiret
  for (let i = 0; i < 6; i++) {
    code += chars[randomInt(chars.length)];
  }
  return code;
}

function sqlQuote(s) {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

console.log(`\n🎁 Génération de ${count} code(s) "${skinId}"${maxUses ? ` (${maxUses} usages max)` : " (usages illimités)"}\n`);
console.log("── Exécuter ce SQL sur la base MySQL o2switch (mask6607_thefronthub) :");
console.log("─────────────────────────────────────────────────────────────────");
const lines = [];
for (let i = 0; i < count; i++) {
  const code = generateCode();
  lines.push(
    `  (${sqlQuote(code)}, ${sqlQuote(skinId)}, ${maxUses === null ? "NULL" : maxUses}, ${sqlQuote(`généré par generate-code.js le ${new Date().toISOString()}`)}, 'generate-code.js')`
  );
  console.log(`  -- ${code}`);
}
console.log("INSERT INTO tfh_reward_codes (code, skin_id, max_uses, note, created_by) VALUES");
console.log(lines.join(",\n") + ";");
console.log("─────────────────────────────────────────────────────────────────");
console.log(`\n✨ ${count} code(s) prêt(s). Rappel : les codes sont SANS tiret en base\n   (normalize_code de api/skins.php), la saisie utilisateur accepte les tirets.\n`);
