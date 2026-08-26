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

const ADSENSE_CLIENT_ID = "ca-pub-2991878097014222";

// Pages où on ne veut PAS de pubs (par défaut, on en met partout)
// ex : ["/lobby.html"] pour pas polluer le lobby temps réel
const PAGES_SANS_PUB = ["/profile.html"];

// ─────────────────────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────────────────────

(function initAds() {
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

  return wrapper;
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
