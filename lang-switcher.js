/**
 * lang-switcher.js — Sélecteur de langue FR/EN à drapeaux (TheFrontHub)
 * ──────────────────────────────────────────────────────────────────────
 * Script CLASSIQUE autonome (IIFE), chargé sur toutes les pages après
 * i18n.min.js. Deux rôles :
 *
 *  1. Injecter le sélecteur à 2 drapeaux (FR / EN) dans la sidebar de la
 *     page (juste après le bouton thème .theme-toggle) — zéro markup à
 *     ajouter dans les HTML.
 *
 *  2. Hydrater TOUT conteneur [data-lang-choice] (modale d'inscription,
 *     réglage « Langue » du profil) avec les mêmes boutons drapeaux :
 *         <div class="lang-choice" data-lang-choice></div>
 *
 * Le changement de langue passe par window.setLanguage(lang) (i18n.js) :
 * localStorage + POST /api/language.php (si connecté) + reload.
 *
 * Drapeaux : SVG inline (les émojis drapeaux ne s'affichent pas sous
 * Windows — on veut un rendu identique partout).
 */
(function () {
  "use strict";

  var FLAG_FR = '<svg class="lang-flag" viewBox="0 0 24 16" aria-hidden="true">' +
    '<rect width="8" height="16" fill="#002395"/><rect x="8" width="8" height="16" fill="#fff"/>' +
    '<rect x="16" width="8" height="16" fill="#ED2939"/></svg>';
  var FLAG_EN = '<svg class="lang-flag" viewBox="0 0 24 16" aria-hidden="true">' +
    '<rect width="24" height="16" fill="#012169"/>' +
    '<path d="M0 0l24 16M24 0L0 16" stroke="#fff" stroke-width="3.2"/>' +
    '<path d="M0 0l24 16M24 0L0 16" stroke="#C8102E" stroke-width="1.8"/>' +
    '<path d="M12 0v16M0 8h24" stroke="#fff" stroke-width="5"/>' +
    '<path d="M12 0v16M0 8h24" stroke="#C8102E" stroke-width="3"/></svg>';

  var LANGS = [
    { code: "fr", flag: FLAG_FR, label: "Français" },
    { code: "en", flag: FLAG_EN, label: "English" },
  ];

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** HTML des boutons drapeaux (l'état actif est posé par sync()). */
  function buttonsHtml() {
    return LANGS.map(function (l) {
      return '<button type="button" class="lang-btn" data-lang="' + l.code + '"' +
        ' aria-label="' + esc(l.label) + '" title="' + esc(l.label) + '">' +
        l.flag + '</button>';
    }).join("");
  }

  /** Met à jour l'état actif de tous les switchers de la page. */
  function sync(current) {
    document.querySelectorAll(".lang-btn[data-lang]").forEach(function (btn) {
      var active = btn.getAttribute("data-lang") === current;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }
  window.__tfhSyncLangSwitchers = sync;

  function onClick(e) {
    var btn = e.target.closest(".lang-btn[data-lang]");
    if (!btn) return;
    var lang = btn.getAttribute("data-lang");
    if (lang === (window.currentLanguage || "fr")) return;
    if (typeof window.setLanguage === "function") {
      window.setLanguage(lang); // localStorage + API compte + reload (i18n.js)
    } else {
      try { localStorage.setItem("openfront_lang", lang); } catch (err) {}
      window.location.reload();
    }
  }

  /* ── 1. Switcher sidebar (injecté, si une sidebar existe) ──────────── */
  function injectSidebarSwitcher() {
    if (document.querySelector(".lang-switcher")) return;
    var sidebar = document.querySelector("aside.sidebar");
    if (!sidebar) return;
    var anchor = sidebar.querySelector(".theme-toggle");
    var box = document.createElement("div");
    box.className = "lang-switcher";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Langue / Language");
    var label = document.createElement("span");
    label.className = "lang-switcher-label";
    label.setAttribute("data-i18n", "lang.label");
    label.textContent = (window.t ? window.t("lang.label") : "Langue");
    box.appendChild(label);
    var btns = document.createElement("div");
    btns.className = "lang-switcher-btns";
    btns.innerHTML = buttonsHtml();
    box.appendChild(btns);
    if (anchor && anchor.parentNode === sidebar) {
      anchor.insertAdjacentElement("afterend", box);
    } else {
      sidebar.appendChild(box);
    }
  }

  /* ── 2. Zones de choix déclarées [data-lang-choice] ────────────────── */
  function hydrateChoiceZones() {
    document.querySelectorAll("[data-lang-choice]").forEach(function (zone) {
      if (zone.querySelector(".lang-btn")) return; // déjà hydraté
      zone.innerHTML = buttonsHtml();
    });
  }

  function init() {
    injectSidebarSwitcher();
    hydrateChoiceZones();
    sync(window.currentLanguage || "fr");
  }

  document.addEventListener("click", onClick);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
