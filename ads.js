// ads.js — Gestion des publicités Google AdSense pour TheFrontHub
//
// Configuration :
//   - Charge le script Google AdSense une seule fois
//   - Affiche les emplacements pub (header, sidebar, in-content, footer)
//   - Respecte le design existant (palette orange TheFrontHub)
//   - Désactiver les pubs sur certaines pages (lobby, profile) si besoin
//
// Émplacement pub ID :
//   - ad-header         → bannière en haut (728x90 ou responsive)
//   - ad-sidebar-top    → sidebar en haut (300x250 ou responsive)
//   - ad-sidebar-bottom → sidebar en bas (300x600 ou responsive)
//   - ad-in-content     → dans le contenu principal (responsive)
//   - ad-footer         → bannière en bas (728x90 ou responsive)
//
// ⚠️ TOUT le fichier est enveloppé dans une IIFE : ce script est chargé en
// <script> CLASSIQUE sur toutes les pages ; des déclarations top-level
// (`const PAGES_SANS_PUB` → minifié `const l`) entraient en collision avec
// les globales d'autres scripts classiques chargés avant lui (i18n.min.js
// expose `function setLanguage` → minifié `function l`) →
// « Uncaught SyntaxError: Identifier 'l' has already been declared » et
// mort du script pub sur TOUTES les pages. L'IIFE supprime la classe entière
// de bug, quelle que soit la minification.
(function () {
"use strict";

const ADSENSE_CLIENT_ID = "ca-pub-2991878097014222";

/* ═════════════════════════════════════════════════════════════════════
   MASTER SWITCH — INTERRUPTEUR GLOBAL DES PUBLICITÉS
   ───────────────────────────────────────────────────────────────────
   false = AUCUN emplacement injecté, AUCUN script AdSense chargé
           (état actuel : pas encore d'annonces réelles — les slots vides
           faisaient clignoter des cadres « Publicité » vides pendant
           les 3 premières secondes de chaque page).
   true  = réinjecte les emplacements + charge AdSense (quand le compte
           AdSense sera validé avec de vrais IDs de slots).
   ══════════════════════════════════════════════════════════════════ */
const ADS_ENABLED = false;

// Pages où on ne veut PAS de pubs (par défaut, on en met partout)
// ex : ["/lobby.html"] pour pas polluer le lobby temps réel
const PAGES_SANS_PUB = ["/profile.html"];

// ─────────────────────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────────────────────

(function initAds() {
  // Interrupteur global : rien du tout tant que ADS_ENABLED est false
  if (!ADS_ENABLED) {
    console.log("[ads] Publicités désactivées (ADS_ENABLED = false)");
    return;
  }

  // Ne rien faire si on est sur une page sans pub
  const path = window.location.pathname;
  if (PAGES_SANS_PUB.includes(path)) {
    console.log("[ads] Page sans pub:", path);
    return;
  }

  // Ne rien faire si l'utilisateur est connecté (optionnel — respecter l'expérience user)
  // if (document.cookie.includes("tfs_logged_in")) return;

  // 1. Charger le script AdSense
  loadAdSenseScript();

  // 2. Injecter les emplacements pub après le DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectAdSlots);
  } else {
    injectAdSlots();
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
//  FONCTIONS
// ─────────────────────────────────────────────────────────────────────────────

function loadAdSenseScript() {
  if (document.getElementById("adsense-script")) return;

  const s = document.createElement("script");
  s.id = "adsense-script";
  s.async = true;
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`;
  s.crossOrigin = "anonymous";

  // Document de configuration pour AdSense (recommandé)
  const head = document.head || document.getElementsByTagName("head")[0];
  const meta = document.createElement("meta");
  meta.name = "google-adsense-account";
  meta.content = "ca-pub-2991878097014222";
  head.appendChild(meta);

  head.appendChild(s);
  console.log("[ads] AdSense script loaded");
}

function injectAdSlots() {
  // ── Header bannière (en haut du main content) ──
  injectHeaderAd();

  // ── Sidebar (si la page a une sidebar) ──
  injectSidebarAds();

  // ── In-content (au milieu du main content, après le 2e paragraphe) ──
  injectInContentAd();

  // ── Footer (en bas du main content) ──
  injectFooterAd();
}

function injectHeaderAd() {
  const main = document.querySelector("main.content") || document.querySelector("main");
  if (!main) return;

  // Ne pas réinjecter si déjà présent
  if (document.getElementById("ad-header")) return;

  const adDiv = createAdSlot("ad-header", "auto", "horizontal");
  main.insertBefore(adDiv, main.firstChild);
}

function injectSidebarAds() {
  const sidebar = document.querySelector("aside.sidebar");
  if (!sidebar) return;

  // Top
  const top = createAdSlot("ad-sidebar-top", "auto", "vertical");
  const profile = sidebar.querySelector(".sidebar-profile");
  if (profile && profile.nextSibling) {
    sidebar.insertBefore(top, profile.nextSibling);
  } else {
    sidebar.appendChild(top);
  }

  // Bottom
  const bottom = createAdSlot("ad-sidebar-bottom", "auto", "vertical");
  sidebar.appendChild(bottom);
}

function injectInContentAd() {
  const content = document.querySelector("main.content") || document.querySelector("main");
  if (!content) return;

  // Trouve tous les "blocs" visibles (h2, section, table)
  const blocks = content.querySelectorAll("h2, section, .card, table");
  if (blocks.length < 3) return;

  // Injecte après le 2e bloc
  const target = blocks[1];
  if (!target || target.parentNode.querySelector("#ad-in-content")) return;

  const adDiv = createAdSlot("ad-in-content", "auto", "horizontal");
  target.parentNode.insertBefore(adDiv, target.nextSibling);
}

function injectFooterAd() {
  const footer = document.querySelector("footer.lobby-footer") ||
                 document.querySelector("footer");
  if (!footer) return;

  if (document.getElementById("ad-footer")) return;

  const adDiv = createAdSlot("ad-footer", "auto", "horizontal");
  footer.parentNode.insertBefore(adDiv, footer);
}

function createAdSlot(id, format, layout) {
  const wrapper = document.createElement("div");
  wrapper.className = `ad-slot ad-${layout}`;
  wrapper.id = id;

  // Label "Publicité" (requis par Google + RGPD)
  const label = document.createElement("div");
  label.className = "ad-label";
  label.textContent = "Publicité";
  wrapper.appendChild(label);

  // Ins block
  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.display = "block";
  ins.setAttribute("data-ad-client", ADSENSE_CLIENT_ID);
  ins.setAttribute("data-ad-slot", getAdSlotId(id));
  ins.setAttribute("data-ad-format", format);
  ins.setAttribute("data-full-width-responsive", "true");
  wrapper.appendChild(ins);

  // Trigger (requis par AdSense)
  setTimeout(() => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      console.warn("[ads] push failed for", id, e.message);
    }
  }, 100);

  // Collapse automatique si la pub n'a pas rempli l'emplacement.
  // AdSense pose data-ad-status="filled" | "unfilled" sur le <ins>.
  // Un slot vide ne doit PAS laisser un grand rectangle noir : on le replie.
  scheduleCollapseCheck(wrapper, ins, id);

  return wrapper;
}

/**
 * Vérifie après un délai si l'annonce a été remplie.
 * Si non remplie (bloqueur de pub, pas de campagne, IDs placeholder…),
 * le slot est masqué pour ne pas créer de trou visuel dans la page.
 */
function scheduleCollapseCheck(wrapper, ins, id) {
  const checks = [
    { delay: 2500 },
    { delay: 6000 },  // 2e chance : les annonces tardives (lazy, vidéo…) remplissent parfois après 3-5s
  ];

  const check = () => {
    if (!wrapper.isConnected) return; // slot retiré du DOM entre-temps

    // data-ad-status est posé par AdSense : "filled" | "unfilled".
    // ⚠️ un iframe est créé même pour les annonces NON remplies :
    // on ne peut PAS se fier à sa seule présence.
    const status = ins.getAttribute("data-ad-status");
    let filled;
    if (status === "filled") {
      filled = true;
    } else if (status === "unfilled") {
      filled = false;
    } else {
      // Statut absent : AdSense pas encore traité (réseau lent) ou bloqué.
      // On ne replie que si rien n'est rendu.
      filled = ins.offsetHeight > 40 && ins.querySelector("iframe") !== null;
    }

    if (!filled) {
      wrapper.classList.add("ad-collapsed");
      console.log("[ads] slot non rempli → replié:", id);
    } else {
      wrapper.classList.remove("ad-collapsed");
      // Anti-flash (ads.css) : le slot ne devient visible qu'une fois rempli
      wrapper.classList.add("ad-has-filled");
    }
  };

  checks.forEach(({ delay }) => setTimeout(check, delay));
}

// IDs de slots AdSense — à remplacer par tes vrais IDs quand tu crées
// les emplacements dans la console AdSense (https://adsense.google.com)
// Pour l'instant on utilise des placeholders génériques
function getAdSlotId(slotId) {
  const ids = {
    "ad-header":         "0000000001",
    "ad-sidebar-top":    "0000000002",
    "ad-sidebar-bottom": "0000000003",
    "ad-in-content":     "0000000004",
    "ad-footer":         "0000000005",
  };
  return ids[slotId] || "0000000000";
}

})(); // ─ fin IIFE ads.js ─
