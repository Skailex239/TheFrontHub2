/**
 * reward-codes.js v2 — Système de codes de récompense pour TheFrontHub.
 * ─────────────────────────────────────────────────────────────────────
 * MIGRÉ de Firestore vers l'API MySQL (/api/skins.php) :
 *   - tfh_reward_codes  : codes { code, skinId, maxUses, uses, note, expiresAt }
 *   - tfh_user_skins    : skins possédés { publicId, skinId, codeUsed, active }
 *
 * La logique atomique (rachat, vérification de propriété, activation)
 * vit côté serveur en PHP ; ce module ne fait que consommer l'API.
 *
 * ⚠️ SÉCURITÉ : le rachat et l'activation vérifient côté serveur que le
 * publicId appartient bien au compte connecté (session cookie HttpOnly).
 * La création de codes est réservée au rôle admin (table tfh_users.role).
 */

import { getSkin, getUnlockableSkins, DEFAULT_SKIN_ID, normalizeCode, VALID_SKIN_IDS } from "./skins.js";

/* ══════════════════════════════════════════════════════════════════
   Cache local de l'active skin (évite les allers-retours API)
   ══════════════════════════════════════════════════════════════════ */

const activeSkinCache = new Map(); // publicId → skinId
const activeSkinPromises = new Map(); // publicId → Promise<skinId>
const CACHE_TTL = 5 * 60 * 1000; // 5 min
const cacheTimestamps = new Map();

async function apiGet(url) {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.code = body.error || `http_${res.status}`;
    throw err;
  }
  return body;
}

async function apiPost(payload) {
  const res = await fetch("/api/skins.php", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.code = body.error || `http_${res.status}`;
    throw err;
  }
  return body;
}

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
      const data = await apiGet(`/api/skins.php?publicId=${encodeURIComponent(publicId)}`);
      const skinId = data.activeSkinId || null;
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

/* ══════════════════════════════════════════════════════════════════
   Carte publique des skins actifs (bulk — pour les classements)
   ══════════════════════════════════════════════════════════════════ */

/**
 * Cache partagé de la carte des skins actifs (toutes les pages d'une
 * session partagent le module si importé, sinon chaque bundle a le
 * sien — dans tous les cas 1 seule requête par page et par TTL).
 * byPid : publicId → skinId (ranked, dashboard — matching exact)
 * byUser : username du compte → skinId (speedruns, matching exact)
 * byNorm : username normalisé → skinId (fallback : "[LBU] Skailex" et
 *          "VarXard.9236" se normalisent comme "Skailex"/"VarXard").
 *          Alimenté par le username du compte ET par openfrontUsername
 *          (résolu côté serveur dans l'endpoint activeMap — l'API
 *          OpenFront est CORS-restreinte, impossible depuis le client).
 */
const activeMapCache = { at: 0, byPid: null, byUser: null, byNorm: null };
const ACTIVE_MAP_TTL = 60 * 1000; // 1 min

/**
 * Normalise un pseudo pour le matching speedruns :
 * - retire le tag de clan en préfixe ("[LBU] Skailex" → "Skailex")
 * - retire le discriminateur OpenFront ("VarXard.9236" → "VarXard")
 * - minuscules
 */
export function normPlayerName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/^\[[a-z0-9_-]{2,8}\]\s*/, "")
    .replace(/\.\d{3,6}$/, "")
    .trim();
}

/**
 * Charge en UNE requête la map publique publicId/username → skin actif.
 *
 * Utilisé par les leaderboards (index, dashboard, runs) pour skinner
 * les pseudos sans faire une requête API par ligne de classement.
 * L'endpoint renvoie aussi openfrontUsername (username OpenFront actuel,
 * résolu côté serveur avec cache 5 min) qui alimente byNorm — c'est ce
 * qui fait matcher "[LBU] Skailex" (nom en partie) avec le compte
 * skailex_yt.
 * Retourne { byPid: Map, byUser: Map, byNorm: Map, byNormPid: Map }.
 */
export async function fetchActiveSkinMap(force = false) {
  const now = Date.now();
  if (!force && activeMapCache.byPid && now - activeMapCache.at < ACTIVE_MAP_TTL) {
    return activeMapCache;
  }
  try {
    const data = await apiGet("/api/skins.php?activeMap=1");
    const byPid = new Map();
    const byUser = new Map();
    const byNorm = new Map();
    const byNormPid = new Map(); // pseudo normalisé → publicId (résolution profil)
    for (const row of data.active || []) {
      if (!row.publicId || !row.skinId) continue;
      byPid.set(row.publicId, row.skinId);
      if (row.username) {
        byUser.set(row.username, row.skinId);
        byNorm.set(normPlayerName(row.username), row.skinId);
        byNormPid.set(normPlayerName(row.username), row.publicId);
      }
      if (row.openfrontUsername) {
        byNorm.set(normPlayerName(row.openfrontUsername), row.skinId);
        byNormPid.set(normPlayerName(row.openfrontUsername), row.publicId);
      }
    }
    activeMapCache.byPid = byPid;
    activeMapCache.byUser = byUser;
    activeMapCache.byNorm = byNorm;
    activeMapCache.byNormPid = byNormPid;
    activeMapCache.at = now;
    return activeMapCache;
  } catch (e) {
    console.warn("[reward-codes] fetchActiveSkinMap failed:", e);
    if (!activeMapCache.byPid) {
      activeMapCache.byPid = new Map();
      activeMapCache.byUser = new Map();
      activeMapCache.byNorm = new Map();
      activeMapCache.byNormPid = new Map();
      activeMapCache.at = now;
    }
    return activeMapCache;
  }
}

/* ══════════════════════════════════════════════════════════════════
   Récupérer les skins possédés par un joueur
   ══════════════════════════════════════════════════════════════════ */

/**
 * Retourne { ownedSkins: [{skinId, codeUsed, redeemedAt, active}], activeSkinId }
 * pour un joueur donné.
 */
export async function fetchOwnedSkins(publicId) {
  if (!publicId) return { ownedSkins: [], activeSkinId: null };
  try {
    const data = await apiGet(`/api/skins.php?publicId=${encodeURIComponent(publicId)}`);
    return {
      ownedSkins: data.ownedSkins || [],
      activeSkinId: data.activeSkinId || null,
    };
  } catch (e) {
    console.warn("[reward-codes] fetchOwnedSkins failed:", e);
    return { ownedSkins: [], activeSkinId: null };
  }
}

/* ══════════════════════════════════════════════════════════════════
   Rachat de code (redeem) — atomique côté serveur
   ══════════════════════════════════════════════════════════════════ */

/**
 * Valide un code de récompense pour un joueur.
 *
 * Le serveur vérifie en une transaction : code existant, non expiré,
 * limite d'utilisations, propriété du publicId par le compte connecté,
 * unicité du skin. Retourne { ok, alreadyOwned?, skinId, skinName, message }.
 */
export async function redeemCode(rawCode, publicId) {
  const code = normalizeCode(rawCode);
  if (!code) throw new Error("Code manquant");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(publicId)) throw new Error("Public ID invalide");

  // Pré-validation locale du format (la vraie validation est côté serveur)
  const result = await apiPost({ action: "redeem", code, publicId });

  const skin = getSkin(result.skinId);
  if (result.alreadyOwned) {
    return {
      ok: true,
      alreadyOwned: true,
      skinId: result.skinId,
      skinName: skin.name,
      message: `Tu possèdes déjà le skin "${skin.name}"`,
    };
  }

  invalidateActiveSkinCache(publicId);
  return {
    ok: true,
    alreadyOwned: false,
    skinId: result.skinId,
    skinName: skin.name,
    rarity: skin.rarity,
    message: `Skin "${skin.name}" débloqué !`,
  };
}

/* ══════════════════════════════════════════════════════════════════
   Activation de skin
   ══════════════════════════════════════════════════════════════════ */

/**
 * Active un skin pour un joueur (le met comme skin affiché).
 * "default" = revenir au skin par défaut. Le serveur vérifie la propriété.
 */
export async function activateSkin(publicId, skinId) {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(publicId)) throw new Error("Public ID invalide");
  if (skinId !== DEFAULT_SKIN_ID && !VALID_SKIN_IDS.includes(skinId)) throw new Error("skinId invalide");

  const result = await apiPost({ action: "activate", skinId, publicId });
  invalidateActiveSkinCache(publicId);
  return { ok: true, activeSkinId: result.activeSkinId || skinId };
}

/* ══════════════════════════════════════════════════════════════════
   Helper pour appliquer un skin à un élément DOM
   ══════════════════════════════════════════════════════════════════ */

/**
 * Applique la classe CSS du skin actif d'un joueur à un élément <span>.
 * Si aucun skin actif, applique skin-default.
 */
export function applySkinToElement(el, publicId, async = true) {
  if (!el || !publicId) return;

  // Sync: apply cached skin immediately
  const cached = getCachedActiveSkinId(publicId);
  const skin = getSkin(cached);
  el.className = el.className.replace(/\bskin-\S+/g, "").trim();
  el.classList.add(skin.cssClass);

  if (async) {
    fetchActiveSkinId(publicId).then((skinId) => {
      const s = getSkin(skinId);
      // ⚠️ Ne PAS comparer au cache (déjà peuplé par la promesse elle-même) :
      // vérifier la classe réellement appliquée à l'élément.
      if (el.classList.contains(s.cssClass)) return; // déjà appliqué
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

/* ══════════════════════════════════════════════════════════════════
   Admin : gérer les codes (rôle admin vérifié côté serveur)
   ══════════════════════════════════════════════════════════════════ */

/**
 * Crée un code de récompense (admin only — vérifié via la session).
 */
export async function createRewardCode({ code, skinId, maxUses, note, createdBy, expiresAt }) {
  const normalized = normalizeCode(code);
  if (normalized.length < 3) throw new Error("Code trop court");
  if (!VALID_SKIN_IDS.includes(skinId)) throw new Error("skinId invalide");
  if (skinId === DEFAULT_SKIN_ID) throw new Error("Impossible de créer un code pour le skin par défaut");

  const result = await apiPost({
    action: "createCode",
    code: normalized,
    skinId,
    maxUses: maxUses == null ? null : Math.max(1, parseInt(maxUses, 10) || 1),
    note: note || null,
    expiresAt: expiresAt || null,
  });
  return { ok: true, code: result.code, skinId: result.skinId };
}

/**
 * Liste tous les codes (admin only). Ne retourne aucun champ sensible.
 */
export async function listAllCodes() {
  const data = await apiGet("/api/skins.php?codes=1");
  return data.codes || [];
}

// Export pour compatibilité
export { getSkin, getUnlockableSkins, DEFAULT_SKIN_ID };
