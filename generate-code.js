/**
 * generate-code.js — Admin script pour générer des codes récompense TheFrontHub.
 *
 * ⚠️ SÉCURITÉ (audit 2026) : ce script utilise désormais le SDK ADMIN Firebase
 * (compte de service), PAS le SDK client. L'ancienne version écrivait sans
 * authentification, ce qui imposait des règles Firestore ouvertes en écriture
 * — n'importe qui pouvait alors créer/écraser des codes via l'API REST.
 *
 * Prérequis (une seule fois) :
 *   1. Console Firebase → Paramètres du projet → Comptes de service →
 *      "Générer une nouvelle clé privée" → télécharge le JSON.
 *   2. Pose la clé LOCALEMENT (jamais dans le repo !), par ex. :
 *        mkdir -p ~/.tfs && cp ~/Downloads/xxx-firebase-adminsdk.json ~/.tfs/service-account.json
 *        chmod 600 ~/.tfs/service-account.json
 *   3. Installe la dépendance :  npm install --no-save firebase-admin
 *
 * Usage :
 *   GOOGLE_APPLICATION_CREDENTIALS=~/.tfs/service-account.json \
 *     node generate-code.js [count] [skinId] [maxUses]
 *
 *   node generate-code.js              → 1 code pour le skin "vip"     (usages illimités)
 *   node generate-code.js 5            → 5 codes "vip"
 *   node generate-code.js 3 gold 100   → 3 codes "gold", 100 usages max chacun
 *
 * Les codes sont ajoutés dans Firestore (collection reward-codes) avec le
 * schéma attendu par reward-codes.js : { skinId, maxUses, uses, note, ... }.
 * Doc id = le code lui-même (ex: OR-A7K3QW), conforme à redeemCode().
 */

import { readFileSync, existsSync } from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { firebaseConfig } from "./shared/firebase-config.js";

// ── Compte de service (jamais committé) ──
const KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || (process.env.HOME + "/.tfs/service-account.json");
if (!existsSync(KEY_PATH)) {
  console.error("❌ Clé de compte de service introuvable : " + KEY_PATH);
  console.error("   Console Firebase → Comptes de service → Générer une clé privée,");
  console.error("   puis : export GOOGLE_APPLICATION_CREDENTIALS=/chemin/vers/cle.json");
  process.exit(1);
}

// Liste des skins valides (doit rester synchronisée avec skins.js)
const VALID_SKINS = ["vip", "gold"];
// Récupérée dynamiquement si possible, fallback sur la liste ci-dessus
let validSkins = VALID_SKINS;
try {
  const { VALID_SKIN_IDS } = await import("./skins.js");
  if (Array.isArray(VALID_SKIN_IDS) && VALID_SKIN_IDS.length) validSkins = VALID_SKIN_IDS;
} catch { /* skins.js utilise des imports navigateur — fallback */ }

// ── Args ──
const count = Math.max(1, parseInt(process.argv[2] || "1", 10) || 1);
const skinId = process.argv[3] || validSkins.find((s) => s !== "default") || "vip";
const maxUses = process.argv[4] ? Math.max(1, parseInt(process.argv[4], 10) || 1) : null;

if (!validSkins.includes(skinId) || skinId === "default") {
  console.error(`❌ skinId invalide : ${skinId}. Skins disponibles : ${validSkins.join(", ")}`);
  process.exit(1);
}

// ── Init SDK Admin ──
const serviceAccount = JSON.parse(readFileSync(KEY_PATH, "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Pas de I,O,0,1 pour éviter la confusion
  let code = "OR-"; // OR = OpenFront Reward
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function main() {
  console.log(`\n🎁 Génération de ${count} code(s) "${skinId}"${maxUses ? ` (${maxUses} usages max)` : " (usages illimités)"}...\n`);

  const created = [];
  for (let i = 0; i < count; i++) {
    const code = generateCode();
    try {
      await db.collection("reward-codes").doc(code).set({
        skinId,
        maxUses,
        uses: 0,
        note: `généré par generate-code.js le ${new Date().toISOString()}`,
        createdBy: "generate-code.js",
        createdAt: new Date().toISOString(),
        expiresAt: null,
      });
      console.log(`  ✅ ${code} (${skinId})`);
      created.push(code);
    } catch (e) {
      console.error(`  ❌ Erreur pour ${code} : ${e.message}`);
    }
  }

  console.log(`\n✨ ${created.length}/${count} code(s) généré(s).`);

  // Afficher les codes existants encore utilisables
  const snap = await db.collection("reward-codes").get();
  const usable = [];
  snap.forEach((d) => {
    const data = d.data();
    const expired = data.expiresAt && new Date(data.expiresAt).getTime() < Date.now();
    const exhausted = data.maxUses != null && (data.uses || 0) >= data.maxUses;
    if (!expired && !exhausted) usable.push(d.id);
  });
  console.log(`📋 Codes encore utilisables : ${usable.length}`);
  usable.slice(0, 30).forEach((c) => console.log(`   ${c}`));
  if (usable.length > 30) console.log(`   … et ${usable.length - 30} autres`);
  console.log();

  process.exit(0);
}

main().catch((e) => {
  console.error("Erreur:", e);
  process.exit(1);
});
