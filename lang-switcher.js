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
 * Drapeaux : SVG inline aux proportions officielles (les émojis drapeaux
 * ne s'affichent pas sous Windows — on veut un rendu identique partout).
 *   - France  : 3 bandes verticales, couleurs JOLI (#002654 / #fff / #ED2939)
 *   - Royaume-Uni : construction officielle de l'Union Jack (saltire blanc,
 *     saltire rouge DÉCALÉ via clip-path, croix blanche 10/30, croix rouge
 *     6/30). Les ids de clip-path sont uniques par instance (plusieurs
 *     switchers peuvent coexister sur une même page).
 */
(function () {
  "use strict";

  var uid = 0;

  function flagFR() {
    return '<svg class="lang-flag" viewBox="0 0 30 20" aria-hidden="true" focusable="false" role="img">' +
      '<rect width="30" height="20" fill="#002654"/>' +
      '<rect x="10" width="10" height="20" fill="#FFFFFF"/>' +
      '<rect x="20" width="10" height="20" fill="#ED2939"/>' +
      '</svg>';
  }

  function flagEN() {
    uid += 1;
    var s = "tfhuk-" + uid + "-s";
    var t = "tfhuk-" + uid + "-t";
    return '<svg class="lang-flag" viewBox="0 0 60 30" aria-hidden="true" focusable="false" role="img">' +
      '<defs>' +
      '<clipPath id="' + s + '"><path d="M0,0 v30 h60 v-30 z"/></clipPath>' +
      '<clipPath id="' + t + '"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath>' +
      '</defs>' +
      '<g clip-path="url(#' + s + ')">' +
      '<path d="M0,0 v30 h60 v-30 z" fill="#012169"/>' +
      '<path d="M0,0 L60,30 M60,0 L0,30" stroke="#FFFFFF" stroke-width="6"/>' +
      '<path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#' + t + ')" stroke="#C8102E" stroke-width="4"/>' +
      '<path d="M30,0 v30 M0,15 h60" stroke="#FFFFFF" stroke-width="10"/>' +
      '<path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/>' +
      '</g>' +
      '</svg>';
  }

  var LANGS = [
    { code: "fr", flag: flagFR, label: "Français" },
    { code: "en", flag: flagEN, label: "English" },
  ];

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** HTML des boutons drapeaux (l'état actif est posé par sync()). */
  function buttonsHtml() {
    return LANGS.map(function (l) {
      return '<button type="button" class="lang-btn" data-lang="' + l.code + '"' +
        ' aria-label="' + esc(l.label) + '" title="' + esc(l.label) + '">' +
        '<span class="flag-wrap">' + l.flag() + '</span>' +
        '</button>';
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
