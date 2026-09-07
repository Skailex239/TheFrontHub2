/**
 * banners.js — Bannières pixel art pour la plaquette de pseudo (TheFrontHub).
 * ────────────────────────────────────────────────────────────────────────────
 * Une « bannière » est un motif pixel art (trame basse résolution rendue en
 * canvas puis étirée en `image-rendering: pixelated`) appliquée en fond de la
 * carte identité du profil (`.pf2-id`) — la plaquette blanche (mode clair) /
 * noire (mode sombre) sous le pseudo. Le motif couvre TOUTE la plaquette,
 * comme une bannière de profil Discord.
 *
 * Chaque bannière définit :
 *   - id          : identifiant stable stocké en DB (`banner_*`, a-z 0-9 _ -)
 *   - name        : nom affiché (FR)
 *   - description : courte description
 *   - rarity      : common | rare | epic | legendary | mythic (méta partagée
 *                   avec les skins — RARITY_META dans skins.js)
 *   - cols/rows   : trame pixel (48×12 → pixels ~8-15px une fois étirée)
 *   - matrix()    : générateur déterministe de la trame (48 chaînes de 12
 *                   caractères pris dans la palette, '.' = fond de plaque)
 *   - palette     : par caractère → { l: couleur mode clair, d: mode sombre }
 *
 * Déblocage : codes de récompense (même table tfh_reward_codes, skin_id
 * préfixé `banner_`) — /api/skins.php route le rachat vers tfh_user_banners,
 * /api/banners.php gère la propriété + l'activation.
 *
 * Pour ajouter une bannière : ajoute une entrée dans BANNERS ci-dessous
 * (le reste — codes, rachat, activation, rendu — est déjà branché).
 */

/* ════════════════════════════════════════════════════════════════
   Catalogue
   ════════════════════════════════════════════════════════════════ */

const COLS = 48;
const ROWS = 12;

/** Hash déterministe (0-99) — étincelles / braises reproductibles. */
function hash(x, y) {
  let h = (x * 2654435761) ^ (y * 97531);
  h = (h ^ (h >> 13)) * 1274126177;
  return Math.abs(h % 100);
}

/** Trame « Vagues » : 3 ondes sinusoïdales superposées style Discord/NVR. */
function vaguesMatrix() {
  const m = [];
  for (let y = 0; y < ROWS; y++) {
    let row = "";
    for (let x = 0; x < COLS; x++) {
      const t = x / COLS;
      const w1 = Math.round(Math.sin(t * Math.PI * 4) * 1.6 + 8.5);        // vague avant
      const w2 = Math.round(Math.sin(t * Math.PI * 6 + 2.1) * 1.3 + 5.5);  // vague médiane
      const w3 = Math.round(Math.sin(t * Math.PI * 3 + 4.4) * 1.8 + 10.5); // vague arrière
      let ch = ".";
      if (y >= w3) ch = "1";
      if (y >= w2) ch = "2";
      if (y >= w1) ch = "3";
      if (y === w1) ch = "4";                              // crête éclatante
      if (y === w2 && x % 7 === 3) ch = "5";               // écume magenta
      if (y === w3 && x % 11 === 6) ch = "5";
      if (y === 1 && x % 17 === 5) ch = "5";               // poussière d'étoile
      row += ch;
    }
    m.push(row);
  }
  return m;
}

/** Trame « Braises » : braise au sol + étincelles montantes (accent orange). */
function braisesMatrix() {
  const m = [];
  for (let y = 0; y < ROWS; y++) {
    let row = "";
    for (let x = 0; x < COLS; x++) {
      const h = hash(x, y);
      let ch = ".";
      if (y >= 8) ch = h < 55 ? "1" : "2";
      if (y >= 10) ch = h < 30 ? "2" : h < 75 ? "1" : "3";
      if (y >= 11) ch = h < 40 ? "3" : h < 80 ? "2" : "4";
      if (ch === "." && y >= 4 && h < 5) ch = "5";          // étincelle haute
      if (ch === "." && y >= 6 && h >= 5 && h < 11) ch = "3";
      if (ch === "." && y >= 2 && h >= 97) ch = "5";        // rare pique
      row += ch;
    }
    m.push(row);
  }
  return m;
}

export const BANNERS = [
  {
    id: "banner_vagues",
    name: "Vagues",
    description: "Pixel art violet & magenta — trois vagues rétro qui baignent toute ta plaquette.",
    rarity: "epic",
    cols: COLS,
    rows: ROWS,
    matrix: vaguesMatrix(),
    palette: {
      ".": { l: "#f6effe", d: "#151021" },
      "1": { l: "#e6d4fb", d: "#241a39" },
      "2": { l: "#d5b6f6", d: "#372653" },
      "3": { l: "#c297f1", d: "#4c3171" },
      "4": { l: "#a46fe9", d: "#7d47dd" },
      "5": { l: "#ef9df5", d: "#d946ef" },
    },
  },
  {
    id: "banner_braises",
    name: "Braises",
    description: "Pixel art braise & étincelles — un lit de braises orange qui crépite sous ton pseudo.",
    rarity: "legendary",
    cols: COLS,
    rows: ROWS,
    matrix: braisesMatrix(),
    palette: {
      ".": { l: "#fdf4e8", d: "#190f07" },
      "1": { l: "#fbe7c6", d: "#33200e" },
      "2": { l: "#f8cf99", d: "#5c3410" },
      "3": { l: "#f5a94f", d: "#b45309" },
      "4": { l: "#ef8118", d: "#f59e0b" },
      "5": { l: "#ef5f44", d: "#fbbf24" },
    },
  },
  // ── Prochaines bannières : à venir ─────────────────────────────
  // {
  //   id: "banner_exemple",
  //   name: "Exemple",
  //   description: "Description.",
  //   rarity: "epic",
  //   cols: COLS, rows: ROWS,
  //   matrix: [...],            // ROWS chaînes de COLS caractères
  //   palette: { ".": {l,d}, "1": {l,d}, ... },
  // },
];

export const DEFAULT_BANNER_ID = "none"; // « Aucune » — plaquette standard

const BANNER_MAP = Object.fromEntries(BANNERS.map((b) => [b.id, b]).filter(([k]) => !!k));

export function getBanner(bannerId) {
  if (bannerId && BANNER_MAP[bannerId]) return BANNER_MAP[bannerId];
  return null;
}

/** Id valide côté client (le serveur applique sa propre regex `^banner_`). */
export function isBannerId(id) {
  return typeof id === "string" && /^banner_[a-z0-9_-]{1,32}$/.test(id);
}

export const VALID_BANNER_IDS = BANNERS.map((b) => b.id);

/* ════════════════════════════════════════════════════════════════
   Thème (miroir de icons.js — data-theme + prefers-color-scheme)
   ════════════════════════════════════════════════════════════════ */

export function currentTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  try {
    const stored = localStorage.getItem("tfs-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch (e) { /* localStorage indisponible */ }
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark" : "light";
}

/* ════════════════════════════════════════════════════════════════
   Rendu pixel art → data URL PNG (1 pixel de trame = 1px de canvas)
   ════════════════════════════════════════════════════════════════ */

const urlCache = new Map(); // `${bannerId}|${theme}` → dataURL

export function renderBannerUrl(banner, theme) {
  if (!banner || !banner.matrix) return null;
  const key = `${banner.id}|${theme}`;
  const cached = urlCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = banner.cols || COLS;
  canvas.height = banner.rows || ROWS;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const dark = theme === "dark";
  for (let y = 0; y < canvas.height; y++) {
    const row = banner.matrix[y] || "";
    for (let x = 0; x < canvas.width; x++) {
      const ch = row[x] || ".";
      const pair = (banner.palette && banner.palette[ch]) || null;
      if (!pair) continue; // caractère inconnu → transparent
      const color = dark ? pair.d : pair.l;
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const url = canvas.toDataURL("image/png");
  urlCache.set(key, url);
  return url;
}

/* ════════════════════════════════════════════════════════════════
   API /api/banners.php (propriété + activation)
   ════════════════════════════════════════════════════════════════ */

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
  const res = await fetch("/api/banners.php", {
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

/* Cache : publicId → { ownedBanners, activeBannerId } (60 s) */
const ownedCache = new Map();
const CACHE_TTL = 60 * 1000;

export function invalidateBannerCache(publicId) {
  if (publicId) ownedCache.delete(publicId);
  else ownedCache.clear();
}

/** { ownedBanners: [{bannerId, codeUsed, redeemedAt, active}], activeBannerId } */
export async function fetchOwnedBanners(publicId) {
  if (!publicId) return { ownedBanners: [], activeBannerId: null };
  const hit = ownedCache.get(publicId);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return { ownedBanners: hit.ownedBanners, activeBannerId: hit.activeBannerId };
  }
  try {
    const data = await apiGet(`/api/banners.php?publicId=${encodeURIComponent(publicId)}`);
    const out = {
      ownedBanners: data.ownedBanners || [],
      activeBannerId: data.activeBannerId || null,
    };
    ownedCache.set(publicId, { at: Date.now(), ...out });
    return out;
  } catch (e) {
    console.warn("[banners] fetchOwnedBanners failed:", e);
    return { ownedBanners: [], activeBannerId: null };
  }
}

export async function fetchActiveBannerId(publicId) {
  if (!publicId) return null;
  const { activeBannerId } = await fetchOwnedBanners(publicId);
  return activeBannerId || null;
}

/**
 * Active une bannière (bannerId du catalogue, ou "none" pour retirer).
 * Le serveur vérifie la propriété + le compte connecté.
 */
export async function activateBanner(publicId, bannerId) {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(String(publicId || ""))) throw new Error("Public ID invalide");
  if (bannerId !== DEFAULT_BANNER_ID && !isBannerId(bannerId)) throw new Error("Bannière invalide");
  const result = await apiPost({ action: "activate", bannerId, publicId });
  invalidateBannerCache(publicId);
  return { ok: true, activeBannerId: result.activeBannerId || null };
}

/* ════════════════════════════════════════════════════════════════
   Peinture sur la plaquette (.pf2-id)
   ════════════════════════════════════════════════════════════════ */

/** Cartes actuellement peintes : élément → bannerId (pour re-render thème). */
const painted = new Map();

export function paintBanner(cardEl, bannerId) {
  if (!cardEl) return;
  const banner = getBanner(bannerId);
  if (!banner) {
    clearBanner(cardEl);
    return;
  }
  const url = renderBannerUrl(banner, currentTheme());
  if (!url) return;
  cardEl.style.setProperty("--pfb-img", `url("${url}")`);
  cardEl.classList.add("pfb-on");
  painted.set(cardEl, banner.id);
}

export function clearBanner(cardEl) {
  if (!cardEl) return;
  cardEl.classList.remove("pfb-on");
  cardEl.style.removeProperty("--pfb-img");
  painted.delete(cardEl);
}

/** Charge la bannière active d'un joueur et l'applique à la plaquette. */
export async function applyBannerToCard(cardEl, publicId) {
  if (!cardEl) return;
  if (!publicId) {
    clearBanner(cardEl);
    return;
  }
  try {
    const bannerId = await fetchActiveBannerId(publicId);
    // Ne pas écraser une peinture plus récente (changement de profil rapide)
    paintBanner(cardEl, bannerId);
  } catch (e) {
    console.warn("[banners] applyBannerToCard failed:", e);
  }
}

/* ── Re-render au changement de thème (clair ⇄ sombre) ──────────── */

function repaintAll() {
  for (const [el, bannerId] of painted) {
    if (!el.isConnected) { painted.delete(el); continue; }
    paintBanner(el, bannerId);
  }
}

try {
  const mo = new MutationObserver(() => repaintAll());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
} catch (e) { /* MutationObserver indisponible — très vieux navigateurs */ }

try {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  if (mq && typeof mq.addEventListener === "function") {
    mq.addEventListener("change", () => repaintAll());
  }
} catch (e) { /* no-op */ }
