/**
 * skins.js — Catalogue de skins pour TheFrontStats.
 *
 * Un "skin" est un motif de texte coloré (dégradé, glow, animation) appliqué
 * au pseudo d'un joueur sur le classement et le profil.
 *
 * Les skins se débloquent via des codes de récompense (voir reward-codes.js).
 * Chaque skin a :
 *   - id          : identifiant stable stocké en DB
 *   - name        : nom affiché (FR)
 *   - description : courte description
 *   - rarity      : common | rare | epic | legendary | mythic
 *   - cssClass    : classe CSS appliquée au <span> contenant le pseudo
 *
 * Le CSS de chaque classe .skin-* est dans skins.css.
 */

export const DEFAULT_SKIN_ID = "default";

export const RARITY_META = {
  common:    { label: "Commun",     color: "#6B7280", bg: "rgba(107,114,128,0.12)" },
  rare:      { label: "Rare",       color: "#2563eb", bg: "rgba(37,99,235,0.12)" },
  epic:      { label: "Épique",     color: "#9333ea", bg: "rgba(147,51,234,0.12)" },
  legendary: { label: "Légendaire", color: "#d97706", bg: "rgba(217,119,6,0.12)" },
  mythic:    { label: "Mythique",   color: "#dc2626", bg: "rgba(220,38,38,0.12)" },
};

export const SKINS = [
  {
    id: DEFAULT_SKIN_ID,
    name: "Standard",
    description: "Le look classique. Texte normal.",
    rarity: "common",
    cssClass: "skin-default",
  },
  {
    id: "gold",
    name: "Or",
    description: "Dégradé doré brillant. Symbole de victoire.",
    rarity: "rare",
    cssClass: "skin-gold",
  },
  {
    id: "rainbow",
    name: "Arc-en-ciel",
    description: "Texte animé arc-en-ciel. Toujours en mouvement.",
    rarity: "mythic",
    cssClass: "skin-rainbow",
  },
  {
    id: "fire",
    name: "Flammes",
    description: "Rouge et orange incandescents. Pour les batailleurs.",
    rarity: "epic",
    cssClass: "skin-fire",
  },
  {
    id: "ice",
    name: "Glace",
    description: "Bleu cyan givré. Froid mais élégant.",
    rarity: "rare",
    cssClass: "skin-ice",
  },
  {
    id: "neon",
    name: "Néon",
    description: "Vert néon lumineux. Out of the matrix.",
    rarity: "epic",
    cssClass: "skin-neon",
  },
  {
    id: "purple",
    name: "Violet Royal",
    description: "Dégradé violet profond. Statut premium.",
    rarity: "rare",
    cssClass: "skin-purple",
  },
  {
    id: "sunset",
    name: "Coucher de soleil",
    description: "Rose, orange et violet. La fin d'une belle partie.",
    rarity: "epic",
    cssClass: "skin-sunset",
  },
  {
    id: "ocean",
    name: "Océan",
    description: "Bleu marine à turquoise. Profond comme l'océan.",
    rarity: "rare",
    cssClass: "skin-ocean",
  },
  {
    id: "silver",
    name: "Argent",
    description: "Métal argenté poli. Discrétion et classe.",
    rarity: "common",
    cssClass: "skin-silver",
  },
  {
    id: "bronze",
    name: "Bronze",
    description: "Bronze patiné. Pour les débutants prometteurs.",
    rarity: "common",
    cssClass: "skin-bronze",
  },
  {
    id: "diamond",
    name: "Diamant",
    description: "Éclat cristallin bleu-blanc. Élégance pure.",
    rarity: "legendary",
    cssClass: "skin-diamond",
  },
  {
    id: "inferno",
    name: "Inferno",
    description: "Le feu ultime. Dégradé animé rouge-noir.",
    rarity: "legendary",
    cssClass: "skin-inferno",
  },
  {
    id: "emerald",
    name: "Émeraude",
    description: "Vert profond précieux. Richesse et nature.",
    rarity: "legendary",
    cssClass: "skin-emerald",
  },
  {
    id: "galaxy",
    name: "Galaxie",
    description: "Violet, rose et bleu cosmique. Pour les voyageurs.",
    rarity: "mythic",
    cssClass: "skin-galaxy",
  },
];

const SKIN_MAP = Object.fromEntries(SKINS.map((s) => [s.id, s]));

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
