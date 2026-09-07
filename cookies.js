/*!
 * cookies.js v3 — Bandeau de consentement TheFrontHub (CNIL / RGPD) — + lien "Politique de confidentialité"
 * ---------------------------------------------------------------------------
 * Architecture (Consent Mode v2, vie privée d'abord) :
 *   1. consent 'default' TOUT à 'denied' AVANT tout le reste
 *   2. `ga-disable` activé → strictement AUCUN hit GA avant acceptation
 *   3. gtag.js est chargé (nécessaire pour transmettre les signaux de
 *      consentement à Google : AdSense sert alors des pubs non personnalisées
 *      quand `ad_storage` = denied — aucun cookie pub n'est déposé)
 *   4. Le choix de l'utilisateur (accepter / refuser / personnaliser) est
 *      stocké dans localStorage (`tfs-consent`) et appliqué via
 *      gtag('consent','update',…)
 *
 * Aucune dépendance. IIFE. Injecte lui-même son CSS et son HTML.
 * API publique : window.openCookiePreferences()
 */
(function () {
  "use strict";

  var MEASUREMENT_ID = "G-GNY8ZYKCZB";
  var KEY = "tfs-consent";
  var DISMISS_KEY = "tfs-consent-dismiss"; // bandeau fermé SANS choix (session)

  /* ═══════════════ i18n ═══════════════ */

  function lang() {
    try {
      return (localStorage.getItem("openfront_lang") || "fr").slice(0, 2) === "en" ? "en" : "fr";
    } catch (e) { return "fr"; }
  }

  var STR = {
    fr: {
      title: "Nous respectons votre vie privée",
      body: "Des cookies pour la <b>mesure d'audience</b> et la <b>publicité</b>. Rien n'est déposé avant votre choix.",
      accept: "Tout accepter",
      deny: "Tout refuser",
      custom: "Personnaliser",
      close: "Fermer",
      privacy: "Politique de confidentialité",
      mtitle: "Préférences cookies",
      ana_t: "Mesure d'audience",
      ana_d: "Google Analytics — pages visitées, conservées 13 mois maximum.",
      ads_t: "Publicité",
      ads_d: "Google AdSense — désactivé : pubs non personnalisées.",
      save: "Enregistrer mes choix",
      note: "Modifiable à tout moment via le bouton 🍪.",
      fab: "Préférences cookies",
      toast: "Préférences cookies enregistrées"
    },
    en: {
      title: "We respect your privacy",
      body: "Cookies for <b>audience measurement</b> and <b>ads</b>. Nothing is stored before your choice.",
      accept: "Accept all",
      deny: "Reject all",
      custom: "Customize",
      close: "Close",
      privacy: "Privacy policy",
      mtitle: "Cookie preferences",
      ana_t: "Audience measurement",
      ana_d: "Google Analytics — visited pages, kept 13 months max.",
      ads_t: "Advertising",
      ads_d: "Google AdSense — off: non-personalized ads.",
      save: "Save my choices",
      note: "Change your mind anytime via the 🍪 button.",
      fab: "Cookie preferences",
      toast: "Cookie preferences saved"
    }
  };

  /* ═══════════════ Consent Mode v2 (AVANT tout) ═══════════════ */

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
    wait_for_update: 500
  });

  // Sécurité maximale : aucun hit GA tant que la mesure d'audience n'est pas acceptée
  window["ga-disable-" + MEASUREMENT_ID] = true;

  // gtag.js est chargé immédiatement : il relaie les signaux de consentement
  // (AdSense s'en sert pour ne servir QUE des pubs non personnalisées si refus)
  (function () {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + MEASUREMENT_ID;
    document.head.appendChild(s);
  })();

  /* ═══════════════ Stockage ═══════════════ */

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (c.a !== "granted" && c.a !== "denied") return null;
      if (c.p !== "granted" && c.p !== "denied") return null;
      return c;
    } catch (e) { return null; }
  }

  function save(a, p) {
    try { localStorage.setItem(KEY, JSON.stringify({ a: a, p: p, ts: Date.now() })); } catch (e) {}
    try { sessionStorage.removeItem(DISMISS_KEY); } catch (e) {}
    apply({ a: a, p: p });
  }

  function apply(c) {
    gtag("consent", "update", {
      analytics_storage: c.a,
      ad_storage: c.p,
      ad_user_data: c.p,
      ad_personalization: c.p
    });
    if (c.a === "granted") {
      delete window["ga-disable-" + MEASUREMENT_ID];
      gtag("js", new Date());
      gtag("config", MEASUREMENT_ID);
    } else {
      window["ga-disable-" + MEASUREMENT_ID] = true;
    }
  }

  function toast(msg) {
    try {
      if (typeof window.showToast === "function") window.showToast(msg, "success", 2200);
    } catch (e) {}
  }

  /* ═══════════════ CSS ═══════════════ */

  var CSS =
    ".tfsck-banner,.tfsck-modal,.tfsck-fab,.tfsck-overlay{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,sans-serif}" +
    ".tfsck-banner *,.tfsck-modal *{box-sizing:border-box;margin:0;padding:0}" +

    /* ── Bandeau ── */
    ".tfsck-banner{position:fixed;left:16px;bottom:16px;z-index:2147483000;width:min(420px,calc(100vw - 32px));" +
      "background:var(--bg-subtle,#FAFAFA);background:color-mix(in srgb,var(--bg-subtle,#FAFAFA) 94%,transparent);" +
      "-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);" +
      "border:1px solid var(--border,#E4E4E7);border-radius:18px;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.12),0 24px 64px rgba(0,0,0,.22);" +
      "padding:20px;opacity:0;transform:translateY(24px);transition:opacity .45s cubic-bezier(.22,1,.36,1),transform .45s cubic-bezier(.22,1,.36,1)}" +
    ".tfsck-banner.tfsck-in{opacity:1;transform:translateY(0)}" +
    ".tfsck-banner.tfsck-out{opacity:0;transform:translateY(24px);pointer-events:none}" +

    ".tfsck-row{display:flex;gap:14px;align-items:flex-start}" +
    ".tfsck-icon{flex:0 0 auto;width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;" +
      "background:linear-gradient(135deg,#ff6b00,#ff9500);box-shadow:0 4px 14px rgba(255,107,0,.35);color:#fff}" +
    ".tfsck-icon svg{width:22px;height:22px}" +
    ".tfsck-title{font-size:15px;font-weight:800;color:var(--fg,#18181B);letter-spacing:-.01em;margin-bottom:4px}" +
    ".tfsck-body{font-size:12.5px;line-height:1.55;color:var(--fg-muted,#71717A)}" +
    ".tfsck-body b{color:var(--fg-secondary,#3F3F46);font-weight:700}" +

    ".tfsck-actions{display:flex;gap:10px;margin-top:16px}" +
    ".tfsck-btn{flex:1;min-height:44px;border-radius:12px;border:1px solid transparent;cursor:pointer;" +
      "font-family:inherit;font-size:13.5px;font-weight:800;letter-spacing:-.01em;" +
      "transition:transform .15s,box-shadow .2s,filter .2s;-webkit-tap-highlight-color:transparent}" +
    ".tfsck-btn:active{transform:scale(.97)}" +
    ".tfsck-accept{background:linear-gradient(135deg,#ff6b00,#ff9500);color:#fff;" +
      "box-shadow:0 4px 14px rgba(255,107,0,.35)}" +
    ".tfsck-accept:hover{filter:brightness(1.08);box-shadow:0 6px 20px rgba(255,107,0,.45)}" +
    ".tfsck-deny{background:transparent;color:var(--fg-secondary,#3F3F46);border-color:var(--border-strong,#D4D4D8)}" +
    ".tfsck-deny:hover{border-color:var(--fg-muted,#71717A);color:var(--fg,#18181B)}" +
    ".tfsck-customline{text-align:center;margin-top:10px;display:flex;justify-content:center;align-items:center;gap:6px;flex-wrap:wrap}" +
    ".tfsck-custom{background:none;border:none;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;" +
      "color:var(--fg-muted,#71717A);text-decoration:underline;text-underline-offset:3px;padding:6px 10px;border-radius:8px;display:inline-block}" +
    ".tfsck-custom:hover{color:var(--orange,#ff6b00)}" +
    ".tfsck-plink{font-size:12px;font-weight:600;color:var(--fg-muted,#71717A);text-decoration:underline;text-underline-offset:3px;padding:6px 10px;border-radius:8px;display:inline-block}" +
    ".tfsck-plink:hover{color:var(--orange,#ff6b00)}" +
    ".tfsck-x{position:absolute;top:10px;right:10px;width:32px;height:32px;border-radius:10px;border:none;background:transparent;" +
      "color:var(--fg-subtle,#A1A1AA);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;line-height:1}" +
    ".tfsck-x:hover{background:var(--bg-muted,#F4F4F5);color:var(--fg,#18181B)}" +

    "@media (max-width:560px){.tfsck-banner{left:12px;right:12px;bottom:12px;width:auto;padding:18px}}" +

    /* ── Overlay + modal ── */
    ".tfsck-overlay{position:fixed;inset:0;z-index:2147483400;background:rgba(0,0,0,.55);" +
      "-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);" +
      "display:flex;align-items:center;justify-content:center;padding:20px;" +
      "opacity:0;transition:opacity .25s}" +
    ".tfsck-overlay.tfsck-in{opacity:1}" +
    ".tfsck-overlay[hidden]{display:none}" +
    ".tfsck-modal{width:min(460px,100%);background:var(--bg-subtle,#FAFAFA);border:1px solid var(--border,#E4E4E7);" +
      "border-radius:20px;padding:24px;box-shadow:0 32px 80px rgba(0,0,0,.4);" +
      "transform:scale(.94) translateY(10px);transition:transform .25s cubic-bezier(.22,1,.36,1)}" +
    ".tfsck-overlay.tfsck-in .tfsck-modal{transform:scale(1) translateY(0)}" +
    ".tfsck-mtitle{font-size:17px;font-weight:800;color:var(--fg,#18181B);letter-spacing:-.01em;margin-bottom:16px}" +
    ".tfsck-item{display:flex;align-items:center;gap:14px;padding:14px;border:1px solid var(--border,#E4E4E7);" +
      "border-radius:14px;background:var(--bg,#FFFFFF)}" +
    ".tfsck-item+.tfsck-item{margin-top:10px}" +
    ".tfsck-item-txt{flex:1;min-width:0}" +
    ".tfsck-item-txt p{font-size:13.5px;font-weight:700;color:var(--fg,#18181B);margin-bottom:2px}" +
    ".tfsck-item-txt span{font-size:11.5px;line-height:1.5;color:var(--fg-muted,#71717A);display:block}" +
    ".tfsck-sw{position:relative;display:inline-block;flex:0 0 auto;width:44px;height:26px}" +
    ".tfsck-sw input{opacity:0;width:0;height:0;position:absolute}" +
    ".tfsck-sw span{position:absolute;inset:0;border-radius:999px;background:var(--bg-muted,#F4F4F5);" +
      "border:1px solid var(--border,#E4E4E7);transition:background .2s,border-color .2s;cursor:pointer}" +
    ".tfsck-sw span::after{content:'';position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;" +
      "background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);transition:transform .2s cubic-bezier(.22,1,.36,1)}" +
    ".tfsck-sw input:checked+span{background:linear-gradient(135deg,#ff6b00,#ff9500);border-color:transparent}" +
    ".tfsck-sw input:checked+span::after{transform:translateX(18px)}" +
    ".tfsck-sw input:focus-visible+span{outline:2px solid var(--orange,#ff6b00);outline-offset:2px}" +
    ".tfsck-note{font-size:11px;color:var(--fg-subtle,#A1A1AA);text-align:center;margin:14px 0 0;line-height:1.5}" +
    ".tfsck-save{width:100%;margin-top:16px;flex:none}" +

    /* ── Bouton flottant 🍪 (empilé au-dessus de la bulle chat) ── */
    ".tfsck-fab{position:fixed;right:20px;bottom:84px;z-index:2147482900;width:40px;height:40px;border-radius:12px;" +
      "border:1px solid var(--border,#E4E4E7);background:var(--bg-subtle,#FAFAFA);color:var(--fg-muted,#71717A);" +
      "cursor:pointer;display:flex;align-items:center;justify-content:center;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.10);opacity:.55;transition:opacity .2s,transform .2s,color .2s}" +
    ".tfsck-fab:hover{opacity:1;transform:translateY(-2px);color:var(--orange,#ff6b00)}" +
    ".tfsck-fab svg{width:20px;height:20px}" +
    ".tfsck-fab[hidden]{display:none}" +
    "@media (max-width:768px){.tfsck-fab{right:12px;bottom:calc(var(--tfh-cw-nav, 76px) + 74px)}}";

  /* ═══════════════ Icônes ═══════════════ */

  var ICON_COOKIE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5z"/>' +
    '<path d="M8.5 8.5v.01M14.5 12.5v.01M10 15v.01M15 16.5v.01M8 12.5v.01"/>' +
    "</svg>";

  /* ═══════════════ UI ═══════════════ */

  var banner, overlay, anaCb, adsCb, fab, t;

  function ensureStyle() {
    if (document.getElementById("tfsck-style")) return;
    var st = document.createElement("style");
    st.id = "tfsck-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function dismissSession() {
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch (e) {}
    hideBanner();
  }

  function hideBanner() {
    if (!banner) return;
    banner.classList.add("tfsck-out");
    setTimeout(function () {
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      banner = null;
      showFab();
    }, 500);
  }

  function onAcceptAll() { save("granted", "granted"); hideBanner(); toast(t.toast); }
  function onDenyAll() { save("denied", "denied"); hideBanner(); toast(t.toast); }

  function onSaveCustom() {
    save(anaCb.checked ? "granted" : "denied", adsCb.checked ? "granted" : "denied");
    closeModal();
    hideBanner();
    toast(t.toast);
  }

  function openModal() {
    ensureStyle();
    var saved = read();
    t = STR[lang()];
    overlay = document.createElement("div");
    overlay.className = "tfsck-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="tfsck-modal" role="dialog" aria-modal="true" aria-labelledby="tfsck-mtitle">' +
        '<p class="tfsck-mtitle" id="tfsck-mtitle">🍪 ' + t.mtitle + "</p>" +
        '<div class="tfsck-item">' +
          '<div class="tfsck-item-txt"><p>' + t.ana_t + "</p><span>" + t.ana_d + "</span></div>" +
          '<label class="tfsck-sw"><input type="checkbox" id="tfsck-ana"><span aria-hidden="true"></span></label>' +
        "</div>" +
        '<div class="tfsck-item">' +
          '<div class="tfsck-item-txt"><p>' + t.ads_t + "</p><span>" + t.ads_d + "</span></div>" +
          '<label class="tfsck-sw"><input type="checkbox" id="tfsck-ads"><span aria-hidden="true"></span></label>' +
        "</div>" +
        '<p class="tfsck-note">' + t.note + "</p>" +
        '<p class="tfsck-note"><a class="tfsck-plink" href="privacy.html">' + t.privacy + "</a></p>" +
        '<button type="button" class="tfsck-btn tfsck-accept tfsck-save">' + t.save + "</button>" +
      "</div>";
    document.body.appendChild(overlay);
    anaCb = overlay.querySelector("#tfsck-ana");
    adsCb = overlay.querySelector("#tfsck-ads");
    anaCb.checked = !saved || saved.a === "granted";
    adsCb.checked = !saved || saved.p === "granted";
    overlay.querySelector(".tfsck-save").addEventListener("click", onSaveCustom);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", onModalKey);
    requestAnimationFrame(function () {
      overlay.hidden = false;
      requestAnimationFrame(function () { overlay.classList.add("tfsck-in"); });
    });
  }

  function onModalKey(e) { if (e.key === "Escape") closeModal(); }

  function closeModal() {
    if (!overlay) return;
    var ov = overlay;
    overlay = null;
    document.removeEventListener("keydown", onModalKey);
    ov.classList.remove("tfsck-in");
    setTimeout(function () {
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }, 280);
  }

  function showBanner() {
    if (banner) return;
    ensureStyle();
    t = STR[lang()];
    banner = document.createElement("div");
    banner.className = "tfsck-banner";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", t.title);
    banner.innerHTML =
      '<button type="button" class="tfsck-x" aria-label="' + t.close + '">✕</button>' +
      '<div class="tfsck-row">' +
        '<div class="tfsck-icon" aria-hidden="true">' + ICON_COOKIE + "</div>" +
        '<div class="tfsck-txt">' +
          '<p class="tfsck-title">' + t.title + "</p>" +
          '<p class="tfsck-body">' + t.body + "</p>" +
        "</div>" +
      "</div>" +
      '<div class="tfsck-actions">' +
        '<button type="button" class="tfsck-btn tfsck-deny">' + t.deny + "</button>" +
        '<button type="button" class="tfsck-btn tfsck-accept">' + t.accept + "</button>" +
      "</div>" +
      '<div class="tfsck-customline">' +
        '<button type="button" class="tfsck-custom">' + t.custom + "</button>" +
        '<a class="tfsck-plink" href="privacy.html">' + t.privacy + "</a>" +
      "</div>";
    banner.querySelector(".tfsck-x").addEventListener("click", dismissSession);
    banner.querySelector(".tfsck-accept").addEventListener("click", onAcceptAll);
    banner.querySelector(".tfsck-deny").addEventListener("click", onDenyAll);
    banner.querySelector(".tfsck-custom").addEventListener("click", openModal);
    document.body.appendChild(banner);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { banner.classList.add("tfsck-in"); });
    });
  }

  function showFab() {
    if (fab || !read()) return; // le bouton n'apparaît qu'après un premier choix
    ensureStyle();
    t = STR[lang()];
    fab = document.createElement("button");
    fab.type = "button";
    fab.className = "tfsck-fab";
    fab.setAttribute("aria-label", t.fab);
    fab.title = t.fab;
    fab.innerHTML = ICON_COOKIE;
    fab.addEventListener("click", openModal);
    document.body.appendChild(fab);
  }

  window.openCookiePreferences = openModal;

  /* ═══════════════ Boot ═══════════════ */

  function boot() {
    var saved = read();
    if (saved) {
      apply(saved);
      showFab();
    } else {
      var dismissed = false;
      try { dismissed = sessionStorage.getItem(DISMISS_KEY) === "1"; } catch (e) {}
      if (!dismissed) {
        // léger délai : laisse la page s'afficher d'abord
        setTimeout(showBanner, 600);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
