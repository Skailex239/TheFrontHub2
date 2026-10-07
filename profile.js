/**
 * profile.js — Profile page logic for TheFrontHub.
 *
 * Flow:
 *   onAuthStateChanged →
 *     • no user                       → show #profile-gate
 *     • user, no Firestore profile    → show #profile-setup (ownership verification)
 *     • user, profile with publicId   → fetch OpenFront stats → show #profile-main
 *
 * Stats are fetched from `https://api.openfront.io/public/player/{publicId}` via
 * fetchOpenFront (handles CORS proxy). ELO is read from local `ranked.json`.
 * Recent games (last 5) get an additional `/public/game/{gameId}` fetch to
 * determine win/loss based on the `winner` array (clientIDs of winners).
 */

import {
  auth, db, doc, getDoc, setDoc,
  collection, onSnapshot,
  onAuthStateChanged,
} from "./auth.js";
import { fetchOpenFront } from "./openfront-client.js?v=25";
import {
  getSkin, getUnlockableSkins, DEFAULT_SKIN_ID, RARITY_META, normalizeCode,
} from "./skins.js?v=2";
import {
  fetchOwnedSkins, redeemCode, activateSkin, applySkinToElement,
  invalidateActiveSkinCache, fetchActiveSkinMap, normPlayerName,
} from "./reward-codes.js?v=2";
import {
  BANNERS, getBanner, DEFAULT_BANNER_ID, renderBannerUrl, currentTheme,
  applyBannerToCard, paintBanner, fetchOwnedBanners, activateBanner,
} from "./banners.js?v=1";
import {
  computePlaytimeStats, extractCareerWins, totalWins, pointsFor,
  formatDurationCompact, formatPct, formatFrenchDate,
  formatPoints, classifyGame, gameDurationSec,
} from "./playtime-stats.js?v=1";

/* ── i18n (FR/EN) — moteur commun i18n.js (window.t, dictionnaire de page
   i18n-dict-profile.js). T(clé, fallback FR, params) ; LOCALE() localise
   les dates/nombres (fr-FR / en-GB). ── */
const T = (k, fb, params) => (typeof window.t === "function" ? window.t(k, params || {}) : fb);
const LOCALE = () => (window.currentLanguage === "en" ? "en-GB" : "fr-FR");

/* ── Vignettes de cartes : nom affiché → slug (atlas-data/maps_data.json,
   précalculé en dictionnaire compact pour un lookup instantané) ── */
const MAP_SLUGS={achiran:"achiran",aegean:"aegean",africa:"africa",alps:"alps",amazonriver:"amazonriver",antarctica:"antarctica",archipelagosea:"archipelagosea",arctic:"arctic",asia:"asia",australia:"australia",baikal:"baikal",baikalnukewars:"baikalnukewars",bajacalifornia:"bajacalifornia",balkans:"balkans",beringsea:"beringsea",beringstrait:"beringstrait",betweentwoseas:"betweentwoseas",blacksea:"blacksea",bosphorusstraits:"bosphorusstraits",branchingpaths:"branchingpaths",britannia:"britannia",britanniaclassic:"britanniaclassic",caribbean:"caribbean",caspiansea:"caspiansea",caucasus:"caucasus",centralasia:"centralasia",china:"china",colombia:"colombia", continua:"continua",danelaw:"danelaw",danishstraits:"danishstraits",degehabur:"degehabur",degahbour:"degahbour",dfz:"dfz",easterisland:"easterisland",europe:"europe",europeclassic:"europeclassic",falklandislands:"falklandislands",fars:"fars",france:"france",gatewaytotheatlantic:"gatewaytotheatlantic",germany:"germany",ghangisgolf:"ghangisgolf",ghana:"ghana",gobi:"gobi",greatlakes:"greatlakes",greece:"greece",greenland:"greenland",halfearth:"halfearth",hawaii:"hawaii",himalaya:"himalaya",iceland:"iceland",india:"india",indonesia:"indonesia",iowa:"iowa",iran:"iran",italia:"italia",italy:"italy",japan:"japan",japanneureich:"japanneureich",kalahari:"kalahari",kamtchatka:"kamtchatka",korea:"korea",lisboa:"lisboa",luna:"luna",maharaja:"maharaja",mallorca:"mallorca",manchuria:"manchuria",mapuche:"mapuche",mars:"mars",medina:"medina",mediterranean:"mediterranean",menam:"menam",montreal:"montreal",namibia:"namibia",naussicaa:"naussicaa",netherlands:"netherlands",newcaledonia:"newcaledonia",newengland:"newengland",newyork:"newyork",northamerica:"northamerica",norway:"norway",oceania:"oceania",pangaea:"pangaea",paris:"paris",patagonia:"patagonia",persepolis:"persepolis",poland:"poland",quebec:"quebec",richelieu:"richelieu",rome:"rome",sahara:"sahara",sardaigne:"sardaigne",sardinia:"sardinia",scandinavia:"scandinavia",southamerica:"southamerica",straitofgibraltar:"straitofgibraltar",suezcanal:"suezcanal",switzerland:"switzerland",taiwan:"taiwan",turkey:"turkey",uk:"uk",ukraine:"ukraine",vostok:"vostok",warsaw:"warsaw",westus:"westus",world:"world",yenisei:"yenisei",yemen:"yemen",znation:"znation"};

/** Slug de carte (même règle que l'atlas & lobby.js : minuscules alphanumériques). */
function mapSlugOfName(name) {
  return String(name || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** Miniature de carte — miroir LOCAL d'abord (atlas-data/thumbnails, 132 cartes,
 *  même origine : rapide et fiable). Repli GitHub automatique par le listener
 *  d'erreur global ci-dessous (v5.22). */
function mapThumbUrl(name) {
  const slug = mapSlugOfName(name);
  // ?v=2 : vignettes officielles OpenFront (fond surface #0a1628, comme le vrai jeu)
  return slug ? `atlas-data/thumbnails/${slug}.webp?v=2` : null;
}

/* v5.22 — repli automatique des vignettes locales → dépôt GitHub OpenFrontIO
 * (les erreurs de chargement <img> ne bouillonnent pas → capture:true).
 * Une seule substitution par image (dataset.ghFb). */
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const src = img.getAttribute("src") || "";
  const m = src.match(/^atlas-data\/thumbnails\/([a-z0-9]+)\.webp$/i);
  if (!m || img.dataset.ghFb) return;
  img.dataset.ghFb = "1";
  img.src = `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${m[1]}/thumbnail.webp`;
}, true);

/* ── State ── */
let currentUser = null;
let currentProfile = null;
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;
let _rankedCache = null;
let _allGamesCache = null; // toutes les games paginées (pour playtime + map stats)
let _allGamesLoading = false;
let _statsRunSeq = 0; // garde anti-course (changement de profil rapide)
let _mapStatsSortBy = "count";
let _mapStatsShowAll = false;
let _rewardCardState = { publicId: null, ownedSkins: [], activeSkinId: null, ownedBanners: [], activeBannerId: null };

// VIP skin: publicId → rewardType (matching par PUBLIC ID, pas par alias)
let vipPlayersByPid = new Map();
let _vipUnsub = null;
const NEW_SKIN_TYPES = ['cyberpunk','sunset','aurore','pastel','gold','volcano','ocean','miami','toxic','chroma','prism'];

/**
 * Écoute public-rewards et construit la map publicId → rewardType.
 * Le skin suit le PUBLIC ID (identité stable) plutôt que l'alias (changeant).
 * On lit data.publicId directement; en fallback on essaie data.username contre
 * le username du profil courant.
 */
function loadVipForProfile() {
  if (_vipUnsub) return; // déjà abonné
  try {
    _vipUnsub = onSnapshot(collection(db, "public-rewards"), (snap) => {
      vipPlayersByPid = new Map();
      // fallback: username → rewardType (pour les docs sans publicId direct)
      const usernameToType = new Map();
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        const rewardType = data.activeType || data.type || null;
        if (!rewardType || data.activated === false) return;
        if (data.publicId) vipPlayersByPid.set(String(data.publicId), rewardType);
        if (data.username) usernameToType.set(data.username, rewardType);
      });
      // Re-applique le skin sur le hero si on a un profil
      // En mode visualisation publique, on utilise le profil virtuel du joueur consulté
      // (son publicId) plutôt que le profil propre de l'utilisateur courant.
      if (viewingPublicId) {
        applyProfileSkin({ username: viewingUsername, publicId: viewingPublicId }, usernameToType);
      } else if (currentProfile) {
        applyProfileSkin(currentProfile, usernameToType);
      }
    }, (err) => {
      console.warn("[profile] VIP listener error (non-critique):", err.message);
    });
  } catch (e) {
    console.warn("[profile] loadVipForProfile error:", e);
  }
}

/**
 * Applique le skin VIP sur le pseudo du hero, résolu via publicId (prioritaire)
 * puis fallback username.
 */
function applyProfileSkin(profile, usernameToTypeFallback) {
  const nameEl = document.getElementById("profile-title-name");
  if (!nameEl) return;
  const pid = profile?.publicId;
  const rewardType = (pid && vipPlayersByPid.get(pid))
    || (profile?.username && usernameToTypeFallback?.get(profile.username))
    || null;
  if (rewardType && NEW_SKIN_TYPES.includes(rewardType)) {
    nameEl.className = `rgb-${rewardType}`;
  } else if (rewardType) {
    nameEl.className = `player-${rewardType}`;
  } else {
    nameEl.className = "";
  }
}

/* ── Helpers ── */

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function showToast(msg, type = "info", duration = 4000) {
  if (typeof window.showToast === "function") window.showToast(msg, type, duration);
  else console.log(`[toast:${type}]`, msg);
}

function showView(view) {
  const views = ["profile-loading", "profile-gate", "profile-setup", "profile-main"];
  views.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("is-active", id === view);
  });
}

function formatDateShort(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(LOCALE(), { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(LOCALE(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

/* ── Auth state ── */

// Public profile view state (set when URL contains ?publicId=XXX)
let viewingPublicId = null;
let viewingUsername = null;

/* ── Sécurité éditeur (2026-09-03) ─────────────────────────────────
 * UN SEUL état décide si l'édition (pseudo / codes cosmétiques) est
 * possible : editingAllowed. Il passe à true UNIQUEMENT quand le héros
 * affiché est celui du compte connecté (renderHero), et à false dès
 * qu'on rend un profil public/étranger (renderPublicProfile). Tous les
 * points d'entrée d'édition (crayon, éditeur, save, codes) consultent
 * ce drapeau — aucune séquence de rendu ne peut le contourner. */
let editingAllowed = false;

function setEditingAllowed(allowed) {
  editingAllowed = !!allowed;
  const editBtn = document.getElementById("pseudo-edit-btn");
  if (editBtn) editBtn.hidden = !editingAllowed;
  if (!editingAllowed) {
    // Referme l'éditeur s'il était ouvert (défense bfcache / re-rendus)
    const ed = document.getElementById("pseudo-editor");
    if (ed) ed.hidden = true;
    // Purge toute carte « codes cosmétiques » résiduelle d'un contexte précédent
    const rw = document.getElementById("reward-code-section");
    if (rw) rw.innerHTML = "";
  }
}

// Restauration depuis le cache navigateur (bfcache) : le DOM affiché peut
// être celui d'un ancien contexte (ex. son propre profil puis profil d'un
// autre). On force un rechargement complet pour réévaluer l'auth state.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) {
    console.info("[profile] Page restaurée depuis le bfcache — rechargement");
    window.location.reload();
  }
});

/* ── Pseudos « hub » (2026-09-03) ─────────────────────────────────────
 * Map publicId → pseudo choisi dans le profil TheFrontHub. Utilisée pour
 * afficher LE MÊME pseudo partout (héros du profil, « Autour de toi »),
 * même quand le pseudo en jeu diffère. */
const _hubNamesByPid = new Map();   // publicId → pseudo hub
const _hubNamesByNorm = new Map();  // pseudo hub normalisé → publicId
let _hubNamesPromise = null;
function loadHubNames() {
  if (_hubNamesPromise) return _hubNamesPromise;
  _hubNamesPromise = fetch("/api/public-aliases.php", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      for (const a of (data && data.aliases) || []) {
        if (a.publicId && a.username) {
          _hubNamesByPid.set(String(a.publicId), String(a.username));
          _hubNamesByNorm.set(normPlayerName(String(a.username)), String(a.publicId));
        }
        // aliases[] inclut le pseudo EN JEU (OpenFront) : on le bridge aussi
        // pour matcher les runs/leaderboards clés par pseudo en jeu.
        if (a.publicId && Array.isArray(a.aliases)) {
          for (const n of a.aliases) {
            if (n) _hubNamesByNorm.set(normPlayerName(String(n)), String(a.publicId));
          }
        }
      }
    })
    .catch(() => { /* non bloquant — pseudos en jeu affichés tels quels */ });
  return _hubNamesPromise;
}
/** Pseudo hub d'un publicId (ou null). La map est chargée en tâche de fond. */
function hubNameForPid(publicId) {
  return publicId ? (_hubNamesByPid.get(String(publicId)) || null) : null;
}
loadHubNames();

/**
 * Détecte si l'URL demande de visualiser le profil PUBLIC d'un autre joueur.
 * Format: profile.html?player=NAME&publicId=XXXXXXXX
 * Si le publicId correspond à celui de l'utilisateur courant, on ignore
 * (c'est son propre profil — flux normal).
 */
function getPublicProfileRequest() {
  const params = new URLSearchParams(window.location.search);
  const pid = (params.get("publicId") || params.get("pid") || "").trim();
  const name = (params.get("player") || "").trim();
  if (pid && /^[A-Za-z0-9]{8}$/.test(pid)) {
    return { publicId: pid, username: name || pid };
  }
  // (2026-09-03) ?player=NOM sans publicId → profil public « speedrun » :
  // tout joueur cliqué depuis les speedruns obtient une page profil, lié ou pas.
  if (name) {
    return { publicId: null, username: name };
  }
  return null;
}

onAuthStateChanged(auth, async (user) => {
  // ── Cas 1 : visualisation du profil public d'un autre joueur ──
  // On vérifie l'URL AVANT toute logique d'auth, car cela doit fonctionner
  // même si l'utilisateur n'est pas connecté.
  const pubReq = getPublicProfileRequest();
  if (pubReq) {
    // ── Cas 1-bis : joueur NON lié (?player=NOM sans publicId) → profil
    // public « speedrun » (records issus des données du site). Fonctionne
    // pour tout le monde, visiteur connecté ou non.
    if (!pubReq.publicId) {
      currentUser = user;
      currentProfile = null;
      // Vue d'un profil étranger (speedrun) : l'édition est verrouillée et le
      // contexte « profil consulté » est déclaré pour les listeners (VIP…).
      viewingUsername = pubReq.username;
      updateSidebarUI(user, null);
      showView("profile-main");
      await renderSpeedrunPublicProfile(pubReq.username);
      return;
    }

    // Lecture du propre profil de l'utilisateur courant (s'il est connecté)
    // pour détecter s'il visualise son PROPRE profil → flux normal.
    let ownProfile = null;
    if (user) {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) ownProfile = snap.data();
      } catch (e) {
        console.warn("[profile] Firestore read error (own, non-bloquant):", e.message);
      }
    }

    if (ownProfile && ownProfile.publicId === pubReq.publicId) {
      // L'utilisateur visualise son propre profil → flux normal (on nettoie l'URL)
      history.replaceState(null, "", window.location.pathname);
      currentUser = user;
      currentProfile = ownProfile;
      updateSidebarUI(user, ownProfile);
      showView("profile-main");
      renderHero(user, ownProfile);
      loadVipForProfile();
      await loadStats(ownProfile.publicId);
      loadProfileSpeedruns(ownProfile.publicId, true, [ownProfile.username]);
      return;
    }

    // ── Profil d'un AUTRE joueur (ou visiteur non connecté) ──
    currentUser = user; // peut être null
    currentProfile = ownProfile; // pour la sidebar (peut être null)
    updateSidebarUI(user, ownProfile);
    viewingPublicId = pubReq.publicId;
    viewingUsername = pubReq.username;
    showView("profile-main");
    renderPublicProfile(pubReq.username, pubReq.publicId);
    loadVipForProfile();
    await loadStats(pubReq.publicId);
    loadProfileSpeedruns(pubReq.publicId, false, [pubReq.username]);
    return;
  }

  // ── Cas 2 : pas de ?publicId dans l'URL → flux normal ──
  if (!user) {
    currentUser = null;
    currentProfile = null;
    updateSidebarUI(null);
    showView("profile-gate");
    return;
  }

  currentUser = user;

  // Read Firestore profile
  let profile = null;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) profile = snap.data();
  } catch (e) {
    console.error("[profile] Firestore read error:", e);
    showToast(T("pf.firestore_error", "Erreur de lecture du profil (Firestore)."), "error");
  }

  currentProfile = profile;
  updateSidebarUI(user, profile);

  if (!profile || !profile.publicId) {
    // New user → setup form (+ restaure un éventuel défi de propriété en
    // cours : LE MÊME code qu'avant de quitter la page — voir
    // restorePendingOwnershipChallenge).
    showView("profile-setup");
    restorePendingOwnershipChallenge();
    return;
  }

  // Returning user with publicId → fetch & display stats
  showView("profile-main");
  renderHero(user, profile);
  // Lance l'écoute VIP (skin par publicId) — re-applique le skin dès que les rewards arrivent
  loadVipForProfile();
  await loadStats(profile.publicId);
  loadProfileSpeedruns(profile.publicId, true, [profile.username]);
});

/* ═════════════════════════════════════════════════════════════════════════
   v5.36 — PAYLOAD PROFIL PARTAGÉ (affichage instantané)
   Le payload route=profile est demandé par pf-prefetch.js (survol/visible),
   posé en sessionStorage (tfh_pp:<pid>, 10 min) et servi par un cache fichier
   côté serveur (profile-warm.php). Un SEUL appel réseau partagé par page :
   renderPublicProfile, loadStats (arbre de carrière + dossier cockpit) et
   preprofile.js réutilisent le même objet — et l'URL est identique partout
   (limit=100) pour que le cache HTTP du navigateur dédoublonne.
   ═════════════════════════════════════════════════════════════════════════ */

const PROFILE_PAYLOAD_TTL = 10 * 60 * 1000;
const PROFILE_PAYLOAD_URL = (pid) => "/api/games-api.php?route=profile&publicId=" + encodeURIComponent(pid) + "&limit=100";
let _profilePayloadState = { pid: null, promise: null };

function profilePayloadFromSession(pid) {
  try {
    const raw = sessionStorage.getItem("tfh_pp:" + pid);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !p.p || Date.now() - (p.t || 0) > PROFILE_PAYLOAD_TTL) return null;
    return p.p;
  } catch (e) { return null; }
}

function profilePayloadToSession(pid, payload) {
  try {
    const json = JSON.stringify({ t: Date.now(), p: payload });
    if (json.length <= 300 * 1024) sessionStorage.setItem("tfh_pp:" + pid, json);
  } catch (e) { /* quota / navigation privée — silencieux */ }
}

/** Payload route=profile du joueur : sessionStorage → promesse partagée → fetch. */
function getProfilePayload(publicId) {
  if (!publicId) return Promise.resolve(null);
  if (_profilePayloadState.pid === publicId && _profilePayloadState.promise) {
    return _profilePayloadState.promise;
  }
  const cached = profilePayloadFromSession(publicId);
  if (cached) {
    window.__tfhProfilePayload = cached; // partagé avec preprofile.js
    return Promise.resolve(cached);
  }
  const promise = fetch(PROFILE_PAYLOAD_URL(publicId), { cache: "default" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j && j.ok) {
        window.__tfhProfilePayload = j;
        profilePayloadToSession(publicId, j);
        return j;
      }
      return null;
    })
    .catch(() => null);
  _profilePayloadState = { pid: publicId, promise };
  return promise;
}

/** Convertit les dernières parties du payload route=profile en échantillon
 *  au format API OpenFront (entrée de buildLiveStatsFromData). */
function payloadRecentSample(payload) {
  const rows = Array.isArray(payload?.stats?.recentGames) ? payload.stats.recentGames : [];
  return rows.map((g) => ({
    gameId: g.id,
    start: g.startedAt ? new Date(g.startedAt).toISOString() : null,
    map: g.map || "",
    mode: g.mode || "",
    rankedType: g.rankedType || null,
    result: g.won === true ? "victory" : (g.won === false ? "defeat" : "incomplete"),
    durationSeconds: typeof g.durationS === "number" ? g.durationS : 0,
    totalPlayers: g.numPlayers ?? null,
  }));
}

/**
 * Affiche le profil PUBLIC d'un autre joueur (ou le sien propre si visité via URL).
 * Masque le bouton de déconnexion, neutralise les actions d'édition, et applique
 * le skin VIP résolu via publicId.
 */
function renderPublicProfile(username, publicId) {
  const nameEl = document.getElementById("profile-title-name");
  // Pseudo AFFICHÉ : pseudo choisi sur TheFrontHub (même pseudo partout)
  // sinon pseudo en jeu. Le pseudo en jeu reste visible en info-bulle.
  const applyHeroName = (shownName, inGameName) => {
    if (!nameEl) return;
    nameEl.innerHTML = "";
    const skinSpan = document.createElement("span");
    skinSpan.textContent = shownName;
    if (inGameName && inGameName !== shownName) {
      skinSpan.title = T("pf.ingame", "En jeu : {name}", { name: inGameName });
    }
    nameEl.appendChild(skinSpan);
    applySkinToElement(skinSpan, publicId, true);
  };
  const hubName = hubNameForPid(publicId);
  applyHeroName(hubName || username, username);
  if (!hubName && publicId) {
    // La map des pseudos hub arrive peut-être après le premier rendu :
    // on met à jour le héros quand elle est chargée.
    loadHubNames().then(() => {
      const h = hubNameForPid(publicId);
      if (h) applyHeroName(h, username);
    });
  }

  const badgeEl = document.getElementById("profile-public-badge-text");
  if (badgeEl) badgeEl.textContent = publicId || "—";
  const pidBtn = document.getElementById("profile-public-badge");
  if (pidBtn) {
    pidBtn.dataset.pid = publicId || "";
    pidBtn.style.display = publicId ? "" : "none";
  }

  // Badge « vérifié » : masqué par défaut sur un profil public (donnée non chargée)
  const verifiedEl = document.getElementById("profile-verified");
  if (verifiedEl) verifiedEl.hidden = true;

  // v5.13 — extras profil masqués en attendant la réponse API
  renderProfileExtras(null);
  const editBtn = document.getElementById("profile-edit-btn");
  if (editBtn) editBtn.hidden = true;
  const claimHint = document.getElementById("claim-hint-banner");
  if (claimHint) claimHint.style.display = "none";

  // Éditeur de pseudo + carte cosmétiques : réservés au PROPRE profil.
  // setEditingAllowed(false) masque le crayon, referme l'éditeur et purge
  // la carte codes — aucune action d'édition possible sur un profil public.
  setEditingAllowed(false);

  // v5.13/v5.36 — Données serveur du profil consulté (verified + bio/map/liens) :
  // payload PARTAGÉ (pré-chargé par pf-prefetch au survol, sessionStorage, ou
  // fetch unique) → le bloc identité peint dès que le payload est en main.
  if (publicId) {
    getProfilePayload(publicId)
      .then((j) => {
        if (!j) return;
        if (viewingPublicId !== publicId) return; // l'utilisateur a changé de profil entre-temps
        if (window.TFHVerified && j.verified) window.TFHVerified.markVerified(publicId);
        const vEl = document.getElementById("profile-verified");
        if (vEl) {
          vEl.title = T("pf.verified_tip", "Joueur vérifié — cette personne est vérifiée (identité prouvée en jeu)");
          vEl.hidden = !j.verified;
        }
        const hint = document.getElementById("claim-hint-banner");
        if (hint) hint.style.display = j.verified ? "none" : "flex";
        renderProfileExtras(j.profile || null);
        // v5.14 — Vitrine cosmétiques depuis la réponse déjà chargée (0 requête en plus)
        renderShowcaseFromData(j);
      })
      .catch(() => {});
  } else {
    // Profil « speedrun » sans publicId : pas de compte lié → encart revendication
    const hint = document.getElementById("claim-hint-banner");
    if (hint) hint.style.display = "flex";
  }

  // Date d'arrivée : masquée sur un profil public (donnée non chargée)
  const joinedEl = document.getElementById("profile-joined-text");
  if (joinedEl) joinedEl.parentElement.style.display = "none";

  // Affiche la bannière "Profil public" + bouton retour
  const banner = document.getElementById("public-profile-banner");
  if (banner) banner.style.display = "flex";

  // Masque le bouton de déconnexion (ce n'est pas notre session)
  const logoutBtn = document.querySelector(".pf-logout-btn");
  if (logoutBtn) logoutBtn.style.display = "none";

  // Avatar dégradé + initiale (cohérent avec le flux normal)
  const avatarEl = document.getElementById("profile-avatar-large");
  if (avatarEl) {
    avatarEl.innerHTML = "";
    avatarEl.textContent = (username || "J").charAt(0).toUpperCase();
  }

  // Réinitialise les chips meta (remplies par renderPrecomputedStats)
  const metaEl = document.getElementById("cockpit-status-meta");
  if (metaEl) metaEl.innerHTML = "";

  // Construit un pseudo-profil pour que applyProfileSkin résolve le skin VIP
  // via le publicId du joueur visualisé (et non celui de l'utilisateur courant).
  const virtualProfile = { username, publicId };
  applyProfileSkin(virtualProfile, null);

  // Bannière pixel art du joueur visité (null → plaquette standard).
  applyBannerToCard(document.querySelector(".pf2-id"), publicId);
}

/* ─────────────────────────────────────────────────────────────────────────
   PROFIL PUBLIC « SPEEDRUN » (2026-09-03)
   Pour un joueur NON lié (?player=NOM sans publicId) : affiche ses records
   de speedrun issus des données du site. Chaque joueur cliqué depuis les
   speedruns obtient ainsi une page profil, visiteur connecté ou non.
   ───────────────────────────────────────────────────────────────────────── */

const SPEEDRUN_PROFILE_SESSION_KEY = "tfh_speedrun_profile";
const SPEEDRUN_PROFILE_SESSION_TTL = 15 * 60 * 1000; // 15 min

/**
 * Charge les runs d'un pseudo :
 *  1. sessionStorage (passés par la page speedrun au clic — instantané) ;
 *  2. fallback : payloads publics runs_public.json (FFA) + teams_public.json
 *     (duos/trios/quads/hvn, recherche par appartenance à la composition).
 */
async function loadSpeedrunPublicData(name) {
  try {
    const raw = sessionStorage.getItem(SPEEDRUN_PROFILE_SESSION_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.name === name && p.stats && Array.isArray(p.stats.runs)
          && Date.now() - (p.ts || 0) < SPEEDRUN_PROFILE_SESSION_TTL) {
        return { source: "session", runs: p.stats.runs };
      }
    }
  } catch (e) { /* sessionStorage indisponible */ }

  const runs = [];
  // FFA (format compact k/r)
  try {
    const res = await fetch("runs_public.json", { cache: "no-store" });
    if (res.ok) {
      const d = await res.json();
      if (d.k && Array.isArray(d.r)) {
        for (const row of d.r) {
          const o = {}; d.k.forEach((k, i) => o[k] = row[i]);
          if (String(o.player || "").trim() === name) {
            runs.push({ map: o.map, duration_s: o.duration_s, difficulty: o.difficulty,
                        timestamp: o.timestamp, mode: "solo",
                        url: o.id ? "https://openfront.io/game/" + o.id : null });
          }
        }
      }
    }
  } catch (e) { /* payload indisponible */ }
  // Équipes (composition "A + B")
  try {
    const res = await fetch("teams_public.json", { cache: "no-store" });
    if (res.ok) {
      const d = await res.json();
      for (const cat of ["duos", "trios", "quads", "hvn"]) {
        const sub = d[cat] || {};
        for (const map of Object.keys(sub)) {
          for (const r of sub[map]) {
            const parts = String(r.t || "").split(" + ").map(s => s.trim());
            if (parts.includes(name)) {
              runs.push({ map, duration_s: r.d, difficulty: r.f, timestamp: r.ts,
                          mode: "team",
                          url: r.g ? "https://openfront.io/game/" + r.g : null });
            }
          }
        }
      }
    }
  } catch (e) { /* payload indisponible */ }

  // Dédoublonnage par URL de replay, tri par temps croissant
  const seen = new Set(); const out = [];
  for (const r of runs.sort((a, b) => a.duration_s - b.duration_s)) {
    const k = r.url || (r.map + "|" + r.duration_s);
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return { source: "payload", runs: out };
}

function formatSpeedrunTime(s) {
  if (s == null || isNaN(s)) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

/**
 * Rendu du profil public speedrun dans la vue profile-main :
 * hero (renderPublicProfile sans publicId) + carte « Records Speedrun »
 * montée dans #pf2-weekly-top. Les blocs du profil complet qui resteraient
 * vides (cartes stats, colonnes) sont masqués.
 */
async function renderSpeedrunPublicProfile(username) {
  // Résolution d'un éventuel compte lié : si ce pseudo en jeu correspond
  // (normalisé) à un compte avec skin actif, on affine le héros (pseudo hub
  // + badge Public ID) tout en gardant la carte Records Speedrun.
  let resolvedPid = null;
  try {
    const { byNormPid } = await fetchActiveSkinMap();
    resolvedPid = (byNormPid && byNormPid.get(normPlayerName(username))) || null;
  } catch (e) { /* skins indisponibles — non bloquant */ }
  // Déclare le profil consulté comme ÉTRANGER : viewingPublicId non null
  // verrouille editingAllowed (reward card, éditeur) même si le joueur est lié.
  viewingPublicId = resolvedPid || "__speedrun__";
  viewingUsername = username;
  renderPublicProfile(username, resolvedPid);
  if (resolvedPid) {
    const badgeText = document.getElementById("profile-public-badge-text");
    const badgeBtn = document.getElementById("profile-public-badge");
    if (badgeText) badgeText.textContent = resolvedPid;
    if (badgeBtn) { badgeBtn.dataset.pid = resolvedPid; badgeBtn.style.display = ""; }
  }

  // Masque les sections réservées au profil complet (données API absentes ici)
  document.querySelectorAll("#profile-main .pf2-stats, #profile-main .pf2-columns")
    .forEach(el => { el.style.display = "none"; });

  // Skin cosmétique par PSEUDO (joueurs VIP non liés) — map publique des skins actifs
  try {
    const { byNorm } = await fetchActiveSkinMap();
    const skinId = byNorm && byNorm.get(normPlayerName(username));
    if (skinId) {
      const span = document.querySelector("#profile-title-name span");
      if (span) span.classList.add(getSkin(skinId).cssClass);
    }
  } catch (e) { /* skins indisponibles — non bloquant */ }

  const mount = document.getElementById("pf2-weekly-top");
  if (!mount) return;
  mount.innerHTML = '<div class="pfsr-loading">' + T("pf.speedrun_loading", "Chargement des records speedrun…") + '</div>';

  const { runs } = await loadSpeedrunPublicData(username);
  const mapsCount = new Set(runs.map(r => r.map)).size;
  const best = runs.length ? runs[0].duration_s : null;

  const MODE_LABEL = { solo: "Solo", team: T("pf.mode_team", "Équipe") };
  const rowsHtml = runs.length
    ? runs.slice(0, 40).map(r => {
        const thumb = mapThumbUrl(r.map);
        const date = r.timestamp
          ? new Date(r.timestamp).toLocaleDateString(LOCALE(), { day: "numeric", month: "short", year: "numeric" })
          : "";
        return '<div class="pfsr-row">'
          + '<div class="pfsr-map">' + (thumb ? '<img class="pfsr-thumb" src="' + thumb + '" alt="" loading="lazy">' : '')
          + '<span>' + esc(r.map) + '</span></div>'
          + '<span class="pfsr-mode">' + (MODE_LABEL[r.mode] || "") + '</span>'
          + (r.difficulty ? '<span class="pfsr-diff">' + esc(r.difficulty) + '</span>' : '')
          + '<span class="pfsr-time">' + formatSpeedrunTime(r.duration_s) + '</span>'
          + '<span class="pfsr-date">' + esc(date) + '</span>'
          + (r.url ? '<a class="pfsr-replay" href="' + esc(r.url) + '" target="_blank" rel="noopener" title="' + T("pf.view_replay", "Voir le replay") + '">▶</a>' : '<span class="pfsr-replay"></span>')
          + '</div>';
      }).join("")
    : '<div class="pfsr-empty">' + T("pf.speedrun_empty", "Aucun record trouvé dans les données publiées pour ce pseudo.") + '</div>';

  mount.innerHTML = ''
    + '<section class="pf2-panel pfsr-card" aria-label="Records speedrun">'
    +   '<header class="pf2-panel-head"><h3>' + T("pf.speedrun_title", "Records Speedrun") + '</h3><i class="pf2-panel-rule"></i></header>'
    +   '<div class="pfsr-chips">'
    +     '<span class="pfsr-chip"><b>' + runs.length + '</b> ' + (runs.length > 1 ? T("pf.wins", "victoires") : T("pf.win", "victoire")) + '</span>'
    +     '<span class="pfsr-chip"><b>' + mapsCount + '</b> ' + (mapsCount > 1 ? T("pf.maps_many", "cartes") : T("pf.map_one", "carte")) + '</span>'
    +     '<span class="pfsr-chip"><b>' + formatSpeedrunTime(best) + '</b> ' + T("pf.best_time_chip", "meilleur temps") + '</span>'
    +   '</div>'
    +   '<div class="pfsr-runs">' + rowsHtml + '</div>'
    +   '<p class="pfsr-note">' + T("pf.speedrun_note_html", "Profil public limité aux speedruns — ce joueur n'a pas encore lié son compte TheFrontHub. <a href=\"index.html\">Me connecter avec Discord</a> pour un profil complet (Elo, niveau, historique).") + '</p>'
    + '</section>';
}

/* ── Sidebar / dropdown UI ── */

function updateSidebarUI(user, profile) {
  const loginBtn = document.getElementById("login-btn-main");
  const userContainer = document.getElementById("user-container");
  if (!user) {
    if (loginBtn) loginBtn.style.display = "flex";
    if (userContainer) { userContainer.style.display = "none"; userContainer.classList.remove("open"); }
    return;
  }
  if (loginBtn) loginBtn.style.display = "none";
  if (userContainer) userContainer.style.display = "block";

  const name = profile?.username || user.displayName || user.email || T("pf.player_default", "Joueur");
  const publicId = profile?.publicId || T("auth.not_linked", "Non lié");

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText("user-display-name", name);
  setText("user-public-id-side", profile?.publicId || T("auth.dropdown_online", "En ligne"));
  setText("dropdown-username-display", name);
  setText("dropdown-publicid-display", publicId);

  const avatarEl = document.getElementById("dropdown-avatar");
  if (avatarEl) {
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${esc(user.photoURL)}" alt="${esc(name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      avatarEl.textContent = (name || "U").substring(0, 2).toUpperCase();
      avatarEl.style.background = "linear-gradient(135deg,var(--accent),var(--accentL))";
    }
  }
}

/* ── Main view: hero ── */

function renderHero(user, profile) {
  const nameEl = document.getElementById("profile-title-name");
  if (nameEl) {
    nameEl.innerHTML = "";
    const skinSpan = document.createElement("span");
    skinSpan.textContent = profile.username || user.displayName || T("pf.player_default", "Joueur");
    nameEl.appendChild(skinSpan);
    applySkinToElement(skinSpan, profile.publicId, true);
  }

  // Chip Public ID copiable (bouton pf2-id-pid)
  const badgeEl = document.getElementById("profile-public-badge-text");
  if (badgeEl) badgeEl.textContent = profile.publicId || "—";
  const pidBtn = document.getElementById("profile-public-badge");
  if (pidBtn) {
    pidBtn.dataset.pid = profile.publicId || "";
    pidBtn.style.display = profile.publicId ? "" : "none";
  }

  // Badge « vérifié » (v5.13 : preuve serveur — profile.verified = verified_at posé
  // par la vérification du défi en jeu côté serveur). Info-bulle explicite.
  const verifiedEl = document.getElementById("profile-verified");
  if (verifiedEl) {
    const tip = T("pf.verified_tip", "Joueur vérifié — cette personne est vérifiée (identité prouvée en jeu)");
    verifiedEl.title = tip;
    verifiedEl.hidden = !profile.verified;
  }

  // v5.13 — Bio / map préférée / liens réseaux + bouton d'édition
  renderProfileExtras({
    bio: profile.bio,
    favMap: profile.favMap,
    links: profile.links,
  });
  // v5.14 — Vitrine cosmétiques du profil propre (fetch dédié, guard anti-course)
  if (profile.publicId) void loadShowcase(profile.publicId);
  const editBtn = document.getElementById("profile-edit-btn");
  if (editBtn) editBtn.hidden = !profile.verified;

  // Éditeur de pseudo : SEULEMENT si le profil affiché est celui du compte
  // connecté (connecté + publicId lié). Tout autre cas reste verrouillé.
  setEditingAllowed(!!currentUser && !!profile.publicId);

  // Date d'arrivée (profile.createdAt)
  const joinedEl = document.getElementById("profile-joined-text");
  if (joinedEl) {
    joinedEl.textContent = profile.createdAt
      ? T("pf.member_since", "Membre depuis le {date}", { date: formatDateShort(profile.createdAt) })
      : T("pf.member", "Membre");
    joinedEl.parentElement.style.display = profile.createdAt ? "" : "none";
  }

  // Masque la bannière "Profil public" (flux normal = propre profil)
  const banner = document.getElementById("public-profile-banner");
  if (banner) banner.style.display = "none";

  // Ré-affiche le bouton de déconnexion (flux normal)
  const logoutBtn = document.querySelector(".pf-logout-btn");
  if (logoutBtn) logoutBtn.style.display = "";

  const avatarEl = document.getElementById("profile-avatar-large");
  if (avatarEl) {
    // Avatar dégradé + initiale (design system — cohérent avec la sidebar)
    avatarEl.innerHTML = "";
    avatarEl.textContent = (profile.username || user.displayName || "J").charAt(0).toUpperCase();
  }

  // Cockpit: ensure #cockpit-status-meta exists inside the header card.
  // Populated later by renderPrecomputedStats with level/playtime/streak chips.
  const metaEl = document.getElementById("cockpit-status-meta");
  if (metaEl) metaEl.innerHTML = "";

  // Applique le skin VIP résolu par publicId (le listener VIP re-appliquera quand
  // les rewards arriveront). Fallback username = null ici car pas encore chargé.
  applyProfileSkin(profile, null);

  // Bannière pixel art de la plaquette (slot indépendant des skins —
  // bannière active du profil affiché, clair/sombre re-rendus par banners.js).
  applyBannerToCard(document.querySelector(".pf2-id"), profile.publicId);
}

/* ═════════════════════════════════════════════════════════════════════════
   v5.13 — PROFIL REVENDIQUÉ : bio, map préférée, liens réseaux
   Rendu du bloc identité (propre profil = données du compte ; profil public
   = réponse route=profile). Édition via la modale #profile-edit-modal.
   ═════════════════════════════════════════════════════════════════════════ */

/** Icônes réseaux : window.icon (icons.js) ou repli autonome minimal. */
function linkIcon(name) {
  try {
    if (typeof window !== "undefined" && typeof window.icon === "function") {
      return window.icon(name, { size: 14 });
    }
  } catch (e) { /* ignore */ }
  return "";
}

/** URL cliquable d'un champ réseau (tolère handle, @pseudo ou lien complet). */
function linkHref(net, raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const clean = v.replace(/^@/, "");
  if (net === "x") return "https://x.com/" + encodeURIComponent(clean);
  if (net === "youtube") return "https://youtube.com/" + encodeURIComponent(v.startsWith("@") ? v : clean);
  if (net === "twitch") return "https://twitch.tv/" + encodeURIComponent(clean);
  return null; // discord : pseudo/invitation affiché sans lien automatique
}

/**
 * Peint bio / map préférée / liens dans la carte identité.
 * @param {{bio?:string|null, favMap?:string|null, links?:object|null}|null} extras
 */
function renderProfileExtras(extras) {
  const bioEl = document.getElementById("profile-bio");
  const mapEl = document.getElementById("profile-favmap");
  const linksEl = document.getElementById("profile-links");

  const bio = extras?.bio ? String(extras.bio) : "";
  if (bioEl) {
    if (bio) {
      bioEl.textContent = bio;
      bioEl.hidden = false;
    } else {
      bioEl.textContent = "";
      bioEl.hidden = true;
    }
  }

  const fm = extras?.favMap ? String(extras.favMap) : "";
  if (mapEl) {
    if (fm) {
      const thumb = mapThumbUrl(fm);
      mapEl.innerHTML =
        '<span class="pf2-id-favmap-label">' + esc(T("pf.fav_map", "Map préférée")) + "</span>" +
        (thumb ? '<img class="pf2-id-favmap-thumb" src="' + esc(thumb) + '" alt="" width="26" height="26" loading="lazy">' : "") +
        "<b>" + esc(fm) + "</b>";
      mapEl.hidden = false;
    } else {
      mapEl.innerHTML = "";
      mapEl.hidden = true;
    }
  }

  if (linksEl) {
    const links = extras?.links || {};
    const items = [];
    const push = (net, iconName, label) => {
      const raw = links[net];
      if (!raw) return;
      const href = linkHref(net, raw);
      items.push(
        href
          ? '<a class="pf2-id-link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" title="' + esc(label + " : " + raw) + '">' + linkIcon(iconName) + "<span>" + esc(raw) + "</span></a>"
          : '<span class="pf2-id-link pf2-id-link-plain" title="' + esc(label + " : " + raw) + '">' + linkIcon(iconName) + "<span>" + esc(raw) + "</span></span>"
      );
    };
    push("x", "xSocial", "X");
    push("youtube", "youtube", "YouTube");
    push("twitch", "twitch", "Twitch");
    push("discord", "discord", "Discord");
    linksEl.innerHTML = items.join("");
    linksEl.hidden = items.length === 0;
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   v5.14 — VITRINE COSMÉTIQUES
   Deux sources reliées au profil :
   1. Cosmétiques OpenFront portés EN JEU (collectés par le cron du site ;
      route=profile → cosmetics[] : motifs, couronnes, drapeaux, effets…
      avec la rareté du catalogue officiel + le nombre de parties portés).
   2. Cosmétiques TheFrontHub (skins texte animés, bannières pixel art,
      statut VIP — route=profile → hubCosmetics).
   Rendu sur le profil PROPRE (fetch dédié) et sur les profils PUBLICS
   (réponse déjà chargée — zéro requête supplémentaire).
   ═════════════════════════════════════════════════════════════════════════ */

const SHOWCASE_CAT_ICON = {
  pattern: "🎨", crown: "👑", flag: "🏴", skin: "👕",
  effect: "✨", emblem: "🛡️", palette: "🌈", pack: "📦",
};
const SHOWCASE_RARITY_COLORS = {
  common: "#6B7280", uncommon: "#0d9488", rare: "#2563eb",
  epic: "#9333ea", legendary: "#d97706", mythic: "#dc2626",
};

let _showcaseSeq = 0; // garde anti-course (changement de profil rapide)

const SHOWCASE_KNOWN_RARITIES = new Set(["common", "uncommon", "rare", "epic", "legendary", "mythic"]);

function showcaseRarityChip(rarity) {
  const r = String(rarity || "").toLowerCase();
  if (!r) return ""; // rareté inconnue (ex : drapeaux) → pas de chip
  if (!SHOWCASE_KNOWN_RARITIES.has(r)) {
    // Rareté inédite du catalogue → libellé capitalisé brut (jamais la clé i18n)
    const color = "#6B7280";
    return '<span class="pf-sc-rarity" style="color:' + esc(color) +
      ';background:' + esc(color) + '1f;border-color:' + esc(color) + '44">' +
      esc(r.charAt(0).toUpperCase() + r.slice(1)) + "</span>";
  }
  const label = T(
    "pf.showcase_rarity_" + r,
    r.charAt(0).toUpperCase() + r.slice(1)
  );
  const color = SHOWCASE_RARITY_COLORS[r] || "#6B7280";
  return '<span class="pf-sc-rarity" style="color:' + esc(color) +
    ';background:' + esc(color) + '1f;border-color:' + esc(color) + '44">' +
    esc(label) + "</span>";
}

const SHOWCASE_KNOWN_CATS = new Set(["pattern", "crown", "flag", "skin", "effect", "emblem", "palette", "pack"]);

function showcaseCatLabel(cat) {
  const c = String(cat || "").toLowerCase();
  if (!c) return "";
  if (!SHOWCASE_KNOWN_CATS.has(c)) return c.charAt(0).toUpperCase() + c.slice(1);
  return T("pf.showcase_cat_" + c, c.charAt(0).toUpperCase() + c.slice(1));
}

/** Carte d'un cosmétique OpenFront porté en jeu.
 * Cas réels observés dans les données :
 *  - c.url renseignée (couronnes, skins) → image CDN ;
 *  - c.name EST l'URL CDN (drapeaux portés) → image depuis le nom,
 *    libellé dérivé du segment final (cc_youtube_ → YouTube) ;
 *  - c.patternData renseigné (motifs du catalogue, v5.15) → canvas décodé ;
 *  - c.name relatif « /flags/SPQR.svg » (drapeaux de nations, v5.22) →
 *    miroir GitHub du dépôt officiel OpenFrontIO ;
 *  - catalogue officiel chargé en fond (v5.22) → name → url pour tout ce
 *    que le cache serveur n'a pas (couronnes/drapeaux « aléatoires ») ;
 *  - sinon (effets, patterns sans données) → icône de catégorie. */
function showcaseCosVisual(c) {
  let url = c.url ? String(c.url) : "";
  let patternData = String(c.patternData || "");
  let label = c.displayName || c.name;
  if (!url && /^https?:\/\//i.test(String(c.name || ""))) {
    url = encodeURI(String(c.name));
    try {
      const seg = String(c.name).split("/").filter(Boolean).pop() || "";
      let tail = seg.replace(/^cc_/, "").replace(/_+$/, "").replace(/_+/g, " ").trim();
      if (tail) {
        label = tail.charAt(0).toUpperCase() + tail.slice(1);
      } else {
        label = "";
      }
    } catch (e) { /* label resté = name */ }
  }
  // v5.22 — drapeaux relatifs (« /flags/SPQR.svg ») → dépôt officiel (1000 drapeaux)
  if (!url && !patternData && /^\/flags\//i.test(String(c.name || ""))) {
    url = "https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources" +
      encodeURI(String(c.name));
    try {
      const seg = String(c.name).split("/").pop().replace(/\.svg$/i, "");
      if (seg) label = seg.replace(/_/g, " ").trim() || label;
    } catch (e) { /* label resté */ }
  }
  // v5.22 — catalogue officiel en fond : name → url (cache serveur incomplet)
  if (!url && !patternData) {
    const cat = window.__ofCosmeticsMap;
    const nm = String(c.name || "");
    if (cat && cat[nm]) url = cat[nm];
  }
  // v5.23 — patterns sans bitmap en base (« aléatoires » sans image) :
  // le catalogue officiel fournit le bitmap officiel (name → pattern).
  if (!url && !patternData && String(c.category || "").toLowerCase() === "pattern") {
    const pats = window.__ofCosmeticsPatterns;
    const nm = String(c.name || "");
    if (pats && pats[nm]) patternData = pats[nm];
  }
  return { url, label, patternData };
}

function showcaseWornCard(c) {
  const { url, label, patternData } = showcaseCosVisual(c);
  const name = label || showcaseCatLabel(c.category);
  const icon = SHOWCASE_CAT_ICON[String(c.category || "").toLowerCase()] || "🧩";
  let img;
  if (patternData) {
    // Motif OpenFront : bitmap décodé et peint après insertion (paintShowcasePatterns).
    img = '<canvas class="pf-sc-canvas" width="40" height="40" data-pattern="' + esc(patternData) +
      '" role="img" aria-label="' + esc(name) + '"></canvas>' +
      '<span class="pf-sc-emoji" style="display:none">' + icon + "</span>";
  } else if (url) {
    img = '<img class="pf-sc-img" src="' + esc(url) + '" alt="" width="40" height="40" loading="lazy" ' +
      'referrerpolicy="no-referrer" decoding="async" ' +
      'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
      '<span class="pf-sc-emoji" style="display:none">' + icon + "</span>";
  } else {
    img = '<span class="pf-sc-emoji">' + icon + "</span>";
  }
  return (
    '<article class="pf-sc-card">' +
      '<div class="pf-sc-thumb">' + img + "</div>" +
      '<div class="pf-sc-body">' +
        '<div class="pf-sc-name" title="' + esc(name) + '">' + esc(name) + "</div>" +
        '<div class="pf-sc-meta">' + showcaseRarityChip(c.rarity) + "</div>" +
        '<div class="pf-sc-sub">' + esc(showcaseCatLabel(c.category)) +
          " · " + esc(T("pf.showcase_worn", "porté ×{n}", { n: c.timesWorn })) + "</div>" +
      "</div>" +
    "</article>"
  );
}

/** Peint tous les canvas[data-pattern] du conteneur (après injection innerHTML). */
function paintShowcasePatterns(root) {
  if (!root) return;
  root.querySelectorAll("canvas[data-pattern]").forEach((cv) => {
    const data = cv.getAttribute("data-pattern") || "";
    if (!data || !paintPatternToCanvas(cv, data, 40)) {
      // décodage impossible → repli emoji (comme avant la v5.15)
      cv.remove();
      const fb = cv.nextElementSibling;
      if (fb && fb.classList.contains("pf-sc-emoji")) fb.style.display = "flex";
      return;
    }
    cv.removeAttribute("data-pattern");
  });
}

/** Cartes des cosmétiques TheFrontHub (VIP, skins animés, bannières pixel art). */
function showcaseHubCards(hub) {
  const cards = [];
  if (hub?.vipActive && hub?.vipType) {
    cards.push(
      '<article class="pf-sc-card pf-sc-vip">' +
        '<div class="pf-sc-thumb"><span class="pf-sc-emoji">👑</span></div>' +
        '<div class="pf-sc-body">' +
          '<div class="pf-sc-name">' + esc(String(hub.vipType).toUpperCase()) + "</div>" +
          '<div class="pf-sc-meta">' +
            '<span class="pf-sc-rarity" style="color:#d97706;background:#d977061f;border-color:#d9770644">' +
              esc(T("pf.showcase_vip", "Statut VIP")) + "</span>" +
          "</div>" +
          '<div class="pf-sc-sub">' + esc(T("pf.showcase_hub", "TheFrontHub")) + "</div>" +
        "</div>" +
      "</article>"
    );
  }
  const ownedSkins = Array.isArray(hub?.ownedSkins) ? hub.ownedSkins : [];
  for (const s of ownedSkins) {
    const skin = getSkin(s.skinId);
    if (!skin || skin.id === DEFAULT_SKIN_ID) continue; // Standard ≠ cosmétique
    const active = !!s.active || s.skinId === hub.activeSkinId;
    cards.push(
      '<article class="pf-sc-card' + (active ? " pf-sc-active" : "") + '">' +
        '<div class="pf-sc-thumb"><span class="pf-sc-skin-preview ' + skin.cssClass + '">Aa</span></div>' +
        '<div class="pf-sc-body">' +
          '<div class="pf-sc-name">' + esc(skin.name) + "</div>" +
          '<div class="pf-sc-meta">' + showcaseRarityChip(skin.rarity) +
            (active ? '<span class="pf-sc-on">' + esc(T("pf.showcase_active", "Actif")) + "</span>" : "") + "</div>" +
          '<div class="pf-sc-sub">' + esc(T("pf.showcase_hub_skin", "Skin TheFrontHub")) + "</div>" +
        "</div>" +
      "</article>"
    );
  }
  const ownedBanners = Array.isArray(hub?.ownedBanners) ? hub.ownedBanners : [];
  for (const b of ownedBanners) {
    const banner = getBanner(b.bannerId);
    if (!banner) continue;
    const active = !!b.active || b.bannerId === hub.activeBannerId;
    let thumb;
    try {
      const url = renderBannerUrl(banner, currentTheme());
      thumb = url
        ? '<img class="pf-sc-img pf-sc-banner" src="' + url + '" alt="" width="40" height="28" loading="lazy">'
        : '<span class="pf-sc-emoji">🚩</span>';
    } catch (e) {
      thumb = '<span class="pf-sc-emoji">🚩</span>';
    }
    cards.push(
      '<article class="pf-sc-card' + (active ? " pf-sc-active" : "") + '">' +
        '<div class="pf-sc-thumb">' + thumb + "</div>" +
        '<div class="pf-sc-body">' +
          '<div class="pf-sc-name">' + esc(banner.name) + "</div>" +
          '<div class="pf-sc-meta">' + showcaseRarityChip(banner.rarity) +
            (active ? '<span class="pf-sc-on">' + esc(T("pf.showcase_active", "Actif")) + "</span>" : "") + "</div>" +
          '<div class="pf-sc-sub">' + esc(T("pf.showcase_hub_banner", "Bannière TheFrontHub")) + "</div>" +
        "</div>" +
      "</article>"
    );
  }
  return cards;
}

/** Peint la vitrine depuis une réponse route=profile (propre ou public). */
let _lastShowcaseData = null; // v5.22 — re-rendu après arrivée du catalogue officiel
function renderShowcaseFromData(data) {
  const root = document.getElementById("profile-showcase");
  if (!root) return;
  _lastShowcaseData = data || null;
  const worn = Array.isArray(data?.cosmetics) ? data.cosmetics : [];
  const hubCards = showcaseHubCards(data?.hubCosmetics || {});
  if (!worn.length && !hubCards.length) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  const sparkle =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>';
  const wornHtml = worn.length
    ? '<h3 class="pf-sc-title">' +
      esc(T("pf.showcase_worn_title", "Cosmétiques OpenFront — portés en jeu")) +
      '</h3><div class="pf-sc-grid">' + worn.map(showcaseWornCard).join("") + "</div>"
    : "";
  const hubHtml = hubCards.length
    ? '<h3 class="pf-sc-title">' +
      esc(T("pf.showcase_hub_title", "Cosmétiques TheFrontHub")) +
      '</h3><div class="pf-sc-grid">' + hubCards.join("") + "</div>"
    : "";
  root.innerHTML =
    '<h2 class="pf-sc-heading">' + sparkle +
      "<span>" + esc(T("pf.showcase_title", "Vitrine cosmétiques")) + "</span></h2>" +
    wornHtml + hubHtml;
  root.hidden = false;
  // v5.15 — peint les motifs (canvas) + emblème du héros (motif le plus récent)
  paintShowcasePatterns(root);
  paintAvatarFromCosmetics(worn);
  // v5.22 — si des cartes n'ont pas d'image (cache serveur incomplet), charge
  // le catalogue officiel en fond puis re-rend la vitrine quand il arrive.
  // v5.23 : inclut les PATTERNS sans bitmap (le catalogue officiel fournit
  // le bitmap officiel — ex: « jr_piracy » présent en base sans patternData).
  if (worn.some((c) => c && !c.url && !c.patternData &&
      !/^https?:\/\//i.test(String(c.name || "")) &&
      !/^\/flags\//i.test(String(c.name || "")))) {
    loadCosmeticsCatalogue();
  }
}

/* v5.22 — catalogue officiel OpenFront chargé en fond (proxy worker /cosmetics,
 * compacté + cache 6 h, repli api.openfront.io direct) → map name → url.
 * Répare les vitrines dont la ligne catalogue en base est absente
 * (couronnes/drapeaux affichés « au hasard » sans image). */
let _cosmeticsMapLoading = false;
function loadCosmeticsCatalogue() {
  if (window.__ofCosmeticsMap || _cosmeticsMapLoading) return;
  _cosmeticsMapLoading = true;
  const BASES = [
    "https://openfront-proxy.diofortnite3.workers.dev/cosmetics",
    "https://api.openfront.io/cosmetics.json",
  ];
  // Aplatit les formes possibles : tableaux (worker) ou objets par nom (catalogue brut)
  const flatten = (v) => {
    const out = [];
    const walk = (x) => {
      if (!x) return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (typeof x === "object") {
        if (typeof x.name === "string") { out.push(x); return; }
        Object.values(x).forEach(walk);
      }
    };
    walk(v);
    return out;
  };
  const tryFetch = async (i) => {
    if (i >= BASES.length) return null;
    try {
      const res = await fetch(BASES[i], { cache: "force-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) { return tryFetch(i + 1); }
  };
  tryFetch(0).then((d) => {
    _cosmeticsMapLoading = false;
    if (!d) return;
    const map = {};
    [d.patterns, d.flags, d.crowns, d.skins, d.effects].forEach((group) => {
      flatten(group).forEach((v) => {
        if (v && typeof v.name === "string" && typeof v.url === "string" && v.url) {
          map[v.name] = v.url;
        }
      });
    });
    // v5.23 — bitmaps officiels des motifs (name → pattern) : répare les
    // vitrines dont la base n'a PAS le patternData (fallback emoji avant).
    const pats = {};
    flatten(d.patterns).forEach((v) => {
      if (v && typeof v.name === "string" && typeof v.pattern === "string" && v.pattern) {
        pats[v.name] = v.pattern;
      }
    });
    const hasUrls = Object.keys(map).length > 0;
    const hasPatterns = Object.keys(pats).length > 0;
    if (!hasUrls && !hasPatterns) return;
    if (hasUrls) window.__ofCosmeticsMap = map;
    if (hasPatterns) window.__ofCosmeticsPatterns = pats;
    if (_lastShowcaseData) renderShowcaseFromData(_lastShowcaseData);
  }).catch(() => { _cosmeticsMapLoading = false; });
}

/** Charge puis peint la vitrine du profil PROPRE (fetch dédié, garde anti-course). */
async function loadShowcase(publicId) {
  const root = document.getElementById("profile-showcase");
  if (!root || !publicId) return;
  const seq = ++_showcaseSeq;
  try {
    // v5.36 — payload partagé (prefetch/sessionStorage/cache serveur), plus de
    // requête dédiée : la vitrine peint avec les données déjà en main.
    const j = await getProfilePayload(publicId);
    if (!j || seq !== _showcaseSeq) {
      if (seq === _showcaseSeq) { root.hidden = true; root.innerHTML = ""; }
      return;
    }
    renderShowcaseFromData(j);
  } catch (e) {
    if (seq === _showcaseSeq) { root.hidden = true; }
  }
}

/* ── Modale d'édition (propre profil revendiqué uniquement) ── */

window.openProfileEditor = function () {
  if (!editingAllowed || viewingPublicId) {
    showToast(T("pf.edit_lock", "Tu ne peux modifier que ton propre profil."), "warning");
    return;
  }
  if (!currentProfile || !currentProfile.publicId) {
    showToast(T("pf.link_pid_first", "Lie d'abord ton Public ID OpenFront avant de personnaliser ton profil."), "warning");
    return;
  }
  const modal = document.getElementById("profile-edit-modal");
  if (!modal) return;
  const bio = currentProfile.bio || "";
  const bioEl = document.getElementById("pem-bio");
  const cnt = document.getElementById("pem-bio-count");
  if (bioEl) bioEl.value = bio;
  if (cnt) cnt.textContent = bio.length + "/400";
  const fm = document.getElementById("pem-favmap");
  if (fm) fm.value = currentProfile.favMap || "";
  const links = currentProfile.links || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
  set("pem-link-x", links.x);
  set("pem-link-youtube", links.youtube);
  set("pem-link-twitch", links.twitch);
  set("pem-link-discord", links.discord);
  // Datalist des cartes : noms connus + cartes les plus jouées du joueur
  const dl = document.getElementById("pem-map-list");
  if (dl) {
    const names = new Set(Object.keys(MAP_SLUGS).map((s) => s.charAt(0).toUpperCase() + s.slice(1)));
    if (currentProfile.favMap) names.add(currentProfile.favMap);
    dl.innerHTML = Array.from(names).sort().map((n) => '<option value="' + esc(n) + '">').join("");
  }
  modal.hidden = false;
  document.body.style.overflow = "hidden";
};

window.closeProfileEditor = function () {
  const modal = document.getElementById("profile-edit-modal");
  if (modal) modal.hidden = true;
  document.body.style.overflow = "";
};

window.saveProfileDetails = async function () {
  const btn = document.getElementById("pem-save");
  const original = btn?.textContent || "";
  if (btn) { btn.disabled = true; btn.textContent = T("pf.saving", "Enregistrement…"); }
  try {
    const payload = {
      action: "details",
      bio: document.getElementById("pem-bio")?.value ?? "",
      favMap: document.getElementById("pem-favmap")?.value ?? "",
      links: {
        x: document.getElementById("pem-link-x")?.value ?? "",
        youtube: document.getElementById("pem-link-youtube")?.value ?? "",
        twitch: document.getElementById("pem-link-twitch")?.value ?? "",
        discord: document.getElementById("pem-link-discord")?.value ?? "",
      },
    };
    const res = await fetch("/api/profile.php", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      if (j?.error === "not_claimed") {
        showToast(T("pf.not_claimed", "Revendique d'abord ton profil (Public ID + vérification en jeu)."), "warning");
      } else if (j?.error === "invalid_link") {
        showToast(T("pf.bad_link", "Un des liens est invalide."), "error");
      } else {
        showToast(j?.message || T("pf.save_fail", "Impossible d'enregistrer. Réessaie."), "error");
      }
      return;
    }
    // Mise à jour locale + re-rendu immédiat
    const p = j.profile || {};
    currentProfile = { ...(currentProfile || {}), bio: p.bio ?? null, favMap: p.favMap ?? null, links: p.links ?? {} };
    renderProfileExtras({
      bio: currentProfile.bio,
      favMap: currentProfile.favMap,
      links: currentProfile.links,
    });
    window.closeProfileEditor();
    showToast(T("pf.profile_updated", "Profil mis à jour !"), "success");
  } catch (e) {
    console.error("[profile] saveProfileDetails:", e);
    showToast(T("pf.save_fail", "Impossible d'enregistrer. Réessaie."), "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
};

// Compteur de caractères de la bio (feedback live)
document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "pem-bio") {
    const cnt = document.getElementById("pem-bio-count");
    if (cnt) cnt.textContent = (e.target.value || "").length + "/400";
  }
});
// Fermeture de la modale : clic sur le fond + touche Escape
document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "profile-edit-modal") window.closeProfileEditor();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modal = document.getElementById("profile-edit-modal");
    if (modal && !modal.hidden) window.closeProfileEditor();
  }
});

/** Copie le Public ID dans le presse-papiers (chip de la carte identité). */
window.copyPublicId = function (btn) {
  const pid = btn?.dataset?.pid || (currentProfile && currentProfile.publicId) || "";
  if (!pid) return;
  const done = () => showToast(T("pf.pid_copied", "Public ID copié : {id}", { id: pid }), "success");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(pid).then(done).catch(() => {
      showToast(T("pf.pid_show", "Public ID : {id}", { id: pid }), "info");
    });
  } else {
    showToast(T("pf.pid_show", "Public ID : {id}", { id: pid }), "info");
  }
};

/* ── Éditeur de pseudo (2026-09-03) ───────────────────────────────
 * Le pseudo choisi ici devient LE pseudo du joueur PARTOUT sur le site
 * (profil, classements hebdo/all-time, classé, speedruns, feed) via la
 * table publique tfh_public_aliases (pseudo hub ↔ publicId). */
window.togglePseudoEditor = function (show) {
  if (show && !editingAllowed) {
    // Verrou : l'édition n'est possible que sur SON propre profil, connecté.
    showToast(T("pf.pseudo_lock", "Tu ne peux modifier que ton propre pseudo — connecte-toi et va sur ton profil."), "warning");
    return;
  }
  const ed = document.getElementById("pseudo-editor");
  if (!ed) return;
  ed.hidden = !show;
  if (show) {
    const input = document.getElementById("edit-pseudo-input");
    if (input) {
      input.value = (currentProfile && currentProfile.username) || "";
      setTimeout(() => input.focus(), 30);
    }
  }
};

window.savePseudoChange = async function () {
  if (!editingAllowed) {
    showToast(T("pf.pseudo_lock", "Tu ne peux modifier que ton propre pseudo — connecte-toi et va sur ton profil."), "warning");
    return;
  }
  if (!currentUser) { showToast(T("pf.login_first", "Connecte-toi d'abord."), "warning"); return; }
  const input = document.getElementById("edit-pseudo-input");
  const newPseudo = (input?.value || "").trim();
  const current = (currentProfile && currentProfile.username) || "";
  if (!newPseudo) { showToast(T("pf.pseudo_required", "Entre un pseudo."), "warning"); return; }
  if (newPseudo === current) { togglePseudoEditor(false); return; }
  if (!/^[A-Za-z0-9_.\- ]{3,32}$/.test(newPseudo)) {
    showToast(T("pf.pseudo_invalid", "Pseudo : 3 à 32 caractères (lettres, chiffres, . _ - espace)."), "warning");
    return;
  }
  const pid = currentProfile && currentProfile.publicId;
  if (!pid) {
    showToast(T("pf.link_pid_first", "Lie d'abord ton Public ID OpenFront avant de choisir un pseudo."), "warning");
    return;
  }
  const saveBtn = document.querySelector("#pseudo-editor .pf2-pseudo-save");
  const original = saveBtn?.textContent || T("profile.save", "Enregistrer");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = T("pf.saving", "Enregistrement…"); }
  try {
    // → POST /api/profile.php (via le pont auth.js) : met à jour tfh_users
    // + tfh_public_aliases (pseudo public) + tfh_public_rewards.
    await setDoc(doc(db, "users", currentUser.uid), {
      username: newPseudo,
      publicId: pid,
    }, { merge: true });
    currentProfile = { ...(currentProfile || {}), username: newPseudo, publicId: pid };
    // Rafraîchit la map locale des pseudos hub (affichage immédiat)
    _hubNamesByPid.set(String(pid), newPseudo);
    _hubNamesByNorm.set(normPlayerName(newPseudo), String(pid));
    showToast(T("pf.pseudo_updated", "Pseudo mis à jour : {name} — il s'affiche maintenant partout !", { name: newPseudo }), "success", 5000);
    togglePseudoEditor(false);
    updateSidebarUI(currentUser, currentProfile);
    renderHero(currentUser, currentProfile);
  } catch (e) {
    console.error("[profile] Changement de pseudo échoué:", e);
    if (e?.code === "already_taken") {
      showToast(T("pf.pseudo_taken", "Ce pseudo est déjà utilisé par un autre compte."), "error");
    } else if (e?.code === "invalid_username") {
      showToast(T("pf.pseudo_invalid2", "Pseudo invalide : 3 à 32 caractères (lettres, chiffres, . _ - espace)."), "error");
    } else {
      showToast(T("pf.pseudo_fail", "Impossible de modifier le pseudo. Réessaie."), "error");
    }
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = original; }
  }
};

/* ── Main view: load stats ── */

async function loadStats(publicId) {
  // Reset stat cards + panneau Elo pendant le chargement
  setText("stat-alltime-value", "…");
  setText("stat-alltime-sub", "");
  hideError();
  const eloPanel = document.getElementById("pf2-elo-panel");
  if (eloPanel) eloPanel.hidden = true;
  const peersPanel = document.getElementById("pf2-peers-panel");
  if (peersPanel) peersPanel.hidden = true;

  // Kick off ELO lookup (ranked.json) in parallel
  const eloPromise = getRankedEntry(publicId);

  // v5.36 — payload PRÉ-GÉNÉRÉ d'abord (pf-prefetch/sessionStorage/cache
  // fichier serveur) : s'il embarque l'arbre de carrière officiel, on n'appelle
  // PLUS l'API OpenFront ici — plus de 1-3 s de latence ni d'échec 503.
  const payloadPromise = getProfilePayload(publicId);
  payloadPromise.catch(() => {});
  const payload = await payloadPromise;

  // Kick off recent games fetch in parallel (separate endpoint) — UNIQUEMENT
  // sans payload : la liste ne sert plus qu'à retarder renderWeeklyChart
  // (v5.15), et le dossier cockpit vient désormais du payload.
  const recentGamesPromise = payload?.official ? Promise.resolve([]) : fetchRecentGames(publicId);
  // Supprime la rejection non-gérée si on retourne avant (publicId invalide).
  recentGamesPromise.catch(() => {});

  let playerData = null;
  if (payload?.official?.stats) {
    playerData = {
      username: payload.official.username || payload.player?.lastUsername || publicId,
      stats: payload.official.stats,
    };
  }
  if (!playerData) {
    try {
      playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    } catch (e) {
    console.error("[profile] OpenFront API error:", e);
    if (e?.isNotFound || e?.status === 404) {
      // Identifiant invalide : rien à afficher (le dossier pré-calculé ne
      // correspondra jamais à un joueur inexistant sur l'API).
      showError(
        T("pf.player_not_found", "Joueur introuvable sur l'API OpenFront (publicId : {id}). Vérifie que ton identifiant OpenFront est correct dans tes paramètres de profil.", { id: publicId })
      );
      setText("stat-alltime-value", "—");
      setText("stat-alltime-sub", "");
      return;
    }
    // API OpenFront injoignable (503 « Offline », timeout…) : NON bloquant —
    // v5.15 le cockpit démarre quand même via le dossier pré-calculé ou le
    // fallback live (avant : return → profil réduit au nom, même pour les
    // joueurs suivis dont le fichier player-stats existait).
    showError(T("pf.stats_load_fail", "Impossible de charger les statistiques depuis l'API OpenFront."));
    } // catch
  }

  if (!playerData) {
    // v5.15.1 : API OpenFront injoignable ≠ score inconnu — on laisse « … »
    // (chargement) : le bloc week-stats ci-dessous posera le score officiel
    // depuis dashboard_scores.json (données serveur, indépendantes d'OpenFront).
    // Si ce bloc n'aboutit pas non plus, il affichera « — » (et non « 0 »,
    // valeur fallacieuse qui laissait croire à un joueur sans aucun point).
    setText("stat-alltime-value", "…");
    setText("stat-alltime-sub", "");
  }

  // NOTE: /public/player/{id} no longer returns a `games` array.
  // Recent games come from the separate /games endpoint (recentGamesPromise).
  const games = [];
  const stats = computeStats(games, playerData?.stats || {});

  // ── Render reward card + career stats + start games loading IMMEDIATELY ──
  // Don't wait for dashboard_scores, ELO, or recent games — those are secondary.
  // Only show reward code card on OWN profile (not when viewing someone else's public profile).
  // editingAllowed est posé par renderHero/renderPublicProfile AVANT loadStats :
  // il garantit que la carte n'apparaît que sur le profil du compte connecté.
  const isOwnProfile = editingAllowed && !viewingPublicId
    && currentProfile && currentProfile.publicId === publicId;
  if (isOwnProfile) {
    renderRewardCodeCard(publicId);
  }
  // v5.15 : playerData peut être null (API OpenFront injoignable) — le cockpit
  // doit quand même démarrer (dossier pré-calculé, sinon fallback live).
  renderCareerStats(playerData?.stats || {}, publicId);
  loadAllGamesForStats(publicId, playerData);

  // ── Week stats from dashboard_scores.json (official data) — non-blocking ──
  (async () => {
    let weekScore = 0, weekRank = "—", weekFFA = 0, weekTeam = 0, weekTotalPoints = 0;
    try {
      // ⚠️ cache "no-cache" (revalidation 304) et PAS "force-cache" : avec
      // force-cache le navigateur peut resservir une réponse PÉRIMÉE (ex.
      // dashboard_scores de la semaine précédente après le reset du lundi).
      // Résultat : weekStart périmé → le point « live » du graphique hebdo
      // était ajouté à droite avec les données de la semaine précédente
      // (inversion S1/S2 sur la courbe du profil). no-cache = toujours frais.
      const scoresRes = await fetch("dashboard_scores.json.gz", { cache: "no-cache" });
      let scoresData = null;
      if (scoresRes.ok) {
        const ds = new DecompressionStream("gzip");
        scoresData = await new Response(scoresRes.body.pipeThrough(ds)).json();
      } else {
        const fallback = await fetch("dashboard_scores.json", { cache: "no-cache" });
        if (fallback.ok) scoresData = await fallback.json();
      }
      if (scoresData && scoresData.players) {
        const entry = scoresData.players.find(p => p.publicId === publicId);
        if (entry) {
          weekFFA = (entry.weekly_ffa_casual || 0) + (entry.weekly_ffa_ranked || 0);
          weekTeam = (entry.weekly_team_casual || 0) + (entry.weekly_team_ranked || 0);
          weekScore = entry.weekly_points || 0;
          weekTotalPoints = entry.points || 0;
          // Compute rank: position in the sorted weekly leaderboard
          const weeklySorted = [...scoresData.players].sort((a, b) => (b.weekly_points || 0) - (a.weekly_points || 0));
          const rankIdx = weeklySorted.findIndex(p => p.publicId === publicId);
          weekRank = rankIdx >= 0 ? rankIdx + 1 : "—";

          // Store for the chart
          window._profileWeekData = {
            publicId: publicId,
            ffa: weekFFA,
            team: weekTeam,
            total: weekScore,
            rank: weekRank,
            weekStart: scoresData.weekStart,
            // Detailed breakdown for tooltip
            ffaCasual: entry.weekly_ffa_casual || 0,
            ffaRanked: entry.weekly_ffa_ranked || 0,
            teamCasual: entry.weekly_team_casual || 0,
            teamRanked: entry.weekly_team_ranked || 0,
            allTimePoints: entry.points || 0,
            allTimeFfa: entry.ffa_casual || 0,
            allTimeTeam: entry.team_casual || 0,
            // Sorted players (voisins de classement pour « Autour de toi »)
            weeklySorted: weeklySorted,
          };
        }
      }
    } catch (e) {
      console.warn("[profile] Week stats load failed:", e.message);
    }

    // ── Historique hebdo (weekly_history.json.gz) — non-blocking ──
    // Alimenté par sync-dashboard.js : un snapshot figé par semaine écoulée,
    // la semaine en cours est rafraîchie toutes les 5 min. Chaque lundi,
    // une nouvelle colonne S1, S2, S3… s'ajoute au graphique du profil.
    // ⛔ FUSION SEED ANNULÉE (demande utilisateur) : les semaines reconstituées
    // a posteriori (weekly_history_seed.json) ne sont PLUS fusionnées dans la
    // courbe — seules les semaines réellement enregistrées s'affichent.
    fetch("weekly_history.json.gz", { cache: "no-cache" })
      .then(async (res) => {
        if (res.ok) {
          const ds = new DecompressionStream("gzip");
          window._profileWeekHistory = await new Response(res.body.pipeThrough(ds)).json();
        } else {
          const fb = await fetch("weekly_history.json", { cache: "no-cache" });
          if (fb.ok) window._profileWeekHistory = await fb.json();
        }
        if (window._profileWeekHistory) {
          await mergeWeeklySeed();
          renderWeeklyChart();
        }
      })
      .catch(() => { /* pas encore d'historique (1re semaine) → courbe à 1 point */ });

    // All-time score
    const allTimeScore = stats.wins * 4 + (stats.total - stats.wins);

    // v5.15.1 : si ni les points officiels ni l'arbre de carrière ne sont
    // disponibles (API OpenFront injoignable + joueur absent de
    // dashboard_scores), on affiche « — » au lieu d'un fallacieux « 0 ».
    const bestScore = weekTotalPoints || allTimeScore;
    setText("stat-alltime-value", bestScore > 0 ? new Intl.NumberFormat(LOCALE()).format(bestScore) : (playerData ? new Intl.NumberFormat(LOCALE()).format(allTimeScore) : "—"));
    setText("stat-alltime-sub", weekRank !== "—" ? T("pf.week_sub", "Semaine : {pts} pts · #{rank}", { pts: new Intl.NumberFormat(LOCALE()).format(weekScore), rank: weekRank }) : "");

    // Chip hebdo (Niv/temps/série sont posés par renderPrecomputedStats)
    const metaEl = document.getElementById("cockpit-status-meta");
    if (metaEl && weekRank !== "—") {
      let chip = document.getElementById("pf2-chip-week");
      if (!chip) {
        chip = document.createElement("span");
        chip.id = "pf2-chip-week";
        chip.className = "pf2-chip";
        metaEl.appendChild(chip);
      }
      chip.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg> ` + T("pf.chip_week", "Hebdo #{rank} · {pts} pts", { rank: weekRank, pts: new Intl.NumberFormat(LOCALE()).format(weekScore) });
    }

    // ── Panneau « Autour de toi » : voisins du classement hebdo ──
    const weekData = window._profileWeekData;
    const peersPanel = document.getElementById("pf2-peers-panel");
    const peersList = document.getElementById("pf2-peers-list");
    if (peersPanel && peersList && weekData?.weeklySorted && currentProfile?.publicId === publicId) {
      const sorted = weekData.weeklySorted;
      const idx = sorted.findIndex(p => p.publicId === publicId);
      if (idx >= 0) {
        const from = Math.max(0, idx - 2);
        const rows = sorted.slice(from, Math.min(sorted.length, from + 5));
        peersList.innerHTML = rows.map((p, i) => {
          const rank = from + i + 1;
          const isMe = p.publicId === publicId;
          // Pseudo hub (même pseudo partout) + ligne cliquable → profil
          const shownName = hubNameForPid(p.publicId) || p.username || p.publicId || T("pf.player_default", "Joueur");
          const peerUrl = p.publicId
            ? `profile.html?pid=${encodeURIComponent(p.publicId)}&player=${encodeURIComponent(shownName)}`
            : `profile.html?player=${encodeURIComponent(shownName)}`;
          return `<a class="pf2-peer${isMe ? " is-me" : ""}" href="${peerUrl}" style="text-decoration:none;color:inherit;cursor:pointer">
            <span class="pf2-peer-rank">${rank}</span>
            <span class="pf2-peer-name">${esc(shownName)}</span>
            <span class="pf2-peer-score">${new Intl.NumberFormat(LOCALE()).format(p.weekly_points || 0)}</span>
          </a>`;
        }).join("");
        peersPanel.hidden = false;
      }
    }

    // ── Panneau « Elo Classé » (ranked.json) ──
    const ranked1v1 = await eloPromise;
    const ranked2v2 = await getRankedEntry(publicId, "2v2");
    if (eloPanel && (ranked1v1?.elo != null || ranked2v2?.elo != null)) {
      const v11 = document.getElementById("elo-1v1");
      const s11 = document.getElementById("elo-1v1-sub");
      const v22 = document.getElementById("elo-2v2");
      const s22 = document.getElementById("elo-2v2-sub");
      if (ranked1v1?.elo != null) {
        setText("elo-1v1", new Intl.NumberFormat(LOCALE()).format(ranked1v1.elo));
        if (s11) s11.textContent = `Peak ${ranked1v1.peakElo ?? "—"}${ranked1v1.rank ? ` · #${ranked1v1.rank}` : ""}`;
      } else if (v11) {
        v11.textContent = "—";
        if (s11) s11.textContent = T("profile.no_rank", "Non classé");
      }
      if (ranked2v2?.elo != null) {
        setText("elo-2v2", new Intl.NumberFormat(LOCALE()).format(ranked2v2.elo));
        if (s22) s22.textContent = `Peak ${ranked2v2.peakElo ?? "—"}${ranked2v2.rank ? ` · #${ranked2v2.rank}` : ""}`;
      } else if (v22) {
        v22.textContent = "—";
        if (s22) s22.textContent = T("profile.no_rank", "Non classé");
      }
      eloPanel.hidden = false;

      // Chip Elo dans les chips meta
      if (metaEl && ranked1v1?.elo != null) {
        let chip = document.getElementById("pf2-chip-elo");
        if (!chip) {
          chip = document.createElement("span");
          chip.id = "pf2-chip-elo";
          chip.className = "pf2-chip";
          metaEl.appendChild(chip);
        }
        chip.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 10 6-5 6 5"/><path d="m6 15 6-5 6 5"/><path d="m6 20 6-5 6 5"/></svg> ` + T("pf.chip_elo", "Elo {v}", { v: new Intl.NumberFormat(LOCALE()).format(ranked1v1.elo) });
      }
    }

    // Recent games — fetched from /public/player/{id}/games (separate endpoint).
    // Used only for the weekly chart now — the full recent games list
    // is rendered by renderPrecomputedStats via loadAllGamesForStats().
    // v5.15.1 : renderWeeklyChart() est appelé dans TOUS les cas (succès OU
    // échec de la récupération des parties) — avant, un échec OpenFront
    // (503 « Offline », proxies injoignables) laissait le graphique hebdo
    // absent ou effacé par un rendu ultérieur du cockpit sans seconde passe.
    try {
      await recentGamesPromise;
    } catch (e) {
      console.error("[profile] recent games fetch failed:", e);
    }
    renderWeeklyChart();
  })();
}

/**
 * Fetch recent games for a player from the /public/player/{id}/games endpoint.
 * Returns up to 10 games with result (victory/defeat) already included.
 * Supports cursor pagination to fetch more if needed.
 */
async function fetchRecentGames(publicId, maxPages = 1) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `/public/player/${encodeURIComponent(publicId)}/games` +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
    const data = await fetchOpenFront(url);
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    cursor = data?.nextCursor;
    if (!cursor || results.length === 0) break;
  }
  return all;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function computeStats(games, statsTree) {
  // Wins: sum all "wins" fields across the stats tree (Private/Public/Ranked → mode → difficulty)
  let wins = 0;
  let total = 0;
  if (statsTree && typeof statsTree === "object") {
    for (const catKey of Object.keys(statsTree)) {
      // ⚠️ v0.34 : stats.recent (agrégats {games, wins} sur fenêtre courte)
      // ne doit JAMAIS être sommé ici — ses wins sont déjà inclus dans les
      // feuilles carrière. Sans ce skip, les wins/total du profil étaient
      // comptés en double (voire ×3 avec les sous-difficultés de recent).
      if (catKey === "recent") continue;
      const cat = statsTree[catKey];
      if (!cat || typeof cat !== "object") continue;
      for (const modeKey of Object.keys(cat)) {
        const mode = cat[modeKey];
        if (!mode || typeof mode !== "object") continue;
        for (const diffKey of Object.keys(mode)) {
          const diff = mode[diffKey];
          // Feuille réelle = porte total OU losses (les agrégats récents ne
          // portent que {games, wins} — jamais comptés comme feuille).
          if (!diff || typeof diff !== "object") continue;
          if (diff.total == null && diff.losses == null) continue;
          if (diff.wins != null) wins += parseInt(diff.wins, 10) || 0;
          if (diff.total != null) total += parseInt(diff.total, 10) || 0;
          else if (diff.wins != null && diff.losses != null) {
            total += (parseInt(diff.wins, 10) || 0) + (parseInt(diff.losses, 10) || 0);
          }
        }
      }
    }
  }

  // Fallback: if stats tree has no totals, use games.length
  if (total === 0 && games.length > 0) total = games.length;

  // Unique maps + favourite map
  const mapCounts = {};
  let lastGame = null;
  for (const g of games) {
    if (g.map) mapCounts[g.map] = (mapCounts[g.map] || 0) + 1;
    if (g.start) {
      const d = new Date(g.start).getTime();
      if (!isNaN(d) && (lastGame === null || d > lastGame)) lastGame = d;
    }
  }
  const uniqueMaps = Object.keys(mapCounts).length;
  let favMap = null;
  let favCount = 0;
  for (const [m, c] of Object.entries(mapCounts)) {
    if (c > favCount) { favMap = m; favCount = c; }
  }
  const lastGameIso = lastGame ? new Date(lastGame).toISOString() : null;

  return { wins, total, uniqueMaps, favMap, lastGame: lastGameIso };
}

async function getRankedEntry(publicId, mode = "1v1") {
  if (_rankedCache === null) {
    try {
      const res = await fetch("ranked.json", { cache: "no-store" });
      if (res.ok) _rankedCache = await res.json();
      else _rankedCache = {};
    } catch (e) {
      console.warn("[profile] ranked.json load failed:", e);
      _rankedCache = {};
    }
  }
  const list = (_rankedCache && Array.isArray(_rankedCache[mode])) ? _rankedCache[mode] : [];
  return list.find((p) => p && p.public_id === publicId) || null;
}

function showError(msg) {
  const el = document.getElementById("profile-api-error");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
}
function hideError() {
  const el = document.getElementById("profile-api-error");
  if (el) el.style.display = "none";
}

/* ── Recent games ── */

/** Format duration in seconds as M:SS or H:MM:SS */
function formatDuration(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}:${String(rs).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}:${String(rm).padStart(2, "0")}:${String(rs).padStart(2, "0")}`;
}

/** Build a human-readable game mode label from the game object */
function formatGameMode(g) {
  const parts = [];
  if (g.type) parts.push(g.type);
  if (g.mode) parts.push(g.mode === "Free For All" ? "FFA" : g.mode);
  if (g.playerTeams && g.playerTeams !== "null") parts.push(g.playerTeams);
  return parts.join(" · ") || "—";
}

/**
 * Check whether the given clientId is among the winners of the given game.
 * OpenFront `/public/game/{gameId}` returns `info.winner` as
 * `[type, name, ...clientIDs]`.
 */
async function checkGameWin(gameId, clientId) {
  if (!gameId || !clientId) return null;
  const data = await fetchOpenFront(`/public/game/${encodeURIComponent(gameId)}`);
  const winner = data?.info?.winner;
  if (!Array.isArray(winner) || winner.length < 3) return null;
  // winner[0] = "team" | "player", winner[1] = name, winner[2..] = clientIDs
  const winnerIds = winner.slice(2);
  return winnerIds.includes(clientId);
}

/* ── Setup: ownership verification ── */

/* ── Persistance du défi de propriété (fix régression 2026-09) ────────────
 * La partie OpenFront qui prouve la propriété peut durer de quelques
 * minutes à 3 h et l'utilisateur navigue sur le site entre-temps. Le code
 * doit donc survivre aux changements de page / reloads / redémarrages du
 * navigateur : il est stocké en localStorage par uid Discord/Firebase et
 * réutilisé TEL QUEL au retour sur la page (étape 2 réaffichée d'office).
 * Il n'est supprimé qu'après une liaison RÉUSSIE — jamais sur navigation.
 * (Avant : simple variable JS `_ownershipCode` → un nouveau code était
 * généré à chaque clic, rendant le défi en cours impossible à valider.) */
const OWNERSHIP_KEY = "tfh-ownership-challenge-";

function ownershipStorageKey() {
  return currentUser?.uid ? OWNERSHIP_KEY + currentUser.uid : null;
}

function loadOwnershipChallenge() {
  const key = ownershipStorageKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data.code !== "string" || !/^TFH[A-Z0-9]{4}$/.test(data.code)) return null;
    if (typeof data.publicId !== "string" || !/^[A-Za-z0-9]{8}$/.test(data.publicId)) return null;
    if (typeof data.username !== "string" || data.username.length < 2 || data.username.length > 30) return null;
    return { code: data.code, publicId: data.publicId, username: data.username, ts: Number(data.ts) || 0 };
  } catch (e) {
    return null; // JSON invalide / localStorage indisponible → on régénérera un défi neuf
  }
}

function saveOwnershipChallenge(challenge) {
  const key = ownershipStorageKey();
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(challenge)); } catch (e) { /* navigation privée : dégradation = ancien comportement */ }
}

/** Supprime le défi stocké — uniquement après une liaison réussie. */
function clearOwnershipChallenge() {
  const key = ownershipStorageKey();
  if (!key) return;
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

/* ── Public ID : accepte le lien OpenFront complet ou le message copié ──
 * Le bouton « Copier » d'OpenFront fournit soit un lien
 * (https://openfront.io/#modal=profile&publicID=UWetOwlW), soit un message
 * (« Mon Public ID : UWetOwlW »). On extrait l'ID (8 caractères
 * alphanumériques) de n'importe quel texte collé ; un ID tapé à la main
 * passe tel quel. Le seuil de 8 caractères évite de découper une saisie
 * manuelle du lien en cours de frappe. */
function extractPublicId(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  const m = v.match(/public\s*ID\s*[:=]\s*["']?([A-Za-z0-9]{8,32})["']?/i);
  return m ? m[1] : v;
}

// Extraction automatique dès le collage : le champ affiche directement l'ID.
(function wirePublicIdAutoExtract() {
  const el = document.getElementById("setup-public-id");
  if (!el) return;
  el.addEventListener("input", () => {
    const extracted = extractPublicId(el.value);
    if (extracted && extracted !== el.value) el.value = extracted;
  });
})();

/** Affiche l'étape 2 (défi en jeu) avec le code, et pré-remplit l'étape 1. */
function showOwnershipStep2(challenge) {
  _ownershipCode = challenge.code;
  _ownershipPublicId = challenge.publicId;
  _ownershipUsername = challenge.username;
  const usernameInput = document.getElementById("setup-username");
  const publicIdInput = document.getElementById("setup-public-id");
  if (usernameInput) usernameInput.value = challenge.username;
  if (publicIdInput) publicIdInput.value = challenge.publicId;
  const codeEl = document.getElementById("ownership-code-display");
  if (codeEl) codeEl.textContent = challenge.code;
  const s1 = document.getElementById("profile-setup-step1");
  const s2 = document.getElementById("profile-setup-step2");
  if (s1) s1.style.display = "none";
  if (s2) s2.style.display = "block";
}

/** Au chargement de la page (utilisateur sans profil lié) : si un défi est
 *  en cours, on réaffiche DIRECTEMENT l'étape 2 avec LE MÊME code — l'usager
 *  peut vérifier s'il a fait sa partie sans rien regénérer. */
function restorePendingOwnershipChallenge() {
  try {
    const pending = loadOwnershipChallenge();
    if (pending) showOwnershipStep2(pending);
  } catch (e) { /* non-bloquant */ }
}

window.startOwnershipVerification = async () => {
  if (!currentUser) {
    showToast(T("pf.setup_login_first", "Veuillez vous connecter d'abord."), "warning");
    return;
  }
  const usernameInput = document.getElementById("setup-username");
  const publicIdInput = document.getElementById("setup-public-id");
  const username = (usernameInput?.value || "").trim();
  // Lien OpenFront collé ou message « Mon Public ID : … » → extraction de l'ID
  const publicId = extractPublicId(publicIdInput?.value || "");

  if (!username || !publicId) {
    showToast(T("profile.fill_all", "Veuillez remplir tous les champs."), "warning");
    return;
  }
  if (username.length < 2 || username.length > 30) {
    showToast(T("pf.pseudo_length", "Le pseudo doit faire entre 2 et 30 caractères."), "warning");
    return;
  }
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) {
    showToast(T("pf.pid_length", "Public ID invalide — 8 caractères alphanumériques (ex: HabCsQYR), ou collez directement le lien OpenFront."), "warning");
    return;
  }
  if (/[^a-zA-Z0-9_\- ]/.test(username)) {
    showToast(T("pf.pseudo_chars", "Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -."), "warning");
    return;
  }

  // Défi déjà en cours pour ce compte ? → réutilise LE MÊME code, sans reset.
  // (l'utilisateur revient après avoir mis le code dans son pseudo, ou après
  //  un simple passage sur une autre page : rien ne doit changer. Le check
  //  est placé AVANT les appels réseau pour marcher même si l'API rame.)
  const pending = loadOwnershipChallenge();
  if (pending && pending.publicId === publicId && pending.username === username) {
    showOwnershipStep2(pending);
    showToast(T("pf.code_pending", "Défi déjà en cours — même code : {code}. Joue (ou finis) ta partie, puis reviens cliquer sur Vérifier.", { code: pending.code }), "info", 6000);
    return;
  }

  // If user already has a different publicId, refuse change
  try {
    if (currentProfile && currentProfile.publicId && currentProfile.publicId !== publicId) {
      showToast(T("profile.public_id_locked_alert", "Le Public ID OpenFront ne peut plus être modifié."), "error");
      return;
    }
  } catch (e) { /* non-blocking */ }

  // Verify publicId exists on OpenFront
  showToast(T("pf.checking_pid", "Vérification du Public ID…"), "info", 3000);
  try {
    const playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    if (!playerData || !playerData.publicId) {
      showToast(T("pf.pid_not_found", "Public ID introuvable sur OpenFront. Vérifiez votre saisie."), "error");
      return;
    }
  } catch (e) {
    if (e?.isNotFound || e?.status === 404) {
      showToast(T("pf.pid_not_found", "Public ID introuvable sur OpenFront. Vérifiez votre saisie."), "error");
      return;
    }
    showToast(T("pf.pid_check_fail", "Impossible de vérifier le Public ID (API indisponible). Réessayez plus tard."), "error", 6000);
    console.error("[setup] API check failed:", e);
    return;
  }

  // Check that no other user has this publicId already
  // (fix 2026-08-29 : FIRESTORE_BASE n'existe plus depuis la migration MySQL —
  //  la vérification pointait vers une variable undefined → ReferenceError
  //  avalé par le catch, check mort. Remplacé par l'API MySQL public-aliases.)
  // (fix 2026-09-03 : comparaison uid cassée — alias.uid (id MySQL) ne peut
  //  JAMAIS égaler currentUser.uid (id Discord) → le check ne servait à rien.
  //  En setup le compte n'est pas encore lié : si le pid figure dans les
  //  alias publics, il appartient forcément à un autre compte → refus.)
  try {
    const aliasesRes = await fetch("/api/public-aliases.php", { cache: "no-store" });
    if (aliasesRes.ok) {
      const aliasesData = await aliasesRes.json();
      const aliases = aliasesData.aliases || [];
      for (const alias of aliases) {
        if (alias.publicId && alias.publicId === publicId) {
          showToast(T("pf.pid_taken", "Ce Public ID est déjà lié à un autre compte."), "error");
          return;
        }
      }
    }
  } catch (e) { /* API indisponible — le défi en jeu ci-dessous reste la preuve de propriété */ }

  // ── Défi de propriété (2026-09-03 — remplace « Directly save ») ──────
  // Lier un Public ID = revendiquer une identité OpenFront. Sans preuve,
  // n'importe qui pouvait réclamer le pid d'un joueur non lié puis piloter
  // « son » profil (pseudo public, cosmétiques). Désormais : un code unique
  // doit apparaître dans une partie récente jouée avec ce compte — seule la
  // personne qui le CONTRÔLE peut le faire apparaître.
  const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans O/0 ni I/1
  let code = "TFH";
  for (let i = 0; i < 4; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  const challenge = { code, publicId, username, ts: Date.now() };
  saveOwnershipChallenge(challenge); // persisté : survit aux navigations/reloads
  showOwnershipStep2(challenge);
  showToast(T("pf.play_with_code", "Joue une partie avec le code {code} dans ton pseudo, puis clique sur Vérifier.", { code }), "info", 7000);
};

/** Copie le code de vérification dans le presse-papiers (étape 2 du setup). */
window.copyOwnershipCode = function () {
  const code = _ownershipCode
    || document.getElementById("ownership-code-display")?.textContent
    || "";
  if (!code || code === "—") return;
  const done = () => showToast(T("pf.code_copied", "Code copié : {code}", { code }), "success");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(() => showToast(T("pf.code_show", "Code : {code}", { code }), "info"));
  } else {
    showToast(T("pf.code_show", "Code : {code}", { code }), "info");
  }
};

window.confirmOwnershipVerification = async () => {
  // Sécurité : si la page vient d'être rechargée et que l'étape 2 n'a pas
  // encore été re-rendue, on repêche le défi persistant (même code).
  if (!_ownershipCode || !_ownershipPublicId) {
    const pending = loadOwnershipChallenge();
    if (pending) {
      _ownershipCode = pending.code;
      _ownershipPublicId = pending.publicId;
      _ownershipUsername = pending.username;
    }
  }
  if (!_ownershipCode || !_ownershipPublicId) return;
  const btn = document.getElementById("confirm-ownership-btn");
  const original = btn?.textContent || T("pf.confirm", "Confirmer");
  if (btn) { btn.disabled = true; btn.textContent = T("pf.verifying", "Vérification…"); }

  try {
    // L'API /public/player/{id} ne renvoie plus `games`. On récupère les
    // parties récentes via l'endpoint dédié /public/player/{id}/games.
    const gamesData = await fetchOpenFront(`/public/player/${encodeURIComponent(_ownershipPublicId)}/games`);
    const games = Array.isArray(gamesData?.results) ? gamesData.results : [];
    // Comparaison insensible à la casse : le code peut être tapé en minuscules.
    const needle = String(_ownershipCode).toUpperCase();
    let found = games.some((g) => String(g.username || "").toUpperCase().includes(needle));
    if (!found) {
      showToast(T("pf.code_not_found", "Code non trouvé dans vos parties récentes. Jouez une partie avec le code dans votre pseudo, puis confirmez."), "error", 6000);
      if (btn) { btn.disabled = false; btn.textContent = original; }
      return;
    }
    // Verified → save to Firestore (v5.13 : le code part au serveur, qui
    // revérifie lui-même la propriété avant de poser le badge définitif)
    await saveUserProfile(_ownershipUsername, _ownershipPublicId, _ownershipCode);
    // Vérification serveur immédiate (si l'inline du save n'a pas suffi —
    // ex : API OpenFront lente à cet instant). Non bloquant : en cas d'échec
    // l'utilisateur garde son profil lié et pourra revérifier plus tard.
    try {
      const res = await fetch("/api/profile.php", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", publicId: _ownershipPublicId, code: _ownershipCode }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        if (currentProfile) currentProfile.verified = true;
      } else if (j?.error && j.error !== "verify_failed") {
        console.warn("[ownership] Server verify soft-fail:", j.error);
      }
    } catch (e) { /* non bloquant */ }
    // Liaison réussie → le défi persistant n'a plus de raison d'exister.
    clearOwnershipChallenge();
  } catch (e) {
    console.error("[ownership] Confirmation failed:", e);
    // Fix 2026-09-06 : affiche la vraie raison renvoyée par l'API
    // (pseudo déjà pris, public ID déjà lié à un autre compte…)
    // au lieu d'un message générique qui masquait le problème.
    showToast(e?.message ? e.message : T("pf.verify_error", "Erreur lors de la vérification. Réessayez."), "error", 7000);
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
};

window.cancelOwnershipVerification = () => {
  // ⚠️ On ne supprime PAS le défi persistant (loadOwnershipChallenge) :
  // « Modifier mes infos » ne doit pas invalider le code que l'utilisateur
  // a peut-être déjà mis dans son pseudo en jeu. S'il relance la liaison
  // avec les mêmes infos, le MÊME code est réaffiché (reuse dans
  // startOwnershipVerification). Effacement uniquement après liaison OK.
  _ownershipCode = null;
  _ownershipPublicId = null;
  _ownershipUsername = null;
  const s1 = document.getElementById("profile-setup-step1");
  const s2 = document.getElementById("profile-setup-step2");
  if (s1) s1.style.display = "block";
  if (s2) s2.style.display = "none";
};

async function saveUserProfile(username, publicId, verifyCode) {
  if (!currentUser) throw new Error("No authenticated user");
  try {
    const existing = currentProfile || {};
    /* v5.13 — le code du défi accompagne la liaison : le serveur scanne
     * lui-même les parties récentes du publicId (source de vérité du badge
     * « vérifié »). verified reste affiché côté client pour la réactivité. */
    await setDoc(doc(db, "users", currentUser.uid), {
      username,
      publicId,
      email: currentUser.email || null,
      verified: true,
      verifiedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(verifyCode ? { verifyCode } : {}),
    }, { merge: true });

    currentProfile = { ...(currentProfile || {}), username, publicId, verified: true };
    showToast(T("pf.profile_saved", "Profil vérifié et enregistré avec succès !"), "success");

    // Publie le lien publicId ↔ username/uid dans une collection publique pour que
    // le matching VIP par PUBLIC ID fonctionne pour tous les viewers (skin suit le
    // public_id, pas l'alias). Best-effort: ignoré silencieusement si règles bloquent.
    try {
      await setDoc(doc(db, "public-aliases", currentUser.uid), {
        username,
        publicId,
        aliases: [username],
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (bridgeErr) {
      console.warn("[profile] Bridge public-aliases (publicId) write failed (non-critique):", bridgeErr.message);
    }
    try {
      await setDoc(doc(db, "public-rewards", currentUser.uid), {
        publicId,
        username,
      }, { merge: true });
    } catch (rewardsErr) {
      console.warn("[profile] public-rewards publicId merge failed (non-critique):", rewardsErr.message);
    }

    // Reset setup form
    window.cancelOwnershipVerification();
    updateSidebarUI(currentUser, currentProfile);

    // Switch to main view and load stats
    showView("profile-main");
    renderHero(currentUser, currentProfile);
    loadVipForProfile(); // écoute VIP pour appliquer le skin par publicId
    await loadStats(publicId);
    loadProfileSpeedruns(publicId, true, [username]);
  } catch (e) {
    console.error("[profile] Save profile error:", e);
    showToast(T("pf.profile_save_error", "Erreur lors de la sauvegarde du profil."), "error");
    throw e;
  }
}

/* ═══════ v5.14 — Liaison instantanée par Identity Token OpenFront ═══════
 * Le joueur génère un token sur openfront.io (Paramètres du compte →
 * « Lier à un site tiers » → thefronthub.com) et le colle ici. Le serveur
 * le valide auprès de l'API officielle : liaison du Public ID + badge
 * « vérifié » immédiats, sans jouer de partie. */
window.linkWithIdentityToken = async () => {
  if (!currentUser) {
    showToast(T("pf.login_required", "Connecte-toi d'abord avec Discord."), "warning");
    return;
  }
  const input = document.getElementById("setup-identity-token");
  const btn = document.getElementById("link-token-btn");
  const token = String(input?.value || "").trim();
  if (!token) {
    showToast(T("pf.token_required", "Colle d'abord le token généré sur OpenFront."), "error");
    return;
  }
  const original = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = T("pf.token_linking", "Vérification du token…"); }
  try {
    const res = await fetch("/api/profile.php", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "link_token", token }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) {
      showToast(
        j?.message || T("pf.token_failed", "Liaison impossible — régénère un token sur OpenFront et réessaie."),
        "error"
      );
      return;
    }
    const chosenUsername =
      (document.getElementById("setup-username")?.value || "").trim() ||
      currentProfile?.username ||
      currentUser.displayName ||
      (currentUser.email || "").split("@")[0] ||
      "joueur" + (Date.now() % 10000);
    // Le serveur a déjà lié + vérifié : on synchronise le pseudo hub + Firestore.
    await saveUserProfile(chosenUsername, j.publicId, null);
    if (input) input.value = "";
    if (window.TFHVerified && j.publicId) window.TFHVerified.markVerified(j.publicId);
    showToast(T("pf.token_ok", "Compte OpenFront lié et vérifié instantanément !"), "success");
  } catch (e) {
    console.error("[profile] linkWithIdentityToken:", e);
    showToast(T("pf.token_failed", "Liaison impossible — régénère un token sur OpenFront et réessaie."), "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
};

/* ── Sidebar / auth modal handlers ── */

// État visuel des boutons Discord pendant la redirection OAuth (modal + gate)
function setDiscordRedirecting(redirecting) {
  const btns = document.querySelectorAll(".auth-btn.discord, .pf-discord-btn, #auth-btn-discord");
  btns.forEach((btn) => {
    const label = btn.querySelector(".auth-btn-label");
    if (redirecting) {
      btn.disabled = true;
      btn.classList.add("is-redirecting");
      if (label) label.textContent = T("pf.redirecting_discord", "Redirection vers Discord…");
    } else {
      btn.disabled = false;
      btn.classList.remove("is-redirecting");
      if (label) label.textContent = T("auth.continue_discord", "Continuer avec Discord");
    }
  });
}

window.toggleAuthModal = function () {
  const modal = document.getElementById("auth-modal");
  if (modal) modal.classList.toggle("active");
};

window.handleLogin = async function (provider) {
  if (window._loginInProgress) return;
  window._loginInProgress = true;
  setDiscordRedirecting(true);
  try {
    // Discord uniquement — loginWithDiscord() redirige vers l'OAuth
    await window.loginWithDiscord();
    const modal = document.getElementById("auth-modal");
    if (modal) modal.classList.remove("active");
  } catch (e) {
    console.error("[profile] Login error:", e);
    window._loginInProgress = false;
    setDiscordRedirecting(false);
  }
};

window.handleLogout = async function (event) {
  if (event) event.stopPropagation();
  if (!confirm(T("profile.logout_confirm", "Voulez-vous vous déconnecter ?"))) return;
  try { await window.logout(); } catch (e) { console.warn("[profile] logout error:", e); }
  currentUser = null;
  currentProfile = null;
  updateSidebarUI(null);
  showView("profile-gate");
};

window.toggleUserDropdown = function (event) {
  if (event) event.stopPropagation();
  const c = document.getElementById("user-container");
  if (c) c.classList.toggle("open");
};

window.closeUserDropdown = function () {
  const c = document.getElementById("user-container");
  if (c) c.classList.remove("open");
};

window.goToProfilePage = function (event) {
  if (event) event.stopPropagation();
  // Already on profile page — just close dropdown
  window.closeUserDropdown();
};

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  const c = document.getElementById("user-container");
  if (c && !c.contains(e.target)) c.classList.remove("open");
});

/* ═══ Activity chart + playtime estimation ═══ */



/* ═══ Weekly Performance Chart — Line chart ═══
   Graphique en lignes : semaines sur l'axe X (S1, S2, S3… — l'historique
   s'accumule semaine après semaine, voir sync-dashboard.js), score sur
   l'axe Y gauche, position sur l'axe Y droite (inversé).
   Lignes colorées par mode : FFA=rouge, Team=bleu, Classé=violet, Total=noir.
   Points avec cercle contenant le rang (#X) sur la série Total. */

/* 🌱 mergeWeeklySeed() réactivée (retour demandé par Skailex 2026-09-23) :
   les semaines « seed » reconstituées a posteriori (data/weekly_history_seed.json)
   complètent l'historique live — S1, S2 réapparaissent sur la courbe.
   Garde-fous : on ne remplace JAMAIS une semaine déjà enregistrée par la sync,
   et on ne comble que des semaines STRICTEMENT antérieures à la plus vieille
   semaine connue. Les labels restent absolus (S = semaine de saison), donc
   aucun décalage de numérotation. */
async function mergeWeeklySeed() {
  try {
    const seedRes = await fetch("data/weekly_history_seed.json", { cache: "no-cache" });
    if (!seedRes.ok) return;
    const seed = await seedRes.json();
    const seedWeeks = (seed && seed.weeks) || {};
    const hist = window._profileWeekHistory = window._profileWeekHistory || { version: 1, weeks: {} };
    hist.weeks = hist.weeks || {};
    const oldest = Object.keys(hist.weeks).sort()[0] || null;
    let added = 0;
    for (const k of Object.keys(seedWeeks)) {
      if (hist.weeks[k]) continue;          // semaine enregistrée → live prioritaire
      if (oldest && k >= oldest) continue;  // uniquement antérieur à l'historique
      hist.weeks[k] = seedWeeks[k];
      added++;
    }
    if (added) console.log("[profile] Historique hebdo : +" + added + " semaine(s) du seed");
  } catch (e) { /* seed indisponible → historique live seul */ }
}

/* Construit la liste chronologique des semaines :
   historique figé (weekly_history.json) + point live (semaine en cours,
   données les plus fraîches) en dernière position. */
function buildWeeklyWeeks(data) {
  const weeks = [];
  const hist = window._profileWeekHistory;
  const histWeeks = hist && hist.weeks ? Object.entries(hist.weeks).sort((a, b) => a[0].localeCompare(b[0])) : [];
  for (const [key, wk] of histWeeks) {
    const p = wk && wk.players ? wk.players[data.publicId] : null;
    weeks.push({
      key,
      start: (wk && wk.start) || key,
      total: p ? p.t || 0 : 0,
      ffa: p ? p.f || 0 : 0,
      team: p ? p.te || 0 : 0,
      ranked: p ? p.r || 0 : 0,
      rank: p && p.k ? p.k : "—",
    });
  }
  // Semaine en cours : refresh avec les données live (dashboard_scores)
  const liveKey = (data.weekStart || "").slice(0, 10);
  const liveIdx = weeks.findIndex((w) => w.key === liveKey);
  if (liveIdx >= 0) {
    const w = weeks[liveIdx];
    w.total = data.total;
    w.ffa = data.ffa;
    w.team = data.team;
    w.ranked = data.ffaRanked + data.teamRanked;
    w.rank = data.rank;
  } else {
    // ⚠️ Garde-fou cache : si les données live sont PLUS ANCIENNES que la
    // dernière semaine de l'historique (dashboard_scores périmé dans le
    // navigateur, ex. après le reset du lundi), on ne les ajoute PAS.
    // Sinon un point « S2 » à droite affichait la semaine précédente →
    // inversion S1/S2 sur la courbe (bug signalé par Skailex).
    const lastKey = weeks.length ? weeks[weeks.length - 1].key : null;
    if (!lastKey || liveKey >= lastKey) {
      weeks.push({
        key: liveKey || "live",
        start: data.weekStart || new Date().toISOString(),
        total: data.total,
        ffa: data.ffa,
        team: data.team,
        ranked: data.ffaRanked + data.teamRanked,
        rank: data.rank,
      });
    }
  }
  // Labels = semaine de SAISON (pas index dans le tableau) : S1 = première
  // semaine suivie par le site (lundi 24/08/2026 00h00 Paris).
  // Un trou dans l'historique ne décale plus la numérotation — la semaine du
  // 31/08 reste S2 même si une semaine manque. Fallback = index si la date
  // est antérieure à la saison (données hors périmètre).
  // 🔄 Nouvelle saison de classement hebdo → mettre à jour WEEKLY_SEASON_START.
  const WEEKLY_SEASON_START_MS = Date.parse("2026-08-23T22:00:00.000Z"); // lundi 24/08 00h00 Paris
  weeks.forEach((w, i) => {
    let n = null;
    const t = Date.parse(w.start);
    if (Number.isFinite(t) && Number.isFinite(WEEKLY_SEASON_START_MS) && t >= WEEKLY_SEASON_START_MS) {
      n = 1 + Math.round((t - WEEKLY_SEASON_START_MS) / (7 * 86400000));
    }
    w.label = "S" + (n && n >= 1 ? n : i + 1);
  });
  return weeks;
}

function renderWeeklyChart() {
  const data = window._profileWeekData;
  if (!data || !data.publicId) return;

  let wrap = document.getElementById("weekly-chart-card");
  if (!wrap) {
    // En HAUT du profil (sous les cartes de stats), puis fallbacks historiques
    const mount = document.getElementById("pf2-weekly-top") || document.getElementById("pf2-below") || document.getElementById("career-stats-section") || document.getElementById("playtime-section-mount");
    if (!mount) return;
    wrap = document.createElement("div");
    wrap.id = "weekly-chart-card";
    wrap.className = "pf2-panel";
    wrap.innerHTML = `
      <header class="pf2-panel-head">
        <h3>${T("pf.chart_title", "Points par semaine")}</h3>
        <i class="pf2-panel-rule"></i>
        <span class="pf2-panel-sub">${T("pf.chart_sub", "Performance hebdomadaire (FFA, Team, Classé) — une nouvelle semaine s'ajoute chaque lundi")}</span>
      </header>
      <canvas id="weekly-chart-canvas" style="width:100%;height:300px;display:block"></canvas>
    `;
    mount.appendChild(wrap);
  }

  const canvas = document.getElementById("weekly-chart-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth;
  const H = 320;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // ── Data : S1 → Sn (historique) + semaine en cours en dernier point ──
  const weeks = buildWeeklyWeeks(data);
  if (weeks.length === 0) return;
  const rankedScore = data.ffaRanked + data.teamRanked;
  const isLive = (i) => i === weeks.length - 1; // dernier point = semaine en cours (live)
  const series = [
    { id: "ffa", label: T("pf.series_ffa", "FFA"), color: "#ef4444", points: weeks.map((w, i) => ({ score: w.ffa, rank: w.rank, detail: isLive(i) ? { wins: data.ffaCasual } : {}, date: w.start })) },
    { id: "team", label: T("pf.series_team", "Team"), color: "#2196f3", points: weeks.map((w, i) => ({ score: w.team, rank: w.rank, detail: isLive(i) ? { wins: data.teamCasual } : {}, date: w.start })) },
    { id: "ranked", label: T("pf.series_ranked", "Classé"), color: "#9333ea", points: weeks.map((w, i) => ({ score: w.ranked, rank: w.rank, detail: isLive(i) ? { ffa1v1: data.ffaRanked, team2v2: data.teamRanked } : {}, date: w.start })) },
    { id: "total", label: T("pf.series_total", "Total"), color: "#111827", points: weeks.map((w, i) => ({ score: w.total, rank: w.rank, detail: isLive(i) ? { ffa: data.ffa, team: data.team, ranked: rankedScore, allTime: data.allTimePoints } : { ffa: w.ffa, team: w.team, ranked: w.ranked }, date: w.start })) },
  ];

  // Store point positions for hover detection
  const pointPositions = [];

  // ── Layout ──
  const padding = { top: 40, right: 30, bottom: 50, left: 55 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;

  // ── Scale ──
  const allScores = series.flatMap(s => s.points.map(p => p.score));
  const maxScore = Math.max(...allScores, 10);
  const niceMax = Math.ceil(maxScore / 5) * 5 || 5;

  // X positions: Week 1 at far left, subsequent weeks spread right
  // For 1 week: place at left + small offset (not centered)
  // For multiple weeks: spread across full width
  const xForIndex = (i) => {
    if (weeks.length === 1) return padding.left + 20;
    return padding.left + (i / (weeks.length - 1)) * chartW;
  };
  const yForScore = (score) => padding.top + chartH - (score / niceMax) * chartH;

  // ── Grid + Y-axis (Score, left) ──
  ctx.fillStyle = "#6b7280";
  ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const val = Math.round((niceMax / 5) * i);
    const y = padding.top + chartH - (i / 5) * chartH;
    ctx.fillText(val, padding.left - 8, y + 3);
    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(W - padding.right, y);
    ctx.stroke();
  }

  // Y-axis label "Score"
  ctx.save();
  ctx.translate(14, padding.top + chartH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px Inter, sans-serif";
  ctx.fillText(T("pf.axis_score", "Score"), 0, 0);
  ctx.restore();

  // ── X-axis labels (S1, S2, … — échantillonnés si trop nombreuses) ──
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "center";
  const labelStep = weeks.length > 12 ? Math.ceil(weeks.length / 12) : 1;
  weeks.forEach((w, i) => {
    if (i % labelStep === 0 || i === weeks.length - 1) {
      ctx.fillText(w.label, xForIndex(i), padding.top + chartH + 20);
    }
  });

  // "Semaines" label centered
  ctx.fillStyle = "#9ca3af";
  ctx.font = "10px Inter, sans-serif";
  ctx.fillText(T("pf.axis_weeks", "Semaines"), padding.left + chartW / 2, H - 8);

  // ── Draw lines + points for each series ──
  series.forEach(s => {
    if (s.points.length === 0) return;

    // Line connecting points (only if 2+ weeks)
    if (s.points.length >= 2) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = xForIndex(i);
        const y = yForScore(p.score);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Points — dots only, except Total which gets a rank circle
    s.points.forEach((p, i) => {
      const x = xForIndex(i);
      const y = yForScore(p.score);

      if (s.id === "total" && p.rank && p.rank !== "—") {
        // Total point: rank circle with "#X" inside
        const r = 16;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.fillStyle = "#111827";
        ctx.font = "700 11px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("#" + p.rank, x, y);
        ctx.textBaseline = "alphabetic";

        // Movement arrow (up/down) compared to previous week
        if (i > 0) {
          const prev = s.points[i - 1];
          if (prev.rank && prev.rank !== "—") {
            const prevRank = parseInt(prev.rank);
            const currRank = parseInt(p.rank);
            if (currRank < prevRank) {
              // Better rank (lower number) → green up arrow
              ctx.fillStyle = "#10b981";
              ctx.font = "700 14px Inter, sans-serif";
              ctx.textAlign = "center";
              ctx.fillText("\u2191", x + r + 4, y - 4);
            } else if (currRank > prevRank) {
              // Worse rank (higher number) → red down arrow
              ctx.fillStyle = "#ef4444";
              ctx.font = "700 14px Inter, sans-serif";
              ctx.textAlign = "center";
              ctx.fillText("\u2193", x + r + 4, y - 4);
            }
          }
        }
      } else {
        // Other series: simple filled dot
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Store position for hover detection
      pointPositions.push({ x, y, r: s.id === "total" ? 18 : 12, series: s, point: p, weekIndex: i });
    });
  });

  // ── Legend (top right) ──
  const legendY = 20;
  let legendX = W - padding.right - 180;
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "left";
  series.forEach(s => {
    ctx.beginPath();
    ctx.arc(legendX, legendY - 3, 5, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#6b7280";
    ctx.fillText(s.label, legendX + 10, legendY);
    legendX += 45;
  });

  // ── Hover tooltip ──
  let tooltip = document.getElementById("weekly-chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "weekly-chart-tooltip";
    tooltip.style.cssText = "position:fixed;z-index:1000;display:none;pointer-events:none;background:rgba(26,20,16,0.97);border:1px solid rgba(255,165,80,0.3);border-radius:10px;padding:10px 14px;font-size:12px;color:#ffd9b3;box-shadow:0 8px 24px rgba(0,0,0,0.3);backdrop-filter:blur(12px);max-width:220px;line-height:1.6";
    document.body.appendChild(tooltip);
  }

  // Clone canvas to remove old event listeners
  const newCanvas = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(newCanvas, canvas);
  const ctx2 = newCanvas.getContext("2d");
  ctx2.drawImage(canvas, 0, 0, W, H);

  const hoverHandler = (e) => {
    const rect = newCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let found = null;
    for (const pp of pointPositions) {
      const dx = mx - pp.x;
      const dy = my - pp.y;
      if (Math.sqrt(dx * dx + dy * dy) <= pp.r) {
        found = pp;
        break;
      }
    }

    if (found) {
      const d = found.point.detail || {};
      const wMeta = weeks[found.weekIndex] || {};
      const dateStr = wMeta.start ? new Intl.DateTimeFormat(LOCALE(), { day: "2-digit", month: "2-digit" }).format(new Date(wMeta.start)) : "";
      const wkTitle = `${wMeta.label || ""}${dateStr ? ` <span style="color:#9ca3af;font-weight:400">· ${T("pf.tooltip_week_of", "semaine du {date}", { date: dateStr })}</span>` : ""}`;
      let html = `<div style="font-weight:700;color:#fff;margin-bottom:4px">${found.series.label} — ${wkTitle}</div>`;
      html += `<div style="color:#9ca3af;font-size:11px;margin-bottom:6px">${T("pf.tooltip_score", "Score: {n} pts", { n: found.point.score })}</div>`;

      if (found.series.id === "ffa") {
        if (d.wins !== undefined) html += `<div style="font-size:11px;color:#a89480">${T("pf.tooltip_wins_ffa", "Wins FFA: {n}", { n: d.wins || 0 })}</div>`;
      } else if (found.series.id === "team") {
        if (d.wins !== undefined) html += `<div style="font-size:11px;color:#a89480">${T("pf.tooltip_wins_team", "Wins Team: {n}", { n: d.wins || 0 })}</div>`;
      } else if (found.series.id === "ranked") {
        if (d.ffa1v1 !== undefined) html += `<div style="font-size:11px;color:#a89480">${T("pf.tooltip_1v1_wins", "1v1: {n} wins", { n: d.ffa1v1 || 0 })}</div>`;
        if (d.team2v2 !== undefined) html += `<div style="font-size:11px;color:#a89480">${T("pf.tooltip_2v2_wins", "2v2: {n} wins", { n: d.team2v2 || 0 })}</div>`;
      } else if (found.series.id === "total") {
        html += `<div style="font-size:11px;color:#a89480">${T("pf.tooltip_ffa_pts", "FFA: {n} pts", { n: d.ffa || 0 })}</div>`;
        html += `<div style="font-size:11px;color:#a89480">${T("pf.tooltip_team_pts", "Team: {n} pts", { n: d.team || 0 })}</div>`;
        html += `<div style="font-size:11px;color:#a89480">${T("pf.tooltip_ranked_pts", "Classé: {n} pts", { n: d.ranked || 0 })}</div>`;
        if (found.point.rank && found.point.rank !== "—") html += `<div style="font-size:11px;color:#a89480">${T("pf.tooltip_rank", "Rang hebdo: #{n}", { n: found.point.rank })}</div>`;
        if (d.allTime !== undefined) html += `<div style="font-size:11px;color:#a89480;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.1)">${T("pf.tooltip_alltime", "All-time: {n} pts", { n: d.allTime || 0 })}</div>`;
      }

      tooltip.innerHTML = html;
      tooltip.style.display = "block";

      let tx = e.clientX + 14;
      let ty = e.clientY - 10;
      if (tx > window.innerWidth - 250) tx = e.clientX - 240;
      tooltip.style.left = tx + "px";
      tooltip.style.top = ty + "px";

      newCanvas.style.cursor = "pointer";
    } else {
      tooltip.style.display = "none";
      newCanvas.style.cursor = "default";
    }
  };

  newCanvas.addEventListener("mousemove", hoverHandler);
  newCanvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    newCanvas.style.cursor = "default";
  });
}
/* ════════════════════════════════════════════════════════════════
   RÉCOMPENSES v2 — codes + cosmétiques (design 2026-08)
   ════════════════════════════════════════════════════════════════ */

const RW_SUBMIT_LABEL = () => T("pf.rw_submit", "Valider");

function setRwFeedback(type, msg) {
  const el = document.getElementById("rw-feedback");
  if (!el) return;
  el.className = "rw-feedback show " + type;
  const icon =
    type === "success"
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  el.innerHTML = icon + "<span>" + esc(msg) + "</span>";
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearRwFeedback() {
  const el = document.getElementById("rw-feedback");
  if (el) {
    el.className = "rw-feedback";
    el.innerHTML = "";
  }
}

function renderRewardCodeCard(publicId) {
  _rewardCardState.publicId = publicId;
  const container = document.getElementById("reward-code-section");
  if (!container) return;

  container.innerHTML = `
    <div class="rw-card rw-card-compact">
      <div class="rw-header">
        <span class="rw-header-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>
        </span>
        <div class="rw-header-text">
          <h2>${T("pf.rw_title", "Code de récompense")}</h2>
          <p>${T("pf.rw_sub", "Entre un code pour débloquer un cosmétique pour ton pseudo.")}</p>
        </div>
      </div>
      <div class="rw-redeem">
        <div class="rw-redeem-row">
          <div class="rw-input-wrap">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            <input type="text" id="reward-code-input" placeholder="${T("pf.rw_ph", "TON-CODE-ICI")}" autocomplete="off" spellcheck="false">
          </div>
          <button type="button" class="rw-submit" id="reward-code-submit" disabled>
            <span class="auth-spinner" aria-hidden="true"></span>
            <span class="rw-submit-label">${RW_SUBMIT_LABEL()}</span>
          </button>
        </div>
        <div class="rw-feedback" id="rw-feedback" role="status"></div>
      </div>
      <div class="rw-owned" id="rw-owned" hidden>
        <div class="rw-owned-head">
          <h3>${T("pf.rw_owned", "Mes cosmétiques")} <span class="rw-count" id="owned-skins-count">0</span></h3>
          <span class="rw-gallery-hint">${T("pf.rw_click_activate", "Clique pour activer")}</span>
        </div>
        <div class="rw-chips" id="rw-chips"></div>
      </div>
      <div class="rw-owned rw-owned-banners" id="rw-banners" hidden>
        <div class="rw-owned-head">
          <h3>${T("pf.rw_banners", "Mes bannières")} <span class="rw-count" id="owned-banners-count">0</span></h3>
          <span class="rw-gallery-hint">${T("pf.rw_banners_hint", "Clique pour l’appliquer sur ta plaquette")}</span>
        </div>
        <div class="rw-chips" id="rw-banner-chips"></div>
      </div>
    </div>
  `;

  const input = document.getElementById("reward-code-input");
  const btn = document.getElementById("reward-code-submit");

  input.addEventListener("input", () => {
    input.value = normalizeCode(input.value);
    btn.disabled = !input.value.trim();
    clearRwFeedback();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) handleRedeem();
  });
  btn.addEventListener("click", handleRedeem);

  refreshOwnedSkins(publicId);
  refreshOwnedBanners(publicId);
}

async function refreshOwnedSkins(publicId) {
  const ownedWrap = document.getElementById("rw-owned");
  if (!ownedWrap) return;

  try {
    const { ownedSkins, activeSkinId } = await fetchOwnedSkins(publicId);
    _rewardCardState.ownedSkins = ownedSkins;
    _rewardCardState.activeSkinId = activeSkinId;
    renderOwnedSkins(ownedSkins, activeSkinId);
  } catch (e) {
    console.warn("[profile] refreshOwnedSkins failed:", e);
  }
}

/**
 * Affiche les cosmétiques possédés en chips compactes.
 * La ligne n'apparaît QUE si le joueur possède au moins un skin du
 * catalogue — sinon la carte reste une simple entrée de code.
 * (Les ids hérités de l'ancien catalogue sont ignorés.)
 */
function renderOwnedSkins(ownedSkins, activeSkinId) {
  const wrap = document.getElementById("rw-owned");
  const chipsEl = document.getElementById("rw-chips");
  const countEl = document.getElementById("owned-skins-count");
  if (!wrap || !chipsEl) return;

  const owned = getUnlockableSkins().filter((s) =>
    ownedSkins.some((o) => o.skinId === s.id)
  );
  if (owned.length === 0) {
    wrap.hidden = true;
    chipsEl.innerHTML = "";
    if (countEl) countEl.textContent = "0";
    return;
  }

  wrap.hidden = false;
  if (countEl) countEl.textContent = String(owned.length);

  const isActive = (skinId) =>
    (skinId === DEFAULT_SKIN_ID && (!activeSkinId || activeSkinId === DEFAULT_SKIN_ID)) ||
    activeSkinId === skinId;

  const chip = (skin) => {
    const rarity = RARITY_META[skin.rarity] || RARITY_META.common;
    const active = isActive(skin.id);
    return `
      <button type="button" class="rw-chip ${active ? "active" : ""}" data-skin-id="${esc(skin.id)}" title="${esc(skin.description)}">
        <span class="rw-chip-preview"><span class="${skin.cssClass}">${esc(skin.name)}</span></span>
        <span class="rw-chip-dot" style="background:${rarity.color}"></span>
        ${active ? `<span class="rw-chip-badge">${T("pf.rw_active", "Actif")}</span>` : ""}
      </button>
    `;
  };

  chipsEl.innerHTML = chip(getSkin(DEFAULT_SKIN_ID)) + owned.map(chip).join("");

  chipsEl.querySelectorAll(".rw-chip[data-skin-id]").forEach((el) => {
    el.addEventListener("click", () => handleActivate(el.dataset.skinId));
  });
}

async function handleRedeem() {
  // Verrou : les codes cosmétiques ne concernent que le profil du compte connecté
  if (!editingAllowed) { showToast(T("pf.rw_lock", "Les codes cosmétiques se saisissent sur ton propre profil."), "warning"); return; }
  const input = document.getElementById("reward-code-input");
  const btn = document.getElementById("reward-code-submit");
  const label = btn ? btn.querySelector(".rw-submit-label") : null;
  if (!input || !input.value.trim()) return;

  const code = input.value.trim();
  const publicId = _rewardCardState.publicId;
  if (!publicId) return;

  btn.disabled = true;
  btn.classList.add("is-redirecting");
  if (label) label.textContent = T("pf.rw_validating", "Validation…");
  clearRwFeedback();

  try {
    const result = await redeemCode(code, publicId);

    /* ── Bannière pixel art : auto-activation sur la plaquette ─────
     * (skins.php a routé le code vers tfh_user_banners — kind:"banner") */
    if (result.kind === "banner") {
      const bName = getBanner(result.skinId)?.name || result.skinId;
      let message = result.alreadyOwned
        ? T("pf.banner_already", "Tu possèdes déjà la bannière « {name} » — réactivée.", { name: bName })
        : T("pf.banner_unlocked", "Bannière « {name} » débloquée et appliquée sur ta plaquette !", { name: bName });
      try {
        const act = await activateBanner(publicId, result.skinId);
        _rewardCardState.activeBannerId = act.activeBannerId;
        paintBanner(document.querySelector(".pf2-id"), act.activeBannerId);
      } catch (e) {
        if (!result.alreadyOwned) {
          message = `${result.message} ${T("pf.rw_activate_below", "Active-le ci-dessous.")}`;
        }
      }
      setRwFeedback("success", message);
      showToast(
        result.alreadyOwned
          ? T("pf.banner_reactivated_short", "Bannière « {name} » réactivée", { name: bName })
          : T("pf.banner_unlocked_short", "Bannière « {name} » débloquée !", { name: bName }),
        result.alreadyOwned ? "info" : "success"
      );
      input.value = "";
      await refreshOwnedBanners(publicId);
      return; // le bloc finally restaure le bouton
    }

    let message = result.message;

    // Auto-activation : le skin débloqué s'applique aussitôt au pseudo.
    // (Peut échouer pour un id hérité hors catalogue → message dégradé.)
    try {
      await activateSkin(publicId, result.skinId);
      message = result.alreadyOwned
        ? T("pf.skin_reactivated", "Skin « {name} » déjà dans ta collection — réactivé.", { name: result.skinName })
        : T("pf.skin_unlocked", "Skin « {name} » débloqué et activé !", { name: result.skinName });
    } catch (e) {
      if (!result.alreadyOwned) message = `${result.message} ${T("pf.rw_activate_below", "Active-le ci-dessous.")}`;
    }

    setRwFeedback("success", message);
    showToast(
      result.alreadyOwned
        ? T("pf.skin_reactivated_short", "Skin « {name} » réactivé", { name: result.skinName })
        : T("pf.cosmetic_unlocked", "Cosmétique « {name} » débloqué !", { name: result.skinName }),
      result.alreadyOwned ? "info" : "success"
    );
    input.value = "";
    await refreshOwnedSkins(publicId);
    if (currentProfile) renderHero(currentUser, currentProfile);
  } catch (e) {
    setRwFeedback("error", e.message || T("pf.code_invalid_expired", "Code invalide ou expiré."));
    showToast(e.message || T("pf.code_invalid", "Code invalide"), "error");
  } finally {
    btn.disabled = true; // sera ré-activé par l'input listener si besoin
    btn.classList.remove("is-redirecting");
    if (label) label.textContent = RW_SUBMIT_LABEL();
  }
}

async function handleActivate(skinId) {
  // Verrou : activer un skin ne concerne que le profil du compte connecté
  if (!editingAllowed) { showToast(T("pf.skin_lock", "Les cosmétiques s’activent sur ton propre profil."), "warning"); return; }
  const publicId = _rewardCardState.publicId;
  if (!publicId) return;
  try {
    const result = await activateSkin(publicId, skinId);
    _rewardCardState.activeSkinId = result.activeSkinId;
    showToast(
      skinId === DEFAULT_SKIN_ID ? T("pf.skin_default_active", "Skin standard activé") : T("pf.skin_activated", "Skin « {name} » activé", { name: getSkin(skinId).name }),
      "success"
    );
    renderOwnedSkins(_rewardCardState.ownedSkins, result.activeSkinId);
    // Rafraîchit le pseudo du hero avec le skin actif
    if (currentProfile) renderHero(currentUser, currentProfile);
  } catch (e) {
    showToast(e.message || T("pf.skin_activate_fail", "Activation impossible"), "error");
  }
}

/* ══════════════════════════════════════════════════════════════
   BANNIÈRES PIXEL ART (plaquette de pseudo)
   Possession/activation via /api/banners.php (tfh_user_banners).
   Le rachat passe par le MÊME champ de code (skins.php route les
   skin_id préfixés banner_ vers la table des bannières).
   ══════════════════════════════════════════════════════════════ */

async function refreshOwnedBanners(publicId) {
  const wrap = document.getElementById("rw-banners");
  if (!wrap) return;
  try {
    const { ownedBanners, activeBannerId } = await fetchOwnedBanners(publicId);
    _rewardCardState.ownedBanners = ownedBanners;
    _rewardCardState.activeBannerId = activeBannerId;
    renderOwnedBanners(ownedBanners, activeBannerId);
  } catch (e) {
    console.warn("[profile] refreshOwnedBanners failed:", e);
  }
}

/**
 * Chips « Mes bannières » : aperçu pixel art en miniature + puce « Aucune »
 * (plaquette standard). N'apparaît QUE si le joueur possède au moins une
 * bannière du catalogue.
 */
function renderOwnedBanners(ownedBanners, activeBannerId) {
  const wrap = document.getElementById("rw-banners");
  const chipsEl = document.getElementById("rw-banner-chips");
  const countEl = document.getElementById("owned-banners-count");
  if (!wrap || !chipsEl) return;

  const owned = BANNERS.filter((b) => (ownedBanners || []).some((o) => o.bannerId === b.id));
  if (owned.length === 0) {
    wrap.hidden = true;
    chipsEl.innerHTML = "";
    if (countEl) countEl.textContent = "0";
    return;
  }

  wrap.hidden = false;
  if (countEl) countEl.textContent = String(owned.length);

  const preview = (banner) => {
    const url = renderBannerUrl(banner, currentTheme());
    return `<img src="${url}" alt="" width="${banner.cols}" height="${banner.rows}" loading="lazy">`;
  };

  const chip = (banner) => {
    const rarity = RARITY_META[banner.rarity] || RARITY_META.common;
    const active = activeBannerId === banner.id;
    return `
      <button type="button" class="rw-chip rw-chip-banner ${active ? "active" : ""}" data-banner-id="${esc(banner.id)}" title="${esc(banner.description)}">
        <span class="rw-chip-preview">${preview(banner)}</span>
        <span class="rw-chip-label">${esc(banner.name)}</span>
        <span class="rw-chip-dot" style="background:${rarity.color}"></span>
        ${active ? `<span class="rw-chip-badge">${T("pf.rw_active", "Actif")}</span>` : ""}
      </button>
    `;
  };

  const noneActive = !activeBannerId;
  chipsEl.innerHTML =
    `<button type="button" class="rw-chip rw-chip-banner ${noneActive ? "active" : ""}" data-banner-id="none" title="${esc(T("pf.rw_banner_none_title", "Retire la bannière — plaquette standard"))}">
       <span class="rw-chip-preview rw-chip-none-preview">${T("pf.rw_banner_none", "Aucune")}</span>
       <span class="rw-chip-label">${T("pf.rw_banner_none_label", "Standard")}</span>
     </button>` +
    owned.map(chip).join("");

  chipsEl.querySelectorAll(".rw-chip[data-banner-id]").forEach((el) => {
    el.addEventListener("click", () => handleActivateBanner(el.dataset.bannerId));
  });
}

async function handleActivateBanner(bannerId) {
  // Verrou : l'activation ne concerne que le profil du compte connecté
  if (!editingAllowed) { showToast(T("pf.banner_lock", "Les bannières s’activent sur ton propre profil."), "warning"); return; }
  const publicId = _rewardCardState.publicId;
  if (!publicId) return;
  try {
    const result = await activateBanner(publicId, bannerId);
    _rewardCardState.activeBannerId = result.activeBannerId;
    // Applique (ou retire) immédiatement sur la plaquette affichée
    paintBanner(document.querySelector(".pf2-id"), result.activeBannerId);
    showToast(
      bannerId === DEFAULT_BANNER_ID
        ? T("pf.banner_removed", "Bannière retirée — plaquette standard")
        : T("pf.banner_activated", "Bannière « {name} » appliquée sur ta plaquette !", { name: getBanner(bannerId)?.name || bannerId }),
      "success"
    );
    renderOwnedBanners(_rewardCardState.ownedBanners, result.activeBannerId);
  } catch (e) {
    showToast(e.message || T("pf.banner_activate_fail", "Activation impossible"), "error");
  }
}

/* ════════════════════════════════════════════════════════════════
   CAREER STATS OVERVIEW + CHARTS
   ════════════════════════════════════════════════════════════════ */

function renderCareerStats(statsTree, publicId) {
  // Cockpit redesign: the full career overview (metrics, rings, cat bars,
  // activity, recent games, map stats) is now rendered by renderPrecomputedStats
  // once the pre-computed stats file (player-stats/<pid>.json) is loaded by
  // loadAllGamesForStats(). This function is kept as a no-op placeholder so the
  // existing loadStats flow doesn't break — the container shows a loading state
  // until the cockpit data arrives.
  const container = document.getElementById("career-stats-section");
  if (!container) return;
  container.innerHTML = `<div class="pf2-loading"><div class="pf2-loading-spinner"></div><span>${T("pf.dossier_loading", "Chargement du dossier…")}</span></div>`;
}

/* ════════════════════════════════════════════════════════════════
   ALL GAMES PAGINATION (for playtime + map stats)
   ════════════════════════════════════════════════════════════════ */

async function loadAllGamesForStats(publicId, playerData) {
  if (_allGamesLoading) return;
  _allGamesLoading = true;
  const runSeq = ++_statsRunSeq;

  const mount = document.getElementById("career-stats-section");
  if (mount) mount.innerHTML = `<div class="pf2-loading"><div class="pf2-loading-spinner"></div><span>${T("pf.dossier_loading", "Chargement du dossier…")}</span></div>`;

  // Load the PRE-CALCULATED stats file — instant, zero calculation!
  // Generated by compute-player-stats.js (GitHub Actions workflow, continuous loop).
  try {
    const statsRes = await fetch(`player-stats/${encodeURIComponent(publicId)}.json`, { cache: "no-store" });
    if (statsRes.ok) {
      const stats = await statsRes.json();
      if (stats && stats.totalGames != null) {
        if (runSeq !== _statsRunSeq) { _allGamesLoading = false; return; }
        if (mount) mount.innerHTML = "";
        renderPrecomputedStats(stats, mount);
        _allGamesLoading = false;
        return;
      }
    }
  } catch (e) {
    console.warn("[profile] Could not load pre-computed stats file:", e.message);
  }

  // ── v5.36 : dossier depuis le PAYLOAD PRÉ-GÉNÉRÉ (0 appel réseau) ──
  // Totaux de carrière exacts (arbre officiel embarqué) + échantillon des ~100
  // dernières parties archivées en DB (cartes, activité, séries). Instantané :
  // le payload est déjà en mémoire (prefetch au survol / sessionStorage).
  try {
    const payloadStats = await getProfilePayload(publicId); // promesse partagée — déjà résolue si loadStats l'a demandée
    if (payloadStats?.official?.stats) {
      const sample = payloadRecentSample(payloadStats);
      const dossier = buildLiveStatsFromData(
        publicId,
        payloadStats.official.stats,
        sample,
        playerData?.username || payloadStats.official.username || payloadStats.player?.lastUsername || null
      );
      if (dossier) {
        if (runSeq !== _statsRunSeq) { _allGamesLoading = false; return; }
        if (mount) mount.innerHTML = "";
        renderPrecomputedStats(dossier, mount);
        _allGamesLoading = false;
        return;
      }
    }
  } catch (e) {
    console.warn("[profile] payload dossier failed:", e?.message);
  }

  // ── Fallback v5.15 : calcul LIVE côté navigateur ──
  // Le dossier pré-calculé n'existe que pour les joueurs suivis par le
  // pipeline CI (sync-players.json). Pour tout autre joueur on construit
  // maintenant un dossier de substitution depuis l'API OpenFront :
  //  - totaux de carrière EXACTS (arbre stats de /public/player/{id}) ;
  //  - échantillon des ~100 dernières parties (cartes, activité, séries…).
  // Avant : message « Stats en cours de calcul » mensonger (le dossier ne
  // serait JAMAIS calculé pour un joueur non suivi) → profil vide = juste
  // un nom. Désormais chaque profil a un vrai cockpit.
  try {
    const live = await buildLiveStatsFromApi(publicId, playerData || null);
    if (runSeq !== _statsRunSeq) { _allGamesLoading = false; return; }
    if (live) {
      if (mount) mount.innerHTML = "";
      renderPrecomputedStats(live, mount);
      _allGamesLoading = false;
      return;
    }
  } catch (e) {
    console.warn("[profile] Live stats fallback failed:", e.message);
  }

  // Dernier recours : API OpenFront injoignable elle aussi.
  if (runSeq !== _statsRunSeq) { _allGamesLoading = false; return; }
  if (mount) {
    mount.innerHTML = `
      <div class="pf2-fallback">
        <div class="pf2-fallback-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <h3>${T("pf.fallback_title", "Stats momentanément indisponibles")}</h3>
        <p>${T("pf.fallback_sub", "Impossible de contacter le serveur de statistiques. Recharge la page dans quelques instants.")}</p>
        <button type="button" class="pf2-fallback-btn" id="pf2-stats-retry">${T("pf.stats_retry", "Réessayer")}</button>
      </div>
    `;
    // v5.15.1 : bouton « Réessayer » réel (relance dossier pré-calculé +
    // fallback live) — plus besoin de recharger toute la page, et le hero/
    // l'élo/la vitrine déjà chargés restent en place.
    document.getElementById("pf2-stats-retry")?.addEventListener("click", () => {
      _allGamesLoading = false;
      loadAllGamesForStats(publicId, null);
    });
  }
  _allGamesLoading = false;
}

/* ════════════════════════════════════════════════════════════════
   v5.15 — DOSSIER DE SUBSTITUTION (profils NON suivis par le CI)
   Construit un objet compatible renderPrecomputedStats depuis :
   1. /public/player/{id}          → arbre de carrière (totaux EXACTS)
   2. /public/player/{id}/games    → échantillon (~100 parties récentes)
   ════════════════════════════════════════════════════════════════ */

/** Classification d'une partie API → clé de catégorie du cockpit. */
function classifyLiveGame(g) {
  return classifyGame(g); // playtime-stats.js — même logique que le pipeline CI
}

/**
 * Agrège l'arbre de carrière OpenFront ({Private,Public,Singleplayer,Ranked})
 * en totaux exacts par catégorie de cockpit. `recent` est ignoré (fenêtre
 * courte — déjà inclus dans les feuilles carrière).
 * Mode FFA/HvN → côté casual ; Team → côté team ; Ranked/1v1 → ffaRanked ;
 * Ranked/2v2 → teamRanked. Private/Singleplayer comptent en casual.
 */
function walkCareerTree(statsTree) {
  const cats = {
    ffaCasual: { wins: 0, losses: 0, total: 0 },
    ffaRanked: { wins: 0, losses: 0, total: 0 },
    teamCasual: { wins: 0, losses: 0, total: 0 },
    teamRanked: { wins: 0, losses: 0, total: 0 },
  };
  if (!statsTree || typeof statsTree !== "object") return cats;
  for (const topKey of Object.keys(statsTree)) {
    if (topKey === "recent") continue; // agrégats fenêtre courte — JAMAIS sommés
    const top = statsTree[topKey];
    if (!top || typeof top !== "object") continue;
    const isRankedTop = topKey === "Ranked";
    for (const modeKey of Object.keys(top)) {
      const mode = top[modeKey];
      if (!mode || typeof mode !== "object") continue;
      const isTeamMode = modeKey === "Team" || /^\d+v\d+$/i.test(modeKey);
      for (const diffKey of Object.keys(mode)) {
        const leaf = mode[diffKey];
        if (!leaf || typeof leaf !== "object") continue;
        if (leaf.total == null && leaf.losses == null) continue; // pas une feuille
        const w = parseInt(leaf.wins, 10) || 0;
        const l = parseInt(leaf.losses, 10) || (parseInt(leaf.total, 10) || 0) - w;
        let bucket;
        if (isRankedTop) bucket = modeKey === "2v2" ? "teamRanked" : "ffaRanked";
        else bucket = isTeamMode ? "teamCasual" : "ffaCasual";
        cats[bucket].wins += w;
        cats[bucket].losses += l;
        cats[bucket].total += w + l;
      }
    }
  }
  return cats;
}

/** Échantillon paginé des dernières parties (cursor API OpenFront).
 *  Une page en échec interrompt la pagination — on garde ce qui est déjà
 *  collecté (les totaux carrière, eux, restent exacts via l'arbre). */
async function fetchGamesSample(publicId, maxPages = 10) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `/public/player/${encodeURIComponent(publicId)}/games` +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
    let data;
    try {
      data = await fetchOpenFront(url);
    } catch (e) {
      if (all.length === 0) throw e; // 1re page KO → l'appelant décidera
      break; // pages suivantes KO → échantillon partiel suffisant
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    cursor = data?.nextCursor;
    if (!cursor || results.length === 0) break;
  }
  return all;
}

/**
 * Dossier de substitution pour un profil non suivi. Retourne un objet au
 * format du fichier player-stats (renderPrecomputedStats) marqué
 * `isSample:true` — totaux de carrière exacts (arbre), détail par carte /
 * activité / séries issus de l'échantillon récent (annotés comme tels).
 */
async function buildLiveStatsFromApi(publicId, playerData) {
  let tree = playerData?.stats || null;
  if (!tree) {
    const data = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    tree = data?.stats || null;
  }
  if (!tree) return null;

  // Échantillon de parties — non bloquant en cas d'échec (totaux restent exacts).
  let sample = [];
  try {
    sample = await fetchGamesSample(publicId, 10);
  } catch (e) {
    console.warn("[profile] games sample failed:", e.message);
  }

  return buildLiveStatsFromData(publicId, tree, sample, playerData?.username || null);
}

/**
 * v5.36 — Agrégation PURE (aucun réseau), corps historique de
 * buildLiveStatsFromApi : totaux de carrière exacts depuis l'arbre officiel +
 * détail (cartes, activité, séries, playtime estimé) depuis l'échantillon.
 * Partagée par le fallback live OpenFront ET le dossier instantané construit
 * depuis le payload pré-généré (échantillon = dernières parties de la DB site).
 */
function buildLiveStatsFromData(publicId, tree, sample, username) {
  if (!tree || typeof tree !== "object") return null;
  sample = Array.isArray(sample) ? sample : [];
  const cats = walkCareerTree(tree);
  const totalWins = cats.ffaCasual.wins + cats.ffaRanked.wins + cats.teamCasual.wins + cats.teamRanked.wins;
  const totalGames = cats.ffaCasual.total + cats.ffaRanked.total + cats.teamCasual.total + cats.teamRanked.total;
  if (totalGames <= 0 && sample.length === 0) return null;

  // Durées + répartition temporelle depuis l'échantillon
  let sampleSec = 0, sampleCount = 0;
  const catSec = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const catGames = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const mapAgg = new Map(); // map → {count,wins,losses,sec,lastPlayed}
  const byWeekday = [0, 0, 0, 0, 0, 0, 0]; // Lun-first (même convention que compute-player-stats)
  const byDay = new Map(); // JJ/MM/AAAA (Europe/Paris) → parties
  // Même convention horaire que le pipeline CI (Europe/Paris) pour que les
  // panneaux activité/sparkline soient identiques entre dossier CI et dossier live.
  const WD_MAP = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  let wdFmt, dayFmt;
  try {
    wdFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short" });
    dayFmt = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric" });
  } catch (e) {
    wdFmt = null; dayFmt = null;
  }
  let longestSec = 0;
  for (const g of sample) {
    const dur = gameDurationSec(g);
    const cat = classifyLiveGame(g);
    sampleSec += dur; sampleCount++;
    catSec[cat] += dur; catGames[cat]++;
    if (dur > longestSec) longestSec = dur;
    const mapName = String(g.map || "").trim();
    if (mapName) {
      let m = mapAgg.get(mapName);
      if (!m) { m = { count: 0, wins: 0, losses: 0, sec: 0, lastPlayed: 0 }; mapAgg.set(mapName, m); }
      m.count++;
      if (g.result === "victory") m.wins++;
      else if (g.result === "defeat") m.losses++;
      m.sec += dur;
      const ts = g.start ? new Date(g.start).getTime() : 0;
      if (ts > m.lastPlayed) m.lastPlayed = ts;
    }
    if (g.start) {
      const ts = new Date(g.start).getTime();
      if (wdFmt && dayFmt) {
        const wd = WD_MAP[wdFmt.format(ts)];
        if (wd != null) byWeekday[wd]++;
        const key = dayFmt.format(ts);
        byDay.set(key, (byDay.get(key) || 0) + 1);
      }
    }
  }
  const avgGameSec = sampleCount > 0 ? sampleSec / sampleCount : 0;

  // Playtime estimé : moyenne échantillon × parties de carrière (annoté ≈)
  const estTotalSec = Math.round(avgGameSec * totalGames);
  const playtime = {
    totalSec: estTotalSec,
    avgGameSec: Math.round(avgGameSec * 10) / 10,
    longestSec,
    shortestSec: null,
    byCategory: {},
  };
  for (const key of Object.keys(catSec)) {
    const share = sampleSec > 0 ? catSec[key] / sampleSec : 0;
    playtime.byCategory[key] = {
      games: cats[key].total,
      playtimeSec: Math.round(estTotalSec * share),
      wins: cats[key].wins,
    };
  }

  // Stats par carte (échantillon récent)
  const maps = [...mapAgg.entries()].map(([map, m]) => {
    const decided = m.wins + m.losses;
    const wr = decided > 0 ? m.wins / decided : 0;
    return {
      map, count: m.count, wins: m.wins, losses: m.losses,
      playtimeSec: m.sec,
      avgDuration: m.count > 0 ? m.sec / m.count : 0,
      winRate: wr,
      lastPlayed: m.lastPlayed ? new Date(m.lastPlayed).toISOString() : null,
      formatted: {
        winRate: formatPct(wr),
        avgDuration: formatDuration(m.count > 0 ? m.sec / m.count : 0),
        lastPlayed: m.lastPlayed ? formatDateShort(new Date(m.lastPlayed).toISOString()) : "—",
      },
    };
  }).sort((a, b) => b.count - a.count);

  // Séries : série courante depuis la partie la plus récente ; record = max
  // observé dans l'échantillon (approximation honnête, annotée).
  let current = 0, best = 0, run = 0;
  for (const g of sample) {
    if (g.result === "victory") { run++; if (run > best) best = run; }
    else if (g.result === "defeat") { run = 0; }
  }
  for (const g of sample) {
    if (g.result === "victory") current++;
    else break;
  }

  // Sparkline 7 derniers jours (échantillon — exact si le joueur est actif)
  const sparkline7d = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = dayFmt ? dayFmt.format(d.getTime()) : "__";
    sparkline7d.push(byDay.get(key) || 0);
  }

  const points = totalWins * 4 + (totalGames - totalWins);
  const fmtNum = (n) => new Intl.NumberFormat(LOCALE()).format(Number(n) || 0);
  const recentGames = sample.slice(0, 20).map((g) => ({ ...g, category: classifyLiveGame(g) }));

  return {
    publicId,
    username: username || null,
    computedAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
    isSample: true,
    sampleSize: sample.length,
    totalGames,
    careerWins: {
      ffaCasual: cats.ffaCasual.wins, ffaRanked: cats.ffaRanked.wins,
      teamCasual: cats.teamCasual.wins, teamRanked: cats.teamRanked.wins,
    },
    totalWins,
    points,
    level: Math.floor(points / 100),
    levelProgress: points % 100,
    levelNextAt: (Math.floor(points / 100) + 1) * 100,
    formatted: {
      points: fmtNum(points),
      totalWins: fmtNum(totalWins),
      totalGames: fmtNum(totalGames),
      totalPlaytime: "≈ " + formatDuration(estTotalSec),
      totalPlaytimeCompact: "≈ " + formatDurationCompact(estTotalSec),
      avgGameDuration: sampleCount > 0 ? formatDuration(avgGameSec) : "—",
      longestGame: longestSec > 0 ? formatDuration(longestSec) : "—",
      winrate: totalGames > 0 ? formatPct(totalWins / totalGames) : "—",
    },
    playtime,
    results: { victory: totalWins, defeat: totalGames - totalWins },
    maps,
    activity: { byWeekday },
    sparkline7d,
    streaks: { current, best },
    recentGames,
  };
}

/** Helpers de formatage — réutilise playtime-stats.js (déjà importé).
 *  formatDuration / formatDurationCompact / formatPct / gameDurationSec. */

/* ── v5.15 — Rendu d'un MOTIF (pattern) OpenFront sur canvas ──
   Portage fidèle de PatternDecoder.ts / PatternPreview.ts (OpenFrontIO) :
   base64url → en-tête 3 octets (version, scale+largeur, hauteur) puis
   bitmap 1 bit/pixel — bit=0 → couleur primaire, bit=1 → secondaire.
   Couleurs par défaut de l'aperçu officiel : #ffffff / #000000. */

function decodePatternDataClient(b64) {
  const s = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length < 3 || bytes[0] !== 0) throw new Error("bad pattern");
  const scale = bytes[1] & 0x07;
  const width = (((bytes[2] & 0x03) << 5) | ((bytes[1] >> 3) & 0x1f)) + 2;
  const height = ((bytes[2] >> 2) & 0x3f) + 2;
  const expectedBytes = Math.ceil((width * height) / 8);
  if (bytes.length - 3 < expectedBytes) throw new Error("pattern too short");
  return { scale, width, height, bytes };
}

/** Peint le motif (mosaïque de tuiles) dans un canvas existant. Retourne bool. */
function paintPatternToCanvas(canvas, patternData, cssSize) {
  try {
    const dec = decodePatternDataClient(patternData);
    const dpr = Math.min(3, Math.max(1, Math.floor(window.devicePixelRatio || 1)));
    const px = Math.max(1, Math.round(cssSize * dpr));
    const tileW = dec.width << dec.scale;
    const tileH = dec.height << dec.scale;
    const cols = Math.max(1, Math.floor(px / tileW));
    const rows = Math.max(1, Math.floor(px / tileH));
    canvas.width = cols * tileW;
    canvas.height = rows * tileH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const img = ctx.createImageData(canvas.width, canvas.height);
    const data = img.data;
    let i = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const px2 = (x >> dec.scale) % dec.width;
        const py2 = (y >> dec.scale) % dec.height;
        const idx = py2 * dec.width + px2;
        const bit = (dec.bytes[3 + (idx >> 3)] >> (idx & 7)) & 1;
        // bit=0 → primaire (#ffffff), bit=1 → secondaire (#000000)
        const v = bit === 0 ? 255 : 0;
        data[i++] = v; data[i++] = v; data[i++] = v; data[i++] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Peint le motif le plus récemment porté du joueur dans l'avatar du héros
 * (sinon laisse l'initiale). Appelé après chaque rendu de vitrine.
 */
function paintAvatarFromCosmetics(cosmetics) {
  const avatarEl = document.getElementById("profile-avatar-large");
  if (!avatarEl || !Array.isArray(cosmetics)) return;
  const pat = cosmetics.find((c) => String(c.category || "").toLowerCase() === "pattern" && c.patternData);
  if (!pat) return;
  const rect = avatarEl.getBoundingClientRect();
  const cssSize = Math.max(48, Math.round(rect.width || 96));
  const canvas = document.createElement("canvas");
  canvas.className = "pf-sc-canvas pf-sc-avatar-pattern";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", T("pf.showcase_cat_pattern", "Motif"));
  if (!paintPatternToCanvas(canvas, pat.patternData, cssSize)) return;
  avatarEl.innerHTML = "";
  avatarEl.appendChild(canvas);
}

/* ════════════════════════════════════════════════════════════════
   [COCKPIT-REDESIGN] The 4 functions below (renderPlaytimeStats,
   renderActivityStats, renderMapStatsTable, renderRecentGamesFull) were
   removed and merged into the new renderPrecomputedStats() which builds
   the Cockpit layout from the pre-computed stats file.
   The map stats table + recent games list are kept inside the cockpit,
   just restyled and rendered inline by renderPrecomputedStats.
   ════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════
   GAME DETAIL MODAL — opens when clicking a recent game row
   ════════════════════════════════════════════════════════════════ */

/** Attach click handlers to all [data-game-id] rows inside `container`. */
function attachGameRowClickHandlers(container, games) {
  if (!container) return;
  const rows = container.querySelectorAll('[data-game-id]');
  rows.forEach((row) => {
    const open = () => {
      const id = row.getAttribute('data-game-id');
      const game = games.find((g) => String(g.gameId) === id);
      if (game) showGameModal(game);
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      open();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

/** Show a modal with detailed info about a single game. */
function showGameModal(game) {
  let modal = document.getElementById('game-detail-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'game-detail-modal';
    modal.className = 'game-modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="game-modal">
        <button class="game-modal-close" aria-label="${T("modal.close", "Fermer")}" type="button">&times;</button>
        <div class="game-modal-content"></div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('.game-modal-close')) {
        closeGameModal();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-open')) closeGameModal();
    });
  }

  const cat = classifyGame(game);
  const catLabels = { ffaCasual: "FFA Casual", ffaRanked: "1v1", teamCasual: "Team Casual", teamRanked: "2v2" };
  const resultColor = game.result === "victory" ? "#10b981" : game.result === "defeat" ? "#ef4444" : game.result === "incomplete" ? "#6B7280" : "#9CA3AF";
  const resultLabel = game.result === "victory" ? T("pf.result_victory", "Victoire") : game.result === "defeat" ? T("pf.result_defeat", "Défaite") : game.result === "incomplete" ? T("pf.result_incomplete", "Incomplet") : (game.result || "—");
  const duration = game.durationSeconds || game.duration;
  const startDate = game.start ? formatFrenchDate(new Date(game.start).getTime()) : "—";
  const replayUrl = game.gameId ? `https://openfront.io/game/${encodeURIComponent(game.gameId)}` : null;

  const content = modal.querySelector('.game-modal-content');
  content.innerHTML = `
    <div class="game-modal-result-badge" style="background:${resultColor}">${esc(resultLabel)}</div>
    <h3 class="game-modal-map">${esc(game.map || T("pf.unknown_map", "Carte inconnue"))}</h3>
    <div class="game-modal-rows">
      <div class="game-modal-row"><span class="game-modal-row-label">${T("pf.row_mode", "Mode")}</span><span class="game-modal-row-value">${esc(catLabels[cat] || game.mode || "—")}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">${T("pf.row_ranked_type", "Type classé")}</span><span class="game-modal-row-value">${esc(game.rankedType || "—")}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">${T("pf.row_duration", "Durée")}</span><span class="game-modal-row-value">${duration ? formatDurationCompact(Number(duration) || 0) : "—"}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">${T("pf.row_players", "Joueurs")}</span><span class="game-modal-row-value">${game.totalPlayers != null ? esc(String(game.totalPlayers)) : "—"}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">${T("profile.col_date", "Date")}</span><span class="game-modal-row-value">${esc(startDate)}</span></div>
      <div class="game-modal-row"><span class="game-modal-row-label">Game ID</span><span class="game-modal-row-value game-modal-gameid">${esc(String(game.gameId || "—"))}</span></div>
    </div>
    ${game.gameId ? `<a class="game-modal-replay" href="game.html?id=${encodeURIComponent(String(game.gameId))}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> ${T("pf.full_game_page", "Page partie complète sur TheFrontHub")}</a>` : ""}
    ${replayUrl ? `<a class="game-modal-replay" href="${replayUrl}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> ${T("pf.view_replay_of", "Voir le replay sur OpenFront")}</a>` : ""}
  `;

  modal.classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

function closeGameModal() {
  const modal = document.getElementById('game-detail-modal');
  if (modal) modal.classList.remove('is-open');
  document.body.style.overflow = '';
}

/* ════════════════════════════════════════════════════════════════
   [COCKPIT-REDESIGN] renderRecentGamesFull was removed — recent games
   are now rendered inline by renderPrecomputedStats (in the cockpit's
   bottom full-width section). The game modal (showGameModal / closeGameModal
   / attachGameRowClickHandlers) is kept as-is for clickable row details.
   ════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════
   FALLBACK: si onAuthStateChanged ne se déclenche pas (Firebase CDN
   bloqué ou lent), force le rendu du profil public après 8s.
   ════════════════════════════════════════════════════════════════ */
setTimeout(() => {
  const loading = document.getElementById("profile-loading");
  if (loading && loading.classList.contains("is-active")) {
    const pubReq = getPublicProfileRequest();
    if (pubReq) {
      console.warn("[profile] Auth state timeout — forcing public profile render");
      currentUser = null;
      currentProfile = null;
      updateSidebarUI(null);
      viewingPublicId = pubReq.publicId;
      viewingUsername = pubReq.username;
      showView("profile-main");
      renderPublicProfile(pubReq.username, pubReq.publicId);
      loadVipForProfile();
      loadStats(pubReq.publicId);
      loadProfileSpeedruns(pubReq.publicId, false, [pubReq.username]);
    } else {
      console.warn("[profile] Auth state timeout — showing gate");
      showView("profile-gate");
    }
  }
}, 8000);

/* ════════════════════════════════════════════════════════════════
   SPEEDRUNS PAR CARTE (section « Speedruns » du profil)
   ════════════════════════════════════════════════════════════════
   Source : runs_public.json.gz (payload public compact ~110 Ko =
   top 25 par carte, régénéré par la sync toutes les 5 min). On y
   retrouve les runs du joueur via ses alias publics (pseudo hub +
   pseudos en jeu), puis on calcule son meilleur temps et son rang
   sur chaque carte. Le playerId des runs est un ID de SESSION
   (change à chaque partie) → matching par NOM uniquement (même
   convention que app.js, qui ne s'y fie jamais aveuglément).
   Tout échec = section laissée masquée, jamais d'erreur bloquante. */

let _speedrunPayloadCache = { data: null, at: 0 };
const SPEEDRUN_PAYLOAD_TTL = 5 * 60 * 1000; // la sync régénère toutes les 5 min
let _speedrunLoadToken = 0;

function speedrunEsc(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (s) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[s]
  ));
}

/** Décompacte le payload public {k: clés, r: lignes} → tableau d'objets run.
 *  (Même format que decodeCompactPayload d'app.js — copie locale car app.js
 *  est un script de page non importable depuis le module profil.) */
function decodeSpeedrunPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.k) && Array.isArray(payload.r) && Array.isArray(payload.r[0])) {
    const keys = payload.k;
    return payload.r.map((row) => {
      const o = {};
      keys.forEach((k, i) => { o[k] = row[i]; });
      return o;
    });
  }
  if (Array.isArray(payload.runs)) return payload.runs;
  return Array.isArray(payload) ? payload : [];
}

async function fetchSpeedrunPayload() {
  if (_speedrunPayloadCache.data && Date.now() - _speedrunPayloadCache.at < SPEEDRUN_PAYLOAD_TTL) {
    return _speedrunPayloadCache.data;
  }
  let data = null;
  try {
    const res = await fetch("runs_public.json.gz", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const ds = new DecompressionStream("gzip");
    data = await new Response(res.body.pipeThrough(ds)).json();
  } catch (e) {
    // Fallback fichier non compressé
    const res = await fetch("runs_public.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  }
  _speedrunPayloadCache = { data, at: Date.now() };
  return data;
}

/** Alias (pseudos) connus d'un publicId : pseudo hub + pseudos en jeu,
 *  via l'API publique des alias. Retourne null si introuvable/indispo. */
async function fetchAliasesForPublicId(publicId) {
  try {
    const res = await fetch("/api/public-aliases.php", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const entry = (data.aliases || []).find((a) => String(a.publicId || "") === String(publicId));
    if (!entry) return null;
    const names = new Set();
    if (entry.username) names.add(String(entry.username));
    (Array.isArray(entry.aliases) ? entry.aliases : []).forEach((n) => { if (n) names.add(String(n)); });
    return names;
  } catch (e) {
    return null;
  }
}

/** Prédicat de matching : pseudo du run exact (insensible casse) ou
 *  normalisé (tags de clan, discriminateurs .9236 — règle du site). */
function speedrunAliasMatcher(nameSet) {
  const exact = new Set([...nameSet].map((n) => n.toLowerCase()));
  const norm = new Set([...nameSet].map((n) => normPlayerName(n)).filter(Boolean));
  return (run) => {
    const p = String(run.player || "");
    if (!p) return false;
    return exact.has(p.toLowerCase()) || norm.has(normPlayerName(p));
  };
}

/** Par carte : meilleur run du joueur + rang dans le top 25 de la carte. */
function computeSpeedrunsPerMap(runs, matchFn) {
  const byMap = new Map();
  for (const r of runs) {
    if (!r || !r.map || typeof r.duration_s !== "number" || !Number.isFinite(r.duration_s)) continue;
    let list = byMap.get(r.map);
    if (!list) { list = []; byMap.set(r.map, list); }
    list.push(r);
  }
  const result = [];
  byMap.forEach((mapRuns, map) => {
    mapRuns.sort((a, b) => a.duration_s - b.duration_s);
    let best = null;
    let entries = 0;
    mapRuns.forEach((r) => {
      if (!matchFn(r)) return;
      entries += 1;
      if (!best || r.duration_s < best.duration_s) best = r;
    });
    if (!best) return;
    const rank = mapRuns.findIndex((r) => r === best) + 1;
    result.push({ map, best, rank, entries });
  });
  // Meilleurs rangs d'abord, puis temps croissant
  result.sort((a, b) => a.rank - b.rank || a.best.duration_s - b.best.duration_s);
  return result;
}

/** Nom de carte francisé via i18n (même mécanique que runs.js). */
function speedrunMapName(raw) {
  if (!raw) return "—";
  const key = "map." + raw;
  const translated = typeof window.t === "function" ? window.t(key) : null;
  return translated && translated !== key ? translated : raw;
}

/** Temps au format m:ss (identique à runs.js / index). */
function speedrunFormatTime(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = String(Math.round(sec % 60)).padStart(2, "0");
  return m + ":" + s;
}

function renderSpeedrunsSection(items, updatedISO, isOwn) {
  const sec = document.getElementById("pf2-speedruns");
  if (!sec) return;
  const grid = sec.querySelector(".pf2-speed-grid");
  const empty = sec.querySelector(".pf2-speed-empty");
  const countEl = sec.querySelector(".pf2-panel-count");
  const subEl = sec.querySelector(".pf2-panel-sub");

  if (!items.length) {
    if (grid) grid.innerHTML = "";
    // Vide → panneau discret sur SON profil, masqué sur les profils publics.
    if (empty) empty.hidden = !isOwn;
    sec.hidden = !isOwn;
    return;
  }
  if (empty) empty.hidden = true;
  if (countEl) countEl.textContent = String(items.length);
  if (subEl && updatedISO) {
    try {
      subEl.textContent = T("pf.speed_updated", "Top 25 · {date}", {
        date: new Date(updatedISO).toLocaleDateString(LOCALE(), { day: "numeric", month: "short", year: "numeric" }),
      });
    } catch (e) { /* i18n absent */ }
  }

  const cards = items.map((it) => {
    const rankCls = it.rank === 1 ? " gold" : it.rank === 2 ? " silver" : it.rank === 3 ? " bronze" : "";
    const thumb = mapThumbUrl(it.map);
    const thumbHtml = thumb
      ? `<img src="${speedrunEsc(thumb)}" alt="" loading="lazy">`
      : speedrunEsc(speedrunMapName(it.map).charAt(0));
    const diff = it.best.difficulty ? ` · ${speedrunEsc(it.best.difficulty)}` : "";
    let dateTxt = "";
    try {
      dateTxt = it.best.timestamp
        ? new Date(it.best.timestamp).toLocaleDateString(LOCALE(), { day: "numeric", month: "short" })
        : "";
    } catch (e) { /* ignore */ }
    const entriesTxt = it.entries > 1
      ? ` <span class="pf2-speed-entries">${speedrunEsc(T("pf.speed_entries", "{n} runs top 25", { n: it.entries }))}</span>`
      : "";
    const mapName = speedrunMapName(it.map);
    return `
      <article class="pf2-speed-card">
        <div class="pf2-speed-thumb" aria-hidden="true">${thumbHtml}</div>
        <div class="pf2-speed-info">
          <span class="pf2-speed-map" title="${speedrunEsc(mapName)}">${speedrunEsc(mapName)}</span>
          <span class="pf2-speed-time">${speedrunEsc(speedrunFormatTime(it.best.duration_s))}</span>
          <span class="pf2-speed-meta">#${it.rank}${diff}${dateTxt ? " · " + speedrunEsc(dateTxt) : ""}${entriesTxt}</span>
        </div>
        <span class="pf2-speed-rank${rankCls}" aria-label="${speedrunEsc(T("pf.speed_rank_aria", "Rang {n}", { n: it.rank }))}">${it.rank}</span>
      </article>`;
  }).join("");

  if (grid) grid.innerHTML = cards;
  sec.hidden = false;
}

/** Charge et affiche les speedruns du joueur (par carte) — non bloquant.
 *  Appelé depuis les 3 chemins d'affichage (profil propre, profil public,
 *  post-liaison). extraNames : pseudos hub connus en secours si l'API
 *  d'alias est indisponible. */
async function loadProfileSpeedruns(publicId, isOwn, extraNames) {
  const sec = document.getElementById("pf2-speedruns");
  if (!sec || !publicId) return;
  const token = ++_speedrunLoadToken;
  try {
    const [payload, aliases] = await Promise.all([
      fetchSpeedrunPayload(),
      fetchAliasesForPublicId(publicId),
    ]);
    if (token !== _speedrunLoadToken) return; // une demande plus récente a pris le dessus
    const names = aliases || new Set();
    if (Array.isArray(extraNames)) extraNames.forEach((n) => { if (n) names.add(String(n)); });
    const runs = decodeSpeedrunPayload(payload);
    const items = names.size ? computeSpeedrunsPerMap(runs, speedrunAliasMatcher(names)) : [];
    renderSpeedrunsSection(items, payload?.u || null, isOwn);
  } catch (e) {
    console.warn("[profile] speedruns load failed (non-critique):", e?.message || e);
    // Section laissée masquée — jamais d'erreur bloquante sur le profil.
  }
}

/* ════════════════════════════════════════════════════════════════
   COCKPIT HELPERS — count-up animation, progress rings SVG,
   sparkline SVG, keyboard shortcuts, share-profile action.
   ════════════════════════════════════════════════════════════════ */

const COCKPIT_CAT_LABELS = { ffaCasual: "FFA Casual", ffaRanked: "1v1", teamCasual: "Team Casual", teamRanked: "2v2" };
const COCKPIT_CAT_COLORS = { ffaCasual: "#ff7a00", ffaRanked: "#d97706", teamCasual: "#10b981", teamRanked: "#a855f7" };
const COCKPIT_WEEKDAYS = () => [
  T("pf.wd_1", "Lun"), T("pf.wd_2", "Mar"), T("pf.wd_3", "Mer"), T("pf.wd_4", "Jeu"),
  T("pf.wd_5", "Ven"), T("pf.wd_6", "Sam"), T("pf.wd_7", "Dim"),
];

/** Animate a number from 0 to target over `duration` ms (ease-out cubic). */
function cockpitCountUp(el, target, duration = 1000) {
  if (!el) return;
  const targetNum = Number(target);
  if (!Number.isFinite(targetNum)) return;
  const start = performance.now();
  const fmt = (n) => new Intl.NumberFormat(LOCALE()).format(Math.round(n));
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(targetNum * eased);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = fmt(targetNum);
  };
  requestAnimationFrame(tick);
}

/** Build a small SVG sparkline from an array of 7 numbers. */
function cockpitSparkline(values) {
  const w = 220;
  const h = 64;
  const pad = 6;
  const vals = Array.isArray(values) && values.length > 0 ? values.slice(-7) : [0, 0, 0, 0, 0, 0, 0];
  while (vals.length < 7) vals.unshift(0);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / Math.max(1, vals.length - 1);
  const pts = vals.map((v, i) => ({
    x: pad + i * stepX,
    y: h - pad - ((v - min) / range) * (h - pad * 2 - 8) - 4,
  }));
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(2)},${h - pad} L${pts[0].x.toFixed(2)},${h - pad} Z`;
  let totalLength = 0;
  for (let i = 1; i < pts.length; i++) {
    totalLength += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return `
    <svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="${T("pf.spark_aria", "Activité 7 derniers jours")}">
      <defs>
        <linearGradient id="cockpit-spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff7a00" stop-opacity="0.28" />
          <stop offset="100%" stop-color="#ff7a00" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#cockpit-spark-grad)" />
      <path d="${linePath}" fill="none" stroke="#ff7a00" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        stroke-dasharray="${totalLength.toFixed(2)}" stroke-dashoffset="${totalLength.toFixed(2)}"
        style="transition: stroke-dashoffset 1.4s cubic-bezier(0.4, 0, 0.2, 1) 0.25s"
        data-target-offset="0" class="sparkline-path" />
      ${pts.map((p, i) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${i === pts.length - 1 ? 3 : 0}" fill="#ff7a00" />`).join("")}
    </svg>
  `;
}

/** Wire up keyboard shortcuts (g=games, m=maps, s=skins, r=recent, Esc=modal). */
function setupCockpitKeyboardShortcuts() {
  if (window._cockpitKbInit) return;
  window._cockpitKbInit = true;
  document.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "g" || k === "r") {
      const el = document.getElementById("pf2-recent");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (k === "m") {
      const el = document.getElementById("pf2-maps");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (k === "s") {
      const el = document.getElementById("reward-code-section");
      if (el && el.children.length > 0) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

/** Copie l'URL du profil consulté dans le presse-papiers.
 *  ⚠️ Partage TOUJOURS le profil AFFICHÉ, jamais le compte connecté :
 *  sur le profil d'un autre joueur, _rewardCardState.publicId (carte code)
 *  et currentProfile (sidebar) restent ceux du VISITEUR connecté — l'ancien
 *  ordre de priorité partageait donc le mauvais compte (bug signalé).
 *  Cas spécial : viewingPublicId === "__speedrun__" = profil speedrun sans
 *  compte lié → l'URL courante (?player=NOM) est déjà la bonne. */
function cockpitShareProfile() {
  let url;
  if (viewingPublicId && viewingPublicId !== "__speedrun__") {
    // Profil d'un autre joueur consulté (?player=…&publicId=…) → on partage
    // CELUI-CI sous forme canonique ?pid=<publicId consulté>.
    url = `${window.location.origin}${window.location.pathname}?pid=${encodeURIComponent(viewingPublicId)}`;
  } else if (viewingPublicId === "__speedrun__") {
    // Profil speedrun sans compte lié : l'URL courante ?player=NOM est la
    // seule forme qui permet de retrouver ce profil.
    url = window.location.href;
  } else {
    // Propre profil (connecté, pas de consultation étrangère en cours).
    const pid = (currentProfile && currentProfile.publicId) || _rewardCardState.publicId;
    url = pid ? `${window.location.origin}${window.location.pathname}?pid=${encodeURIComponent(pid)}` : window.location.href;
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(
      () => showToast(T("pf.link_copied", "Lien du profil copié !"), "success"),
      () => showToast(T("pf.copy_fail_hint", "Copie impossible — sélectionne l'URL manuellement"), "info")
    );
  } else {
    const tmp = document.createElement("input");
    tmp.value = url;
    document.body.appendChild(tmp);
    tmp.select();
    try { document.execCommand("copy"); showToast(T("pf.link_copied", "Lien du profil copié !"), "success"); }
    catch { showToast(T("pf.copy_fail", "Copie impossible"), "error"); }
    document.body.removeChild(tmp);
  }
}
window.cockpitShareProfile = cockpitShareProfile;

/* ════════════════════════════════════════════════════════════════
   RENDER PRE-COMPUTED STATS — layout « A · Dossier »
   (from player-stats/<pid>.json — instant display, zero calculation)
   ════════════════════════════════════════════════════════════════ */

function renderPrecomputedStats(stats, mount) {
  if (!mount || !stats) return;
  mount.innerHTML = "";
  // Idempotence : vide aussi les zones hors mount (rappels loadStats / profils publics)
  const sideExtra = document.getElementById("pf2-side-extra");
  if (sideExtra) sideExtra.innerHTML = "";
  const below = document.getElementById("pf2-below");
  if (below) below.innerHTML = "";
  const weeklyCard = document.getElementById("weekly-chart-card");
  if (weeklyCard) weeklyCard.remove();
  setupCockpitKeyboardShortcuts();

  const fmt = (n) => new Intl.NumberFormat(LOCALE()).format(Number(n) || 0);

  // ─────────── Cartes statistiques (au-dessus de la grille) ───────────
  const results = stats.results || {};
  setText("stat-games", fmt(stats.totalGames));
  setText("stat-wins", fmt(stats.totalWins));
  setText("stat-winrate", stats.formatted?.winrate || "—");
  setText("stat-maps", String(stats.maps?.length || 0));
  setText("stat-games-sub", stats.formatted?.avgGameDuration ? T("pf.sub_avg_duration", "Durée moy. {v}", { v: stats.formatted.avgGameDuration }) : "");
  setText("stat-wins-sub", stats.streaks?.best ? T("pf.sub_best_streak", "Record série : {v}", { v: stats.streaks.best }) : "");
  setText("stat-winrate-sub", results.victory != null ? T("pf.sub_wl", "{w}V · {l}D", { w: fmt(results.victory), l: fmt(results.defeat || 0) }) : "");
  setText("stat-maps-sub", "");
  // v5.15 : le score total est aussi alimenté par le dossier (pré-calculé ou
  // live) — avant, seule loadStats (API OpenFront) le posait ; si l'API était
  // en 503, la carte restait vide même avec un dossier complet.
  if (stats.points != null) {
    setText("stat-alltime-value", stats.formatted?.points || fmt(stats.points));
  }

  // ─────────── Chips meta (niveau / temps de jeu / série) ───────────
  const metaEl = document.getElementById("cockpit-status-meta");
  if (metaEl) {
    const playtimeHours = Math.floor((stats.playtime?.totalSec || 0) / 3600);
    const streak = stats.streaks?.current || 0;
    const level = stats.level ?? Math.floor((stats.points || 0) / 100);
    const flameSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;
    const starSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    const clockSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    metaEl.innerHTML = `
      <span class="pf2-chip">${starSvg} ${T("pf.chip_level", "Niv. {n}", { n: level })}</span>
      <span class="pf2-chip">${clockSvg} ${T("pf.chip_hours", "{n} h", { n: playtimeHours })}</span>
      <span class="pf2-chip${streak > 0 ? " is-active" : ""}">${flameSvg} ${T("pf.chip_streak", "Série de {n}", { n: streak })}</span>
    `;
  }

  // ─────────── Badge de synchro ───────────
  // v5.15 : dossier LIVE (profil non suivi) → badge « échantillon » honnête
  // au lieu du badge « synchronisé » réservé aux dossiers pré-calculés.
  const badge = document.createElement("div");
  if (stats.isSample) {
    badge.className = "pf2-sync pf2-sync-sample";
    badge.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${T("pf.sample_badge", "Aperçu calculé en direct · {n} dernières parties · totaux de carrière exacts", { n: fmt(stats.sampleSize || 0) })}`;
  } else {
    badge.className = "pf2-sync";
    const syncedDate = stats.lastSyncedAt ? new Date(stats.lastSyncedAt) : null;
    const syncedStr = syncedDate ? syncedDate.toLocaleString(LOCALE(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : T("pf.recently", "récemment");
    badge.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${T("pf.sync_badge", "Données synchronisées · {n} parties · MAJ {time}", { n: fmt(stats.totalGames), time: syncedStr })}`;
  }
  mount.appendChild(badge);

  // ─────────── Panneau : Parties récentes ───────────
  const recentGames = stats.recentGames || [];
  const recentPanel = document.createElement("section");
  recentPanel.className = "pf2-panel";
  recentPanel.id = "pf2-recent";
  recentPanel.innerHTML = `
    <header class="pf2-panel-head">
      <h3>${T("pf.recent_title", "Parties récentes")}</h3>
      <span class="pf2-panel-count">${fmt(stats.totalGames)}</span>
      <i class="pf2-panel-rule"></i>
      <span class="pf2-panel-sub">${T("pf.click_details", "clique pour les détails")}</span>
    </header>
    <div class="pf2-recent-list"></div>
  `;
  const recentList = recentPanel.querySelector(".pf2-recent-list");
  if (recentGames.length > 0) {
    recentList.innerHTML = recentGames.slice(0, 20).map((g) => {
      const win = g.result === "victory";
      const loss = g.result === "defeat";
      const pillCls = win ? "pf2-pill-win" : loss ? "pf2-pill-loss" : "pf2-pill-other";
      const label = win ? T("pf.result_victory", "Victoire") : loss ? T("pf.result_defeat", "Défaite") : (g.result || "—");
      const dateStr = g.start ? formatFrenchDate(new Date(g.start).getTime()) : "—";
      const durStr = g.durationSeconds ? formatDurationCompact(Number(g.durationSeconds) || 0) : "—";
      const thumb = mapThumbUrl(g.map);
      const letter = esc((g.map || "?").charAt(0).toUpperCase());
      return `
        <div class="pf2-gamerow" data-game-id="${esc(String(g.gameId ?? ""))}" role="button" tabindex="0" aria-label="${T("pf.game_details_aria", "Détails de la partie — {map}", { map: esc(g.map || T("pf.unknown_map_lower", "carte inconnue")) })}">
          <span class="pf2-gamerow-thumb">${letter}${thumb ? `<img src="${thumb}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>
          <div class="pf2-gamerow-info">
            <p class="pf2-gamerow-map">${esc(g.map || T("pf.unknown_map", "Carte inconnue"))}</p>
            <p class="pf2-gamerow-meta">${esc(COCKPIT_CAT_LABELS[g.category] || g.mode || "—")} · ${T("pf.row_players_count", "{n} joueurs", { n: g.totalPlayers || "?" })}</p>
          </div>
          <div class="pf2-gamerow-right">
            <span class="pf2-pill ${pillCls}">${label}</span>
            <span class="pf2-gamerow-date">${esc(dateStr)} · ${esc(durStr)}</span>
          </div>
        </div>
      `;
    }).join("");
  } else {
    recentList.innerHTML = `<div class="pf-empty">${T("pf.no_recent_games", "Aucune partie récente.")}</div>`;
  }
  mount.appendChild(recentPanel);
  if (recentGames.length > 0) attachGameRowClickHandlers(recentPanel, recentGames.slice(0, 20));

  // ─────────── Panneau : Temps par catégorie ───────────
  const cat = stats.playtime?.byCategory || {};
  const totalSec = stats.playtime?.totalSec || 0;
  const catRows = ["ffaCasual", "ffaRanked", "teamCasual", "teamRanked"].map((key) => ({
    key,
    playtimeSec: cat[key]?.playtimeSec || 0,
    games: cat[key]?.games || 0,
  }));
  const catPanel = document.createElement("section");
  catPanel.className = "pf2-panel";
  catPanel.innerHTML = `
    <header class="pf2-panel-head">
      <h3>${T("pf.cat_title", "Temps par catégorie")}</h3>
      <i class="pf2-panel-rule"></i>
      <span class="pf2-panel-sub">${T("pf.cat_total", "{v} au total", { v: esc(stats.formatted?.totalPlaytime || "—") })}</span>
    </header>
    ${catRows.map((c) => {
      const pct = totalSec > 0 ? (c.playtimeSec / totalSec) * 100 : 0;
      const hours = c.playtimeSec / 3600;
      const hoursStr = hours >= 1
        ? T("pf.dur_hm", "{h} h {m} m", { h: Math.floor(hours), m: Math.floor((hours % 1) * 60) })
        : T("pf.dur_m", "{m} m", { m: Math.floor(c.playtimeSec / 60) });
      return `
        <div class="pf2-cat-row">
          <div class="pf2-cat-label">
            <span class="pf2-cat-name">${esc(COCKPIT_CAT_LABELS[c.key] || c.key)}</span>
            <span class="pf2-cat-hours">${esc(hoursStr)} · ${Math.round(pct)} %</span>
          </div>
          <div class="pf2-cat-track">
            <div class="pf2-cat-fill" style="background:${COCKPIT_CAT_COLORS[c.key] || "#ff7a00"}" data-target-width="${pct.toFixed(2)}"></div>
          </div>
          <div class="pf2-cat-sub">${T("pf.n_games", "{n} parties", { n: fmt(c.games) })}</div>
        </div>
      `;
    }).join("")}
  `;
  mount.appendChild(catPanel);

  // ─────────── Panneau : Activité par jour ───────────
  const wd = stats.activity?.byWeekday || [0, 0, 0, 0, 0, 0, 0];
  const maxWd = Math.max(...wd, 1);
  const peakWdIdx = wd.indexOf(Math.max(...wd));
  const weekPanel = document.createElement("section");
  weekPanel.className = "pf2-panel";
  weekPanel.innerHTML = `
    <header class="pf2-panel-head">
      <h3>${T("pf.activity_title", "Activité par jour")}</h3>
      <i class="pf2-panel-rule"></i>
      <span class="pf2-panel-sub">${T("pf.peak", "Pic : {day} ({n} parties)", { day: esc(COCKPIT_WEEKDAYS()[peakWdIdx] || "—"), n: fmt(maxWd) })}</span>
    </header>
    <div class="pf2-week">
      ${wd.map((count, i) => {
        const h = Math.max(2, (count / maxWd) * 100);
        const isPeak = i === peakWdIdx && count > 0;
        return `
          <div class="pf2-week-col${isPeak ? " is-peak" : ""}" title="${T("pf.day_games_title", "{day} — {n} parties", { day: esc(COCKPIT_WEEKDAYS()[i]), n: fmt(count) })}">
            <div class="pf2-week-track">
              <div class="pf2-week-fill" data-target-height="${h.toFixed(2)}"></div>
            </div>
            <div class="pf2-week-label">${esc(COCKPIT_WEEKDAYS()[i])}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
  mount.appendChild(weekPanel);

  // ─────────── Colonne droite : Objectifs · Succès · Niveau · 7 jours ───────────

  // Milestones (objectifs) — fallback calculé si absentes
  const ms = stats.nextMilestones || (() => {
    const winsCurrent = stats.totalWins || 0;
    const playtimeCurrent = Math.floor((stats.playtime?.totalSec || 0) / 3600);
    const mapsCurrent = stats.maps?.length || 0;
    const nextMult = (val, step) => {
      if (val <= 0) return step;
      const m = Math.ceil(val / step) * step;
      return m > val ? m : m + step;
    };
    return {
      wins: { current: winsCurrent, target: nextMult(winsCurrent, 50) },
      playtime: { current: playtimeCurrent, target: nextMult(playtimeCurrent, 50) },
      maps: { current: mapsCurrent, target: nextMult(mapsCurrent, 10) },
    };
  })();
  const goals = [
    { name: T("pf.goal_wins", "Victoires"), value: ms.wins.current, target: ms.wins.target },
    { name: T("pf.goal_playtime", "Heures de jeu"), value: ms.playtime.current ?? Math.floor((stats.playtime?.totalSec || 0) / 3600), target: ms.playtime.target },
    { name: T("pf.goal_maps", "Cartes explorées"), value: ms.maps.current ?? (stats.maps?.length || 0), target: ms.maps.target },
  ];
  if (sideExtra) {
    const goalsPanel = document.createElement("section");
    goalsPanel.className = "pf2-panel";
    goalsPanel.innerHTML = `
      <header class="pf2-panel-head"><h3>${T("pf.goals_title", "Objectifs")}</h3><i class="pf2-panel-rule"></i></header>
      ${goals.map((g) => {
        const pct = g.target > 0 ? Math.min(100, (g.value / g.target) * 100) : 0;
        const remaining = Math.max(0, g.target - g.value);
        return `
          <div class="pf2-goal">
            <div class="pf2-goal-head">
              <span class="pf2-goal-name">${esc(g.name)}</span>
              <span class="pf2-goal-value">${fmt(g.value)} / ${fmt(g.target)}</span>
            </div>
            <div class="pf2-goal-track">
              <div class="pf2-goal-fill" data-target-width="${pct.toFixed(2)}"></div>
            </div>
            <div class="pf2-goal-sub">${remaining > 0 ? T("pf.remaining", "{n} restants", { n: fmt(remaining) }) : T("pf.goal_done", "Objectif atteint !")}</div>
          </div>
        `;
      }).join("")}
    `;
    sideExtra.appendChild(goalsPanel);

    // ── Succès (tuiles) ──
    const achvData = stats.achievements;
    if (achvData?.list?.length) {
      const ACHV_ICONS = {
        "first-win": `<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>`,
        "ten-wins": `<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>`,
        "hundred-wins": `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
        "marathon": `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
        "weekend": `<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>`,
        "cartographer": `<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>`,
        "streak5": `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`,
        "streak10": `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`,
        "polyvalent": `<path d="m6 10 6-5 6 5"/><path d="m6 15 6-5 6 5"/><path d="m6 20 6-5 6 5"/>`,
        "night-owl": `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`,
      };
      const lockSvg = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      const achvPanel = document.createElement("section");
      achvPanel.className = "pf2-panel";
      achvPanel.innerHTML = `
        <header class="pf2-panel-head">
          <h3>${T("pf.achv_title", "Succès")}</h3>
          <span class="pf2-panel-count">${achvData.unlockedCount ?? achvData.list.filter((a) => a.unlocked).length}/${achvData.list.length}</span>
          <i class="pf2-panel-rule"></i>
        </header>
        <div class="pf2-achv-grid">
          ${achvData.list.map((a) => {
            const icon = a.unlocked
              ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACHV_ICONS[a.id] || ACHV_ICONS["first-win"]}</svg>`
              : lockSvg;
            const prog = !a.unlocked && a.progress?.target > 0
              ? `<div class="pf2-achv-progress"><div class="pf2-achv-progress-fill" style="width:${Math.min(100, Math.round((a.progress.current / a.progress.target) * 100))}%"></div></div>`
              : "";
            return `
              <div class="pf2-achv${a.unlocked ? "" : " is-locked"}">
                <span class="pf2-achv-icon">${icon}</span>
                <p class="pf2-achv-name">${esc(T("pf.achv_" + a.id + "_name", a.name))}</p>
                <p class="pf2-achv-desc">${esc(T("pf.achv_" + a.id + "_desc", a.desc))}</p>
                ${prog}
              </div>
            `;
          }).join("")}
        </div>
      `;
      sideExtra.appendChild(achvPanel);
    }

    // ── Niveau ──
    const level = stats.level ?? Math.floor((stats.points || 0) / 100);
    const levelProgress = stats.levelProgress ?? ((stats.points || 0) % 100);
    const levelPct = Math.min(100, levelProgress);
    const levelPanel = document.createElement("section");
    levelPanel.className = "pf2-panel";
    levelPanel.innerHTML = `
      <header class="pf2-panel-head"><h3>${T("pf.level_title", "Niveau")}</h3><i class="pf2-panel-rule"></i></header>
      <div class="pf2-level-head">
        <span class="pf2-level-title">${T("pf.level_n", "Niveau {n}", { n: level })}</span>
        <span class="pf2-level-sub">${T("pf.level_sub", "{p} / 100 pts → Niv. {n}", { p: levelProgress, n: level + 1 })}</span>
      </div>
      <div class="pf2-level-track">
        <div class="pf2-level-fill" data-target-width="${levelPct.toFixed(2)}"></div>
      </div>
      <div class="pf2-level-stats">
        <span>${T("pf.n_pts", "{n} pts", { n: fmt(levelProgress) })}</span>
        <span>${T("pf.pts_total", "{n} pts total", { n: esc(stats.formatted?.points || fmt(stats.points)) })}</span>
      </div>
    `;
    sideExtra.appendChild(levelPanel);

    // ── 7 derniers jours (sparkline) ──
    const sparkValues = stats.sparkline7d || [0, 0, 0, 0, 0, 0, 0];
    const sparkTotal = sparkValues.reduce((s, v) => s + (Number(v) || 0), 0);
    const sparkPanel = document.createElement("section");
    sparkPanel.className = "pf2-panel";
    sparkPanel.innerHTML = `
      <header class="pf2-panel-head">
        <h3>${T("pf.spark_title", "7 derniers jours")}</h3>
        <i class="pf2-panel-rule"></i>
        <span class="pf2-panel-sub">${T("pf.n_games", "{n} parties", { n: fmt(sparkTotal) })}</span>
      </header>
      <div class="pf2-spark-wrap">${cockpitSparkline(sparkValues)}</div>
      <div class="pf2-spark-axis"><span>${T("pf.d6", "J-6")}</span><span></span><span></span><span></span><span></span><span></span><span>${T("pf.today", "Auj.")}</span></div>
    `;
    sideExtra.appendChild(sparkPanel);
  }

  // ─────────── Sous la grille : stats par carte ───────────
  if (below && stats.maps && stats.maps.length > 0) {
    below.innerHTML = "";
    const allMaps = stats.maps;
    const topMaps = allMaps.slice(0, 10);
    const mapRowHtml = (m) => {
      const wr = m.winRate * 100;
      const wrColor = wr >= 60 ? "is-win" : wr >= 40 ? "" : "is-loss";
      const thumb = mapThumbUrl(m.map);
      return `<tr>
        <td><span class="pf2-mapcell">${thumb ? `<img class="pf2-mapcell-thumb" src="${esc(thumb)}" alt="" loading="lazy" width="26" height="26">` : ""}<span>${esc(m.map)}</span></span></td>
        <td>${fmt(m.count)}</td>
        <td class="is-win">${fmt(m.wins)}</td>
        <td class="is-loss">${fmt(m.losses)}</td>
        <td class="${wrColor}" style="font-weight:700">${esc(m.formatted?.winRate || "—")}</td>
        <td>${esc(m.formatted?.avgDuration || "—")}</td>
        <td class="is-last">${esc(m.formatted?.lastPlayed || "—")}</td>
      </tr>`;
    };
    const mapPanel = document.createElement("section");
    mapPanel.className = "pf2-panel";
    mapPanel.id = "pf2-maps";
    mapPanel.innerHTML = `
      <header class="pf2-panel-head">
        <h3>${T("pf.maps_title", "Statistiques par carte")}</h3>
        <span class="pf2-panel-count">${allMaps.length}</span>
        <i class="pf2-panel-rule"></i>
      </header>
      <button type="button" id="pf2-maps-toggle" class="pf2-maps-toggle" aria-expanded="false">${T("pf.maps_show", "Voir les {n} cartes", { n: allMaps.length })}</button>
      <div class="pf2-maps-body" id="pf2-maps-body">
        <div class="pf2-maps-wrap">
          <table class="pf2-maps-table">
            <thead><tr><th>${T("pf.th_map", "Carte")}</th><th>${T("pf.th_games", "Parties")}</th><th>${T("pf.th_w", "V")}</th><th>${T("pf.th_l", "D")}</th><th>${T("pf.th_winrate", "Winrate")}</th><th>${T("pf.th_avg_duration", "Durée moy.")}</th><th>${T("pf.th_last", "Dernière")}</th></tr></thead>
            <tbody>${topMaps.map(mapRowHtml).join("")}</tbody>
          </table>
        </div>
      </div>
    `;
    below.appendChild(mapPanel);
    const toggleBtn = mapPanel.querySelector("#pf2-maps-toggle");
    const mapsBody = mapPanel.querySelector("#pf2-maps-body");
    if (toggleBtn && mapsBody) {
      let expanded = false;
      toggleBtn.addEventListener("click", () => {
        expanded = !expanded;
        mapsBody.classList.toggle("is-open", expanded);
        toggleBtn.textContent = expanded ? T("pf.maps_hide", "Masquer les cartes") : T("pf.maps_show", "Voir les {n} cartes", { n: allMaps.length });
        toggleBtn.setAttribute("aria-expanded", String(expanded));
        const tbody = mapsBody.querySelector("tbody");
        if (tbody) tbody.innerHTML = (expanded ? allMaps : topMaps).map(mapRowHtml).join("");
      });
    }
  }

  // ── Animations au frame suivant (barres, sparkline) ──
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      mount.querySelectorAll(".pf2-cat-fill").forEach((el) => {
        el.style.width = el.dataset.targetWidth + "%";
      });
      mount.querySelectorAll(".pf2-week-fill").forEach((el) => {
        el.style.height = el.dataset.targetHeight + "%";
      });
      document.querySelectorAll(".pf2-goal-fill").forEach((el) => {
        el.style.width = el.dataset.targetWidth + "%";
      });
      document.querySelectorAll(".pf2-level-fill").forEach((el) => {
        el.style.width = el.dataset.targetWidth + "%";
      });
      document.querySelectorAll(".sparkline-path").forEach((el) => {
        el.style.strokeDashoffset = el.dataset.targetOffset || "0";
      });
    });
  });

  // ── Graphique hebdomadaire (points par semaine) ──
  if (window._profileWeekData) {
    setTimeout(() => renderWeeklyChart(), 100);
  }
}

/* ── Hook de debug (E2E / support) — même pattern que _lobbyDebug ── */
window._profileDebug = {
  showView,
  renderHero,
  renderPrecomputedStats,
  loadStats,
  renderWeeklyChart,
  buildLiveStatsFromApi,
  paintPatternToCanvas,
};
