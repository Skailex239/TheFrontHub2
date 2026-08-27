/**
 * reward-codes.js — Système de codes de récompense pour TheFrontStats.
 *
 * Depuis la migration o2switch (MySQL/PHP) :
 *   - reward-codes/{code}  → table reward_codes
 *   - user-skins/{pid}     → table user_skins
 *   - users/{uid}.activeSkinId → géré via api/rewards.php (action=activate)
 *
 * Le rachat et l'activation sont atomiques côté serveur
 * (api/rewards.php — SELECT … FOR UPDATE) : plus besoin de runTransaction.
 * L'admin est géré par la colonne is_admin en base (isolation des rôles
 * côté serveur, aucun token côté client).
 */

import {
  redeemRewardCode,
  activateRewardSkin,
  fetchActiveSkin,
  fetchOwnedRewardSkins,
  createRewardCodeRequest,
  listRewardCodes,
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
      // Lecture publique : api/rewards.php?action=active&publicId=…
      const skinId = await fetchActiveSkin(publicId);
      activeSkinCache.set(publicId, skinId);
      cacheTimestamps.set(publicId, Date.now());
      return skinId;
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
    // Lecture publique : api/rewards.php?action=owned&publicId=…
    return await fetchOwnedRewardSkins(publicId);
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
 * Toute la logique (existence, expiration, maxUses, unicité du rachat)
 * est vérifiée et appliquée ATOMIQUEMENT côté serveur
 * (api/rewards.php → transaction SQL avec verrou pessimiste).
 *
 * @returns { ok, alreadyOwned?, skinId, skinName, message }
 */
export async function redeemCode(rawCode, publicId) {
  const code = normalizeCode(rawCode);
  if (!code) throw new Error("Code manquant");
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) throw new Error("Public ID invalide");

  const result = await redeemRewardCode(code, publicId);
  const skinId = result.skinId;

  if (result.alreadyOwned) {
    const skin = getSkin(skinId);
    return {
      ok: true,
      alreadyOwned: true,
      skinId,
      skinName: skin ? skin.name : skinId,
      message: `Tu possèdes déjà le skin "${skin ? skin.name : skinId}"`,
    };
  }

  const skin = getSkin(skinId);
  invalidateActiveSkinCache(publicId);
  return {
    ok: true,
    alreadyOwned: false,
    skinId,
    skinName: skin ? skin.name : skinId,
    rarity: skin ? skin.rarity : undefined,
    message: `Skin "${skin ? skin.name : skinId}" débloqué !`,
  };
}

/* ════════════════════════════════════════════════════════════════
   Activation de skin
   ════════════════════════════════════════════════════════════════ */

/**
 * Active un skin pour un joueur (le met comme skin affiché).
 * Atomique côté serveur : désactive l'ancien + active le nouveau dans une
 * même transaction SQL. Le serveur vérifie la propriété du skin.
 */
export async function activateSkin(publicId, skinId) {
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) throw new Error("Public ID invalide");
  if (!VALID_SKIN_IDS.includes(skinId)) throw new Error("skinId invalide");

  const result = await activateRewardSkin(publicId, skinId);
  invalidateActiveSkinCache(publicId);
  return { ok: true, activeSkinId: result.activeSkinId };
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
 * ⚠️ SÉCURITÉ : aucun token côté client. Le serveur (api/rewards.php)
 * refuse la requête si le compte connecté n'a pas is_admin = 1 en base.
 * Pour créer des codes sans navigateur : voir GUIDE_MIGRATION_O2SWITCH.md
 * (page admin ou requête curl authentifiée).
 */
export async function createRewardCode({ code, skinId, maxUses, note, createdBy, expiresAt }) {
  const normalized = normalizeCode(code);
  if (normalized.length < 3) throw new Error("Code trop court");
  if (!VALID_SKIN_IDS.includes(skinId)) throw new Error("skinId invalide");
  if (skinId === DEFAULT_SKIN_ID) throw new Error("Impossible de créer un code pour le skin par défaut");

  await createRewardCodeRequest({
    code: normalized,
    skinId,
    maxUses,
    note,
    createdBy,
    expiresAt,
  });
  return { ok: true, code: normalized, skinId };
}

/**
 * Liste tous les codes (admin only — validé côté serveur).
 */
export async function listAllCodes() {
  const codes = await listRewardCodes();
  return codes.map((c) => ({ id: c.id, ...c }));
}

// Export pour compatibilité
export { getSkin, getUnlockableSkins, DEFAULT_SKIN_ID };
