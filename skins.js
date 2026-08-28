/**
 * skins.js — Catalogue de cosmétiques pour TheFrontHub.
 *
 * Un "cosmétique" est un motif de texte coloré (dégradé, glow, animation)
 * appliqué au pseudo d'un joueur sur les classements, le lobby et le profil.
 *
 * 🔥 REFONTE 2026-08 : le catalogue historique (17 skins : gold, rainbow,
 * fire, ice, neon…) a été RETIRÉ — de nouveaux cosmétiques seront créés
 * sur mesure. Pour en ajouter un, complète simplement SKINS ci-dessous :
 *   - id          : identifiant stable stocké en DB (a-z 0-9 _ -)
 *   - name        : nom affiché (FR)
 *   - description : courte description
 *   - rarity      : common | rare | epic | legendary | mythic
 *   - cssClass    : classe CSS appliquée au <span> du pseudo (dans skins.css)
 *
 * Tout le reste (codes de récompense, rachat atomique, activation) est
 * déjà branché : ajouter une entrée ici suffit à rendre un skin utilisable.
 *
 * Les skins se débloquent via des codes de récompense (voir reward-codes.js
 * et l'API /api/skins.php — tables tfh_reward_codes + tfh_user_skins).
 */

export const DEFAULT_SKIN_ID = "default";

export const RARITY_META = {
  common:    { label: "Commun",     color: "#6B7280", bg: "rgba(107,114,128,0.12)" },
  rare:      { label: "Rare",       color: "#2563eb", bg: "rgba(37,99,235,0.12)" },
  epic:      { label: "Épique",     color: "#9333ea", bg: "rgba(147,51,234,0.12)" },
  legendary: { label: "Légendaire", color: "#d97706", bg: "rgba(217,119,6,0.12)" },
  mythic:    { label: "Mythique",   color: "#dc2626", bg: "rgba(220,38,38,0.12)" },
};

/**
 * Catalogue des cosmétiques.
 * 2026-08 : cosmétiques nouvelle génération — 5 skins de texte à dégradé
 * animé couvrant toute l'échelle de rareté : lagon (rare), aurora et
 * braise (épiques), dusk (légendaire), prisme (mythique). Les skins de
 * l'ancien catalogue (gold, rainbow, fire…) ont été retirés à la refonte ;
 * les lignes tfh_user_skins héritées sont simplement ignorées (fallback
 * Standard).
 */
export const SKINS = [
  {
    id: DEFAULT_SKIN_ID,
    name: "Standard",
    description: "Le look classique. Texte normal.",
    rarity: "common",
    cssClass: "skin-default",
  },
  {
    id: "lagon",
    name: "Lagon",
    description: "Eaux turquoise animées — cyan, bleu océan et indigo qui virevoltent doucement.",
    rarity: "rare",
    cssClass: "skin-lagon",
  },
  {
    id: "aurora",
    name: "Aurore",
    description: "Dégradé boréal animé — turquoise, émeraude et violet qui ondulent sur ton pseudo.",
    rarity: "epic",
    cssClass: "skin-aurora",
  },
  {
    id: "braise",
    name: "Braise",
    description: "Braises animées — ambre, orange et rouge incandescent qui palpitent sans fin.",
    rarity: "epic",
    cssClass: "skin-braise",
  },
  {
    id: "dusk",
    name: "Crépuscule",
    description: "Coucher de soleil animé — ambre, rose et violet qui glissent en continu.",
    rarity: "legendary",
    cssClass: "skin-dusk",
  },
  {
    id: "prisme",
    name: "Prisme",
    description: "Spectre prismatique complet — six couleurs pures qui traversent ton pseudo en boucle.",
    rarity: "mythic",
    cssClass: "skin-prisme",
  },
  // ── Prochains cosmétiques : à venir ────────────────────────────
  // {
  //   id: "exemple",
  //   name: "Exemple",
  //   description: "Description du cosmétique.",
  //   rarity: "epic",
  //   cssClass: "skin-exemple",   // + CSS correspondant dans skins.css
  // },
];

const SKIN_MAP = Object.fromEntries(SKINS.map((s) => [s.id, s.id ? s : null]).filter(Boolean));

/** Retourne un skin par id. Fallback sur le skin par défaut. */
export function getSkin(skinId) {
  if (skinId && SKIN_MAP[skinId]) return SKIN_MAP[skinId];
  return SKIN_MAP[DEFAULT_SKIN_ID];
}

/** Retourne tous les skins déblocables (sans le défaut). */
export function getUnlockableSkins() {
  return SKINS.filter((s) => s.id !== DEFAULT_SKIN_ID);
}

/** Liste des ids de skins valides. */
export const VALID_SKIN_IDS = SKINS.map((s) => s.id);

/** Normalise un code : majuscules, tirets, A-Z0-9 uniquement. */
export function normalizeCode(raw) {
  return String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/g, "");
}
