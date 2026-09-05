// update-banner.js — Banderole « Mises à jour prochainement » (toutes pages)
//
// Petite bande en haut du site, fermable via une croix ✕.
// - Le choix de fermer est MÉMORISÉ (localStorage) : la bande ne réapparaît
//   pas à chaque visite tant que le message reste identique.
// - Pour diffuser un NOUVEAU message plus tard : changer BANNER_TEXT ci-
//   dessous (ou BANNER_ID) → la clé de mémorisation change → la bande
//   réapparaît pour tout le monde.
// - Zéro dépendance, chargé en <script defer> sur toutes les pages :
//   s'il n'existe pas (bloqueur, cache ancien), le site fonctionne normalement.

(function () {
  "use strict";

  // ── Réglages du message ─────────────────────────────────────────────────
  var BANNER_ID = "2026-09-maj";          // changer → ré-affiche la bande
  var BANNER_HTML =
    '<span class="tfh-ub-icon" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>' +
    "</span>" +
    '<span class="tfh-ub-text"><strong>Des mises à jour arrivent prochainement&nbsp;!</strong>&nbsp;De nouvelles fonctionnalités débarquent bientôt sur TheFrontHub. Restez à l\'affût…</span>';

  var STORAGE_KEY = "tfh:update-banner:" + BANNER_ID;

  // Déjà fermée par le visiteur → on ne l'affiche plus.
  try {
    if (localStorage.getItem(STORAGE_KEY) === "dismissed") return;
  } catch (e) { /* localStorage indisponible (navigation privée) → on affiche */ }

  /* FIX « banderole cache le logo » : la sidebar est position:fixed (top:0,
     z-index 50) tandis que la banderole est z-index 500 → elle recouvrait le
     logo en haut à gauche. On pose désormais une classe tfh-ub-open sur
     <html> + une variable CSS --tfh-ub-h (hauteur réelle de la bande) : le
     CSS (styles.css) descend la sidebar sous la bande tant qu'elle est
     visible, et la remet à top:0 dès la fermeture. */
  var root = document.documentElement;

  function syncHeight() {
    var banner = document.getElementById("tfh-update-banner");
    if (!banner) return;
    var h = banner.offsetHeight;
    if (h > 0) root.style.setProperty("--tfh-ub-h", h + "px");
  }

  function teardown() {
    root.classList.remove("tfh-ub-open");
    root.style.removeProperty("--tfh-ub-h");
    window.removeEventListener("resize", syncHeight);
  }

  function inject() {
    if (document.getElementById("tfh-update-banner")) return;

    var banner = document.createElement("div");
    banner.id = "tfh-update-banner";
    banner.className = "tfh-update-banner";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Annonce : mises à jour à venir");

    banner.innerHTML =
      '<div class="tfh-ub-inner">' +
        BANNER_HTML +
        '<button type="button" class="tfh-ub-close" aria-label="Fermer l\'annonce" title="Fermer">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        "</button>" +
      "</div>";

    // En haut du site : premier enfant du body (au-dessus de .page-wrap).
    var first = document.body.firstChild;
    if (first) document.body.insertBefore(banner, first);
    else document.body.appendChild(banner);

    // Descend la sidebar fixed sous la bande (logo toujours visible).
    root.classList.add("tfh-ub-open");
    syncHeight();
    window.addEventListener("resize", syncHeight);
    // Les polices web peuvent changer la hauteur (texte sur 2 lignes mobile).
    setTimeout(syncHeight, 300);
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(syncHeight).catch(function () {});
    }

    var closeBtn = banner.querySelector(".tfh-ub-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        // Petit fondu de sortie avant suppression.
        banner.classList.add("tfh-ub-leaving");
        try { localStorage.setItem(STORAGE_KEY, "dismissed"); } catch (e) { /* ignore */ }
        setTimeout(function () {
          if (banner.parentNode) banner.parentNode.removeChild(banner);
          teardown();
        }, 200);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
