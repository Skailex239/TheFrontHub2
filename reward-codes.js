/**
 * reward-codes.js — Système de codes de récompense pour TheFrontStats.
 *
 * Utilise Firestore (même Firebase que le reste du site) pour stocker :
 *   - reward-codes/{code}     : { skinId, maxUses, uses, note, createdAt, expiresAt }
 *   - user-skins/{pid_skinId} : { publicId, skinId, codeUsed, redeemedAt }
 *   - users/{uid}             : doc existant, on ajoute activeSkinId
 *
 * Le rachat est atomique via runTransaction (incrément uses + créer user-skin).
 *
 * ⚠️ SÉCURITÉ (audit 2026) :
 *   - L'ancien ADMIN_TOKEN codé en dur dans le JS public a été SUPPRIMÉ :
 *     visible par tout visiteur, il permettait à n'importe qui de créer des
 *     codes. La création de codes est désormais réservée au custom claim
 *     Firebase `admin == true` (voir firestore.rules) ou au SDK Admin.
 *   - Les règles Firestore durcies (firestore.rules) font respecter :
 *     création de user-skins uniquement pour SON publicId lié, update limité
 *     au champ `active`, écriture de reward-codes réservée aux admins.
 *   - La création programmatique de codes passe par scripts/generate-code.js
 *     (SDK Admin + compte de service, jamais exposé au navigateur).
 */

import {
  db, doc, getDoc, setDoc, getDocs, collection, query, where,
  runTransaction, increment,
} from "./auth.js";
import { getSkin, getUnlockableSkins, DEFAULT_SKIN_ID, normalizeCode, VALID_SKIN_IDS } from "./skins.js";

/* ════════════════════════════════════════════════════════════════
   Cache local de l'active skin (évite les allers-retours Firestore)
   ════════════════════════════════════════════════════════════════ */

const activeSkinCache = new Map(); // publicId → skinId
const activeSkinPromises = new Map(); // publicId → Promise<skinId>
const CACHE_TTL = 5 * 60 * 1000; // 5 min
const cacheTimestamps = new Map();

/**
 * Retourne le skinId actif pour un joueur (ou null = défaut).
 * Met en cache le résultat 5 min.
 */
export async function fetchActiveSkinId(publicId) {
  if (!publicId) return null;

  const cached = activeSkinCache.get(publicId);
  const cachedAt = cacheTimestamps.get(publicId);
  if (cached !== undefined && cachedAt && Date.now() - cachedAt < CACHE_TTL) {
    return cached;
  }

  const existing = activeSkinPromises.get(publicId);
  if (existing) return existing;

  const p = (async () => {
    try {
      // Query user-skins where publicId == pid AND active == true
      // Since we store active skin in users/{uid}, we need the uid.
      // Simpler: query user-skins collection for this publicId, then
      // check which one has active=true.
      const q = query(collection(db, "user-skins"), where("publicId", "==", publicId), where("active", "==", true));
      const snap = await getDocs(q);
      if (!snap.empty) {
        const skinId = snap.docs[0].data().skinId;
        activeSkinCache.set(publicId, skinId);
        cacheTimestamps.set(publicId, Date.now());
        return skinId;
      }
      activeSkinCache.set(publicId, null);
      cacheTimestamps.set(publicId, Date.now());
      return null;
    } catch (e) {
      console.warn("[reward-codes] fetchActiveSkinId failed:", e);
      return null;
    } finally {
      activeSkinPromises.delete(publicId);
    }
  })();

  activeSkinPromises.set(publicId, p);
  return p;
}

/** Lecture synchrone du cache. */
export function getCachedActiveSkinId(publicId) {
  const cached = activeSkinCache.get(publicId);
  const cachedAt = cacheTimestamps.get(publicId);
  if (cached !== undefined && cachedAt && Date.now() - cachedAt < CACHE_TTL) {
    return cached;
  }
  return null;
}

/** Invalide le cache (après rachat/activation). */
export function invalidateActiveSkinCache(publicId) {
  activeSkinCache.delete(publicId);
  cacheTimestamps.delete(publicId);
}

/* ════════════════════════════════════════════════════════════════
   Récupérer les skins possédés par un joueur
   ════════════════════════════════════════════════════════════════ */

/**
 * Retourne { ownedSkins: [{skinId, codeUsed, redeemedAt, active}], activeSkinId }
 * pour un joueur donné.
 */
export async function fetchOwnedSkins(publicId) {
  if (!publicId) return { ownedSkins: [], activeSkinId: null };
  try {
    const q = query(collection(db, "user-skins"), where("publicId", "==", publicId));
    const snap = await getDocs(q);
    const owned = [];
    let activeSkinId = null;
    snap.forEach((d) => {
      const data = d.data();
      owned.push({
        skinId: data.skinId,
        codeUsed: data.codeUsed || "",
        redeemedAt: data.redeemedAt || "",
        active: !!data.active,
      });
      if (data.active) activeSkinId = data.skinId;
    });
    return { ownedSkins: owned, activeSkinId };
  } catch (e) {
    console.warn("[reward-codes] fetchOwnedSkins failed:", e);
    return { ownedSkins: [], activeSkinId: null };
  }
}

/* ════════════════════════════════════════════════════════════════
   Rachat de code (redeem)
   ════════════════════════════════════════════════════════════════ */

/**
 * Valide un code de récompense pour un joueur.
 *
 * Étapes (atomiques via transaction) :
 *   1. Lire reward-codes/{code}
 *   2. Vérifier : existe, non expiré, uses < maxUses
 *   3. Lire user-skins/{pid_skinId} — si existe, déjà possédé
 *   4. Sinon : incrémenter uses + créer user-skins/{pid_skinId}
 *
 * @returns { ok, alreadyOwned?, skinId, skinName, message }
 */
export async function redeemCode(rawCode, publicId) {
  const code = normalizeCode(rawCode);
  if (!code) throw new Error("Code manquant");
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) throw new Error("Public ID invalide");

  const codeRef = doc(db, "reward-codes", code);
  const skinDocId = `${publicId}_${getSkinFromCode(code) || "x"}`;

  // 1. Read the code first (outside transaction — Firestore limitation)
  const codeSnap = await getDoc(codeRef);
  if (!codeSnap.exists()) {
    throw new Error(`Code "${code}" introuvable`);
  }
  const codeData = codeSnap.data();
  const skinId = codeData.skinId;

  if (!VALID_SKIN_IDS.includes(skinId) || skinId === DEFAULT_SKIN_ID) {
    throw new Error("Code invalide (skin inconnu)");
  }

  // Check expiry
  if (codeData.expiresAt) {
    const exp = codeData.expiresAt.toDate ? codeData.expiresAt.toDate() : new Date(codeData.expiresAt);
    if (exp.getTime() < Date.now()) throw new Error("Ce code a expiré");
  }

  // Check max uses
  if (codeData.maxUses != null && (codeData.uses || 0) >= codeData.maxUses) {
    throw new Error("Ce code a atteint sa limite d'utilisations");
  }

  // 2. Check if already owned
  const userSkinRef = doc(db, "user-skins", `${publicId}_${skinId}`);
  const existingSnap = await getDoc(userSkinRef);
  if (existingSnap.exists()) {
    const skin = getSkin(skinId);
    return {
      ok: true,
      alreadyOwned: true,
      skinId,
      skinName: skin.name,
      message: `Tu possèdes déjà le skin "${skin.name}"`,
    };
  }

  // 3. Atomic: increment uses + create user-skin
  await runTransaction(db, async (tx) => {
    const codeDoc = await tx.get(codeRef);
    if (!codeDoc.exists()) throw new Error("Code introuvable (transaction)");
    const d = codeDoc.data();
    if (d.maxUses != null && (d.uses || 0) >= d.maxUses) {
      throw new Error("Ce code a atteint sa limite d'utilisations");
    }
    tx.update(codeRef, { uses: increment(1) });
    tx.set(userSkinRef, {
      publicId,
      skinId,
      codeUsed: code,
      redeemedAt: new Date().toISOString(),
      active: false,
    });
  });

  const skin = getSkin(skinId);
  invalidateActiveSkinCache(publicId);
  return {
    ok: true,
    alreadyOwned: false,
    skinId,
    skinName: skin.name,
    rarity: skin.rarity,
    message: `Skin "${skin.name}" débloqué !`,
  };
}

/** Helper: read skinId from a code without full redeem (for doc ID). */
async function getSkinFromCode(code) {
  try {
    const snap = await getDoc(doc(db, "reward-codes", code));
    if (snap.exists()) return snap.data().skinId;
  } catch { /* ignore */ }
  return null;
}

/* ════════════════════════════════════════════════════════════════
   Activation de skin
   ════════════════════════════════════════════════════════════════ */

/**
 * Active un skin pour un joueur (le met comme skin affiché).
 * Désactive l'ancien skin actif (si différent).
 */
export async function activateSkin(publicId, skinId) {
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) throw new Error("Public ID invalide");
  if (!VALID_SKIN_IDS.includes(skinId)) throw new Error("skinId invalide");

  // "default" = désactiver tous les skins
  // D'abord : désactiver l'ancien skin actif
  const q = query(collection(db, "user-skins"), where("publicId", "==", publicId), where("active", "==", true));
  const snap = await getDocs(q);

  if (skinId === DEFAULT_SKIN_ID) {
    // Just deactivate everything
    const updates = snap.docs.map((d) => setDoc(d.ref, { active: false }, { merge: true }));
    await Promise.all(updates);
    invalidateActiveSkinCache(publicId);
    return { ok: true, activeSkinId: DEFAULT_SKIN_ID };
  }

  // Check ownership
  const targetRef = doc(db, "user-skins", `${publicId}_${skinId}`);
  const targetSnap = await getDoc(targetRef);
  if (!targetSnap.exists()) {
    throw new Error("Tu ne possèdes pas ce skin");
  }

  // Deactivate old + activate new
  const batch = [
    ...snap.docs.map((d) => setDoc(d.ref, { active: false }, { merge: true })),
    setDoc(targetRef, { active: true }, { merge: true }),
  ];
  await Promise.all(batch);
  invalidateActiveSkinCache(publicId);
  return { ok: true, activeSkinId: skinId };
}

/* ════════════════════════════════════════════════════════════════
   Helper pour appliquer un skin à un élément DOM
   ════════════════════════════════════════════════════════════════ */

/**
 * Applique la classe CSS du skin actif d'un joueur à un élément <span>.
 * Si aucun skin actif, applique skin-default.
 *
 * @param {HTMLElement} el - l'élément à styliser
 * @param {string} publicId - le publicId du joueur
 * @param {boolean} async - si true, fetch Firestore en arrière-plan
 */
export function applySkinToElement(el, publicId, async = true) {
  if (!el || !publicId) return;

  // Sync: apply cached skin immediately
  const cached = getCachedActiveSkinId(publicId);
  const skin = getSkin(cached);
  // Remove old skin classes
  el.className = el.className.replace(/\bskin-\S+/g, "").trim();
  el.classList.add(skin.cssClass);

  if (async) {
    fetchActiveSkinId(publicId).then((skinId) => {
      const s = getSkin(skinId);
      const currentCached = getCachedActiveSkinId(publicId);
      if (currentCached === skinId) return; // déjà appliqué
      el.className = el.className.replace(/\bskin-\S+/g, "").trim();
      el.classList.add(s.cssClass);
    });
  }
}

/**
 * Crée un <span> avec le skin appliqué pour un pseudo.
 * @returns {HTMLElement} span element
 */
export function createSkinnedName(publicId, username) {
  const span = document.createElement("span");
  span.textContent = username;
  applySkinToElement(span, publicId, true);
  return span;
}

/* ════════════════════════════════════════════════════════════════
   Admin : créer un code (réservé au custom claim `admin`)
   ════════════════════════════════════════════════════════════════ */

/**
 * Crée un code de récompense (admin only).
 *
 * ⚠️ SÉCURITÉ : plus AUCUN token magique côté client. L'appel réussit
 * uniquement si le compte connecté porte le custom claim `admin == true`
 * (posé via le SDK Admin Firebase). Sinon Firestore refuse l'écriture
 * (voir firestore.rules → reward-codes : create/update si isAdmin()).
 *
 * Pour créer des codes depuis ton terminal, utilise plutôt
 * scripts/generate-code.js (SDK Admin + compte de service).
 */
export async function createRewardCode({ code, skinId, maxUses, note, createdBy, expiresAt }) {
  const normalized = normalizeCode(code);
  if (normalized.length < 3) throw new Error("Code trop court");
  if (!VALID_SKIN_IDS.includes(skinId)) throw new Error("skinId invalide");
  if (skinId === DEFAULT_SKIN_ID) throw new Error("Impossible de créer un code pour le skin par défaut");

  const data = {
    skinId,
    maxUses: maxUses == null ? null : Math.max(1, parseInt(maxUses, 10) || 1),
    uses: 0,
    note: note || null,
    createdBy: createdBy || null,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
  };

  const ref = doc(db, "reward-codes", normalized);
  const existing = await getDoc(ref);
  if (existing.exists()) throw new Error(`Code "${normalized}" existe déjà`);

  // Refusé par les règles Firestore si le compte n'est pas admin.
  await setDoc(ref, data);
  return { ok: true, code: normalized, skinId };
}

/**
 * Liste tous les codes (admin only — la lecture reste publique dans les
 * règles pour permettre la validation du rachat ; seuls les admins ont
 * besoin de cette vue d'ensemble). Ne retourne plus aucun champ sensible.
 */
export async function listAllCodes() {
  const snap = await getDocs(collection(db, "reward-codes"));
  const codes = [];
  snap.forEach((d) => {
    const data = d.data();
    delete data.adminToken; // champ obsolète (anciennes données), jamais renvoyé
    codes.push({ id: d.id, ...data });
  });
  return codes;
}

// Export pour compatibilité
export { getSkin, getUnlockableSkins, DEFAULT_SKIN_ID };
