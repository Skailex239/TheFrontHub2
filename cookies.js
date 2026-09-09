/*!
 * cookies.js v5 — Tags Google (GA4 + AdSense/CMP) & réouverture du consentement — TheFrontHub
 * ---------------------------------------------------------------------------
 * ⚠️ Correctif v5 : le bandeau ne s'affichait pas sur le site car le TAG
 *    ADSENSE n'était jamais chargé (ADS_ENABLED = false dans ads.js et
 *    cookies.js v4 ne chargeait que gtag.js/GA4). Or le message de
 *    consentement Google (AdSense → « Confidentialité et messages ») est
 *    servi par le tag AdSense (adsbygoogle.js), PAS par gtag.js —
 *    doc officielle : « User messaging functionality can be deployed
 *    using existing Google Publisher or AdSense tags ».
 *    → adsbygoogle.js est désormais chargé sur toutes les pages :
 *        • il affiche le bandeau CMP Google dans l'EEE/RU/CH ;
 *        • il n'affiche AUCUNE publicité tant qu'aucun emplacement
 *          n'existe (ADS_ENABLED reste false : le tag seul est inerte).
 *
 * Historique : v4 = retrait du bandeau maison (consentement délégué à la
 * CMP certifiée Google) ; v1-v3 = bandeau cookies maison.
 *
 * Rôle de ce fichier :
 *   1. Consent Mode v2 : défauts régionaux (refus EEE/RU/CH, accord
 *      ailleurs) — la CMP met ensuite à jour les états après le choix
 *   2. Chargement gtag.js (GA4 G-GNY8ZYKCZB)
 *   3. Chargement adsbygoogle.js (sert le message CMP — aucune pub)
 *   4. window.openCookiePreferences() : rouvre le bandeau Google
 *      (googlefc.showRevocationMessage = API officielle Funding Choices,
 *      repli TCF « displayConsentUi », repli final : message d'info)
 *
 * API publique : window.openCookiePreferences()
 * Aucune dépendance. IIFE.
 */
(function () {
  "use strict";

  var MEASUREMENT_ID = "G-GNY8ZYKCZB";
  var ADSENSE_CLIENT = "ca-pub-2991878097014222";

  /* ── 1. Stub gtag standard (AVANT toute commande) ── */

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  /* ── 2. Consent Mode v2 — défauts régionaux ──────────────────────────
     Refus par défaut dans l'EEE, au Royaume-Uni et en Suisse (périmètre
     du message CMP Google), accord par défaut ailleurs (aucune obligation
     de consentement hors de ces régions). La CMP Google met ensuite à jour
     ces états après le choix de l'utilisateur. wait_for_update laisse
     500 ms aux éventuels appelants asynchrones. */

  var REGION_REGLEMENTEE = [
    // EEE : UE-27 + Islande, Liechtenstein, Norvège
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
    "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
    "SI", "ES", "SE", "IS", "LI", "NO",
    // Royaume-Uni + Suisse
    "GB", "CH"
  ];

  gtag("consent", "default", {
    "ad_storage": "denied",
    "ad_user_data": "denied",
    "ad_personalization": "denied",
    "analytics_storage": "denied",
    "region": REGION_REGLEMENTEE,
    "wait_for_update": 500
  });
  gtag("consent", "default", {
    "ad_storage": "granted",
    "ad_user_data": "granted",
    "ad_personalization": "granted",
    "analytics_storage": "granted"
  }); // sans « region » → s'applique à tous les autres visiteurs

  /* ── 3. Chargement gtag.js (GA4) ── */

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + MEASUREMENT_ID;
  document.head.appendChild(s);

  gtag("js", new Date());
  gtag("config", MEASUREMENT_ID);

  /* ── 4. Chargement du tag AdSense = serveur du message CMP Google ────
     ⚠️ C'est LUI qui affiche le bandeau Google (pas gtag.js). Aucun
     emplacement publicitaire n'est injecté (ADS_ENABLED = false dans
     ads.js) → aucune pub, le tag ne fait que diffuser le message.
     Même id « adsense-script » qu'ads.js pour éviter un double
     chargement le jour où les pubs seront activées. */

  if (!document.getElementById("adsense-script")) {
    var a = document.createElement("script");
    a.id = "adsense-script";
    a.async = true;
    a.crossOrigin = "anonymous";
    a.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + ADSENSE_CLIENT;
    document.head.appendChild(a);
  }

  /* ── 5. Réouverture du bandeau (liens « Gérer les cookies ») ───────── */

  var dejaOuvert = false;

  function tenterOuverture() {
    if (dejaOuvert) return true;
    // a) API officielle Funding Choices (fournie par le tag AdSense) :
    //    googlefc.showRevocationMessage() rouvre le message EEE.
    try {
      var fc = (window.googlefc = window.googlefc || {});
      if (typeof fc.showRevocationMessage === "function") {
        dejaOuvert = true;
        fc.showRevocationMessage();
        return true;
      }
    } catch (e1) {}
    // b) Repli : API TCF (les deux graphies existent selon les versions
    //    de la doc Google ; une commande inconnue renvoie juste false).
    try {
      if (typeof window.__tcfapi === "function") {
        dejaOuvert = true;
        window.__tcfapi("displayConsentUi", 2, function () {});
        window.__tcfapi("displayConsentUI", 2, function () {});
        return true;
      }
    } catch (e2) {}
    return false;
  }

  function messageDeSecours() {
    var en = false;
    try { en = (localStorage.getItem("openfront_lang") || "fr").slice(0, 2) === "en"; } catch (e3) {}
    var msg = en
      ? "The Google consent banner only appears in the EEA, the UK and Switzerland. Outside these regions, no consent is required."
      : "Le bandeau de consentement Google s'affiche uniquement dans l'EEE, au Royaume-Uni et en Suisse. Hors de ces régions, aucun consentement n'est requis.";
    if (typeof window.showToast === "function") window.showToast(msg, "info", 6000);
  }

  window.openCookiePreferences = function () {
    // File d'attente FC : si l'API arrive après le clic, elle ouvrira
    // elle-même le bandeau (mot-clé documenté CONSENT_API_READY).
    try {
      var fc = (window.googlefc = window.googlefc || {});
      if (!fc.callbackQueue) fc.callbackQueue = [];
      fc.callbackQueue.push({ "CONSENT_API_READY": function () { tenterOuverture(); } });
    } catch (e0) {}
    if (tenterOuverture()) return;
    // API pas encore prête : petite fenêtre de chargement puis replis.
    setTimeout(function () {
      if (tenterOuverture()) return;
      messageDeSecours();
    }, 1500);
  };
})();
