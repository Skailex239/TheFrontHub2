/*!
 * cookies.js v4 — Chargeur Google tag (GA4) + réouverture du dialogue CMP — TheFrontHub
 * ---------------------------------------------------------------------------
 * ⚠️ Changement majeur (v4) : le bandeau cookies maison (v1-v3) a été RETIRÉ.
 *    Le consentement dans l'EEE, au Royaume-Uni et en Suisse est désormais
 *    recueilli par la CMP (plateforme de gestion du consentement) certifiée
 *    de Google — configurée dans AdSense → « Confidentialité et messages ».
 *    Un seul bandeau pour le visiteur, conforme TCF v2.2 + Consent Mode v2.
 *
 * Rôle de ce fichier (volontairement minimal) :
 *   1. Définir le stub dataLayer/gtag (snippet standard Google)
 *   2. Charger gtag.js (GA4 G-GNY8ZYKCZB) — c'est aussi le tag qui sert le
 *      message de consentement de la CMP Google sur toutes les pages
 *   3. NE PAS poser de consent default ici : la CMP Google applique elle-même
 *      les défauts régionaux (refus par défaut dans l'EEE/RU/CH avant le
 *      choix ; comportement standard hors de ces régions)
 *   4. window.openCookiePreferences() : rouvre le dialogue de consentement
 *      (API TCF « displayConsentUI », repli googlefc, repli final : message)
 *
 * API publique : window.openCookiePreferences()
 * Aucune dépendance. IIFE.
 */
(function () {
  "use strict";

  var MEASUREMENT_ID = "G-GNY8ZYKCZB";

  /* ── 1. Stub gtag standard (AVANT le chargement du script) ── */

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  /* ── 2. Chargement gtag.js : GA4 + diffusion du message CMP Google ── */

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + MEASUREMENT_ID;
  document.head.appendChild(s);

  /* ── 3. Démarrage de la mesure (le consentement est géré par la CMP) ── */

  gtag("js", new Date());
  gtag("config", MEASUREMENT_ID);

  /* ── 4. Réouverture du dialogue de consentement (liens « Gérer les cookies ») ── */

  window.openCookiePreferences = function () {
    // a) API TCF standard (CMP certifiée Google enregistrant __tcfapi)
    try {
      if (typeof window.__tcfapi === "function") {
        window.__tcfapi("displayConsentUI", 2, function () {});
        return;
      }
    } catch (e) {}
    // b) Repli : API historique Funding Choices
    try {
      window.googlefc = window.googlefc || {};
      if (!window.googlefc.callbackQueue) window.googlefc.callbackQueue = [];
      window.googlefc.callbackQueue.push({ SHOW_REVOCATION_MESSAGE: 1 });
      return;
    } catch (e2) {}
    // c) Dernier repli : guider vers l'icône « Options de confidentialité »
    try {
      var en = false;
      try { en = (localStorage.getItem("openfront_lang") || "fr").slice(0, 2) === "en"; } catch (e3) {}
      if (typeof window.showToast === "function") {
        window.showToast(
          en ? "Use the “Privacy options” icon at the bottom of the screen to change your choices."
             : "Utilise l'icône « Options de confidentialité » en bas de l'écran pour modifier ton choix.",
          "info", 5000
        );
      }
    } catch (e4) {}
  };
})();
