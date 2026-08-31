/**
 * icons.js — Jeu d'icônes SVG originals, monochrome (currentColor),
 * pour remplacer tous les émojis affichés du site TheFrontHub.
 *
 * Utilisation :
 *   - En JS (module)  : import { icon, hydrateIcons } from './icons.js'; icon('trophy')
 *   - En JS (classique): window.icon('trophy')   (ex: toast.js)
 *   - En HTML          : <i data-icon="trophy"></i>  (hydraté automatiquement)
 *                        option: data-icon-size="14" data-icon-color="#f0c060"
 *
 * Taille par défaut 18px. Pour le rendu, on injecte width/height + class="icon".
 */

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';

// Chaque icône = contenu interne du <svg> (balise ouvrante + fermante ajoutées par icon()).
const ICONS = {
  // ── Rangs ───────────────────────────────────────────────
  crown: '<path d="M4 8l3.5 4L12 4l4.5 8L20 8l-1.5 11h-17L4 8z"/>',
  diamond: '<path d="M12 2l8 7-8 13-8-13 8-7z"/><path d="M4 9h16M12 2v20"/>',
  medal: '<circle cx="12" cy="15" r="6"/><path d="M9 3l3 6M15 3l-3 6"/><path d="M12 12l1 2.2 2.3.4-1.7 1.6.4 2.3L12 17l-2.3 1.5.4-2.3L8.4 16l2.3-.4L12 12z"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',

  // ── Navigation / UI ─────────────────────────────────────
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.6 14.2c2.5.3 4.4 2.5 4.4 5.3"/>',
  swords: '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/><polyline points="14.5 17.5 17.5 14.5 12 9 9 12 14.5 17.5"/><polyline points="9.5 17.5 6.5 14.5 12 9"/><line x1="20" y1="8" x2="8" y2="20"/>',
  // Ladder (échelle) — icône de la catégorie « Classé » (proposition 4 validée) :
  // triple chevron montant, évoque le « ladder » classé 1v1/2v2.
  ladder: '<path d="m6 10 6-5 6 5"/><path d="m6 15 6-5 6 5"/><path d="m6 20 6-5 6 5"/>',
  bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  trophy: '<path d="M8 4h8v4a4 4 0 01-8 0V4z"/><path d="M5 4H3v3a3 3 0 003 3M19 4h2v3a3 3 0 01-3 3M9 14h6M10 14v3h4v-3M8 20h8"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  fire: '<path d="M12 3c1 3-2 4-2 7a2 2 0 004 0c0-1-.5-2-1-3 2 1 4 4 4 7a5 5 0 01-10 0c0-4 3-6 5-11z"/>',
  stopwatch: '<circle cx="12" cy="13" r="7"/><path d="M12 13V9M9.5 2h5M12 2v3"/><path d="M9.5 13l3-3"/>',
  starOutline: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.8 6.6 20l1-6.1L3.2 9.5l6.1-.9L12 3z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.8 6.6 20l1-6.1L3.2 9.5l6.1-.9L12 3z" fill="currentColor" stroke="none"/>',
  key: '<circle cx="8" cy="8" r="4"/><path d="M11 11l8 8M16 16l3-3M14 14l2-2"/>',
  link: '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 015.6 5.6l-2 2"/><path d="M13 18l-1 1A4 4 0 018.4 13.4l2-2"/>',
  sparkle: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z"/>',
  chartDown: '<path d="M4 4v16h16"/><path d="M7 14l4-4 3 3 5-6"/>',
  castle: '<path d="M4 21V8l2 2 2-3 2 3 2-3 2 3 2-3 2 3 2-2v13z"/><path d="M10 21v-4h4v4"/>',
  home: '<path d="M4 11l8-7 8 7M6 10v10h12V10"/>',
  package: '<path d="M3 8l9-5 9 5v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  hourglass: '<path d="M7 3h10M7 21h10M7 3c0 6 10 6 10 12M17 21c0-6-10-6-10-12"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v6h-6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  warning: '<path d="M12 3l9 16H3L12 3z"/><path d="M12 10v4M12 17v.6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
  wave: '<path d="M5 13V8a1.5 1.5 0 013 0v4M8 12V6a1.5 1.5 0 013 0v6M11 12V7a1.5 1.5 0 013 0v5M14 12V8a1.5 1.5 0 013 0v6a6 6 0 01-6 6h-1a6 6 0 01-5-3l-3-4a1.5 1.5 0 012-2l2 2"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  check: '<path d="M5 12l5 5 9-11"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  snowflake: '<path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/>',
};

/**
 * Retourne le markup SVG inline pour une icône.
 * @param {string} name
 * @param {{size?:number,cls?:string,color?:string}} [opts]
 */
function icon(name, opts = {}) {
  const { size = 18, cls = "", color } = opts;
  const inner = ICONS[name];
  if (inner == null) return "";
  let attrs = `width="${size}" height="${size}" class="icon${cls ? " " + cls : ""}"`;
  if (color) attrs += ` style="color:${color}"`;
  return SVG_OPEN.replace("<svg", `<svg ${attrs}`) + inner + "</svg>";
}

/** Hydrate tous les <i data-icon> non encore traités dans `root`. */
function hydrateIcons(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const nodes = root.querySelectorAll('[data-icon]:not([data-icon-done])');
  nodes.forEach((el) => {
    const name = el.getAttribute("data-icon");
    const size = Number(el.getAttribute("data-icon-size")) || 18;
    const color = el.getAttribute("data-icon-color");
    el.innerHTML = icon(name, { size, color });
    el.classList.add("icon-wrap");
    el.setAttribute("data-icon-done", "1");
  });
}

// Export pour les modules (app.js, profile.js)
export { ICONS, icon, hydrateIcons };

// Exposition globale pour les scripts classiques (toast.js, etc.)
if (typeof window !== "undefined") {
  window.ICONS = ICONS;
  window.icon = icon;
  window.hydrateIcons = hydrateIcons;
}

// Auto-hydratation dans le navigateur : initiale + à chaque mutation du DOM
if (typeof document !== "undefined") {
  const boot = () => hydrateIcons(document);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  // Observe les ajouts dynamiques (rendus fréquents de app.js)
  let _iconDebounce = null;
  const observer = new MutationObserver(() => {
    if (_iconDebounce) return;
    _iconDebounce = requestAnimationFrame(() => {
      _iconDebounce = null;
      hydrateIcons(document);
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// THEME TOGGLE (light / dark / auto)
// ═══════════════════════════════════════════════════════════════════════════
//
// 3 modes :
//   - "auto"   → suit prefers-color-scheme (default, no data-theme attribute)
//   - "light"  → force clair (data-theme="light")
//   - "dark"   → force sombre (data-theme="dark")
//
// Clic sur le bouton = cycle auto → light → dark → auto → ...
// Le choix est sauvegardé en localStorage('tfs-theme').
// Au chargement, on lit le localStorage et on applique.

const THEME_KEY = 'tfs-theme';

/**
 * Apply theme based on stored preference.
 * Called on page load (see bottom of this file).
 */
function applyStoredTheme() {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      // "auto" or null → remove attribute to let prefers-color-scheme rule
      document.documentElement.removeAttribute('data-theme');
    }
  } catch (e) {
    // localStorage might throw in private mode, ignore
    console.warn('[theme] Could not read localStorage:', e.message);
  }
}

/**
 * Get the current effective theme (what the user actually sees).
 * Returns 'light' or 'dark'.
 */
function getEffectiveTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'light' || explicit === 'dark') return explicit;
  // Auto → check prefers-color-scheme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Get the current "mode" (what's stored): 'auto', 'light', or 'dark'.
 */
function getThemeMode() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch (e) {}
  return 'auto';
}

/**
 * Cycle through auto → light → dark → auto.
 * Called when user clicks the .theme-toggle button.
 */
function toggleTheme() {
  const current = getThemeMode();
  let next;
  if (current === 'auto') next = 'light';
  else if (current === 'light') next = 'dark';
  else next = 'auto';

  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyStoredTheme();

  // Show a toast if available
  const labels = { auto: 'Auto (suit le système)', light: 'Thème clair', dark: 'Thème sombre' };
  if (typeof window.showToast === 'function') {
    window.showToast(labels[next], 'info', 1500);
  } else {
    console.log(`[theme] switched to ${next}`);
  }
}

// Expose globally for onclick handlers
if (typeof window !== 'undefined') {
  window.toggleTheme = toggleTheme;
  window.getEffectiveTheme = getEffectiveTheme;

  // Apply stored theme ASAP (before CSS renders) to avoid flash of wrong theme
  // This script is loaded as type="module" so it's deferred — but still
  // applies before the user sees anything thanks to module defer semantics.
  applyStoredTheme();

  // Listen for system theme changes (only affects "auto" mode)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    // Only re-apply if user is in auto mode
    if (getThemeMode() === 'auto') {
      // No attribute change needed — CSS prefers-color-scheme handles it
      // Just notify the user (optional)
    }
  });
}

